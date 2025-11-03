// src/models/apiKey.ts
import { getPrismaClient } from '../config/database.js';
const prisma = getPrismaClient();
import { logger } from '../utils/logger.js';
import crypto from 'node:crypto';

export interface ApiKey {
  id: string;
  name: string;
  key: string;
  description?: string | null;
  isActive: boolean;
  lastUsedAt?: Date | null;
  expiresAt?: Date | null;
  createdBy?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Genera una API key única
 */
function generateApiKey(): string {
  return `sk_${crypto.randomBytes(32).toString('hex')}`;
}

/**
 * Crea una nueva API key
 */
export async function create(
  name: string,
  description?: string,
  createdBy?: string,
  expiresAt?: Date
): Promise<ApiKey> {
  try {
    const key = generateApiKey();

    const apiKey = await prisma.apiKey.create({
      data: {
        name,
        key,
        description,
        createdBy,
        expiresAt,
      },
    });

    logger.info(`[API-KEY] Created new API key: ${name} (${apiKey.id})`);
    return apiKey as ApiKey;
  } catch (error: unknown) {
    logger.error({ err: error, name, createdBy }, '[API-KEY] Error creating API key');
    throw error;
  }
}

/**
 * Valida una API key
 * Retorna la info de la key si es válida, null si no es válida
 */
export async function validate(key: string): Promise<ApiKey | null> {
  try {
    const apiKey = await prisma.apiKey.findUnique({
      where: { key },
    });

    if (!apiKey) {
      const prefix = (key ?? '').slice(0, 10);
      logger.warn(`[API-KEY] Invalid key attempt: ${prefix}...`);
      return null;
    }

    if (!apiKey.isActive) {
      logger.warn(`[API-KEY] Inactive key used: ${apiKey.name}`);
      return null;
    }

    // Verificar expiración
    if (apiKey.expiresAt && apiKey.expiresAt < new Date()) {
      logger.warn(`[API-KEY] Expired key used: ${apiKey.name}`);
      return null;
    }

    // Actualizar última vez usada (sin await; logea si falla)
    prisma.apiKey
      .update({
        where: { id: apiKey.id },
        data: { lastUsedAt: new Date() },
      })
      .catch((err: unknown) => {
        logger.error({ err, id: apiKey.id }, '[API-KEY] Error updating lastUsedAt');
      });

    logger.debug(`[API-KEY] Valid key used: ${apiKey.name}`);
    return apiKey as ApiKey;
  } catch (error: unknown) {
    logger.error({ err: error }, '[API-KEY] Error validating key');
    return null;
  }
}

/**
 * Lista todas las API keys (sin mostrar la key completa)
 */
export async function list(): Promise<ApiKey[]> {
  try {
    const keys = await prisma.apiKey.findMany({
      orderBy: { createdAt: 'desc' },
    });

    return keys as ApiKey[];
  } catch (error: unknown) {
    logger.error({ err: error }, '[API-KEY] Error listing keys');
    throw error;
  }
}

/**
 * Obtiene una API key por ID
 */
export async function findById(id: string): Promise<ApiKey | null> {
  try {
    const item = await prisma.apiKey.findUnique({
      where: { id },
    });
    return (item as ApiKey) ?? null;
  } catch (error: unknown) {
    logger.error({ err: error, id }, '[API-KEY] Error finding key');
    return null;
  }
}

/**
 * Desactiva una API key
 */
export async function deactivate(id: string): Promise<boolean> {
  try {
    await prisma.apiKey.update({
      where: { id },
      data: { isActive: false },
    });

    logger.info(`[API-KEY] Deactivated key: ${id}`);
    return true;
  } catch (error: unknown) {
    logger.error({ err: error, id }, '[API-KEY] Error deactivating key');
    return false;
  }
}

/**
 * Activa una API key
 */
export async function activate(id: string): Promise<boolean> {
  try {
    await prisma.apiKey.update({
      where: { id },
      data: { isActive: true },
    });

    logger.info(`[API-KEY] Activated key: ${id}`);
    return true;
  } catch (error: unknown) {
    logger.error({ err: error, id }, '[API-KEY] Error activating key');
    return false;
  }
}

/**
 * Elimina una API key permanentemente
 */
export async function remove(id: string): Promise<boolean> {
  try {
    await prisma.apiKey.delete({
      where: { id },
    });

    logger.info(`[API-KEY] Deleted key: ${id}`);
    return true;
  } catch (error: unknown) {
    logger.error({ err: error, id }, '[API-KEY] Error deleting key');
    return false;
  }
}

/**
 * Actualiza una API key
 */
export async function update(
  id: string,
  data: {
    name?: string;
    description?: string;
    expiresAt?: Date | null;
  }
): Promise<ApiKey | null> {
  try {
    const updated = await prisma.apiKey.update({
      where: { id },
      data,
    });

    logger.info(`[API-KEY] Updated key: ${id}`);
    return (updated as ApiKey) ?? null;
  } catch (error: unknown) {
    logger.error({ err: error, id, data }, '[API-KEY] Error updating key');
    return null;
  }
}

/**
 * Cuenta las API keys activas
 */
export async function countActive(): Promise<number> {
  try {
    return await prisma.apiKey.count({
      where: { isActive: true },
    });
  } catch (error: unknown) {
    logger.error({ err: error }, '[API-KEY] Error counting active keys');
    return 0;
  }
}
