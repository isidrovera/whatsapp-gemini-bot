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

// ⬇️ NUEVO: importamos tipos y helpers estructurados
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

// Horarios / Plantillas / Config Dinámica
import * as workingHoursModel from '../models/workingHours.js';
import * as systemVarModel from '../models/systemVar.js';
import * as configurationModel from '../models/configuration.js';
import * as messageTemplateModel from '../models/template.js';

// Odoo
import {
  detectServiceIntent,
  detectTonerIntent,
  getOdooServiceLink,
} from './odoo.js';

// Auto-respuestas
import * as autoResponseModel from '../models/autoResponse.js';
import { replaceVariables } from '../utils/formatters.js';

// DNI/RUC externo
import * as external from './external.js';

// Tags (HUMANO / URGENTE / etc)
import * as tagModel from '../models/tag.js';

// Prisma directo (para guardar RUC provisional)
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
// AUTH FOLDER HELPERS (NUEVO)
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
    logger.error('No se pudo limpiar/recrear AUTH_FOLDER:', err);
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
// HELPER: detectar mensaje urgente
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
// MENSAJE / MENÚ PRINCIPAL (DINÁMICO SI EXISTE PLANTILLA)
// ==================================================
async function buildMainMenu(contact: any): Promise<string> {
  // intentamos información de empresa activa
  const { companyName } = contactModel.resolvePrimaryCompany(contact) || {};

  // Intentar plantilla dinámica desde configuration/messageTemplate.
  // Priorizamos configuration.templates.main_menu
  let dynamicMenu: string | null = null;

  // 1) configuration: category 'templates', key 'main_menu'
  const configMainMenu = await configurationModel.get('templates', 'main_menu');
  if (configMainMenu && configMainMenu.trim().length > 0) {
    dynamicMenu = configMainMenu;
  } else {
    // 2) messageTemplate: category='menu', name='main_menu'
    const tplList = await messageTemplateModel.getByCategory('menu');
    const tpl = tplList.find((t) => t.name === 'main_menu');
    if (tpl?.content) {
      dynamicMenu = tpl.content;
    }
  }

  const varsBase = {
    customer_name: contact?.name || '',
    company_name: companyName || contact?.companyName || '',
  };

  if (dynamicMenu) {
    return messageTemplateModel.render(dynamicMenu, varsBase);
  }

  // Fallback HARDCODEADO
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
// MENÚ PARA ELEGIR EMPRESA
// ==================================================
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

// ==================================================
// PLANTILLA FUERA DE HORARIO
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
// ESCALAMIENTO HUMANO URGENTE (FUERA DE HORARIO)
// ==================================================
async function escalarUrgenteFueraDeHorario(
  jid: string,
  phoneE164: string
) {
  // 1. Crear / asegurar tag HUMANO
  let allTags = await tagModel.getAll();
  let humanTag = allTags.find(
    (t: any) => (t.name || '').toUpperCase() === 'HUMANO'
  );

  if (!humanTag) {
    humanTag = await tagModel.create({
      name: 'HUMANO',
      color: '#ff0000',
      description: 'Escalado a soporte humano urgente',
    });
  }

  const existingTags = await tagModel.getByConversation(phoneE164);
  const alreadyTagged = existingTags.some(
    (t: any) => (t.name || '').toUpperCase() === 'HUMANO'
  );
  if (!alreadyTagged) {
    await tagModel.assignToConversation(phoneE164, humanTag.id);
  }

  // 2. takeover humano en el contacto
  await contactModel.setHumanTakeover(phoneE164);

  // 3. Mensaje dinámico de escalada
  let escaladaTpl =
    (await configurationModel.get('templates', 'urgent_human_message')) || '';

  if (!escaladaTpl) {
    const tplList = await messageTemplateModel.getByCategory('templates');
    const found = tplList.find((t) => t.name === 'urgent_human_message');
    if (found?.content) {
      escaladaTpl = found.content;
    }
  }

  if (!escaladaTpl) {
    escaladaTpl =
      '⚠ Entendido. Estoy derivando tu caso a soporte humano ahora mismo. Un técnico te responderá en breve.';
  }

  const sysVars = await configurationModel.getForSystemVariables();
  const rendered = messageTemplateModel.render(escaladaTpl, {
    company_name: sysVars.company_name || '',
    company_phone: sysVars.company_phone || '',
  });

  await sendMessage(jid, rendered);
}

// ==================================================
// EXTRACCIÓN CONTENIDO MENSAJE
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

// guarda RUC provisional en contacto
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
// INICIALIZACIÓN WHATSAPP (BAILEYS)
// ==================================================
export async function initializeWhatsApp(forceNew: boolean = false) {
  try {
    logger.info(
      `Initializing WhatsApp client (Baileys v7)... forceNew=${forceNew}`
    );

    // si queremos forzar nueva sesión, limpiamos carpeta
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

      // QR recibido
      if (qr) {
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

      // conexión cerrada
      if (connection === 'close') {
        const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;

        // caso: cerraste sesión desde el teléfono / escaneaste en otro lado
        if (statusCode === DisconnectReason.loggedOut) {
          logger.warn(
            '⚠️ WhatsApp dijo: loggedOut (device_removed). Limpiando auth y reiniciando para QR nuevo...'
          );

          // limpiar estado actual
          sock = null;
          isReady = false;
          botPhoneNumber = null;
          currentQR = null;
          qrDataURL = null;

          // reiniciar en modo forzado → mostrará QR
          setTimeout(() => {
            initializeWhatsApp(true).catch((err) =>
              logger.error(
                'Error reinitializing WhatsApp after loggedOut:',
                err
              )
            );
          }, 1000);

          return;
        }

        // otros errores → reconectar normal
        logger.warn('Connection closed. Reconnecting...', statusCode);

        isReady = false;
        botPhoneNumber = null;
        currentQR = null;
        qrDataURL = null;

        setTimeout(() => {
          initializeWhatsApp().catch((err) =>
            logger.error('Error reinitializing WhatsApp:', err)
          );
        }, 3000);
      }

      // conexión abierta
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
    logger.error('Error initializing WhatsApp:', error);
    throw error;
  }
}

// ==================================================
// MENSAJES DESDE EL MISMO NÚMERO DEL BOT (HUMANO)
// ==================================================
async function handleAgentMessageFromMe(
  senderJid: string,
  message: proto.IWebMessageInfo
) {
  const messageText = extractMessageText(message);
  const textLower = (messageText || '').toLowerCase().trim();

  const phoneNumber = normalizeJidToPhone(senderJid);
  const normalizedPhone = normalizePhone(phoneNumber);

  // takeover manual
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

  // cualquier mensaje del humano renueva takeover
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
    // ignorar mensajes viejos
    if ((message.messageTimestamp as number) * 1000 < startTime) return;

    const senderJid = message.key.remoteJid;
    if (!senderJid) return;

    // ignorar eco propio
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

    // mensaje del mismo número del bot => humano contestando
    if (message.key.fromMe) {
      await handleAgentMessageFromMe(senderJid, message);
      return;
    }

    // ignorar / bloquear grupos
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

    // normalizamos número
    const phoneNumberRaw = normalizeJidToPhone(senderJid);
    const normalizedPhone = normalizePhone(phoneNumberRaw);

    if (!normalizedPhone) {
      logger.error(
        `[PARSER] Could not normalize phone from JID "${senderJid}" -> "${phoneNumberRaw}"`
      );
      return;
    }

    // ========================================
    // VERIFICACIÓN DE PERMISOS GRANULARES
    // ========================================
    
    // 1. Verificar si está bloqueado completamente
    const isBlockedNum = await blockedModel.isBlocked(normalizedPhone);
    if (isBlockedNum) {
      logger.info(`[BLOCKED] Message from ${normalizedPhone} - completely blocked`);
      return;
    }

    // 2. Obtener permisos del usuario
    const permissions = await blockedModel.getPermissions(normalizedPhone);
    
    logger.debug(`[PERMISSIONS] ${normalizedPhone} - Level: ${permissions.accessLevel}`, {
      odoo: permissions.permissions.odoo,
      tickets: permissions.permissions.tickets,
      ai: permissions.permissions.ai,
      human: permissions.permissions.human,
      autoresponse: permissions.permissions.autoresponse
    });

    // takeover humano?
    const shouldRespond = await contactModel.shouldBotRespond(normalizedPhone);
    if (!shouldRespond) {
      logger.info(
        `[BOT-PAUSED] 🤫 Skipping response for ${normalizedPhone} - human takeover active`
      );
      return;
    }

    // ==========================================================
    // EXTRAER TEXTO Y ANALIZAR MEDIA CON GEMINI MULTIMODAL
    // ==========================================================
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
          if (anydeskCode) {
            logger.info(`[ANYDESK] Code extracted: ${anydeskCode}`);
          }

          finalMessageTextFromMedia =
            mediaAnalysisResult.ocrText ||
            mediaAnalysisResult.rawSummary ||
            null;

          logger.info('[WHATSAPP] Media analysis summary:', {
            summary: mediaAnalysisResult.rawSummary,
            serial: mediaAnalysisResult.detectedSerial,
            errorCode: mediaAnalysisResult.detectedErrorCode,
            anydesk: mediaAnalysisResult.detectedAnydesk,
            class: mediaAnalysisResult.mediaTypeClass,
          });
        }
      } catch (err: any) {
        logger.error('[WHATSAPP] Media processing error:', {
          message: err?.message,
          stack: err?.stack,
        });
      }
    }

    // mensaje final para el flujo
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

    // asegurar contacto
    await contactModel.getOrCreate(normalizedPhone);
    let contact = await contactModel.findByPhone(normalizedPhone);
    let state = contact?.state || 'NEW';

    // ==========================================================
    // 0. HORARIO / URGENCIA
    // ==========================================================
    const status = await workingHoursModel.getStatusInfo(new Date());
    const negocioCerrado = !status?.isOpen;

    if (negocioCerrado) {
      // fuera de horario:
      if (esUrgente(finalMessageText)) {
        // escalar a humano y NO mandar "Aún no abrimos"
        await escalarUrgenteFueraDeHorario(senderJid, normalizedPhone);
        return;
      }

      // no urgente => respuesta fuera de horario
      await replyOutOfHours(senderJid);
      return;
    }

    // ==========================================================
    // 1. VERIFICAR NIVEL DE ACCESO RESTRINGIDO
    // ==========================================================
    if (permissions.accessLevel === 'RESTRICTED') {
      logger.info(`[RESTRICTED] ${normalizedPhone} - Only auto-responses allowed`);
      
      const canUseAutoResponse = permissions.permissions.autoresponse ?? false;
      
      if (canUseAutoResponse) {
        const autoResp = await autoResponseModel.findAndProcessResponse(
          finalMessageText,
          {
            contact: {
              name: contact?.name || null,
              dni: contact?.dni || null,
              phoneNumber: normalizedPhone,
              companyName: contact?.companyName || null,
              ruc: contact?.ruc || null,
            },
            company: {
              razonSocial: contact?.companyName || null,
              numeroDoc: contact?.ruc || null,
              name: contact?.companyName || null,
              ruc: contact?.ruc || null,
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
    // 2. AUTO-RESPUESTAS DINÁMICAS (si tiene permiso)
    // ==========================================================
    const canUseAutoResponse = permissions.permissions.autoresponse ?? true;

    if (canUseAutoResponse) {
      const autoResp = await autoResponseModel.findAndProcessResponse(
        finalMessageText,
        {
          contact: {
            name: contact?.name || null,
            dni: contact?.dni || null,
            phoneNumber: normalizedPhone,
            companyName: contact?.companyName || null,
            ruc: contact?.ruc || null,
          },
          company: {
            razonSocial: contact?.companyName || null,
            numeroDoc: contact?.ruc || null,
            name: contact?.companyName || null,
            ruc: contact?.ruc || null,
          },
          customVars: {},
        }
      );

      if (autoResp) {
        logger.info(
          `[AUTO-RESPONSE] Sent auto-response for ${normalizedPhone}`
        );
        await sendMessage(senderJid, autoResp);
        return;
      }
    }

    // ==========================================================
    // 3. FLUJO DE REGISTRO (DNI / RUC / EMPRESA / MENU)
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

        if (contact?.companies && contact.companies.length > 1) {
          await contactModel.updateState(
            normalizedPhone,
            'SELECTING_COMPANY'
          );

          await sendMessage(
            senderJid,
            `He verificado tu empresa con RUC ${rucCandidate} ✅`
          );
          await sendMessage(senderJid, buildCompanySelectionMenu(contact));
          return;
        }

        await contactModel.updateState(normalizedPhone, 'MENU');
        contact = await contactModel.findByPhone(normalizedPhone);

        await sendMessage(
          senderJid,
          `¡Excelente! Quedaste registrado con ${contact.companyName} ✅`
        );
        await sendMessage(senderJid, await buildMainMenu(contact));
        return;
      }

      const infoRuc = await external.validateRUC(rucCandidate);

      if (!infoRuc) {
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

      const razonSocial =
        infoRuc.razonSocial || `Empresa ${rucCandidate}`.trim();

      await contactModel.updateRUC(
        normalizedPhone,
        rucCandidate,
        razonSocial
      );

      contact = await contactModel.findByPhone(normalizedPhone);

      if (contact?.companies && contact.companies.length > 1) {
        await contactModel.updateState(
          normalizedPhone,
          'SELECTING_COMPANY'
        );

        await sendMessage(
          senderJid,
          `He registrado la empresa: ${razonSocial} ✅`
        );
        await sendMessage(senderJid, buildCompanySelectionMenu(contact));
        return;
      }

      await contactModel.updateState(normalizedPhone, 'MENU');
      contact = await contactModel.findByPhone(normalizedPhone);

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
      const provisionalRuc = contact?.ruc || '';

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

      if (contact?.companies && contact.companies.length > 1) {
        await contactModel.updateState(
          normalizedPhone,
          'SELECTING_COMPANY'
        );

        await sendMessage(
          senderJid,
          `He registrado la empresa: ${razonSocialManual} ✅`
        );
        await sendMessage(senderJid, buildCompanySelectionMenu(contact));
        return;
      }

      await contactModel.updateState(normalizedPhone, 'MENU');
      contact = await contactModel.findByPhone(normalizedPhone);

      await sendMessage(
        senderJid,
        `¡Excelente! Quedaste registrado con ${contact.companyName} ✅`
      );
      await sendMessage(senderJid, await buildMainMenu(contact));
      return;
    }

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

      await contactModel.setPrimaryCompany(
        contact.id,
        chosenPivot.companyId
      );

      await contactModel.updateState(normalizedPhone, 'MENU');

      contact = await contactModel.findByPhone(normalizedPhone);

      await sendMessage(
        senderJid,
        `Perfecto 👍 Ahora usaré *${contact.companyName}* como tu empresa activa.`
      );

      await sendMessage(senderJid, await buildMainMenu(contact));
      return;
    }

    // ==========================================================
    // 4. ESTADOS OPERATIVOS (MENU / REGISTERED) - CON PERMISOS
    // ==========================================================
    if (state === 'MENU' || state === 'REGISTERED') {
      const trimmed = finalMessageText.trim();

      if (/^(menu|hola|buenas|hi)$/i.test(trimmed)) {
        await sendMessage(senderJid, await buildMainMenu(contact));
        return;
      }

      // 1️⃣ Servicio técnico en sitio - VERIFICAR PERMISO ODOO
      if (trimmed === '1') {
        const canUseOdoo = permissions.permissions.odoo ?? true;

        if (!canUseOdoo) {
          logger.warn(`[PERMISSION-DENIED] ${normalizedPhone} - odoo access denied`);
          await sendMessage(
            senderJid,
            '⚠️ No tienes permiso para consultar información de servicio técnico. ' +
            'Contacta a tu administrador para más información.'
          );
          return;
        }

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

      // 2️⃣ Tóner / insumos - VERIFICAR PERMISO TICKETS
      if (trimmed === '2') {
        const canCreateTickets = permissions.permissions.tickets ?? true;

        if (!canCreateTickets) {
          logger.warn(`[PERMISSION-DENIED] ${normalizedPhone} - tickets access denied`);
          await sendMessage(
            senderJid,
            '⚠️ No tienes permiso para crear solicitudes de tóner. ' +
            'Contacta a soporte para más información.'
          );
          return;
        }

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

      // 3️⃣ Asistencia remota / AnyDesk
      if (trimmed === '3') {
        await contactModel.updateState(
          normalizedPhone,
          'WAITING_REMOTE_INFO'
        );
        await sendMessage(
          senderJid,
          '💻 *Asistencia remota*\n' +
            'Envíame el *ID de AnyDesk* (los 9 dígitos) o una *foto clara de tu pantalla donde se vea el ID*.\n' +
            'Un técnico se puede conectar para ayudarte 👨‍💻.'
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
          await contactModel.updateState(
            normalizedPhone,
            'SELECTING_COMPANY'
          );
          await sendMessage(senderJid, buildCompanySelectionMenu(contact));
        }
        return;
      }

      // 5️⃣ Hablar con técnico - VERIFICAR PERMISO HUMAN
      if (trimmed === '5') {
        const canTalkToHuman = permissions.permissions.human ?? true;

        if (!canTalkToHuman) {
          logger.warn(`[PERMISSION-DENIED] ${normalizedPhone} - human access denied`);
          await sendMessage(
            senderJid,
            '⚠️ No puedes solicitar atención humana en este momento. ' +
            'Por favor utiliza las opciones del menú automatizado o contacta a soporte por otro medio.'
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

      // mensaje libre cercano a servicio técnico - VERIFICAR PERMISO ODOO
      if (detectServiceIntent(finalMessageText)) {
        const canUseOdoo = permissions.permissions.odoo ?? true;

        if (!canUseOdoo) {
          logger.warn(`[PERMISSION-DENIED] ${normalizedPhone} - odoo intent denied`);
          await sendMessage(
            senderJid,
            '⚠️ No tienes acceso a solicitudes de servicio técnico. ' +
            'Contacta a tu administrador.'
          );
          return;
        }

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

      // mensaje libre cercano a tóner - VERIFICAR PERMISO TICKETS
      if (detectTonerIntent(finalMessageText)) {
        const canCreateTickets = permissions.permissions.tickets ?? true;

        if (!canCreateTickets) {
          logger.warn(`[PERMISSION-DENIED] ${normalizedPhone} - toner intent denied`);
          await sendMessage(
            senderJid,
            '⚠️ No tienes permiso para crear solicitudes de tóner. ' +
            'Contacta a soporte.'
          );
          return;
        }

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

      // Gemini como fallback - VERIFICAR PERMISO AI
      const canUseAI = permissions.permissions.ai ?? true;

      if (canUseAI) {
        const responseFromGemini = await geminiService.processMessage(
          normalizedPhone,
          finalMessageText,
          !!mediaType,
          mediaAnalysisResult
            ? JSON.stringify(mediaAnalysisResult, null, 2)
            : null,
          anydeskCode || null
        );

        await sendMessage(senderJid, responseFromGemini);
      } else {
        logger.warn(`[PERMISSION-DENIED] ${normalizedPhone} - AI access denied`);
        await sendMessage(
          senderJid,
          'Lo siento, no puedo procesar tu mensaje en este momento. ' +
          'Por favor usa las opciones del menú: envía "menu" para ver las opciones disponibles.'
        );
      }
      return;
    }

    // ==========================================================
    // 5. ESPERANDO INFO REMOTA
    // ==========================================================
    if (state === 'WAITING_REMOTE_INFO') {
      await contactModel.setHumanTakeover(normalizedPhone);

      await contactModel.updateState(normalizedPhone, 'MENU');

      contact = await contactModel.findByPhone(normalizedPhone);

      await sendMessage(
        senderJid,
        '✅ Gracias. Ya tengo la información para soporte remoto.\n' +
          'Un técnico se conectará contigo o te escribirá en breve 👨‍💻'
      );
      return;
    }

    // ==========================================================
    // 6. Estado raro → forzamos MENU
    // ==========================================================
    logger.warn(
      `[BOT] Estado desconocido "${state}" para ${normalizedPhone}, forzando MENU`
    );
    await contactModel.updateState(normalizedPhone, 'MENU');
    contact = await contactModel.findByPhone(normalizedPhone);
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
    logger.error('Error sending message:', error);
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

    logger.info(
      `(API) Message sent to ${jid}: ${text.substring(0, 80)}...`
    );

    return resp;
  } catch (error) {
    logger.error('Error sending direct message:', error);
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
export async function onWhatsAppExists(
  e164: string
): Promise<boolean> {
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
      logger.error('Error disconnecting WhatsApp:', error);
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
    await initializeWhatsApp(true); // 👈 forzado
    logger.info(
      'forceNewQRState(): WhatsApp client reinitialized, waiting for QR scan'
    );
  } catch (err) {
    logger.error(
      'forceNewQRState() failed to reinitialize WhatsApp:',
      err
    );
  }
}

export async function disconnect(): Promise<void> {
  await disconnectSession();
}

// ==================================================
// FIN DEL ARCHIVO
// ==================================================
