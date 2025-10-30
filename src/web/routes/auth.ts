// src/web/routes/auth.ts
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
import speakeasy from 'speakeasy';

const router = express.Router();

// ==========================================
// Página de login
// ==========================================
router.get('/login', redirectIfAuth, (req, res) => {
  res.render('login', {
    title: 'Login',
    error: null
  });
});

// ==========================================
// Procesar login (1er factor: usuario + contraseña)
// ==========================================
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.render('login', {
        title: 'Login',
        error: 'Usuario y contraseña son requeridos'
      });
    }

    // 1. validar credenciales
    const isValid = await adminModel.verifyPassword(username, password);

    if (!isValid) {
      return res.render('login', {
        title: 'Login',
        error: 'Usuario o contraseña incorrectos'
      });
    }

    // 2. obtener admin con todos los campos (incluido 2FA)
    const admin = await adminModel.findByUsername(username);

    if (!admin) {
      return res.render('login', {
        title: 'Login',
        error: 'Error al iniciar sesión'
      });
    }

    // 3. Si el admin TIENE 2FA activado -> NO crear sesión todavía
    if (admin.twoFAEnabled) {
      // guardamos en sesión “temporal” los datos del usuario logueado
      req.session.tempUserId = admin.id;
      req.session.tempUsername = admin.username;

      logger.info(`[AUTH] User passed 1st factor (password) and requires 2FA: ${username}`);

      // redirigimos a la pantalla de código
      return res.redirect('/auth/2fa');
    }

    // 4. Si NO tiene 2FA -> login normal de siempre
    req.session.userId = admin.id;
    req.session.username = admin.username;

    // opcional: guardar último login
    await adminModel.updateLastLogin(admin.id, req.ip);

    logger.info(`[AUTH] User logged in: ${username}`);

    // Si WhatsApp aún no está conectado pero ya hay QR,
    // mándalo directo a escanear.
    if (!getConnectionStatus() && hasQR()) {
      return res.redirect('/auth/qr');
    }

    return res.redirect('/');
  } catch (error) {
    logger.error('Error in login:', error);
    res.render('login', {
      title: 'Login',
      error: 'Error del servidor'
    });
  }
});

// ==========================================
// 2FA: mostrar formulario para ingresar el código
// (solo si antes pasó usuario/contraseña)
// ==========================================
router.get('/2fa', (req, res) => {
  // si no viene de un login previo, lo mandamos al login
  if (!req.session.tempUserId) {
    return res.redirect('/auth/login');
  }

  res.render('auth-2fa', {
    title: 'Verificación 2FA',
    error: null
  });
});

// ==========================================
// 2FA: procesar código TOTP
// ==========================================
router.post('/2fa', async (req, res) => {
  try {
    // no hay usuario temporal -> que haga login
    if (!req.session.tempUserId) {
      return res.redirect('/auth/login');
    }

    const { code } = req.body;
    if (!code) {
      return res.render('auth-2fa', {
        title: 'Verificación 2FA',
        error: 'Ingresa el código de 6 dígitos'
      });
    }

    // buscar admin temporal
    const admin = await adminModel.findById(req.session.tempUserId);
    if (!admin || !admin.twoFAEnabled || !admin.twoFASecret) {
      // algo raro: o desactivaron 2FA en medio o la sesión está vieja
      return res.redirect('/auth/login');
    }

    // validar código TOTP
    const isValid = speakeasy.totp.verify({
      secret: admin.twoFASecret,
      encoding: 'base32',
      token: code,
      window: 1 // pequeña tolerancia
    });

    if (!isValid) {
      return res.render('auth-2fa', {
        title: 'Verificación 2FA',
        error: 'Código inválido o expirado'
      });
    }

    // ✅ código correcto -> ahora sí creamos sesión REAL
    req.session.userId = admin.id;
    req.session.username = admin.username;

    // limpiar temporales
    delete req.session.tempUserId;
    delete req.session.tempUsername;

    // opcional: guardar último login
    await adminModel.updateLastLogin(admin.id, req.ip);

    logger.info(`[AUTH] 2FA success for user: ${admin.username}`);

    // igual que en el login normal: si hay QR pendiente, lo mandamos ahí
    if (!getConnectionStatus() && hasQR()) {
      return res.redirect('/auth/qr');
    }

    return res.redirect('/');
  } catch (err) {
    logger.error('Error in 2FA verification:', err);
    return res.render('auth-2fa', {
      title: 'Verificación 2FA',
      error: 'Error al verificar el código'
    });
  }
});

// ==========================================
// Página de QR de WhatsApp
// ==========================================
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

// ==========================================
// API: Estado de conexión WhatsApp
// ==========================================
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

// ==========================================
// 🔌 Desconectar WhatsApp desde el dashboard
// ==========================================
router.post('/logout-whatsapp', requireAuth, async (req, res) => {
  try {
    // 1. cerrar sesión actual con el número conectado
    await disconnectSession();

    // 2. marcar el estado interno para que el panel pase a "Esperando escaneo"
    await forceNewQRState();

    logger.info(
      `[WHATSAPP] Sesión WhatsApp desconectada manualmente por ${
        req.session?.username || 'unknown'
      }`
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

// ==========================================
// Logout de la sesión web (admin panel)
// ==========================================
router.post('/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      logger.error('Error destroying session:', err);
    }
    res.redirect('/auth/login');
  });
});

export default router;
