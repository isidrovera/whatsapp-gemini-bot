import express from 'express';
import * as adminModel from '../../models/admin.js';
import { logger } from '../../utils/logger.js';

const router = express.Router();

// Ver página de usuarios admin
router.get('/', async (req, res) => {
  try {
    const admins = await adminModel.getAll();
    res.render('adminUsers', { 
      title: 'Usuarios Admin',
      admins,
      currentUserId: req.session.userId // Para no permitir eliminarse a sí mismo
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

// API: Crear admin
router.post('/api', async (req, res) => {
  try {
    const { username, password, name } = req.body;
    
    if (!username || !password) {
      return res.status(400).json({ error: 'username and password are required' });
    }

    // Verificar si el username ya existe
    const existing = await adminModel.findByUsername(username);
    if (existing) {
      return res.status(400).json({ error: 'Username already exists' });
    }

    const admin = await adminModel.create(username, password, name);
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
    const { username, name } = req.body;
    
    const updateData: any = {};
    if (username !== undefined) updateData.username = username;
    if (name !== undefined) updateData.name = name;

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

export default router;