// src/models/contact.ts
import { getPrismaClient } from '../config/database.js';
import { logger } from '../utils/logger.js';
import { normalizePhone } from '../utils/validators.js';

const prisma = getPrismaClient();

/* -------------------------------------------------
 * HELPERS INTERNOS
 * ------------------------------------------------- */

/**
 * Valida un DNI peruano muy básico: 8 dígitos numéricos.
 */
function isValidDNI(dni: string) {
  const onlyDigits = dni?.trim();
  return !!onlyDigits && /^[0-9]{8}$/.test(onlyDigits);
}

/**
 * Valida RUC peruano muy básico: 11 dígitos.
 */
function isValidRUC(ruc: string) {
  const onlyDigits = ruc?.trim();
  return !!onlyDigits && /^[0-9]{11}$/.test(onlyDigits);
}

/**
 * Marca una relación ContactCompany específica como primaria,
 * y desmarca las demás del mismo contacto.
 */
async function setPrimaryCompanyInternal(contactId: string, companyId: string) {
  await prisma.contactCompany.updateMany({
    where: { contactId },
    data: { isPrimary: false },
  });

  return prisma.contactCompany.updateMany({
    where: { contactId, companyId },
    data: { isPrimary: true },
  });
}

/**
 * Crea o retorna una empresa por RUC si NO existe.
 * Usa campos más nuevos (company.numeroDoc / razonSocial)
 * y también legacy (ruc / name) para compatibilidad.
 */
async function getOrCreateCompany(ruc: string, name: string) {
  const cleanedRuc = ruc?.trim();
  const cleanedName = name?.trim();

  if (!cleanedRuc || !cleanedName) {
    throw new Error('RUC y razón social requeridos para la empresa');
  }

  let existing = await prisma.company.findFirst({
    where: {
      OR: [{ ruc: cleanedRuc }, { numeroDoc: cleanedRuc }],
    },
  });

  if (existing) {
    const patchData: Record<string, any> = {};

    if (!existing.razonSocial && cleanedName) patchData.razonSocial = cleanedName;
    if (!existing.name && cleanedName) patchData.name = cleanedName;
    if (!existing.numeroDoc) patchData.numeroDoc = cleanedRuc;
    if (!existing.ruc) patchData.ruc = cleanedRuc;

    if (Object.keys(patchData).length > 0) {
      existing = await prisma.company.update({
        where: { id: existing.id },
        data: patchData,
      });
    }

    return existing;
  }

  return prisma.company.create({
    data: {
      tipoDoc: 'RUC',
      numeroDoc: cleanedRuc,
      razonSocial: cleanedName,

      // legacy
      ruc: cleanedRuc,
      name: cleanedName,
    },
  });
}

/**
 * Genera un phoneNumber "shadow" único para contactos creados solo por @lid.
 * No es un número real; sirve para cumplir el NOT NULL + UNIQUE del schema.
 */
function makeShadowPhoneFromBillysId(billysId: string) {
  const safe = (billysId || '').replace(/[^a-zA-Z0-9@._-]/g, '');
  return `lid:${safe}`;
}

// ✅ SOLUCIÓN 2B: Determinar qué estado es más avanzado en el flujo de registro
function getStatePriority(state: string): number {
  const priorities: Record<string, number> = {
    'REGISTERED': 100,
    'MENU': 90,
    'WAITING_REMOTE_INFO': 80,
    'SELECTING_COMPANY': 70,
    'WAITING_COMPANY_NAME': 60,
    'WAITING_RUC': 50,
    'WAITING_DNI': 40,
    'NEW': 10,
  };
  return priorities[state] || 0;
}

// ✅ SOLUCIÓN 2B: Elegir el estado más avanzado entre dos contactos
function chooseBestState(stateA: string, stateB: string): string {
  const priorityA = getStatePriority(stateA);
  const priorityB = getStatePriority(stateB);
  
  if (priorityA >= priorityB) return stateA;
  return stateB;
}

/**
 * Merge seguro de pivots contactCompany del shadow al real, evitando duplicados.
 */
async function mergeContactCompanies(fromContactId: string, toContactId: string) {
  const fromPivots = await prisma.contactCompany.findMany({
    where: { contactId: fromContactId },
  });

  for (const p of fromPivots) {
    const existing = await prisma.contactCompany.findFirst({
      where: {
        contactId: toContactId,
        companyId: p.companyId,
      },
    });

    if (!existing) {
      await prisma.contactCompany.create({
        data: {
          contactId: toContactId,
          companyId: p.companyId,
          role: p.role || null,
          isPrimary: !!p.isPrimary,
        },
      });
    } else {
      const patch: any = {};
      if (!existing.role && p.role) patch.role = p.role;
      if (Object.keys(patch).length > 0) {
        await prisma.contactCompany.update({
          where: { id: existing.id },
          data: patch,
        });
      }
    }
  }

  await prisma.contactCompany.deleteMany({
    where: { contactId: fromContactId },
  });
}

/**
 * Mueve historial conversacional si tu ConversationHistory se vincula por phoneNumber.
 */
async function mergeConversationHistoryPhone(
  fromPhoneNumber: string,
  toPhoneNumber: string
) {
  if (!fromPhoneNumber || !toPhoneNumber) return;

  await prisma.conversationHistory.updateMany({
    where: { phoneNumber: fromPhoneNumber },
    data: { phoneNumber: toPhoneNumber },
  });
}

/* -------------------------------------------------
 * FUNCIONES NUEVAS (para Baileys v7: PN + LID)
 * ------------------------------------------------- */

/**
 * getOrCreateByBillysId:
 * - crea un contacto "shadow" cuando solo llega @lid (billysId),
 *   con phoneNumber sintético UNIQUE.
 * - si ya existe, lo devuelve.
 */
export async function getOrCreateByBillysId(billysId: string) {
  try {
    const existing = await prisma.contact.findUnique({
      where: { billysId },
      include: {
        companies: { include: { company: true } },
      },
    });
    if (existing) return existing;

    const shadowPhone = makeShadowPhoneFromBillysId(billysId);

    try {
      return await prisma.contact.create({
        data: {
          phoneNumber: shadowPhone,
          billysId,
          state: 'NEW',
        },
        include: {
          companies: { include: { company: true } },
        },
      });
    } catch (err: any) {
      logger.warn({ err }, 'Race on contact.create (by billysId), retrying findUnique...');
      return await prisma.contact.findUnique({
        where: { billysId },
        include: {
          companies: { include: { company: true } },
        },
      });
    }
  } catch (error) {
    logger.error({ err: error }, 'Error in getOrCreateByBillysId:');
    throw error;
  }
}

/**
 * ✅ SOLUCIÓN 2B APLICADA: attachLidToPhoneContact con merge inteligente de estados
 * 
 * - asegura que el contacto REAL por phoneNumber tenga billysId = @lid
 * - si existe un contacto shadow con ese billysId, lo MERGE al real:
 *    - mueve ContactCompany
 *    - mueve ConversationHistory (phoneNumber shadow -> real)
 *    - PRESERVA EL ESTADO MÁS AVANZADO (nuevo)
 *    - elimina shadow
 *
 * Importante: esto evita que el usuario "se vuelva a registrar" cuando llega @lid luego.
 */
export async function attachLidToPhoneContact(phoneNumber: string, billysId: string) {
  const phone = normalizePhone(phoneNumber);

  if (!phone || !billysId) return null;

  try {
    const result = await prisma.$transaction(async (tx) => {
      // 1) contacto real por phone
      let real = await tx.contact.findUnique({
        where: { phoneNumber: phone },
      });

      if (!real) {
        real = await tx.contact.create({
          data: { phoneNumber: phone, state: 'NEW', billysId },
        });
        logger.info(`[ATTACH-LID] Contacto real creado: ${phone} con billysId=${billysId}`);
        return real;
      }

      // 2) contacto shadow por billysId
      const shadow = await tx.contact.findUnique({
        where: { billysId },
      });

      // 3) Si no hay shadow, solo pegar billysId
      if (!shadow) {
        if (!real.billysId) {
          real = await tx.contact.update({
            where: { id: real.id },
            data: { billysId },
          });
          logger.info(`[ATTACH-LID] billysId asignado a contacto existente ${phone}`);
        }
        return real;
      }

      // 4) Si shadow == real, ok
      if (shadow.id === real.id) {
        return real;
      }

      // ✅ 5) MERGE INTELIGENTE: shadow -> real
      logger.warn(
        `[MERGE-START] Mergeando shadow=${shadow.id} (state=${shadow.state}) → real=${real.id} (state=${real.state})`
      );

      // a) Mover empresas
      const shadowPivots = await tx.contactCompany.findMany({
        where: { contactId: shadow.id },
      });

      for (const p of shadowPivots) {
        const exists = await tx.contactCompany.findFirst({
          where: { contactId: real.id, companyId: p.companyId },
        });

        if (!exists) {
          await tx.contactCompany.create({
            data: {
              contactId: real.id,
              companyId: p.companyId,
              role: p.role || null,
              isPrimary: !!p.isPrimary,
            },
          });
          logger.info(`[MERGE] Copiada empresa ${p.companyId} de shadow a real`);
        } else {
          if (!exists.role && p.role) {
            await tx.contactCompany.update({
              where: { id: exists.id },
              data: { role: p.role },
            });
          }
        }
      }

      await tx.contactCompany.deleteMany({
        where: { contactId: shadow.id },
      });

      // b) Mover conversation history
      await tx.conversationHistory.updateMany({
        where: { phoneNumber: shadow.phoneNumber },
        data: { phoneNumber: real.phoneNumber },
      });
      logger.info(`[MERGE] Movido historial conversacional de shadow a real`);

      // ✅ c) MERGE INTELIGENTE DE DATOS (incluyendo estado)
      const patch: any = {};

      // Copiar name/dni/companyName si real no tiene y shadow sí
      if (!real.name && shadow.name) patch.name = shadow.name;
      if (!real.dni && shadow.dni) patch.dni = shadow.dni;
      if (!real.companyName && shadow.companyName) patch.companyName = shadow.companyName;

      // ✅ CLAVE: Elegir el estado más avanzado
      const bestState = chooseBestState(real.state, shadow.state);
      if (bestState !== real.state) {
        patch.state = bestState;
        logger.info(
          `[MERGE-STATE] Eligiendo estado más avanzado: "${bestState}" (real="${real.state}", shadow="${shadow.state}")`
        );
      }

      if (Object.keys(patch).length > 0) {
        real = await tx.contact.update({
          where: { id: real.id },
          data: patch,
        });
        logger.info(`[MERGE] Actualizado contacto real con datos de shadow:`, patch);
      }

      // d) Eliminar shadow (libera billysId)
      await tx.contact.delete({
        where: { id: shadow.id },
      });
      logger.info(`[MERGE] Shadow eliminado: ${shadow.id}`);

      // e) Asegurar billysId en real
      if (real.billysId !== billysId) {
        real = await tx.contact.update({
          where: { id: real.id },
          data: { billysId },
        });
      }

      // f) Corregir múltiples primarias si existen
      const primaries = await tx.contactCompany.findMany({
        where: { contactId: real.id, isPrimary: true },
      });

      if (primaries.length > 1) {
        const keep = primaries[0];
        await tx.contactCompany.updateMany({
          where: { contactId: real.id },
          data: { isPrimary: false },
        });
        await tx.contactCompany.update({
          where: { id: keep.id },
          data: { isPrimary: true },
        });
        logger.info(`[MERGE] Corregidas múltiples empresas primarias`);
      }

      logger.info(
        `[MERGE-COMPLETE] ✅ Merge exitoso: ${phone} ahora tiene state="${real.state}", billysId="${billysId}"`
      );

      return real;
    });

    return result;
  } catch (error) {
    logger.error({ err: error }, 'Error in attachLidToPhoneContact:');
    return null;
  }
}

/* -------------------------------------------------
 * FUNCIONES EXPORTADAS DE APOYO MULTIEMPRESA
 * ------------------------------------------------- */

export async function linkExistingCompanyToContact(
  contactId: string,
  opts: {
    companyId: string;
    role?: string;
    isPrimary?: boolean;
  }
) {
  try {
    const company = await prisma.company.findUnique({
      where: { id: opts.companyId },
    });
    if (!company) {
      throw new Error('Empresa no encontrada');
    }

    let pivot = await prisma.contactCompany.findFirst({
      where: {
        contactId,
        companyId: opts.companyId,
      },
    });

    if (!pivot) {
      pivot = await prisma.contactCompany.create({
        data: {
          contactId,
          companyId: opts.companyId,
          role: opts.role || null,
          isPrimary: false,
        },
      });
    } else {
      if (opts.role !== undefined) {
        pivot = await prisma.contactCompany.update({
          where: { id: pivot.id },
          data: { role: opts.role || null },
        });
      }
    }

    if (opts.isPrimary) {
      await setPrimaryCompanyInternal(contactId, opts.companyId);

      await prisma.contact.update({
        where: { id: contactId },
        data: {
          companyName: company.name || company.razonSocial || 'SIN RAZON SOCIAL',
        },
      });
    }

    return pivot;
  } catch (error) {
    logger.error({ err: error }, 'Error linking existing company:');
    throw error;
  }
}

export async function linkExistingCompanyByRucAndSetPrimary(
  phoneNumber: string,
  ruc: string
): Promise<{ ok: boolean; reason?: string }> {
  try {
    const phone = normalizePhone(phoneNumber);

    if (!isValidRUC(ruc)) {
      return { ok: false, reason: 'INVALID_RUC' };
    }

    const contact = await prisma.contact.findUnique({
      where: { phoneNumber: phone },
    });
    if (!contact) {
      return { ok: false, reason: 'CONTACT_NOT_FOUND' };
    }

    const existingCompany = await prisma.company.findFirst({
      where: {
        OR: [{ ruc }, { numeroDoc: ruc }],
      },
    });

    if (!existingCompany) {
      logger.info(
        `[RUC-LINK] Empresa con RUC ${ruc} no existe aún. Se pedirá razón social`
      );
      return { ok: false, reason: 'COMPANY_NOT_FOUND' };
    }

    let pivot = await prisma.contactCompany.findFirst({
      where: {
        contactId: contact.id,
        companyId: existingCompany.id,
      },
    });

    if (!pivot) {
      pivot = await prisma.contactCompany.create({
        data: {
          contactId: contact.id,
          companyId: existingCompany.id,
          role: null,
          isPrimary: false,
        },
      });
    }

    await setPrimaryCompanyInternal(contact.id, existingCompany.id);

    await prisma.contact.update({
      where: { id: contact.id },
      data: {
        companyName:
          existingCompany.name ||
          existingCompany.razonSocial ||
          'SIN RAZON SOCIAL',
        state: 'REGISTERED',
      },
    });

    return { ok: true };
  } catch (error) {
    logger.error(
      { err: error },
      'linkExistingCompanyByRucAndSetPrimary error:'
    );
    return { ok: false, reason: 'EXCEPTION' };
  }
}

/* -------------------------------------------------
 * LECTURA / CONSULTA
 * ------------------------------------------------- */

export async function findByPhone(phoneNumber: string) {
  try {
    const phone = normalizePhone(phoneNumber);
    return await prisma.contact.findUnique({
      where: { phoneNumber: phone },
      include: {
        companies: {
          include: {
            company: true,
          },
        },
      },
    });
  } catch (error) {
    logger.error({ err: error }, 'Error finding contact by phone:');
    return null;
  }
}

export async function findByBillysId(billysId: string) {
  try {
    return await prisma.contact.findUnique({
      where: { billysId },
      include: {
        companies: {
          include: {
            company: true,
          },
        },
      },
    });
  } catch (error) {
    logger.error({ err: error }, 'Error finding contact by billysId:');
    return null;
  }
}

export async function getAll(limit?: number, offset?: number) {
  try {
    const contacts = await prisma.contact.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit ?? undefined,
      skip: offset ?? undefined,
      include: {
        companies: {
          include: {
            company: true,
          },
        },
      },
    });

    return contacts.map((c) => {
      const { companyName, ruc } = resolvePrimaryCompany(c);

      return {
        id: c.id,
        phoneNumber: c.phoneNumber,
        billysId: c.billysId,
        name: c.name,
        dni: c.dni,
        ruc: ruc,
        companyName: companyName,
        state: c.state,
        isBlocked: c.isBlocked,
        humanTakeoverAt: c.humanTakeoverAt,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
      };
    });
  } catch (error) {
    logger.error({ err: error }, 'Error getting all contacts:');
    return [];
  }
}

export async function isRegistered(phoneNumber: string): Promise<boolean> {
  try {
    const contact = await findByPhone(phoneNumber);
    return contact?.state === 'REGISTERED';
  } catch (error) {
    logger.error({ err: error }, 'Error checking registration:');
    return false;
  }
}

export async function getAllCompaniesForContact(contactId: string) {
  try {
    const contact = await prisma.contact.findUnique({
      where: { id: contactId },
      include: {
        companies: {
          include: {
            company: true,
          },
          orderBy: {
            createdAt: 'asc',
          },
        },
      },
    });

    if (!contact) return [];

    return contact.companies.map((cc: any) => ({
      companyId: cc.companyId,
      name: cc.company?.name || cc.company?.razonSocial || null,
      ruc: cc.company?.ruc || cc.company?.numeroDoc || null,
      role: cc.role || null,
      isPrimary: cc.isPrimary || false,
    }));
  } catch (error) {
    logger.error({ err: error }, 'Error getting companies for contact:');
    return [];
  }
}

export function resolvePrimaryCompany(contact: any) {
  if (contact?.companies && contact.companies.length > 0) {
    const primary = contact.companies.find((cc: any) => cc.isPrimary);
    const chosen = primary || contact.companies[0];
    if (chosen && chosen.company) {
      return {
        companyName:
          chosen.company.name ||
          chosen.company.razonSocial ||
          contact?.companyName ||
          null,
        ruc:
          chosen.company.ruc ||
          chosen.company.numeroDoc ||
          contact?.ruc ||
          null,
      };
    }
  }

  return {
    companyName: contact?.companyName ?? null,
    ruc: contact?.ruc ?? null,
  };
}

/* -------------------------------------------------
 * CREAR / OBTENER
 * ------------------------------------------------- */

export async function create(phoneNumber: string, billysId?: string) {
  try {
    const phone = normalizePhone(phoneNumber);

    return await prisma.contact.create({
      data: {
        phoneNumber: phone,
        billysId: billysId || undefined,
        state: 'NEW',
      },
    });
  } catch (error: any) {
    logger.error({ err: error }, 'Error creating contact:');
    throw error;
  }
}

export async function getOrCreate(phoneNumber: string) {
  const phone = normalizePhone(phoneNumber);
  const existing = await findByPhone(phone);
  if (existing) return existing;

  try {
    return await prisma.contact.create({
      data: { phoneNumber: phone, state: 'NEW' },
    });
  } catch (err: any) {
    logger.warn('Race on contact.create, retrying find:', err?.message || err);
    return await findByPhone(phone);
  }
}

/**
 * linkBillysId:
 * - asigna billysId a un contacto existente identificado por phoneNumber
 * - sólo si ese contacto aún no tiene billysId
 */
export async function linkBillysId(phoneNumber: string, billysId: string) {
  try {
    const phone = normalizePhone(phoneNumber);

    const contact = await prisma.contact.findUnique({
      where: { phoneNumber: phone },
    });
    if (!contact) {
      logger.warn(`linkBillysId: contact not found for ${phone}, creating new`);
      return await prisma.contact.create({
        data: {
          phoneNumber: phone,
          billysId,
          state: 'NEW',
        },
      });
    }

    if (contact.billysId) {
      return contact;
    }

    return await prisma.contact.update({
      where: { phoneNumber: phone },
      data: { billysId },
    });
  } catch (error) {
    logger.error({ err: error }, 'Error linking billysId:');
    throw error;
  }
}

/* -------------------------------------------------
 * ACTUALIZACIONES DE IDENTIDAD / ESTADO
 * ------------------------------------------------- */

export async function updateDNI(phoneNumber: string, dni: string, name: string) {
  try {
    const phone = normalizePhone(phoneNumber);

    if (!isValidDNI(dni)) {
      throw new Error(`DNI inválido: ${dni}`);
    }

    return await prisma.contact.update({
      where: { phoneNumber: phone },
      data: {
        dni,
        name,
        state: 'WAITING_RUC',
      },
    });
  } catch (error) {
    logger.error({ err: error }, 'Error updating DNI:');
    throw error;
  }
}

export async function updateRUC(
  phoneNumber: string,
  ruc: string,
  companyName: string
) {
  try {
    const phone = normalizePhone(phoneNumber);

    if (!isValidRUC(ruc)) {
      throw new Error(`RUC inválido: ${ruc}`);
    }

    const contact = await prisma.contact.findUnique({
      where: { phoneNumber: phone },
    });
    if (!contact) throw new Error('Contacto no encontrado');

    const company = await getOrCreateCompany(ruc, companyName);

    let pivot = await prisma.contactCompany.findFirst({
      where: {
        contactId: contact.id,
        companyId: company.id,
      },
    });

    if (!pivot) {
      pivot = await prisma.contactCompany.create({
        data: {
          contactId: contact.id,
          companyId: company.id,
          role: null,
          isPrimary: false,
        },
      });
    }

    await setPrimaryCompanyInternal(contact.id, company.id);

    return await prisma.contact.update({
      where: { phoneNumber: phone },
      data: {
        companyName: company.name || company.razonSocial || companyName,
        state: 'REGISTERED',
      },
    });
  } catch (error) {
    logger.error({ err: error }, 'Error updating RUC:');
    throw error;
  }
}

export async function updateState(phoneNumber: string, state: string) {
  try {
    const phone = normalizePhone(phoneNumber);
    return await prisma.contact.update({
      where: { phoneNumber: phone },
      data: { state },
    });
  } catch (error) {
    logger.error({ err: error }, 'Error updating state:');
    throw error;
  }
}

export async function updateContactInfo(
  contactId: string,
  patch: {
    name?: string;
    dni?: string;
    state?: string;
    isBlocked?: boolean;
    humanTakeoverAt?: Date | null;
  }
) {
  try {
    const data: any = {};

    if (patch.name !== undefined) data.name = patch.name?.trim() || null;
    if (patch.dni !== undefined) {
      if (patch.dni && !isValidDNI(patch.dni)) {
        throw new Error(`DNI inválido: ${patch.dni}`);
      }
      data.dni = patch.dni || null;
    }
    if (patch.state !== undefined) data.state = patch.state;
    if (patch.isBlocked !== undefined) data.isBlocked = patch.isBlocked;
    if (patch.humanTakeoverAt !== undefined)
      data.humanTakeoverAt = patch.humanTakeoverAt;

    return await prisma.contact.update({
      where: { id: contactId },
      data,
    });
  } catch (error) {
    logger.error({ err: error }, 'Error updating contact info:');
    throw error;
  }
}

/* -------------------------------------------------
 * MULTIEMPRESA
 * ------------------------------------------------- */

export async function addCompanyToContact(
  contactId: string,
  opts: {
    ruc: string;
    name: string;
    role?: string;
    isPrimary?: boolean;
  }
) {
  try {
    if (!isValidRUC(opts.ruc)) {
      throw new Error(`RUC inválido: ${opts.ruc}`);
    }

    const company = await getOrCreateCompany(opts.ruc, opts.name);

    let pivot = await prisma.contactCompany.findFirst({
      where: {
        contactId,
        companyId: company.id,
      },
    });

    if (!pivot) {
      pivot = await prisma.contactCompany.create({
        data: {
          contactId,
          companyId: company.id,
          role: opts.role || null,
          isPrimary: false,
        },
      });
    } else {
      if (opts.role !== undefined) {
        pivot = await prisma.contactCompany.update({
          where: { id: pivot.id },
          data: { role: opts.role || null },
        });
      }
    }

    if (opts.isPrimary) {
      await setPrimaryCompanyInternal(contactId, company.id);

      await prisma.contact.update({
        where: { id: contactId },
        data: {
          companyName: company.name || company.razonSocial || opts.name || null,
        },
      });
    }

    return pivot;
  } catch (error) {
    logger.error({ err: error }, 'Error adding company to contact:');
    throw error;
  }
}

export async function setPrimaryCompany(contactId: string, companyId: string) {
  try {
    const pivot = await prisma.contactCompany.findFirst({
      where: { contactId, companyId },
      include: { company: true },
    });
    if (!pivot) {
      throw new Error('Relación contacto-empresa no existe');
    }

    await setPrimaryCompanyInternal(contactId, companyId);

    await prisma.contact.update({
      where: { id: contactId },
      data: {
        companyName:
          pivot.company.name || pivot.company.razonSocial || 'SIN RAZON SOCIAL',
      },
    });

    return true;
  } catch (error) {
    logger.error({ err: error }, 'Error setting primary company:');
    throw error;
  }
}

export async function removeCompanyFromContact(contactId: string, companyId: string) {
  try {
    const pivot = await prisma.contactCompany.findFirst({
      where: { contactId, companyId },
    });
    if (!pivot) return false;

    const wasPrimary = pivot.isPrimary;

    await prisma.contactCompany.delete({
      where: { id: pivot.id },
    });

    if (wasPrimary) {
      const remaining = await prisma.contactCompany.findFirst({
        where: { contactId },
        include: { company: true },
        orderBy: { createdAt: 'asc' },
      });

      if (remaining) {
        await setPrimaryCompanyInternal(contactId, remaining.companyId);

        await prisma.contact.update({
          where: { id: contactId },
          data: {
            companyName:
              remaining.company.name ||
              remaining.company.razonSocial ||
              'SIN RAZON SOCIAL',
          },
        });
      } else {
        await prisma.contact.update({
          where: { id: contactId },
          data: {
            companyName: null,
          },
        });
      }
    }

    return true;
  } catch (error) {
    logger.error({ err: error }, 'Error removing company from contact:');
    throw error;
  }
}

/* -------------------------------------------------
 * TAKEOVER HUMANO / BLOQUEO / BOT
 * ------------------------------------------------- */

export async function setHumanTakeover(phoneNumber: string) {
  const phone = normalizePhone(phoneNumber);
  logger.info(`[CONTACT] Setting human takeover for ${phone}`);

  try {
    let contact = await prisma.contact.findUnique({
      where: { phoneNumber: phone },
    });

    if (!contact) {
      logger.warn(
        `[CONTACT] setHumanTakeover: contact not found for ${phone}, creating new contact`
      );
      contact = await prisma.contact.create({
        data: {
          phoneNumber: phone,
          state: 'NEW',
          humanTakeoverAt: new Date(),
        },
      });
      return contact;
    }

    return await prisma.contact.update({
      where: { phoneNumber: phone },
      data: {
        humanTakeoverAt: new Date(),
      },
    });
  } catch (error: any) {
    if (error?.code === 'P2025') {
      logger.warn(
        `[CONTACT] setHumanTakeover: P2025 for ${phone} (no contact on update), ignoring`
      );
      return null;
    }

    logger.error({ err: error }, 'Error setting human takeover:');
    throw error;
  }
}

export async function releaseHumanTakeover(phoneNumber: string) {
  const phone = normalizePhone(phoneNumber);
  logger.info(`[CONTACT] Releasing human takeover for ${phone}`);

  try {
    const contact = await prisma.contact.findUnique({
      where: { phoneNumber: phone },
    });

    if (!contact) {
      logger.warn(
        `[CONTACT] releaseHumanTakeover: contact not found for ${phone}, nothing to release`
      );
      return null;
    }

    return await prisma.contact.update({
      where: { phoneNumber: phone },
      data: {
        humanTakeoverAt: null,
      },
    });
  } catch (error: any) {
    if (error?.code === 'P2025') {
      logger.warn(
        `[CONTACT] releaseHumanTakeover: P2025 for ${phone} (no contact on update), ignoring`
      );
      return null;
    }

    logger.error({ err: error }, 'Error releasing human takeover:');
    throw error;
  }
}

export async function shouldBotRespond(phoneNumber: string): Promise<boolean> {
  try {
    const phone = normalizePhone(phoneNumber);
    const contact = await prisma.contact.findUnique({
      where: { phoneNumber: phone },
    });

    if (!contact) return true;

    const onboardingStates = [
      'NEW',
      'WAITING_DNI',
      'WAITING_RUC',
      'WAITING_COMPANY_NAME',
      'SELECTING_COMPANY',
    ];

    if (onboardingStates.includes(contact.state)) {
      if (contact.humanTakeoverAt) {
        await prisma.contact.update({
          where: { phoneNumber: phone },
          data: { humanTakeoverAt: null },
        });
        logger.info(
          `[CONTACT] Clearing human takeover for ${phone} in onboarding state=${contact.state}`
        );
      }
      return true;
    }

    if (!contact.humanTakeoverAt) return true;

    const now = new Date();
    const diff = now.getTime() - contact.humanTakeoverAt.getTime();
    const oneHourInMs = 60 * 60 * 1000;

    if (diff > oneHourInMs) {
      await prisma.contact.update({
        where: { phoneNumber: phone },
        data: { humanTakeoverAt: null },
      });
      logger.info(
        `[CONTACT] Released human takeover for ${phone} after ${Math.round(
          diff / 60000
        )} minutes`
      );
      return true;
    }

    const remainingMinutes = Math.round((oneHourInMs - diff) / 60000);
    logger.info(
      `[CONTACT] Bot paused for ${phone} - ${remainingMinutes} minutes remaining (state=${contact.state})`
    );
    return false;
  } catch (error) {
    logger.error({ err: error }, 'Error checking if bot should respond:');
    return true;
  }
}

export async function blockContact(phoneNumber: string, reason: string = 'Bloqueado') {
  try {
    const phone = normalizePhone(phoneNumber);

    const updated = await prisma.contact.update({
      where: { phoneNumber: phone },
      data: { isBlocked: true },
    });

    await prisma.blockedNumber.upsert({
      where: { identifier: phone },
      update: {
        reason,
        type: 'PHONE',
      },
      create: {
        identifier: phone,
        type: 'PHONE',
        reason,
      },
    });

    return updated;
  } catch (error) {
    logger.error({ err: error }, 'Error blocking contact:');
    throw error;
  }
}

export async function unblockContact(phoneNumber: string) {
  try {
    const phone = normalizePhone(phoneNumber);

    const updated = await prisma.contact.update({
      where: { phoneNumber: phone },
      data: { isBlocked: false },
    });

    return updated;
  } catch (error) {
    logger.error({ err: error }, 'Error unblocking contact:');
    throw error;
  }
}

/* -------------------------------------------------
 * IMPORT / EXPORT EXCEL
 * ------------------------------------------------- */

export async function exportContactsToExcelData() {
  try {
    const contacts = await prisma.contact.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        companies: {
          include: { company: true },
        },
      },
    });

    return contacts.map((c) => {
      const primary = c.companies.find((cc: any) => cc.isPrimary);
      const fallback = primary || c.companies[0] || null;

      const primaryCompanyName =
        fallback?.company?.name ||
        fallback?.company?.razonSocial ||
        c.companyName ||
        null;
      const primaryCompanyRuc =
        fallback?.company?.ruc ||
        fallback?.company?.numeroDoc ||
        c.ruc ||
        null;

      const extraCompanies = c.companies
        .filter((cc: any) => !primary || cc.companyId !== primary.companyId)
        .map((cc: any) => ({
          ruc: cc.company?.ruc || cc.company?.numeroDoc || null,
          name: cc.company?.name || cc.company?.razonSocial || null,
          role: cc.role || null,
        }));

      return {
        phoneNumber: c.phoneNumber,
        name: c.name,
        dni: c.dni,
        state: c.state,
        isBlocked: c.isBlocked,
        humanTakeoverAt: c.humanTakeoverAt,
        primaryCompanyName,
        primaryCompanyRuc,
        extraCompanies,
        createdAt: c.createdAt,
      };
    });
  } catch (error) {
    logger.error({ err: error }, 'Error preparing export data:');
    throw error;
  }
}

export async function importContactsFromExcel(
  rows: Array<{
    phoneNumber: string;
    name?: string;
    dni?: string;
    companies?: Array<{
      ruc: string;
      name: string;
      role?: string;
      primary?: boolean;
    }>;
  }>
) {
  const results: any[] = [];

  for (const row of rows) {
    try {
      const phone = normalizePhone(row.phoneNumber);

      let contact = await prisma.contact.findUnique({
        where: { phoneNumber: phone },
      });

      if (!contact) {
        contact = await prisma.contact.create({
          data: {
            phoneNumber: phone,
            name: row.name?.trim() || null,
            dni: row.dni && isValidDNI(row.dni) ? row.dni : null,
            state: 'REGISTERED',
          },
        });
      } else {
        const patchData: any = {};
        if (!contact.name && row.name) patchData.name = row.name.trim();
        if (!contact.dni && row.dni && isValidDNI(row.dni)) patchData.dni = row.dni;
        if (Object.keys(patchData).length > 0) {
          contact = await prisma.contact.update({
            where: { id: contact.id },
            data: patchData,
          });
        }
      }

      if (row.companies && row.companies.length > 0) {
        for (const comp of row.companies) {
          if (!comp.ruc || !comp.name) continue;
          if (!isValidRUC(comp.ruc)) continue;

          await addCompanyToContact(contact.id, {
            ruc: comp.ruc,
            name: comp.name,
            role: comp.role,
            isPrimary: !!comp.primary,
          });
        }
      }

      results.push({ phoneNumber: phone, status: 'OK' });
    } catch (err: any) {
      logger.error({ err }, 'Error importing row:');
      results.push({
        phoneNumber: row.phoneNumber,
        status: 'ERROR',
        error: err?.message || String(err),
      });
    }
  }

  return results;
}

/* -------------------------------------------------
 * ELIMINACIÓN MANUAL
 * ------------------------------------------------- */

export async function deleteContact(contactId: string) {
  try {
    await prisma.contactCompany.deleteMany({
      where: { contactId },
    });

    const existing = await prisma.contact.findUnique({
      where: { id: contactId },
    });

    if (existing) {
      await prisma.conversationHistory.deleteMany({
        where: { phoneNumber: existing.phoneNumber },
      });
    }

    await prisma.contact.delete({
      where: { id: contactId },
    });

    return true;
  } catch (error) {
    logger.error({ err: error }, 'Error deleting contact:');
    throw error;
  }
}
