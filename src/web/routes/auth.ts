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

interface SessionLike {
  userId?: string;
  username?: string;
  tempUserId?: string;
  tempUsername?: string;
  destroy?: (cb: (err?: unknown) => void) => void;
}

type RequestWithSession = express.Request & {
  session: SessionLike;
  cookies?: Record<string, string>;
};

const TRUSTED_DEVICE_COOKIE = 'td_token';
const COOKIE_MAX_AGE = 30 * 24 * 60 * 60 * 1000; // 30 días

// ==========================================
// Página de login
// ==========================================
router.get('/login', redirectIfAuth, (req, res) => {
  logger.debug('📝 GET /auth/login - Rendering login page');
  res.render('login', {
    title: 'Login',
    error: null
  });
});

// ==========================================
// Procesar login (1er factor: usuario + contraseña)
// ==========================================
router.post('/login', async (req: RequestWithSession, res) => {
  const startTime = Date.now();
  
  try {
    const { username, password } = req.body as { username?: string; password?: string };

    logger.info({
      username: username || 'undefined',
      hasPassword: !!password,
      ip: req.ip,
      userAgent: req.get('user-agent'),
      sessionId: (req.session as any)?.id?.substring(0, 8) || 'no-session',
    }, '🔐 POST /auth/login - Login attempt');

    if (!username || !password) {
      logger.warn({ username }, '⚠️  Login failed: Missing credentials');
      return res.render('login', {
        title: 'Login',
        error: 'Usuario y contraseña son requeridos'
      });
    }

    // 1. Validar credenciales
    const isValid = await adminModel.verifyPassword(username, password);
    if (!isValid) {
      logger.warn({ username, ip: req.ip }, '⚠️  Login failed: Invalid credentials');
      return res.render('login', {
        title: 'Login',
        error: 'Usuario o contraseña incorrectos'
      });
    }

    // 2. Obtener admin
    const admin = await adminModel.findByUsername(username);
    if (!admin) {
      logger.error({ username }, '❌ Login failed: Admin not found after password verification');
      return res.render('login', {
        title: 'Login',
        error: 'Error al iniciar sesión'
      });
    }

    logger.info({ 
      username,
      adminId: admin.id,
      has2FA: admin.twoFAEnabled 
    }, '✅ Password verified successfully');

    // 3. Si el admin TIENE 2FA activado
    if (admin.twoFAEnabled) {
      const trustedToken = req.cookies?.[TRUSTED_DEVICE_COOKIE];

      logger.debug({
        username,
        hasTrustedToken: !!trustedToken,
        tokenPrefix: trustedToken?.substring(0, 10)
      }, '🔐 2FA enabled - checking trusted device');

      if (trustedToken) {
        const trustedDevice = await trustedDeviceModel.verifyTrustedDevice(
          admin.id,
          trustedToken
        );

        if (trustedDevice) {
          // ✅ Skip 2FA por dispositivo confiable
          req.session.userId = admin.id;
          req.session.username = admin.username;

          await adminModel.updateLastLogin(admin.id, req.ip);

          logger.info({
            username,
            deviceName: trustedDevice.deviceName,
            duration: Date.now() - startTime
          }, '✅ Login successful via trusted device (2FA skipped)');

          if (!getConnectionStatus() && hasQR()) {
            return res.redirect('/auth/qr');
          }
          return res.redirect('/');
        } else {
          // Token inválido/expirado
          res.clearCookie(TRUSTED_DEVICE_COOKIE);
          logger.debug({ username }, '🧹 Cleared invalid trusted device token');
        }
      }

      // No hay dispositivo confiable válido -> pedir 2FA
      req.session.tempUserId = admin.id;
      req.session.tempUsername = admin.username;

      logger.info({ 
        username,
        duration: Date.now() - startTime 
      }, '🔐 Redirecting to 2FA verification');
      
      return res.redirect('/auth/2fa');
    }

    // 4. Sin 2FA -> login normal
    req.session.userId = admin.id;
    req.session.username = admin.username;

    await adminModel.updateLastLogin(admin.id, req.ip);
    
    logger.info({ 
      username,
      duration: Date.now() - startTime,
      sessionId: (req.session as any)?.id?.substring(0, 8)
    }, '✅ Login successful (no 2FA)');

    // Log cookies enviadas
    const setCookieHeader = res.getHeader('Set-Cookie');
    logger.debug({
      setCookie: setCookieHeader ? 'present' : 'missing',
      cookieCount: Array.isArray(setCookieHeader) ? setCookieHeader.length : (setCookieHeader ? 1 : 0)
    }, '🍪 Response cookies');

    if (!getConnectionStatus() && hasQR()) {
      return res.redirect('/auth/qr');
    }
    return res.redirect('/');
  } catch (err) {
    logger.error({ 
      err,
      username: req.body?.username,
      duration: Date.now() - startTime 
    }, '❌ Error in login');
    
    res.render('login', {
      title: 'Login',
      error: 'Error del servidor'
    });
  }
});

// ==========================================
// 2FA: mostrar formulario
// ==========================================
router.get('/2fa', (req: RequestWithSession, res) => {
  if (!req.session.tempUserId) {
    logger.warn('⚠️  GET /auth/2fa - No temp user, redirecting to login');
    return res.redirect('/auth/login');
  }

  logger.debug({
    tempUserId: req.session.tempUserId,
    tempUsername: req.session.tempUsername
  }, '📝 GET /auth/2fa - Rendering 2FA page');

  res.render('auth-2fa', {
    title: 'Verificación 2FA',
    error: null
  });
});

// ==========================================
// 2FA: procesar código TOTP
// ==========================================
router.post('/2fa', async (req: RequestWithSession, res) => {
  const startTime = Date.now();
  
  try {
    if (!req.session.tempUserId) {
      logger.warn('⚠️  POST /auth/2fa - No temp user, redirecting to login');
      return res.redirect('/auth/login');
    }

    const { code, trustDevice } = req.body as { code?: string; trustDevice?: string };

    logger.info({
      tempUserId: req.session.tempUserId,
      hasCode: !!code,
      trustDevice: trustDevice === 'on'
    }, '🔐 POST /auth/2fa - Processing 2FA code');

    if (!code) {
      return res.render('auth-2fa', {
        title: 'Verificación 2FA',
        error: 'Ingresa el código de 6 dígitos'
      });
    }

    const admin = await adminModel.findById(req.session.tempUserId);
    if (!admin || !admin.twoFAEnabled || !admin.twoFASecret) {
      logger.error({
        tempUserId: req.session.tempUserId
      }, '❌ 2FA verification failed: Invalid admin state');
      return res.redirect('/auth/login');
    }

    // Validar TOTP
    const isValid = speakeasy.totp.verify({
      secret: admin.twoFASecret,
      encoding: 'base32',
      token: code,
      window: 1
    });

    if (!isValid) {
      logger.warn({
        username: admin.username,
        codeLength: code.length
      }, '⚠️  2FA verification failed: Invalid code');
      
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
    
    logger.info({ 
      username: admin.username,
      duration: Date.now() - startTime 
    }, '✅ 2FA verification successful');

    // Confiar dispositivo
    if (trustDevice === 'on') {
      try {
        await trustedDeviceModel.limitDevicesPerAdmin(admin.id, 5);
        const device = await trustedDeviceModel.createTrustedDevice(admin.id, {
          userAgent: req.get('user-agent'),
          ipAddress: req.ip,
          daysValid: 30
        });

        res.cookie(TRUSTED_DEVICE_COOKIE, device.deviceToken, {
          maxAge: COOKIE_MAX_AGE,
          httpOnly: true,
          secure: process.env.NODE_ENV === 'production',
          sameSite: 'lax'
        });

        logger.info({
          username: admin.username,
          deviceName: device.deviceName
        }, '✅ Trusted device created');
      } catch (err) {
        logger.error({ err, username: admin.username }, '❌ Error creating trusted device');
      }
    }

    if (!getConnectionStatus() && hasQR()) {
      return res.redirect('/auth/qr');
    }
    return res.redirect('/');
  } catch (err) {
    logger.error({ 
      err,
      duration: Date.now() - startTime 
    }, '❌ Error in 2FA verification');
    
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
    logger.warn('⚠️  GET /auth/qr - Not authenticated, redirecting to login');
    return res.redirect('/auth/login');
  }

  const qrDataURL = getQRDataURL();
  const isConnected = getConnectionStatus();

  logger.debug({
    username: req.session.username,
    hasQR: !!qrDataURL,
    isConnected
  }, '📱 GET /auth/qr - Rendering QR page');

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
// Desconectar WhatsApp
// ==========================================
router.post('/logout-whatsapp', requireAuth, async (req: RequestWithSession, res) => {
  try {
    await disconnectSession();
    await forceNewQRState();

    logger.info({
      username: req.session?.username || 'unknown'
    }, '🔌 WhatsApp session disconnected manually');

    return res.json({
      success: true,
      message: 'Sesión de WhatsApp cerrada. Escanea nuevamente el QR.'
    });
  } catch (err) {
    logger.error({ err }, '❌ Error disconnecting WhatsApp');
    return res.status(500).json({
      success: false,
      error: 'No se pudo desconectar WhatsApp'
    });
  }
});

// ==========================================
// Logout de la sesión web
// ==========================================
router.post('/logout', (req: RequestWithSession, res) => {
  const username = req.session?.username || 'unknown';
  
  logger.info({ username }, '👋 User logging out');

  if (typeof req.session?.destroy === 'function') {
    req.session.destroy((destroyErr?: unknown) => {
      if (destroyErr) {
        logger.error({ err: destroyErr, username }, '❌ Error destroying session');
      } else {
        logger.info({ username }, '✅ Session destroyed successfully');
      }
      res.redirect('/auth/login');
    });
  } else {
    logger.warn({ username }, '⚠️  Session.destroy not available');
    res.redirect('/auth/login');
  }
});

export default router;