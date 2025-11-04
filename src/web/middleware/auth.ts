// src/web/middleware/auth.ts
import { Request, Response, NextFunction } from 'express';
import { logger } from '../../utils/logger.js';
import * as apiKeyModel from '../../models/apiKeys.js';

declare global {
  namespace Express {
    interface Request {
      apiKey?: {
        id?: string;
        name?: string;
      };
    }
  }
}

declare module 'express-session' {
  interface SessionData {
    userId: string;
    username: string;
    tempUserId?: string;
    tempUsername?: string;
    twoFASetupSecret?: string;
  }
}

// ==========================================
// AUTENTICACIÓN WEB (panel con sesión)
// ==========================================
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const hasSession = !!req.session;
  const hasUserId = !!(req.session as any)?.userId;
  const sessionId = (req.session as any)?.id?.substring(0, 8) || 'no-session';
  const username = (req.session as any)?.username;

  logger.debug({
    path: req.path,
    method: req.method,
    hasSession,
    hasUserId,
    sessionId,
    username: username || 'none',
    cookies: Object.keys(req.cookies || {})
  }, '🔒 requireAuth middleware check');

  if (req.session && (req.session as any).userId) {
    return next();
  }
  
  logger.warn({
    path: req.path,
    sessionId,
    hasSession,
    hasUserId
  }, '⚠️  requireAuth failed - redirecting to login');
  
  return res.redirect('/auth/login');
}

export function redirectIfAuth(req: Request, res: Response, next: NextFunction) {
  const hasUserId = !!(req.session as any)?.userId;
  
  logger.debug({
    path: req.path,
    hasUserId,
    username: (req.session as any)?.username || 'none'
  }, '🔄 redirectIfAuth middleware check');
  
  if (req.session && (req.session as any).userId) {
    logger.debug({ username: (req.session as any).username }, '🔄 Already authenticated - redirecting to dashboard');
    return res.redirect('/');
  }
  next();
}

// ==========================================
// AUTENTICACIÓN API (x-api-key)
// ==========================================
export async function validateApiKey(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const apiKeyValue =
      (req.headers['x-api-key'] as string) ||
      (typeof (req.body as any)?.apiKey === 'string' ? (req.body as any).apiKey : undefined);

    if (!apiKeyValue) {
      logger.warn({ ip: req.ip, path: req.path }, '⚠️  API key missing');
      return res.status(401).json({
        success: false,
        error: 'API key no proporcionada. Usa header "x-api-key"',
      });
    }

    const apiKey = await apiKeyModel.validate(apiKeyValue);

    if (!apiKey) {
      logger.warn({
        ip: req.ip,
        path: req.path,
        keyPrefix: apiKeyValue.slice(0, 10)
      }, '⚠️  Invalid API key');
      
      return res.status(401).json({
        success: false,
        error: 'API key inválida o inactiva',
      });
    }

    req.apiKey = {
      id: apiKey.id,
      name: apiKey.name,
    };

    logger.info({
      ip: req.ip,
      path: req.path,
      apiKeyName: apiKey.name,
      apiKeyId: apiKey.id
    }, '✅ Valid API key');

    next();
  } catch (error) {
    logger.error({ err: error, path: req.path }, '❌ Error validating API key');
    return res.status(500).json({
      success: false,
      error: 'Error al validar API key',
    });
  }
}