// src/models/company.ts
import { getPrismaClient } from '../config/database.js';
import { logger } from '../utils/logger.js';

const prisma = getPrismaClient();

// ========== EMPRESAS ==========

// Lista todas las empresas con un resumen (cantidad sucursales)
export async function getAllCompanies() {
  try {
    return await prisma.company.findMany({
      orderBy: { razonSocial: 'asc' },
      select: {
        id: true,
        tipoDoc: true,
        numeroDoc: true,
        razonSocial: true,
        estadoSunat: true,
        createdAt: true,
        branches: {
          select: { id: true },
        },
      },
    });
  } catch (err) {
    logger.error('getAllCompanies error:', err);
    return [];
  }
}

// Trae una empresa completa con sucursales y contactos de sucursal
export async function getCompanyById(companyId: string) {
  try {
    return await prisma.company.findUnique({
      where: { id: companyId },
      include: {
        branches: {
          orderBy: { nombre: 'asc' },
          include: {
            contacts: {
              orderBy: { nombre: 'asc' },
            },
          },
        },
      },
    });
  } catch (err) {
    logger.error('getCompanyById error:', err);
    return null;
  }
}

export async function createCompany(input: {
  tipoDoc: string;
  numeroDoc: string;
  razonSocial: string;
  estadoSunat?: string | null;
}) {
  try {
    return await prisma.company.create({
      data: {
        tipoDoc: input.tipoDoc,
        numeroDoc: input.numeroDoc,
        razonSocial: input.razonSocial,
        estadoSunat: input.estadoSunat || null,

        // compat campos legacy:
        ruc: input.tipoDoc === 'RUC' ? input.numeroDoc : null,
        name: input.razonSocial,
      },
    });
  } catch (err: any) {
    logger.error('createCompany error:', err);
    throw err;
  }
}

export async function updateCompany(companyId: string, data: {
  razonSocial?: string;
  estadoSunat?: string | null;
}) {
  try {
    return await prisma.company.update({
      where: { id: companyId },
      data: {
        ...(data.razonSocial ? { razonSocial: data.razonSocial, name: data.razonSocial } : {}),
        ...(data.estadoSunat !== undefined ? { estadoSunat: data.estadoSunat } : {}),
      },
    });
  } catch (err: any) {
    logger.error('updateCompany error:', err);
    throw err;
  }
}

export async function deleteCompany(companyId: string) {
  try {
    return await prisma.company.delete({
      where: { id: companyId },
    });
  } catch (err: any) {
    logger.error('deleteCompany error:', err);
    throw err;
  }
}

// ========== SUCURSALES ==========

export async function createBranch(companyId: string, data: {
  nombre: string;
  direccion: string;
  distrito?: string;
  provincia?: string;
  departamento?: string;
  referencia?: string;
  telefono?: string;
  email?: string;
  isActive?: boolean;
}) {
  try {
    return await prisma.branch.create({
      data: {
        companyId,
        nombre: data.nombre,
        direccion: data.direccion,
        distrito: data.distrito || null,
        provincia: data.provincia || null,
        departamento: data.departamento || null,
        referencia: data.referencia || null,
        telefono: data.telefono || null,
        email: data.email || null,
        isActive: data.isActive !== false,
      },
    });
  } catch (err: any) {
    logger.error('createBranch error:', err);
    throw err;
  }
}

export async function updateBranch(branchId: string, data: {
  nombre?: string;
  direccion?: string;
  distrito?: string;
  provincia?: string;
  departamento?: string;
  referencia?: string;
  telefono?: string;
  email?: string;
  isActive?: boolean;
}) {
  try {
    return await prisma.branch.update({
      where: { id: branchId },
      data: {
        ...(data.nombre !== undefined ? { nombre: data.nombre } : {}),
        ...(data.direccion !== undefined ? { direccion: data.direccion } : {}),
        ...(data.distrito !== undefined ? { distrito: data.distrito } : {}),
        ...(data.provincia !== undefined ? { provincia: data.provincia } : {}),
        ...(data.departamento !== undefined ? { departamento: data.departamento } : {}),
        ...(data.referencia !== undefined ? { referencia: data.referencia } : {}),
        ...(data.telefono !== undefined ? { telefono: data.telefono } : {}),
        ...(data.email !== undefined ? { email: data.email } : {}),
        ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
      },
    });
  } catch (err: any) {
    logger.error('updateBranch error:', err);
    throw err;
  }
}

export async function deleteBranch(branchId: string) {
  try {
    return await prisma.branch.delete({
      where: { id: branchId },
    });
  } catch (err: any) {
    logger.error('deleteBranch error:', err);
    throw err;
  }
}

// ========== CONTACTOS DE SUCURSAL ==========

export async function createBranchContact(branchId: string, data: {
  nombre: string;
  cargo?: string;
  email?: string;
  celular?: string;
  whatsapp?: string;
  isActive?: boolean;
}) {
  try {
    return await prisma.branchContact.create({
      data: {
        branchId,
        nombre: data.nombre,
        cargo: data.cargo || null,
        email: data.email || null,
        celular: data.celular || null,
        whatsapp: data.whatsapp || null,
        isActive: data.isActive !== false,
      },
    });
  } catch (err: any) {
    logger.error('createBranchContact error:', err);
    throw err;
  }
}

export async function updateBranchContact(contactId: string, data: {
  nombre?: string;
  cargo?: string;
  email?: string;
  celular?: string;
  whatsapp?: string;
  isActive?: boolean;
}) {
  try {
    return await prisma.branchContact.update({
      where: { id: contactId },
      data: {
        ...(data.nombre !== undefined ? { nombre: data.nombre } : {}),
        ...(data.cargo !== undefined ? { cargo: data.cargo } : {}),
        ...(data.email !== undefined ? { email: data.email } : {}),
        ...(data.celular !== undefined ? { celular: data.celular } : {}),
        ...(data.whatsapp !== undefined ? { whatsapp: data.whatsapp } : {}),
        ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
      },
    });
  } catch (err: any) {
    logger.error('updateBranchContact error:', err);
    throw err;
  }
}

export async function deleteBranchContact(contactId: string) {
  try {
    return await prisma.branchContact.delete({
      where: { id: contactId },
    });
  } catch (err: any) {
    logger.error('deleteBranchContact error:', err);
    throw err;
  }
}
