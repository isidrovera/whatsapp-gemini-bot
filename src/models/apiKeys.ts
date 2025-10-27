// src/models/apiKey.ts
import { getPrismaClient } from '../config/database.js';
const prisma = getPrismaClient();
import { logger } from '../utils/logger';
import crypto from 'crypto';

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
    return apiKey;
  } catch (error) {
    logger.error('[API-KEY] Error creating API key:', error);
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
      logger.warn(`[API-KEY] Invalid key attempt: ${key.substring(0, 10)}...`);
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

    // Actualizar última vez usada (sin esperar)
    prisma.apiKey.update({
      where: { id: apiKey.id },
      data: { lastUsedAt: new Date() },
    }).catch(err => {
      logger.error('[API-KEY] Error updating lastUsedAt:', err);
    });

    logger.debug(`[API-KEY] Valid key used: ${apiKey.name}`);
    return apiKey;
  } catch (error) {
    logger.error('[API-KEY] Error validating key:', error);
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

    return keys;
  } catch (error) {
    logger.error('[API-KEY] Error listing keys:', error);
    throw error;
  }
}

/**
 * Obtiene una API key por ID
 */
export async function findById(id: string): Promise<ApiKey | null> {
  try {
    return await prisma.apiKey.findUnique({
      where: { id },
    });
  } catch (error) {
    logger.error('[API-KEY] Error finding key:', error);
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
  } catch (error) {
    logger.error('[API-KEY] Error deactivating key:', error);
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
  } catch (error) {
    logger.error('[API-KEY] Error activating key:', error);
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
  } catch (error) {
    logger.error('[API-KEY] Error deleting key:', error);
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
    return updated;
  } catch (error) {
    logger.error('[API-KEY] Error updating key:', error);
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
  } catch (error) {
    logger.error('[API-KEY] Error counting active keys:', error);
    return 0;
  }
}
