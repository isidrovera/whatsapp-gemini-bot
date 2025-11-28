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
import { logger } from '../utils/logger.js';

import fs from 'fs';
import path from 'path';

import * as blockedModel from '../models/blocked.js';
import * as contactModel from '../models/contact.js';
import * as geminiService from './gemini.js';

// Media helpers
import {
  getMediaType,
  processImage,
  processVideo,
  processAudio,
  processDocument,
  extractAnydeskCodeFromAnalysis,
  type MediaAnalysisResult,
} from './imageProcessor.js';

import {
  isGroupJid,
  normalizePhone,
  extractPhoneFromJid,
} from '../utils/validators.js';

// Dinámicos (horarios / plantillas / autorespuestas)
import * as workingHoursModel from '../models/workingHours.js';
import * as systemVarModel from '../models/systemVar.js';
import * as messageTemplateModel from '../models/template.js';
import * as autoResponseModel from '../models/autoResponse.js';

// Odoo
import {
  detectServiceIntent,
  detectTonerIntent,
  getOdooServiceLink,
} from './odoo.js';

// Tags (HUMANO / URGENTE / etc)
import * as tagModel from '../models/tag.js';

// Prisma directo (para guardar RUC provisional legacy)
import { getPrismaClient } from '../config/database.js';
const prisma = getPrismaClient();

// ==================================================
// ESTADO INTERNO WHATSAPP
// ==================================================
let sock: WASocket | null = null;
let isReady = false;
let botPhoneNumber: string | null = null;
const startTime = Date.now();

let currentQR: string | null = null;
let qrDataURL: string | null = null;

const HUMAN_TAKEOVER_COMMAND = '/humano';
const RELEASE_TAKEOVER_COMMAND = '/auto';

const botSentMessageIds = new Map<string, number>();
const BOT_ID_TTL_MS = 5 * 60 * 1000;

// ==================================================
// AUTH FOLDER HELPERS
// ==================================================
const AUTH_FOLDER = path.resolve('./baileys_auth');

async function ensureCleanAuthFolder() {
  try {
    if (fs.existsSync(AUTH_FOLDER)) {
      fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
      logger.warn('🗑️ AUTH anterior eliminada.');
    }
    fs.mkdirSync(AUTH_FOLDER, { recursive: true });
    logger.info('📁 AUTH folder creada nuevamente (clean).');
  } catch (err) {
    logger.error({ err }, 'No se pudo limpiar/recrear AUTH_FOLDER:');
  }
}

// ==================================================
// HELPERS INTERNOS BASE
// ==================================================
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

function normalizeJidToPhone(remoteJid: string): string {
  if (!remoteJid) return '';
  const leftSide = remoteJid.split('@')[0];
  const justNumber = leftSide.split(':')[0];
  return justNumber.replace(/\D/g, '');
}

/**
 * Valida de forma simple que el número "parezca" un teléfono real.
 * En este caso asumimos Perú (E.164 sin '+'): 51 + 9 dígitos = 11 caracteres.
 *
 * Ejemplo válido: 51994681222
 */
function isLikelyRealPhone(phone: string | null | undefined): boolean {
  if (!phone) return false;
  return /^51\d{9}$/.test(phone);
}

// ==================================================
// URGENCIA
// ==================================================
function esUrgente(text: string): boolean {
  const lower = (text || '').toLowerCase();
  return (
    lower.includes('urgente') ||
    lower.includes('es urgente') ||
    lower.includes('emergencia') ||
    lower.includes('soporte urgente') ||
    lower.includes('ayuda urgente')
  );
}

// ==================================================
// MENÚ PRINCIPAL (dinámico por plantilla)
// ==================================================
async function buildMainMenu(contact: any): Promise<string> {
  const { companyName } = contactModel.resolvePrimaryCompany(contact) || {};

  // Prioridad: plantilla MessageTemplate -> 'menu'/'main_menu', si no existe usar 'MAIN_MENU__DEFAULT'
  let dynamicMenu: string | null = null;

  try {
    const tplList = await messageTemplateModel.getByCategory('menu');
    let tpl = tplList.find((t) => (t.name || '').toLowerCase() === 'main_menu');
    if (!tpl) {
      tpl = tplList.find((t) => (t.name || '').toUpperCase() === 'MAIN_MENU__DEFAULT');
    }
    if (tpl?.content) dynamicMenu = tpl.content;
  } catch {
    dynamicMenu = null;
  }

  const varsBase = {
    customer_name: contact?.name || '',
    company_name: companyName || contact?.companyName || '',
  };

  if (dynamicMenu) {
    return messageTemplateModel.render(dynamicMenu, varsBase);
  }

  // Fallback
  return (
    `👋 Hola ${varsBase.customer_name || ''}` +
    `${varsBase.company_name ? ` (${varsBase.company_name})` : ''}\n\n` +
    `Por favor elige una opción:\n` +
    `1️⃣ Solicitud de *servicio técnico en sitio*\n` +
    `2️⃣ Solicitud de *tóner / suministros*\n` +
    `3️⃣ *Asistencia remota* (AnyDesk / foto de pantalla)\n` +
    `4️⃣ *Cambiar empresa activa* (si trabajas con más de una)\n` +
    `5️⃣ Hablar con un *Técnico*`
  );
}

// ==================================================
// MENÚ SELECCIÓN EMPRESA
// ==================================================
function buildCompanySelectionMenu(contact: any): string {
  if (!contact.companies || contact.companies.length === 0) {
    return 'No encuentro empresas asociadas a tu número 😕';
  }

  let msg =
    'Tienes más de una empresa asociada.\n¿Con cuál quieres continuar?\n\n';
  contact.companies.forEach((cc: any, idx: number) => {
    const name = cc.company?.name || cc.company?.razonSocial || '—';
    const ruc = cc.company?.ruc || cc.company?.numeroDoc || '—';
    msg += `${idx + 1}️⃣ ${name} (${ruc})\n`;
  });
  msg += `\nEscribe el número de la empresa.`;

  return msg;
}

// ==================================================
// MENSAJE FUERA DE HORARIO
// ==================================================
async function replyOutOfHours(jid: string) {
  const status = await workingHoursModel.getStatusInfo(new Date());
  const [nextOpen, tz, aftTpl, brTpl, holTpl] = await Promise.all([
    workingHoursModel.getNextOpenDateTime(new Date()),
    systemVarModel.getBusinessTimezone(),
    systemVarModel.getAfterHoursTemplate(),
    systemVarModel.getBreakTemplate(),
    systemVarModel.getHolidayTemplate(),
  ]);

  const open = status?.todayHours?.openTime || '--:--';
  const close = status?.todayHours?.closeTime || '--:--';
  const break_start = status?.todayHours?.breakStart || '';
  const break_end = status?.todayHours?.breakEnd || '';
  const break_hint =
    status?.reason === 'break' && break_end ? ` (volvemos ${break_end})` : '';
  const next_open_line = nextOpen
    ? `Volvemos a estar disponibles: ${workingHoursModel.formatDateTime(
        nextOpen,
        tz
      )}.`
    : 'Te responderemos apenas volvamos a estar disponibles.';

  const reasonMap: Record<string, string> = {
    holiday: 'Hoy es día no laborable',
    closure: 'Hoy nuestro local está cerrado',
    non_workday: 'Hoy no tenemos atención',
    before_open: 'Aún no abrimos',
    after_close: 'Ya cerramos por hoy',
    break: 'Estamos en horario de refrigerio',
  };
  const reason =
    reasonMap[status?.reason || 'closure'] || 'Estamos fuera de horario';

  let template = aftTpl;
  if (status?.reason === 'break') template = brTpl;
  if (status?.reason === 'holiday' || status?.reason === 'closure')
    template = holTpl;

  const event_type = status?.reason || '';
  const event_title = status?.todayEvent?.title || '';

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

  await sendMessage(jid, msg);
}

// ==================================================
// POLÍTICA: URGENTE FUERA DE HORARIO (sin humano)
// ==================================================
async function marcarUrgenteSinTakeover(phoneE164: string) {
  // Aseguramos tag HUMANO (para priorizar), pero NO ponemos takeover.
  let allTags = await tagModel.getAll();
  let humanTag = allTags.find(
    (t: any) => (t.name || '').toUpperCase() === 'HUMANO'
  );
  if (!humanTag) {
    humanTag = await tagModel.create({
      name: 'HUMANO',
      color: '#ff0000',
      description: 'Casos a priorizar',
    });
  }
  const existingTags = await tagModel.getByConversation(phoneE164);
  const alreadyTagged = existingTags.some(
    (t: any) => (t.name || '').toUpperCase() === 'HUMANO'
  );
  if (!alreadyTagged) {
    await tagModel.assignToConversation(phoneE164, humanTag.id);
  }
}

// ==================================================
// EXTRAER TEXTO
// ==================================================
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

// ==================================================
// LINK A ODOO
// ==================================================
async function generateOdooLinkForContact(contact: any, phone: string) {
  const { companyName } = contactModel.resolvePrimaryCompany(contact);
  if (!companyName) return null;
  const userName = contact.name || 'Usuario';
  return await getOdooServiceLink(companyName, userName, phone);
}

// Guarda RUC provisional legacy (si lo usas en WAITING_COMPANY_NAME)
async function saveProvisionalRUC(phoneE164: string, ruc: string) {
  try {
    await prisma.contact.update({
      where: { phoneNumber: phoneE164 },
      data: { ruc },
    });
  } catch (err) {
    logger.warn({ err }, 'No se pudo guardar RUC provisional:');
  }
}

// ==================================================
// INICIALIZACIÓN (BAILEYS)
// ==================================================
export async function initializeWhatsApp(forceNew: boolean = false) {
  try {
    logger.info(
      `Initializing WhatsApp client (Baileys v7)... forceNew=${forceNew}`
    );

    if (forceNew) {
      await ensureCleanAuthFolder();
    }

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
        logger.info('QR Code received, scan to authenticate:');
        qrcode.generate(qr, { small: true });

        currentQR = qr;
        try {
          qrDataURL = await QRCode.toDataURL(qr);
          logger.info('✅ QR available at: http://localhost:3000/auth/qr');
        } catch (error) {
          logger.error({ err: error }, 'Error generating QR data URL:');
          qrDataURL = null;
        }

        isReady = false;
        botPhoneNumber = null;
      }

      if (connection === 'close') {
        const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;

        if (statusCode === DisconnectReason.loggedOut) {
          logger.warn(
            '⚠️ loggedOut (device_removed). Limpiando auth y reiniciando para QR nuevo...'
          );

          sock = null;
          isReady = false;
          botPhoneNumber = null;
          currentQR = null;
          qrDataURL = null;

          setTimeout(() => {
            initializeWhatsApp(true).catch((err) =>
              logger.error({ err }, 'Error reinitializing after loggedOut:')
            );
          }, 1000);
          return;
        }

        logger.warn({ statusCode }, 'Connection closed. Reconnecting...');

        isReady = false;
        botPhoneNumber = null;
        currentQR = null;
        qrDataURL = null;

        setTimeout(() => {
          initializeWhatsApp().catch((err) =>
            logger.error({ err }, 'Error reinitializing WhatsApp:')
          );
        }, 3000);
      }

      if (connection === 'open') {
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
    logger.error({ err: error }, 'Error initializing WhatsApp:');
    throw error;
  }
}

// ==================================================
// MENSAJES DEL MISMO NÚMERO (AGENTE HUMANO)
// ==================================================
async function handleAgentMessageFromMe(
  senderJid: string,
  message: proto.IWebMessageInfo
) {
  const messageText = extractMessageText(message);
  const textLower = (messageText || '').toLowerCase().trim();

  const phoneNumber = normalizeJidToPhone(senderJid);
  const normalizedPhone = normalizePhone(phoneNumber);

  if (textLower === HUMAN_TAKEOVER_COMMAND) {
    await contactModel.setHumanTakeover(normalizedPhone);
    logger.info(`[HUMAN-TAKEOVER] ✋ Manually activated for ${normalizedPhone}`);
    return;
  }

  if (textLower === RELEASE_TAKEOVER_COMMAND) {
    await contactModel.releaseHumanTakeover(normalizedPhone);
    logger.info(
      `[BOT-REACTIVATED] 🤖 Manually reactivated for ${normalizedPhone}`
    );
    return;
  }

  // Cualquier mensaje del agente renueva takeover
  if (messageText && messageText.trim().length > 0) {
    const contact = await contactModel.findByPhone(normalizedPhone);
    const now = new Date();
    const oneHourInMs = 60 * 60 * 1000;

    if (!contact?.humanTakeoverAt) {
      await contactModel.setHumanTakeover(normalizedPhone);
      logger.info(
        `[HUMAN-TAKEOVER] 🙋 Agent message detected for ${normalizedPhone}`
      );
    } else {
      const diff = now.getTime() - contact.humanTakeoverAt.getTime();
      if (diff > oneHourInMs) {
        await contactModel.setHumanTakeover(normalizedPhone);
        logger.info(
          `[HUMAN-TAKEOVER] 🔄 Renewed for ${normalizedPhone} (previous expired)`
        );
      } else {
        await contactModel.setHumanTakeover(normalizedPhone);
        logger.info(
          `[HUMAN-TAKEOVER] ⏰ Extended for ${normalizedPhone} - Human still active`
        );
      }
    }
  }
}

// ==================================================
// HANDLER PRINCIPAL
// ==================================================
async function handleIncomingMessage(
  message: proto.IWebMessageInfo,
  upsertType?: UpsertType
) {
  try {
    if ((message.messageTimestamp as number) * 1000 < startTime) return;

    const key = message.key;
    const senderJid = key?.remoteJid ?? key?.participant;

    if (!senderJid) {
      logger.warn('Received message without remoteJid/participant, ignoring');
      return;
    }

    if (senderJid === 'status@broadcast') {
      logger.debug('[WA] Ignorando mensaje de status@broadcast');
      return;
    }


    if (upsertType === 'append') {
      logger.debug('Ignoring local append upsert (likely our own send)');
      return;
    }
    if (!message.key || !message.key.id) {
      logger.debug('Ignoring message without valid key');
      return;
    }
    if (isFromBotById(message.key.id)) {
      logger.debug(
        `Ignoring message id=${message.key.id} (sent by bot recently)`
      );
      return;
    }

    if (message.key.fromMe) {
      await handleAgentMessageFromMe(senderJid, message);
      return;
    }

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

    // ----------------------------------------------------------
// 3) Resolver teléfono E.164 y verificar que sea "real"
// ----------------------------------------------------------
const phoneNumberRaw = normalizeJidToPhone(senderJid);

// Si no hay dígitos en el JID (por ejemplo status@broadcast), salimos
if (!phoneNumberRaw) {
  logger.warn(
    `[PARSER] JID "${senderJid}" no contiene número utilizable, ignorando mensaje`
  );
  return;
}

// AQUÍ SÍ usamos normalizePhone
const phoneE164 = normalizePhone(phoneNumberRaw);

// Validamos que parezca un número E.164 peruano (51 + 9 dígitos)
if (!isLikelyRealPhone(phoneE164)) {
  logger.error(
    `[PARSER] No se pudo extraer un teléfono válido del JID "${senderJid}" -> "${phoneNumberRaw}" (candidate="${phoneE164}")`
  );
  // No creamos contacto con "teléfono raro" (LID). Preferimos ignorar
  // este mensaje antes que contaminar la tabla contacts con phoneNumber=6503...
  return;
}

    // 1) Bloqueos / permisos
    const isBlockedNum = await blockedModel.isBlocked(phoneE164);
    if (isBlockedNum) {
      logger.info(
        `[BLOCKED] Message from ${phoneE164} - completely blocked`
      );
      return;
    }

    const permissions = await blockedModel.getPermissions(phoneE164);

    // 2) Human takeover vigente (en horario hábil)
    const shouldRespond = await contactModel.shouldBotRespond(phoneE164);
    if (!shouldRespond) {
      logger.info(
        `[BOT-PAUSED] 🤫 Skipping response for ${phoneE164} - human takeover active`
      );
      return;
    }

    // 3) Texto y media
    const rawText = extractMessageText(message);
    const mediaType = getMediaType(message);

    let mediaAnalysisResult: MediaAnalysisResult | null = null;
    let anydeskCode: string | null = null;
    let finalMessageTextFromMedia: string | null = null;

    if (mediaType) {
      logger.info(
        `[WHATSAPP] Processing ${mediaType} from ${phoneE164}...`
      );

      try {
        if (mediaType === 'image') {
          mediaAnalysisResult = await processImage(message);
        } else if (mediaType === 'audio') {
          mediaAnalysisResult = await processAudio(message);
        } else if (mediaType === 'video') {
          mediaAnalysisResult = await processVideo(message);
        } else if (mediaType === 'document') {
          mediaAnalysisResult = await processDocument(message);
        }

        if (mediaAnalysisResult) {
          anydeskCode = extractAnydeskCodeFromAnalysis(mediaAnalysisResult);
          if (anydeskCode) logger.info(`[ANYDESK] Code extracted: ${anydeskCode}`);

          finalMessageTextFromMedia =
            mediaAnalysisResult.ocrText ||
            mediaAnalysisResult.rawSummary ||
            null;

          logger.info(
            {
              summary: mediaAnalysisResult.rawSummary,
              serial: mediaAnalysisResult.detectedSerial,
              errorCode: mediaAnalysisResult.detectedErrorCode,
              anydesk: mediaAnalysisResult.detectedAnydesk,
              class: mediaAnalysisResult.mediaTypeClass,
            },
            '[WHATSAPP] Media analysis summary:'
          );
        }
      } catch (err: any) {
        logger.error(
          {
            message: err?.message,
            stack: err?.stack,
          },
          '[WHATSAPP] Media processing error:'
        );
      }
    }

    let finalMessageText = (rawText || '').trim();
    if (!finalMessageText) {
      if (finalMessageTextFromMedia) {
        finalMessageText = finalMessageTextFromMedia.trim();
      } else if (mediaType) {
        finalMessageText = `[El usuario envió ${mediaType} con información técnica detectada]`;
      } else {
        logger.info('Empty message received - ignoring');
        return;
      }
    }

    logger.info(
      `Message from ${phoneE164}: ${finalMessageText.substring(
        0,
        120
      )}... ${mediaType ? `[+${mediaType.toUpperCase()}]` : ''}`
    );

    // 4) Contacto y estado
    await contactModel.getOrCreate(phoneE164);
    let contact = await contactModel.findByPhone(phoneE164);
    if (!contact) {
      logger.error(
        `[CONTACT] Failed to create or retrieve contact for ${phoneE164}`
      );
      return;
    }
    let state = contact.state || 'NEW';

    // 5) Horario
    const status = await workingHoursModel.getStatusInfo(new Date());
    const negocioCerrado = !status?.isOpen;

    // Si está cerrado, informamos SIEMPRE una vez:
    if (negocioCerrado) {
      await replyOutOfHours(senderJid);

      // Si dice "urgente", SOLO tag; NO takeover
      if (esUrgente(finalMessageText)) {
        await marcarUrgenteSinTakeover(phoneE164);
      }
      // Continuamos con flujo (links/AI), pero se bloquea derivación humana más abajo.
    }

    // ==========================================================
    // 6) NIVEL DE ACCESO RESTRINGIDO
    // ==========================================================
    if (permissions.accessLevel === 'RESTRICTED') {
      logger.info(
        `[RESTRICTED] ${phoneE164} - Only auto-responses allowed`
      );

      const canUseAutoResponse = permissions.permissions.autoresponse ?? false;

      if (canUseAutoResponse) {
        const autoResp = await autoResponseModel.findAndProcessResponse(
          finalMessageText,
          {
            contact: {
              name: contact.name || '',
              dni: contact.dni || '',
              phoneNumber: phoneE164,
              companyName: contact.companyName || '',
              ruc: contact.ruc || '',
            },
            company: {
              razonSocial: contact.companyName || '',
              numeroDoc: contact.ruc || '',
              name: contact.companyName || '',
              ruc: contact.ruc || '',
            },
            customVars: {},
          }
        );


        if (autoResp) {
          await sendMessage(senderJid, autoResp);
        } else {
          await sendMessage(
            senderJid,
            '⚠️ Tu acceso está restringido. Solo puedo responder consultas básicas. Para más información contacta a soporte.'
          );
        }
      } else {
        await sendMessage(
          senderJid,
          '⚠️ Tu acceso está restringido. Para más información contacta a soporte.'
        );
      }
      return;
    }

    // ==========================================================
    // 7) AUTO-RESPUESTAS (si tiene permiso)
    // ==========================================================
    const canUseAutoResponse = permissions.permissions.autoresponse ?? true;

    if (canUseAutoResponse) {
      const autoResp = await autoResponseModel.findAndProcessResponse(
        finalMessageText,
        {
          contact: {
            name: contact.name || '',
            dni: contact.dni || '',
            phoneNumber: phoneE164,
            companyName: contact.companyName || '',
            ruc: contact.ruc || '',
          },
          company: {
            razonSocial: contact.companyName || '',
            numeroDoc: contact.ruc || '',
            name: contact.companyName || '',
            ruc: contact.ruc || '',
          },
          customVars: {},
        }
      );


      if (autoResp) {
        logger.info(
          `[AUTO-RESPONSE] Sent auto-response for ${phoneE164}`
        );
        await sendMessage(senderJid, autoResp);
        // Si quisieras cortar aquí, podrías return; (dejamos fluir por si necesita AI).
      }
    }

    // ==========================================================
    // 8) REGISTRO (DNI / RUC / EMPRESA)
    // ==========================================================
    if (state === 'NEW') {
      await contactModel.updateState(phoneE164, 'WAITING_DNI');
      await sendMessage(
        senderJid,
        '¡Hola! 👋 Para continuar, por favor envíame tu *DNI (8 dígitos)* para validar tu identidad y registrar tu nombre. 🙏'
      );
      return;
    }

    if (state === 'WAITING_DNI') {
      const dniCandidate = finalMessageText.trim();
      const isDniValid = /^\d{8}$/.test(dniCandidate);

      if (!isDniValid) {
        await sendMessage(
          senderJid,
          'El DNI debe tener exactamente 8 dígitos numéricos. Inténtalo nuevamente 🙌'
        );
        return;
      }

      const persona = await (await import('./external.js')).validateDNI(
        dniCandidate
      );

      if (!persona) {
        await sendMessage(
          senderJid,
          'No pude validar el DNI en RENIEC. Por favor verifica que sea correcto o inténtalo más tarde.'
        );
        return;
      }

      const nombreCompleto = `${persona.nombres} ${persona.apellidoPaterno} ${persona.apellidoMaterno}`.trim();

      await contactModel.updateDNI(
        phoneE164,
        dniCandidate,
        nombreCompleto
      );

      await sendMessage(
        senderJid,
        `Perfecto ✅ ${nombreCompleto}.\nAhora envíame el *RUC de tu empresa (11 dígitos)* para asociarte.`
      );
      return;
    }

    if (state === 'WAITING_RUC') {
      const rucCandidate = finalMessageText.trim();
      const isRucBasicValid = /^\d{11}$/.test(rucCandidate);

      if (!isRucBasicValid) {
        await sendMessage(
          senderJid,
          'El RUC debe tener exactamente 11 dígitos numéricos. Inténtalo nuevamente 🙌'
        );
        return;
      }

      const linkRes =
        await contactModel.linkExistingCompanyByRucAndSetPrimary(
          phoneE164,
          rucCandidate
        );

      if (linkRes.ok === true) {
        contact = await contactModel.findByPhone(phoneE164);
        if (!contact) {
          logger.error(
            `[CONTACT] Contact disappeared after linking company for ${phoneE164}`
          );
          return;
        }

        if (contact.companies && contact.companies.length > 1) {
          await contactModel.updateState(phoneE164, 'SELECTING_COMPANY');
          await sendMessage(
            senderJid,
            `He verificado tu empresa con RUC ${rucCandidate} ✅`
          );
          await sendMessage(senderJid, buildCompanySelectionMenu(contact));
          return;
        }

        await contactModel.updateState(phoneE164, 'MENU');
        contact = await contactModel.findByPhone(phoneE164);
        if (!contact) {
          logger.error(
            `[CONTACT] Contact disappeared after state update for ${phoneE164}`
          );
          return;
        }

        await sendMessage(
          senderJid,
          `¡Excelente! Quedaste registrado con ${contact.companyName} ✅`
        );
        await sendMessage(senderJid, await buildMainMenu(contact));
        return;
      }

      const infoRuc = await (await import('./external.js')).validateRUC(
        rucCandidate
      );

      if (!infoRuc) {
        await contactModel.updateState(phoneE164, 'WAITING_COMPANY_NAME');
        await saveProvisionalRUC(phoneE164, rucCandidate);

        await sendMessage(
          senderJid,
          'No pude validar el RUC en SUNAT. Por favor envíame el *nombre o razón social de tu empresa* tal como debería figurar.'
        );
        return;
      }

      const razonSocial =
        infoRuc.razonSocial || `Empresa ${rucCandidate}`.trim();

      await contactModel.updateRUC(phoneE164, rucCandidate, razonSocial);

      contact = await contactModel.findByPhone(phoneE164);
      if (!contact) {
        logger.error(
          `[CONTACT] Contact disappeared after RUC update for ${phoneE164}`
        );
        return;
      }

      if (contact.companies && contact.companies.length > 1) {
        await contactModel.updateState(phoneE164, 'SELECTING_COMPANY');

        await sendMessage(
          senderJid,
          `He registrado la empresa: ${razonSocial} ✅`
        );
        await sendMessage(senderJid, buildCompanySelectionMenu(contact));
        return;
      }

      await contactModel.updateState(phoneE164, 'MENU');
      contact = await contactModel.findByPhone(phoneE164);
      if (!contact) {
        logger.error(`[CONTACT] Contact disappeared for ${phoneE164}`);
        return;
      }

      await sendMessage(
        senderJid,
        `¡Excelente! Quedaste registrado con ${contact.companyName} ✅`
      );
      await sendMessage(senderJid, await buildMainMenu(contact));
      return;
    }

    if (state === 'WAITING_COMPANY_NAME') {
      const razonSocialManual = finalMessageText.trim();

      contact = await contactModel.findByPhone(phoneE164);
      if (!contact) {
        logger.error(`[CONTACT] Contact not found for ${phoneE164}`);
        return;
      }

      const provisionalRuc = contact.ruc || '';

      if (!provisionalRuc || provisionalRuc.length !== 11) {
        await contactModel.updateState(phoneE164, 'WAITING_RUC');
        await sendMessage(
          senderJid,
          'Necesito nuevamente el RUC (11 dígitos) para poder registrar tu empresa. 🙏'
        );
        return;
      }

      await contactModel.updateRUC(
        phoneE164,
        provisionalRuc,
        razonSocialManual
      );

      contact = await contactModel.findByPhone(phoneE164);
      if (!contact) {
        logger.error(`[CONTACT] Contact disappeared for ${phoneE164}`);
        return;
      }

      if (contact.companies && contact.companies.length > 1) {
        await contactModel.updateState(phoneE164, 'SELECTING_COMPANY');

        await sendMessage(
          senderJid,
          `He registrado la empresa: ${razonSocialManual} ✅`
        );
        await sendMessage(senderJid, buildCompanySelectionMenu(contact));
        return;
      }

      await contactModel.updateState(phoneE164, 'MENU');
      contact = await contactModel.findByPhone(phoneE164);
      if (!contact) {
        logger.error(`[CONTACT] Contact disappeared for ${phoneE164}`);
        return;
      }

      await sendMessage(
        senderJid,
        `¡Excelente! Quedaste registrado con ${contact.companyName} ✅`
      );
      await sendMessage(senderJid, await buildMainMenu(contact));
      return;
    }

    if (state === 'SELECTING_COMPANY') {
      const idxChosen = parseInt(finalMessageText.trim(), 10) - 1;
      const empresas = contact.companies || [];

      if (
        Number.isNaN(idxChosen) ||
        idxChosen < 0 ||
        idxChosen >= empresas.length
      ) {
        await sendMessage(
          senderJid,
          'Opción no válida. Por favor envía el número de la empresa que deseas usar.'
        );
        return;
      }

      const chosenPivot = empresas[idxChosen];

      await contactModel.setPrimaryCompany(contact.id, chosenPivot.companyId);
      await contactModel.updateState(phoneE164, 'MENU');

      contact = await contactModel.findByPhone(phoneE164);
      if (!contact) {
        logger.error(`[CONTACT] Contact disappeared for ${phoneE164}`);
        return;
      }

      await sendMessage(
        senderJid,
        `Perfecto 👍 Ahora usaré *${contact.companyName}* como tu empresa activa.`
      );
      await sendMessage(senderJid, await buildMainMenu(contact));
      return;
    }

    // ==========================================================
    // 9) OPERACIÓN (MENU / REGISTERED)
    // ==========================================================
    if (state === 'MENU' || state === 'REGISTERED') {
      const trimmed = finalMessageText.trim();

      if (/^(menu|hola|buenas|hi)$/i.test(trimmed)) {
        await sendMessage(senderJid, await buildMainMenu(contact));
        return;
      }

      // 1️⃣ Servicio técnico en sitio (permitido off-hours → crea link)
      if (trimmed === '1') {
        const canUseOdoo = permissions.permissions.odoo ?? true;

        if (!canUseOdoo) {
          logger.warn(
            `[PERMISSION-DENIED] ${phoneE164} - odoo access denied`
          );
          await sendMessage(
            senderJid,
            '⚠️ No tienes permiso para consultar información de servicio técnico.'
          );
          return;
        }

        const link = await generateOdooLinkForContact(contact, phoneE164);
        if (link) {
          await sendMessage(
            senderJid,
            `🛠️ *Solicitud de servicio técnico en sitio*\n` +
              `Completa este formulario:\n${link}\n\n` +
              `Indica el modelo o serie del equipo y cuál es el problema.`
          );
        } else {
          await sendMessage(
            senderJid,
            'No pude generar el enlace de servicio técnico. ' +
              'Por favor confirma la Razón Social / RUC registrada.'
          );
        }
        return;
      }

      // 2️⃣ Tóner / insumos (permitido off-hours)
      if (trimmed === '2') {
        const canCreateTickets = permissions.permissions.tickets ?? true;

        if (!canCreateTickets) {
          logger.warn(
            `[PERMISSION-DENIED] ${phoneE164} - tickets access denied`
          );
          await sendMessage(
            senderJid,
            '⚠️ No tienes permiso para crear solicitudes de tóner.'
          );
          return;
        }

        const link = await generateOdooLinkForContact(contact, phoneE164);
        if (link) {
          await sendMessage(
            senderJid,
            `🖨 *Solicitud de tóner / suministros*\n` +
              `Realiza tu pedido aquí:\n${link}\n\n` +
              `Indica el número de serie del equipo y el color de tóner que necesitas.`
          );
        } else {
          await sendMessage(
            senderJid,
            'No pude generar el enlace de suministros. ' +
              'Confírmame por favor la empresa / RUC.'
          );
        }
        return;
      }

      // 3️⃣ Asistencia remota (permitido off-hours: solo guía/ID, sin humano)
      if (trimmed === '3') {
        await contactModel.updateState(phoneE164, 'WAITING_REMOTE_INFO');
        await sendMessage(
          senderJid,
          '💻 *Asistencia remota*\n' +
            'Envíame el *ID de AnyDesk* (9 dígitos) o una *foto clara de tu pantalla donde se vea el ID*.\n' +
            'Un técnico podrá conectarse cuando estemos en horario de atención 👨‍💻.'
        );
        return;
      }

      // 4️⃣ Cambiar empresa activa
      if (trimmed === '4') {
        const empresas = contact.companies || [];
        if (empresas.length <= 1) {
          await sendMessage(
            senderJid,
            'Actualmente solo tienes una empresa asociada.'
          );
        } else {
          await contactModel.updateState(phoneE164, 'SELECTING_COMPANY');
          await sendMessage(senderJid, buildCompanySelectionMenu(contact));
        }
        return;
      }

      // 5️⃣ Hablar con técnico
      if (trimmed === '5') {
        if (negocioCerrado) {
          await sendMessage(
            senderJid,
            '⏰ En este momento no contamos con atención humana. ' +
              'Puedes usar el *menú* para solicitar servicio, tóner o asistencia remota. ' +
              'Un técnico te responderá cuando estemos en horario.'
          );
          return;
        }

        const canTalkToHuman = permissions.permissions.human ?? true;
        if (!canTalkToHuman) {
          logger.warn(
            `[PERMISSION-DENIED] ${phoneE164} - human access denied`
          );
          await sendMessage(
            senderJid,
            '⚠️ No puedes solicitar atención humana en este momento. ' +
              'Por favor utiliza las opciones del menú automatizado.'
          );
          return;
        }

        await contactModel.setHumanTakeover(phoneE164);
        await sendMessage(
          senderJid,
          '👨‍🔧 Listo. Estoy derivando tu caso a un técnico. Te van a responder en breve.'
        );
        return;
      }

      // Intents libres (servicio / tóner) — permitidos off-hours (vía link)
      if (detectServiceIntent(finalMessageText)) {
        const canUseOdoo = permissions.permissions.odoo ?? true;
        if (!canUseOdoo) {
          await sendMessage(
            senderJid,
            '⚠️ No tienes acceso a solicitudes de servicio técnico.'
          );
          return;
        }

        const link = await generateOdooLinkForContact(contact, phoneE164);
        if (link) {
          await sendMessage(
            senderJid,
            `🛠️ Parece que necesitas soporte técnico.\n` +
              `Completa este formulario y descríbenos el problema:\n${link}`
          );
        } else {
          await sendMessage(
            senderJid,
            'Necesito validar tu Razón Social / RUC para generar el enlace de servicio técnico. ' +
              '¿Cuál es el nombre de tu empresa o el RUC?'
          );
        }
        return;
      }

      if (detectTonerIntent(finalMessageText)) {
        const canCreateTickets = permissions.permissions.tickets ?? true;
        if (!canCreateTickets) {
          await sendMessage(
            senderJid,
            '⚠️ No tienes permiso para crear solicitudes de tóner.'
          );
          return;
        }

        const link = await generateOdooLinkForContact(contact, phoneE164);
        if (link) {
          await sendMessage(
            senderJid,
            `🖨 Entendido, solicitud de tóner / insumos.\n` +
              `Haz tu pedido aquí:\n${link}\n\n` +
              `Indica el color que necesitas y el número de serie del equipo.`
          );
        } else {
          await sendMessage(
            senderJid,
            'Para generar el enlace de suministros necesito la Razón Social / RUC registrada. ¿Me la confirmas?'
          );
        }
        return;
      }

      // Fallback Gemini (permitido off-hours)
      const canUseAI = permissions.permissions.ai ?? true;
      if (canUseAI) {
        const mediaAnalysisJson =
  mediaAnalysisResult ? JSON.stringify(mediaAnalysisResult, null, 2) : '';

        const responseFromGemini = await geminiService.processMessage(
          phoneE164,
          finalMessageText,
          !!mediaType,
          mediaAnalysisJson,                         // string siempre
          anydeskCode ?? '',                         // string
          mediaAnalysisResult?.mediaTypeClass ?? '', // string
          mediaAnalysisResult?.detectedErrorCode ?? '', // string
          mediaAnalysisResult?.detectedSerial ?? ''  // string
        );


        await sendMessage(senderJid, responseFromGemini);
      } else {
        logger.warn(
          `[PERMISSION-DENIED] ${phoneE164} - AI access denied`
        );
        await sendMessage(
          senderJid,
          'Lo siento, no puedo procesar tu mensaje en este momento. ' +
            'Por favor usa las opciones del menú: envía "menu" para ver las opciones disponibles.'
        );
      }
      return;
    }

    // ==========================================================
    // 10) ESPERANDO INFO REMOTA
    // ==========================================================
    if (state === 'WAITING_REMOTE_INFO') {
      // No activamos humano automáticamente.
      await contactModel.updateState(phoneE164, 'MENU');

      contact = await contactModel.findByPhone(phoneE164);
      if (!contact) {
        logger.error(`[CONTACT] Contact disappeared for ${phoneE164}`);
        return;
      }

      await sendMessage(
        senderJid,
        '✅ Gracias. Ya tengo la información para soporte remoto.\n' +
          'Un técnico se conectará contigo o te escribirá en cuanto estemos en horario 👨‍💻'
      );
      return;
    }

    // ==========================================================
    // 11) Estado desconocido → MENU
    // ==========================================================
    logger.warn(
      `[BOT] Estado desconocido "${state}" para ${phoneE164}, forzando MENU`
    );
    await contactModel.updateState(phoneE164, 'MENU');
    contact = await contactModel.findByPhone(phoneE164);
    if (!contact) {
      logger.error(`[CONTACT] Contact disappeared for ${phoneE164}`);
      return;
    }
    await sendMessage(senderJid, await buildMainMenu(contact));
    return;
  } catch (error: any) {
    const debugInfo = {
      errMessage: error?.message,
      stack: error?.stack,
      jid: message?.key?.remoteJid,
      msgId: message?.key?.id,
      upsertType,
    };

    logger.error(
      'Error handling incoming message: ' + JSON.stringify(debugInfo, null, 2)
    );
  }
}


// ==================================================
// ENVÍO DE MENSAJES
// ==================================================
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
    logger.info(`Message sent to ${jid}: ${text.substring(0, 80)}...`);
  } catch (error) {
    logger.error({ err: error }, 'Error sending message:');
    throw error;
  }
}

export async function sendDirectMessage(to: string, text: string) {
  if (!sock || !isReady) {
    logger.error('WhatsApp client not ready');
    throw new Error('WhatsApp client not ready');
  }

  const trimmed = (to || '').trim();
  if (!trimmed) {
    throw new Error('Destino vacío (to)');
  }

  let jid: string;

  // 1) Si ya viene como JID (grupo o contacto), lo usamos tal cual
  //    Ej: 51924894829-1599154643@g.us  (grupo)
  //        51999999999@s.whatsapp.net   (contacto)
  if (trimmed.includes('@')) {
    jid = trimmed;
  } else {
    // 2) Si viene como número, lo normalizamos a JID de persona
    const clean = trimmed.replace(/\D/g, '');
    if (!clean) {
      throw new Error(`Número vacío después de limpiar: "${to}"`);
    }
    jid = `${clean}@s.whatsapp.net`;
  }

  try {
    const resp = await sock.sendMessage(jid, { text });

    const sentId = resp?.key?.id;
    if (sentId) {
      markBotMessageId(sentId);
      logger.debug(`Marked bot message id=${sentId} (API direct)`);
    }

    logger.info(
      `(API) Message sent to ${jid}: ${text.substring(0, 80)}...`
    );
    return resp;
  } catch (error) {
    logger.error({ err: error }, 'Error sending direct message:');
    throw error;
  }
}



// ==================================================
// ENVÍO DE MEDIA
// ==================================================
export type SendMediaPayload = {
  buffer: Buffer;
  mime: string;
  fileName?: string;
  caption?: string;
  kind?: 'image' | 'video' | 'audio' | 'application';
};

export async function sendMedia(to: string, payload: SendMediaPayload) {
  if (!sock || !isReady) {
    logger.error('WhatsApp client not ready (sendMedia)');
    throw new Error('WhatsApp client not ready (sendMedia)');
  }

  const raw = (to || '').trim();
  if (!raw) {
    logger.error('sendMedia: destino vacío');
    throw new Error('Destino vacío en sendMedia');
  }

  // 🔹 Igual lógica: JID si trae '@', número si no
  let jid: string;
  let isJid = false;

  if (raw.includes('@')) {
    isJid = true;
    jid = raw;
  } else {
    const clean = raw.replace(/\D/g, '');
    if (!clean) {
      logger.error('sendMedia: número inválido (sin dígitos)');
      throw new Error('Número inválido en sendMedia');
    }
    jid = `${clean}@s.whatsapp.net`;
  }

  const { buffer, mime, fileName, caption } = payload;
  const kind =
    payload.kind ?? (mime.split('/')[0] as SendMediaPayload['kind']);

  try {
    let resp: any;

    if (kind === 'image') {
      resp = await sock.sendMessage(jid, { image: buffer, caption });
    } else if (kind === 'video') {
      resp = await sock.sendMessage(jid, { video: buffer, caption });
    } else if (kind === 'audio') {
      resp = await sock.sendMessage(jid, { audio: buffer, mimetype: mime });
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
      `Media sent to ${jid} (isJid=${isJid}) from to="${to}": ${kind} ${
        fileName ? `(${fileName})` : ''
      } ${caption ? `| ${caption.substring(0, 50)}…` : ''}`
    );

    return resp;
  } catch (error: any) {
    const boom = error?.output;
    logger.error(
      {
        err: error,
        msg: error?.message,
        code: error?.code || boom?.statusCode,
        data: error?.data || boom?.payload,
        stack: error?.stack,
        to,
      },
      'Error sending media:'
    );
    throw error;
  }
}


export async function sendMediaToPhone(
  phoneOrJid: string,
  payload: SendMediaPayload
) {
  if (!sock || !isReady) {
    logger.error('WhatsApp client not ready (sendMediaToPhone)');
    throw new Error('WhatsApp client not ready (sendMediaToPhone)');
  }

  const raw = (phoneOrJid || '').trim();
  if (!raw) {
    throw new Error('Destino vacío (sendMediaToPhone)');
  }

  let jid: string;

  if (raw.includes('@')) {
    // grupo o contacto JID completo
    jid = raw;
  } else {
    const clean = raw.replace(/\D/g, '');
    if (!clean) {
      throw new Error(`Número vacío después de limpiar: "${phoneOrJid}"`);
    }
    jid = `${clean}@s.whatsapp.net`;
  }

  return sendMedia(jid, payload);
}



// ==================================================
// ESTADO / QR / CONEXIÓN
// ==================================================
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

export function getConnectionStatus(): boolean {
  return isReady;
}

export function getBotPhoneNumber(): string | null {
  return botPhoneNumber;
}

export function getQRCode(): string | null {
  return currentQR;
}
export function getQRDataURL(): string | null {
  return qrDataURL;
}
export function hasQR(): boolean {
  return currentQR !== null;
}

export function getStatusForDashboard() {
  return {
    connected: isReady,
    hasQR: hasQR(),
    botNumber: botPhoneNumber || null,
  };
}

export async function disconnectSession(): Promise<void> {
  if (sock) {
    try {
      await sock.logout();
      logger.info('WhatsApp disconnected via disconnectSession()');
    } catch (error) {
      logger.error({ err: error }, 'Error disconnecting WhatsApp:');
    }
  }

  sock = null;
  isReady = false;
  botPhoneNumber = null;
  currentQR = null;
  qrDataURL = null;
}

export async function forceNewQRState(): Promise<void> {
  try {
    await initializeWhatsApp(true);
    logger.info(
      'forceNewQRState(): WhatsApp client reinitialized, waiting for QR scan'
    );
  } catch (err) {
    logger.error({ err }, 'forceNewQRState() failed to reinitialize WhatsApp:');
  }
}

// ==================================================
// OBTENER GRUPOS DE WHATSAPP
// ==================================================
export async function getWhatsAppGroups(): Promise<Array<{
  id: string;
  name: string;
  participants: number;
  createdAt: string | null;
  description: string | null;
}>> {
  if (!sock || !isReady) {
    logger.error('[WhatsApp] Client not ready to fetch groups');
    throw new Error('WhatsApp client not ready');
  }

  try {
    logger.info('[WhatsApp] Fetching WhatsApp groups...');

    const chats = await sock.groupFetchAllParticipating();
    
    if (!chats || Object.keys(chats).length === 0) {
      logger.warn('[WhatsApp] No groups found');
      return [];
    }

    const groups = Object.values(chats).map((chat: any) => ({
      id: chat.id,
      name: chat.subject || 'Sin nombre',
      participants: chat.participants?.length || 0,
      createdAt: chat.creation 
        ? new Date(chat.creation * 1000).toISOString() 
        : null,
      description: chat.desc || null,
    }));

    logger.info(`✅ [WhatsApp] Found ${groups.length} groups`);
    
    return groups;
  } catch (error) {
    logger.error({ err: error }, '❌ [WhatsApp] Error fetching groups:');
    throw error;
  }
}


export async function disconnect(): Promise<void> {
  await disconnectSession();
}
