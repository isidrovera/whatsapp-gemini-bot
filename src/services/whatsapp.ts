// src/services/whatsapp.ts
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  WASocket,
  proto,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import qrcode from 'qrcode-terminal';
import QRCode from 'qrcode';
import { logger } from '../utils/logger';
import * as blockedModel from '../models/blocked';
import * as contactModel from '../models/contact';
import * as geminiService from './gemini';
import * as imageProcessor from './imageProcessor';
import { extractPhoneFromJid, isGroupJid, normalizePhone } from '../utils/validators';

// Horarios / Plantillas
import * as workingHoursModel from '../models/workingHours';
import * as systemVarModel from '../models/systemVar';

// Odoo
import { detectServiceIntent, getOdooServiceLink } from './odoo';

// Auto-respuestas
import * as autoResponseModel from '../models/autoResponse';
import { replaceVariables } from '../utils/formatters';

let sock: WASocket | null = null;
let isReady = false;                // = conectado OK
let botPhoneNumber: string | null = null;
const startTime = Date.now();

// Estado QR / conexión
let currentQR: string | null = null;    // string crudo que entrega Baileys
let qrDataURL: string | null = null;    // data:image/png;base64,...
// NOTA: en el dashboard tú muestras:
//  - connected = isReady
//  - hasQR = hasQR()
//  - botNumber = botPhoneNumber
// hasQR() abajo usa currentQR !== null, pero después de desconexión manual
// vamos a forzar currentQR = null y luego, al reiniciar sesión, Baileys va
// a emitir un nuevo qr otra vez (lo volvemos a setear en connection.update)


// takeover helpers internos
const HUMAN_TAKEOVER_COMMAND = '/humano';
const RELEASE_TAKEOVER_COMMAND = '/auto';

const botSentMessageIds = new Map<string, number>(); // id -> expiresAt
const BOT_ID_TTL_MS = 5 * 60 * 1000;

function markBotMessageId(id: string) {
  botSentMessageIds.set(id, Date.now() + BOT_ID_TTL_MS);
}
function isFromBotById(id?: string | null) {
  if (!id) return false;
  const exp = botSentMessageIds.get(id);
  if (!exp) return false;
  if (Date.now() > exp) {
    botSentMessageIds.delete(id);
    return false;
  }
  return true;
}

type UpsertType = 'notify' | 'append' | 'replace' | string;

/**
 * Inicializa o reinicializa el socket de WhatsApp.
 * - Carga/crea credenciales en ./baileys_auth (multi-file)
 * - Setea listeners para QR, conexión, mensajes, etc.
 */
export async function initializeWhatsApp() {
  try {
    logger.info('Initializing WhatsApp client (Baileys v7)...');

    const { state, saveCreds } = await useMultiFileAuthState('./baileys_auth');

    sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      logger: logger as any,
      browser: ['WhatsApp Bot', 'Chrome', '1.0.0'],
      syncFullHistory: false,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        // Se recibió un QR fresco -> aún NO estamos conectados
        logger.info('QR Code received, scan to authenticate:');
        qrcode.generate(qr, { small: true });

        currentQR = qr;
        try {
          qrDataURL = await QRCode.toDataURL(qr);
          logger.info('✅ QR available at: http://localhost:3000/auth/qr');
        } catch (error) {
          logger.error('Error generating QR data URL:', error);
          qrDataURL = null;
        }

        // Cuando hay QR disponible estamos claramente "no conectados"
        isReady = false;
        botPhoneNumber = null;
      }

      if (connection === 'close') {
        const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        logger.warn('Connection closed. Reconnecting:', shouldReconnect);

        // Marcar estado como desconectado
        isReady = false;
        botPhoneNumber = null;

        // Si no fue logout voluntario, intentamos reconectar
        if (shouldReconnect) {
          setTimeout(() => initializeWhatsApp(), 3000);
        } else {
          // loggedOut => hay que borrar credenciales manualmente para volver a emparejar
          logger.error(
            'Logged out. Please delete baileys_auth folder and restart.'
          );
          // dejamos QR en null (no hay QR válido), el admin tendrá que regenerar
          currentQR = null;
          qrDataURL = null;
        }
      }

      if (connection === 'open') {
        // YA conectó correctamente
        logger.info('✅ WhatsApp connected successfully!');
        isReady = true;
        currentQR = null;
        qrDataURL = null;

        if (sock?.user?.id) {
          botPhoneNumber = extractPhoneFromJid(sock.user.id);
          logger.info(`📱 Bot phone number: ${botPhoneNumber}`);
        }
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      for (const message of messages) {
        await handleIncomingMessage(message, type as UpsertType);
      }
    });

    logger.info('WhatsApp client initialized');
  } catch (error) {
    logger.error('Error initializing WhatsApp:', error);
    throw error;
  }
}

/**
 * Procesa mensajes entrantes.
 */
async function handleIncomingMessage(
  message: proto.IWebMessageInfo,
  upsertType?: UpsertType
) {
  try {
    // Ignorar antiguos
    if ((message.messageTimestamp as number) * 1000 < startTime) return;

    const senderJid = message.key.remoteJid;
    if (!senderJid) return;

    // Anti eco de mensajes propios
    if (upsertType === 'append') {
      logger.debug('Ignoring local append upsert (likely our own send)');
      return;
    }
    if (isFromBotById(message.key?.id ?? null)) {
      logger.debug(
        `Ignoring message id=${message.key?.id} (sent by bot recently)`
      );
      return;
    }

    // Mensajes enviados "desde este número" (agente humano)
    if (message.key.fromMe) {
      const messageText = extractMessageText(message);
      const textLower = messageText.toLowerCase().trim();

      // Comandos manuales takeover
      if (textLower === HUMAN_TAKEOVER_COMMAND) {
        const phoneNumber = extractPhoneFromJid(senderJid);
        const normalizedPhone = normalizePhone(phoneNumber);
        await contactModel.setHumanTakeover(normalizedPhone);
        logger.info(`[HUMAN-TAKEOVER] ✋ Manually activated for ${normalizedPhone}`);
        return;
      }

      if (textLower === RELEASE_TAKEOVER_COMMAND) {
        const phoneNumber = extractPhoneFromJid(senderJid);
        const normalizedPhone = normalizePhone(phoneNumber);
        await contactModel.releaseHumanTakeover(normalizedPhone);
        logger.info(`[BOT-REACTIVATED] 🤖 Manually reactivated for ${normalizedPhone}`);
        return;
      }

      // Si mandó cualquier cosa manual, marcamos takeover o extendemos ventana
      if (messageText && messageText.trim().length > 0) {
        const phoneNumber = extractPhoneFromJid(senderJid);
        const normalizedPhone = normalizePhone(phoneNumber);
        const contact = await contactModel.findByPhone(normalizedPhone);

        const now = new Date();
        const oneHourInMs = 60 * 60 * 1000;

        if (!contact?.humanTakeoverAt) {
          await contactModel.setHumanTakeover(normalizedPhone);
          logger.info(`[HUMAN-TAKEOVER] 🙋 Agent message detected for ${normalizedPhone}`);
        } else {
          const diff = now.getTime() - contact.humanTakeoverAt.getTime();
          if (diff > oneHourInMs) {
            await contactModel.setHumanTakeover(normalizedPhone);
            logger.info(`[HUMAN-TAKEOVER] 🔄 Renewed for ${normalizedPhone} (previous expired)`);
          } else {
            await contactModel.setHumanTakeover(normalizedPhone);
            logger.info(`[HUMAN-TAKEOVER] ⏰ Extended for ${normalizedPhone} - Human still active`);
          }
        }
      }
      return; // no seguir procesando propios
    }

    // Ignorar grupos: también bloquea automáticamente si entra un grupo nuevo
    if (isGroupJid(senderJid)) {
      logger.info(`Message from group ${senderJid} - ignoring`);
      const isBlockedGroup = await blockedModel.isBlocked(senderJid);
      if (!isBlockedGroup) {
        await blockedModel.block(
          senderJid,
          'GROUP',
          'Grupo bloqueado automáticamente'
        );
        logger.info(`Group ${senderJid} blocked automatically`);
      }
      return;
    }

    // Cliente real
    const phoneNumber = extractPhoneFromJid(senderJid);
    const normalizedPhone = normalizePhone(phoneNumber);

    // Bloqueados
    const isBlockedNum = await blockedModel.isBlocked(normalizedPhone);
    if (isBlockedNum) {
      logger.info(`Message from blocked number ${normalizedPhone} - ignoring`);
      return;
    }

    // ¿bot debe responder o hay humano tomando?
    const shouldRespond = await contactModel.shouldBotRespond(normalizedPhone);
    if (!shouldRespond) {
      logger.info(`[BOT-PAUSED] 🤫 Skipping response for ${normalizedPhone} - human takeover active`);
      return;
    }

    // Horarios / fuera de horario
    const status = await workingHoursModel.getStatusInfo(new Date());
    if (!status.isOpen) {
      const [nextOpen, tz, aftTpl, brTpl, holTpl] = await Promise.all([
        workingHoursModel.getNextOpenDateTime(new Date()),
        systemVarModel.getBusinessTimezone(),
        systemVarModel.getAfterHoursTemplate(),
        systemVarModel.getBreakTemplate(),
        systemVarModel.getHolidayTemplate(),
      ]);

      const open = status.todayHours?.openTime || '--:--';
      const close = status.todayHours?.closeTime || '--:--';
      const break_start = status.todayHours?.breakStart || '';
      const break_end = status.todayHours?.breakEnd || '';
      const break_hint = status.reason === 'break' && break_end
        ? ` (volvemos ${break_end})`
        : '';
      const next_open_line = nextOpen
        ? `Volvemos a estar disponibles: ${workingHoursModel.formatDateTime(nextOpen, tz)}.`
        : 'Te responderemos apenas volvamos a estar disponibles.';

      const reasonMap: Record<string, string> = {
        holiday: 'Hoy es día no laborable',
        closure: 'Hoy nuestro local está cerrado',
        non_workday: 'Hoy no tenemos atención',
        before_open: 'Aún no abrimos',
        after_close: 'Ya cerramos por hoy',
        break: 'Estamos en horario de refrigerio',
      };
      const reason = reasonMap[status.reason || 'closure'] || 'Estamos fuera de horario';

      let template = aftTpl;
      if (status.reason === 'break') template = brTpl;
      if (status.reason === 'holiday' || status.reason === 'closure') template = holTpl;

      const event_type = status.reason || '';
      const event_title = status.todayEvent?.title || '';

      const msg = template
        .replaceAll('{{reason}}', reason)
        .replaceAll('{{open}}', open)
        .replaceAll('{{close}}', close)
        .replaceAll('{{break_start}}', break_start)
        .replaceAll('{{break_end}}', break_end)
        .replaceAll('{{break_hint}}', break_hint)
        .replaceAll('{{next_open_line}}', next_open_line)
        .replaceAll('{{event_type}}', String(event_type))
        .replaceAll('{{event_title}}', event_title);

      await sendMessage(senderJid, msg);
      return; // no pasamos a Gemini si estamos fuera de horario
    }

    // Extraer texto y medios
    const messageText = extractMessageText(message);
    const mediaType = imageProcessor.getMediaType(message);

    let mediaAnalysis: string | null = null;
    let anydeskCode: string | null = null;

    if (mediaType) {
      logger.info(`[WHATSAPP] Processing ${mediaType} from ${normalizedPhone}...`);

      switch (mediaType) {
        case 'image':
          mediaAnalysis = await imageProcessor.processImage(message);
          if (mediaAnalysis) {
            anydeskCode = imageProcessor.extractAnydeskCode(mediaAnalysis);
            if (anydeskCode) logger.info(`[ANYDESK] Code extracted: ${anydeskCode}`);
          }
          break;
        case 'video':
          mediaAnalysis = await imageProcessor.processVideo(message);
          break;
        case 'audio':
          mediaAnalysis = await imageProcessor.processAudio(message);
          break;
        case 'document':
          mediaAnalysis = await imageProcessor.processDocument(message);
          break;
      }
    }

    let finalMessageText = messageText;
    if (!finalMessageText || finalMessageText.trim().length === 0) {
      if (mediaAnalysis) {
        finalMessageText = mediaAnalysis;
      } else if (mediaType) {
        finalMessageText = `[El usuario envió ${
          mediaType === 'image'
            ? 'una imagen'
            : mediaType === 'video'
            ? 'un video'
            : mediaType === 'audio'
            ? 'un audio'
            : 'un documento'
        }]`;
      } else {
        logger.info('Empty message received - ignoring');
        return;
      }
    }

    logger.info(
      `Message from ${normalizedPhone}: ${finalMessageText.substring(0, 50)}... ${mediaType ? `[+${mediaType.toUpperCase()}]` : ''}`
    );

    // AUTO-RESPUESTAS
    const autoResp = await autoResponseModel.findByTrigger(finalMessageText);
    if (autoResp) {
      logger.info(`[AUTO-RESPONSE] Matched trigger "${autoResp.trigger}" for ${normalizedPhone}`);

      const contact = await contactModel.findByPhone(normalizedPhone);
      const systemVars = await systemVarModel.getVariablesForPrompt();

      const responseText = replaceVariables(autoResp.response, {
        ...systemVars,
        name: contact?.name || 'Usuario',
        company_name_user: contact?.companyName || 'su empresa',
        phone: normalizedPhone,
      });

      await sendMessage(senderJid, responseText);
      logger.info(`[AUTO-RESPONSE] Sent response (category: ${autoResp.category || 'none'})`);
      return;
    }

    // BLOQUEO DNI / registro
    const contact = await contactModel.findByPhone(normalizedPhone);
    const looksLikeDNI = /^\d{8}$/.test(finalMessageText.trim());

    if (!contact?.name && !looksLikeDNI) {
      await sendMessage(
        senderJid,
        'Para continuar, por favor envíame tu *DNI (8 dígitos)* para validar tu identidad y registrar tu nombre. 🙏'
      );
      return;
    }

    // VISITA TÉCNICA (Odoo)
    if (detectServiceIntent(finalMessageText)) {
      const c = contact || (await contactModel.findByPhone(normalizedPhone));

      if (!c?.name) {
        await sendMessage(senderJid, 'Estoy validando tus datos, un momento por favor…');
        // dejamos que luego Gemini maneje
      } else if (!c?.companyName) {
        await sendMessage(
          senderJid,
          'Para coordinar la visita técnica necesito tu *Razón Social / RUC* tal como figura en nuestro sistema. ¿Podrías enviarla?'
        );
        return;
      } else {
        const serviceUrl = await getOdooServiceLink(
          c.companyName,
          c.name,
          normalizedPhone
        );
        if (serviceUrl) {
          await sendMessage(
            senderJid,
            `🛠️ Perfecto, ${c.name}.\nGeneré tu enlace de *servicio técnico* para coordinar la visita:\n${serviceUrl}\n\nSi necesitas ayuda adicional, dime el *modelo del equipo* y el *síntoma* (por ejemplo, "atasco de papel" o "no imprime").`
          );
          return;
        } else {
          await sendMessage(
            senderJid,
            'No encontré coincidencia de tu empresa en el sistema. Por favor confirma la *Razón Social / RUC* tal como está registrada o envíanos el *RUC* para validarlo.'
          );
          return;
        }
      }
    }

    // GEMINI
    const response = await geminiService.processMessage(
      normalizedPhone,
      finalMessageText,
      !!mediaType,
      mediaAnalysis,
      anydeskCode
    );

    await sendMessage(senderJid, response);
  } catch (error) {
    logger.error('Error handling incoming message:', error);
  }
}

function extractMessageText(message: proto.IWebMessageInfo): string {
  const messageContent = message.message;
  if (!messageContent) return '';

  if (messageContent.conversation) return messageContent.conversation;
  if (messageContent.extendedTextMessage?.text)
    return messageContent.extendedTextMessage.text;
  if (messageContent.imageMessage?.caption)
    return messageContent.imageMessage.caption;
  if (messageContent.videoMessage?.caption)
    return messageContent.videoMessage.caption;
  if (messageContent.documentMessage?.caption)
    return messageContent.documentMessage.caption;

  return '';
}

// ====================
// Envío de mensajes
// ====================
export async function sendMessage(jid: string, text: string): Promise<void> {
  if (!sock || !isReady) {
    logger.error('WhatsApp client not ready');
    throw new Error('WhatsApp client not ready');
  }

  try {
    const resp = await sock.sendMessage(jid, { text });
    const sentId = resp?.key?.id;
    if (sentId) {
      markBotMessageId(sentId);
      logger.debug(`Marked bot message id=${sentId}`);
    }
    logger.info(`Message sent to ${jid}: ${text.substring(0, 50)}...`);
  } catch (error) {
    logger.error('Error sending message:', error);
    throw error;
  }
}

/**
 * Enviar mensaje directo usando solo número E164 (sin '+')
 * Ej: "51987654321".
 */
export async function sendDirectMessage(
  phoneE164: string,
  text: string
) {
  if (!sock || !isReady) {
    logger.error('WhatsApp client not ready');
    throw new Error('WhatsApp client not ready');
  }

  const clean = phoneE164.replace(/\D/g, '');
  const jid = `${clean}@s.whatsapp.net`;

  try {
    const resp = await sock.sendMessage(jid, { text });

    const sentId = resp?.key?.id;
    if (sentId) {
      markBotMessageId(sentId);
      logger.debug(`Marked bot message id=${sentId} (API direct)`);
    }

    logger.info(`(API) Message sent to ${jid}: ${text.substring(0, 50)}...`);

    return resp;
  } catch (error) {
    logger.error('Error sending direct message:', error);
    throw error;
  }
}

// ====================
// Envío de media
// ====================
export type SendMediaPayload = {
  buffer: Buffer;
  mime: string;
  fileName?: string;
  caption?: string;
  kind?: 'image' | 'video' | 'audio' | 'application';
};

export async function sendMedia(
  jid: string,
  payload: SendMediaPayload
) {
  if (!sock || !isReady) {
    logger.error('WhatsApp client not ready (sendMedia)');
    throw new Error('WhatsApp client not ready');
  }

  const { buffer, mime, fileName, caption } = payload;
  const kind = payload.kind ?? (mime.split('/')[0] as SendMediaPayload['kind']);

  try {
    let resp: any;

    if (kind === 'image') {
      resp = await sock.sendMessage(jid, {
        image: buffer,
        caption,
      });
    } else if (kind === 'video') {
      resp = await sock.sendMessage(jid, {
        video: buffer,
        caption,
      });
    } else if (kind === 'audio') {
      resp = await sock.sendMessage(jid, {
        audio: buffer,
        mimetype: mime,
      });
    } else {
      resp = await sock.sendMessage(jid, {
        document: buffer,
        mimetype: mime,
        fileName: fileName || 'archivo',
        caption,
      });
    }

    const sentId = resp?.key?.id;
    if (sentId) {
      markBotMessageId(sentId);
      logger.debug(`Marked bot media message id=${sentId}`);
    }

    logger.info(
      `Media sent to ${jid}: ${kind} ${fileName ? `(${fileName})` : ''} ${caption ? `| ${caption.substring(0, 50)}…` : ''}`
    );

    return resp;
  } catch (error: any) {
    const boom = error?.output;
    logger.error('Error sending media:', {
      msg: error?.message,
      code: error?.code || boom?.statusCode,
      data: error?.data || boom?.payload,
      stack: error?.stack,
    });
    throw error;
  }
}

/**
 * Igual que sendMedia(), pero pasando solo el número (E164 "51..."),
 * no el jid completo.
 */
export async function sendMediaToPhone(
  phoneE164: string,
  payload: SendMediaPayload
) {
  if (!sock || !isReady) {
    logger.error('WhatsApp client not ready (sendMediaToPhone)');
    throw new Error('WhatsApp client not ready');
  }

  const clean = phoneE164.replace(/\D/g, '');
  const jid = `${clean}@s.whatsapp.net`;

  return sendMedia(jid, payload);
}

// ====================
// Helpers de estado / conexión / QR
// ====================

export async function onWhatsAppExists(e164: string): Promise<boolean> {
  if (!sock) return false;
  try {
    const res = await sock.onWhatsApp(e164);
    if (Array.isArray(res)) return res.some((r) => r.exists);
    return !!(res as any)?.exists;
  } catch (e: any) {
    logger.warn('onWhatsApp check failed (continuing):', e?.message || e);
    return false;
  }
}

/**
 * ¿Está listo para enviar mensajes?
 */
export function getConnectionStatus(): boolean {
  return isReady;
}

/**
 * Teléfono del bot (ej. "51987654321") si ya está logueado.
 */
export function getBotPhoneNumber(): string | null {
  return botPhoneNumber;
}

/**
 * QR "crudo" (texto) y QR como dataURL (imagen base64 embebible)
 * para la vista /auth/qr
 */
export function getQRCode(): string | null {
  return currentQR;
}
export function getQRDataURL(): string | null {
  return qrDataURL;
}
export function hasQR(): boolean {
  return currentQR !== null;
}

/**
 * Devuelve el objeto que le pasas al dashboard (whatsappStatus)
 * para pintar el badge, número del bot y botones.
 */
export function getStatusForDashboard() {
  return {
    connected: isReady,
    hasQR: hasQR(),
    botNumber: botPhoneNumber || null,
  };
}

/**
 * Desconectar sesión actual (logout Baileys) y limpiar estado en memoria.
 * Esta función la vamos a llamar desde /auth/logout-whatsapp.
 */
export async function disconnectSession(): Promise<void> {
  // hacemos logout del socket actual si existe
  if (sock) {
    try {
      await sock.logout();
      logger.info('WhatsApp disconnected via disconnectSession()');
    } catch (error) {
      logger.error('Error disconnecting WhatsApp:', error);
    }
    // Nota: sock.logout() ya invalida las credenciales en baileys_auth,
    // así que la próxima vez que corramos initializeWhatsApp() va a pedir
    // un login nuevo y generará un QR fresco.
  }

  // limpiamos referencias
  sock = null;
  isReady = false;
  botPhoneNumber = null;
  currentQR = null;
  qrDataURL = null;
}

/**
 * Fuerza el estado de "necesitamos nuevo QR".
 * Básicamente marca que no estamos conectados y que cuando volvamos
 * a inicializar WhatsApp se genere un QR otra vez.
 *
 * OJO: con Baileys, después de logout() las creds quedan inválidas,
 * así que al volver a ejecutar initializeWhatsApp() vas a recibir 'qr'
 * en connection.update, y eso va a poblar currentQR / qrDataURL otra vez.
 *
 * forceNewQRState() puede simplemente re-llamar initializeWhatsApp()
 * para que el QR aparezca ASAP, sin que el admin tenga que reiniciar
 * el proceso Node.
 */
export async function forceNewQRState(): Promise<void> {
  // Estamos explícitamente diciendo "rearranca el cliente para generar QR"
  try {
    await initializeWhatsApp();
    logger.info('forceNewQRState(): WhatsApp client reinitialized, waiting for QR scan');
  } catch (err) {
    logger.error('forceNewQRState() failed to reinitialize WhatsApp:', err);
    // Si falla, igual nos quedamos desconectados.
  }
}

/**
 * Compat: método antiguo 'disconnect()' que usabas.
 * Lo mantenemos, pero ahora internamente delega a disconnectSession().
 */
export async function disconnect(): Promise<void> {
  await disconnectSession();
}
