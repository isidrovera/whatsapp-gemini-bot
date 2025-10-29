// src/services/gemini.ts

import { getGeminiModel } from '../config/gemini.js';
import { logger } from '../utils/logger.js';

import * as conversationModel from '../models/conversation.js';
import * as contactModel from '../models/contact.js';
import * as companyModel from '../models/company.js';
import * as configurationModel from '../models/configuration.js';
import * as departmentModel from '../models/department.js';
import * as productModel from '../models/product.js';
import * as workingHoursModel from '../models/workingHours.js';
import * as tagModel from '../models/tag.js';

import * as odooService from './odoo.js';
import * as externalService from './external.js';
import * as calendarModel from '../models/calendar.js';

import { isValidDNI, isValidRUC } from '../utils/validators.js';
import { replaceVariables } from '../utils/formatters.js';

import * as templateModel from '../models/template.js';
import * as autoResponseModel from '../models/autoResponse.js';

/* ============================================================
   TRACKER DE ENLACES (anti-spam de links del sistema)
   ============================================================ */
interface LinkTracking {
  phoneNumber: string;
  lastLinkSentAt: Date;
  lastLinkUrl: string;
}

const linkTracker = new Map<string, LinkTracking>();
const LINK_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutos

function shouldSendNewLink(phoneNumber: string, newUrl: string): boolean {
  const tracked = linkTracker.get(phoneNumber);
  if (!tracked) return true;

  const now = Date.now();
  const elapsed = now - tracked.lastLinkSentAt.getTime();

  if (tracked.lastLinkUrl === newUrl && elapsed < LINK_COOLDOWN_MS) {
    logger.info(
      `[LINK-TRACKER] Skipping duplicate link for ${phoneNumber} (sent ${Math.round(
        elapsed / 1000
      )}s ago)`
    );
    return false;
  }
  return true;
}

function trackLinkSent(phoneNumber: string, url: string) {
  linkTracker.set(phoneNumber, {
    phoneNumber,
    lastLinkSentAt: new Date(),
    lastLinkUrl: url,
  });
}

/* ============================================================
   HELPERS DINÁMICOS
   ============================================================ */

/**
 * user_context: info del cliente + equipos de Odoo
 */
async function buildUserContext(contact: any, phoneNumber: string) {
  const primaryData = contactModel.resolvePrimaryCompany(contact);

  const activeCompanyName =
    primaryData.companyName || contact.companyName || null;
  const activeCompanyRUC = primaryData.ruc || contact.ruc || null;

  let equipmentContext =
    'El cliente NO tiene equipos registrados en el sistema.';
  let customerInfo: any = null;

  if (activeCompanyName) {
    customerInfo = await odooService.getCustomerInfo(
      activeCompanyName,
      contact.name || 'Usuario',
      phoneNumber
    );

    if (customerInfo) {
      equipmentContext = odooService.formatEquipmentContext(customerInfo);
      logger.info(
        `[ODOO] Found ${customerInfo.equipment.length} equipment(s) for ${activeCompanyName}`
      );
    }
  }

  const userContext = `Nombre: ${contact.name || 'No proporcionado'}
Empresa activa: ${activeCompanyName || 'No proporcionada'}
RUC activo: ${activeCompanyRUC || 'No proporcionado'}
DNI: ${contact.dni || 'No proporcionado'}
Estado interno: ${contact.state || 'N/A'}

EQUIPOS REGISTRADOS EN EL SISTEMA:
${equipmentContext}
`;

  return {
    userContext,
    customerInfo,
    activeCompanyName,
    activeCompanyRUC,
  };
}

/**
 * Texto legible de horarios de atención para IA y para avisos
 */
async function buildScheduleContext() {
  return workingHoursModel.getScheduleContextForAI();
}

/**
 * Bloque de "departamentos y contactos" para IA
 */
async function buildDepartmentsContext() {
  return departmentModel.getDepartmentsContextForAI();
}

/**
 * Bloque de "catálogo de productos/servicios" para IA
 */
async function buildProductsContext() {
  return productModel.getProductsContextForAI();
}

/**
 * Construye el systemPrompt final dinámico.
 */
async function buildSystemPrompt(
  baseUserContext: string,
  departmentsContext: string,
  productsContext: string,
  scheduleContext: string
) {
  const systemVars = await configurationModel.getForSystemVariables();

  // Prompt desde configuración (ai_prompt.system_prompt)
  let systemPromptTemplate =
    (await configurationModel.get('ai_prompt', 'system_prompt')) || '';

  // Fallback si no hay prompt configurado
  if (!systemPromptTemplate || systemPromptTemplate.trim() === '') {
    systemPromptTemplate = `
Eres un asistente virtual profesional de {{company_name}}.

INFORMACIÓN DE LA EMPRESA:
Nombre: {{company_name}}
Descripción: {{company_description}}
📍 Dirección: {{company_address}}
📧 Email: {{company_email}}
📞 Teléfono: {{company_phone}}
🌐 Web: {{company_website}}

DEPARTAMENTOS Y CONTACTOS DISPONIBLES:
{{departments_context}}

CATÁLOGO DE PRODUCTOS Y SERVICIOS:
{{products_context}}

HORARIOS E INFORMACIÓN DE ATENCIÓN:
{{schedule_context}}

INFORMACIÓN DEL USUARIO ACTUAL:
{{user_context}}

REGLAS DE ESTILO / POLÍTICA:
- Tono base: {{policy_tone_style}}
- Llama siempre al link de registro "{{policy_link_label}}", NO digas "Odoo".
- Si el cliente pide soporte remoto, menciona {{policy_remote_tool_name}} y pídele su ID (9 dígitos) o una foto clara.
- Si el usuario pide hablar con humano, ofrécele derivarlo con un técnico real.
- Si el cliente pide servicio técnico onsite, no prometas hora exacta de visita si {{policy_allow_field_visit_commitment}} = "false"; di "un técnico coordina contigo".
- Puedes compartir teléfonos directos solo si {{policy_allow_direct_phone_share}} = "true".
- No repitas información innecesaria y responde breve (máx ~15 líneas).
- Usa emojis profesionales (📋 🔧 🖨 📞 🧑‍💻) si eso mantiene el tono cercano.
`;
  }

  const systemPrompt = replaceVariables(systemPromptTemplate, {
    ...systemVars,
    departments_context: departmentsContext,
    products_context: productsContext,
    schedule_context: scheduleContext,
    user_context: baseUserContext,
  });

  return {
    systemPrompt,
    systemVars,
  };
}

/* ============================================================
   DETECCIÓN DE INTENCIONES
   ============================================================ */

function detectRemoteSupportIntent(
  messageText: string,
  hasMedia: boolean,
  anydeskCode: string | null,
  remoteToolName: string,
  mediaTypeClass: string | null
): boolean {
  const lower = (messageText || '').toLowerCase();

  if (anydeskCode && anydeskCode.trim() !== '') return true;
  if (mediaTypeClass === 'anydesk') return true;

  const remoteKeywords = [
    'asistencia remota',
    'control remoto',
    'soporte remoto',
    'conéctate',
    'conectarse',
    'conexión remota',
    remoteToolName.toLowerCase(),
    'puedes tomar control',
    'pueden ingresar',
    'pueden entrar',
  ];

  return remoteKeywords.some((k) => lower.includes(k));
}

async function detectIntents(
  messageText: string,
  hasMedia: boolean,
  anydeskCode: string | null,
  remoteToolName: string,
  mediaTypeClass: string | null
) {
  const deptMatch = await departmentModel.detectDepartment(messageText);
  const productMatches = await productModel.searchByKeyword(messageText);

  // Remote support?
  const wantsRemote = detectRemoteSupportIntent(
    messageText,
    hasMedia,
    anydeskCode,
    remoteToolName,
    mediaTypeClass
  );

  const lower = messageText.toLowerCase();

  // Tóner / insumos
  const wantsToner =
    lower.includes('tóner') ||
    lower.includes('toner') ||
    lower.includes('cartucho') ||
    lower.includes('insumo') ||
    (productMatches.length > 0 &&
      productMatches[0].product?.category?.toLowerCase?.().includes('tóner'));

  // Falla física / servicio técnico
  let wantsService =
    lower.includes('fall') ||
    lower.includes('soporte') ||
    lower.includes('mantenimiento') ||
    lower.includes('no imprime') ||
    lower.includes('atasco') ||
    lower.includes('atascada') ||
    lower.includes('no jala') ||
    lower.includes('error') ||
    (deptMatch?.department?.name || '')
      .toLowerCase()
      .includes('soporte');

  if (
    mediaTypeClass === 'error_screen' ||
    mediaTypeClass === 'hardware_damage' ||
    mediaTypeClass === 'video'
  ) {
    wantsService = true;
  }

  return {
    deptMatch,
    productMatches,
    wantsRemote,
    wantsToner,
    wantsService,
  };
}

/* ============================================================
   HELPERS DE TEMPLATES DE RESPUESTA
   ============================================================ */

async function renderTemplateByCategory(
  category: string,
  vars: Record<string, string>
): Promise<string | null> {
  try {
    const list = await templateModel.getByCategory(category);
    if (!list || list.length === 0) return null;
    const t = list[0]; // tomamos la primera activa
    const raw = t.content || '';
    return templateModel.render(raw, vars);
  } catch (err) {
    logger.error('[TEMPLATE] Error rendering template:', err);
    return null;
  }
}

async function buildLinkAttachmentMessage(
  category: string,
  linkUrl: string,
  customerInfo: any,
  systemVars: Record<string, string>,
  remoteToolName: string
): Promise<string | null> {
  if (!linkUrl) return null;

  let equipmentBrand = '';
  let equipmentModel = '';
  let equipmentSerial = '';
  let equipmentCount = '0';

  if (customerInfo && Array.isArray(customerInfo.equipment)) {
    equipmentCount = String(customerInfo.equipment.length || 0);

    if (customerInfo.equipment.length === 1) {
      const eq = customerInfo.equipment[0];
      equipmentBrand = eq.brand || '';
      equipmentModel = eq.model || '';
      equipmentSerial = eq.serial || '';
    }
  }

  const vars = {
    link: linkUrl,
    equipmentBrand,
    equipmentModel,
    equipmentSerial,
    equipmentCount,
    policy_link_label: systemVars.policy_link_label || 'enlace del sistema',
    policy_remote_tool_name: remoteToolName || 'AnyDesk',
  };

  const rendered = await renderTemplateByCategory(category, vars);
  return rendered;
}

async function buildEscalateHumanMessage(systemVars: Record<string, string>) {
  const rendered = await renderTemplateByCategory('ESCALATE_HUMAN', {
    company_name: systemVars.company_name || '',
    company_phone: systemVars.company_phone || '',
  });

  return (
    rendered ||
    '⚠ Entendido. Voy a derivar tu caso a soporte humano ahora mismo. Por favor dime brevemente qué está pasando para priorizarlo 🙏.'
  );
}

async function buildOutOfHoursNotice(scheduleContext: string) {
  const rendered = await renderTemplateByCategory('OUT_OF_HOURS', {
    schedule_context: scheduleContext,
  });

  return (
    rendered ||
    `⏰ En este momento estamos fuera de horario. ${scheduleContext}\nSi tu caso es URGENTE responde *URGENTE* y te derivamos a soporte humano.`
  );
}

/* ============================================================
   HELPER: asegurar tag HUMANO en la conversación
   ============================================================ */

async function ensureHumanTag(phoneNumber: string) {
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

    allTags = await tagModel.getAll();
  }

  const convTags = await tagModel.getByConversation(phoneNumber);
  const already = convTags.some(
    (t: any) => (t.name || '').toUpperCase() === 'HUMANO'
  );
  if (!already) {
    await tagModel.assignToConversation(phoneNumber, humanTag.id);
  }
}

/* ============================================================
   DETECCIÓN DE RESPUESTA-MENÚ (para no spamear menú otra vez)
   ============================================================ */

function looksLikeMenuAnswer(text: string): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();

  const hasListNumbers =
    lower.includes('1') &&
    lower.includes('2') &&
    lower.includes('3') &&
    lower.includes('4');

  const hasKeywords =
    lower.includes('servicio técnico') ||
    lower.includes('tóner') ||
    lower.includes('asistencia remota') ||
    lower.includes('cambiar empresa');

  // Si es prácticamente el saludo tipo "Hola NOMBRE ... Por favor elige una opción"
  const isGreetingMenu =
    lower.includes('por favor elige una opción') ||
    lower.includes('por favor elige una opcion');

  return hasListNumbers && hasKeywords && isGreetingMenu;
}

/* ============================================================
   MAIN FLOW
   ============================================================ */

export async function processMessage(
  phoneNumber: string,
  messageText: string,
  hasMedia: boolean = false,
  mediaAnalysisJson: string | null = null,
  anydeskCode: string | null = null,
  mediaTypeClass: string | null = null,
  detectedErrorCode: string | null = null,
  detectedSerial: string | null = null
): Promise<string> {
  try {
    logger.info(
      `Processing message for ${phoneNumber}: ${messageText.substring(
        0,
        80
      )}... ${hasMedia ? '[+MEDIA]' : ''}`
    );

    /* 0. Obtener o crear contacto */
    let contact = await contactModel.findByPhone(phoneNumber);
    if (!contact) {
      contact = await contactModel.create(phoneNumber);
      logger.info(`New contact created: ${phoneNumber}`);
    }

    /* 1. Guardar mensaje del usuario en la conversación */
    let contentToSave = messageText;
    if (hasMedia && mediaAnalysisJson) {
      contentToSave += ` [MEDIA ANALYSIS: ${mediaAnalysisJson.substring(
        0,
        180
      )}...]`;
    }
    if (anydeskCode) {
      contentToSave += ` [ANYDESK: ${anydeskCode}]`;
    }

    await conversationModel.save(phoneNumber, 'USER', contentToSave);

    /* 2. Revisión de estado de registro */
    if (
      contact.state === 'NEW' ||
      contact.state === 'WAITING_DNI' ||
      contact.state === 'WAITING_RUC' ||
      contact.state === 'SELECTING_COMPANY'
    ) {
      const pendingMsg =
        (await renderTemplateByCategory('REGISTRATION_PENDING', {
          nombre: contact.name || 'Cliente',
        })) ||
        'Estoy validando tus datos para poder ayudarte 👍. Ya casi terminamos el registro.';

      await conversationModel.save(phoneNumber, 'ASSISTANT', pendingMsg);
      return pendingMsg;
    }

    /* 3. PRE-CORTE: "URGENTE" fuera de horario */
    const statusInfoEarly = await workingHoursModel.getStatusInfo(new Date());
    const isClosedEarly = !statusInfoEarly.isOpen;
    const txtLower = messageText.trim().toLowerCase();
    const isEscalationKeyword =
      txtLower.includes('urgente') ||
      txtLower.includes('es urgente') ||
      txtLower.includes('emergencia');

    if (isClosedEarly && isEscalationKeyword) {
      // Tag humano
      await ensureHumanTag(phoneNumber);

      // Mensaje humano usando systemVars
      const { userContext } = await buildUserContext(contact, phoneNumber);
      const departmentsContext = await buildDepartmentsContext();
      const productsContext = await buildProductsContext();
      const scheduleContext = await buildScheduleContext();
      const { systemVars } = await buildSystemPrompt(
        userContext,
        departmentsContext,
        productsContext,
        scheduleContext
      );

      const humanEscalationMsg = await buildEscalateHumanMessage(systemVars);

      await conversationModel.save(
        phoneNumber,
        'ASSISTANT',
        humanEscalationMsg
      );
      return humanEscalationMsg;
    }

    /* 4. CONTEXTO DINÁMICO COMPLETO PARA IA */
    const {
      userContext,
      customerInfo,
      activeCompanyName,
      activeCompanyRUC,
    } = await buildUserContext(contact, phoneNumber);

    const departmentsContext = await buildDepartmentsContext();
    const productsContext = await buildProductsContext();
    const scheduleContext = await buildScheduleContext();

    const { systemPrompt, systemVars } = await buildSystemPrompt(
      userContext,
      departmentsContext,
      productsContext,
      scheduleContext
    );

    /* 5. Historial (últimos 10 mensajes USER/ASSISTANT) */
    const recentHistory = await conversationModel.getHistory(phoneNumber, 10);

    const geminiHistory: any[] = [];
    for (const msg of recentHistory) {
      if (msg.role === 'USER') {
        geminiHistory.push({ role: 'user', parts: [{ text: msg.content }] });
      } else if (msg.role === 'ASSISTANT') {
        geminiHistory.push({ role: 'model', parts: [{ text: msg.content }] });
      }
    }
    while (geminiHistory.length > 0 && geminiHistory[0].role !== 'user') {
      geminiHistory.shift();
    }
    const validatedHistory: any[] = [];
    let lastRole: string | null = null;
    for (const msg of geminiHistory) {
      if (lastRole === null || lastRole !== msg.role) {
        validatedHistory.push(msg);
        lastRole = msg.role;
      }
    }

    /* 6. Tags activos (HUMANO, etc.) */
    const conversationTags = await tagModel.getByConversation(phoneNumber);
    const tagNames = conversationTags.map((t: any) =>
      (t.name || '').toUpperCase()
    );

    // regla: si el contacto tiene takeover humano activo EN LA BD (campo humanTakeoverAt reciente)
    // entonces forzamos humano; si solo tiene el tag HUMANO viejo pero ya no hay takeoverAt reciente,
    // permitimos IA.
    let forceHuman = false;
    if (tagNames.includes('HUMANO')) {
      // chequeo adicional:
      const takeoverAt = contact.humanTakeoverAt;
      if (takeoverAt) {
        const elapsedMs = Date.now() - takeoverAt.getTime();
        // 1h de ventana "humano manda"
        if (elapsedMs < 60 * 60 * 1000) {
          forceHuman = true;
        } else {
          logger.debug(
            `[HUMAN-GUARD] HUMANO tag present but humanTakeoverAt is stale (+${Math.round(
              elapsedMs / 1000
            )}s) → Gemini allowed`
          );
        }
      } else {
        logger.debug(
          '[HUMAN-GUARD] HUMANO tag present but no humanTakeoverAt → Gemini allowed'
        );
      }
    }

    logger.debug('[FLOW] forceHuman decision:', {
      forceHuman,
      hasHumanTag: tagNames.includes('HUMANO'),
      humanTakeoverAt: contact.humanTakeoverAt || null,
    });

    /* 7. Detección de intención */
    const {
      deptMatch,
      productMatches,
      wantsRemote,
      wantsToner,
      wantsService,
    } = await detectIntents(
      messageText,
      hasMedia,
      anydeskCode,
      systemVars.policy_remote_tool_name || 'AnyDesk',
      mediaTypeClass
    );

    /* 8. AutoResponse directa si aplica (solo si NO está forzado humano) */
    if (!forceHuman) {
      const autoResp = await autoResponseModel.findAndProcessResponse(
        messageText,
        {
          contact: {
            name: contact.name || null,
            dni: contact.dni || null,
            phoneNumber: phoneNumber,
            companyName: activeCompanyName || null,
            ruc: activeCompanyRUC || null,
          },
          company: {
            razonSocial: activeCompanyName || null,
            numeroDoc: activeCompanyRUC || null,
            name: activeCompanyName || null,
            ruc: activeCompanyRUC || null,
          },
          product:
            productMatches && productMatches[0]
              ? {
                  name: productMatches[0].product.name || '',
                  category: productMatches[0].product.category || '',
                  price: productMatches[0].product.price ?? null,
                }
              : undefined,
        }
      );

      if (autoResp) {
        await conversationModel.save(phoneNumber, 'ASSISTANT', autoResp);
        return autoResp;
      }
    }

    /* 9. Construir mensaje enriquecido que enviamos a Gemini */
    let finalMessageToModel = messageText;

    // Adjuntamos el análisis estructurado media
    if (hasMedia && mediaAnalysisJson) {
      finalMessageToModel += `

[ANÁLISIS TÉCNICO DEL ARCHIVO QUE EL USUARIO ENVIÓ]
${mediaAnalysisJson}
`;
    }

    // Inyectar info crítica detectada automáticamente
    if (detectedErrorCode) {
      finalMessageToModel += `

[CÓDIGO DE ERROR DETECTADO: ${detectedErrorCode}]
Explica en lenguaje simple lo que implica este tipo de error
(en impresoras / multifuncionales / escáner / copiadora),
pregunta si el equipo está totalmente detenido o todavía imprime/escanea parcialmente
y ofrece ayuda para registrar servicio técnico en sitio.
NO prometas hora exacta ni solución definitiva sin ver el equipo físicamente.
NO ofrezcas asistencia remota ni pidas AnyDesk a menos que el usuario lo haya pedido explícitamente.
`;
    }

    if (detectedSerial) {
      finalMessageToModel += `

[NÚMERO DE SERIE DETECTADO DEL EQUIPO: ${detectedSerial}]
Incluye este número al hablar del caso,
para que el técnico identifique el equipo correcto.
`;
    }

    if (anydeskCode) {
      finalMessageToModel += `

[ID REMOTO (${systemVars.policy_remote_tool_name ||
        'AnyDesk'}) DETECTADO DEL USUARIO: ${anydeskCode}]
Inclúyelo una sola vez en la respuesta y ofrece conexión remota de un técnico humano 👨‍💻.
No repitas el ID varias veces.
`;
    }

    // Guías específicas según intención detectada
    if (wantsRemote) {
      const remoteGuide =
        (await renderTemplateByCategory('INTENT_REMOTE_GUIDE', {
          policy_remote_tool_name:
            systemVars.policy_remote_tool_name || 'AnyDesk',
          policy_link_label:
            systemVars.policy_link_label || 'enlace del sistema',
        })) ||
        `El usuario solicita soporte remoto (${systemVars.policy_remote_tool_name ||
          'AnyDesk'}). Pídele su ID (9 dígitos) si no lo dio aún o confirma el que detectaste. Dile que un técnico puede conectarse.`;
      finalMessageToModel += `

[GUÍA DE CONTEXTO PARA TU RESPUESTA - ASISTENCIA REMOTA]
${remoteGuide}
`;
    }

    if (wantsService) {
      const serviceGuide =
        (await renderTemplateByCategory('INTENT_SERVICE_GUIDE', {
          policy_link_label:
            systemVars.policy_link_label || 'enlace del sistema',
        })) ||
        `El usuario reporta una falla física / mensaje de error en el equipo. Pídele más detalles ("atasco de papel", "no imprime negro", etc.). Ofrece registrar servicio técnico para que un técnico coordine visita. No prometas hora exacta.`;
      finalMessageToModel += `

[GUÍA DE CONTEXTO PARA TU RESPUESTA - SERVICIO TÉCNICO]
${serviceGuide}
`;
    }

    if (wantsToner) {
      const tonerGuide =
        (await renderTemplateByCategory('INTENT_TONER_GUIDE', {
          policy_link_label:
            systemVars.policy_link_label || 'enlace del sistema',
        })) ||
        `El usuario solicita tóner / insumos. Pídele confirmar modelo/serie y el color de tóner que necesita. No prometas stock inmediato.`;
      finalMessageToModel += `

[GUÍA DE CONTEXTO PARA TU RESPUESTA - TÓNER / INSUMOS]
${tonerGuide}
`;
    }

    // ⚠️ INSTRUCCIONES NEGATIVAS
    if (!wantsRemote) {
      if (wantsService) {
        finalMessageToModel += `

[RESTRICCIÓN IMPORTANTE]
El usuario NO ha solicitado soporte remoto ni ha dado un ID de conexión remota válido.
ESTO PARECE una falla física / código de error en la máquina.
NO pidas AnyDesk ni hables de conexión remota.
Tu enfoque debe ser:
1) reconocer el problema/código que se ve en la máquina,
2) pedir confirmación de síntomas (¿puede imprimir? ¿está detenida?),
3) ofrecer registrar un servicio técnico en sitio para que un técnico coordine visita.
`;
      } else {
        finalMessageToModel += `

[RESTRICCIÓN IMPORTANTE]
El usuario NO ha solicitado soporte remoto.
NO pidas AnyDesk ni hables de conexión remota a menos que él mismo lo pida.
Primero pide una breve explicación del problema que muestra la imagen / archivo.
`;
      }
    }

    if (wantsRemote) {
      finalMessageToModel += `

[RESTRICCIÓN IMPORTANTE]
El usuario SÍ está pidiendo asistencia remota.
Debes pedir o confirmar el ID de ${systemVars.policy_remote_tool_name ||
        'AnyDesk'} (9 dígitos) UNA sola vez y explicar que un técnico humano puede conectarse.
No prometas tiempos exactos.
`;
    }

    /* 10. ¿Forzamos humano? */
    if (forceHuman) {
      const humanMsg = await buildEscalateHumanMessage(systemVars);

      await conversationModel.save(phoneNumber, 'ASSISTANT', humanMsg);
      return humanMsg;
    }

    /* 11. Crear sesión Gemini con systemInstruction dinámico */
    const model = await getGeminiModel();
    const chat = model.startChat({
      history: validatedHistory,
      systemInstruction: {
        role: 'system',
        parts: [{ text: systemPrompt }],
      },
    });

    logger.info(
      `[GEMINI] Sending enriched message (${finalMessageToModel.length} chars)`
    );
    const result = await chat.sendMessage(finalMessageToModel);
    let response = result.response.text() || '';

    logger.info(
      `[GEMINI] Initial response: ${response.substring(0, 160)}...`
    );

    /* 12. Post-procesamiento (links / humano / fuera de horario / antispam menú duplicado) */

    const needsLink = wantsRemote || wantsService || wantsToner;

    if (needsLink && activeCompanyName && customerInfo) {
      // si el cliente tiene un solo equipo, preselecciona
      const equipmentId =
        customerInfo.equipment && customerInfo.equipment.length === 1
          ? customerInfo.equipment[0].id
          : undefined;

      const serviceUrl = await odooService.getOdooServiceLink(
        activeCompanyName,
        contact.name || 'Usuario',
        phoneNumber,
        equipmentId
      );

      if (serviceUrl && shouldSendNewLink(phoneNumber, serviceUrl)) {
        let linkCategory = 'LINK_SERVICE';
        if (wantsRemote) linkCategory = 'LINK_REMOTE';
        else if (wantsToner) linkCategory = 'LINK_TONER';

        const linkMsg = await buildLinkAttachmentMessage(
          linkCategory,
          serviceUrl,
          customerInfo,
          systemVars,
          systemVars.policy_remote_tool_name || 'AnyDesk'
        );

        if (linkMsg) {
          response += `\n\n${linkMsg}`;
        }

        trackLinkSent(phoneNumber, serviceUrl);
        logger.info(
          `[GEMINI] Link added with equipment context (${
            customerInfo.equipment?.length || 0
          } equipment(s))`
        );
      } else if (serviceUrl) {
        logger.info(`[GEMINI] Link skipped (recently sent)`);
      } else {
        logger.warn(`[GEMINI] Could not obtain link from Odoo`);
      }
    } else if (needsLink && !customerInfo) {
      if (wantsRemote) {
        const remoteFallback =
          (await renderTemplateByCategory(
            'REMOTE_FALLBACK_NO_CUSTOMER',
            {
              policy_remote_tool_name:
                systemVars.policy_remote_tool_name || 'AnyDesk',
            }
          )) ||
          `Por favor envíame tu ID de ${systemVars.policy_remote_tool_name ||
            'AnyDesk'} (9 dígitos) o una foto clara de tu pantalla para que un técnico se conecte 🧑‍💻.`;
        response += `\n\n${remoteFallback}`;
      } else {
        const genericFallback =
          (await renderTemplateByCategory(
            'SERVICE_FALLBACK_NO_CUSTOMER',
            {
              policy_link_label:
                systemVars.policy_link_label || 'enlace del sistema',
            }
          )) ||
          `Necesito validar tu empresa registrada para poder generar el ${systemVars.policy_link_label ||
            'enlace del sistema'}. ¿Me confirmas la razón social o el RUC, por favor?`;
        response += `\n\n${genericFallback}`;
      }
    }

    // Nota fuera de horario (si no se forzó humano)
    const statusInfo = await workingHoursModel.getStatusInfo(new Date());
    if (!statusInfo.isOpen) {
      const outOfHours = await buildOutOfHoursNotice(scheduleContext);
      if (outOfHours) {
        response += `\n\n${outOfHours}`;
      }
    }

    // último: si Gemini respondió básicamente el menú otra vez y el user NO pidió menú,
    // devolvemos una respuesta más humana en lugar de spamear menú.
    if (
      looksLikeMenuAnswer(response) &&
      !/^(menu|hola|buenas|hi)$/i.test(messageText.trim())
    ) {
      response =
        'Perfecto 👍. Ya tomé nota de tu mensaje. Un técnico lo está revisando y te va a responder en breve 🙌.';
    }

    /* 13. Guardar respuesta final en BD */
    await conversationModel.save(phoneNumber, 'ASSISTANT', response);

    /* 14. Devolver respuesta (WhatsApp) */
    return response;
  } catch (error) {
    logger.error(`[GEMINI] Error:`, error);
    return 'Lo siento, estoy teniendo problemas para procesar tu mensaje. ¿Podrías intentarlo de nuevo?';
  }
}
