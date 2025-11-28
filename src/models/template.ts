// src/models/template.ts
import { getPrismaClient } from '../config/database.js';
import { logger } from '../utils/logger.js';
import type { MessageTemplate } from '@prisma/client';

const prisma = getPrismaClient();

/* ==================== HELPERS ==================== */
function serializeVars(vars?: string[] | null): string | null {
  if (!vars) return null;
  try { return JSON.stringify(vars); } catch { return null; }
}

/* ==================== QUERIES ==================== */
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

/* ==================== MUTATIONS ==================== */
type CreateTemplateInput = Pick<MessageTemplate, 'name' | 'content' | 'category'> &
  Partial<Pick<MessageTemplate, 'variables' | 'isActive'>>;

type UpdateTemplateInput = Partial<
  Pick<MessageTemplate, 'name' | 'content' | 'category' | 'variables' | 'isActive'>
>;

export async function create(data: CreateTemplateInput): Promise<MessageTemplate> {
  try {
    return await prisma.messageTemplate.create({
      data: {
        ...data,
        variables: data.variables ?? null,
        isActive: data.isActive !== false,
      },
    });
  } catch (error) {
    logger.error({ err: error }, 'Error creating template:');
    throw error;
  }
}

export async function update(id: string, data: UpdateTemplateInput): Promise<MessageTemplate> {
  try {
    return await prisma.messageTemplate.update({
      where: { id },
      data,
    });
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

/**
 * Upsert seguro por `name` (tu schema define name @unique global).
 * Si ya existe `name`, actualiza el registro (sin importar categoría previa).
 * Esto evita colisiones sutiles y mantiene coherencia con servicios que
 * buscan por nombre conocido (p.ej. *_DEFAULT, after_hours, etc.).
 */
export async function upsert(
  category: string,
  name: string,
  content: string,
  options?: { variables?: string[]; isActive?: boolean }
): Promise<MessageTemplate> {
  const vars = serializeVars(options?.variables);
  return prisma.$transaction(
    async (tx) => {
      const updated = await tx.messageTemplate.updateMany({
        where: { name },
        data: {
          content,
          category,
          isActive: options?.isActive ?? true,
          ...(vars !== null ? { variables: vars } : {}),
        },
      });
      if (updated.count > 0) {
        return tx.messageTemplate.findFirstOrThrow({ where: { name } });
      }
      return tx.messageTemplate.create({
        data: {
          category,
          name,
          content,
          isActive: options?.isActive ?? true,
          variables: vars,
        },
      });
    },
    { isolationLevel: 'Serializable' }
  );
}

/* ==================== RENDER / UTILS ==================== */
/**
 * Render soporta {{key}} y {{key|fallback}}.
 * Para prevenir reemplazos parciales, hace una primera pasada de fallbacks
 * y luego sustituye claves exactas. No modifica placeholders desconocidos.
 */
export function render(content: string, variables: Record<string, string>): string {
  let result = content || '';

  // Primero, llaves con fallback: {{ key | fallback }}
  result = result.replace(/{{\s*([a-zA-Z0-9_]+)\s*\|\s*([^}]+)\s*}}/g, (_, key, fallback) => {
    const val = variables?.[key];
    const s = (val ?? '').toString().trim();
    return s.length ? s : String(fallback);
  });

  // Luego, llaves simples: {{ key }}
  // (usamos RegExp escapando el key para evitar efectos colaterales)
  for (const [key, value] of Object.entries(variables || {})) {
    const esc = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`{{\\s*${esc}\\s*}}`, 'g');
    result = result.replace(re, (value ?? '').toString());
  }

  return result;
}

export function extractVariables(content: string): string[] {
  const regex = /{{\s*([a-zA-Z0-9_]+)(?:\|[^}]*)?\s*}}/g;
  const vars: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = regex.exec(content || '')) !== null) {
    const key = m[1];
    if (!vars.includes(key)) vars.push(key);
  }
  return vars;
}

export function preview(content: string, sample: Record<string, string>): string {
  return render(content, sample);
}

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

/* ==================== SEED DEFAULTS (idempotente) ==================== */
/**
 * NOTA IMPORTANTE:
 * - Usamos sufijo __DEFAULT para no colisionar con nombres “canónicos” como
 *   'after_hours', 'break', 'holiday' que puede consumir systemVarModel.
 * - Como `name` es único global, estos seeds no pisan tus plantillas
 *   personalizadas si eliges otros nombres.
 */
export async function ensureDefaults() {
  try {
    const templates: Array<{
      category: string;
      name: string; // debe ser único global
      content: string;
      variables?: string[];
    }> = [
      // Menú principal por defecto (SOLO opciones, sin saludo largo)
      {
        category: 'menu',
        name: 'MAIN_MENU__DEFAULT',
        content: [
          '1️⃣ Servicio técnico en sitio',
          '2️⃣ Tóner / Insumos',
          '3️⃣ Asistencia remota',
          '4️⃣ Cambiar empresa activa',
          '5️⃣ Hablar con un técnico',
        ].join('\n'),
      },
      // Hint corto para Gemini y respuestas (se pega al final)
      {
        category: 'templates',
        name: 'menu_hint',
        content: 'Si quieres ver el *menú de opciones*, escribe *menu*.',
      },
      {
        category: 'templates',
        name: 'OUT_OF_HOURS__DEFAULT',
        content: [
          '⏰ En este momento estamos *fuera de horario*.',
          '{{schedule_context}}',
          '',
          'Si tu caso es *URGENTE* podemos tomar nota, pero la atención humana se realizará en horario laboral.',
        ].join('\n'),
        variables: ['schedule_context'],
      },
      {
        category: 'templates',
        name: 'ESCALATE_HUMAN__DEFAULT',
        content: [
          '⚠ Entendido. Voy a derivar tu caso a soporte humano.',
          'Por favor cuéntame brevemente el problema para priorizarlo 🙏.',
          '',
          '☎ {{company_phone}}',
        ].join('\n'),
        variables: ['company_phone'],
      },
      {
        category: 'LINK',
        name: 'LINK_SERVICE__DEFAULT',
        content: [
          '🧾 He generado tu {{policy_link_label}} para registrar servicio técnico:',
          '{{link}}',
          '',
          'Equipos vinculados: {{equipmentCount}}',
          'Si corresponde: {{equipmentBrand}} {{equipmentModel}} (SN: {{equipmentSerial}})',
        ].join('\n'),
        variables: ['policy_link_label', 'link', 'equipmentCount', 'equipmentBrand', 'equipmentModel', 'equipmentSerial'],
      },
      {
        category: 'LINK',
        name: 'LINK_REMOTE__DEFAULT',
        content: [
          '🖥️ Para soporte remoto usa *{{policy_remote_tool_name}}*:',
          '👉 {{link}}',
          '',
          'Un técnico humano se conectará en el horario de atención.',
        ].join('\n'),
        variables: ['policy_remote_tool_name', 'link'],
      },
      {
        category: 'LINK',
        name: 'LINK_TONER__DEFAULT',
        content: [
          '🛒 Solicitud de tóner/insumos registrada:',
          '👉 {{link}}',
          '',
          'Equipos vinculados: {{equipmentCount}}',
          'Si corresponde: {{equipmentBrand}} {{equipmentModel}} (SN: {{equipmentSerial}})',
        ].join('\n'),
        variables: ['link', 'equipmentCount', 'equipmentBrand', 'equipmentModel', 'equipmentSerial'],
      },
      {
        category: 'templates',
        name: 'REGISTRATION_PENDING__DEFAULT',
        content: 'Estoy validando tus datos, {{nombre}}. Ya casi terminamos el registro 👍.',
        variables: ['nombre'],
      },
      {
        category: 'INTENT',
        name: 'INTENT_REMOTE_GUIDE__DEFAULT',
        content: [
          'Para *asistencia remota* usaremos {{policy_remote_tool_name}}.',
          'Si ya tienes tu ID, compártelo (9 dígitos).',
          'Si no, ingresa al enlace y sigue las instrucciones.',
          'Si tienes capturas de pantalla del error, envíalas 📷.',
        ].join('\n'),
        variables: ['policy_remote_tool_name'],
      },
      {
        category: 'INTENT',
        name: 'INTENT_SERVICE_GUIDE__DEFAULT',
        content: [
          'Parece un *caso de servicio técnico*.',
          '¿Puedes detallar el problema (mensaje de error, atasco, modelo/serie)?',
          'Te generaré un enlace para registrar el ticket.',
        ].join('\n'),
      },
      {
        category: 'INTENT',
        name: 'INTENT_TONER_GUIDE__DEFAULT',
        content: [
          'Perfecto, para *tóner/insumos* necesito *modelo o serie* y *color*.',
          'Con eso genero el {{policy_link_label}}.',
        ].join('\n'),
        variables: ['policy_link_label'],
      },
    ];

    await prisma.$transaction(async (tx) => {
      for (const t of templates) {
        const vars = serializeVars(t.variables);
        const updated = await tx.messageTemplate.updateMany({
          where: { name: t.name }, // name es único global
          data: {
            category: t.category,
            content: t.content,
            isActive: true,
            ...(vars !== null ? { variables: vars } : {}),
          },
        });
        if (updated.count === 0) {
          await tx.messageTemplate.create({
            data: {
              category: t.category,
              name: t.name,
              content: t.content,
              isActive: true,
              variables: vars,
            },
          });
        }
      }
    });

    logger.info('✅ Template defaults ensured');
  } catch (error) {
    logger.error({ err: error }, 'Error ensuring default templates:');
  }
}
