// src/web/middleware/auth.ts
import { Request, Response, NextFunction } from 'express';
import { logger } from '../../utils/logger.js';
import * as apiKeyModel from '../../models/apiKeys.js';

// ------------------------------------------------------
// Extender Request para incluir info de API key
// ------------------------------------------------------
declare global {
  namespace Express {
    interface Request {
      apiKey?: {
        id?: string;   // opcional para no romper en handlers que solo setean name
        name?: string; // opcional por la misma razón
      };
    }
  }
}

// ------------------------------------------------------
// Extender tipos de Express-Session para incluir session
// (ahora con campos temporales para 2FA)
// ------------------------------------------------------
declare module 'express-session' {
  interface SessionData {
    // sesión web “real” (ya autenticado)
    userId: string;
    username: string;

    // 🔐 paso intermedio cuando el admin tiene 2FA activado
    tempUserId?: string;
    tempUsername?: string;

    // 🔐 durante el setup de 2FA (mostrar QR + confirmar código)
    twoFASetupSecret?: string;
  }
}

// ==========================================
// AUTENTICACIÓN WEB (panel con sesión)
// ==========================================
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (req.session && req.session.userId) {
    return next();
  }
  // si no está logueado -> login
  return res.redirect('/auth/login');
}

export function redirectIfAuth(req: Request, res: Response, next: NextFunction) {
  if (req.session && req.session.userId) {
    return res.redirect('/');
  }
  next();
}

// ==========================================
// AUTENTICACIÓN API (x-api-key)
// ==========================================
/**
 * Middleware para validar API Key desde la base de datos.
 * Usado en endpoints públicos /api/* consumidos por sistemas externos.
 */
export async function validateApiKey(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    // API key viene por header x-api-key
    // o también se acepta en body.apiKey por comodidad
    const apiKeyValue =
      (req.headers['x-api-key'] as string) ||
      (typeof (req.body as any)?.apiKey === 'string' ? (req.body as any).apiKey : undefined);

    if (!apiKeyValue) {
      logger.warn({ ip: req.ip }, '[API-AUTH] API key missing');
      return res.status(401).json({
        success: false,
        error: 'API key no proporcionada. Usa header "x-api-key"',
      });
    }

    // Validar API key en la base de datos
    const apiKey = await apiKeyModel.validate(apiKeyValue);

    if (!apiKey) {
      logger.warn(
        { ip: req.ip, keyPrefix: apiKeyValue.slice(0, 10) },
        '[API-AUTH] Invalid API key'
      );
      return res.status(401).json({
        success: false,
        error: 'API key inválida o inactiva',
      });
    }

    // Adjuntar info básica al request para logging/auditoría
    req.apiKey = {
      id: apiKey.id,
      name: apiKey.name,
    };

    logger.debug(
      { ip: req.ip, apiKeyName: apiKey.name, apiKeyId: apiKey.id },
      '[API-AUTH] Valid API key'
    );

    next();
  } catch (error) {
    logger.error({ err: error }, '[API-AUTH] Error validating API key');
    return res.status(500).json({
      success: false,
      error: 'Error al validar API key',
    });
  }
}
