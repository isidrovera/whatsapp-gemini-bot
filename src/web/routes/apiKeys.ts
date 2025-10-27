// src/web/routes/apiKeys.ts
import express, { Request, Response } from 'express';
import { requireAuth } from '../middleware/auth.js';
import * as apiKeyModel from '../../models/apiKeys.js';
import { logger } from '../../utils/logger.js';

const router = express.Router();

/**
 * GET /api-keys
 * Lista todas las API keys (protegido, solo admins)
 */
router.get('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const keys = await apiKeyModel.list();

    // Mostrar solo parcial de la clave
    const sanitizedKeys = keys.map(k => ({
      ...k,
      key: `${k.key.substring(0, 15)}...${k.key.substring(k.key.length - 4)}`,
    }));

    res.json({
      success: true,
      data: sanitizedKeys,
    });
  } catch (error: any) {
    logger.error('[API-KEYS] Error listing keys:', error);
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
router.post('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const { name, description, expiresAt } = req.body;

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
  } catch (error: any) {
    logger.error('[API-KEYS] Error creating key:', error);
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
    const { id } = req.params;
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
  } catch (error: any) {
    logger.error('[API-KEYS] Error deactivating key:', error);
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
    const { id } = req.params;
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
  } catch (error: any) {
    logger.error('[API-KEYS] Error activating key:', error);
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
    const { id } = req.params;
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
  } catch (error: any) {
    logger.error('[API-KEYS] Error deleting key:', error);
    res.status(500).json({
      success: false,
      error: 'Error al eliminar API key',
    });
  }
});

export default router;
