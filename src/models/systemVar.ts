// src/models/systemVar.ts
import { getPrismaClient } from '../config/database.js';
import { logger } from '../utils/logger.js';

import * as configModel from './configuration.js';
import * as departmentModel from './department.js';
import * as workingHoursModel from './workingHours.js';
import * as calendarModel from './calendar.js';
import * as productModel from './product.js';
import * as messageTemplateModel from './template.js';

const prisma = getPrismaClient();

/**
 * systemVar.ts - AGREGADOR DINÁMICO
 *
 * No persiste datos propios; reúne y normaliza información de:
 * - configuration.ts
 * - department.ts
 * - workingHours.ts
 * - calendar.ts
 * - product.ts
 * - template.ts
 *
 * Objetivo: entregar “paquetes” de contexto listos para prompts y plantillas.
 */

/* =================================================================================
 * 1) VARIABLES PARA PROMPT (compat con tu versión anterior)
 * ================================================================================= */
export async function getVariablesForPrompt(): Promise<Record<string, string>> {
  try {
    // 1) Datos de empresa
    const company = await configModel.getByCategory('company');

    // 2) Departamentos + contactos
    const departments = await departmentModel.getActive();

    // 3) Buscar algunos deptos clave por nombre
    const salesDept = departments.find(
      (d: any) => (d.name || '').toLowerCase().includes('venta')
    );
    const supportDept = departments.find(
      (d: any) =>
        (d.name || '').toLowerCase().includes('soporte') ||
        (d.name || '').toLowerCase().includes('técnico') ||
        (d.name || '').toLowerCase().includes('tecnico')
    );

    const salesContacts = salesDept?.contacts || [];
    const supportContacts = supportDept?.contacts || [];

    // 4) Horarios de hoy
    const todayHours = await workingHoursModel.getTodayHours();

    return {
      // Empresa
      company_name: company.name || 'Mi Empresa',
      company_description: company.description || '',
      company_address: company.address || '',
      company_email: company.email || '',
      company_phone: company.main_phone || '',
      company_website: company.website || '',

      // Ventas (máx 2)
      seller_1_name: salesContacts[0]?.name || '',
      seller_1_phone: salesContacts[0]?.phoneNumber || '',
      seller_1_role: salesContacts[0]?.role || 'Ventas',

      seller_2_name: salesContacts[1]?.name || '',
      seller_2_phone: salesContacts[1]?.phoneNumber || '',
      seller_2_role: salesContacts[1]?.role || 'Ventas',

      // Soporte (máx 2)
      support_1_name: supportContacts[0]?.name || '',
      support_1_phone: supportContacts[0]?.phoneNumber || '',
      support_1_role: supportContacts[0]?.role || 'Soporte',

      support_2_name: supportContacts[1]?.name || '',
      support_2_phone: supportContacts[1]?.phoneNumber || '',
      support_2_role: supportContacts[1]?.role || 'Soporte',

      // Horarios base
      work_hours_start: todayHours?.openTime || '08:30',
      work_hours_end: todayHours?.closeTime || '18:00',
      break_start: todayHours?.breakStart || '13:00',
      break_end: todayHours?.breakEnd || '14:00',
    };
  } catch (error) {
    logger.error({ err: error }, 'Error getting variables for prompt:');

    // Fallback seguro
    return {
      company_name: 'Mi Empresa',
      company_description: '',
      company_address: '',
      company_email: '',
      company_phone: '',
      company_website: '',
      seller_1_name: '',
      seller_1_phone: '',
      seller_1_role: '',
      seller_2_name: '',
      seller_2_phone: '',
      seller_2_role: '',
      support_1_name: '',
      support_1_phone: '',
      support_1_role: '',
      support_2_name: '',
      support_2_phone: '',
      support_2_role: '',
      work_hours_start: '08:30',
      work_hours_end: '18:00',
      break_start: '13:00',
      break_end: '14:00',
    };
  }
}

/* =================================================================================
 * 2) HELPERS DE CONFIGURACIÓN
 * ================================================================================= */
export async function getBusinessTimezone(): Promise<string> {
  const tz = await configModel.get('system', 'timezone');
  return tz || 'America/Lima';
}

export async function getHumanTakeoverMinutes(): Promise<number> {
  const minutes = await configModel.get('system', 'human_takeover_minutes');
  const n = Number(minutes);
  return Number.isFinite(n) && n > 0 ? n : 60;
}

export async function getBotName(): Promise<string> {
  const name = await configModel.get('system', 'bot_name');
  return name || 'Asistente Virtual';
}

export async function isAutoResponseEnabled(): Promise<boolean> {
  const enabled = await configModel.get('system', 'auto_response_enabled');
  return enabled === 'true';
}

export async function isDepartmentRoutingEnabled(): Promise<boolean> {
  const enabled = await configModel.get('system', 'department_routing_enabled');
  return enabled === 'true';
}

/* Flags útiles para Gemini (parametrizables desde BD) */
export async function getAIModeFlags() {
  return {
    ai_menu_mode: (await configModel.get('system', 'ai_menu_mode')) || 'text', // "text" | "buttons" | "list"
    ai_attach_hint: ((await configModel.get('system', 'ai_attach_hint')) || 'true') === 'true',
    ai_allow_after_hours: ((await configModel.get('system', 'ai_allow_after_hours')) || 'true') === 'true',
    policy_remote_tool_name: (await configModel.get('system', 'policy_remote_tool_name')) || 'AnyDesk',
    policy_link_label: (await configModel.get('system', 'policy_link_label')) || 'enlace del sistema',
  };
}

/* =================================================================================
 * 3) PLANTILLAS DE MENSAJES (horarios)
 * ================================================================================= */
export async function getAfterHoursTemplate(): Promise<string> {
  const template = await configModel.get('templates', 'after_hours_message');
  return (
    template ||
    `⏰ {{reason}}.\n🕒 Hoy: {{open}}–{{close}}{{break_hint}}\n{{next_open_line}}\n\nSi tu caso es *URGENTE*, responde *URGENTE* y te derivamos a soporte.`
  );
}

export async function getBreakTemplate(): Promise<string> {
  const template = await configModel.get('templates', 'break_message');
  return (
    template ||
    `⏰ Estamos en horario de refrigerio ({{break_start}}–{{break_end}}). Retomamos a las {{break_end}}.\n{{next_open_line}}`
  );
}

export async function getHolidayTemplate(): Promise<string> {
  const template = await configModel.get('templates', 'holiday_message');
  return (
    template ||
    `⛱️ Hoy es {{event_type}}: {{event_title}}. Por ello, no tenemos atención hoy.\n{{next_open_line}}`
  );
}

/* =================================================================================
 * 4) CONTEXTO DE HORARIOS (para prompts / Gemini)
 * ================================================================================= */
export async function getScheduleContext(): Promise<string> {
  try {
    const now = new Date();
    const dayName = workingHoursModel.getDayName(now.getDay());

    // ¿Feriado?
    const isHoliday = await calendarModel.isHoliday(now);
    const todayEvent = await calendarModel.getTodayEvent();

    // Horarios de hoy
    const todayHours = await workingHoursModel.getTodayHours();
    const isWorkingNow = await workingHoursModel.isWorkingNow();

    let scheduleInfo = `\n📅 **INFORMACIÓN DE HORARIOS**\n`;
    scheduleInfo += `Hoy es ${dayName}, ${now.toLocaleDateString('es-PE', { day: 'numeric', month: 'long' })}\n`;
    scheduleInfo += `Hora actual: ${now.toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit' })}\n\n`;

    if (isHoliday && todayEvent) {
      scheduleInfo += `⚠️ **HOY ES FERIADO/EVENTO ESPECIAL:**\n`;
      scheduleInfo += `"${todayEvent.title}"\n`;
      if (todayEvent.description) {
        scheduleInfo += `${todayEvent.description}\n`;
      }
      if (todayEvent.type === 'holiday' || todayEvent.type === 'closure') {
        scheduleInfo += `\n🔒 **ESTAMOS CERRADOS HOY**\n`;
        scheduleInfo += `IMPORTANTE: No hay atención hoy por este motivo. Indica cuándo abriremos nuevamente.\n\n`;
      }
    }

    if (todayHours && todayHours.isWorkday && !isHoliday) {
      scheduleInfo += `**Horario de hoy:**\n`;
      scheduleInfo += `Apertura: ${todayHours.openTime}\n`;
      scheduleInfo += `Cierre: ${todayHours.closeTime}\n`;
      if (todayHours.breakStart && todayHours.breakEnd) {
        scheduleInfo += `Refrigerio: ${todayHours.breakStart} - ${todayHours.breakEnd}\n`;
      }
      scheduleInfo += `\n**Estado actual:** ${isWorkingNow ? '✅ ABIERTO' : '🔒 CERRADO'}\n\n`;

      if (!isWorkingNow) {
        const currentTime = `${String(now.getHours()).padStart(2, '0')}:${String(
          now.getMinutes()
        ).padStart(2, '0')}`;

        if (
          todayHours.breakStart &&
          todayHours.breakEnd &&
          currentTime >= todayHours.breakStart &&
          currentTime <= todayHours.breakEnd
        ) {
          scheduleInfo += `⏰ **ESTAMOS EN REFRIGERIO** — retomamos a las ${todayHours.breakEnd}\n\n`;
        } else if (currentTime < (todayHours.openTime || '00:00')) {
          scheduleInfo += `⏰ **AÚN NO ABRIMOS** — abrimos a las ${todayHours.openTime}\n\n`;
        } else {
          scheduleInfo += `⏰ **YA CERRAMOS** — cerramos a las ${todayHours.closeTime}\n\n`;
        }
      }
    } else if (!todayHours?.isWorkday || isHoliday) {
      scheduleInfo += `🔒 **HOY NO ES DÍA LABORAL**\n\n`;
    }

    // Horario semanal resumido
    scheduleInfo += `**Horarios de atención (semana):**\n`;
    const allHours = await workingHoursModel.getAll();
    for (const dayHours of allHours) {
      const day = workingHoursModel.getDayName(dayHours.dayOfWeek);
      if (dayHours.isWorkday) {
        scheduleInfo += `${day}: ${dayHours.openTime} - ${dayHours.closeTime}\n`;
      } else {
        scheduleInfo += `${day}: Cerrado\n`;
      }
    }

    // Próximos eventos (máx 3)
    const upcoming = await calendarModel.getUpcoming(30);
    if (upcoming.length > 0) {
      scheduleInfo += `\n**Próximos feriados/eventos:**\n`;
      for (const event of upcoming.slice(0, 3)) {
        const eventDate = new Date(event.date);
        const dateStr = eventDate.toLocaleDateString('es-PE', {
          day: 'numeric',
          month: 'long',
        });
        scheduleInfo += `- ${event.title} (${dateStr})${
          event.type === 'holiday' || event.type === 'closure' ? ' - Cerrado' : ''
        }\n`;
      }
    }

    return scheduleInfo;
  } catch (error) {
    logger.error({ err: error }, 'Error getting schedule context:');
    return '\n⚠️ No se pudo obtener información de horarios.\n';
  }
}

/* =================================================================================
 * 5) CONTEXTO DE DEPARTAMENTOS (para prompts / Gemini)
 * ================================================================================= */
export async function getDepartmentsContext(): Promise<string> {
  try {
    const departments = await departmentModel.getActive();
    if (!departments.length) return '';

    let context = '\n📋 **DEPARTAMENTOS DISPONIBLES**\n\n';
    for (const dept of departments) {
      context += `**${dept.name}**\n`;
      if (dept.description) context += `${dept.description}\n`;

      if (dept.contacts && dept.contacts.length > 0) {
        context += `Contactos:\n`;
        for (const c of dept.contacts.slice(0, 2)) {
          context += `- ${c.name}${c.role ? ` (${c.role})` : ''}${
            c.phoneNumber ? `: ${c.phoneNumber}` : ''
          }\n`;
        }
      }
      context += `\n`;
    }
    return context;
  } catch (error) {
    logger.error({ err: error }, 'Error getting departments context:');
    return '';
  }
}

/* =================================================================================
 * 6) CONTEXTO DE PRODUCTOS (para prompts / Gemini)
 * ================================================================================= */
export async function getProductsContext(category?: string): Promise<string> {
  try {
    const products = category
      ? await productModel.getByCategory(category)
      : await productModel.getActive();

    if (!products.length) return '';

    let context = '\n🛒 **CATÁLOGO DE PRODUCTOS**\n\n';

    // Agrupar por categoría
    const grouped = products.reduce((acc: any, prod: any) => {
      const key = prod.category || 'Sin categoría';
      if (!acc[key]) acc[key] = [];
      acc[key].push(prod);
      return acc;
    }, {});

    for (const [cat, prods] of Object.entries(grouped)) {
      context += `**${cat}**\n`;
      for (const p of (prods as any[]).slice(0, 5)) {
        const price =
          typeof p.price === 'number' ? ` - S/ ${Number(p.price).toFixed(2)}` : '';
        context += `- ${p.name}${price}${p.description ? `\n  ${p.description}` : ''}\n`;
      }
      context += `\n`;
    }

    return context;
  } catch (error) {
    logger.error({ err: error }, 'Error getting products context:');
    return '';
  }
}

export async function getProductCategories(): Promise<string[]> {
  try {
    return await productModel.getCategories();
  } catch (error) {
    logger.error({ err: error }, 'Error getting product categories:');
    return [];
  }
}

/* =================================================================================
 * 7) TEMPLATES (helpers directos)
 * ================================================================================= */
export async function getMessageTemplate(
  category: string,
  name: string
): Promise<string | null> {
  try {
    const list = await messageTemplateModel.getByCategory(category);
    const tpl = list.find((t: any) => (t.name || '') === name);
    return tpl?.content || null;
  } catch (error) {
    logger.error({ err: error }, 'Error getting message template:');
    return null;
  }
}

export async function renderMessageTemplate(
  category: string,
  name: string,
  variables: Record<string, string>
): Promise<string | null> {
  try {
    const content = await getMessageTemplate(category, name);
    if (!content) return null;
    return messageTemplateModel.render(content, variables);
  } catch (error) {
    logger.error({ err: error }, 'Error rendering message template:');
    return null;
  }
}

/* =================================================================================
 * 8) PAQUETE DE CONTEXTO PARA GEMINI (nuevo)
 * ================================================================================= */
export async function getDynamicContextForAI() {
  const [variables, schedule, departments, products, flags] = await Promise.all([
    getVariablesForPrompt(),
    getScheduleContext(),
    getDepartmentsContext(),
    getProductsContext(),
    getAIModeFlags(),
  ]);

  return {
    variables,
    scheduleContext: schedule,
    departmentsContext: departments,
    productsContext: products,
    flags,
  };
}

/* =================================================================================
 * 9) INIT DEFAULTS (migración de valores por defecto a configuration)
 * ================================================================================= */
export async function initDefaults() {
  try {
    logger.info('SystemVar: Ensuring default configurations exist...');

    // Plantillas base (edita desde panel sin tocar código)
    const templates = [
      {
        category: 'templates',
        key: 'after_hours_message',
        value:
          '⏰ {{reason}}.\n🕒 Hoy: {{open}}–{{close}}{{break_hint}}\n{{next_open_line}}\n\nSi tu caso es *URGENTE*, responde *URGENTE* y te derivamos a soporte.',
        isEncrypted: false,
        description: 'Plantilla para mensajes fuera de horario',
      },
      {
        category: 'templates',
        key: 'break_message',
        value:
          '⏰ Estamos en horario de refrigerio ({{break_start}}–{{break_end}}). Retomamos a las {{break_end}}.\n{{next_open_line}}',
        isEncrypted: false,
        description: 'Plantilla para horario de refrigerio',
      },
      {
        category: 'templates',
        key: 'holiday_message',
        value:
          '⛱️ Hoy es {{event_type}}: {{event_title}}. Por ello, no tenemos atención hoy.\n{{next_open_line}}',
        isEncrypted: false,
        description: 'Plantilla para feriados',
      },
      {
        category: 'templates',
        key: 'menu_hint',
        value: 'Si quieres ver el *menú de opciones*, escribe *menu*.',
        isEncrypted: false,
        description: 'Hint corto que se agrega al final de muchas respuestas',
      },
      // Sugeridas para Gemini (si decides crearlas):
      // OUT_OF_HOURS, REGISTRATION_PENDING, INTENT_SERVICE_GUIDE, INTENT_TONER_GUIDE,
      // INTENT_REMOTE_GUIDE, LINK_SERVICE, LINK_TONER, LINK_REMOTE, farewell
    ];

    for (const tpl of templates) {
      const exists = await configModel.get(tpl.category, tpl.key);
      if (!exists) {
        await configModel.set(tpl.category, tpl.key, tpl.value, tpl.isEncrypted);
        logger.info(`Created template: ${tpl.key}`);
      }
    }

    // Configuraciones de sistema útiles para AI
    const systemConfigs = [
      { category: 'system', key: 'timezone', value: 'America/Lima', description: 'Zona horaria del negocio' },
      { category: 'system', key: 'human_takeover_minutes', value: '60', description: 'Minutos antes de expirar takeover humano' },
      { category: 'system', key: 'ai_menu_mode', value: 'text', description: 'Modo de menú AI: text|buttons|list' },
      { category: 'system', key: 'ai_attach_hint', value: 'true', description: 'Adjuntar hint de menú al final' },
      { category: 'system', key: 'ai_allow_after_hours', value: 'true', description: 'Permitir interacción AI fuera de horario (sin humano)' },
      { category: 'system', key: 'policy_remote_tool_name', value: 'AnyDesk', description: 'Nombre de la herramienta remota' },
      { category: 'system', key: 'policy_link_label', value: 'enlace del sistema', description: 'Etiqueta amigable para links' },
    ];

    for (const cfg of systemConfigs) {
      const exists = await configModel.get(cfg.category, cfg.key);
      if (!exists) {
        await configModel.set(cfg.category, cfg.key, cfg.value, false);
        logger.info(`Created system config: ${cfg.key}`);
      }
    }

    logger.info('✅ SystemVar defaults initialized');
  } catch (error) {
    logger.error({ err: error }, 'Error initializing systemVar defaults:');
  }
}

/* =================================================================================
 * 10) COMPAT (funciones legacy para no romper otros módulos)
 * ================================================================================= */
export async function get(key: string): Promise<string | null> {
  logger.warn(`systemVar.get("${key}") is deprecated. Use configuration.get() or specific helpers instead.`);

  const mapping: Record<string, { category: string; key: string }> = {
    company_name: { category: 'company', key: 'name' },
    support_phone: { category: 'company', key: 'main_phone' },
    business_timezone: { category: 'system', key: 'timezone' },
    human_takeover_minutes: { category: 'system', key: 'human_takeover_minutes' },
  };

  const mapped = mapping[key];
  if (mapped) {
    return await configModel.get(mapped.category, mapped.key);
  }
  return null;
}

export async function set(key: string, value: string, _description?: string) {
  logger.warn(`systemVar.set("${key}") is deprecated. Use configuration.set() instead.`);
  throw new Error('systemVar.set() is deprecated. Use configuration.set() directly.');
}

export async function getAll() {
  logger.warn('systemVar.getAll() is deprecated. Use getVariablesForPrompt() instead.');
  return await getVariablesForPrompt();
}

/* =================================================================================
 * 11) (Opcional) API amigable para Gemini: contexto “todo-en-uno”
 * ================================================================================= */
/** Alias legible */
export async function getScheduleContextForAI() {
  return getScheduleContext();
}
export async function getDepartmentsContextForAI() {
  return getDepartmentsContext();
}
export async function getProductsContextForAI() {
  return getProductsContext();
}
