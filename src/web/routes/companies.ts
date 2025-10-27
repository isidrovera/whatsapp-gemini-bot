// src/web/routes/companies.ts
import express from 'express';
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
} from '../../models/company.js';

import { validateDNI, validateRUC } from '../../services/external.js';

const router = express.Router();

/**
 * GET /companies
 * Lista todas las empresas
 */
router.get('/', async (req, res) => {
  try {
    const companies = await getAllCompanies();

    res.render('companies', {
      title: 'Empresas',
      user: req.session?.username || 'Admin',
      companies,
    });
  } catch (err: any) {
    logger.error('GET /companies error:', err);
    res.status(500).send('Error cargando empresas');
  }
});

/**
 * GET /companies/:companyId
 * Detalle de una empresa + sucursales + contactos
 */
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

// =====================
// API EMPRESA
// =====================

// Crear empresa
router.post('/api/company', async (req, res) => {
  try {
    const { tipoDoc, numeroDoc } = req.body;

    if (!tipoDoc || !numeroDoc) {
      return res.status(400).json({ error: 'tipoDoc y numeroDoc son requeridos' });
    }

    let razonSocial = req.body.razonSocial || '';
    let estadoSunat = req.body.estadoSunat || null;

    // Si no mandaron razonSocial explícita, intentamos autocompletar
    if (!razonSocial) {
      if (tipoDoc === 'RUC') {
        const info = await validateRUC(numeroDoc);
        if (info) {
          razonSocial = info.razonSocial;
          estadoSunat = info.estado;
        }
      } else if (tipoDoc === 'DNI') {
        const info = await validateDNI(numeroDoc);
        if (info) {
          razonSocial = `${info.nombres} ${info.apellidoPaterno || ''} ${info.apellidoMaterno || ''}`.trim();
          estadoSunat = 'PERSONA NATURAL';
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
      estadoSunat,
    });

    res.json(created);
  } catch (err: any) {
    logger.error('POST /companies/api/company error:', err);
    res.status(500).json({ error: err?.message || 'Error creando empresa' });
  }
});

// Editar empresa
router.put('/api/company/:companyId', async (req, res) => {
  try {
    const updated = await updateCompany(req.params.companyId, {
      razonSocial: req.body.razonSocial,
      estadoSunat: req.body.estadoSunat,
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
    res.status(500).json({ error: err?.message || 'Error eliminando empresa' });
  }
});

// =====================
// API SUCURSAL
// =====================

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
    res.status(500).json({ error: err?.message || 'Error creando sucursal' });
  }
});

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
    res.status(500).json({ error: err?.message || 'Error actualizando sucursal' });
  }
});

router.delete('/api/branch/:branchId', async (req, res) => {
  try {
    await deleteBranch(req.params.branchId);
    res.json({ success: true });
  } catch (err: any) {
    logger.error('DELETE /companies/api/branch/:branchId error:', err);
    if (err.code === 'P2025') {
      return res.status(404).json({ error: 'Sucursal no encontrada' });
    }
    res.status(500).json({ error: err?.message || 'Error eliminando sucursal' });
  }
});

// =====================
// API CONTACTO DE SUCURSAL
// =====================

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
    res.status(500).json({ error: err?.message || 'Error creando contacto' });
  }
});

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
    res.status(500).json({ error: err?.message || 'Error actualizando contacto' });
  }
});

router.delete('/api/branch-contact/:contactId', async (req, res) => {
  try {
    await deleteBranchContact(req.params.contactId);
    res.json({ success: true });
  } catch (err: any) {
    logger.error('DELETE /companies/api/branch-contact/:contactId error:', err);
    if (err.code === 'P2025') {
      return res.status(404).json({ error: 'Contacto no encontrado' });
    }
    res.status(500).json({ error: err?.message || 'Error eliminando contacto' });
  }
});

// =====================
// API LOOKUP DNI / RUC
// =====================

router.get('/api/lookup-ruc/:ruc', async (req, res) => {
  try {
    const info = await validateRUC(req.params.ruc);
    if (!info) {
      return res.status(404).json({ error: 'No encontrado en SUNAT' });
    }
    res.json(info); // { razonSocial, estado }
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
    res.json(info); // { nombres, apellidoPaterno, apellidoMaterno }
  } catch (err: any) {
    logger.error('GET /companies/api/lookup-dni/:dni error:', err);
    res.status(500).json({ error: 'Error consultando RENIEC' });
  }
});

export default router;
