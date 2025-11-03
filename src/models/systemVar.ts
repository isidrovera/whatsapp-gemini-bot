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
 * systemVar.ts - HELPER/AGREGADOR
 * 
 * Este archivo NO almacena datos propios, sino que los obtiene de:
 * - configuration.ts (empresa, API keys, configs generales)
 * - department.ts (departamentos y contactos)
 * - workingHours.ts (horarios)
 * - calendar.ts (feriados)
 * - product.ts (catálogo de productos)
 * - messageTemplate.ts (plantillas de mensajes)
 * 
 * Su única función es AGREGAR datos de múltiples fuentes
 * para facilitar su uso en prompts y plantillas.
 */

// ==============================
// AGREGADOR: Variables para Prompt de Gemini
// ==============================

export async function getVariablesForPrompt(): Promise<Record<string, string>> {
  try {
    // 1. Datos de la empresa
    const company = await configModel.getByCategory('company');
    
    // 2. Departamentos activos con sus contactos
    const departments = await departmentModel.getActive();
    
    // 3. Buscar departamentos específicos por nombre
    const salesDept = departments.find(d => d.name.toLowerCase().includes('venta'));
    const supportDept = departments.find(d => d.name.toLowerCase().includes('soporte') || d.name.toLowerCase().includes('técnico'));
    
    // 4. Extraer contactos principales (primero de cada lista)
    const salesContacts = salesDept?.contacts || [];
    const supportContacts = supportDept?.contacts || [];
    
    // 5. Horarios generales
    const todayHours = await workingHoursModel.getTodayHours();
    
    return {
      // Empresa
      company_name: company.name || 'Mi Empresa',
      company_description: company.description || '',
      company_address: company.address || '',
      company_email: company.email || '',
      company_phone: company.main_phone || '',
      company_website: company.website || '',
      
      // Contactos de ventas (máximo 2)
      seller_1_name: salesContacts[0]?.name || '',
      seller_1_phone: salesContacts[0]?.phoneNumber || '',
      seller_1_role: salesContacts[0]?.role || 'Ventas',
      
      seller_2_name: salesContacts[1]?.name || '',
      seller_2_phone: salesContacts[1]?.phoneNumber || '',
      seller_2_role: salesContacts[1]?.role || 'Ventas',
      
      // Contactos de soporte (máximo 2)
      support_1_name: supportContacts[0]?.name || '',
      support_1_phone: supportContacts[0]?.phoneNumber || '',
      support_1_role: supportContacts[0]?.role || 'Soporte',
      
      support_2_name: supportContacts[1]?.name || '',
      support_2_phone: supportContacts[1]?.phoneNumber || '',
      support_2_role: supportContacts[1]?.role || 'Soporte',
      
      // Horarios de hoy
      work_hours_start: todayHours?.openTime || '08:30',
      work_hours_end: todayHours?.closeTime || '18:00',
      break_start: todayHours?.breakStart || '13:00',
      break_end: todayHours?.breakEnd || '14:00',
    };
  } catch (error) {
    logger.error({ err: error },'Error getting variables for prompt:');
    
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

// ==============================
// HELPERS: Configuración específica
// ==============================

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

// ==============================
// PLANTILLAS: Mensajes de horario
// ==============================

export async function getAfterHoursTemplate(): Promise<string> {
  const template = await configModel.get('templates', 'after_hours_message');
  
  return template || 
    `⏰ {{reason}}.\n🕒 Hoy: {{open}}–{{close}}{{break_hint}}\n{{next_open_line}}\n\nSi tu caso es *URGENTE*, responde *URGENTE* y te derivamos a soporte.`;
}

export async function getBreakTemplate(): Promise<string> {
  const template = await configModel.get('templates', 'break_message');
  
  return template || 
    `⏰ Estamos en horario de refrigerio ({{break_start}}–{{break_end}}). Retomamos a las {{break_end}}.\n{{next_open_line}}`;
}

export async function getHolidayTemplate(): Promise<string> {
  const template = await configModel.get('templates', 'holiday_message');
  
  return template || 
    `⛱️ Hoy es {{event_type}}: {{event_title}}. Por ello, no tenemos atención hoy.\n{{next_open_line}}`;
}

// ==============================
// AGREGADOR: Contexto completo de horarios
// ==============================

export async function getScheduleContext(): Promise<string> {
  try {
    const now = new Date();
    const dayName = workingHoursModel.getDayName(now.getDay());
    
    // Verificar si hoy es feriado
    const isHoliday = await calendarModel.isHoliday(now);
    const todayEvent = await calendarModel.getTodayEvent();
    
    // Obtener horarios de hoy
    const todayHours = await workingHoursModel.getTodayHours();
    const isWorkingNow = await workingHoursModel.isWorkingNow();
    
    let scheduleInfo = `\n📅 **INFORMACIÓN DE HORARIOS**\n`;
    scheduleInfo += `Hoy es ${dayName}, ${now.toLocaleDateString('es-PE', { day: 'numeric', month: 'long' })}\n`;
    scheduleInfo += `Hora actual: ${now.toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit' })}\n\n`;
    
    // Si hoy es feriado/evento especial
    if (isHoliday && todayEvent) {
      scheduleInfo += `⚠️ **HOY ES FERIADO/EVENTO ESPECIAL:**\n`;
      scheduleInfo += `"${todayEvent.title}"\n`;
      if (todayEvent.description) {
        scheduleInfo += `${todayEvent.description}\n`;
      }
      
      if (todayEvent.type === 'holiday' || todayEvent.type === 'closure') {
        scheduleInfo += `\n🔒 **ESTAMOS CERRADOS HOY**\n`;
        scheduleInfo += `IMPORTANTE: Informa al cliente que no hay atención hoy por este motivo.\n`;
        scheduleInfo += `Indica cuándo abriremos nuevamente.\n\n`;
      }
    }
    
    // Horarios de hoy
    if (todayHours && todayHours.isWorkday && !isHoliday) {
      scheduleInfo += `**Horario de hoy:**\n`;
      scheduleInfo += `Apertura: ${todayHours.openTime}\n`;
      scheduleInfo += `Cierre: ${todayHours.closeTime}\n`;
      
      if (todayHours.breakStart && todayHours.breakEnd) {
        scheduleInfo += `Refrigerio: ${todayHours.breakStart} - ${todayHours.breakEnd}\n`;
      }
      
      scheduleInfo += `\n**Estado actual:** ${isWorkingNow ? '✅ ABIERTO' : '🔒 CERRADO'}\n\n`;
      
      if (!isWorkingNow) {
        const currentTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
        
        // Verificar si está en refrigerio
        if (todayHours.breakStart && todayHours.breakEnd && 
            currentTime >= todayHours.breakStart && currentTime <= todayHours.breakEnd) {
          scheduleInfo += `⏰ **ESTAMOS EN HORARIO DE REFRIGERIO**\n`;
          scheduleInfo += `Retomamos atención a las ${todayHours.breakEnd}\n`;
          scheduleInfo += `Informa al cliente que estamos en almuerzo y lo atenderemos pronto.\n\n`;
        } else if (currentTime < (todayHours.openTime || '00:00')) {
          scheduleInfo += `⏰ **AÚN NO ABRIMOS**\n`;
          scheduleInfo += `Abrimos a las ${todayHours.openTime}\n`;
          scheduleInfo += `Informa al cliente cuándo abriremos.\n\n`;
        } else {
          scheduleInfo += `⏰ **YA CERRAMOS**\n`;
          scheduleInfo += `Cerramos a las ${todayHours.closeTime}\n`;
          scheduleInfo += `Informa al cliente que retomamos mañana.\n\n`;
        }
      }
    } else if (!todayHours?.isWorkday || isHoliday) {
      scheduleInfo += `🔒 **HOY NO ES DÍA LABORAL**\n`;
      scheduleInfo += `Informa al cliente nuestro horario semanal.\n\n`;
    }
    
    // Horario semanal resumido
    scheduleInfo += `**Horarios de atención:**\n`;
    const allHours = await workingHoursModel.getAll();
    
    for (const dayHours of allHours) {
      const day = workingHoursModel.getDayName(dayHours.dayOfWeek);
      
      if (dayHours.isWorkday) {
        scheduleInfo += `${day}: ${dayHours.openTime} - ${dayHours.closeTime}\n`;
      } else {
        scheduleInfo += `${day}: Cerrado\n`;
      }
    }
    
    // Próximos eventos (máximo 3)
    const upcomingEvents = await calendarModel.getUpcoming(30);
    if (upcomingEvents.length > 0) {
      scheduleInfo += `\n**Próximos feriados/eventos:**\n`;
      
      for (const event of upcomingEvents.slice(0, 3)) {
        const eventDate = new Date(event.date);
        const dateStr = eventDate.toLocaleDateString('es-PE', { 
          day: 'numeric', 
          month: 'long' 
        });
        
        scheduleInfo += `- ${event.title} (${dateStr})`;
        if (event.type === 'holiday' || event.type === 'closure') {
          scheduleInfo += ` - Cerrado`;
        }
        scheduleInfo += `\n`;
      }
    }
    
    return scheduleInfo;
    
  } catch (error) {
    logger.error({ err: error },'Error getting schedule context:');
    return '\n⚠️ No se pudo obtener información de horarios.\n';
  }
}

// ==============================
// AGREGADOR: Información de departamentos
// ==============================

export async function getDepartmentsContext(): Promise<string> {
  try {
    const departments = await departmentModel.getActive();
    
    if (departments.length === 0) {
      return '';
    }
    
    let context = '\n📋 **DEPARTAMENTOS DISPONIBLES**\n\n';
    
    for (const dept of departments) {
      context += `**${dept.name}**\n`;
      if (dept.description) {
        context += `${dept.description}\n`;
      }
      
      if (dept.contacts && dept.contacts.length > 0) {
        context += `Contactos:\n`;
        for (const contact of dept.contacts.slice(0, 2)) { // Máximo 2 contactos por depto
          context += `- ${contact.name}`;
          if (contact.role) context += ` (${contact.role})`;
          if (contact.phoneNumber) context += `: ${contact.phoneNumber}`;
          context += `\n`;
        }
      }
      
      context += `\n`;
    }
    
    return context;
  } catch (error) {
    logger.error({ err: error },'Error getting departments context:');
    return '';
  }
}

// ==============================
// AGREGADOR: Catálogo de productos
// ==============================

export async function getProductsContext(category?: string): Promise<string> {
  try {
    const products = category 
      ? await productModel.getByCategory(category)
      : await productModel.getActive();
    
    if (products.length === 0) {
      return '';
    }
    
    let context = '\n🛒 **CATÁLOGO DE PRODUCTOS**\n\n';
    
    // Agrupar por categoría
    const byCategory = products.reduce((acc, prod) => {
      if (!acc[prod.category]) acc[prod.category] = [];
      acc[prod.category].push(prod);
      return acc;
    }, {} as Record<string, typeof products>);
    
    for (const [cat, prods] of Object.entries(byCategory)) {
      context += `**${cat}**\n`;
      
      for (const prod of prods.slice(0, 5)) { // Máximo 5 productos por categoría
        context += `- ${prod.name}`;
        if (prod.price) {
          context += ` - S/ ${prod.price.toFixed(2)}`;
        }
        if (prod.description) {
          context += `\n  ${prod.description}`;
        }
        context += `\n`;
      }
      
      context += `\n`;
    }
    
    return context;
  } catch (error) {
    logger.error({ err: error },'Error getting products context:');
    return '';
  }
}

export async function getProductCategories(): Promise<string[]> {
  try {
    return await productModel.getCategories();
  } catch (error) {
    logger.error({ err: error },'Error getting product categories:');
    return [];
  }
}

// ==============================
// PLANTILLAS: Obtener y renderizar
// ==============================

export async function getMessageTemplate(category: string, name: string): Promise<string | null> {
  try {
    const templates = await messageTemplateModel.getByCategory(category);
    const template = templates.find(t => t.name === name);
    return template?.content || null;
  } catch (error) {
    logger.error({ err: error },'Error getting message template:');
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
    logger.error({ err: error },'Error rendering message template:');
    return null;
  }
}

// ==============================
// INICIALIZACIÓN: Migrar defaults a configuration.ts
// ==============================

export async function initDefaults() {
  try {
    logger.info('SystemVar: Ensuring default configurations exist...');
    
    // Las plantillas de mensajes ahora van en configuration.ts
    const templates = [
      {
        category: 'templates',
        key: 'after_hours_message',
        value: '⏰ {{reason}}.\n🕒 Hoy: {{open}}–{{close}}{{break_hint}}\n{{next_open_line}}\n\nSi tu caso es *URGENTE*, responde *URGENTE* y te derivamos a soporte.',
        isEncrypted: false,
        description: 'Plantilla para mensajes fuera de horario',
      },
      {
        category: 'templates',
        key: 'break_message',
        value: '⏰ Estamos en horario de refrigerio ({{break_start}}–{{break_end}}). Retomamos a las {{break_end}}.\n{{next_open_line}}',
        isEncrypted: false,
        description: 'Plantilla para horario de refrigerio',
      },
      {
        category: 'templates',
        key: 'holiday_message',
        value: '⛱️ Hoy es {{event_type}}: {{event_title}}. Por ello, no tenemos atención hoy.\n{{next_open_line}}',
        isEncrypted: false,
        description: 'Plantilla para feriados',
      },
    ];
    
    for (const tpl of templates) {
      const exists = await configModel.get(tpl.category, tpl.key);
      if (!exists) {
        await configModel.set(tpl.category, tpl.key, tpl.value, tpl.isEncrypted);
        logger.info(`Created template: ${tpl.key}`);
      }
    }
    
    // Configuraciones de sistema
    const systemConfigs = [
      { category: 'system', key: 'timezone', value: 'America/Lima', description: 'Zona horaria del negocio' },
      { category: 'system', key: 'human_takeover_minutes', value: '60', description: 'Minutos antes de expirar takeover humano' },
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
    logger.error({ err: error },'Error initializing systemVar defaults:');
  }
}

// ==============================
// COMPAT: Funciones legacy (por si las usas en otro código)
// ==============================

export async function get(key: string): Promise<string | null> {
  logger.warn(`systemVar.get("${key}") is deprecated. Use configuration.get() or specific helpers instead.`);
  
  // Mapeo legacy -> nuevo sistema
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

export async function set(key: string, value: string, description?: string) {
  logger.warn(`systemVar.set("${key}") is deprecated. Use configuration.set() instead.`);
  throw new Error('systemVar.set() is deprecated. Use configuration.set() directly.');
}

export async function getAll() {
  logger.warn('systemVar.getAll() is deprecated. Use getVariablesForPrompt() instead.');
  return await getVariablesForPrompt();
}