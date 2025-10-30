import express from 'express';
import * as adminModel from '../../models/admin.js';
import { logger } from '../../utils/logger.js';
import { validateDNI } from '../../services/external.js';
import speakeasy from 'speakeasy';
import QRCode from 'qrcode';

const router = express.Router();

// Ver página de usuarios admin
router.get('/', async (req, res) => {
  try {
    const admins = await adminModel.getAll();
    res.render('adminUsers', { 
      title: 'Usuarios Admin',
      admins,
      currentUserId: req.session.userId
    });
  } catch (error) {
    logger.error('Error loading admin users:', error);
    res.status(500).send('Error loading admin users');
  }
});

// API: Obtener todos los admins
router.get('/api', async (req, res) => {
  try {
    const admins = await adminModel.getAll();
    res.json(admins);
  } catch (error) {
    logger.error('Error getting admins:', error);
    res.status(500).json({ error: 'Error getting admins' });
  }
});

// API: Obtener admin por ID
router.get('/api/:id', async (req, res) => {
  try {
    const admin = await adminModel.findById(req.params.id);
    if (!admin) {
      return res.status(404).json({ error: 'Admin not found' });
    }
    res.json(admin);
  } catch (error) {
    logger.error('Error getting admin:', error);
    res.status(500).json({ error: 'Error getting admin' });
  }
});

// API: Consultar DNI en RENIEC
router.post('/api/validate-dni', async (req, res) => {
  try {
    const { dni } = req.body;
    
    if (!dni || !/^\d{8}$/.test(dni)) {
      return res.status(400).json({ 
        success: false,
        error: 'DNI debe tener 8 dígitos' 
      });
    }

    logger.info(`Validating DNI: ${dni}`);
    const data = await validateDNI(dni);

    if (!data) {
      return res.status(404).json({ 
        success: false,
        error: 'DNI no encontrado en RENIEC o servicio no disponible' 
      });
    }

    // Construir nombre completo
    const fullName = `${data.nombres} ${data.apellidoPaterno} ${data.apellidoMaterno}`.trim();

    res.json({
      success: true,
      data: {
        dni,
        name: fullName,
        nombres: data.nombres,
        apellidoPaterno: data.apellidoPaterno,
        apellidoMaterno: data.apellidoMaterno
      }
    });
  } catch (error) {
    logger.error('Error validating DNI:', error);
    res.status(500).json({ 
      success: false,
      error: 'Error al validar DNI' 
    });
  }
});

// API: Crear admin
router.post('/api', async (req, res) => {
  try {
    const { username, password, name, email, phone, avatarUrl, dni, role, isActive } = req.body;
    
    if (!username || !password) {
      return res.status(400).json({ error: 'username and password are required' });
    }

    // Verificar si el username ya existe
    const existing = await adminModel.findByUsername(username);
    if (existing) {
      return res.status(400).json({ error: 'Username already exists' });
    }

    const admin = await adminModel.create(username, password, name, {
      email,
      phone,
      avatarUrl,
      dni,
      role: role || 'ADMIN',
      isActive: isActive !== false
    });

    res.json({ 
      success: true, 
      admin: {
        id: admin.id,
        username: admin.username,
        name: admin.name
      }
    });
  } catch (error) {
    logger.error('Error creating admin:', error);
    res.status(500).json({ error: 'Error creating admin' });
  }
});

// API: Actualizar admin
router.put('/api/:id', async (req, res) => {
  try {
    const { username, name, email, phone, avatarUrl, dni, role, isActive } = req.body;
    
    const updateData: any = {};
    if (username !== undefined) updateData.username = username;
    if (name !== undefined) updateData.name = name;
    if (email !== undefined) updateData.email = email;
    if (phone !== undefined) updateData.phone = phone;
    if (avatarUrl !== undefined) updateData.avatarUrl = avatarUrl;
    if (dni !== undefined) updateData.dni = dni;
    if (role !== undefined) updateData.role = role;
    if (isActive !== undefined) updateData.isActive = isActive;

    const admin = await adminModel.updateAdmin(req.params.id, updateData);
    res.json({ success: true, admin });
  } catch (error) {
    logger.error('Error updating admin:', error);
    res.status(500).json({ error: 'Error updating admin' });
  }
});

// API: Cambiar contraseña
router.post('/api/:id/change-password', async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'currentPassword and newPassword are required' });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    await adminModel.changePassword(req.params.id, currentPassword, newPassword);
    res.json({ success: true, message: 'Password changed successfully' });
  } catch (error) {
    logger.error('Error changing password:', error);
    
    if (error instanceof Error && error.message === 'Current password is incorrect') {
      return res.status(400).json({ error: 'Current password is incorrect' });
    }
    
    res.status(500).json({ error: 'Error changing password' });
  }
});

// API: Resetear contraseña (solo el admin actual puede hacerlo a otros)
router.post('/api/:id/reset-password', async (req, res) => {
  try {
    const { newPassword } = req.body;
    
    if (!newPassword) {
      return res.status(400).json({ error: 'newPassword is required' });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    // Verificar que no se esté reseteando a sí mismo
    if (req.params.id === req.session.userId) {
      return res.status(400).json({ error: 'Use change-password to update your own password' });
    }

    // CORREGIDO: Usar id en lugar de username
    await adminModel.updatePassword(req.params.id, newPassword);
    res.json({ success: true, message: 'Password reset successfully' });
  } catch (error) {
    logger.error('Error resetting password:', error);
    res.status(500).json({ error: 'Error resetting password' });
  }
});

// API: Eliminar admin
router.delete('/api/:id', async (req, res) => {
  try {
    // Verificar que no se esté eliminando a sí mismo
    if (req.params.id === req.session.userId) {
      return res.status(400).json({ error: 'Cannot delete yourself' });
    }

    await adminModel.deleteAdmin(req.params.id);
    res.json({ success: true, message: 'Admin deleted successfully' });
  } catch (error) {
    logger.error('Error deleting admin:', error);
    
    if (error instanceof Error && error.message === 'Cannot delete the last admin user') {
      return res.status(400).json({ error: 'Cannot delete the last admin user' });
    }
    
    res.status(500).json({ error: 'Error deleting admin' });
  }
});

// ==========================================
// 🔐 ENDPOINTS DE 2FA
// ==========================================

// API: Generar QR para activar 2FA
router.post('/api/:id/2fa/setup', async (req, res) => {
  try {
    const adminId = req.params.id;
    
    // Solo puede configurar su propio 2FA
    if (adminId !== req.session.userId) {
      return res.status(403).json({ error: 'You can only setup 2FA for your own account' });
    }

    const admin = await adminModel.findById(adminId);
    if (!admin) {
      return res.status(404).json({ error: 'Admin not found' });
    }

    // Generar secret
    const secret = speakeasy.generateSecret({
      name: `WhatsApp Bot Admin (${admin.username})`,
      issuer: 'WhatsApp Bot Admin'
    });

    // Generar QR code
    const qrCodeUrl = await QRCode.toDataURL(secret.otpauth_url!);

    // Guardar secret temporal en sesión
    req.session.twoFASetupSecret = secret.base32;
    await req.session.save();

    res.json({
      success: true,
      secret: secret.base32,
      qrCode: qrCodeUrl
    });
  } catch (error) {
    logger.error('Error setting up 2FA:', error);
    res.status(500).json({ error: 'Error setting up 2FA' });
  }
});

// API: Verificar código y activar 2FA
router.post('/api/:id/2fa/enable', async (req, res) => {
  try {
    const adminId = req.params.id;
    const { code } = req.body;

    // Solo puede activar su propio 2FA
    if (adminId !== req.session.userId) {
      return res.status(403).json({ error: 'You can only enable 2FA for your own account' });
    }

    if (!code || !/^\d{6}$/.test(code)) {
      return res.status(400).json({ error: 'Invalid code format' });
    }

    // Obtener secret de la sesión
    const secret = req.session.twoFASetupSecret;
    if (!secret) {
      return res.status(400).json({ error: '2FA setup not initiated. Please scan QR code first.' });
    }

    // Verificar el código
    const verified = speakeasy.totp.verify({
      secret,
      encoding: 'base32',
      token: code,
      window: 2 // Permite +/- 1 minuto de diferencia
    });

    if (!verified) {
      return res.status(400).json({ error: 'Invalid code. Please try again.' });
    }

    // Activar 2FA en la base de datos
    await adminModel.enable2FA(adminId, secret);

    // Limpiar secret temporal de la sesión
    delete req.session.twoFASetupSecret;
    await req.session.save();

    logger.info(`2FA enabled for admin: ${adminId}`);

    res.json({
      success: true,
      message: '2FA enabled successfully'
    });
  } catch (error) {
    logger.error('Error enabling 2FA:', error);
    res.status(500).json({ error: 'Error enabling 2FA' });
  }
});

// API: Desactivar 2FA
router.post('/api/:id/2fa/disable', async (req, res) => {
  try {
    const adminId = req.params.id;
    const { currentPassword } = req.body;

    // Solo puede desactivar su propio 2FA
    if (adminId !== req.session.userId) {
      return res.status(403).json({ error: 'You can only disable 2FA for your own account' });
    }

    if (!currentPassword) {
      return res.status(400).json({ error: 'Current password is required to disable 2FA' });
    }

    // Verificar contraseña actual
    const admin = await adminModel.findById(adminId);
    if (!admin) {
      return res.status(404).json({ error: 'Admin not found' });
    }

    const isValidPassword = await adminModel.verifyPassword(admin.username, currentPassword);
    if (!isValidPassword) {
      return res.status(400).json({ error: 'Current password is incorrect' });
    }

    // Desactivar 2FA
    await adminModel.disable2FA(adminId);

    logger.info(`2FA disabled for admin: ${adminId}`);

    res.json({
      success: true,
      message: '2FA disabled successfully'
    });
  } catch (error) {
    logger.error('Error disabling 2FA:', error);
    res.status(500).json({ error: 'Error disabling 2FA' });
  }
});

export default router;