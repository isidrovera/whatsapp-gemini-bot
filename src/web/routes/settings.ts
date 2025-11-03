// src/web/routes/settings.ts
import express from 'express';
import * as configModel from '../../models/configuration.js';
import * as apiKeyModel from '../../models/apiKeys.js';
import { logger } from '../../utils/logger.js';
import { reinitializeGemini } from '../../config/gemini.js';

const router = express.Router();

// =======================================
// VISTA PRINCIPAL (EJS)
// =======================================
router.get('/', async (req, res) => {
  try {
    const configs = await configModel.getAll();

    // Agrupar por categoría para las tabs
    const grouped: { [category: string]: any[] } = {};
    for (const config of configs) {
      if (!grouped[config.category]) grouped[config.category] = [];
      grouped[config.category].push(config);
    }

    res.render('settings', {
      title: 'Configuración',
      grouped,
    });
  } catch (error) {
    logger.error({ err: error }, 'Error loading settings:');
    res.status(500).send('Error loading settings');
  }
});

// =======================================
// CONFIG (ya existentes)
// =======================================

router.get('/api', async (_req, res) => {
  try {
    const configs = await configModel.getAll();
    res.json(configs);
  } catch (error) {
    logger.error({ err: error }, 'Error getting all configs:');
    res.status(500).json({ error: 'Error getting configs' });
  }
});

router.get('/api/:category', async (req, res) => {
  try {
    const configs = await configModel.getByCategory(req.params.category);
    res.json(configs);
  } catch (error) {
    logger.error({ err: error }, 'Error getting configs:');
    res.status(500).json({ error: 'Error getting configs' });
  }
});

router.get('/api/:category/:key', async (req, res) => {
  try {
    const value = await configModel.get(req.params.category, req.params.key);
    res.json({ value });
  } catch (error) {
    logger.error({ err: error }, 'Error getting config:');
    res.status(500).json({ error: 'Error getting config' });
  }
});

// este sentinel se usa solo visualmente para campos encriptados
const SECRET_SENTINEL = '********';

router.post('/api', async (req, res) => {
  try {
    const { category, key, value, isEncrypted } = req.body;

    if (!category || !key) {
      return res.status(400).json({ error: 'category and key are required' });
    }

    if (isEncrypted === true && (!value || value === SECRET_SENTINEL)) {
      return res.json({ success: true, skipped: true });
    }

    await configModel.set(category, key, value || '', isEncrypted === true);
    res.json({ success: true });
  } catch (error) {
    logger.error({ err: error }, 'Error updating config:');
    res.status(500).json({ error: 'Error updating config' });
  }
});

router.post('/api/bulk', async (req, res) => {
  try {
    const { configs } = req.body; // Array de { category, key, value, isEncrypted }

    if (!Array.isArray(configs)) {
      return res.status(400).json({ error: 'configs must be an array' });
    }

    for (const c of configs) {
      if (!c?.category || !c?.key) continue;

      if (c.isEncrypted === true && (!c.value || c.value === SECRET_SENTINEL)) {
        continue;
      }

      await configModel.set(
        c.category,
        c.key,
        c.value || '',
        c.isEncrypted === true
      );
    }

    res.json({ success: true, message: 'Configurations updated successfully' });
  } catch (error) {
    logger.error({ err: error }, 'Error updating configs:');
    res.status(500).json({ error: 'Error updating configs' });
  }
});

router.get('/api/validate', async (_req, res) => {
  try {
    const validation = await configModel.validateCritical();
    res.json(validation);
  } catch (error) {
    logger.error({ err: error }, 'Error validating configs:');
    res.status(500).json({ error: 'Error validating configs' });
  }
});

router.get('/api/stats', async (_req, res) => {
  try {
    const stats = await configModel.getStats();
    res.json(stats);
  } catch (error) {
    logger.error({ err: error }, 'Error getting config stats:');
    res.status(500).json({ error: 'Error getting config stats' });
  }
});

router.get('/api/export', async (_req, res) => {
  try {
    const backup = await configModel.exportAll();
    if (!backup) {
      return res.status(500).json({ error: 'Error exporting configs' });
    }

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename=config-backup.json');
    res.send(backup);
  } catch (error) {
    logger.error({ err: error }, 'Error exporting configs:');
    res.status(500).json({ error: 'Error exporting configs' });
  }
});

router.post('/api/import', async (req, res) => {
  try {
    const { jsonData } = req.body;
    if (!jsonData) {
      return res.status(400).json({ error: 'JSON data is required' });
    }

    const success = await configModel.importAll(jsonData);
    if (success) {
      res.json({ success: true, message: 'Configurations imported successfully' });
    } else {
      res.status(500).json({ error: 'Error importing configurations' });
    }
  } catch (error) {
    logger.error({ err: error }, 'Error importing configs:');
    res.status(500).json({ error: 'Error importing configs' });
  }
});

router.post('/api/reset/:category', async (req, res) => {
  try {
    const success = await configModel.resetCategory(req.params.category);
    if (success) {
      res.json({
        success: true,
        message: `Category ${req.params.category} reset successfully`,
      });
    } else {
      res.status(500).json({ error: 'Error resetting category' });
    }
  } catch (error) {
    logger.error({ err: error }, 'Error resetting category:');
    res.status(500).json({ error: 'Error resetting category' });
  }
});

router.get('/api/check/:category/:key', async (req, res) => {
  try {
    const isConfigured = await configModel.isConfigured(
      req.params.category,
      req.params.key
    );
    res.json({ isConfigured });
  } catch (error) {
    logger.error({ err: error }, 'Error checking config:');
    res.status(500).json({ error: 'Error checking config' });
  }
});

router.post('/api/reinitialize/:service', async (req, res) => {
  const { service } = req.params;

  try {
    switch (service) {
      case 'gemini':
        await reinitializeGemini();
        return res.json({
          success: true,
          message: 'Gemini restarted successfully',
        });

      default:
        return res.status(400).json({
          success: false,
          error: `Servicio no soportado: ${service}`,
        });
    }
  } catch (err: any) {
    logger.error({ err }, 'Error reinitializing service:');
    return res.status(500).json({
      success: false,
      error: 'Error al reiniciar el servicio',
      detail: err?.message || String(err),
    });
  }
});

// =======================================
// API KEYS (panel API / Tokens)
// =======================================

// Listar todas las API keys
router.get('/api-keys', async (_req, res) => {
  try {
    const keys = await apiKeyModel.list();

    // Sanitizar preview (solo mostramos parte)
    const safe = keys.map((k: any) => ({
      id: k.id,
      name: k.name,
      preview:
        k.key.length > 24
          ? `${k.key.substring(0, 16)}…${k.key.substring(k.key.length - 4)}`
          : k.key,
      isActive: k.isActive,
      lastUsedAt: k.lastUsedAt,
      expiresAt: k.expiresAt,
      createdAt: k.createdAt,
      updatedAt: k.updatedAt,
    }));

    res.json({ success: true, data: safe });
  } catch (error: any) {
    logger.error({ err: error }, '[API-KEYS] Error listing keys:');
    res.status(500).json({
      success: false,
      error: 'Error al listar API keys',
    });
  }
});

// Crear nueva API key
// Devuelve la key COMPLETA una sola vez
router.post('/api-keys', async (req, res) => {
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
      req.session?.userId,
      expiresAt ? new Date(expiresAt) : undefined
    );

    res.json({
      success: true,
      data: {
        id: apiKey.id,
        name: apiKey.name,
        key: apiKey.key, // <-- mostrar COMPLETA solo aquí
        description: apiKey.description,
        isActive: apiKey.isActive,
        lastUsedAt: apiKey.lastUsedAt,
        expiresAt: apiKey.expiresAt,
        createdAt: apiKey.createdAt,
      },
    });
  } catch (error: any) {
    logger.error({ err: error }, '[API-KEYS] Error creating key:');
    res.status(500).json({
      success: false,
      error: 'Error al crear API key',
    });
  }
});

// Activar/desactivar
router.patch('/api-keys/:id/toggle', async (req, res) => {
  try {
    const { id } = req.params;
    const { enable } = req.body; // true/false

    let ok = false;
    if (enable === true) {
      ok = await apiKeyModel.activate(id);
    } else {
      ok = await apiKeyModel.deactivate(id);
    }

    if (!ok) {
      return res.status(500).json({
        success: false,
        error: 'No se pudo actualizar el estado',
      });
    }

    res.json({
      success: true,
      message: enable ? 'API key activada' : 'API key desactivada',
    });
  } catch (error: any) {
    logger.error({ err: error }, '[API-KEYS] Error toggling key:');
    res.status(500).json({
      success: false,
      error: 'Error al cambiar estado de la llave',
    });
  }
});

// Eliminar
router.delete('/api-keys/:id', async (req, res) => {
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
    logger.error({ err: error }, '[API-KEYS] Error deleting key:');
    res.status(500).json({
      success: false,
      error: 'Error al eliminar API key',
    });
  }
});

export default router;