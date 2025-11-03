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

router.get('/', async (req, res) => {
  try {
    const contacts = await contactModel.getAll();
    res.render('contacts', { title: 'Contactos', contacts });
  } catch (error) {
    logger.error({ err: error }, 'Error loading contacts:');
    res.status(500).send('Error loading contacts');
  }
});

// Vincular una empresa ya existente por companyId
router.post('/api/:contactId/company/link-existing', async (req, res) => {
  try {
    const { companyId, role, primary } = req.body;
    if (!companyId) return res.status(400).json({ error: 'companyId requerido' });

    const pivot = await contactModel.linkExistingCompanyToContact(req.params.contactId, {
      companyId,
      role,
      isPrimary: !!primary,
    });

    res.json({ success: true, pivot });
  } catch (error) {
    logger.error({ err: error }, 'Error linking existing company to contact:');
    res.status(500).json({ error: 'Error linking existing company to contact' });
  }
});

/* -------------------------
 * API BÁSICA
 * ------------------------- */

router.get('/api', async (req, res) => {
  try {
    const { limit, offset } = req.query as { limit?: string; offset?: string };
    const contacts = await contactModel.getAll(
      limit ? parseInt(String(limit), 10) : undefined,
      offset ? parseInt(String(offset), 10) : undefined
    );
    res.json(contacts);
  } catch (error) {
    logger.error({ err: error }, 'Error getting contacts:');
    res.status(500).json({ error: 'Error getting contacts' });
  }
});

router.get('/api/:phoneNumber', async (req, res) => {
  try {
    const contact = await contactModel.findByPhone(req.params.phoneNumber);
    if (!contact) return res.status(404).json({ error: 'Contact not found' });
    res.json(contact);
  } catch (error) {
    logger.error({ err: error }, 'Error getting contact:');
    res.status(500).json({ error: 'Error getting contact' });
  }
});

/* -------------------------
 * ESTADO / BLOQUEO / TAKEOVER
 * ------------------------- */

router.put('/api/:phoneNumber/state', async (req, res) => {
  try {
    const { state } = req.body;
    await contactModel.updateState(req.params.phoneNumber, state);
    res.json({ success: true, message: 'Estado actualizado' });
  } catch (error) {
    logger.error({ err: error }, 'Error updating state:');
    res.status(500).json({ error: 'Error updating state' });
  }
});

router.post('/api/:phoneNumber/block', async (req, res) => {
  try {
    const { reason } = req.body;
    await contactModel.blockContact(req.params.phoneNumber, reason || 'Bloqueado desde panel web');
    res.json({ success: true, message: 'Contacto bloqueado' });
  } catch (error) {
    logger.error({ err: error }, 'Error blocking contact:');
    res.status(500).json({ error: 'Error blocking contact' });
  }
});

router.post('/api/:phoneNumber/unblock', async (_req, res) => {
  try {
    await contactModel.unblockContact(res.req.params.phoneNumber);
    res.json({ success: true, message: 'Contacto desbloqueado' });
  } catch (error) {
    logger.error({ err: error }, 'Error unblocking contact:');
    res.status(500).json({ error: 'Error unblocking contact' });
  }
});

router.post('/api/:phoneNumber/takeover', async (req, res) => {
  try {
    await contactModel.setHumanTakeover(req.params.phoneNumber);
    res.json({ success: true, message: 'Takeover activado' });
  } catch (error) {
    logger.error({ err: error }, 'Error setting takeover:');
    res.status(500).json({ error: 'Error setting takeover' });
  }
});

router.post('/api/:phoneNumber/release', async (req, res) => {
  try {
    await contactModel.releaseHumanTakeover(req.params.phoneNumber);
    res.json({ success: true, message: 'Takeover liberado' });
  } catch (error) {
    logger.error({ err: error }, 'Error releasing takeover:');
    res.status(500).json({ error: 'Error releasing takeover' });
  }
});

/* -------------------------
 * MULTIEMPRESA
 * ------------------------- */

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
    logger.error({ err: error }, 'Error adding company to contact:');
    res.status(500).json({ error: 'Error adding company to contact' });
  }
});

router.post('/api/:contactId/company/:companyId/primary', async (req, res) => {
  try {
    await contactModel.setPrimaryCompany(req.params.contactId, req.params.companyId);
    res.json({ success: true, message: 'Empresa principal actualizada' });
  } catch (error) {
    logger.error({ err: error }, 'Error setting primary company:');
    res.status(500).json({ error: 'Error setting primary company' });
  }
});

router.delete('/api/:contactId/company/:companyId', async (req, res) => {
  try {
    await contactModel.removeCompanyFromContact(req.params.contactId, req.params.companyId);
    res.json({ success: true, message: 'Empresa removida del contacto' });
  } catch (error) {
    logger.error({ err: error }, 'Error removing company from contact:');
    res.status(500).json({ error: 'Error removing company from contact' });
  }
});

/* -------------------------
 * EDITAR / ELIMINAR CONTACTO
 * ------------------------- */

router.put('/api/contact/:contactId', async (req, res) => {
  try {
    const updated = await contactModel.updateContactInfo(req.params.contactId, req.body);
    res.json({ success: true, contact: updated });
  } catch (error) {
    logger.error({ err: error }, 'Error updating contact info:');
    res.status(500).json({ error: 'Error updating contact info' });
  }
});

router.delete('/api/contact/:contactId', async (req, res) => {
  try {
    await contactModel.deleteContact(req.params.contactId);
    res.json({ success: true, message: 'Contacto eliminado' });
  } catch (error) {
    logger.error({ err: error }, 'Error deleting contact:');
    res.status(500).json({ error: 'Error deleting contact' });
  }
});

/* -------------------------
 * IMPORT / EXPORT
 * ------------------------- */

router.get('/api-export', async (_req, res) => {
  try {
    const data = await contactModel.exportContactsToExcelData();

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Contactos');

    const firstRow = data[0] ?? {};
    const columns = Object.keys(firstRow).map((key) => ({
      header: key.charAt(0).toUpperCase() + key.slice(1),
      key,
      width: 20,
    }));
    worksheet.columns = columns as any;

    data.forEach((row) => worksheet.addRow(row));

    worksheet.getRow(1).font = { bold: true };
    worksheet.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFE0E0E0' },
    } as any;

    const timestamp = new Date().toISOString().split('T')[0];
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=contactos-${timestamp}.xlsx`);

    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    logger.error({ err: error }, 'Error exporting contacts:');
    res.status(500).json({ error: 'Error exporting contacts' });
  }
});

router.post('/api-import', async (req, res) => {
  try {
    const rows = (req.body as any).rows;
    if (!Array.isArray(rows)) return res.status(400).json({ error: 'rows must be an array' });

    const result = await contactModel.importContactsFromExcel(rows);
    res.json({ importedAt: new Date(), result });
  } catch (error) {
    logger.error({ err: error }, 'Error importing contacts:');
    res.status(500).json({ error: 'Error importing contacts' });
  }
});

// NUEVA RUTA: Importar contactos desde archivo Excel (.xlsx)
router.post('/api-import-file', upload.single('file'), async (req, res) => {
  try {
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ error: 'No se recibió ningún archivo' });
    }

    const workbook = new ExcelJS.Workbook();

    // ✅ Convertir a ArrayBuffer **puro** copiando a Uint8Array (evita el tipo Buffer<ArrayBufferLike>)
    const u8 = new Uint8Array(req.file.buffer); // copia los bytes
    const arrayBuffer: ArrayBuffer = u8.buffer;  // ArrayBuffer limpio

    await workbook.xlsx.load(arrayBuffer);

    const worksheet = workbook.getWorksheet(1);
    if (!worksheet) {
      return res.status(400).json({ error: 'El archivo no contiene hojas de cálculo' });
    }

    type ImportedCompany = { ruc: string; name: string; role?: string; primary?: boolean };
    type ImportedRow = { phoneNumber: string; name?: string; dni?: string; companies?: ImportedCompany[] };

    const rows: ImportedRow[] = [];

    const cellToString = (v: unknown) =>
      v == null
        ? ''
        : typeof v === 'object'
        ? String(
            (v as any).text ??
              (v as any).result ??
              (v as any).richText?.map((t: any) => t.text).join('') ??
              (v as any).toString?.() ??
              ''
          )
        : String(v);

    // Columnas esperadas: phoneNumber, name, dni, companyRuc, companyName, companyRole
    worksheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;

      const c1 = cellToString(row.getCell(1).value);
      const c2 = cellToString(row.getCell(2).value);
      const c3 = cellToString(row.getCell(3).value);
      const c4 = cellToString(row.getCell(4).value);
      const c5 = cellToString(row.getCell(5).value);
      const c6 = cellToString(row.getCell(6).value);

      const phoneNumber = c1.trim();
      if (!phoneNumber) return;

      const name = c2.trim() || undefined;
      const dni = c3.trim() || undefined;
      const companyRuc = c4.trim();
      const companyName = c5.trim();
      const companyRole = c6.trim();

      const rowData: ImportedRow = { phoneNumber, name, dni };

      if (companyRuc && companyName) {
        rowData.companies = [{ ruc: companyRuc, name: companyName, role: companyRole || undefined, primary: true }];
      }

      rows.push(rowData);
    });

    if (rows.length === 0) {
      return res.status(400).json({ error: 'El archivo no contiene datos válidos o está vacío' });
    }

    const result = await contactModel.importContactsFromExcel(rows);

    res.json({ success: true, importedAt: new Date(), totalRows: rows.length, result });
  } catch (error) {
    logger.error({ err: error }, 'Error importing Excel file:');
    res.status(500).json({
      error: 'Error procesando el archivo Excel',
      details: error instanceof Error ? error.message : String(error),
    });
  }
});

/* -------------------------
 * EMPRESAS (selector modal)
 * ------------------------- */

router.get('/api-companies', async (_req, res) => {
  try {
    const companies = await prisma.company.findMany({
      orderBy: { name: 'asc' },
      select: { id: true, name: true, ruc: true },
    });
    res.json({ ok: true, companies });
  } catch (error) {
    logger.error({ err: error }, 'Error listing companies:');
    res.status(500).json({ error: 'Error listing companies' });
  }
});

export default router;
