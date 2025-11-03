// src/web/routes/auth.ts
import express from 'express';
import * as adminModel from '../../models/admin.js';
import * as trustedDeviceModel from '../../models/trustedDevice.js';
import { redirectIfAuth, requireAuth } from '../middleware/auth.js';
import {
  getQRDataURL,
  hasQR,
  getConnectionStatus,
  disconnectSession,
  forceNewQRState
} from '../../services/whatsapp.js';
import { logger } from '../../utils/logger.js';
import speakeasy from 'speakeasy';

const router = express.Router();

// Tipos auxiliares mínimos para no pelear con tipos de sesión/cookies
interface SessionLike {
  userId?: string;
  username?: string;
  tempUserId?: string;
  tempUsername?: string;
  destroy?: (cb: (err?: unknown) => void) => void;
}
interface RequestWithSession extends express.Request {
  session: SessionLike;
  cookies?: Record<string, string>;
}

// Nombre de la cookie para dispositivo confiable
const TRUSTED_DEVICE_COOKIE = 'td_token';
const COOKIE_MAX_AGE = 30 * 24 * 60 * 60 * 1000; // 30 días en milisegundos

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
router.post('/login', async (req: RequestWithSession, res) => {
  try {
    const { username, password } = req.body as { username?: string; password?: string };

    if (!username || !password) {
      return res.render('login', {
        title: 'Login',
        error: 'Usuario y contraseña son requeridos'
      });
    }

    // 1. Validar credenciales
    const isValid = await adminModel.verifyPassword(username, password);

    if (!isValid) {
      return res.render('login', {
        title: 'Login',
        error: 'Usuario o contraseña incorrectos'
      });
    }

    // 2. Obtener admin con todos los campos
    const admin = await adminModel.findByUsername(username);

    if (!admin) {
      return res.render('login', {
        title: 'Login',
        error: 'Error al iniciar sesión'
      });
    }

    // 3. Si el admin TIENE 2FA activado
    if (admin.twoFAEnabled) {
      // 🔐 Verificar si hay un dispositivo confiable en cookies
      const trustedToken = req.cookies?.[TRUSTED_DEVICE_COOKIE];

      if (trustedToken) {
        const trustedDevice = await trustedDeviceModel.verifyTrustedDevice(
          admin.id,
          trustedToken
        );

        if (trustedDevice) {
          // ✅ Dispositivo confiable válido - skip 2FA
          req.session.userId = admin.id;
          req.session.username = admin.username;

          await adminModel.updateLastLogin(admin.id, req.ip);

          logger.info(
            { username, deviceName: trustedDevice.deviceName },
            '[AUTH] User logged in via trusted device'
          );

          if (!getConnectionStatus() && hasQR()) {
            return res.redirect('/auth/qr');
          }

          return res.redirect('/');
        } else {
          // Token inválido o expirado - eliminar cookie
          res.clearCookie(TRUSTED_DEVICE_COOKIE);
          logger.debug(
            { username },
            '[AUTH] Cleared invalid trusted device token'
          );
        }
      }

      // No hay dispositivo confiable válido -> pedir 2FA
      req.session.tempUserId = admin.id;
      req.session.tempUsername = admin.username;

      logger.info(
        { username },
        '[AUTH] User passed 1st factor (password) and requires 2FA'
      );

      return res.redirect('/auth/2fa');
    }

    // 4. Si NO tiene 2FA -> login normal
    req.session.userId = admin.id;
    req.session.username = admin.username;

    await adminModel.updateLastLogin(admin.id, req.ip);

    logger.info({ username }, '[AUTH] User logged in');

    if (!getConnectionStatus() && hasQR()) {
      return res.redirect('/auth/qr');
    }

    return res.redirect('/');
  } catch (err) {
    logger.error({ err }, 'Error in login');
    res.render('login', {
      title: 'Login',
      error: 'Error del servidor'
    });
  }
});

// ==========================================
// 2FA: mostrar formulario para ingresar el código
// ==========================================
router.get('/2fa', (req: RequestWithSession, res) => {
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
router.post('/2fa', async (req: RequestWithSession, res) => {
  try {
    // No hay usuario temporal -> que haga login
    if (!req.session.tempUserId) {
      return res.redirect('/auth/login');
    }

    const { code, trustDevice } = req.body as { code?: string; trustDevice?: string };

    if (!code) {
      return res.render('auth-2fa', {
        title: 'Verificación 2FA',
        error: 'Ingresa el código de 6 dígitos'
      });
    }

    // Buscar admin temporal
    const admin = await adminModel.findById(req.session.tempUserId);

    if (!admin || !admin.twoFAEnabled || !admin.twoFASecret) {
      return res.redirect('/auth/login');
    }

    // Validar código TOTP
    const isValid = speakeasy.totp.verify({
      secret: admin.twoFASecret,
      encoding: 'base32',
      token: code,
      window: 1
    });

    if (!isValid) {
      return res.render('auth-2fa', {
        title: 'Verificación 2FA',
        error: 'Código inválido o expirado'
      });
    }

    // ✅ Código correcto -> crear sesión REAL
    req.session.userId = admin.id;
    req.session.username = admin.username;

    // Limpiar temporales
    delete req.session.tempUserId;
    delete req.session.tempUsername;

    await adminModel.updateLastLogin(admin.id, req.ip);

    logger.info({ username: admin.username }, '[AUTH] 2FA success');

    // 🆕 Si el usuario marcó "Confiar en este dispositivo"
    if (trustDevice === 'on') {
      try {
        // Limitar a máximo 5 dispositivos
        await trustedDeviceModel.limitDevicesPerAdmin(admin.id, 5);

        // Crear nuevo dispositivo confiable
        const device = await trustedDeviceModel.createTrustedDevice(admin.id, {
          userAgent: req.get('user-agent'),
          ipAddress: req.ip,
          daysValid: 30
        });

        // Guardar token en cookie (30 días, httpOnly, secure en producción)
        res.cookie(TRUSTED_DEVICE_COOKIE, device.deviceToken, {
          maxAge: COOKIE_MAX_AGE,
          httpOnly: true,
          secure: process.env.NODE_ENV === 'production',
          sameSite: 'lax'
        });

        logger.info(
          { username: admin.username, deviceName: device.deviceName },
          '[AUTH] Trusted device created'
        );
      } catch (err) {
        logger.error({ err }, '[AUTH] Error creating trusted device');
        // No bloqueamos el login si falla crear el dispositivo
      }
    }

    if (!getConnectionStatus() && hasQR()) {
      return res.redirect('/auth/qr');
    }

    return res.redirect('/');
  } catch (err) {
    logger.error({ err }, 'Error in 2FA verification');
    return res.render('auth-2fa', {
      title: 'Verificación 2FA',
      error: 'Error al verificar el código'
    });
  }
});

// ==========================================
// Página de QR de WhatsApp
// ==========================================
router.get('/qr', (req: RequestWithSession, res) => {
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
router.get('/api/status', (req: RequestWithSession, res) => {
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
router.post('/logout-whatsapp', requireAuth, async (req: RequestWithSession, res) => {
  try {
    await disconnectSession();
    await forceNewQRState();

    logger.info(
      { username: req.session?.username || 'unknown' },
      '[WHATSAPP] Sesión WhatsApp desconectada manualmente'
    );

    return res.json({
      success: true,
      message: 'Sesión de WhatsApp cerrada. Escanea nuevamente el QR.'
    });
  } catch (err) {
    logger.error({ err }, 'Error al desconectar WhatsApp');
    return res.status(500).json({
      success: false,
      error: 'No se pudo desconectar WhatsApp'
    });
  }
});

// ==========================================
// Logout de la sesión web (admin panel)
// ==========================================
router.post('/logout', (req: RequestWithSession, res) => {
  // Opcional: eliminar cookie de dispositivo confiable al hacer logout
  // res.clearCookie(TRUSTED_DEVICE_COOKIE);

  if (typeof req.session?.destroy === 'function') {
    req.session.destroy((destroyErr?: unknown) => {
      if (destroyErr) {
        logger.error({ err: destroyErr }, 'Error destroying session');
      }
      res.redirect('/auth/login');
    });
  } else {
    res.redirect('/auth/login');
  }
});

export default router;
