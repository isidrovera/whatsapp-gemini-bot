// src/models/blocked.ts
import { getPrismaClient } from '../config/database.js';
import { logger } from '../utils/logger.js';

const prisma = getPrismaClient();

export type AccessLevel = 'BLOCKED' | 'RESTRICTED' | 'LIMITED' | 'STANDARD' | 'FULL' | 'VIP';
export type BlockType = 'PHONE' | 'GROUP';

export type Permission =
  | 'odoo'
  | 'tickets'
  | 'history'
  | 'human'
  | 'ai'
  | 'autoresponse';

// Campos de permisos personalizados en el modelo Prisma (booleans opcionales)
type PermissionField =
  | 'canUseOdoo'
  | 'canCreateTickets'
  | 'canSeeHistory'
  | 'canTalkToHuman'
  | 'canUseAI'
  | 'canUseAutoResponse';

// Permisos por nivel de acceso
const ACCESS_PERMISSIONS: Record<AccessLevel, Partial<Record<Permission, boolean>>> = {
  BLOCKED: { odoo: false, tickets: false, history: false, human: false, ai: false, autoresponse: false },
  RESTRICTED: { odoo: false, tickets: false, history: false, human: false, ai: false, autoresponse: true },
  LIMITED: { odoo: false, tickets: false, history: false, human: true, ai: true, autoresponse: true },
  STANDARD: { odoo: true, tickets: true, history: false, human: true, ai: true, autoresponse: true },
  FULL: { odoo: true, tickets: true, history: true, human: true, ai: true, autoresponse: true },
  VIP: { odoo: true, tickets: true, history: true, human: true, ai: true, autoresponse: true },
};

/**
 * Verifica si un identificador está bloqueado completamente
 */
export async function isBlocked(identifier: string): Promise<boolean> {
  try {
    const blocked = await prisma.blockedNumber.findUnique({ where: { identifier } });
    return blocked?.accessLevel === 'BLOCKED';
  } catch (error: unknown) {
    logger.error({ err: error, identifier }, 'Error checking if blocked');
    return false;
  }
}

/**
 * Verifica si un identificador tiene un permiso específico
 */
export async function hasPermission(identifier: string, permission: Permission): Promise<boolean> {
  try {
    const record = await prisma.blockedNumber.findUnique({ where: { identifier } });

    // Si no está en la tabla, tiene acceso completo
    if (!record) return true;

    // Si está bloqueado completamente
    if (record.accessLevel === 'BLOCKED') return false;

    // Verificar permisos personalizados primero
    const permissionMap: Record<Permission, PermissionField> = {
      odoo: 'canUseOdoo',
      tickets: 'canCreateTickets',
      history: 'canSeeHistory',
      human: 'canTalkToHuman',
      ai: 'canUseAI',
      autoresponse: 'canUseAutoResponse',
    };

    const field = permissionMap[permission];
    const custom = (record as any)[field] as boolean | null | undefined;

    if (custom !== null && custom !== undefined) {
      return !!custom;
    }

    // Si no hay permiso custom, usar el del nivel de acceso
    const levelPerms = ACCESS_PERMISSIONS[record.accessLevel as AccessLevel];
    return levelPerms[permission] ?? true;
  } catch (error: unknown) {
    logger.error({ err: error, identifier, permission }, 'Error checking permission');
    return false;
  }
}

/**
 * Obtiene todos los permisos de un identificador
 */
export async function getPermissions(identifier: string) {
  try {
    const record = await prisma.blockedNumber.findUnique({ where: { identifier } });

    if (!record) {
      return {
        accessLevel: 'FULL' as AccessLevel,
        permissions: ACCESS_PERMISSIONS.FULL,
        isBlocked: false,
      };
    }

    const level = record.accessLevel as AccessLevel;

    return {
      accessLevel: level,
      permissions: {
        odoo: record.canUseOdoo ?? ACCESS_PERMISSIONS[level].odoo,
        tickets: record.canCreateTickets ?? ACCESS_PERMISSIONS[level].tickets,
        history: record.canSeeHistory ?? ACCESS_PERMISSIONS[level].history,
        human: record.canTalkToHuman ?? ACCESS_PERMISSIONS[level].human,
        ai: record.canUseAI ?? ACCESS_PERMISSIONS[level].ai,
        autoresponse: record.canUseAutoResponse ?? ACCESS_PERMISSIONS[level].autoresponse,
      },
      isBlocked: level === 'BLOCKED',
      reason: record.reason,
      notes: record.notes,
      customPermissions: record.customPermissions,
    };
  } catch (error: unknown) {
    logger.error({ err: error, identifier }, 'Error getting permissions');
    return {
      accessLevel: 'FULL' as AccessLevel,
      permissions: ACCESS_PERMISSIONS.FULL,
      isBlocked: false,
    };
  }
}

/**
 * Bloquear número con nivel de acceso
 */
export async function block(
  identifier: string,
  type: BlockType,
  reason?: string,
  accessLevel: AccessLevel = 'BLOCKED'
) {
  try {
    return await prisma.blockedNumber.create({
      data: {
        identifier,
        type,
        reason: reason || 'Bloqueado manualmente',
        accessLevel,
      },
    });
  } catch (error: unknown) {
    logger.error({ err: error, identifier, type, accessLevel }, 'Error blocking number');
    throw error;
  }
}

/**
 * Establecer nivel de acceso
 */
export async function setAccessLevel(
  identifier: string,
  accessLevel: AccessLevel,
  reason?: string,
  blockedBy?: string
) {
  try {
    return await prisma.blockedNumber.upsert({
      where: { identifier },
      update: {
        accessLevel,
        reason,
        blockedBy,
        updatedAt: new Date(),
      },
      create: {
        identifier,
        type: 'PHONE',
        accessLevel,
        reason,
        blockedBy,
      },
    });
  } catch (error: unknown) {
    logger.error({ err: error, identifier, accessLevel }, 'Error setting access level');
    throw error;
  }
}

/**
 * Establecer permisos personalizados
 */
export async function setCustomPermissions(
  identifier: string,
  permissions: Partial<{
    canUseOdoo: boolean;
    canCreateTickets: boolean;
    canSeeHistory: boolean;
    canTalkToHuman: boolean;
    canUseAI: boolean;
    canUseAutoResponse: boolean;
  }>
) {
  try {
    return await prisma.blockedNumber.upsert({
      where: { identifier },
      update: {
        ...permissions,
        updatedAt: new Date(),
      },
      create: {
        identifier,
        type: 'PHONE',
        accessLevel: 'STANDARD',
        ...permissions,
      },
    });
  } catch (error: unknown) {
    logger.error({ err: error, identifier, permissions }, 'Error setting custom permissions');
    throw error;
  }
}

/**
 * Desbloquear número (elimina el registro)
 */
export async function unblock(identifier: string) {
  try {
    return await prisma.blockedNumber.delete({ where: { identifier } });
  } catch (error: unknown) {
    logger.error({ err: error, identifier }, 'Error unblocking number');
    throw error;
  }
}

export async function getAll() {
  try {
    return await prisma.blockedNumber.findMany({
      orderBy: { blockedAt: 'desc' },
    });
  } catch (error: unknown) {
    logger.error({ err: error }, 'Error getting blocked numbers');
    return [];
  }
}

export async function getAllByType(type: BlockType) {
  try {
    return await prisma.blockedNumber.findMany({
      where: { type },
      orderBy: { blockedAt: 'desc' },
    });
  } catch (error: unknown) {
    logger.error({ err: error, type }, 'Error getting blocked numbers by type');
    return [];
  }
}

export async function blockMultiple(entries: Array<{
  identifier: string;
  type: BlockType;
  reason?: string;
  accessLevel?: AccessLevel;
}>) {
  try {
    const results = {
      success: 0,
      failed: 0,
      errors: [] as string[],
      duplicates: [] as string[],
    };

    for (const entry of entries) {
      try {
        const existing = await prisma.blockedNumber.findUnique({
          where: { identifier: entry.identifier },
        });

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
            accessLevel: entry.accessLevel || 'BLOCKED',
          },
        });

        results.success++;
        logger.info(`Blocked successfully: ${entry.identifier}`);
      } catch (error: unknown) {
        results.failed++;
        const msg = error instanceof Error ? error.message : String(error);
        results.errors.push(`${entry.identifier}: ${msg}`);
        logger.error({ err: error, entry }, `Error blocking ${entry.identifier}`);
      }
    }

    return results;
  } catch (error: unknown) {
    logger.error({ err: error }, 'Error in bulk block');
    throw error;
  }
}

export async function exportAll() {
  try {
    const blocked = await prisma.blockedNumber.findMany({
      orderBy: { blockedAt: 'desc' },
      select: {
        identifier: true,
        type: true,
        accessLevel: true,
        reason: true,
        blockedAt: true,
        canUseOdoo: true,
        canCreateTickets: true,
        canUseAI: true,
      },
    });
    return blocked;
  } catch (error: unknown) {
    logger.error({ err: error }, 'Error exporting blocked numbers');
    throw error;
  }
}
