import { getPrismaClient } from '../config/database.js';
import { logger } from '../utils/logger.js';

const prisma = getPrismaClient();

// ========== EMPRESAS ==========

// Lista todas las empresas (resumen). Incluimos campos fiscales básicos para editar desde listado si quieres.
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
        condicionSunat: true,
        direccionFiscal: true,
        distritoFiscal: true,
        provinciaFiscal: true,
        departamentoFiscal: true,
        createdAt: true,
        branches: { select: { id: true } },
      },
    });
  } catch (err) {
    logger.error('getAllCompanies error:', err);
    return [];
  }
}

// Trae una empresa completa con sucursales y contactos
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
  condicionSunat?: string | null;
  direccionFiscal?: string | null;
  distritoFiscal?: string | null;
  provinciaFiscal?: string | null;
  departamentoFiscal?: string | null;
}) {
  try {
    return await prisma.company.create({
      data: {
        tipoDoc: input.tipoDoc,
        numeroDoc: input.numeroDoc,
        razonSocial: input.razonSocial,

        estadoSunat: input.estadoSunat ?? null,
        condicionSunat: input.condicionSunat ?? null,

        direccionFiscal: input.direccionFiscal ?? null,
        distritoFiscal: input.distritoFiscal ?? null,
        provinciaFiscal: input.provinciaFiscal ?? null,
        departamentoFiscal: input.departamentoFiscal ?? null,

        // legacy
        ruc: input.tipoDoc === 'RUC' ? input.numeroDoc : null,
        name: input.razonSocial,
      },
    });
  } catch (err: any) {
    logger.error('createCompany error:', err);
    throw err;
  }
}

export async function updateCompany(
  companyId: string,
  data: {
    razonSocial?: string;
    estadoSunat?: string | null;
    condicionSunat?: string | null;
    direccionFiscal?: string | null;
    distritoFiscal?: string | null;
    provinciaFiscal?: string | null;
    departamentoFiscal?: string | null;
  }
) {
  try {
    return await prisma.company.update({
      where: { id: companyId },
      data: {
        ...(data.razonSocial !== undefined
          ? { razonSocial: data.razonSocial, name: data.razonSocial }
          : {}),
        ...(data.estadoSunat !== undefined
          ? { estadoSunat: data.estadoSunat }
          : {}),
        ...(data.condicionSunat !== undefined
          ? { condicionSunat: data.condicionSunat }
          : {}),
        ...(data.direccionFiscal !== undefined
          ? { direccionFiscal: data.direccionFiscal }
          : {}),
        ...(data.distritoFiscal !== undefined
          ? { distritoFiscal: data.distritoFiscal }
          : {}),
        ...(data.provinciaFiscal !== undefined
          ? { provinciaFiscal: data.provinciaFiscal }
          : {}),
        ...(data.departamentoFiscal !== undefined
          ? { departamentoFiscal: data.departamentoFiscal }
          : {}),
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

export async function createBranch(
  companyId: string,
  data: {
    nombre: string;
    direccion: string;
    distrito?: string;
    provincia?: string;
    departamento?: string;
    referencia?: string;
    telefono?: string;
    email?: string;
    isActive?: boolean;
  }
) {
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

export async function updateBranch(
  branchId: string,
  data: {
    nombre?: string;
    direccion?: string;
    distrito?: string;
    provincia?: string;
    departamento?: string;
    referencia?: string;
    telefono?: string;
    email?: string;
    isActive?: boolean;
  }
) {
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

export async function createBranchContact(
  branchId: string,
  data: {
    nombre: string;
    cargo?: string;
    email?: string;
    celular?: string;
    whatsapp?: string;
    isActive?: boolean;
  }
) {
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

export async function updateBranchContact(
  contactId: string,
  data: {
    nombre?: string;
    cargo?: string;
    email?: string;
    celular?: string;
    whatsapp?: string;
    isActive?: boolean;
  }
) {
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

// ===============================
// EXPORT / IMPORT MASIVA (EXCEL)
// ===============================

export async function exportAllCompanyDataFlat() {
  const companies = await prisma.company.findMany({
    orderBy: { razonSocial: 'asc' },
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

  const rows: any[] = [];

  companies.forEach((co) => {
    if (!co.branches || co.branches.length === 0) {
      rows.push({
        companyId: co.id,
        tipoDoc: co.tipoDoc,
        numeroDoc: co.numeroDoc,
        razonSocial: co.razonSocial,
        estadoSunat: co.estadoSunat ?? '',
        condicionSunat: co.condicionSunat ?? '',
        direccionFiscal: co.direccionFiscal ?? '',
        distritoFiscal: co.distritoFiscal ?? '',
        provinciaFiscal: co.provinciaFiscal ?? '',
        departamentoFiscal: co.departamentoFiscal ?? '',

        branchId: '',
        branchNombre: '',
        branchDireccion: '',
        branchDistrito: '',
        branchProvincia: '',
        branchDepartamento: '',
        branchReferencia: '',
        branchTelefono: '',
        branchEmail: '',
        branchIsActive: '',

        contactId: '',
        contactNombre: '',
        contactCargo: '',
        contactEmail: '',
        contactCelular: '',
        contactWhatsapp: '',
        contactIsActive: '',
      });
      return;
    }

    co.branches.forEach((br) => {
      if (!br.contacts || br.contacts.length === 0) {
        rows.push({
          companyId: co.id,
          tipoDoc: co.tipoDoc,
          numeroDoc: co.numeroDoc,
          razonSocial: co.razonSocial,
          estadoSunat: co.estadoSunat ?? '',
          condicionSunat: co.condicionSunat ?? '',
          direccionFiscal: co.direccionFiscal ?? '',
          distritoFiscal: co.distritoFiscal ?? '',
          provinciaFiscal: co.provinciaFiscal ?? '',
          departamentoFiscal: co.departamentoFiscal ?? '',

          branchId: br.id,
          branchNombre: br.nombre,
          branchDireccion: br.direccion,
          branchDistrito: br.distrito ?? '',
          branchProvincia: br.provincia ?? '',
          branchDepartamento: br.departamento ?? '',
          branchReferencia: br.referencia ?? '',
          branchTelefono: br.telefono ?? '',
          branchEmail: br.email ?? '',
          branchIsActive: br.isActive ? 'true' : 'false',

          contactId: '',
          contactNombre: '',
          contactCargo: '',
          contactEmail: '',
          contactCelular: '',
          contactWhatsapp: '',
          contactIsActive: '',
        });
        return;
      }

      br.contacts.forEach((ct) => {
        rows.push({
          companyId: co.id,
          tipoDoc: co.tipoDoc,
          numeroDoc: co.numeroDoc,
          razonSocial: co.razonSocial,
          estadoSunat: co.estadoSunat ?? '',
          condicionSunat: co.condicionSunat ?? '',
          direccionFiscal: co.direccionFiscal ?? '',
          distritoFiscal: co.distritoFiscal ?? '',
          provinciaFiscal: co.provinciaFiscal ?? '',
          departamentoFiscal: co.departamentoFiscal ?? '',

          branchId: br.id,
          branchNombre: br.nombre,
          branchDireccion: br.direccion,
          branchDistrito: br.distrito ?? '',
          branchProvincia: br.provincia ?? '',
          branchDepartamento: br.departamento ?? '',
          branchReferencia: br.referencia ?? '',
          branchTelefono: br.telefono ?? '',
          branchEmail: br.email ?? '',
          branchIsActive: br.isActive ? 'true' : 'false',

          contactId: ct.id,
          contactNombre: ct.nombre,
          contactCargo: ct.cargo ?? '',
          contactEmail: ct.email ?? '',
          contactCelular: ct.celular ?? '',
          contactWhatsapp: ct.whatsapp ?? '',
          contactIsActive: ct.isActive ? 'true' : 'false',
        });
      });
    });
  });

  return rows;
}

export async function importFlatRows(rows: any[]) {
  const result = {
    companiesCreated: 0,
    companiesUpdated: 0,
    branchesCreated: 0,
    branchesUpdated: 0,
    contactsCreated: 0,
    contactsUpdated: 0,
  };

  for (const raw of rows) {
    const tipoDoc = (raw.tipoDoc || '').toString().trim();
    const numeroDoc = (raw.numeroDoc || '').toString().trim();
    const razonSocial = (raw.razonSocial || '').toString().trim();
    const estadoSunat = raw.estadoSunat ? String(raw.estadoSunat).trim() : null;
    const condicionSunat = raw.condicionSunat ? String(raw.condicionSunat).trim() : null;
    const direccionFiscal = raw.direccionFiscal ? String(raw.direccionFiscal).trim() : null;
    const distritoFiscal = raw.distritoFiscal ? String(raw.distritoFiscal).trim() : null;
    const provinciaFiscal = raw.provinciaFiscal ? String(raw.provinciaFiscal).trim() : null;
    const departamentoFiscal = raw.departamentoFiscal ? String(raw.departamentoFiscal).trim() : null;

    if (!tipoDoc || !numeroDoc || !razonSocial) {
      continue;
    }

    // upsert empresa
    const existingCompany = await prisma.company.findFirst({
      where: { tipoDoc, numeroDoc },
    });

    let company;
    if (existingCompany) {
      company = await prisma.company.update({
        where: { id: existingCompany.id },
        data: {
          razonSocial,
          estadoSunat,
          condicionSunat,
          direccionFiscal,
          distritoFiscal,
          provinciaFiscal,
          departamentoFiscal,
        },
      });
      result.companiesUpdated++;
    } else {
      company = await prisma.company.create({
        data: {
          tipoDoc,
          numeroDoc,
          razonSocial,
          estadoSunat,
          condicionSunat,
          direccionFiscal,
          distritoFiscal,
          provinciaFiscal,
          departamentoFiscal,
          ruc: tipoDoc === 'RUC' ? numeroDoc : null,
          name: razonSocial,
        },
      });
      result.companiesCreated++;
    }

    // sucursal
    const branchNombre = (raw.branchNombre || '').toString().trim();
    const branchDireccion = (raw.branchDireccion || '').toString().trim();

    let branchRecord = null;
    if (branchNombre || branchDireccion) {
      const uniqueNombre = branchNombre || 'SIN NOMBRE';
      const uniqueDireccion = branchDireccion || 'SIN DIRECCION';

      const existingBranch = await prisma.branch.findFirst({
        where: {
          companyId: company.id,
          nombre: uniqueNombre,
          direccion: uniqueDireccion,
        },
      });

      const branchData: any = {
        distrito: raw.branchDistrito ? String(raw.branchDistrito).trim() : null,
        provincia: raw.branchProvincia ? String(raw.branchProvincia).trim() : null,
        departamento: raw.branchDepartamento ? String(raw.branchDepartamento).trim() : null,
        referencia: raw.branchReferencia ? String(raw.branchReferencia).trim() : null,
        telefono: raw.branchTelefono ? String(raw.branchTelefono).trim() : null,
        email: raw.branchEmail ? String(raw.branchEmail).trim() : null,
        isActive: String(raw.branchIsActive || '').toLowerCase() !== 'false',
      };

      if (existingBranch) {
        branchRecord = await prisma.branch.update({
          where: { id: existingBranch.id },
          data: branchData,
        });
        result.branchesUpdated++;
      } else {
        branchRecord = await prisma.branch.create({
          data: {
            companyId: company.id,
            nombre: uniqueNombre,
            direccion: uniqueDireccion,
            ...branchData,
          },
        });
        result.branchesCreated++;
      }
    }

    // contacto
    if (branchRecord) {
      const contactNombre = (raw.contactNombre || '').toString().trim();
      const contactCelular = (raw.contactCelular || '').toString().trim();

      if (contactNombre || contactCelular) {
        const existingContact = await prisma.branchContact.findFirst({
          where: {
            branchId: branchRecord.id,
            nombre: contactNombre || 'SIN NOMBRE',
            celular: contactCelular || null,
          },
        });

        const contactData: any = {
          cargo: raw.contactCargo ? String(raw.contactCargo).trim() : null,
          email: raw.contactEmail ? String(raw.contactEmail).trim() : null,
          celular: contactCelular || null,
          whatsapp: raw.contactWhatsapp ? String(raw.contactWhatsapp).trim() : null,
          isActive: String(raw.contactIsActive || '').toLowerCase() !== 'false',
        };

        if (existingContact) {
          await prisma.branchContact.update({
            where: { id: existingContact.id },
            data: contactData,
          });
          result.contactsUpdated++;
        } else {
          await prisma.branchContact.create({
            data: {
              branchId: branchRecord.id,
              nombre: contactNombre || 'SIN NOMBRE',
              ...contactData,
            },
          });
          result.contactsCreated++;
        }
      }
    }
  }

  return result;
}
