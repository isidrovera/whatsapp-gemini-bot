// src/web/routes/blocked.ts
import express from 'express';
import multer, { FileFilterCallback } from 'multer';
import * as XLSX from 'xlsx';
import * as blockedModel from '../../models/blocked.js';
import { logger } from '../../utils/logger.js';

const router = express.Router();

type AccessLevel =
  | 'BLOCKED'
  | 'RESTRICTED'
  | 'LIMITED'
  | 'STANDARD'
  | 'FULL'
  | 'VIP';

type BlockEntry = {
  identifier: string;
  type: 'PHONE' | 'GROUP';
  reason: string;
  accessLevel: AccessLevel;
};

type ImportRow = {
  identifier?: unknown;
  numero?: unknown;
  telefono?: unknown;
  type?: unknown;
  tipo?: unknown;
  reason?: unknown;
  razon?: unknown;
  motivo?: unknown;
  accessLevel?: unknown;
  nivel?: unknown;
};

const VALID_LEVELS: AccessLevel[] = [
  'BLOCKED',
  'RESTRICTED',
  'LIMITED',
  'STANDARD',
  'FULL',
  'VIP',
];

const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter: (_req: express.Request, file: Express.Multer.File, cb: FileFilterCallback) => {
    const allowedTypes = new Set([
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ]);
    if (allowedTypes.has(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Solo se permiten archivos Excel (.xls, .xlsx)'));
    }
  },
  limits: { fileSize: 5 * 1024 * 1024 },
});

// Ver página de bloqueados
router.get('/', async (_req, res) => {
  try {
    const blocked = await blockedModel.getAll();
    res.render('blocked', {
      title: 'Bloqueados',
      blocked,
      page: 'blocked',
    });
  } catch (error) {
    logger.error({ err: error }, 'Error loading blocked');
    res.status(500).send('Error loading blocked numbers');
  }
});

// API: Obtener bloqueados
router.get('/api', async (_req, res) => {
  try {
    const blocked = await blockedModel.getAll();
    res.json(blocked);
  } catch (error) {
    logger.error({ err: error }, 'Error getting blocked');
    res.status(500).json({ error: 'Error getting blocked' });
  }
});

// API: Obtener permisos de un número
router.get('/api/permissions/:identifier', async (req, res) => {
  try {
    const identifier = decodeURIComponent(req.params.identifier);
    const permissions = await blockedModel.getPermissions(identifier);
    res.json(permissions);
  } catch (error) {
    logger.error({ err: error }, 'Error getting permissions');
    res.status(500).json({ error: 'Error getting permissions' });
  }
});

// API: Bloquear número/grupo con nivel de acceso
router.post('/api', async (req, res) => {
  try {
    logger.info({ body: req.body }, 'POST /blocked/api');

    const { identifier, type, reason, accessLevel } = req.body as {
      identifier?: string;
      type?: string;
      reason?: string;
      accessLevel?: string;
    };

    // Validaciones
    if (!identifier?.trim()) {
      logger.warn({}, 'POST /blocked/api - Missing identifier');
      return res.status(400).json({
        success: false,
        error: 'El campo "identifier" es requerido',
      });
    }

    if (!type?.trim()) {
      logger.warn({}, 'POST /blocked/api - Missing type');
      return res.status(400).json({
        success: false,
        error: 'El campo "type" es requerido',
      });
    }

    const normalizedType = type.toUpperCase().trim();
    if (normalizedType !== 'PHONE' && normalizedType !== 'GROUP') {
      logger.warn({ type }, 'POST /blocked/api - Invalid type');
      return res.status(400).json({
        success: false,
        error: 'El tipo debe ser "PHONE" o "GROUP"',
      });
    }

    let level: AccessLevel = 'BLOCKED';
    if (accessLevel?.trim()) {
      const normalized = accessLevel.toUpperCase().trim() as AccessLevel;
      if (!VALID_LEVELS.includes(normalized)) {
        logger.warn({ accessLevel }, 'POST /blocked/api - Invalid accessLevel');
        return res.status(400).json({
          success: false,
          error: `Nivel de acceso inválido. Debe ser uno de: ${VALID_LEVELS.join(', ')}`,
        });
      }
      level = normalized;
    }

    // Verificar si ya existe con restricción
    const existing = await blockedModel.getPermissions(identifier);
    if (existing && existing.accessLevel !== 'FULL') {
      logger.warn({ identifier }, 'POST /blocked/api - Identifier already restricted');
      return res.status(400).json({
        success: false,
        error: 'Este identificador ya está en la lista de restricciones',
      });
    }

    // Crear registro
    const result = await blockedModel.block(
      identifier.trim(),
      normalizedType as 'PHONE' | 'GROUP',
      reason?.trim() || 'Bloqueado desde panel web',
      level
    );

    logger.info({ identifier }, 'POST /blocked/api - Blocked successfully');
    res.json({
      success: true,
      message: 'Restricción agregada exitosamente',
      data: result,
    });
  } catch (error: any) {
    logger.error({ err: error }, 'Error blocking');
    res.status(500).json({
      success: false,
      error: error?.message || 'Error al agregar restricción',
    });
  }
});

// API: Establecer nivel de acceso
router.put('/api/:identifier/access-level', async (req, res) => {
  try {
    const identifier = decodeURIComponent(req.params.identifier);
    const { accessLevel, reason, blockedBy } = req.body as {
      accessLevel?: string;
      reason?: string;
      blockedBy?: string;
    };

    if (!accessLevel?.trim()) {
      return res.status(400).json({ error: 'accessLevel es requerido' });
    }

    const normalized = accessLevel.toUpperCase().trim() as AccessLevel;
    if (!VALID_LEVELS.includes(normalized)) {
      return res.status(400).json({
        error: `Nivel de acceso inválido. Debe ser uno de: ${VALID_LEVELS.join(', ')}`,
      });
    }

    await blockedModel.setAccessLevel(identifier, normalized, reason, blockedBy);
    res.json({ success: true, message: 'Nivel de acceso actualizado' });
  } catch (error) {
    logger.error({ err: error }, 'Error setting access level');
    res.status(500).json({ error: 'Error al establecer nivel de acceso' });
  }
});

// API: Establecer permisos personalizados
router.put('/api/:identifier/permissions', async (req, res) => {
  try {
    const identifier = decodeURIComponent(req.params.identifier);
    const permissions = req.body as Record<string, unknown>;

    await blockedModel.setCustomPermissions(identifier, permissions);
    res.json({ success: true, message: 'Permisos actualizados' });
  } catch (error) {
    logger.error({ err: error }, 'Error setting permissions');
    res.status(500).json({ error: 'Error al establecer permisos' });
  }
});

// API: Desbloquear
router.delete('/api/:identifier', async (req, res) => {
  try {
    const identifier = decodeURIComponent(req.params.identifier);
    await blockedModel.unblock(identifier);
    res.json({ success: true, message: 'Desbloqueado exitosamente' });
  } catch (error) {
    logger.error({ err: error }, 'Error unblocking');
    res.status(500).json({ error: 'Error al desbloquear' });
  }
});

// API: Importar desde Excel
router.post('/api/import', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No se proporcionó ningún archivo' });
    }

    logger.info({ filename: req.file.originalname, size: req.file.size }, 'Importing Excel file');

    const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    const data = XLSX.utils.sheet_to_json<ImportRow>(worksheet);

    if (data.length === 0) {
      return res.status(400).json({ error: 'El archivo está vacío' });
    }

    const entries: BlockEntry[] = [];
    const validationErrors: string[] = [];

    data.forEach((row, index) => {
      const rowNum = index + 2;

      const identifier =
        (row.identifier as string) ??
        (row.numero as string) ??
        (row.telefono as string);

      const type = (row.type as string) ?? (row.tipo as string);
      const reason =
        (row.reason as string) ??
        (row.razon as string) ??
        (row.motivo as string);
      const accessLevel =
        (row.accessLevel as string) ?? (row.nivel as string) ?? 'BLOCKED';

      if (!identifier || !String(identifier).trim()) {
        validationErrors.push(`Fila ${rowNum}: falta identifier`);
        return;
      }

      if (!type || !String(type).trim()) {
        validationErrors.push(`Fila ${rowNum}: falta type`);
        return;
      }

      const normalizedType = String(type).toUpperCase().trim();
      if (normalizedType !== 'PHONE' && normalizedType !== 'GROUP') {
        validationErrors.push(`Fila ${rowNum}: tipo debe ser PHONE o GROUP`);
        return;
      }

      const normalizedAccessLevel = String(accessLevel).toUpperCase().trim() as AccessLevel;
      if (!VALID_LEVELS.includes(normalizedAccessLevel)) {
        validationErrors.push(
          `Fila ${rowNum}: accessLevel debe ser uno de: ${VALID_LEVELS.join(', ')}`
        );
        return;
      }

      entries.push({
        identifier: String(identifier).trim(),
        type: normalizedType as 'PHONE' | 'GROUP',
        reason: reason ? String(reason).trim() : 'Importado desde Excel',
        accessLevel: normalizedAccessLevel,
      });
    });

    if (validationErrors.length > 0) {
      return res.status(400).json({
        error: 'Errores de validación',
        details: validationErrors,
      });
    }

    const results = await blockedModel.blockMultiple(entries);

    res.json({
      success: true,
      message: 'Importación completada',
      stats: {
        total: entries.length,
        success: (results as any)?.success ?? 0,
        failed: (results as any)?.failed ?? 0,
      },
      errors: (results as any)?.errors ?? [],
    });
  } catch (error) {
    logger.error({ err: error }, 'Error importing Excel');
    res.status(500).json({ error: 'Error al importar archivo' });
  }
});

// API: Descargar plantilla Excel
router.get('/api/template', (_req, res) => {
  try {
    const templateData: Array<{
      identifier: string;
      type: 'PHONE' | 'GROUP';
      accessLevel: AccessLevel;
      reason: string;
    }> = [
      {
        identifier: '51987654321',
        type: 'PHONE',
        accessLevel: 'BLOCKED',
        reason: 'Spam',
      },
      {
        identifier: '51912345678',
        type: 'PHONE',
        accessLevel: 'LIMITED',
        reason: 'Sin acceso a Odoo',
      },
      {
        identifier: '51999888777',
        type: 'PHONE',
        accessLevel: 'RESTRICTED',
        reason: 'Solo info básica',
      },
    ];

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(templateData);

    (ws as any)['!cols'] = [
      { wch: 30 }, // identifier
      { wch: 10 }, // type
      { wch: 15 }, // accessLevel
      { wch: 40 }, // reason
    ];

    XLSX.utils.book_append_sheet(wb, ws, 'Bloqueados');

    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    res.setHeader(
      'Content-Disposition',
      'attachment; filename=plantilla_bloqueados.xlsx'
    );
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.send(buffer);

    logger.info({}, 'Template Excel downloaded');
  } catch (error) {
    logger.error({ err: error }, 'Error generating template');
    res.status(500).json({ error: 'Error al generar plantilla' });
  }
});

// API: Exportar bloqueados a Excel
router.get('/api/export', async (_req, res) => {
  try {
    const blocked = await blockedModel.getAll();

    if (blocked.length === 0) {
      return res.status(404).json({ error: 'No hay registros para exportar' });
    }

    const exportData = blocked.map((item: any) => ({
      identifier: item.identifier,
      type: item.type,
      accessLevel: item.accessLevel,
      canUseOdoo: item.canUseOdoo,
      canCreateTickets: item.canCreateTickets,
      canUseAI: item.canUseAI,
      reason: item.reason || '',
      blockedAt: new Date(item.blockedAt).toLocaleString('es-PE'),
    }));

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(exportData);

    (ws as any)['!cols'] = [
      { wch: 30 }, // identifier
      { wch: 10 }, // type
      { wch: 15 }, // accessLevel
      { wch: 12 }, // canUseOdoo
      { wch: 15 }, // canCreateTickets
      { wch: 10 }, // canUseAI
      { wch: 40 }, // reason
      { wch: 20 }, // blockedAt
    ];

    XLSX.utils.book_append_sheet(wb, ws, 'Bloqueados');

    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    const filename = `bloqueados_${new Date().toISOString().split('T')[0]}.xlsx`;
    res.setHeader('Content-Disposition', `attachment; filename=${filename}`);
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.send(buffer);

    logger.info({ count: blocked.length }, 'Exported blocked entries to Excel');
  } catch (error) {
    logger.error({ err: error }, 'Error exporting to Excel');
    res.status(500).json({ error: 'Error al exportar datos' });
  }
});

export default router;
