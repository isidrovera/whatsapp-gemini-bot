// src/models/admin.ts
import { getPrismaClient } from '../config/database.js';
import { logger } from '../utils/logger.js';
import bcrypt from 'bcryptjs';

const prisma = getPrismaClient();

/**
 * Buscar admin por username
 */
export async function findByUsername(username: string) {
  try {
    return await prisma.admin.findUnique({
      where: { username },
    });
  } catch (error) {
    logger.error('Error finding admin by username:', error);
    return null;
  }
}

/**
 * Crear admin (local)
 */
export async function create(
  username: string,
  password: string,
  name?: string,
  extra?: {
    email?: string;
    phone?: string;
    avatarUrl?: string;
    role?: string;
    isActive?: boolean;
    dni?: string;
  }
) {
  try {
    const hashedPassword = await bcrypt.hash(password, 10);

    return await prisma.admin.create({
      data: {
        username,
        password: hashedPassword,
        name,
        email: extra?.email,
        phone: extra?.phone,
        avatarUrl: extra?.avatarUrl,
        role: extra?.role ?? 'ADMIN',
        isActive: extra?.isActive ?? true,
        dni: extra?.dni,
      },
    });
  } catch (error) {
    logger.error('Error creating admin:', error);
    throw error;
  }
}

/**
 * Verificar password
 */
export async function verifyPassword(username: string, password: string): Promise<boolean> {
  try {
    const admin = await findByUsername(username);
    if (!admin) return false;

    return await bcrypt.compare(password, admin.password);
  } catch (error) {
    logger.error('Error verifying password:', error);
    return false;
  }
}

/**
 * Crear admin por defecto si no hay ninguno
 */
export async function initDefaultAdmin() {
  try {
    const adminCount = await prisma.admin.count();

    if (adminCount === 0) {
      logger.info('Creating default admin user...');
      await create('admin', 'admin123', 'Administrador', {
        email: 'admin@local.test',
        role: 'SUPER_ADMIN',
        isActive: true,
      });
      logger.info('✅ Default admin created (username: admin, password: admin123)');
      logger.warn('⚠️  IMPORTANTE: Cambia la contraseña por defecto inmediatamente');
    }
  } catch (error) {
    logger.error('Error initializing default admin:', error);
  }
}

/**
 * Listar admins
 */
export async function getAll() {
  try {
    return await prisma.admin.findMany({
      select: {
        id: true,
        username: true,
        name: true,
        email: true,
        phone: true,
        avatarUrl: true,
        role: true,
        isActive: true,
        dni: true,
        twoFAEnabled: true,
        createdAt: true,
        updatedAt: true,
        lastLoginAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  } catch (error) {
    logger.error('Error getting admins:', error);
    return [];
  }
}

/**
 * ✅ CORREGIDO: Actualizar solo la contraseña por ID (no username)
 */
export async function updatePassword(id: string, newPassword: string) {
  try {
    const hashedPassword = await bcrypt.hash(newPassword, 10);

    return await prisma.admin.update({
      where: { id }, // ✅ Usar id en lugar de username
      data: { password: hashedPassword },
    });
  } catch (error) {
    logger.error('Error updating password:', error);
    throw error;
  }
}

/**
 * Cambiar contraseña con validación de la actual
 */
export async function changePassword(id: string, currentPassword: string, newPassword: string) {
  try {
    const admin = await prisma.admin.findUnique({ where: { id } });

    if (!admin) {
      throw new Error('Admin not found');
    }

    const isValid = await bcrypt.compare(currentPassword, admin.password);

    if (!isValid) {
      throw new Error('Current password is incorrect');
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);

    return await prisma.admin.update({
      where: { id },
      data: { password: hashedPassword },
    });
  } catch (error) {
    logger.error('Error changing password:', error);
    throw error;
  }
}

/**
 * Actualizar datos básicos del admin
 */
export async function updateAdmin(
  id: string,
  data: {
    username?: string;
    name?: string;
    email?: string;
    phone?: string;
    avatarUrl?: string;
    dni?: string;
    role?: string;
    isActive?: boolean;
  }
) {
  try {
    return await prisma.admin.update({
      where: { id },
      data,
    });
  } catch (error: any) {
    logger.error('Error updating admin:', error);
    throw error;
  }
}

/**
 * Eliminar admin (evitar borrar el último)
 */
export async function deleteAdmin(id: string) {
  try {
    // Verificar que no sea el último admin
    const adminCount = await prisma.admin.count();

    if (adminCount <= 1) {
      throw new Error('Cannot delete the last admin user');
    }

    return await prisma.admin.delete({
      where: { id },
    });
  } catch (error) {
    logger.error('Error deleting admin:', error);
    throw error;
  }
}

/**
 * Buscar admin por id
 */
export async function findById(id: string) {
  try {
    return await prisma.admin.findUnique({
      where: { id },
      select: {
        id: true,
        username: true,
        name: true,
        email: true,
        phone: true,
        avatarUrl: true,
        role: true,
        isActive: true,
        dni: true,
        twoFAEnabled: true,
        twoFASecret: true,
        lastLoginAt: true,
        lastLoginIp: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  } catch (error) {
    logger.error('Error finding admin by id:', error);
    return null;
  }
}

/**
 * Activar 2FA para un admin
 */
export async function enable2FA(id: string, secret: string) {
  try {
    return await prisma.admin.update({
      where: { id },
      data: {
        twoFAEnabled: true,
        twoFASecret: secret,
      },
    });
  } catch (error) {
    logger.error('Error enabling 2FA:', error);
    throw error;
  }
}

/**
 * Desactivar 2FA para un admin
 */
export async function disable2FA(id: string) {
  try {
    return await prisma.admin.update({
      where: { id },
      data: {
        twoFAEnabled: false,
        twoFASecret: null,
      },
    });
  } catch (error) {
    logger.error('Error disabling 2FA:', error);
    throw error;
  }
}

/**
 * Actualizar última fecha/IP de login
 */
export async function updateLastLogin(id: string, ip?: string | null) {
  try {
    return await prisma.admin.update({
      where: { id },
      data: {
        lastLoginAt: new Date(),
        lastLoginIp: ip ?? undefined,
      },
    });
  } catch (error) {
    logger.error('Error updating last login for admin:', error);
    return null;
  }
}