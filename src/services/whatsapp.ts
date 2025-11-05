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

// Dinámicos (horarios / plantillas / configuración / autorespuestas)
import * as workingHoursModel from '../models/workingHours.js';
import * as systemVarModel from '../models/systemVar.js';
import * as configurationModel from '../models/configuration.js';
import * as messageTemplateModel from '../models/template.js';
import * as autoResponseModel from '../models/autoResponse.js';
import { replaceVariables } from '../utils/formatters.js';

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
// MENÚ PRINCIPAL (dinámico por plantilla/config)
// ==================================================
async function buildMainMenu(contact: any): Promise<string> {
  const { companyName } = contactModel.resolvePrimaryCompany(contact) || {};

  // Prioridad: configuration('templates','main_menu') → template.category('menu').name('main_menu')
  let dynamicMenu: string | null = null;

  const configMainMenu = await configurationModel.get('templates', 'main_menu');
  if (configMainMenu && configMainMenu.trim().length > 0) {
    dynamicMenu = configMainMenu;
  } else {
    const tplList = await messageTemplateModel.getByCategory('menu');
    const tpl = tplList.find((t) => t.name === 'main_menu');
    if (tpl?.content) dynamicMenu = tpl.content;
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
    const senderJid = key?.remoteJid ?? key?.participant ?? null;
    if (!senderJid) {
      logger.warn({ key }, '[WA] No se pudo resolver senderJid (key vacío)');
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

    const phoneNumberRaw = normalizeJidToPhone(senderJid);
    const normalizedPhone = normalizePhone(phoneNumberRaw);
    if (!normalizedPhone) {
      logger.error(
        `[PARSER] Could not normalize phone from JID "${senderJid}" -> "${phoneNumberRaw}"`
      );
      return;
    }

    // 1) Bloqueos / permisos
    const isBlockedNum = await blockedModel.isBlocked(normalizedPhone);
    if (isBlockedNum) {
      logger.info(
        `[BLOCKED] Message from ${normalizedPhone} - completely blocked`
      );
      return;
    }

    const permissions = await blockedModel.getPermissions(normalizedPhone);

    // 2) Human takeover vigente (en horario hábil)
    const shouldRespond = await contactModel.shouldBotRespond(normalizedPhone);
    if (!shouldRespond) {
      logger.info(
        `[BOT-PAUSED] 🤫 Skipping response for ${normalizedPhone} - human takeover active`
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
        `[WHATSAPP] Processing ${mediaType} from ${normalizedPhone}...`
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
      `Message from ${normalizedPhone}: ${finalMessageText.substring(
        0,
        120
      )}... ${mediaType ? `[+${mediaType.toUpperCase()}]` : ''}`
    );

    // 4) Contacto y estado
    await contactModel.getOrCreate(normalizedPhone);
    let contact = await contactModel.findByPhone(normalizedPhone);
    if (!contact) {
      logger.error(
        `[CONTACT] Failed to create or retrieve contact for ${normalizedPhone}`
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
        await marcarUrgenteSinTakeover(normalizedPhone);
      }
      // OJO: NO retornamos. Continuamos con auto-respuestas / intents / Gemini,
      // pero bloqueamos derivación humana (opción 5) más abajo.
    }

    // ==========================================================
    // 6) NIVEL DE ACCESO RESTRINGIDO
    // ==========================================================
    if (permissions.accessLevel === 'RESTRICTED') {
      logger.info(
        `[RESTRICTED] ${normalizedPhone} - Only auto-responses allowed`
      );

      const canUseAutoResponse = permissions.permissions.autoresponse ?? false;

      if (canUseAutoResponse) {
        const autoResp = await autoResponseModel.findAndProcessResponse(
          finalMessageText,
          {
            contact: {
              name: contact.name || null,
              dni: contact.dni || null,
              phoneNumber: normalizedPhone,
              companyName: contact.companyName || null,
              ruc: contact.ruc || null,
            },
            company: {
              razonSocial: contact.companyName || null,
              numeroDoc: contact.ruc || null,
              name: contact.companyName || null,
              ruc: contact.ruc || null,
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
            name: contact.name || null,
            dni: contact.dni || null,
            phoneNumber: normalizedPhone,
            companyName: contact.companyName || null,
            ruc: contact.ruc || null,
          },
          company: {
            razonSocial: contact.companyName || null,
            numeroDoc: contact.ruc || null,
            name: contact.companyName || null,
            ruc: contact.ruc || null,
          },
          customVars: {},
        }
      );

      if (autoResp) {
        logger.info(
          `[AUTO-RESPONSE] Sent auto-response for ${normalizedPhone}`
        );
        await sendMessage(senderJid, autoResp);
        // No return: dejamos que el flujo siga si hace falta (pero típicamente basta).
        // Si quieres cortar aquí, descomenta:
        // return;
      }
    }

    // ==========================================================
    // 8) REGISTRO (DNI / RUC / EMPRESA)
    // ==========================================================
    if (state === 'NEW') {
      await contactModel.updateState(normalizedPhone, 'WAITING_DNI');
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
          normalizedPhone,
          rucCandidate
        );

      if (linkRes.ok === true) {
        contact = await contactModel.findByPhone(normalizedPhone);
        if (!contact) {
          logger.error(
            `[CONTACT] Contact disappeared after linking company for ${normalizedPhone}`
          );
          return;
        }

        if (contact.companies && contact.companies.length > 1) {
          await contactModel.updateState(normalizedPhone, 'SELECTING_COMPANY');
          await sendMessage(
            senderJid,
            `He verificado tu empresa con RUC ${rucCandidate} ✅`
          );
          await sendMessage(senderJid, buildCompanySelectionMenu(contact));
          return;
        }

        await contactModel.updateState(normalizedPhone, 'MENU');
        contact = await contactModel.findByPhone(normalizedPhone);
        if (!contact) {
          logger.error(
            `[CONTACT] Contact disappeared after state update for ${normalizedPhone}`
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
        await contactModel.updateState(normalizedPhone, 'WAITING_COMPANY_NAME');
        await saveProvisionalRUC(normalizedPhone, rucCandidate);

        await sendMessage(
          senderJid,
          'No pude validar el RUC en SUNAT. Por favor envíame el *nombre o razón social de tu empresa* tal como debería figurar.'
        );
        return;
      }

      const razonSocial =
        infoRuc.razonSocial || `Empresa ${rucCandidate}`.trim();

      await contactModel.updateRUC(normalizedPhone, rucCandidate, razonSocial);

      contact = await contactModel.findByPhone(normalizedPhone);
      if (!contact) {
        logger.error(
          `[CONTACT] Contact disappeared after RUC update for ${normalizedPhone}`
        );
        return;
      }

      if (contact.companies && contact.companies.length > 1) {
        await contactModel.updateState(normalizedPhone, 'SELECTING_COMPANY');

        await sendMessage(
          senderJid,
          `He registrado la empresa: ${razonSocial} ✅`
        );
        await sendMessage(senderJid, buildCompanySelectionMenu(contact));
        return;
      }

      await contactModel.updateState(normalizedPhone, 'MENU');
      contact = await contactModel.findByPhone(normalizedPhone);
      if (!contact) {
        logger.error(`[CONTACT] Contact disappeared for ${normalizedPhone}`);
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

      contact = await contactModel.findByPhone(normalizedPhone);
      if (!contact) {
        logger.error(`[CONTACT] Contact not found for ${normalizedPhone}`);
        return;
      }

      const provisionalRuc = contact.ruc || '';

      if (!provisionalRuc || provisionalRuc.length !== 11) {
        await contactModel.updateState(normalizedPhone, 'WAITING_RUC');
        await sendMessage(
          senderJid,
          'Necesito nuevamente el RUC (11 dígitos) para poder registrar tu empresa. 🙏'
        );
        return;
      }

      await contactModel.updateRUC(
        normalizedPhone,
        provisionalRuc,
        razonSocialManual
      );

      contact = await contactModel.findByPhone(normalizedPhone);
      if (!contact) {
        logger.error(`[CONTACT] Contact disappeared for ${normalizedPhone}`);
        return;
      }

      if (contact.companies && contact.companies.length > 1) {
        await contactModel.updateState(normalizedPhone, 'SELECTING_COMPANY');

        await sendMessage(
          senderJid,
          `He registrado la empresa: ${razonSocialManual} ✅`
        );
        await sendMessage(senderJid, buildCompanySelectionMenu(contact));
        return;
      }

      await contactModel.updateState(normalizedPhone, 'MENU');
      contact = await contactModel.findByPhone(normalizedPhone);
      if (!contact) {
        logger.error(`[CONTACT] Contact disappeared for ${normalizedPhone}`);
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
      await contactModel.updateState(normalizedPhone, 'MENU');

      contact = await contactModel.findByPhone(normalizedPhone);
      if (!contact) {
        logger.error(`[CONTACT] Contact disappeared for ${normalizedPhone}`);
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
            `[PERMISSION-DENIED] ${normalizedPhone} - odoo access denied`
          );
          await sendMessage(
            senderJid,
            '⚠️ No tienes permiso para consultar información de servicio técnico.'
          );
          return;
        }

        const link = await generateOdooLinkForContact(contact, normalizedPhone);
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
            `[PERMISSION-DENIED] ${normalizedPhone} - tickets access denied`
          );
          await sendMessage(
            senderJid,
            '⚠️ No tienes permiso para crear solicitudes de tóner.'
          );
          return;
        }

        const link = await generateOdooLinkForContact(contact, normalizedPhone);
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
        await contactModel.updateState(normalizedPhone, 'WAITING_REMOTE_INFO');
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
          await contactModel.updateState(normalizedPhone, 'SELECTING_COMPANY');
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
            `[PERMISSION-DENIED] ${normalizedPhone} - human access denied`
          );
          await sendMessage(
            senderJid,
            '⚠️ No puedes solicitar atención humana en este momento. ' +
              'Por favor utiliza las opciones del menú automatizado.'
          );
          return;
        }

        await contactModel.setHumanTakeover(normalizedPhone);
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

        const link = await generateOdooLinkForContact(contact, normalizedPhone);
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

        const link = await generateOdooLinkForContact(contact, normalizedPhone);
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
        const responseFromGemini = await geminiService.processMessage(
          normalizedPhone,
          finalMessageText,
          !!mediaType,
          mediaAnalysisResult
            ? JSON.stringify(mediaAnalysisResult, null, 2)
            : null,
          anydeskCode || null,
          mediaAnalysisResult?.mediaTypeClass || null,
          mediaAnalysisResult?.detectedErrorCode || null,
          mediaAnalysisResult?.detectedSerial || null
        );

        await sendMessage(senderJid, responseFromGemini);
      } else {
        logger.warn(
          `[PERMISSION-DENIED] ${normalizedPhone} - AI access denied`
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
      await contactModel.updateState(normalizedPhone, 'MENU');

      contact = await contactModel.findByPhone(normalizedPhone);
      if (!contact) {
        logger.error(`[CONTACT] Contact disappeared for ${normalizedPhone}`);
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
      `[BOT] Estado desconocido "${state}" para ${normalizedPhone}, forzando MENU`
    );
    await contactModel.updateState(normalizedPhone, 'MENU');
    contact = await contactModel.findByPhone(normalizedPhone);
    if (!contact) {
      logger.error(`[CONTACT] Contact disappeared for ${normalizedPhone}`);
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

export async function sendDirectMessage(phoneE164: string, text: string) {
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
    logger.info(`(API) Message sent to ${jid}: ${text.substring(0, 80)}...`);
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

export async function sendMedia(jid: string, payload: SendMediaPayload) {
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
      `Media sent to ${jid}: ${kind} ${fileName ? `(${fileName})` : ''} ${
        caption ? `| ${caption.substring(0, 50)}…` : ''
      }`
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
      },
      'Error sending media:'
    );
    throw error;
  }
}

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

export async function disconnect(): Promise<void> {
  await disconnectSession();
}
