import express from 'express';
import multer from 'multer';
import XLSX from 'xlsx';
import * as blockedModel from '../../models/blocked.js';
import { logger } from '../../utils/logger.js';

const router = express.Router();

// Configurar multer para archivos en memoria
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
  limits: { fileSize: 5 * 1024 * 1024 } // 5MB máximo
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

// API: Bloquear número/grupo
router.post('/api', async (req, res) => {
  try {
    const { identifier, type, reason } = req.body;
    
    if (!identifier || !type) {
      return res.status(400).json({ error: 'identifier y type son requeridos' });
    }

    if (type !== 'PHONE' && type !== 'GROUP') {
      return res.status(400).json({ error: 'type debe ser PHONE o GROUP' });
    }

    await blockedModel.block(identifier, type, reason || 'Bloqueado desde panel web');
    res.json({ success: true, message: 'Bloqueado exitosamente' });
  } catch (error) {
    logger.error('Error blocking:', error);
    res.status(500).json({ error: 'Error al bloquear' });
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

    logger.info(`Importing Excel file: ${req.file.originalname}, size: ${req.file.size} bytes`);

    // Leer el archivo Excel
    const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    
    // Convertir a JSON
    const data = XLSX.utils.sheet_to_json(worksheet);

    if (data.length === 0) {
      return res.status(400).json({ error: 'El archivo está vacío o no tiene datos' });
    }

    logger.info(`Excel file parsed: ${data.length} rows found`);

    // Validar y transformar datos
    const entries = [];
    const validationErrors = [];

    data.forEach((row, index) => {
      const rowNum = index + 2; // +2 porque Excel empieza en 1 y hay header
      
      // Buscar columnas (flexible con nombres en español e inglés)
      const identifier = row.identifier || row.numero || row.telefono || 
                        row.Identifier || row.Número || row.Telefono || row.id;
      const type = row.type || row.tipo || row.Type || row.Tipo;
      const reason = row.reason || row.razon || row.motivo || 
                     row.Reason || row.Razón || row.Motivo || row.descripcion;

      if (!identifier) {
        validationErrors.push(`Fila ${rowNum}: falta columna 'identifier' o 'numero'`);
        return;
      }

      if (!type) {
        validationErrors.push(`Fila ${rowNum}: falta columna 'type' o 'tipo'`);
        return;
      }

      const normalizedType = type.toString().toUpperCase().trim();
      if (normalizedType !== 'PHONE' && normalizedType !== 'GROUP') {
        validationErrors.push(`Fila ${rowNum}: tipo debe ser PHONE o GROUP (actual: ${type})`);
        return;
      }

      entries.push({
        identifier: identifier.toString().trim(),
        type: normalizedType,
        reason: reason ? reason.toString().trim() : 'Importado desde Excel'
      });
    });

    if (validationErrors.length > 0) {
      logger.warn('Validation errors in Excel import:', validationErrors);
      return res.status(400).json({ 
        error: 'Errores de validación en el archivo',
        details: validationErrors 
      });
    }

    if (entries.length === 0) {
      return res.status(400).json({ 
        error: 'No se encontraron registros válidos para importar' 
      });
    }

    logger.info(`Validated ${entries.length} entries, starting bulk block...`);

    // Importar los datos
    const results = await blockedModel.blockMultiple(entries);

    logger.info(`Import completed: ${results.success} success, ${results.failed} failed`);

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
    res.status(500).json({ 
      error: 'Error al importar archivo',
      details: error.message 
    });
  }
});

// API: Descargar plantilla Excel
router.get('/api/template', (req, res) => {
  try {
    const wb = XLSX.utils.book_new();
    
    // Datos de ejemplo
    const templateData = [
      { 
        identifier: '51987654321', 
        type: 'PHONE', 
        reason: 'Spam - Mensajes no deseados' 
      },
      { 
        identifier: '51912345678', 
        type: 'PHONE', 
        reason: 'Usuario bloqueado manualmente' 
      },
      { 
        identifier: '120363123456789012@g.us', 
        type: 'GROUP', 
        reason: 'Grupo no autorizado' 
      },
      { 
        identifier: '51999888777', 
        type: 'PHONE', 
        reason: 'Acoso' 
      }
    ];

    const ws = XLSX.utils.json_to_sheet(templateData);
    
    // Ajustar ancho de columnas
    ws['!cols'] = [
      { wch: 30 }, // identifier
      { wch: 10 }, // type
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
      reason: item.reason || '',
      blockedAt: new Date(item.blockedAt).toLocaleString('es-PE')
    }));

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(exportData);
    
    // Ajustar ancho de columnas
    ws['!cols'] = [
      { wch: 30 }, // identifier
      { wch: 10 }, // type
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