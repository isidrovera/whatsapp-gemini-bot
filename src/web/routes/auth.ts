import express from 'express';
import * as adminModel from '../../models/admin.js';
import { redirectIfAuth, requireAuth } from '../middleware/auth.js';
import {
  getQRDataURL,
  hasQR,
  getConnectionStatus,
  disconnectSession,   // 👈 nuevo
  forceNewQRState      // 👈 nuevo
} from '../../services/whatsapp.js';
import { logger } from '../../utils/logger.js';

const router = express.Router();

// Página de login
router.get('/login', redirectIfAuth, (req, res) => {
  res.render('login', { 
    title: 'Login',
    error: null 
  });
});

// Procesar login
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    
    if (!username || !password) {
      return res.render('login', { 
        title: 'Login',
        error: 'Usuario y contraseña son requeridos' 
      });
    }

    const isValid = await adminModel.verifyPassword(username, password);
    
    if (!isValid) {
      return res.render('login', { 
        title: 'Login',
        error: 'Usuario o contraseña incorrectos' 
      });
    }

    const admin = await adminModel.findByUsername(username);
    
    if (admin) {
      req.session.userId = admin.id;
      req.session.username = admin.username;
      
      logger.info(`[AUTH] User logged in: ${username}`);
      
      // Si WhatsApp aún no está conectado pero ya hay QR,
      // mándalo directo a escanear.
      if (!getConnectionStatus() && hasQR()) {
        return res.redirect('/auth/qr');
      }
      
      return res.redirect('/');
    }

    res.render('login', { 
      title: 'Login',
      error: 'Error al iniciar sesión' 
    });
  } catch (error) {
    logger.error('Error in login:', error);
    res.render('login', { 
      title: 'Login',
      error: 'Error del servidor' 
    });
  }
});

// Página de QR de WhatsApp
router.get('/qr', (req, res) => {
  if (!req.session.userId) {
    return res.redirect('/auth/login');
  }

  const qrDataURL = getQRDataURL();
  const isConnected = getConnectionStatus();

  res.render('qr', { 
    title: 'Conectar WhatsApp',
    qrDataURL,
    isConnected
  });
});

// API: Estado de conexión WhatsApp (para AJAX polling en la vista QR, si lo usas)
router.get('/api/status', (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  res.json({
    connected: getConnectionStatus(),
    hasQR: hasQR(),
    qrDataURL: getQRDataURL()
  });
});

// 🔌 NUEVO: Desconectar WhatsApp desde el dashboard
router.post('/logout-whatsapp', requireAuth, async (req, res) => {
  try {
    // 1. cerrar sesión actual con el número conectado
    await disconnectSession();

    // 2. marcar el estado interno para que el panel pase a "Esperando escaneo"
    //    (connected=false, hasQR=true, qrDataURL listo para mostrar en /auth/qr)
    await forceNewQRState();

    logger.info(
      `[WHATSAPP] Sesión WhatsApp desconectada manualmente por ${req.session?.username || 'unknown'}`
    );

    return res.json({
      success: true,
      message: 'Sesión de WhatsApp cerrada. Escanea nuevamente el QR.'
    });
  } catch (err) {
    logger.error('Error al desconectar WhatsApp:', err);
    return res.status(500).json({
      success: false,
      error: 'No se pudo desconectar WhatsApp'
    });
  }
});

// Logout de la sesión web (admin panel)
router.post('/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      logger.error('Error destroying session:', err);
    }
    res.redirect('/auth/login');
  });
});

export default router;
