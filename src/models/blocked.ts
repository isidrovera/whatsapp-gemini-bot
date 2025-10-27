import { getPrismaClient } from '../config/database.js';
import { logger } from '../utils/logger.js';

const prisma = getPrismaClient();

export async function isBlocked(identifier: string): Promise<boolean> {
  try {
    const blocked = await prisma.blockedNumber.findUnique({
      where: { identifier },
    });
    return !!blocked;
  } catch (error) {
    logger.error('Error checking if blocked:', error);
    return false;
  }
}

export async function block(identifier: string, type: 'PHONE' | 'GROUP', reason?: string) {
  try {
    return await prisma.blockedNumber.create({
      data: {
        identifier,
        type,
        reason: reason || 'Bloqueado manualmente',
      },
    });
  } catch (error) {
    logger.error('Error blocking number:', error);
    throw error;
  }
}

export async function unblock(identifier: string) {
  try {
    return await prisma.blockedNumber.delete({
      where: { identifier },
    });
  } catch (error) {
    logger.error('Error unblocking number:', error);
    throw error;
  }
}

export async function getAll() {
  try {
    return await prisma.blockedNumber.findMany({
      orderBy: { blockedAt: 'desc' },
    });
  } catch (error) {
    logger.error('Error getting blocked numbers:', error);
    return [];
  }
}

export async function getAllByType(type: 'PHONE' | 'GROUP') {
  try {
    return await prisma.blockedNumber.findMany({
      where: { type },
      orderBy: { blockedAt: 'desc' },
    });
  } catch (error) {
    logger.error('Error getting blocked numbers by type:', error);
    return [];
  }
}

// Nueva función para importación masiva
export async function blockMultiple(entries: Array<{
  identifier: string;
  type: 'PHONE' | 'GROUP';
  reason?: string;
}>) {
  try {
    const results = {
      success: 0,
      failed: 0,
      errors: [] as string[],
      duplicates: [] as string[]
    };

    for (const entry of entries) {
      try {
        // Verificar si ya está bloqueado
        const existing = await isBlocked(entry.identifier);
        if (existing) {
          results.duplicates.push(entry.identifier);
          results.failed++;
          continue;
        }

        await prisma.blockedNumber.create({
          data: {
            identifier: entry.identifier,
            type: entry.type,
            reason: entry.reason || 'Importado desde Excel',
          },
        });
        results.success++;
        
        logger.info(`Blocked successfully: ${entry.identifier}`);
      } catch (error: any) {
        results.failed++;
        const errorMsg = `${entry.identifier}: ${error.message}`;
        results.errors.push(errorMsg);
        logger.error(`Error blocking ${entry.identifier}:`, error);
      }
    }

    return results;
  } catch (error) {
    logger.error('Error in bulk block:', error);
    throw error;
  }
}

// Nueva función para exportar todos los bloqueados
export async function exportAll() {
  try {
    const blocked = await prisma.blockedNumber.findMany({
      orderBy: { blockedAt: 'desc' },
      select: {
        identifier: true,
        type: true,
        reason: true,
        blockedAt: true,
      }
    });
    return blocked;
  } catch (error) {
    logger.error('Error exporting blocked numbers:', error);
    throw error;
  }
}