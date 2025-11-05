// src/models/autoResponse.ts
import { getPrismaClient } from '../config/database.js';
import { logger } from '../utils/logger.js';

const prisma = getPrismaClient();

export type AutoResponseInput = {
  trigger: string;
  response: string;
  isActive?: boolean;
  priority?: number;
  category?: string | null;
};

/**
 * SISTEMA DE VARIABLES DINÁMICO
 * 
 * Detecta automáticamente qué variables usa la respuesta y carga los datos necesarios.
 * 
 * VARIABLES BÁSICAS (siempre disponibles):
 * - {{nombre}}, {{dni}}, {{telefono}}, {{empresa}}, {{ruc}}
 * - {{fecha}}, {{hora}}
 * - {{producto}}, {{categoria}}, {{precio}}
 * 
 * VARIABLES DINÁMICAS (se cargan automáticamente si se usan):
 * - {{departamentos}} - Lista completa de departamentos con contactos
 * - {{ventas_nombre}}, {{ventas_telefono}}, {{ventas_contactos}}
 * - {{soporte_nombre}}, {{soporte_telefono}}, {{soporte_contactos}}
 * - {{alquiler_nombre}}, {{alquiler_telefono}}, {{alquiler_contactos}}
 * - {{facturacion_nombre}}, {{facturacion_telefono}}, {{facturacion_contactos}}
 * - {{horario_hoy}}, {{horario_apertura}}, {{horario_cierre}}
 * - {{break_inicio}}, {{break_fin}}, {{esta_abierto}}
 * - {{catalogo}} - Lista de productos activos
 */

/**
 * Detecta qué variables dinámicas usa el template
 */
function detectRequiredData(text: string): {
  needsDepartments: boolean;
  needsWorkingHours: boolean;
  needsProducts: boolean;
} {
  const lower = text.toLowerCase();
  
  return {
    needsDepartments: 
      /\{\{departamentos\}\}/.test(lower) ||
      /\{\{ventas_/.test(lower) ||
      /\{\{soporte_/.test(lower) ||
      /\{\{alquiler_/.test(lower) ||
      /\{\{facturacion_/.test(lower) ||
      /\{\{[a-z_]+_nombre\}\}/.test(lower) ||
      /\{\{[a-z_]+_telefono\}\}/.test(lower) ||
      /\{\{[a-z_]+_contactos\}\}/.test(lower),
    
    needsWorkingHours:
      /\{\{horario_/.test(lower) ||
      /\{\{break_/.test(lower) ||
      /\{\{esta_abierto\}\}/.test(lower),
    
    needsProducts:
      /\{\{catalogo\}\}/.test(lower)
  };
}

/**
 * Carga datos dinámicos según lo que necesite el template
 */
async function loadDynamicData(required: ReturnType<typeof detectRequiredData>) {
  const data: Record<string, string> = {};

  try {
    // Cargar departamentos si se necesitan
    if (required.needsDepartments) {
      const departmentModel = await import('./department.js');
      const departments = await departmentModel.getActive();
      
      // Lista completa formateada
      data.departamentos = departments
        .map((d: any, i: number) => {
          const contacts = d.contacts
            ?.map((c: any) => `  📱 ${c.name}: ${c.phoneNumber || c.whatsapp || 'Sin contacto'}`)
            .join('\n') || '  (Sin contactos disponibles)';
          
          return `${i + 1}️⃣ *${d.name}*\n   ${d.description || ''}\n${contacts}`;
        })
        .join('\n\n');

      // Variables por departamento específico (dinámico para CUALQUIER departamento)
      for (const dept of departments) {
        // "Soporte Técnico" → "soporte_tecnico"
        const key = String(dept.name ?? '')
          .toLowerCase()
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '') // quitar acentos
          .replace(/\s+/g, '_'); // espacios a guión bajo

        data[`${key}_nombre`] = dept.name ?? '';
        data[`${key}_telefono`] = dept.phoneNumber || 'No disponible';
        data[`${key}_contactos`] = dept.contacts
          ?.map((c: any) => `${c.name}: ${c.phoneNumber || c.whatsapp || 'Sin teléfono'}`)
          .join('\n') || 'Sin contactos disponibles';
      }
    }

    // Cargar horarios si se necesitan
    if (required.needsWorkingHours) {
      const workingHoursModel = await import('./workingHours.js');
      const todayHours = await workingHoursModel.getTodayHours();
      const isOpen = await workingHoursModel.isWorkingNow();

      if (todayHours) {
        data.horario_apertura = todayHours.openTime || '--:--';
        data.horario_cierre = todayHours.closeTime || '--:--';
        data.break_inicio = todayHours.breakStart || 'No aplica';
        data.break_fin = todayHours.breakEnd || 'No aplica';
        data.horario_hoy = todayHours.isWorkday
          ? `${todayHours.openTime} - ${todayHours.closeTime}${
              todayHours.breakStart ? ` (break ${todayHours.breakStart}-${todayHours.breakEnd})` : ''
            }`
          : 'Cerrado';
        data.esta_abierto = isOpen ? '✅ Abierto' : '🔒 Cerrado';
      }
    }

    // Cargar productos si se necesitan
    if (required.needsProducts) {
      const productModel = await import('./product.js');
      const products = await productModel.getActive();

      // Catálogo general (primeros 10)
      data.catalogo = products
        .slice(0, 10)
        .map((p: any, i: number) => {
          const price = typeof p.price === 'number' ? ` - S/ ${p.price.toFixed(2)}` : '';
          return `${i + 1}. ${p.name}${price}`;
        })
        .join('\n');
    }

  } catch (error: unknown) {
    logger.error({ err: error }, '[AUTO-RESPONSE] Error loading dynamic data');
  }

  return data;
}

/**
 * Procesa TODAS las variables (básicas + dinámicas)
 */
async function processVariables(
  text: string,
  context?: {
    contact?: {
      name?: string | null;
      dni?: string | null;
      phoneNumber?: string;
      companyName?: string | null;
      ruc?: string | null;
    };
    company?: {
      razonSocial?: string | null;
      numeroDoc?: string | null;
      name?: string | null;
      ruc?: string | null;
    };
    product?: {
      name?: string;
      category?: string;
      price?: number | null;
    };
    customVars?: Record<string, string>;
  }
): Promise<string> {
  if (!text) return '';

  let result = text;

  // ==========================================
  // VARIABLES BÁSICAS (contacto, empresa, etc)
  // ==========================================
  
  if (context?.contact) {
    result = result.replace(/\{\{nombre\}\}/gi, context.contact.name || 'Cliente');
    result = result.replace(/\{\{dni\}\}/gi, context.contact.dni || 'No registrado');
    result = result.replace(/\{\{empresa\}\}/gi, context.contact.companyName || 'No registrada');
    result = result.replace(/\{\{companyName\}\}/gi, context.contact.companyName || 'No registrada');
    result = result.replace(/\{\{ruc\}\}/gi, context.contact.ruc || 'No registrado');
    result = result.replace(/\{\{telefono\}\}/gi, context.contact.phoneNumber || '');
    result = result.replace(/\{\{phone\}\}/gi, context.contact.phoneNumber || '');
  }

  if (context?.company) {
    result = result.replace(/\{\{empresa\}\}/gi, context.company.razonSocial || context.company.name || 'No registrada');
    result = result.replace(/\{\{companyName\}\}/gi, context.company.razonSocial || context.company.name || 'No registrada');
    result = result.replace(/\{\{ruc\}\}/gi, context.company.numeroDoc || context.company.ruc || 'No registrado');
  }

  if (context?.product) {
    result = result.replace(/\{\{producto\}\}/gi, context.product.name || '');
    result = result.replace(/\{\{categoria\}\}/gi, context.product.category || '');
    result = result.replace(/\{\{precio\}\}/gi, typeof context.product.price === 'number' ? `S/ ${context.product.price.toFixed(2)}` : 'Consultar');
  }

  // Fecha/hora (Lima)
  const now = new Date();
  const dateStr = now.toLocaleDateString('es-PE', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'America/Lima',
  } as Intl.DateTimeFormatOptions);
  const timeStr = now.toLocaleTimeString('es-PE', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'America/Lima',
  } as Intl.DateTimeFormatOptions);

  result = result.replace(/\{\{fecha\}\}/gi, dateStr);
  result = result.replace(/\{\{hora\}\}/gi, timeStr);

  // Variables personalizadas
  if (context?.customVars) {
    for (const [key, value] of Object.entries(context.customVars)) {
      const regex = new RegExp(`\\{\\{${key}\\}\\}`, 'gi');
      result = result.replace(regex, value);
    }
  }

  // ==========================================
  // VARIABLES DINÁMICAS (departamentos, horarios, productos)
  // ==========================================
  
  const required = detectRequiredData(result);
  
  if (required.needsDepartments || required.needsWorkingHours || required.needsProducts) {
    const dynamicData = await loadDynamicData(required);
    
    // Reemplazar todas las variables dinámicas
    for (const [key, value] of Object.entries(dynamicData)) {
      const regex = new RegExp(`\\{\\{${key}\\}\\}`, 'gi');
      result = result.replace(regex, String(value));
    }
  }

  return result;
}

// ==========================================
// FUNCIONES PÚBLICAS (CRUD)
// ==========================================

export async function getAll() {
  try {
    return await prisma.autoResponse.findMany({
      orderBy: [{ priority: 'asc' }, { createdAt: 'desc' }],
    });
  } catch (error: unknown) {
    logger.error({ err: error }, 'Error getting auto responses');
    return [];
  }
}

export async function getActive() {
  try {
    return await prisma.autoResponse.findMany({
      where: { isActive: true },
      orderBy: [{ priority: 'asc' }, { createdAt: 'desc' }],
    });
  } catch (error: unknown) {
    logger.error({ err: error }, 'Error getting active auto responses');
    return [];
  }
}

export async function findById(id: string) {
  try {
    return await prisma.autoResponse.findUnique({ where: { id } });
  } catch (error: unknown) {
    logger.error({ err: error, id }, 'Error finding auto response by id');
    return null;
  }
}

export async function create(input: AutoResponseInput) {
  try {
    return await prisma.autoResponse.create({
      data: {
        trigger: input.trigger.trim(),
        response: input.response,
        isActive: input.isActive !== false,
        priority: input.priority ?? 1,
        category: input.category ?? null,
      },
    });
  } catch (error: unknown) {
    logger.error({ err: error, input }, 'Error creating auto response');
    throw error;
  }
}

export async function update(id: string, input: Partial<AutoResponseInput>) {
  try {
    return await prisma.autoResponse.update({
      where: { id },
      data: {
        ...(input.trigger !== undefined ? { trigger: input.trigger.trim() } : {}),
        ...(input.response !== undefined ? { response: input.response } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
        ...(input.priority !== undefined ? { priority: input.priority } : {}),
        ...(input.category !== undefined ? { category: input.category } : {}),
      },
    });
  } catch (error: unknown) {
    logger.error({ err: error, id, input }, 'Error updating auto response');
    throw error;
  }
}

export async function remove(id: string) {
  try {
    await prisma.autoResponse.delete({ where: { id } });
    return true;
  } catch (error: unknown) {
    logger.error({ err: error, id }, 'Error deleting auto response');
    throw error;
  }
}

/**
 * Upsert por (trigger, category). Si ya existe ese trigger (y misma category si se da),
 * actualiza su respuesta/estado sin crear duplicados.
 */
export async function upsert(
  input: AutoResponseInput & { matchCategory?: boolean }
) {
  const where: any = input.matchCategory
    ? { trigger: input.trigger.trim(), category: input.category ?? null }
    : { trigger: input.trigger.trim() };

  const existing = await prisma.autoResponse.findFirst({ where });

  if (existing) {
    return prisma.autoResponse.update({
      where: { id: existing.id },
      data: {
        response: input.response,
        isActive: input.isActive !== false,
        priority: input.priority ?? existing.priority ?? 1,
        category: input.category ?? existing.category ?? null,
      },
    });
  }

  return prisma.autoResponse.create({
    data: {
      trigger: input.trigger.trim(),
      response: input.response,
      isActive: input.isActive !== false,
      priority: input.priority ?? 1,
      category: input.category ?? null,
    },
  });
}

export async function findByTrigger(message: string) {
  const text = (message || '').trim();
  if (!text) return null;

  try {
    const candidates = await prisma.autoResponse.findMany({
      where: { isActive: true },
      orderBy: [{ priority: 'asc' }, { createdAt: 'desc' }],
    });

    const lower = text.toLowerCase();
    const ordered = candidates.sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      return (b.trigger?.length || 0) - (a.trigger?.length || 0);
    });

    for (const r of ordered) {
      const raw = (r.trigger || '').trim();
      if (!raw) continue;

      // Soporte regex
      if (raw.startsWith('/') && raw.lastIndexOf('/') > 0) {
        const last = raw.lastIndexOf('/');
        const body = raw.slice(1, last);
        const flags = raw.slice(last + 1) || 'i';
        try {
          const re = new RegExp(body, flags.includes('i') ? flags : flags + 'i');
          if (re.test(text)) return r;
        } catch {
          // regex inválido, continuar
        }
      }

      const trig = raw.toLowerCase();

      if (lower === trig) return r;
      if (lower.includes(trig)) return r;

      if (trig.includes(',') || trig.includes(';') || trig.includes('|')) {
        const parts = trig.split(/[,;|]/).map(s => s.trim()).filter(Boolean);
        if (parts.some(p => lower.includes(p))) return r;
      }
    }

    return null;
  } catch (error: unknown) {
    logger.error({ err: error }, 'Error searching auto response by trigger');
    return null;
  }
}

/**
 * FUNCIÓN PRINCIPAL
 * Busca auto-respuesta y procesa TODAS las variables dinámicamente
 */
export async function findAndProcessResponse(
  message: string,
  context?: {
    contact?: {
      name?: string | null;
      dni?: string | null;
      phoneNumber?: string;
      companyName?: string | null;
      ruc?: string | null;
    };
    company?: {
      razonSocial?: string | null;
      numeroDoc?: string | null;
      name?: string | null;
      ruc?: string | null;
    };
    product?: {
      name?: string;
      category?: string;
      price?: number | null;
    };
    customVars?: Record<string, string>;
  }
): Promise<string | null> {
  try {
    const autoResponse = await findByTrigger(message);

    if (!autoResponse) {
      return null;
    }

    // Procesar variables (ahora con detección automática de dinámicas)
    const processedResponse = await processVariables(autoResponse.response, context);

    logger.info(`[AUTO-RESPONSE] Triggered: "${autoResponse.trigger}" with dynamic variables`);
    return processedResponse;
  } catch (error: unknown) {
    logger.error({ err: error, message }, 'Error finding and processing auto response');
    return null;
  }
}

/* ============================================================================
 * SEMILLAS DE RESPUESTAS AUTOMÁTICAS
 * ==========================================================================*/
/**
 * Crea (o actualiza) un set de respuestas comunes para
 * saludos, menú, gracias y casos urgentes.
 * 
 * Respeta tu pipeline de variables dinámicas y prioridad.
 */
export async function ensureDefaults() {
  try {
    const seeds: Array<AutoResponseInput> = [
      {
        category: 'general',
        trigger: 'hola,buenas,hi,hello',
        response:
          '👋 ¡Hola {{nombre}}! Soy tu asistente virtual.\n\n' +
          'Si quieres ver el *menú de opciones*, escribe *menu*.',
        priority: 1,
        isActive: true,
      },
      {
        category: 'general',
        trigger: 'buenos días',
        response:
          '🌅 ¡Buenos días {{nombre}}! ¿En qué te ayudo hoy?\n' +
          'Escribe *menu* para ver opciones.',
        priority: 1,
        isActive: true,
      },
      {
        category: 'general',
        trigger: 'buenas tardes',
        response:
          '☀️ ¡Buenas tardes {{nombre}}! ¿Necesitas soporte, tóner o asistencia remota?\n' +
          'Escribe *menu* para ver opciones.',
        priority: 1,
        isActive: true,
      },
      {
        category: 'general',
        trigger: 'buenas noches',
        response:
          '🌙 ¡Buenas noches {{nombre}}! Gracias por escribirnos.\n' +
          'Puedes dejar tu mensaje o escribir *menu* para ver opciones.',
        priority: 1,
        isActive: true,
      },
      {
        category: 'general',
        trigger: 'gracias, muchas gracias, gracias!',
        response:
          '😊 ¡Gracias a ti, {{nombre}}! Si necesitas algo más, escribe *menu* para continuar.',
        priority: 2,
        isActive: true,
      },
      {
        category: 'menu',
        trigger: 'menu',
        response:
          '📋 *Menú Principal*\n' +
          '1️⃣ Servicio técnico en sitio\n' +
          '2️⃣ Tóner / insumos\n' +
          '3️⃣ Asistencia remota\n' +
          '4️⃣ Cambiar empresa activa\n' +
          '5️⃣ Hablar con un técnico',
        priority: 0,
        isActive: true,
      },
      {
        category: 'alerta',
        trigger: 'urgente, emergencia, es urgente',
        response:
          '⚠️ Entendido {{nombre}}. Marcaré tu caso como *URGENTE* para priorizarlo.\n' +
          'Si puedes, describe brevemente el problema (modelo/serie y síntoma).',
        priority: 0,
        isActive: true,
      },
      {
        category: 'info',
        trigger: '/(horario|atienden|abren|cierran)/i',
        response:
          '🕒 Estado actual: {{esta_abierto}}\n' +
          'Horario de hoy: {{horario_hoy}}\n' +
          'Apertura: {{horario_apertura}} / Cierre: {{horario_cierre}}',
        priority: 2,
        isActive: true,
      },
      {
        category: 'info',
        trigger: '/(departamento|ventas|soporte|facturacion|alquiler)/i',
        response:
          '📋 *Departamentos*:\n{{departamentos}}',
        priority: 3,
        isActive: true,
      },
      {
        category: 'catalogo',
        trigger: '/(productos|catálogo|catalogo)/i',
        response:
          '🛒 *Catálogo* (top 10):\n{{catalogo}}',
        priority: 3,
        isActive: true,
      },
    ];

    for (const s of seeds) {
      await upsert({
        ...s,
        matchCategory: true, // evita choques entre triggers homónimos en distintas categorías
      });
    }

    logger.info('✅ Default autoResponses ensured');
  } catch (error) {
    logger.error({ err: error }, 'Error ensuring default autoResponses');
  }
}
