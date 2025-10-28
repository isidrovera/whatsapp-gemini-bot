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

import * as blockedModel from '../models/blocked.js';
import * as contactModel from '../models/contact.js';
import * as geminiService from './gemini.js';
import * as imageProcessor from './imageProcessor.js';
import {
  isGroupJid,
  normalizePhone,
  extractPhoneFromJid, // lo seguimos usando solo en casos estables (bot self-id)
} from '../utils/validators.js';

// Horarios / Plantillas
import * as workingHoursModel from '../models/workingHours.js';
import * as systemVarModel from '../models/systemVar.js';

// Odoo
import {
  detectServiceIntent,
  detectTonerIntent,
  getOdooServiceLink,
} from './odoo.js';

// Auto-respuestas
import * as autoResponseModel from '../models/autoResponse.js';
import { replaceVariables } from '../utils/formatters.js';

// 🔄 DNI/RUC externo (RENIEC / SUNAT)
import * as external from './external.js';

// ⭐ MOD: necesitamos acceso directo a prisma aquí para guardar RUC provisional
import { getPrismaClient } from '../config/database.js';
const prisma = getPrismaClient();

// ==================================================
// ESTADO INTERNO WHATSAPP
// ==================================================
let sock: WASocket | null = null;
let isReady = false; // = conectado OK
let botPhoneNumber: string | null = null;
const startTime = Date.now();

// Estado QR / conexión
let currentQR: string | null = null; // string crudo que entrega Baileys
let qrDataURL: string | null = null; // data:image/png;base64,...

// takeover helpers internos
const HUMAN_TAKEOVER_COMMAND = '/humano';
const RELEASE_TAKEOVER_COMMAND = '/auto';

const botSentMessageIds = new Map<string, number>(); // id -> expiresAt
const BOT_ID_TTL_MS = 5 * 60 * 1000;

// ==================================================
// HELPERS INTERNOS
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

/**
 * normaliza un remoteJid tipo
 *   "51924894829@s.whatsapp.net"
 *   "51924894829:10@s.whatsapp.net"
 *   "51924894829:10@newsletter.whatsapp.net"
 * a solo "51924894829"
 */
function normalizeJidToPhone(remoteJid: string): string {
  if (!remoteJid) return '';
  // Parte izquierda antes del "@"
  const leftSide = remoteJid.split('@')[0]; // "5192...:10"
  // Quita sufijo ":10"
  const justNumber = leftSide.split(':')[0]; // "5192..."
  // Asegura dígitos
  return justNumber.replace(/\D/g, '');
}

/**
 * Construye el menú interactivo para el cliente.
 * MOSTRAMOS SIEMPRE que ya está registrado.
 */
function buildMainMenu(contact: any): string {
  // intentamos mostrar la empresa primaria:
  const { companyName } = contactModel.resolvePrimaryCompany(contact) || {};

  return (
    `👋 Hola ${contact.name || ''}${
      companyName ? ` (${companyName})` : ''
    }\n\n` +
    `Por favor elige una opción:\n` +
    `1️⃣ Solicitud de *servicio técnico en sitio*\n` +
    `2️⃣ Solicitud de *tóner / suministros*\n` +
    `3️⃣ *Asistencia remota* (AnyDesk / foto de pantalla)\n` +
    `4️⃣ *Cambiar empresa activa* (si trabajas con más de una)\n` +
    `5️⃣ Hablar con un *Técnico*`
  );
}

/**
 * Menú para elegir empresa activa cuando el contacto tiene varias.
 */
function buildCompanySelectionMenu(contact: any): string {
  if (!contact.companies || contact.companies.length === 0) {
    return 'No encuentro empresas asociadas a tu número 😕';
  }

  let msg =
    'Tienes más de una empresa asociada.\n¿Con cuál quieres continuar?\n\n';
  contact.companies.forEach((cc: any, idx: number) => {
    msg += `${idx + 1}️⃣ ${cc.company.name} (${cc.company.ruc})\n`;
  });
  msg += `\nEscribe el número de la empresa.`;

  return msg;
}

/**
 * Envía mensaje fuera de horario usando plantillas configurables.
 */
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

/**
 * Extrae el texto limpio de un mensaje entrante de WhatsApp.
 */
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

/**
 * Genera la URL única de servicio / tóner en base a la empresa primaria del contacto.
 */
async function generateOdooLinkForContact(contact: any, phone: string) {
  const { companyName } = contactModel.resolvePrimaryCompany(contact);
  if (!companyName) return null;
  const userName = contact.name || 'Usuario';
  return await getOdooServiceLink(companyName, userName, phone);
}

// ⭐ MOD: guarda el RUC provisional cuando el RUC no existe en BD aún
async function saveProvisionalRUC(phoneE164: string, ruc: string) {
  try {
    await prisma.contact.update({
      where: { phoneNumber: phoneE164 },
      data: { ruc },
    });
  } catch (err) {
    logger.warn('No se pudo guardar RUC provisional:', err);
  }
}

// ==================================================
// INICIALIZACIÓN WHATSAPP (Baileys)
// ==================================================
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
        // QR recibido → aún no conectado
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

        isReady = false;
        botPhoneNumber = null;
      }

      if (connection === 'close') {
        const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        logger.warn('Connection closed. Reconnecting:', shouldReconnect);

        // Marcar estado desconectado
        isReady = false;
        botPhoneNumber = null;

        if (shouldReconnect) {
          // Reintentar conexión
          setTimeout(() => initializeWhatsApp(), 3000);
        } else {
          // loggedOut => hay que borrar baileys_auth manualmente
          logger.error(
            'Logged out. Please delete baileys_auth folder and restart.'
          );
          currentQR = null;
          qrDataURL = null;
        }
      }

      if (connection === 'open') {
        // Conexión OK
        logger.info('✅ WhatsApp connected successfully!');
        isReady = true;
        currentQR = null;
        qrDataURL = null;

        if (sock?.user?.id) {
          // Acá podemos usar extractPhoneFromJid porque el jid de "yo" no viene con :10
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

// ==================================================
// MENSAJES QUE ENVÍA EL HUMANO DESDE EL MISMO NÚMERO (fromMe)
// ==================================================
async function handleAgentMessageFromMe(
  senderJid: string,
  message: proto.IWebMessageInfo
) {
  const messageText = extractMessageText(message);
  const textLower = (messageText || '').toLowerCase().trim();

  // usamos normalizeJidToPhone para cubrir casos tipo ":10@s.whatsapp.net"
  const phoneNumber = normalizeJidToPhone(senderJid);
  const normalizedPhone = normalizePhone(phoneNumber);

  // comandos manuales takeover
  if (textLower === HUMAN_TAKEOVER_COMMAND) {
    await contactModel.setHumanTakeover(normalizedPhone);
    logger.info(
      `[HUMAN-TAKEOVER] ✋ Manually activated for ${normalizedPhone}`
    );
    return;
  }

  if (textLower === RELEASE_TAKEOVER_COMMAND) {
    await contactModel.releaseHumanTakeover(normalizedPhone);
    logger.info(
      `[BOT-REACTIVATED] 🤖 Manually reactivated for ${normalizedPhone}`
    );
    return;
  }

  // cualquier mensaje del humano = activar / renovar takeover
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
// HANDLER PRINCIPAL DE MENSAJES ENTRANTES (CLIENTE)
// ==================================================
async function handleIncomingMessage(
  message: proto.IWebMessageInfo,
  upsertType?: UpsertType
) {
  try {
    // Ignorar mensajes anteriores al arranque del proceso
    if ((message.messageTimestamp as number) * 1000 < startTime) return;

    const senderJid = message.key.remoteJid;
    if (!senderJid) return;

    // Evitar eco de mensajes que nosotros mismos acabamos de mandar
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

    // Mensajes enviados por el mismo número del bot (agente humano respondiendo manualmente)
    if (message.key.fromMe) {
      await handleAgentMessageFromMe(senderJid, message);
      return;
    }

    // Ignorar / bloquear grupos
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

    // === Cliente real / chat 1 a 1 ===
    // IMPORTANTE: usamos normalizeJidToPhone para soportar JIDs con sufijos tipo ":10"
    const phoneNumberRaw = normalizeJidToPhone(senderJid);
    const normalizedPhone = normalizePhone(phoneNumberRaw);

    if (!normalizedPhone) {
      logger.error(
        `[PARSER] Could not normalize phone from JID "${senderJid}" -> "${phoneNumberRaw}"`
      );
      return;
    }

    // Está bloqueado?
    const isBlockedNum = await blockedModel.isBlocked(normalizedPhone);
    if (isBlockedNum) {
      logger.info(
        `Message from blocked number ${normalizedPhone} - ignoring`
      );
      return;
    }

    // takeover humano activo?
    const shouldRespond = await contactModel.shouldBotRespond(normalizedPhone);
    if (!shouldRespond) {
      logger.info(
        `[BOT-PAUSED] 🤫 Skipping response for ${normalizedPhone} - human takeover active`
      );
      return;
    }

    // horario de atención (defensivo)
    const status = await workingHoursModel.getStatusInfo(new Date());
    if (!status || status.isOpen === false) {
      await replyOutOfHours(senderJid);
      return;
    }

    // Extraer contenido
    const rawText = extractMessageText(message);
    const mediaType = imageProcessor.getMediaType(message);

    let mediaAnalysis: string | null = null;
    let anydeskCode: string | null = null;

    if (mediaType) {
      logger.info(
        `[WHATSAPP] Processing ${mediaType} from ${normalizedPhone}...`
      );

      switch (mediaType) {
        case 'image': {
          mediaAnalysis = await imageProcessor.processImage(message);
          if (mediaAnalysis) {
            anydeskCode = imageProcessor.extractAnydeskCode(mediaAnalysis);
            if (anydeskCode) {
              logger.info(`[ANYDESK] Code extracted: ${anydeskCode}`);
            }
          }
          break;
        }
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

    // mensaje final de texto para procesar
    let finalMessageText = rawText;
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
      `Message from ${normalizedPhone}: ${finalMessageText.substring(
        0,
        80
      )}... ${mediaType ? `[+${mediaType.toUpperCase()}]` : ''}`
    );

    // Asegurar contacto en BD (esto crea el contacto si es la primera vez)
    await contactModel.getOrCreate(normalizedPhone);
    let contact = await contactModel.findByPhone(normalizedPhone);
    let state = contact?.state || 'NEW';

    // --------------------------------------------
    // 1. AUTO-RESPUESTAS
    // --------------------------------------------
    const autoResp = await autoResponseModel.findByTrigger(finalMessageText);
    if (autoResp) {
      logger.info(
        `[AUTO-RESPONSE] Matched trigger "${autoResp.trigger}" for ${normalizedPhone}`
      );

      const systemVars = await systemVarModel.getVariablesForPrompt();
      const responseText = replaceVariables(autoResp.response, {
        ...systemVars,
        name: contact?.name || 'Usuario',
        company_name_user: contact?.companyName || 'su empresa',
        phone: normalizedPhone,
      });

      await sendMessage(senderJid, responseText);
      logger.info(
        `[AUTO-RESPONSE] Sent response (category: ${
          autoResp.category || 'none'
        })`
      );
      return;
    }

    // --------------------------------------------
    // 2. FLUJO DE REGISTRO (DNI -> nombre -> RUC -> empresa)
    //
    // Estados manejados aquí:
    //   - NEW
    //   - WAITING_DNI
    //   - WAITING_RUC
    //   - WAITING_COMPANY_NAME  ⭐ MOD (nuevo estado intermedio)
    //   - SELECTING_COMPANY
    //   - MENU / REGISTERED
    //   - WAITING_REMOTE_INFO
    // --------------------------------------------

    //
    // 2.a) Si es NEW -> pasamos a pedir DNI
    //
    if (state === 'NEW') {
      await contactModel.updateState(normalizedPhone, 'WAITING_DNI');
      await sendMessage(
        senderJid,
        '¡Hola! 👋 Para continuar, por favor envíame tu *DNI (8 dígitos)* para validar tu identidad y registrar tu nombre. 🙏'
      );
      return;
    }

    //
    // 2.b) WAITING_DNI -> validar DNI con RENIEC vía external.validateDNI
    //
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

      // 🔎 Consultamos RENIEC
      const persona = await external.validateDNI(dniCandidate);

      if (!persona) {
        await sendMessage(
          senderJid,
          'No pude validar el DNI en RENIEC. Por favor verifica que sea correcto o inténtalo más tarde.'
        );
        return;
      }

      const nombreCompleto = `${persona.nombres} ${persona.apellidoPaterno} ${persona.apellidoMaterno}`.trim();

      await contactModel.updateDNI(
        normalizedPhone,
        dniCandidate,
        nombreCompleto
      );

      await sendMessage(
        senderJid,
        `Perfecto ✅ ${nombreCompleto}.\nAhora envíame el *RUC de tu empresa (11 dígitos)* para asociarte.`
      );
      return;
    }

    //
    // 2.c) WAITING_RUC
    //
    // ⭐ MOD IMPORTANTE:
    // Antes tú SIEMPRE ibas directo a SUNAT y luego a updateRUC().
    // Problema: si el RUC YA EXISTE en BD, igual intentabas recrear todo
    // y el flujo se trababa.
    //
    // Ahora:
    //   1. Intentamos vincular a una empresa EXISTENTE con ese RUC
    //      contactModel.linkExistingCompanyByRucAndSetPrimary()
    //      - esto solo linkea, no crea
    //   2. Si ok === true => contacto queda REGISTERED / MENU
    //   3. Si no existe esa empresa todavía:
    //         hacemos la validación SUNAT, pedimos razón social (o la tomamos),
    //         pero si SUNAT falla igual pedimos razón social manual
    //
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

      // 2.c.1: intentar linkear con empresa YA existente
      const linkRes =
        await contactModel.linkExistingCompanyByRucAndSetPrimary(
          normalizedPhone,
          rucCandidate
        );

      if (linkRes.ok === true) {
        // ya quedó asociada la empresa primaria, y contacto.state pasa a REGISTERED internamente
        // recargamos contacto
        contact = await contactModel.findByPhone(normalizedPhone);

        // si tiene varias empresas → seleccionar
        if (contact?.companies && contact.companies.length > 1) {
          await contactModel.updateState(normalizedPhone, 'SELECTING_COMPANY');

          await sendMessage(
            senderJid,
            `He verificado tu empresa con RUC ${rucCandidate} ✅`
          );
          await sendMessage(senderJid, buildCompanySelectionMenu(contact));
          return;
        }

        // si tiene 1 sola → vamos directo a MENU
        await contactModel.updateState(normalizedPhone, 'MENU');

        contact = await contactModel.findByPhone(normalizedPhone);

        await sendMessage(
          senderJid,
          `¡Excelente! Quedaste registrado con ${contact.companyName} ✅`
        );
        await sendMessage(senderJid, buildMainMenu(contact));
        return;
      }

      // 2.c.2: si NO existe la empresa con ese RUC en BD todavía,
      // consultamos SUNAT para traer razón social automática.
      const infoRuc = await external.validateRUC(rucCandidate);

      if (!infoRuc) {
        // No pudimos validar SUNAT tampoco.
        // Pedimos razón social manual.
        await contactModel.updateState(
          normalizedPhone,
          'WAITING_COMPANY_NAME'
        );

        await saveProvisionalRUC(normalizedPhone, rucCandidate);

        await sendMessage(
          senderJid,
          'No pude validar el RUC en SUNAT. Por favor envíame el *nombre o razón social de tu empresa* tal como debería figurar.'
        );
        return;
      }

      // Si sí tenemos info SUNAT, ya podemos registrar directo usando updateRUC()
      const razonSocial =
        infoRuc.razonSocial || `Empresa ${rucCandidate}`.trim();

      await contactModel.updateRUC(
        normalizedPhone,
        rucCandidate,
        razonSocial
      );

      contact = await contactModel.findByPhone(normalizedPhone);

      // ¿tiene más de una empresa asociada?
      if (contact?.companies && contact.companies.length > 1) {
        await contactModel.updateState(normalizedPhone, 'SELECTING_COMPANY');

        await sendMessage(
          senderJid,
          `He registrado la empresa: ${razonSocial} ✅`
        );
        await sendMessage(senderJid, buildCompanySelectionMenu(contact));
        return;
      }

      // si sólo tiene una → listo, pasa a MENU
      await contactModel.updateState(normalizedPhone, 'MENU');

      contact = await contactModel.findByPhone(normalizedPhone);

      await sendMessage(
        senderJid,
        `¡Excelente! Quedaste registrado con ${contact.companyName} ✅`
      );
      await sendMessage(senderJid, buildMainMenu(contact));
      return;
    }

    //
    // ⭐ MOD NUEVO ESTADO:
    // 2.c.bis) WAITING_COMPANY_NAME
    //
    // Entramos acá cuando:
    //  - El usuario ya dio RUC válido
    //  - Esa empresa NO existía en BD
    //  - SUNAT tampoco devolvió datos
    //  - Le pedimos manualmente la razón social
    //
    if (state === 'WAITING_COMPANY_NAME') {
      const razonSocialManual = finalMessageText.trim();

      // leemos el contacto actual para extraer el RUC provisional que guardamos
      contact = await contactModel.findByPhone(normalizedPhone);
      const provisionalRuc = contact?.ruc || '';

      if (!provisionalRuc || provisionalRuc.length !== 11) {
        // si por algún motivo no tenemos el ruc, pedimos de nuevo
        await contactModel.updateState(normalizedPhone, 'WAITING_RUC');
        await sendMessage(
          senderJid,
          'Necesito nuevamente el RUC (11 dígitos) para poder registrar tu empresa. 🙏'
        );
        return;
      }

      // ahora sí creamos esa empresa con (RUC provisional + razón social manual)
      await contactModel.updateRUC(
        normalizedPhone,
        provisionalRuc,
        razonSocialManual
      );

      contact = await contactModel.findByPhone(normalizedPhone);

      // ¿tiene varias empresas?
      if (contact?.companies && contact.companies.length > 1) {
        await contactModel.updateState(normalizedPhone, 'SELECTING_COMPANY');

        await sendMessage(
          senderJid,
          `He registrado la empresa: ${razonSocialManual} ✅`
        );
        await sendMessage(senderJid, buildCompanySelectionMenu(contact));
        return;
      }

      // si sólo tiene una → pasa a MENU
      await contactModel.updateState(normalizedPhone, 'MENU');

      contact = await contactModel.findByPhone(normalizedPhone);

      await sendMessage(
        senderJid,
        `¡Excelente! Quedaste registrado con ${contact.companyName} ✅`
      );
      await sendMessage(senderJid, buildMainMenu(contact));
      return;
    }

    //
    // 2.d) SELECTING_COMPANY -> usuario elige cuál es su empresa activa
    //
    if (state === 'SELECTING_COMPANY') {
      const idxChosen = parseInt(finalMessageText.trim(), 10) - 1;
      const empresas = contact?.companies || [];

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

      // marcamos esa empresa como primaria
      await contactModel.setPrimaryCompany(contact.id, chosenPivot.companyId);

      // pasamos al estado MENU
      await contactModel.updateState(normalizedPhone, 'MENU');

      // recargar contacto con la nueva empresa primaria reflejada
      contact = await contactModel.findByPhone(normalizedPhone);

      await sendMessage(
        senderJid,
        `Perfecto 👍 Ahora usaré *${contact.companyName}* como tu empresa activa.`
      );

      await sendMessage(senderJid, buildMainMenu(contact));
      return;
    }

    // --------------------------------------------
    // 3. ESTADOS YA REGISTRADOS: MENU / REGISTERED
    // --------------------------------------------
    if (state === 'MENU' || state === 'REGISTERED') {
      // si dice "menu" / "hola" / etc -> reenviar menú
      if (/^(menu|hola|buenas|hi)$/i.test(finalMessageText.trim())) {
        await sendMessage(senderJid, buildMainMenu(contact));
        return;
      }

      // opción 1: servicio técnico en sitio
      if (finalMessageText.trim() === '1') {
        const link = await generateOdooLinkForContact(
          contact,
          normalizedPhone
        );
        if (link) {
          await sendMessage(
            senderJid,
            `🛠️ *Solicitud de servicio técnico en sitio*\n` +
              `Completa este formulario:\n${link}\n\n` +
              `Indica el modelo o serie del equipo y cuál es el problema (por ejemplo "no imprime", "atasco de papel").`
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

      // opción 2: tóner / suministros
      if (finalMessageText.trim() === '2') {
        const link = await generateOdooLinkForContact(
          contact,
          normalizedPhone
        );
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

      // opción 3: asistencia remota / AnyDesk
      if (finalMessageText.trim() === '3') {
        await contactModel.updateState(normalizedPhone, 'WAITING_REMOTE_INFO');
        await sendMessage(
          senderJid,
          '💻 *Asistencia remota*\n' +
            'Envíame el *ID de AnyDesk* (los 9 dígitos) o una *foto clara de tu pantalla donde se vea el ID*.\n' +
            'Un técnico se puede conectar para ayudarte 👨‍💻.'
        );
        return;
      }

      // opción 4: cambiar empresa activa
      if (finalMessageText.trim() === '4') {
        const empresas = contact.companies || [];
        if (empresas.length <= 1) {
          await sendMessage(
            senderJid,
            'Actualmente solo tienes una empresa asociada.'
          );
        } else {
          await contactModel.updateState(
            normalizedPhone,
            'SELECTING_COMPANY'
          );
          await sendMessage(senderJid, buildCompanySelectionMenu(contact));
        }
        return;
      }

      // opción 5: hablar con técnico
      if (finalMessageText.trim() === '5') {
        await contactModel.setHumanTakeover(normalizedPhone);
        await sendMessage(
          senderJid,
          '👨‍🔧 Listo. Estoy derivando tu caso a un técnico. Te van a responder en breve.'
        );
        return;
      }

      // mensaje libre que suena a servicio técnico
      if (detectServiceIntent(finalMessageText)) {
        const link = await generateOdooLinkForContact(
          contact,
          normalizedPhone
        );

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

      // mensaje libre que suena a pedido de tóner / insumos
      if (detectTonerIntent(finalMessageText)) {
        const link = await generateOdooLinkForContact(
          contact,
          normalizedPhone
        );
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

      // si nada matchea menú ni intenciones → pasamos a Gemini
      const responseFromGemini = await geminiService.processMessage(
        normalizedPhone,
        finalMessageText,
        !!mediaType,
        mediaAnalysis,
        anydeskCode
      );

      await sendMessage(senderJid, responseFromGemini);
      return;
    }

    // --------------------------------------------
    // 4. ESPERANDO INFO REMOTA (WAITING_REMOTE_INFO)
    // --------------------------------------------
    if (state === 'WAITING_REMOTE_INFO') {
      // asumimos que ya envió el ID de AnyDesk o la foto
      // 1) marcamos takeover humano
      await contactModel.setHumanTakeover(normalizedPhone);

      // 2) volvemos el estado al menú normal
      await contactModel.updateState(normalizedPhone, 'MENU');

      // refrescamos contacto
      contact = await contactModel.findByPhone(normalizedPhone);

      // respondemos
      await sendMessage(
        senderJid,
        '✅ Gracias. Ya tengo la información para soporte remoto.\n' +
          'Un técnico se conectará contigo o te escribirá en breve 👨‍💻'
      );
      return;
    }

    // --------------------------------------------
    // 5. Cualquier estado raro → forzamos MENU
    // --------------------------------------------
    logger.warn(
      `[BOT] Estado desconocido "${state}" para ${normalizedPhone}, forzando MENU`
    );
    await contactModel.updateState(normalizedPhone, 'MENU');
    contact = await contactModel.findByPhone(normalizedPhone);
    await sendMessage(senderJid, buildMainMenu(contact));
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
      'Error handling incoming message: ' +
        JSON.stringify(debugInfo, null, 2)
    );
  }
}

// ==================================================
// ENVÍO DE MENSAJES (TEXTO / MEDIA) Y HELPERS DE ESTADO
// ==================================================

/**
 * Enviar mensaje de texto usando el jid completo "51XXXX@s.whatsapp.net"
 */
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

    logger.info(
      `(API) Message sent to ${jid}: ${text.substring(0, 80)}...`
    );

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
    throw new Error('WhatsApp client not ready (sendMedia)');
  }

  const { buffer, mime, fileName, caption } = payload;
  const kind =
    payload.kind ?? (mime.split('/')[0] as SendMediaPayload['kind']);

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
      `Media sent to ${jid}: ${kind} ${
        fileName ? `(${fileName})` : ''
      } ${caption ? `| ${caption.substring(0, 50)}…` : ''}`
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
    throw new Error('WhatsApp client not ready (sendMediaToPhone)');
  }

  const clean = phoneE164.replace(/\D/g, '');
  const jid = `${clean}@s.whatsapp.net`;

  return sendMedia(jid, payload);
}

// ====================
// Helpers de estado / conexión / QR
// ====================

/**
 * Verifica si un número existe en WhatsApp.
 */
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
 */
export async function disconnectSession(): Promise<void> {
  if (sock) {
    try {
      await sock.logout();
      logger.info('WhatsApp disconnected via disconnectSession()');
    } catch (error) {
      logger.error('Error disconnecting WhatsApp:', error);
    }
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
 */
export async function forceNewQRState(): Promise<void> {
  try {
    await initializeWhatsApp();
    logger.info(
      'forceNewQRState(): WhatsApp client reinitialized, waiting for QR scan'
    );
  } catch (err) {
    logger.error('forceNewQRState() failed to reinitialize WhatsApp:', err);
    // Si falla, igual nos quedamos desconectados.
  }
}

/**
 * Compatibilidad con tu método antiguo disconnect()
 * Ahora solo llama a disconnectSession()
 */
export async function disconnect(): Promise<void> {
  await disconnectSession();
}

// ==================================================
// FIN DEL ARCHIVO
// ==================================================
