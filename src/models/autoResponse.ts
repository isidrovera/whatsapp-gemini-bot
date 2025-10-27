// src/models/autoResponse.ts
import { getPrismaClient } from '../config/database.js';
import { logger } from '../utils/logger.js';

const prisma = getPrismaClient();

export type AutoResponseInput = {
  trigger: string;        // palabra, frase o patrón simple
  response: string;       // texto (puede incluir variables si luego las procesas)
  isActive?: boolean;     // por defecto true
  priority?: number;      // menor = más prioridad (1 > 2)
  category?: string | null;
};

export async function getAll() {
  try {
    return await prisma.autoResponse.findMany({
      orderBy: [{ priority: 'asc' }, { createdAt: 'desc' }],
    });
  } catch (error) {
    logger.error('Error getting auto responses:', error);
    return [];
  }
}

export async function getActive() {
  try {
    return await prisma.autoResponse.findMany({
      where: { isActive: true },
      orderBy: [{ priority: 'asc' }, { createdAt: 'desc' }],
    });
  } catch (error) {
    logger.error('Error getting active auto responses:', error);
    return [];
  }
}

export async function findById(id: string) {
  try {
    return await prisma.autoResponse.findUnique({ where: { id } });
  } catch (error) {
    logger.error('Error finding auto response by id:', error);
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
  } catch (error) {
    logger.error('Error creating auto response:', error);
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
  } catch (error) {
    logger.error('Error updating auto response:', error);
    throw error;
  }
}

export async function remove(id: string) {
  try {
    await prisma.autoResponse.delete({ where: { id } });
    return true;
  } catch (error) {
    logger.error('Error deleting auto response:', error);
    throw error;
  }
}

/**
 * Busca la MEJOR coincidencia para un mensaje dado:
 * - Solo respuestas activas
 * - Orden: priority ASC, luego trigger más largo (más específico)
 * - Coincidencia case-insensitive: igualdad exacta o "incluye"
 * - Si el trigger empieza y termina con /.../ se interpreta como RegExp simple
 */
export async function findByTrigger(message: string) {
  const text = (message || '').trim();
  if (!text) return null;

  try {
    const candidates = await prisma.autoResponse.findMany({
      where: { isActive: true },
      orderBy: [{ priority: 'asc' }, { createdAt: 'desc' }],
    });

    const lower = text.toLowerCase();

    // ordenar por prioridad y especificidad del trigger (más largo primero)
    const ordered = candidates.sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      return (b.trigger?.length || 0) - (a.trigger?.length || 0);
    });

    for (const r of ordered) {
      const raw = (r.trigger || '').trim();
      if (!raw) continue;

      // Soporte para patrón /regex/i
      if (raw.startsWith('/') && raw.lastIndexOf('/') > 0) {
        const last = raw.lastIndexOf('/');
        const body = raw.slice(1, last);
        const flags = raw.slice(last + 1) || 'i';
        try {
          const re = new RegExp(body, flags.includes('i') ? flags : flags + 'i');
          if (re.test(text)) return r;
        } catch {
          // si el regex es inválido, seguimos como texto normal
        }
      }

      const trig = raw.toLowerCase();

      // Igualdad exacta
      if (lower === trig) return r;

      // "Incluye" (palabra/frase)
      if (lower.includes(trig)) return r;

      // Lista separada por comas | punto y coma
      if (trig.includes(',') || trig.includes(';') || trig.includes('|')) {
        const parts = trig.split(/[,;|]/).map(s => s.trim()).filter(Boolean);
        if (parts.some(p => lower.includes(p))) return r;
      }
    }

    return null;
  } catch (error) {
    logger.error('Error searching auto response by trigger:', error);
    return null;
  }
}
