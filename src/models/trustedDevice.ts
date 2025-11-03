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
  else if (ua.includes('iphone') || ua.includes('ipad')) os = 'iOS';
  else if (ua.includes('android')) os = 'Android';
  else if (ua.includes('mac')) os = 'macOS';
  else if (ua.includes('linux')) os = 'Linux';

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
      { adminId, deviceId: device.id, deviceName },
      '[TRUSTED-DEVICE] Created trusted device'
    );

    return device;
  } catch (error) {
    logger.error(
      { err: error, adminId },
      '[TRUSTED-DEVICE] Error creating trusted device'
    );
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
        { adminId, deviceId: device.id, deviceName: device.deviceName },
        '[TRUSTED-DEVICE] Verified device'
      );
    }

    return device;
  } catch (error) {
    logger.error(
      { err: error, adminId },
      '[TRUSTED-DEVICE] Error verifying trusted device'
    );
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
    logger.error(
      { err: error, adminId },
      '[TRUSTED-DEVICE] Error getting trusted devices'
    );
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
    logger.error(
      { err: error, adminId },
      '[TRUSTED-DEVICE] Error counting trusted devices'
    );
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
      { deviceId: id, deviceName: device.deviceName },
      '[TRUSTED-DEVICE] Revoked device'
    );

    return device;
  } catch (error) {
    logger.error(
      { err: error, deviceId: id },
      '[TRUSTED-DEVICE] Error revoking trusted device'
    );
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
      { adminId, removed: result.count },
      '[TRUSTED-DEVICE] Revoked all devices for admin'
    );

    return result.count;
  } catch (error) {
    logger.error(
      { err: error, adminId },
      '[TRUSTED-DEVICE] Error revoking all trusted devices'
    );
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
        { removed: result.count },
        '[TRUSTED-DEVICE] Cleaned expired trusted devices'
      );
    }

    return result.count;
  } catch (error) {
    logger.error(
      { err: error },
      '[TRUSTED-DEVICE] Error cleaning expired devices'
    );
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
        { adminId, removed: devicesToDelete.length },
        '[TRUSTED-DEVICE] Removed old devices for admin'
      );

      return devicesToDelete.length;
    }

    return 0;
  } catch (error) {
    logger.error(
      { err: error, adminId },
      '[TRUSTED-DEVICE] Error limiting devices per admin'
    );
    return 0;
  }
}
