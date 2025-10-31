// src/routes/blocked.ts - VERSIÓN CORREGIDA
import express from 'express';
import multer from 'multer';
import XLSX from 'xlsx';
import * as blockedModel from '../../models/blocked.js';
import { logger } from '../../utils/logger.js';

const router = express.Router();

const upload = multer({ 
  storage: multer.memoryStorage(),
  fileFilter: (req, file, cb) => {
    const allowedTypes = [
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    ];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Solo se permiten archivos Excel (.xls, .xlsx)'));
    }
  },
  limits: { fileSize: 5 * 1024 * 1024 }
});

// Ver página de bloqueados
router.get('/', async (req, res) => {
  try {
    const blocked = await blockedModel.getAll();
    res.render('blocked', { 
      title: 'Bloqueados',
      blocked,
      page: 'blocked'
    });
  } catch (error) {
    logger.error('Error loading blocked:', error);
    res.status(500).send('Error loading blocked numbers');
  }
});

// API: Obtener bloqueados
router.get('/api', async (req, res) => {
  try {
    const blocked = await blockedModel.getAll();
    res.json(blocked);
  } catch (error) {
    logger.error('Error getting blocked:', error);
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
    logger.error('Error getting permissions:', error);
    res.status(500).json({ error: 'Error getting permissions' });
  }
});

// API: Bloquear número/grupo con nivel de acceso
// 🔧 ENDPOINT CORREGIDO
router.post('/api', async (req, res) => {
  try {
    logger.info('POST /blocked/api - Request body:', req.body);
    
    const { identifier, type, reason, accessLevel } = req.body;
    
    // Validaciones detalladas
    if (!identifier) {
      logger.warn('POST /blocked/api - Missing identifier');
      return res.status(400).json({ 
        success: false,
        error: 'El campo "identifier" es requerido' 
      });
    }

    if (!type) {
      logger.warn('POST /blocked/api - Missing type');
      return res.status(400).json({ 
        success: false,
        error: 'El campo "type" es requerido' 
      });
    }

    if (type !== 'PHONE' && type !== 'GROUP') {
      logger.warn('POST /blocked/api - Invalid type:', type);
      return res.status(400).json({ 
        success: false,
        error: 'El tipo debe ser "PHONE" o "GROUP"' 
      });
    }

    // Validar accessLevel si viene
    if (accessLevel) {
      const validLevels = ['BLOCKED', 'RESTRICTED', 'LIMITED', 'STANDARD', 'FULL', 'VIP'];
      if (!validLevels.includes(accessLevel)) {
        logger.warn('POST /blocked/api - Invalid accessLevel:', accessLevel);
        return res.status(400).json({ 
          success: false,
          error: `Nivel de acceso inválido. Debe ser uno de: ${validLevels.join(', ')}` 
        });
      }
    }

    // Verificar si ya existe
    const existing = await blockedModel.getPermissions(identifier);
    if (existing && existing.accessLevel !== 'FULL') {
      logger.warn('POST /blocked/api - Identifier already blocked:', identifier);
      return res.status(400).json({ 
        success: false,
        error: 'Este identificador ya está en la lista de restricciones' 
      });
    }

    // Crear registro
    const result = await blockedModel.block(
      identifier, 
      type as 'PHONE' | 'GROUP',
      reason || 'Bloqueado desde panel web',
      (accessLevel as any) || 'BLOCKED'
    );
    
    logger.info('POST /blocked/api - Successfully blocked:', identifier);
    res.json({ 
      success: true, 
      message: 'Restricción agregada exitosamente',
      data: result
    });
    
  } catch (error: any) {
    logger.error('Error blocking:', error);
    res.status(500).json({ 
      success: false,
      error: error.message || 'Error al agregar restricción' 
    });
  }
});

// API: Establecer nivel de acceso
router.put('/api/:identifier/access-level', async (req, res) => {
  try {
    const identifier = decodeURIComponent(req.params.identifier);
    const { accessLevel, reason, blockedBy } = req.body;
    
    if (!accessLevel) {
      return res.status(400).json({ error: 'accessLevel es requerido' });
    }

    await blockedModel.setAccessLevel(identifier, accessLevel, reason, blockedBy);
    res.json({ success: true, message: 'Nivel de acceso actualizado' });
  } catch (error) {
    logger.error('Error setting access level:', error);
    res.status(500).json({ error: 'Error al establecer nivel de acceso' });
  }
});

// API: Establecer permisos personalizados
router.put('/api/:identifier/permissions', async (req, res) => {
  try {
    const identifier = decodeURIComponent(req.params.identifier);
    const permissions = req.body;
    
    await blockedModel.setCustomPermissions(identifier, permissions);
    res.json({ success: true, message: 'Permisos actualizados' });
  } catch (error) {
    logger.error('Error setting permissions:', error);
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
    logger.error('Error unblocking:', error);
    res.status(500).json({ error: 'Error al desbloquear' });
  }
});

// API: Importar desde Excel
router.post('/api/import', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No se proporcionó ningún archivo' });
    }

    logger.info(`Importing Excel file: ${req.file.originalname}`);

    const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    const data = XLSX.utils.sheet_to_json(worksheet);

    if (data.length === 0) {
      return res.status(400).json({ error: 'El archivo está vacío' });
    }

    const entries = [];
    const validationErrors = [];

    data.forEach((row, index) => {
      const rowNum = index + 2;
      
      const identifier = row.identifier || row.numero || row.telefono;
      const type = row.type || row.tipo;
      const reason = row.reason || row.razon || row.motivo;
      const accessLevel = row.accessLevel || row.nivel || 'BLOCKED';

      if (!identifier) {
        validationErrors.push(`Fila ${rowNum}: falta identifier`);
        return;
      }

      if (!type) {
        validationErrors.push(`Fila ${rowNum}: falta type`);
        return;
      }

      const normalizedType = type.toString().toUpperCase().trim();
      if (normalizedType !== 'PHONE' && normalizedType !== 'GROUP') {
        validationErrors.push(`Fila ${rowNum}: tipo debe ser PHONE o GROUP`);
        return;
      }

      const normalizedAccessLevel = accessLevel.toString().toUpperCase().trim();
      const validLevels = ['BLOCKED', 'RESTRICTED', 'LIMITED', 'STANDARD', 'FULL', 'VIP'];
      if (!validLevels.includes(normalizedAccessLevel)) {
        validationErrors.push(`Fila ${rowNum}: accessLevel debe ser uno de: ${validLevels.join(', ')}`);
        return;
      }

      entries.push({
        identifier: identifier.toString().trim(),
        type: normalizedType,
        reason: reason ? reason.toString().trim() : 'Importado desde Excel',
        accessLevel: normalizedAccessLevel
      });
    });

    if (validationErrors.length > 0) {
      return res.status(400).json({ 
        error: 'Errores de validación',
        details: validationErrors 
      });
    }

    const results = await blockedModel.blockMultiple(entries);

    res.json({
      success: true,
      message: 'Importación completada',
      stats: {
        total: entries.length,
        success: results.success,
        failed: results.failed
      },
      errors: results.errors
    });

  } catch (error) {
    logger.error('Error importing Excel:', error);
    res.status(500).json({ error: 'Error al importar archivo' });
  }
});

// API: Descargar plantilla Excel
router.get('/api/template', (req, res) => {
  try {
    const templateData = [
      { 
        identifier: '51987654321', 
        type: 'PHONE', 
        accessLevel: 'BLOCKED',
        reason: 'Spam' 
      },
      { 
        identifier: '51912345678', 
        type: 'PHONE', 
        accessLevel: 'LIMITED',
        reason: 'Sin acceso a Odoo' 
      },
      { 
        identifier: '51999888777', 
        type: 'PHONE', 
        accessLevel: 'RESTRICTED',
        reason: 'Solo info básica' 
      }
    ];

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(templateData);
    
    ws['!cols'] = [
      { wch: 30 }, // identifier
      { wch: 10 }, // type
      { wch: 15 }, // accessLevel
      { wch: 40 }  // reason
    ];

    XLSX.utils.book_append_sheet(wb, ws, 'Bloqueados');
    
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    
    res.setHeader('Content-Disposition', 'attachment; filename=plantilla_bloqueados.xlsx');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buffer);

    logger.info('Template Excel downloaded');
  } catch (error) {
    logger.error('Error generating template:', error);
    res.status(500).json({ error: 'Error al generar plantilla' });
  }
});

// API: Exportar bloqueados a Excel
router.get('/api/export', async (req, res) => {
  try {
    const blocked = await blockedModel.getAll();
    
    if (blocked.length === 0) {
      return res.status(404).json({ error: 'No hay registros para exportar' });
    }

    const exportData = blocked.map(item => ({
      identifier: item.identifier,
      type: item.type,
      accessLevel: item.accessLevel,
      canUseOdoo: item.canUseOdoo,
      canCreateTickets: item.canCreateTickets,
      canUseAI: item.canUseAI,
      reason: item.reason || '',
      blockedAt: new Date(item.blockedAt).toLocaleString('es-PE')
    }));

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(exportData);
    
    ws['!cols'] = [
      { wch: 30 }, // identifier
      { wch: 10 }, // type
      { wch: 15 }, // accessLevel
      { wch: 12 }, // canUseOdoo
      { wch: 15 }, // canCreateTickets
      { wch: 10 }, // canUseAI
      { wch: 40 }, // reason
      { wch: 20 }  // blockedAt
    ];

    XLSX.utils.book_append_sheet(wb, ws, 'Bloqueados');
    
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    
    const filename = `bloqueados_${new Date().toISOString().split('T')[0]}.xlsx`;
    res.setHeader('Content-Disposition', `attachment; filename=${filename}`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buffer);

    logger.info(`Exported ${blocked.length} blocked entries to Excel`);
  } catch (error) {
    logger.error('Error exporting to Excel:', error);
    res.status(500).json({ error: 'Error al exportar datos' });
  }
});

export default router;