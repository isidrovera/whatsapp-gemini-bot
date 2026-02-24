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

// ✅ CAMBIO 1: Importar nuevas funciones de validators (incluidas las de LID)
import {
  isGroupJid,
  normalizePhone,
  extractPhoneFromJid,
  normalizeJidToPhone,
  isLikelyRealPhone,
  isLidJid,
  normalizeLidJid,
  extractPhoneFromAltJid,
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

// ─────────────────────────────────────────────────
// FIX: Control centralizado de reconexión
// Evita que múltiples timeouts compitan entre sí
// cuando se produce un logout (desde el celular o manual)
// ─────────────────────────────────────────────────
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let isLoggedOutPending = false;

function clearReconnectTimer() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

// ==================================================
// AUTH FOLDER HELPERS - SOLUCIÓN 1: PERSISTENCIA
// ==================================================
const AUTH_FOLDER = path.resolve('./baileys_auth');

async function ensureAuthFolderExists() {
  try {
    if (!fs.existsSync(AUTH_FOLDER)) {
      fs.mkdirSync(AUTH_FOLDER, { recursive: true });
      logger.info(`📁 AUTH folder creada: ${AUTH_FOLDER}`);
    } else {
      const files = fs.readdirSync(AUTH_FOLDER);
      logger.info(`✅ AUTH folder existe con ${files.length} archivos en: ${AUTH_FOLDER}`);
    }
  } catch (err) {
    logger.error({ err }, 'Error verificando AUTH_FOLDER:');
  }
}

async function ensureCleanAuthFolder() {
  try {
    if (fs.existsSync(AUTH_FOLDER)) {
      fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
      logger.warn('🗑️ AUTH eliminada (logout manual explícito)');
    }
    fs.mkdirSync(AUTH_FOLDER, { recursive: true });
    logger.info('📁 AUTH folder recreada limpia');
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

// ==================================================
// ✅ CAMBIO 3: NUEVA resolución LID → PN en cascada
// ==================================================

/**
 * Intenta resolver un LID a un número de teléfono E.164 usando múltiples fuentes,
 * en orden de confiabilidad:
 *
 *   1) remoteJidAlt / participantAlt (Baileys v7 lo incluye en message.key)
 *   2) sock.signalRepository.lidMapping.getPNForLID() (store interno de Baileys)
 *   3) Buscar en nuestra BD por billysId (si ya lo tenemos mapeado de antes)
 *
 * Retorna { phoneE164, source } o null si no se pudo resolver.
 */
async function resolvePhoneFromLid(
  lidJid: string,
  messageKey?: proto.IMessageKey | null
): Promise<{ phoneE164: string; source: string } | null> {
  const canonicalLid = normalizeLidJid(lidJid) || lidJid;

  // ── FUENTE 1: remoteJidAlt / participantAlt del message.key ──
  if (messageKey) {
    const altJid =
      (messageKey as any).remoteJidAlt ||
      (messageKey as any).participantAlt ||
      null;

    const phoneFromAlt = extractPhoneFromAltJid(altJid);
    if (phoneFromAlt) {
      logger.info(
        `[LID-RESOLVE] ✅ Fuente 1 (Alt JID): ${canonicalLid} → ${phoneFromAlt}`
      );
      return { phoneE164: phoneFromAlt, source: 'altJid' };
    }
  }

  // ── FUENTE 2: lidMapping.getPNForLID() del store de Baileys ──
  try {
    const repo = (sock as any)?.signalRepository;
    const lm = repo?.lidMapping;

    if (lm && typeof lm.getPNForLID === 'function') {
      const pnResult = await lm.getPNForLID(canonicalLid);

      if (pnResult) {
        const pnStr = typeof pnResult === 'string'
          ? pnResult
          : pnResult?.jid || pnResult?.pn || pnResult?.phoneNumber || String(pnResult);

        const digits = pnStr.includes('@')
          ? extractPhoneFromJid(pnStr)
          : pnStr.replace(/\D/g, '');

        if (digits) {
          try {
            const phoneE164 = normalizePhone(digits);
            if (isLikelyRealPhone(phoneE164)) {
              logger.info(
                `[LID-RESOLVE] ✅ Fuente 2 (getPNForLID): ${canonicalLid} → ${phoneE164}`
              );
              return { phoneE164, source: 'getPNForLID' };
            }
          } catch {
            // normalizePhone falló, continuar con siguiente fuente
          }
        }
      }
    }
  } catch (err) {
    logger.debug({ err }, '[LID-RESOLVE] getPNForLID falló, continuando...');
  }

  // ── FUENTE 3: Buscar en nuestra BD por billysId ──
  try {
    const contactByLid = await contactModel.findByBillysId(canonicalLid);

    if (contactByLid?.phoneNumber) {
      const phone = contactByLid.phoneNumber;

      if (!phone.startsWith('lid:') && isLikelyRealPhone(phone)) {
        logger.info(
          `[LID-RESOLVE] ✅ Fuente 3 (BD billysId): ${canonicalLid} → ${phone}`
        );
        return { phoneE164: phone, source: 'database' };
      }
    }
  } catch (err) {
    logger.debug({ err }, '[LID-RESOLVE] BD lookup falló');
  }

  logger.warn(`[LID-RESOLVE] ❌ No se pudo resolver PN para ${canonicalLid}`);
  return null;
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
// ✅ CAMBIO 4: Helper para resolver phone desde JID (PN o LID)
// ==================================================
async function resolvePhoneFromJid(
  jid: string,
  messageKey?: proto.IMessageKey | null
): Promise<string | null> {
  if (isLidJid(jid)) {
    const resolved = await resolvePhoneFromLid(jid, messageKey);
    return resolved?.phoneE164 || null;
  }

  const raw = normalizeJidToPhone(jid);
  if (!raw) return null;

  try {
    const phone = normalizePhone(raw);
    if (isLikelyRealPhone(phone)) return phone;
  } catch {
    // normalizePhone falló
  }

  return null;
}

// ==================================================
// INICIALIZACIÓN (BAILEYS)
// ==================================================
export async function initializeWhatsApp(forceNew: boolean = false) {
  try {
    logger.info(`Initializing WhatsApp client (Baileys v7)... forceNew=${forceNew}`);

    if (forceNew) {
      await ensureCleanAuthFolder();
    } else {
      await ensureAuthFolderExists();
    }

    const { state, saveCreds } = await useMultiFileAuthState('/app/baileys_auth');

    sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      logger: logger as any,

      // ✅ FINGERPRINT REAL (evita bloqueo WA)
      browser: ['Chrome', 'Chrome', '120.0.0'],

      // ✅ VERSION WEB ESTABLE (CLAVE contra 405)
      version: [2, 2413, 1],

      syncFullHistory: false,
      markOnlineOnConnect: false,
      generateHighQualityLinkPreview: false,

      // ✅ Evita cortes en VPS
      connectTimeoutMs: 60000,
      keepAliveIntervalMs: 15000,
    });

    sock.ev.on('creds.update', saveCreds);

    // FIX: backoff progresivo con variable local al scope de esta instancia
    // Así cada initializeWhatsApp() comienza desde 3000ms fresco
    let reconnectDelay = 3000;

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        logger.info('📲 QR Code received');

        currentQR = qr;
        try {
          qrDataURL = await QRCode.toDataURL(qr);
          logger.info('✅ QR disponible en /auth/qr');
        } catch (err) {
          logger.error({ err }, 'QR generation error');
        }

        isReady = false;
        botPhoneNumber = null;
      }

      if (connection === 'open') {
        logger.info('✅ WhatsApp connected successfully!');

        // FIX: resetear backoff y flags al conectar exitosamente
        reconnectDelay = 3000;
        isLoggedOutPending = false;
        isReady = true;
        currentQR = null;
        qrDataURL = null;

        if (sock?.user?.id) {
          botPhoneNumber = extractPhoneFromJid(sock.user.id);
          logger.info(`📱 Bot phone number: ${botPhoneNumber}`);
        }
      }

      if (connection === 'close') {
        const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;

        logger.warn({ statusCode }, 'Connection closed');

        isReady = false;
        botPhoneNumber = null;

        // FIX: Cancelar cualquier reconexión pendiente anterior
        // para que no haya dos timers compitiendo
        clearReconnectTimer();

        // ✅ Logout real (desde celular o /api/logout)
        // → limpiar auth, resetear estado y generar QR nuevo
        if (statusCode === DisconnectReason.loggedOut) {
          // FIX: guardar referencia al sock actual para evitar
          // que una segunda llamada concurrente también entre aquí
          if (isLoggedOutPending) {
            logger.warn('[LOGOUT] Ya hay un proceso de logout en curso, ignorando duplicado');
            return;
          }
          isLoggedOutPending = true;

          logger.warn('🔐 Device logged out. Resetting auth...');

          // Limpiar estado de QR/bot inmediatamente
          sock = null;
          currentQR = null;
          qrDataURL = null;

          reconnectTimer = setTimeout(async () => {
            reconnectTimer = null;
            isLoggedOutPending = false;
            logger.info('🔄 Reinitializing after logout (forceNew=true)...');
            await initializeWhatsApp(true);
          }, 2000);

          return;
        }

        // ✅ Reconexión normal con backoff progresivo
        reconnectDelay = Math.min(reconnectDelay * 1.5, 20000);
        logger.info(`🔄 Reconnecting in ${Math.round(reconnectDelay)}ms...`);

        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          initializeWhatsApp(false).catch((err) =>
            logger.error({ err }, 'Reinit error')
          );
        }, reconnectDelay);
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
// ✅ CAMBIO 5: MENSAJES DEL MISMO NÚMERO (AGENTE HUMANO) - CON SOPORTE LID
// ==================================================
async function handleAgentMessageFromMe(
  senderJid: string,
  message: proto.IWebMessageInfo
) {
  const messageText = extractMessageText(message);
  const textLower = (messageText || '').toLowerCase().trim();

  const phoneNumberRaw = await resolvePhoneFromJid(senderJid, message.key);

  if (!phoneNumberRaw) {
    if (isLidJid(senderJid)) {
      logger.info(
        `[AGENT-MSG] Mensaje agente a LID sin resolver: ${senderJid} (ignorando takeover)`
      );
    } else {
      logger.warn(
        `[AGENT-MSG] Received agent message with empty/invalid phone from JID=${senderJid}`
      );
    }
    return;
  }

  if (textLower === HUMAN_TAKEOVER_COMMAND) {
    await contactModel.setHumanTakeover(phoneNumberRaw);
    logger.info(`[HUMAN-TAKEOVER] ✋ Manually activated for ${phoneNumberRaw}`);
    return;
  }

  if (textLower === RELEASE_TAKEOVER_COMMAND) {
    await contactModel.releaseHumanTakeover(phoneNumberRaw);
    logger.info(`[BOT-REACTIVATED] 🤖 Manually reactivated for ${phoneNumberRaw}`);
    return;
  }

  if (messageText && messageText.trim().length > 0) {
    const contact = await contactModel.findByPhone(phoneNumberRaw);

    const onboardingStates = [
      'NEW',
      'WAITING_DNI',
      'WAITING_RUC',
      'WAITING_COMPANY_NAME',
      'SELECTING_COMPANY',
    ];

    if (contact && onboardingStates.includes(contact.state)) {
      logger.info(
        `[AGENT-MSG] ⚠️  Ignoring agent message for ${phoneNumberRaw} - User in onboarding state=${contact.state}`
      );
      logger.info(
        `[AGENT-MSG] 💡 Tip: User needs to complete registration first. Use /humano to force takeover if needed.`
      );
      return;
    }

    const now = new Date();
    const oneHourInMs = 60 * 60 * 1000;

    if (!contact?.humanTakeoverAt) {
      await contactModel.setHumanTakeover(phoneNumberRaw);
      logger.info(
        `[HUMAN-TAKEOVER] 🙋 Agent message detected for ${phoneNumberRaw} (state=${contact?.state || 'unknown'})`
      );
    } else {
      const diff = now.getTime() - contact.humanTakeoverAt.getTime();
      if (diff > oneHourInMs) {
        await contactModel.setHumanTakeover(phoneNumberRaw);
        logger.info(
          `[HUMAN-TAKEOVER] 🔄 Renewed for ${phoneNumberRaw} (previous expired)`
        );
      } else {
        await contactModel.setHumanTakeover(phoneNumberRaw);
        logger.info(
          `[HUMAN-TAKEOVER] ⏰ Extended for ${phoneNumberRaw} - Human still active`
        );
      }
    }
  }
}

// ==================================================
// ✅ CAMBIO 6: HANDLER PRINCIPAL - RESOLUCIÓN LID EN CASCADA
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

    // ==================================================
    // ✅ CAMBIO 6: Resolver identidad con cascada (sin setTimeout)
    // ==================================================
    const isLid = isLidJid(senderJid);

    const effectiveJid = isLid
      ? (normalizeLidJid(senderJid) || senderJid)
      : senderJid;

    let phoneE164: string | null = null;
    let contact: any = null;

    if (isLid) {
      logger.info(`[LID-DETECT] Mensaje desde @lid: ${senderJid} → normalized: ${effectiveJid}`);

      const resolved = await resolvePhoneFromLid(effectiveJid, message.key);

      if (resolved) {
        phoneE164 = resolved.phoneE164;
        logger.info(
          `[LID-RESOLVED] ${effectiveJid} → ${phoneE164} (fuente: ${resolved.source})`
        );

        contact = await contactModel.findByPhone(phoneE164);
        if (!contact) {
          await contactModel.getOrCreate(phoneE164);
          contact = await contactModel.findByPhone(phoneE164);
        }

        await contactModel.attachLidToPhoneContact(phoneE164, effectiveJid);

        contact = await contactModel.findByPhone(phoneE164);
      } else {
        logger.warn(
          `[LID-UNRESOLVED] No se pudo resolver PN para ${effectiveJid}`
        );

        const shadowContact = await contactModel.findByBillysId(effectiveJid);

        if (shadowContact && shadowContact.phoneNumber && !shadowContact.phoneNumber.startsWith('lid:')) {
          phoneE164 = shadowContact.phoneNumber;
          contact = shadowContact;
          logger.info(
            `[LID-FALLBACK] Encontrado contacto existente por billysId: ${phoneE164}`
          );
        } else {
          logger.warn(
            `[LID-UNRESOLVED] Sin mapping disponible para ${effectiveJid}, ignorando mensaje`
          );
          return;
        }
      }
    } else {
      const phoneNumberRaw = normalizeJidToPhone(senderJid);
      if (!phoneNumberRaw) {
        logger.warn(
          `[PARSER] JID "${senderJid}" no contiene número utilizable, ignorando mensaje`
        );
        return;
      }

      phoneE164 = normalizePhone(phoneNumberRaw);

      if (!isLikelyRealPhone(phoneE164)) {
        logger.error(
          `[PARSER] No se pudo extraer un teléfono válido del JID "${senderJid}" -> "${phoneNumberRaw}" (candidate="${phoneE164}")`
        );
        return;
      }

      await contactModel.getOrCreate(phoneE164);

      const lidFromAlt = (message.key as any)?.remoteJidAlt || (message.key as any)?.participantAlt || null;
      if (lidFromAlt && isLidJid(lidFromAlt)) {
        const cleanLid = normalizeLidJid(lidFromAlt) || lidFromAlt;
        await contactModel.attachLidToPhoneContact(phoneE164, cleanLid);
        logger.info(`[PN-ATTACH-LID] Mapeado LID desde Alt: ${cleanLid} → ${phoneE164}`);
      }

      contact = await contactModel.findByPhone(phoneE164);
    }

    if (!contact) {
      logger.error(`[CONTACT] No se pudo obtener/crear contacto para jid=${senderJid}`);
      return;
    }

    logger.info(
      `[CONTACT] Procesando mensaje de ${contact.name || phoneE164} (state=${contact.state})`
    );

    const replyJid = senderJid;

    // ----------------------------------------------------------
    // 1) Bloqueos / permisos
    // ----------------------------------------------------------
    const isBlockedNum = await blockedModel.isBlocked(phoneE164);
    if (isBlockedNum) {
      logger.info(`[BLOCKED] Message from ${phoneE164} - completely blocked`);
      return;
    }

    const permissions = await blockedModel.getPermissions(phoneE164);

    // ----------------------------------------------------------
    // 2) Human takeover vigente (en horario hábil)
    // ----------------------------------------------------------
    const shouldRespond = await contactModel.shouldBotRespond(phoneE164);

    if (!shouldRespond) {
      logger.info(
        `[BOT-PAUSED] 🤫 Skipping response for ${phoneE164} - human takeover active`
      );
      return;
    }

    // ----------------------------------------------------------
    // 3) Texto y media
    // ----------------------------------------------------------
    const rawText = extractMessageText(message);
    const mediaType = getMediaType(message);

    let mediaAnalysisResult: MediaAnalysisResult | null = null;
    let anydeskCode: string | null = null;
    let finalMessageTextFromMedia: string | null = null;

    if (mediaType) {
      logger.info(`[WHATSAPP] Processing ${mediaType} from ${phoneE164}...`);

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

    // ----------------------------------------------------------
    // 4) Contacto y estado
    // ----------------------------------------------------------
    let state = contact.state || 'NEW';

    // ----------------------------------------------------------
    // 5) Horario
    // ----------------------------------------------------------
    const status = await workingHoursModel.getStatusInfo(new Date());
    const negocioCerrado = !status?.isOpen;

    if (negocioCerrado) {
      await replyOutOfHours(replyJid);

      if (esUrgente(finalMessageText)) {
        await marcarUrgenteSinTakeover(phoneE164);
      }
    }

    // ==========================================================
    // 6) NIVEL DE ACCESO RESTRINGIDO
    // ==========================================================
    if (permissions.accessLevel === 'RESTRICTED') {
      logger.info(`[RESTRICTED] ${phoneE164} - Only auto-responses allowed`);

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
          await sendMessage(replyJid, autoResp);
        } else {
          await sendMessage(
            replyJid,
            '⚠️ Tu acceso está restringido. Solo puedo responder consultas básicas. Para más información contacta a soporte.'
          );
        }
      } else {
        await sendMessage(
          replyJid,
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
        logger.info(`[AUTO-RESPONSE] Sent auto-response for ${phoneE164}`);
        await sendMessage(replyJid, autoResp);

        if (state === 'MENU' || state === 'REGISTERED') {
          return;
        }
      }
    }

    // ==========================================================
    // 8) REGISTRO (DNI / RUC / EMPRESA)
    // ==========================================================
    if (state === 'NEW') {
      await contactModel.updateState(phoneE164, 'WAITING_DNI');
      await sendMessage(
        replyJid,
        '¡Hola! 👋 Para continuar, por favor envíame tu *DNI (8 dígitos)* para validar tu identidad y registrar tu nombre. 🙏'
      );
      return;
    }

    if (state === 'WAITING_DNI') {
      const dniCandidate = finalMessageText.trim();
      const isDniValid = /^\d{8}$/.test(dniCandidate);

      if (!isDniValid) {
        await sendMessage(
          replyJid,
          'El DNI debe tener exactamente 8 dígitos numéricos. Inténtalo nuevamente 🙌'
        );
        return;
      }

      const persona = await (await import('./external.js')).validateDNI(
        dniCandidate
      );

      if (!persona) {
        await sendMessage(
          replyJid,
          'No pude validar el DNI en RENIEC. Por favor verifica que sea correcto o inténtalo más tarde.'
        );
        return;
      }

      const nombreCompleto = `${persona.nombres} ${persona.apellidoPaterno} ${persona.apellidoMaterno}`.trim();

      await contactModel.updateDNI(phoneE164, dniCandidate, nombreCompleto);

      await sendMessage(
        replyJid,
        `Perfecto ✅ ${nombreCompleto}.\nAhora envíame el *RUC de tu empresa (11 dígitos)* para asociarte.`
      );
      return;
    }

    if (state === 'WAITING_RUC') {
      const rucCandidate = finalMessageText.trim();
      const isRucBasicValid = /^\d{11}$/.test(rucCandidate);

      if (!isRucBasicValid) {
        await sendMessage(
          replyJid,
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
            replyJid,
            `He verificado tu empresa con RUC ${rucCandidate} ✅`
          );
          await sendMessage(replyJid, buildCompanySelectionMenu(contact));
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
          replyJid,
          `¡Excelente! Quedaste registrado con ${contact.companyName} ✅`
        );
        await sendMessage(replyJid, await buildMainMenu(contact));
        return;
      }

      const infoRuc = await (await import('./external.js')).validateRUC(
        rucCandidate
      );

      if (!infoRuc) {
        await contactModel.updateState(phoneE164, 'WAITING_COMPANY_NAME');
        await saveProvisionalRUC(phoneE164, rucCandidate);

        await sendMessage(
          replyJid,
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
          replyJid,
          `He registrado la empresa: ${razonSocial} ✅`
        );
        await sendMessage(replyJid, buildCompanySelectionMenu(contact));
        return;
      }

      await contactModel.updateState(phoneE164, 'MENU');
      contact = await contactModel.findByPhone(phoneE164);
      if (!contact) {
        logger.error(`[CONTACT] Contact disappeared for ${phoneE164}`);
        return;
      }

      await sendMessage(
        replyJid,
        `¡Excelente! Quedaste registrado con ${contact.companyName} ✅`
      );
      await sendMessage(replyJid, await buildMainMenu(contact));
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
          replyJid,
          'Necesito nuevamente el RUC (11 dígitos) para poder registrar tu empresa. 🙏'
        );
        return;
      }

      await contactModel.updateRUC(phoneE164, provisionalRuc, razonSocialManual);

      contact = await contactModel.findByPhone(phoneE164);
      if (!contact) {
        logger.error(`[CONTACT] Contact disappeared for ${phoneE164}`);
        return;
      }

      if (contact.companies && contact.companies.length > 1) {
        await contactModel.updateState(phoneE164, 'SELECTING_COMPANY');

        await sendMessage(
          replyJid,
          `He registrado la empresa: ${razonSocialManual} ✅`
        );
        await sendMessage(replyJid, buildCompanySelectionMenu(contact));
        return;
      }

      await contactModel.updateState(phoneE164, 'MENU');
      contact = await contactModel.findByPhone(phoneE164);
      if (!contact) {
        logger.error(`[CONTACT] Contact disappeared for ${phoneE164}`);
        return;
      }

      await sendMessage(
        replyJid,
        `¡Excelente! Quedaste registrado con ${contact.companyName} ✅`
      );
      await sendMessage(replyJid, await buildMainMenu(contact));
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
          replyJid,
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
        replyJid,
        `Perfecto 👍 Ahora usaré *${contact.companyName}* como tu empresa activa.`
      );
      await sendMessage(replyJid, await buildMainMenu(contact));
      return;
    }

    // ==========================================================
    // 9) OPERACIÓN (MENU / REGISTERED)
    // ==========================================================
    if (state === 'MENU' || state === 'REGISTERED') {
      const trimmed = finalMessageText.trim();

      if (/^(menu|hola|buenas|hi)$/i.test(trimmed)) {
        await sendMessage(replyJid, await buildMainMenu(contact));
        return;
      }

      if (trimmed === '1') {
        const canUseOdoo = permissions.permissions.odoo ?? true;

        if (!canUseOdoo) {
          logger.warn(`[PERMISSION-DENIED] ${phoneE164} - odoo access denied`);
          await sendMessage(
            replyJid,
            '⚠️ No tienes permiso para consultar información de servicio técnico.'
          );
          return;
        }

        const link = await generateOdooLinkForContact(contact, phoneE164);
        if (link) {
          await sendMessage(
            replyJid,
            `🛠️ *Solicitud de servicio técnico en sitio*\n` +
              `Completa este formulario:\n${link}\n\n` +
              `Indica el modelo o serie del equipo y cuál es el problema.`
          );
        } else {
          await sendMessage(
            replyJid,
            'No pude generar el enlace de servicio técnico. ' +
              'Por favor confirma la Razón Social / RUC registrada.'
          );
        }
        return;
      }

      if (trimmed === '2') {
        const canCreateTickets = permissions.permissions.tickets ?? true;

        if (!canCreateTickets) {
          logger.warn(`[PERMISSION-DENIED] ${phoneE164} - tickets access denied`);
          await sendMessage(
            replyJid,
            '⚠️ No tienes permiso para crear solicitudes de tóner.'
          );
          return;
        }

        const link = await generateOdooLinkForContact(contact, phoneE164);
        if (link) {
          await sendMessage(
            replyJid,
            `🖨 *Solicitud de tóner / suministros*\n` +
              `Realiza tu pedido aquí:\n${link}\n\n` +
              `Indica el número de serie del equipo y el color de tóner que necesitas.`
          );
        } else {
          await sendMessage(
            replyJid,
            'No pude generar el enlace de suministros. ' +
              'Confírmame por favor la empresa / RUC.'
          );
        }
        return;
      }

      if (trimmed === '3') {
        await contactModel.updateState(phoneE164, 'WAITING_REMOTE_INFO');
        await sendMessage(
          replyJid,
          '💻 *Asistencia remota*\n' +
            'Envíame el *ID de AnyDesk* (9 dígitos) o una *foto clara de tu pantalla donde se vea el ID*.\n' +
            'Un técnico podrá conectarse cuando estemos en horario de atención 👨‍💻.'
        );
        return;
      }

      if (trimmed === '4') {
        const empresas = contact.companies || [];
        if (empresas.length <= 1) {
          await sendMessage(
            replyJid,
            'Actualmente solo tienes una empresa asociada.'
          );
        } else {
          await contactModel.updateState(phoneE164, 'SELECTING_COMPANY');
          await sendMessage(replyJid, buildCompanySelectionMenu(contact));
        }
        return;
      }

      if (trimmed === '5') {
        if (negocioCerrado) {
          await sendMessage(
            replyJid,
            '⏰ En este momento no contamos con atención humana. ' +
              'Puedes usar el *menú* para solicitar servicio, tóner o asistencia remota. ' +
              'Un técnico te responderá cuando estemos en horario.'
          );
          return;
        }

        const canTalkToHuman = permissions.permissions.human ?? true;
        if (!canTalkToHuman) {
          logger.warn(`[PERMISSION-DENIED] ${phoneE164} - human access denied`);
          await sendMessage(
            replyJid,
            '⚠️ No puedes solicitar atención humana en este momento. ' +
              'Por favor utiliza las opciones del menú automatizado.'
          );
          return;
        }

        await contactModel.setHumanTakeover(phoneE164);
        await sendMessage(
          replyJid,
          '👨‍🔧 Listo. Estoy derivando tu caso a un técnico. Te van a responder en breve.'
        );
        return;
      }

      if (detectServiceIntent(finalMessageText)) {
        const canUseOdoo = permissions.permissions.odoo ?? true;
        if (!canUseOdoo) {
          await sendMessage(
            replyJid,
            '⚠️ No tienes acceso a solicitudes de servicio técnico.'
          );
          return;
        }

        const link = await generateOdooLinkForContact(contact, phoneE164);
        if (link) {
          await sendMessage(
            replyJid,
            `🛠️ Parece que necesitas soporte técnico.\n` +
              `Completa este formulario y descríbenos el problema:\n${link}`
          );
        } else {
          await sendMessage(
            replyJid,
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
            replyJid,
            '⚠️ No tienes permiso para crear solicitudes de tóner.'
          );
          return;
        }

        const link = await generateOdooLinkForContact(contact, phoneE164);
        if (link) {
          await sendMessage(
            replyJid,
            `🖨 Entendido, solicitud de tóner / insumos.\n` +
              `Haz tu pedido aquí:\n${link}\n\n` +
              `Indica el color que necesitas y el número de serie del equipo.`
          );
        } else {
          await sendMessage(
            replyJid,
            'Para generar el enlace de suministros necesito la Razón Social / RUC registrada. ¿Me la confirmas?'
          );
        }
        return;
      }

      const canUseAI = permissions.permissions.ai ?? true;
      if (canUseAI) {
        const mediaAnalysisJson =
          mediaAnalysisResult ? JSON.stringify(mediaAnalysisResult, null, 2) : '';

        const responseFromGemini = await geminiService.processMessage(
          phoneE164,
          finalMessageText,
          !!mediaType,
          mediaAnalysisJson,
          anydeskCode ?? '',
          mediaAnalysisResult?.mediaTypeClass ?? '',
          mediaAnalysisResult?.detectedErrorCode ?? '',
          mediaAnalysisResult?.detectedSerial ?? ''
        );

        await sendMessage(replyJid, responseFromGemini);
      } else {
        logger.warn(`[PERMISSION-DENIED] ${phoneE164} - AI access denied`);
        await sendMessage(
          replyJid,
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
      await contactModel.updateState(phoneE164, 'MENU');

      contact = await contactModel.findByPhone(phoneE164);
      if (!contact) {
        logger.error(`[CONTACT] Contact disappeared for ${phoneE164}`);
        return;
      }

      await sendMessage(
        replyJid,
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
    await sendMessage(replyJid, await buildMainMenu(contact));
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

  if (trimmed.includes('@')) {
    jid = trimmed;
  } else {
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
  const kind = payload.kind ?? (mime.split('/')[0] as SendMediaPayload['kind']);

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
export function hasQR(): string | null {
  return currentQR !== null ? currentQR : null;
}

export function getStatusForDashboard() {
  return {
    connected: isReady,
    hasQR: currentQR !== null,
    botNumber: botPhoneNumber || null,
  };
}

// ==================================================
// DESCONEXIÓN
// ==================================================
export async function disconnectSession(): Promise<void> {
  // FIX: cancelar cualquier reconexión pendiente antes de desconectar
  // para que el logout manual no compita con un timer de backoff activo
  clearReconnectTimer();
  isLoggedOutPending = false;

  if (sock) {
    try {
      await sock.logout();
      logger.info('WhatsApp disconnected via disconnectSession() - LOGOUT COMPLETO');
    } catch (error) {
      logger.error({ err: error }, 'Error disconnecting WhatsApp:');
    }
  }

  sock = null;
  isReady = false;
  botPhoneNumber = null;
  currentQR = null;
  qrDataURL = null;

  await ensureCleanAuthFolder();
}

export async function forceNewQRState(): Promise<void> {
  try {
    await initializeWhatsApp(false);
    logger.info(
      'forceNewQRState(): WhatsApp client reinitialized without deleting auth'
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
      createdAt: chat.creation ? new Date(chat.creation * 1000).toISOString() : null,
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
  // FIX: también cancelar timer en el disconnect suave
  clearReconnectTimer();

  if (sock) {
    try {
      sock.end(undefined);
      logger.info('WhatsApp disconnected gracefully (auth preserved)');
    } catch (error) {
      logger.error({ err: error }, 'Error during graceful disconnect:');
    }
  }

  sock = null;
  isReady = false;
  botPhoneNumber = null;
  currentQR = null;
  qrDataURL = null;

  logger.info('✅ WhatsApp connection closed, auth files preserved');
}