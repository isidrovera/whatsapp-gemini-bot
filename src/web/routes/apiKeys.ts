// src/web/routes/apiKeys.ts
import express, { Request, Response } from 'express';
import { requireAuth } from '../middleware/auth.js';
import * as apiKeyModel from '../../models/apiKeys.js';
import { logger } from '../../utils/logger.js';

const router = express.Router();

// Tipado mínimo para acceder a session.userId sin que TS se queje
interface RequestWithSession extends Request {
  session: { userId?: string };
}

/**
 * GET /api-keys
 * Lista todas las API keys (protegido, solo admins)
 */
router.get('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const keys = await apiKeyModel.list();

    // Mostrar solo parcial de la clave (manejo seguro de longitudes)
    const sanitizedKeys = keys.map((k: any) => {
      const key = String(k.key ?? '');
      const head = key.substring(0, Math.min(15, key.length));
      const tail = key.length > 4 ? key.substring(key.length - 4) : key;
      return {
        ...k,
        key: `${head}...${tail}`,
      };
    });

    res.json({
      success: true,
      data: sanitizedKeys,
    });
  } catch (e) {
    logger.error({ err: e }, '[API-KEYS] Error listing keys');
    res.status(500).json({
      success: false,
      error: 'Error al listar API keys',
    });
  }
});

/**
 * POST /api-keys
 * Crea una nueva API key (protegido, solo admins)
 */
router.post('/', requireAuth, async (req: RequestWithSession, res: Response) => {
  try {
    const { name, description, expiresAt } = req.body as {
      name?: string;
      description?: string;
      expiresAt?: string;
    };

    if (!name) {
      return res.status(400).json({
        success: false,
        error: 'El campo "name" es requerido',
      });
    }

    const apiKey = await apiKeyModel.create(
      name,
      description,
      req.session.userId, // admin que la creó
      expiresAt ? new Date(expiresAt) : undefined
    );

    res.json({
      success: true,
      message: 'API key creada exitosamente',
      data: apiKey, // Aquí sí devolvemos la key completa UNA SOLA VEZ
    });
  } catch (e) {
    logger.error({ err: e }, '[API-KEYS] Error creating key');
    res.status(500).json({
      success: false,
      error: 'Error al crear API key',
    });
  }
});

/**
 * PATCH /api-keys/:id/deactivate
 * Desactiva una API key
 */
router.patch('/:id/deactivate', requireAuth, async (req: Request, res: Response) => {
  try {
    const { id } = req.params as { id: string };
    const ok = await apiKeyModel.deactivate(id);

    if (!ok) {
      return res.status(500).json({
        success: false,
        error: 'Error al desactivar API key',
      });
    }

    res.json({
      success: true,
      message: 'API key desactivada',
    });
  } catch (e) {
    logger.error({ err: e }, '[API-KEYS] Error deactivating key');
    res.status(500).json({
      success: false,
      error: 'Error al desactivar API key',
    });
  }
});

/**
 * PATCH /api-keys/:id/activate
 * Activa una API key
 */
router.patch('/:id/activate', requireAuth, async (req: Request, res: Response) => {
  try {
    const { id } = req.params as { id: string };
    const ok = await apiKeyModel.activate(id);

    if (!ok) {
      return res.status(500).json({
        success: false,
        error: 'Error al activar API key',
      });
    }

    res.json({
      success: true,
      message: 'API key activada',
    });
  } catch (e) {
    logger.error({ err: e }, '[API-KEYS] Error activating key');
    res.status(500).json({
      success: false,
      error: 'Error al activar API key',
    });
  }
});

/**
 * DELETE /api-keys/:id
 * Elimina una API key permanentemente
 */
router.delete('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const { id } = req.params as { id: string };
    const ok = await apiKeyModel.remove(id);

    if (!ok) {
      return res.status(500).json({
        success: false,
        error: 'Error al eliminar API key',
      });
    }

    res.json({
      success: true,
      message: 'API key eliminada',
    });
  } catch (e) {
    logger.error({ err: e }, '[API-KEYS] Error deleting key');
    res.status(500).json({
      success: false,
      error: 'Error al eliminar API key',
    });
  }
});

export default router;
