// src/web/routes/companies.ts
import express from 'express';
import multer from 'multer';
import * as XLSX from 'xlsx';

import { logger } from '../../utils/logger.js';
import {
  getAllCompanies,
  getCompanyById,
  createCompany,
  updateCompany,
  deleteCompany,
  createBranch,
  updateBranch,
  deleteBranch,
  createBranchContact,
  updateBranchContact,
  deleteBranchContact,
  exportAllCompanyDataFlat,
  importFlatRows,
} from '../../models/company.js';

import { validateDNI, validateRUC } from '../../services/external.js';

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

// ======================================================
// API EMPRESA (crear / editar / borrar)
// ======================================================

// Crear empresa
router.post('/api/company', async (req, res) => {
  try {
    const {
      tipoDoc,
      numeroDoc,
      razonSocial: rawRazonSocial,
      estadoSunat,
      condicionSunat,
      direccionFiscal,
      distritoFiscal,
      provinciaFiscal,
      departamentoFiscal,
    } = req.body;

    if (!tipoDoc || !numeroDoc) {
      return res.status(400).json({ error: 'tipoDoc y numeroDoc son requeridos' });
    }

    // razonSocial puede venir vacío, intentamos poblarla con validateRUC/DNI
    let razonSocial = rawRazonSocial || '';
    let estadoAuto = estadoSunat || null;
    let condicionAuto = condicionSunat || null;
    let dirFiscalAuto = direccionFiscal || null;
    let distFiscalAuto = distritoFiscal || null;
    let provFiscalAuto = provinciaFiscal || null;
    let depFiscalAuto  = departamentoFiscal || null;

    if (!razonSocial) {
      if (tipoDoc === 'RUC') {
        const info = await validateRUC(numeroDoc);
        if (info) {
          // info.razonSocial, info.estado, info.condicion, info.direccion, info.distrito, etc.
          if (!razonSocial) razonSocial = info.razonSocial;
          if (!estadoAuto)  estadoAuto  = info.estado || null;
          if (!condicionAuto && info.condicion) condicionAuto = info.condicion;
          if (!dirFiscalAuto && info.direccion) dirFiscalAuto = info.direccion;
          if (!distFiscalAuto && info.distrito)  distFiscalAuto = info.distrito;
          if (!provFiscalAuto && info.provincia) provFiscalAuto = info.provincia;
          if (!depFiscalAuto  && info.departamento) depFiscalAuto = info.departamento;
        }
      } else if (tipoDoc === 'DNI') {
        const info = await validateDNI(numeroDoc);
        if (info) {
          const fullName = `${info.nombres} ${info.apellidoPaterno || ''} ${info.apellidoMaterno || ''}`.trim();
          if (fullName) razonSocial = fullName;
          if (!estadoAuto) estadoAuto = 'PERSONA NATURAL';
        }
      }
    }

    if (!razonSocial) {
      return res.status(400).json({ error: 'No se pudo determinar razón social/nombre' });
    }

    const created = await createCompany({
      tipoDoc,
      numeroDoc,
      razonSocial,
      estadoSunat: estadoAuto,
      condicionSunat: condicionAuto,
      direccionFiscal: dirFiscalAuto,
      distritoFiscal: distFiscalAuto,
      provinciaFiscal: provFiscalAuto,
      departamentoFiscal: depFiscalAuto,
    });

    res.json(created);
  } catch (err: any) {
    logger.error('POST /companies/api/company error:', err);
    res.status(500).json({ error: err?.message || 'Error creando empresa' });
  }
});

router.put('/api/company/:companyId', async (req, res) => {
  try {
    const updated = await updateCompany(req.params.companyId, {
      razonSocial: req.body.razonSocial,
      estadoSunat: req.body.estadoSunat,
      condicionSunat: req.body.condicionSunat,
      direccionFiscal: req.body.direccionFiscal,
      distritoFiscal: req.body.distritoFiscal,
      provinciaFiscal: req.body.provinciaFiscal,
      departamentoFiscal: req.body.departamentoFiscal,
    });
    res.json(updated);
  } catch (err: any) {
    logger.error('PUT /companies/api/company/:companyId error:', err);
    if (err.code === 'P2025') {
      return res.status(404).json({ error: 'Empresa no encontrada' });
    }
    res.status(500).json({ error: err?.message || 'Error actualizando empresa' });
  }
});


// Editar empresa
router.put('/api/company/:companyId', async (req, res) => {
  try {
    const updated = await updateCompany(req.params.companyId, {
      razonSocial: req.body.razonSocial,
      estadoSunat: req.body.estadoSunat,

      condicionSunat: req.body.condicionSunat,
      direccionFiscal: req.body.direccionFiscal,
      distritoFiscal: req.body.distritoFiscal,
      provinciaFiscal: req.body.provinciaFiscal,
      departamentoFiscal: req.body.departamentoFiscal,
    });
    res.json(updated);
  } catch (err: any) {
    logger.error('PUT /companies/api/company/:companyId error:', err);
    if (err.code === 'P2025') {
      return res.status(404).json({ error: 'Empresa no encontrada' });
    }
    res
      .status(500)
      .json({ error: err?.message || 'Error actualizando empresa' });
  }
});

// Eliminar empresa
router.delete('/api/company/:companyId', async (req, res) => {
  try {
    await deleteCompany(req.params.companyId);
    res.json({ success: true });
  } catch (err: any) {
    logger.error('DELETE /companies/api/company/:companyId error:', err);
    if (err.code === 'P2025') {
      return res.status(404).json({ error: 'Empresa no encontrada' });
    }
    res
      .status(500)
      .json({ error: err?.message || 'Error eliminando empresa' });
  }
});

// ======================================================
// API SUCURSAL
// ======================================================

// Crear sucursal
router.post('/api/company/:companyId/branch', async (req, res) => {
  try {
    const data = await createBranch(req.params.companyId, {
      nombre: req.body.nombre,
      direccion: req.body.direccion,
      distrito: req.body.distrito,
      provincia: req.body.provincia,
      departamento: req.body.departamento,
      referencia: req.body.referencia,
      telefono: req.body.telefono,
      email: req.body.email,
      isActive: req.body.isActive,
    });

    res.json(data);
  } catch (err: any) {
    logger.error('POST /companies/api/company/:companyId/branch error:', err);
    res
      .status(500)
      .json({ error: err?.message || 'Error creando sucursal' });
  }
});

// Editar sucursal
router.put('/api/branch/:branchId', async (req, res) => {
  try {
    const data = await updateBranch(req.params.branchId, {
      nombre: req.body.nombre,
      direccion: req.body.direccion,
      distrito: req.body.distrito,
      provincia: req.body.provincia,
      departamento: req.body.departamento,
      referencia: req.body.referencia,
      telefono: req.body.telefono,
      email: req.body.email,
      isActive: req.body.isActive,
    });

    res.json(data);
  } catch (err: any) {
    logger.error('PUT /companies/api/branch/:branchId error:', err);
    if (err.code === 'P2025') {
      return res.status(404).json({ error: 'Sucursal no encontrada' });
    }
    res
      .status(500)
      .json({ error: err?.message || 'Error actualizando sucursal' });
  }
});

// Eliminar sucursal
router.delete('/api/branch/:branchId', async (req, res) => {
  try {
    await deleteBranch(req.params.branchId);
    res.json({ success: true });
  } catch (err: any) {
    logger.error('DELETE /companies/api/branch/:branchId error:', err);
    if (err.code === 'P2025') {
      return res.status(404).json({ error: 'Sucursal no encontrada' });
    }
    res
      .status(500)
      .json({ error: err?.message || 'Error eliminando sucursal' });
  }
});

// ======================================================
// API CONTACTO SUCURSAL
// ======================================================

// Crear contacto
router.post('/api/branch/:branchId/contact', async (req, res) => {
  try {
    const data = await createBranchContact(req.params.branchId, {
      nombre: req.body.nombre,
      cargo: req.body.cargo,
      email: req.body.email,
      celular: req.body.celular,
      whatsapp: req.body.whatsapp,
      isActive: req.body.isActive,
    });

    res.json(data);
  } catch (err: any) {
    logger.error('POST /companies/api/branch/:branchId/contact error:', err);
    res
      .status(500)
      .json({ error: err?.message || 'Error creando contacto' });
  }
});

// Editar contacto
router.put('/api/branch-contact/:contactId', async (req, res) => {
  try {
    const data = await updateBranchContact(req.params.contactId, {
      nombre: req.body.nombre,
      cargo: req.body.cargo,
      email: req.body.email,
      celular: req.body.celular,
      whatsapp: req.body.whatsapp,
      isActive: req.body.isActive,
    });

    res.json(data);
  } catch (err: any) {
    logger.error('PUT /companies/api/branch-contact/:contactId error:', err);
    if (err.code === 'P2025') {
      return res.status(404).json({ error: 'Contacto no encontrado' });
    }
    res
      .status(500)
      .json({ error: err?.message || 'Error actualizando contacto' });
  }
});

// Eliminar contacto
router.delete('/api/branch-contact/:contactId', async (req, res) => {
  try {
    await deleteBranchContact(req.params.contactId);
    res.json({ success: true });
  } catch (err: any) {
    logger.error('DELETE /companies/api/branch-contact/:contactId error:', err);
    if (err.code === 'P2025') {
      return res.status(404).json({ error: 'Contacto no encontrado' });
    }
    res
      .status(500)
      .json({ error: err?.message || 'Error eliminando contacto' });
  }
});

// ======================================================
// LOOKUP DNI / RUC (consulta externa SUNAT/RENIEC)
// ======================================================

router.get('/api/lookup-ruc/:ruc', async (req, res) => {
  try {
    const info = await validateRUC(req.params.ruc);
    if (!info) {
      return res.status(404).json({ error: 'No encontrado en SUNAT' });
    }
    // devolvemos todo lo que tengamos para que el front pueda prellenar más campos
    return res.json(info);
  } catch (err: any) {
    logger.error('GET /companies/api/lookup-ruc/:ruc error:', err);
    res.status(500).json({ error: 'Error consultando SUNAT' });
  }
});

router.get('/api/lookup-dni/:dni', async (req, res) => {
  try {
    const info = await validateDNI(req.params.dni);
    if (!info) {
      return res.status(404).json({ error: 'No encontrado en RENIEC' });
    }
    return res.json(info);
  } catch (err: any) {
    logger.error('GET /companies/api/lookup-dni/:dni error:', err);
    res.status(500).json({ error: 'Error consultando RENIEC' });
  }
});

// ======================================================
// EXPORT EXCEL / IMPORT EXCEL
// ======================================================

router.get('/api/export', async (_req, res) => {
  try {
    const flatRows = await exportAllCompanyDataFlat();

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(flatRows);
    XLSX.utils.book_append_sheet(wb, ws, 'Empresas');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    res.setHeader('Content-Disposition', 'attachment; filename="empresas.xlsx"');
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.send(buf);
  } catch (err: any) {
    logger.error('GET /companies/api/export error:', err);
    res
      .status(500)
      .json({ error: 'No se pudo generar el Excel de empresas' });
  }
});

router.post('/api/import', upload.single('file'), async (req, res) => {
  try {
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ error: 'Archivo requerido (file)' });
    }

    const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });

    const firstSheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[firstSheetName];

    const rows = XLSX.utils.sheet_to_json(sheet, {
      defval: '',
    });

    const summary = await importFlatRows(rows);

    res.json({
      ok: true,
      summary,
    });
  } catch (err: any) {
    logger.error('POST /companies/api/import error:', err);
    res
      .status(500)
      .json({ error: err?.message || 'No se pudo importar el Excel' });
  }
});

// ======================================================
// VISTAS HTML
// ======================================================

// Listado de empresas
router.get('/', async (req, res) => {
  try {
    const companies = await getAllCompanies();
    res.render('companies', {
      title: 'Empresas',
      user: req.session?.username || 'Admin',
      companies,
      error: null,
    });
  } catch (err: any) {
    logger.error('GET /companies error:', err);
    res.status(500).render('companies', {
      title: 'Empresas',
      user: req.session?.username || 'Admin',
      companies: [],
      error: 'Error cargando empresas',
    });
  }
});

// Detalle empresa (incluye sucursales y contactos)
router.get('/:companyId', async (req, res) => {
  try {
    const company = await getCompanyById(req.params.companyId);
    if (!company) {
      return res.status(404).send('Empresa no encontrada');
    }
    res.render('company_detail', {
      title: 'Detalle Empresa',
      user: req.session?.username || 'Admin',
      company,
    });
  } catch (err: any) {
    logger.error('GET /companies/:companyId error:', err);
    res.status(500).send('Error cargando empresa');
  }
});

export default router;
