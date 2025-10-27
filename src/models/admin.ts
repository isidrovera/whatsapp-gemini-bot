import { getPrismaClient } from '../config/database.js';
import { logger } from '../utils/logger.js';
import bcrypt from 'bcryptjs';

const prisma = getPrismaClient();

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

export async function create(username: string, password: string, name?: string) {
  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    
    return await prisma.admin.create({
      data: {
        username,
        password: hashedPassword,
        name,
      },
    });
  } catch (error) {
    logger.error('Error creating admin:', error);
    throw error;
  }
}

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

export async function initDefaultAdmin() {
  try {
    const adminCount = await prisma.admin.count();
    
    if (adminCount === 0) {
      logger.info('Creating default admin user...');
      await create('admin', 'admin123', 'Administrador');
      logger.info('✅ Default admin created (username: admin, password: admin123)');
      logger.warn('⚠️  IMPORTANTE: Cambia la contraseña por defecto inmediatamente');
    }
  } catch (error) {
    logger.error('Error initializing default admin:', error);
  }
}

export async function getAll() {
  try {
    return await prisma.admin.findMany({
      select: {
        id: true,
        username: true,
        name: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  } catch (error) {
    logger.error('Error getting admins:', error);
    return [];
  }
}

export async function updatePassword(username: string, newPassword: string) {
  try {
    const hashedPassword = await bcrypt.hash(newPassword, 10);
    
    return await prisma.admin.update({
      where: { username },
      data: { password: hashedPassword },
    });
  } catch (error) {
    logger.error('Error updating password:', error);
    throw error;
  }
}


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

export async function updateAdmin(id: string, data: { username?: string; name?: string }) {
  try {
    return await prisma.admin.update({
      where: { id },
      data,
    });
  } catch (error) {
    logger.error('Error updating admin:', error);
    throw error;
  }
}

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

export async function findById(id: string) {
  try {
    return await prisma.admin.findUnique({
      where: { id },
      select: {
        id: true,
        username: true,
        name: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  } catch (error) {
    logger.error('Error finding admin by id:', error);
    return null;
  }
}