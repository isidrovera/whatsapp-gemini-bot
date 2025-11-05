// src/models/template.ts
import { getPrismaClient } from '../config/database.js';
import { logger } from '../utils/logger.js';
import type { Prisma, MessageTemplate } from '@prisma/client';

const prisma = getPrismaClient();

/* ============================================================================
 * CONSULTAS BÁSICAS
 * ==========================================================================*/
export async function getAll(): Promise<MessageTemplate[]> {
  try {
    return await prisma.messageTemplate.findMany({
      orderBy: [{ category: 'asc' }, { name: 'asc' }],
    });
  } catch (error) {
    logger.error({ err: error }, 'Error getting templates:');
    return [];
  }
}

export async function getActive(): Promise<MessageTemplate[]> {
  try {
    return await prisma.messageTemplate.findMany({
      where: { isActive: true },
      orderBy: [{ category: 'asc' }, { name: 'asc' }],
    });
  } catch (error) {
    logger.error({ err: error }, 'Error getting active templates:');
    return [];
  }
}

export async function getByCategory(category: string): Promise<MessageTemplate[]> {
  try {
    return await prisma.messageTemplate.findMany({
      where: { category, isActive: true },
      orderBy: { name: 'asc' },
    });
  } catch (error) {
    logger.error({ err: error }, 'Error getting templates by category:');
    return [];
  }
}

export async function getByCategoryAndName(
  category: string,
  name: string
): Promise<MessageTemplate | null> {
  try {
    return await prisma.messageTemplate.findFirst({
      where: { category, name, isActive: true },
    });
  } catch (error) {
    logger.error({ err: error }, 'Error getting template by category & name:');
    return null;
  }
}

export async function findById(id: string): Promise<MessageTemplate | null> {
  try {
    return await prisma.messageTemplate.findUnique({ where: { id } });
  } catch (error) {
    logger.error({ err: error }, 'Error finding template:');
    return null;
  }
}

/* ============================================================================
 * MUTACIONES
 * ==========================================================================*/
type CreateTemplateInput =
  Pick<MessageTemplate, 'name' | 'content' | 'category'> &
  Partial<Pick<MessageTemplate, 'variables' | 'isActive'>>;

type UpdateTemplateInput = Partial<
  Pick<MessageTemplate, 'name' | 'content' | 'category' | 'variables' | 'isActive'>
>;

export async function create(data: CreateTemplateInput): Promise<MessageTemplate> {
  try {
    return await prisma.messageTemplate.create({ data });
  } catch (error) {
    logger.error({ err: error }, 'Error creating template:');
    throw error;
  }
}

export async function update(id: string, data: UpdateTemplateInput): Promise<MessageTemplate> {
  try {
    return await prisma.messageTemplate.update({ where: { id }, data });
  } catch (error) {
    logger.error({ err: error }, 'Error updating template:');
    throw error;
  }
}

export async function remove(id: string): Promise<MessageTemplate> {
  try {
    return await prisma.messageTemplate.delete({ where: { id } });
  } catch (error) {
    logger.error({ err: error }, 'Error deleting template:');
    throw error;
  }
}

/** Upsert por (category, name) — útil para seeds/config sin duplicar. */
export async function upsert(
  category: string,
  name: string,
  content: string,
  options?: { variables?: string[]; isActive?: boolean }
): Promise<MessageTemplate> {
  try {
    const existing = await prisma.messageTemplate.findFirst({ where: { category, name } });
    if (existing) {
      return await prisma.messageTemplate.update({
        where: { id: existing.id },
        data: {
          content,
          isActive: options?.isActive ?? true,
          variables: options?.variables ? JSON.stringify(options.variables) : existing.variables,
        },
      });
    }
    return await prisma.messageTemplate.create({
      data: {
        category,
        name,
        content,
        isActive: options?.isActive ?? true,
        variables: options?.variables ? JSON.stringify(options.variables) : null,
      },
    });
  } catch (error) {
    logger.error({ err: error, category, name }, 'Error upserting template:');
    throw error;
  }
}

/* ============================================================================
 * RENDER / UTILIDADES
 * ==========================================================================*/
/** Renderiza reemplazando {{clave}} por su valor (case-sensitive en clave). */
export function render(content: string, variables: Record<string, string>): string {
  let result = content || '';
  for (const [key, value] of Object.entries(variables || {})) {
    const regex = new RegExp(`{{${key}}}`, 'g');
    result = result.replace(regex, value ?? '');
  }
  return result;
}

/** Extrae variables: "Hola {{nombre}}, tu RUC es {{ruc}}" -> ['nombre','ruc'] */
export function extractVariables(content: string): string[] {
  const regex = /{{(\w+)}}/g;
  const vars: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = regex.exec(content || '')) !== null) {
    const key = m[1];
    if (!vars.includes(key)) vars.push(key);
  }
  return vars;
}

/** Vista previa rápida con variables (ignorando faltantes). */
export function preview(content: string, sample: Record<string, string>): string {
  return render(content, sample);
}

/** Listado de categorías distintas (para UI). */
export async function listCategories(): Promise<string[]> {
  try {
    const rows = await prisma.messageTemplate.findMany({
      select: { category: true },
      distinct: ['category'],
      orderBy: { category: 'asc' },
    });
    return rows.map((r) => r.category);
  } catch (error) {
    logger.error({ err: error }, 'Error listing categories:');
    return [];
  }
}

/* ============================================================================
 * SEED SUGERIDO DE PLANTILLAS
 * ==========================================================================*/
/**
 * ensureDefaults(): crea/actualiza un conjunto de plantillas recomendadas
 * para tu flujo (menú, fuera de horario, guías de intent, links, despedida).
 *
 * Llama a esta función desde un script de bootstrap o desde tu init.
 */
export async function ensureDefaults() {
  try {
    const templates: Array<{
      category: string;
      name: string;
      content: string;
      variables?: string[];
    }> = [
      // ===== Menú principal (dinámico) =====
      {
        category: 'menu',
        name: 'main_menu',
        content:
          '👋 Hola {{customer_name}}{{company_suffix}}\n\n' +
          'Por favor elige una opción:\n' +
          '1️⃣ *Servicio técnico en sitio*\n' +
          '2️⃣ *Tóner / suministros*\n' +
          '3️⃣ *Asistencia remota* ({{policy_remote_tool_name}})\n' +
          '4️⃣ *Cambiar empresa activa*\n' +
          '5️⃣ *Hablar con un técnico*\n',
        variables: ['customer_name', 'company_suffix', 'policy_remote_tool_name'],
      },

      // ===== Avisos fuera de horario / feriados / break (ya los tienes también en configuration) =====
      {
        category: 'templates',
        name: 'after_hours',
        content:
          '⏰ {{reason}}.\n🕒 Hoy: {{open}}–{{close}}{{break_hint}}\n{{next_open_line}}\n\n' +
          'Si tu caso es *URGENTE*, responde *URGENTE* y te derivamos a soporte.',
        variables: ['reason', 'open', 'close', 'break_hint', 'next_open_line'],
      },
      {
        category: 'templates',
        name: 'holiday',
        content:
          '⛱️ Hoy es {{event_type}}: {{event_title}}. Por ello, no tenemos atención hoy.\n{{next_open_line}}',
        variables: ['event_type', 'event_title', 'next_open_line'],
      },
      {
        category: 'templates',
        name: 'break',
        content:
          '⏰ Estamos en horario de refrigerio ({{break_start}}–{{break_end}}). Retomamos a las {{break_end}}.\n{{next_open_line}}',
        variables: ['break_start', 'break_end', 'next_open_line'],
      },

      // ===== Guías por intención (usadas por gemini.ts para enriquecer) =====
      {
        category: 'INTENT',
        name: 'INTENT_SERVICE_GUIDE',
        content:
          'Guía: El usuario reporta una falla física. Pide detalles claros (modelo/serie, síntomas, códigos en pantalla). Ofrece registrar servicio técnico y menciona tiempos aproximados sin prometer hora exacta.',
      },
      {
        category: 'INTENT',
        name: 'INTENT_TONER_GUIDE',
        content:
          'Guía: El usuario solicita tóner/insumos. Pide *modelo o serie* y *color*. Si hay foto de etiqueta, úsala. Ofrece generar pedido con el enlace del sistema.',
      },
      {
        category: 'INTENT',
        name: 'INTENT_REMOTE_GUIDE',
        content:
          'Guía: El usuario requiere asistencia remota. Pide el *ID de {{policy_remote_tool_name}} (9 dígitos)* si no lo ha dado. No repitas la solicitud si ya lo entregó.',
        variables: ['policy_remote_tool_name'],
      },

      // ===== Mensajes con LINK (se anexan al final si corresponde) =====
      {
        category: 'LINK',
        name: 'LINK_SERVICE',
        content:
          '🛠️ Para avanzar, completa este formulario: {{link}}\n' +
          '{{equipmentCount|0}} equipo(s) registrados{{equipment_tail}}',
        // Nota: variables con sufijo opcional lo puedes pre-renderizar antes de llamar a render()
      },
      {
        category: 'LINK',
        name: 'LINK_TONER',
        content:
          '🖨️ Pedido de tóner / insumos aquí: {{link}}\n' +
          'Incluye *modelo/serie* y *color* en el formulario.',
      },
      {
        category: 'LINK',
        name: 'LINK_REMOTE',
        content:
          '💻 Conexión remota: {{link}}\n' +
          'Comparte tu ID de {{policy_remote_tool_name}} si aún no lo enviaste.',
        variables: ['link', 'policy_remote_tool_name'],
      },

      // ===== Escalada a humano =====
      {
        category: 'templates',
        name: 'ESCALATE_HUMAN',
        content:
          '⚠ Entendido. Derivaré tu caso a soporte humano ahora mismo. Un técnico te responderá en breve.\n' +
          'Si necesitas contactarnos por teléfono: {{company_phone}}',
        variables: ['company_phone'],
      },

      // ===== Estado de registro pendiente (cuando aún está en NEW/WAITING_*) =====
      {
        category: 'templates',
        name: 'REGISTRATION_PENDING',
        content:
          'Estoy validando tus datos, {{nombre}}. Ya casi terminamos el registro 👍.',
        variables: ['nombre'],
      },

      // ===== Despedida / “hint de menú” =====
      {
        category: 'templates',
        name: 'farewell',
        content:
          'Gracias por escribirnos. Si quieres ver el *menú de opciones*, escribe *menu*.',
      },
    ];

    for (const t of templates) {
      await upsert(t.category, t.name, t.content, {
        variables: t.variables,
        isActive: true,
      });
    }

    logger.info('✅ Template defaults ensured');
  } catch (error) {
    logger.error({ err: error }, 'Error ensuring default templates:');
  }
}
