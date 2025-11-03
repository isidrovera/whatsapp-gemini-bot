// src/web/routes/contacts.ts
import express from 'express';
import ExcelJS from 'exceljs';
import multer from 'multer';
import * as contactModel from '../../models/contact.js';
import { logger } from '../../utils/logger.js';
import { getPrismaClient } from '../../config/database.js';

const prisma = getPrismaClient();
const router = express.Router();

// Configurar multer para manejar uploads en memoria
const upload = multer({ storage: multer.memoryStorage() });

/* -------------------------
 * VISTA PRINCIPAL
 * ------------------------- */

// Ver página de contactos
router.get('/', async (req, res) => {
  try {
    const contacts = await contactModel.getAll();
    res.render('contacts', { 
      title: 'Contactos',
      contacts 
    });
  } catch (error) {
    logger.error({ err: error },'Error loading contacts:');
    res.status(500).send('Error loading contacts');
  }
});

// Vincular una empresa ya existente por companyId
router.post('/api/:contactId/company/link-existing', async (req, res) => {
  try {
    const { companyId, role, primary } = req.body;

    if (!companyId) {
      return res.status(400).json({ error: 'companyId requerido' });
    }

    const pivot = await contactModel.linkExistingCompanyToContact(
      req.params.contactId,
      {
        companyId,
        role,
        isPrimary: !!primary,
      }
    );

    res.json({ success: true, pivot });
  } catch (error) {
    logger.error({ err: error },'Error linking existing company to contact:');
    res.status(500).json({ error: 'Error linking existing company to contact' });
  }
});

/* -------------------------
 * API BÁSICA
 * ------------------------- */

// API: Obtener todos los contactos
router.get('/api', async (req, res) => {
  try {
    const { limit, offset } = req.query;
    const contacts = await contactModel.getAll(
      limit ? parseInt(String(limit), 10) : undefined,
      offset ? parseInt(String(offset), 10) : undefined
    );
    res.json(contacts);
  } catch (error) {
    logger.error({ err: error },'Error getting contacts:');
    res.status(500).json({ error: 'Error getting contacts' });
  }
});

// API: Obtener un contacto (por phoneNumber)
router.get('/api/:phoneNumber', async (req, res) => {
  try {
    const contact = await contactModel.findByPhone(req.params.phoneNumber);
    if (!contact) {
      return res.status(404).json({ error: 'Contact not found' });
    }
    res.json(contact);
  } catch (error) {
    logger.error({ err: error },'Error getting contact:');
    res.status(500).json({ error: 'Error getting contact' });
  }
});

/* -------------------------
 * ESTADO / BLOQUEO / TAKEOVER
 * ------------------------- */

// API: Actualizar estado
router.put('/api/:phoneNumber/state', async (req, res) => {
  try {
    const { state } = req.body;
    await contactModel.updateState(req.params.phoneNumber, state);
    res.json({ success: true, message: 'Estado actualizado' });
  } catch (error) {
    logger.error({ err: error },'Error updating state:');
    res.status(500).json({ error: 'Error updating state' });
  }
});

// API: Bloquear contacto
router.post('/api/:phoneNumber/block', async (req, res) => {
  try {
    const { reason } = req.body;
    await contactModel.blockContact(req.params.phoneNumber, reason || 'Bloqueado desde panel web');
    res.json({ success: true, message: 'Contacto bloqueado' });
  } catch (error) {
    logger.error({ err: error },'Error blocking contact:');
    res.status(500).json({ error: 'Error blocking contact' });
  }
});

// API: Desbloquear contacto
router.post('/api/:phoneNumber/unblock', async (req, res) => {
  try {
    await contactModel.unblockContact(req.params.phoneNumber);
    res.json({ success: true, message: 'Contacto desbloqueado' });
  } catch (error) {
    logger.error({ err: error },'Error unblocking contact:');
    res.status(500).json({ error: 'Error unblocking contact' });
  }
});

// API: Activar takeover
router.post('/api/:phoneNumber/takeover', async (req, res) => {
  try {
    await contactModel.setHumanTakeover(req.params.phoneNumber);
    res.json({ success: true, message: 'Takeover activado' });
  } catch (error) {
    logger.error({ err: error },'Error setting takeover:');
    res.status(500).json({ error: 'Error setting takeover' });
  }
});

// API: Liberar takeover
router.post('/api/:phoneNumber/release', async (req, res) => {
  try {
    await contactModel.releaseHumanTakeover(req.params.phoneNumber);
    res.json({ success: true, message: 'Takeover liberado' });
  } catch (error) {
    logger.error({ err: error },'Error releasing takeover:');
    res.status(500).json({ error: 'Error releasing takeover' });
  }
});

/* -------------------------
 * MULTIEMPRESA
 * ------------------------- */

// Agregar/actualizar una empresa en un contacto
router.post('/api/:contactId/company', async (req, res) => {
  try {
    const { ruc, name, role, primary } = req.body;

    const pivot = await contactModel.addCompanyToContact(req.params.contactId, {
      ruc,
      name,
      role,
      isPrimary: !!primary,
    });

    res.json({ success: true, pivot });
  } catch (error) {
    logger.error({ err: error },'Error adding company to contact:');
    res.status(500).json({ error: 'Error adding company to contact' });
  }
});

// Marcar una empresa como primaria
router.post('/api/:contactId/company/:companyId/primary', async (req, res) => {
  try {
    await contactModel.setPrimaryCompany(req.params.contactId, req.params.companyId);
    res.json({ success: true, message: 'Empresa principal actualizada' });
  } catch (error) {
    logger.error({ err: error },'Error setting primary company:');
    res.status(500).json({ error: 'Error setting primary company' });
  }
});

// Quitar empresa de un contacto
router.delete('/api/:contactId/company/:companyId', async (req, res) => {
  try {
    await contactModel.removeCompanyFromContact(req.params.contactId, req.params.companyId);
    res.json({ success: true, message: 'Empresa removida del contacto' });
  } catch (error) {
    logger.error({ err: error },'Error removing company from contact:');
    res.status(500).json({ error: 'Error removing company from contact' });
  }
});

/* -------------------------
 * EDITAR / ELIMINAR CONTACTO
 * ------------------------- */

// Editar info manual del contacto
router.put('/api/contact/:contactId', async (req, res) => {
  try {
    const updated = await contactModel.updateContactInfo(req.params.contactId, req.body);
    res.json({ success: true, contact: updated });
  } catch (error) {
    logger.error({ err: error },'Error updating contact info:');
    res.status(500).json({ error: 'Error updating contact info' });
  }
});

// Eliminar contacto completo
router.delete('/api/contact/:contactId', async (req, res) => {
  try {
    await contactModel.deleteContact(req.params.contactId);
    res.json({ success: true, message: 'Contacto eliminado' });
  } catch (error) {
    logger.error({ err: error },'Error deleting contact:');
    res.status(500).json({ error: 'Error deleting contact' });
  }
});

/* -------------------------
 * IMPORT / EXPORT
 * ------------------------- */

// Exportar contactos para Excel
router.get('/api-export', async (req, res) => {
  try {
    const data = await contactModel.exportContactsToExcelData();
    
    // Crear workbook
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Contactos');
    
    // Definir columnas basadas en la estructura de tus datos
    // Ajusta estas columnas según lo que devuelva exportContactsToExcelData()
    const firstRow = data[0] || {};
    const columns = Object.keys(firstRow).map(key => ({
      header: key.charAt(0).toUpperCase() + key.slice(1),
      key: key,
      width: 20
    }));
    
    worksheet.columns = columns;
    
    // Agregar datos
    data.forEach(row => {
      worksheet.addRow(row);
    });
    
    // Estilizar encabezados
    worksheet.getRow(1).font = { bold: true };
    worksheet.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFE0E0E0' }
    };
    
    // Configurar respuesta para descarga
    const timestamp = new Date().toISOString().split('T')[0];
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename=contactos-${timestamp}.xlsx`
    );
    
    // Escribir y enviar
    await workbook.xlsx.write(res);
    res.end();
    
  } catch (error) {
    logger.error({ err: error },'Error exporting contacts:');
    res.status(500).json({ error: 'Error exporting contacts' });
  }
});

// Importar contactos desde Excel parseado (JSON)
router.post('/api-import', async (req, res) => {
  try {
    const rows = req.body.rows;
    if (!Array.isArray(rows)) {
      return res.status(400).json({ error: 'rows must be an array' });
    }

    const result = await contactModel.importContactsFromExcel(rows);
    res.json({
      importedAt: new Date(),
      result,
    });
  } catch (error) {
    logger.error({ err: error },'Error importing contacts:');
    res.status(500).json({ error: 'Error importing contacts' });
  }
});

// NUEVA RUTA: Importar contactos desde archivo Excel (.xlsx)
router.post('/api-import-file', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No se recibió ningún archivo' });
    }

    // Leer el archivo Excel desde el buffer
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(req.file.buffer);
    
    const worksheet = workbook.getWorksheet(1); // Primera hoja
    if (!worksheet) {
      return res.status(400).json({ error: 'El archivo no contiene hojas de cálculo' });
    }

    // Parsear las filas del Excel
    const rows: Array<{
      phoneNumber: string;
      name?: string;
      dni?: string;
      companies?: Array<{
        ruc: string;
        name: string;
        role?: string;
        primary?: boolean;
      }>;
    }> = [];

    // Asumiendo que la primera fila son encabezados
    // Columnas esperadas: phoneNumber, name, dni, companyRuc, companyName, companyRole
    worksheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return; // Saltar encabezados

      const phoneNumber = row.getCell(1).value?.toString().trim();
      if (!phoneNumber) return; // Saltar filas sin teléfono

      const name = row.getCell(2).value?.toString().trim() || undefined;
      const dni = row.getCell(3).value?.toString().trim() || undefined;
      const companyRuc = row.getCell(4).value?.toString().trim();
      const companyName = row.getCell(5).value?.toString().trim();
      const companyRole = row.getCell(6).value?.toString().trim();

      const rowData: any = {
        phoneNumber,
        name,
        dni,
      };

      // Si tiene datos de empresa, agregarlos
      if (companyRuc && companyName) {
        rowData.companies = [{
          ruc: companyRuc,
          name: companyName,
          role: companyRole,
          primary: true,
        }];
      }

      rows.push(rowData);
    });

    if (rows.length === 0) {
      return res.status(400).json({ 
        error: 'El archivo no contiene datos válidos o está vacío' 
      });
    }

    // Importar usando la función existente
    const result = await contactModel.importContactsFromExcel(rows);

    res.json({
      success: true,
      importedAt: new Date(),
      totalRows: rows.length,
      result,
    });

  } catch (error) {
    logger.error({ err: error },'Error importing Excel file:');
    res.status(500).json({ 
      error: 'Error procesando el archivo Excel',
      details: error instanceof Error ? error.message : String(error)
    });
  }
});

// Listar todas las empresas existentes (para selector en modal)
router.get('/api-companies', async (_req, res) => {
  try {
    const companies = await prisma.company.findMany({
      orderBy: { name: 'asc' },
      select: {
        id: true,
        name: true,
        ruc: true,
      },
    });

    res.json({ ok: true, companies });
  } catch (error) {
    logger.error({ err: error },'Error listing companies:');
    res.status(500).json({ error: 'Error listing companies' });
  }
});

export default router;