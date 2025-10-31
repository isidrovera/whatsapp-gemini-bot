// src/models/trustedDevice.ts
import { getPrismaClient } from '../config/database.js';
import { logger } from '../utils/logger.js';
import crypto from 'crypto';

const prisma = getPrismaClient();

/**
 * Generar token único para dispositivo (64 caracteres hex)
 */
export function generateDeviceToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Obtener nombre amigable del dispositivo basado en User-Agent
 */
export function getDeviceName(userAgent?: string): string {
  if (!userAgent) return 'Navegador desconocido';
  
  const ua = userAgent.toLowerCase();
  
  // Detectar navegador
  let browser = 'Navegador';
  if (ua.includes('chrome') && !ua.includes('edg')) browser = 'Chrome';
  else if (ua.includes('firefox')) browser = 'Firefox';
  else if (ua.includes('safari') && !ua.includes('chrome')) browser = 'Safari';
  else if (ua.includes('edg')) browser = 'Edge';
  else if (ua.includes('opera') || ua.includes('opr')) browser = 'Opera';
  
  // Detectar sistema operativo
  let os = '';
  if (ua.includes('windows')) os = 'Windows';
  else if (ua.includes('mac')) os = 'macOS';
  else if (ua.includes('linux')) os = 'Linux';
  else if (ua.includes('android')) os = 'Android';
  else if (ua.includes('iphone') || ua.includes('ipad')) os = 'iOS';
  
  return os ? `${browser} en ${os}` : browser;
}

/**
 * Crear dispositivo confiable
 */
export async function createTrustedDevice(
  adminId: string,
  options: {
    userAgent?: string;
    ipAddress?: string;
    daysValid?: number; // por defecto 30 días
  } = {}
) {
  try {
    const deviceToken = generateDeviceToken();
    const daysValid = options.daysValid || 30;
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + daysValid);

    const deviceName = getDeviceName(options.userAgent);

    const device = await prisma.trustedDevice.create({
      data: {
        adminId,
        deviceToken,
        deviceName,
        userAgent: options.userAgent,
        ipAddress: options.ipAddress,
        expiresAt,
      },
    });

    logger.info(
      `[TRUSTED-DEVICE] Created trusted device for admin ${adminId}: ${deviceName}`
    );

    return device;
  } catch (error) {
    logger.error('[TRUSTED-DEVICE] Error creating trusted device:', error);
    throw error;
  }
}

/**
 * Verificar si un dispositivo es confiable y está vigente
 */
export async function verifyTrustedDevice(
  adminId: string,
  deviceToken: string
) {
  try {
    const device = await prisma.trustedDevice.findFirst({
      where: {
        adminId,
        deviceToken,
        expiresAt: {
          gt: new Date(), // no expirado
        },
      },
    });

    if (device) {
      // Actualizar última vez usado
      await prisma.trustedDevice.update({
        where: { id: device.id },
        data: { lastUsedAt: new Date() },
      });

      logger.debug(
        `[TRUSTED-DEVICE] Verified device ${device.deviceName} for admin ${adminId}`
      );
    }

    return device;
  } catch (error) {
    logger.error('[TRUSTED-DEVICE] Error verifying trusted device:', error);
    return null;
  }
}

/**
 * Listar dispositivos confiables de un admin
 */
export async function getTrustedDevices(adminId: string) {
  try {
    return await prisma.trustedDevice.findMany({
      where: { adminId },
      orderBy: { lastUsedAt: 'desc' },
    });
  } catch (error) {
    logger.error('[TRUSTED-DEVICE] Error getting trusted devices:', error);
    return [];
  }
}

/**
 * Contar dispositivos confiables activos de un admin
 */
export async function countActiveTrustedDevices(adminId: string): Promise<number> {
  try {
    return await prisma.trustedDevice.count({
      where: {
        adminId,
        expiresAt: {
          gt: new Date(),
        },
      },
    });
  } catch (error) {
    logger.error('[TRUSTED-DEVICE] Error counting trusted devices:', error);
    return 0;
  }
}

/**
 * Revocar dispositivo confiable
 */
export async function revokeTrustedDevice(id: string) {
  try {
    const device = await prisma.trustedDevice.delete({
      where: { id },
    });

    logger.info(
      `[TRUSTED-DEVICE] Revoked device ${device.deviceName} (${device.id})`
    );

    return device;
  } catch (error) {
    logger.error('[TRUSTED-DEVICE] Error revoking trusted device:', error);
    throw error;
  }
}

/**
 * Revocar todos los dispositivos de un admin
 */
export async function revokeAllTrustedDevices(adminId: string) {
  try {
    const result = await prisma.trustedDevice.deleteMany({
      where: { adminId },
    });

    logger.info(
      `[TRUSTED-DEVICE] Revoked all devices for admin ${adminId} (${result.count} devices)`
    );

    return result.count;
  } catch (error) {
    logger.error('[TRUSTED-DEVICE] Error revoking all trusted devices:', error);
    throw error;
  }
}

/**
 * Limpiar dispositivos expirados (ejecutar periódicamente)
 */
export async function cleanExpiredDevices() {
  try {
    const result = await prisma.trustedDevice.deleteMany({
      where: {
        expiresAt: {
          lt: new Date(),
        },
      },
    });

    if (result.count > 0) {
      logger.info(
        `[TRUSTED-DEVICE] Cleaned ${result.count} expired trusted devices`
      );
    }

    return result.count;
  } catch (error) {
    logger.error('[TRUSTED-DEVICE] Error cleaning expired devices:', error);
    return 0;
  }
}

/**
 * Limitar cantidad de dispositivos por admin (mantener solo los N más recientes)
 */
export async function limitDevicesPerAdmin(
  adminId: string,
  maxDevices: number = 5
) {
  try {
    const devices = await prisma.trustedDevice.findMany({
      where: { adminId },
      orderBy: { lastUsedAt: 'desc' },
    });

    if (devices.length > maxDevices) {
      const devicesToDelete = devices.slice(maxDevices);
      const idsToDelete = devicesToDelete.map((d) => d.id);

      await prisma.trustedDevice.deleteMany({
        where: {
          id: { in: idsToDelete },
        },
      });

      logger.info(
        `[TRUSTED-DEVICE] Removed ${devicesToDelete.length} old devices for admin ${adminId}`
      );

      return devicesToDelete.length;
    }

    return 0;
  } catch (error) {
    logger.error('[TRUSTED-DEVICE] Error limiting devices per admin:', error);
    return 0;
  }
}