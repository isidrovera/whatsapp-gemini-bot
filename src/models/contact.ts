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
  // Desmarcar todas las empresas del contacto
  await prisma.contactCompany.updateMany({
    where: { contactId },
    data: { isPrimary: false },
  });

  // Marcar esta como primaria
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

  // buscamos empresa existente por ruc legacy o numeroDoc
  let existing = await prisma.company.findFirst({
    where: {
      OR: [{ ruc: cleanedRuc }, { numeroDoc: cleanedRuc }],
    },
  });

  if (existing) {
    // merge defensivo por si faltan algunos campos
    const patchData: Record<string, any> = {};

    if (!existing.razonSocial && cleanedName) {
      patchData.razonSocial = cleanedName;
    }
    if (!existing.name && cleanedName) {
      patchData.name = cleanedName;
    }
    if (!existing.numeroDoc) {
      patchData.numeroDoc = cleanedRuc;
    }
    if (!existing.ruc) {
      patchData.ruc = cleanedRuc;
    }

    if (Object.keys(patchData).length > 0) {
      existing = await prisma.company.update({
        where: { id: existing.id },
        data: patchData,
      });
    }

    return existing;
  }

  // crear nueva empresa
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

/* -------------------------------------------------
 * FUNCIONES EXPORTADAS DE APOYO MULTIEMPRESA
 * ------------------------------------------------- */

/**
 * Vincula una empresa existente (companyId ya conocido) a un contacto.
 * Opcionalmente la marca como principal.
 */
export async function linkExistingCompanyToContact(
  contactId: string,
  opts: {
    companyId: string;
    role?: string;
    isPrimary?: boolean;
  }
) {
  try {
    // 1. asegurar que la empresa exista
    const company = await prisma.company.findUnique({
      where: { id: opts.companyId },
    });
    if (!company) {
      throw new Error('Empresa no encontrada');
    }

    // 2. asegurar relación pivot
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
      // si ya existe, podemos actualizar role
      if (opts.role !== undefined) {
        pivot = await prisma.contactCompany.update({
          where: { id: pivot.id },
          data: { role: opts.role || null },
        });
      }
    }

    // 3. si pidió "principal", marcamos esta como primary
    if (opts.isPrimary) {
      await setPrimaryCompanyInternal(contactId, opts.companyId);

      // reflejar en contact.companyName;
      // ⚠ ya NO seteamos contact.ruc porque contact.ruc es UNIQUE
      await prisma.contact.update({
        where: { id: contactId },
        data: {
          companyName:
            company.name ||
            company.razonSocial ||
            'SIN RAZON SOCIAL',
        },
      });
    }

    return pivot;
  } catch (error) {
    logger.error({ err: error },'Error linking existing company:');
    throw error;
  }
}

/**
 * Intenta:
 *  - Buscar contacto por phoneNumber
 *  - Buscar company existente por RUC/numeroDoc
 *  - Vincular esa company al contacto si existe
 *  - Marcarla primaria
 *  - Actualizar contact.companyName y state='REGISTERED'
 *
 * Importante: ya NO escribimos contact.ruc
 * porque ese campo es UNIQUE en Contact y rompe si varios contactos usan el mismo RUC.
 */
export async function linkExistingCompanyByRucAndSetPrimary(
  phoneNumber: string,
  ruc: string
): Promise<{ ok: boolean; reason?: string }> {
  try {
    const phone = normalizePhone(phoneNumber);

    if (!isValidRUC(ruc)) {
      return { ok: false, reason: 'INVALID_RUC' };
    }

    // 1. asegurar contacto
    const contact = await prisma.contact.findUnique({
      where: { phoneNumber: phone },
    });
    if (!contact) {
      return { ok: false, reason: 'CONTACT_NOT_FOUND' };
    }

    // 2. buscar empresa ya existente con ese RUC
    const existingCompany = await prisma.company.findFirst({
      where: {
        OR: [{ ruc }, { numeroDoc: ruc }],
      },
    });

    if (!existingCompany) {
      // no hay empresa aún → necesitamos pedir razón social más adelante
      logger.info(
        `[RUC-LINK] Empresa con RUC ${ruc} no existe aún. Se pedirá razón social`
      );
      return { ok: false, reason: 'COMPANY_NOT_FOUND' };
    }

    // 3. asegurar pivot contact_company
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

    // 4. marcar como primaria
    await setPrimaryCompanyInternal(contact.id, existingCompany.id);

    // 5. reflejar SOLO companyName + state en el contacto
    //    ⚠ NO seteamos contact.ruc porque es UNIQUE en Contact
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
    logger.error({ err: error },'linkExistingCompanyByRucAndSetPrimary error:');
    return { ok: false, reason: 'EXCEPTION' };
  }
}

/* -------------------------------------------------
 * LECTURA / CONSULTA
 * ------------------------------------------------- */

/**
 * Busca contacto por teléfono normalizado (E.164 sin '+').
 * Incluye sus empresas asociadas.
 */
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
    logger.error({ err: error },'Error finding contact by phone:');
    return null;
  }
}

/**
 * Busca contacto por billysId (ID técnico WhatsApp ej "5192...@c.us")
 */
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
    logger.error({ err: error },'Error finding contact by billysId:');
    return null;
  }
}

/**
 * Lista todos los contactos (más recientes primero)
 * Enriquecidos con su empresa primaria calculada.
 */
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

    // pre-formatear para la vista
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
    logger.error({ err: error },'Error getting all contacts:');
    return [];
  }
}

/**
 * ¿Está registrado?
 */
export async function isRegistered(phoneNumber: string): Promise<boolean> {
  try {
    const contact = await findByPhone(phoneNumber);
    return contact?.state === 'REGISTERED';
  } catch (error) {
    logger.error({ err: error },'Error checking registration:');
    return false;
  }
}

/**
 * Devuelve TODAS las empresas asociadas a un contacto,
 * con su RUC, rol y si es la principal.
 */
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
    logger.error({ err: error },'Error getting companies for contact:');
    return [];
  }
}

/**
 * Retorna { companyName, ruc } para la empresa primaria del contacto.
 * Si no hay primaria, intenta la primera. Si no hay ninguna, cae a los campos legacy.
 *
 * ⚠ Esta función la usa whatsapp.ts (buildMainMenu, generateOdooLinkForContact)
 * así que debe ser exportada.
 */
export function resolvePrimaryCompany(contact: any) {
  // contact.companies: ContactCompany[] con { isPrimary, role, company: { name, razonSocial, ruc, numeroDoc } }

  if (contact?.companies && contact.companies.length > 0) {
    // buscar la primary explícita
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

  // fallback legacy
  return {
    companyName: contact?.companyName ?? null,
    ruc: contact?.ruc ?? null,
  };
}

/* -------------------------------------------------
 * CREAR / OBTENER
 * ------------------------------------------------- */

/**
 * Crea contacto NUEVO (lanza si ya existe)
 */
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
    logger.error({ err: error },'Error creating contact:');
    throw error;
  }
}

/**
 * getOrCreate:
 * - normaliza phone
 * - busca por phone
 * - si existe:
 *    - si no tiene billysId y recibimos uno → lo seteamos
 * - si NO existe:
 *    - creamos con state=NEW (y billysId si viene)
 * Maneja race condition.
 */
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
 *  - asigna billysId a un contacto existente identificado por phoneNumber
 *  - sólo si ese contacto aún no tiene billysId
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
      // ya tiene billysId, no lo sobreescribimos
      return contact;
    }

    return await prisma.contact.update({
      where: { phoneNumber: phone },
      data: { billysId },
    });
  } catch (error) {
    logger.error({ err: error },'Error linking billysId:');
    throw error;
  }
}

/* -------------------------------------------------
 * ACTUALIZACIONES DE IDENTIDAD / ESTADO
 * ------------------------------------------------- */

/**
 * Actualiza DNI y nombre; pasa a WAITING_RUC
 */
export async function updateDNI(
  phoneNumber: string,
  dni: string,
  name: string
) {
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
    logger.error({ err: error },'Error updating DNI:');
    throw error;
  }
}

/**
 * Actualiza RUC y razón social; pasa a REGISTERED
 *
 * - asegura/crea Company
 * - asegura pivot ContactCompany
 * - marca esa empresa como primaria
 * - actualiza contact.companyName y state='REGISTERED'
 *
 * ⚠ YA NO escribe contact.ruc (para no violar UNIQUE si
 * varios contactos usan el mismo RUC)
 */
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

    // 1. asegurar contacto
    const contact = await prisma.contact.findUnique({
      where: { phoneNumber: phone },
    });
    if (!contact) throw new Error('Contacto no encontrado');

    // 2. asegurar company (crea si no existe)
    const company = await getOrCreateCompany(ruc, companyName);

    // 3. asegurar pivot ContactCompany
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

    // 4. marcar esa empresa como primaria para este contacto
    await setPrimaryCompanyInternal(contact.id, company.id);

    // 5. actualizar contacto legacy + estado
    return await prisma.contact.update({
      where: { phoneNumber: phone },
      data: {
        companyName:
          company.name ||
          company.razonSocial ||
          companyName,
        state: 'REGISTERED',
      },
    });
  } catch (error) {
    logger.error({ err: error },'Error updating RUC:');
    throw error;
  }
}

/**
 * Cambia el estado (NEW / WAITING_DNI / WAITING_RUC / REGISTERED / etc.)
 */
export async function updateState(phoneNumber: string, state: string) {
  try {
    const phone = normalizePhone(phoneNumber);
    return await prisma.contact.update({
      where: { phoneNumber: phone },
      data: { state },
    });
  } catch (error) {
    logger.error({ err: error },'Error updating state:');
    throw error;
  }
}

/**
 * Edición manual desde panel:
 * - nombre
 * - dni
 * - state
 * - isBlocked
 * - humanTakeoverAt (forzado)
 */
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
    logger.error({ err: error },'Error updating contact info:');
    throw error;
  }
}

/* -------------------------------------------------
 * MULTIEMPRESA
 * ------------------------------------------------- */

/**
 * Agrega o asegura una empresa en el contacto.
 * Si isPrimary = true, la deja como principal.
 *
 * ⚠ Cuando marcamos como primaria ya NO seteamos contact.ruc,
 * solo contact.companyName (para evitar UNIQUE en Contact.ruc).
 */
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

    // asegurar empresa
    const company = await getOrCreateCompany(opts.ruc, opts.name);

    // asegurar vínculo
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
      // actualizar role si vino
      if (opts.role !== undefined) {
        pivot = await prisma.contactCompany.update({
          where: { id: pivot.id },
          data: { role: opts.role || null },
        });
      }
    }

    // marcar primaria si se pidió
    if (opts.isPrimary) {
      await setPrimaryCompanyInternal(contactId, company.id);

      // reflejar en contacto legacy SOLO companyName
      await prisma.contact.update({
        where: { id: contactId },
        data: {
          companyName:
            company.name ||
            company.razonSocial ||
            opts.name ||
            null,
        },
      });
    }

    return pivot;
  } catch (error) {
    logger.error({ err: error },'Error adding company to contact:');
    throw error;
  }
}

/**
 * Cambia la empresa principal del contacto.
 *
 * Ya NO seteamos contact.ruc aquí (por el UNIQUE),
 * solo actualizamos companyName.
 */
export async function setPrimaryCompany(
  contactId: string,
  companyId: string
) {
  try {
    // 1. asegurar que la relación exista
    const pivot = await prisma.contactCompany.findFirst({
      where: { contactId, companyId },
      include: { company: true },
    });
    if (!pivot) {
      throw new Error('Relación contacto-empresa no existe');
    }

    // 2. marcar como primaria y desmarcar las demás
    await setPrimaryCompanyInternal(contactId, companyId);

    // 3. reflejar en contacto legacy SOLO companyName
    await prisma.contact.update({
      where: { id: contactId },
      data: {
        companyName:
          pivot.company.name ||
          pivot.company.razonSocial ||
          'SIN RAZON SOCIAL',
      },
    });

    return true;
  } catch (error) {
    logger.error({ err: error },'Error setting primary company:');
    throw error;
  }
}

/**
 * Quita una empresa del contacto.
 *
 * Si borramos la empresa primaria, reasignamos otra como primaria
 * y actualizamos SOLO companyName (sin tocar ruc).
 * Si ya no queda ninguna empresa, limpiamos companyName.
 */
export async function removeCompanyFromContact(
  contactId: string,
  companyId: string
) {
  try {
    // ver si era primaria
    const pivot = await prisma.contactCompany.findFirst({
      where: { contactId, companyId },
    });
    if (!pivot) return false;

    const wasPrimary = pivot.isPrimary;

    // borrar la relación
    await prisma.contactCompany.delete({
      where: { id: pivot.id },
    });

    if (wasPrimary) {
      // reasignar otra primaria si existe
      const remaining = await prisma.contactCompany.findFirst({
        where: { contactId },
        include: { company: true },
        orderBy: { createdAt: 'asc' },
      });

      if (remaining) {
        await setPrimaryCompanyInternal(contactId, remaining.companyId);

        // reflejar en contacto legacy SOLO companyName
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
        // si ya no tiene empresas, limpiamos companyName
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
    logger.error({ err: error },'Error removing company from contact:');
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
    // 1) Buscar contacto
    let contact = await prisma.contact.findUnique({
      where: { phoneNumber: phone },
    });

    // 2) Si no existe, lo creamos con takeover activo
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

    // 3) Si existe, actualizar takeover
    return await prisma.contact.update({
      where: { phoneNumber: phone },
      data: {
        humanTakeoverAt: new Date(),
      },
    });
  } catch (error: any) {
    if (error?.code === 'P2025') {
      // Race rara: entre el findUnique y el update alguien borró el contacto
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
    // 1) Verificamos si existe el contacto
    const contact = await prisma.contact.findUnique({
      where: { phoneNumber: phone },
    });

    if (!contact) {
      logger.warn(
        `[CONTACT] releaseHumanTakeover: contact not found for ${phone}, nothing to release`
      );
      return null;
    }

    // 2) Limpiar takeover
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

/**
 * Determina si el bot debe responder:
 *  - Si no existe contacto → true (responder)
 *  - Si no hay takeover → true
 *  - Si takeover > 1h → liberar y true
 *  - Si takeover vigente → false (pausado)
 */
export async function shouldBotRespond(
  phoneNumber: string
): Promise<boolean> {
  try {
    const phone = normalizePhone(phoneNumber);
    const contact = await prisma.contact.findUnique({
      where: { phoneNumber: phone },
    });

    if (!contact) return true;
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

    const remainingMinutes = Math.round(
      (oneHourInMs - diff) / 60000
    );
    logger.info(
      `[CONTACT] Bot paused for ${phone} - ${remainingMinutes} minutes remaining`
    );
    return false;
  } catch (error) {
    logger.error({ err: error },'Error checking if bot should respond:');
    // en caso de error no bloqueamos al bot
    return true;
  }
}

/**
 * Bloquear contacto para que el bot no lo atienda más
 */
export async function blockContact(
  phoneNumber: string,
  reason: string = 'Bloqueado'
) {
  try {
    const phone = normalizePhone(phoneNumber);

    // marcamos isBlocked en la tabla de contactos
    const updated = await prisma.contact.update({
      where: { phoneNumber: phone },
      data: { isBlocked: true },
    });

    // opcional: registramos en la tabla BlockedNumber
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
    logger.error({ err: error },'Error blocking contact:');
    throw error;
  }
}

/**
 * Desbloquear contacto
 */
export async function unblockContact(phoneNumber: string) {
  try {
    const phone = normalizePhone(phoneNumber);

    const updated = await prisma.contact.update({
      where: { phoneNumber: phone },
      data: { isBlocked: false },
    });

    // no eliminamos forzosamente el registro de BlockedNumber (auditoría)
    return updated;
  } catch (error) {
    logger.error({ err: error },'Error unblocking contact:');
    throw error;
  }
}

/* -------------------------------------------------
 * IMPORT / EXPORT EXCEL
 * ------------------------------------------------- */

/**
 * Prepara datos para exportar a Excel.
 * NO genera el archivo XLSX aquí, solo devuelve data estructurada.
 */
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
      // primaria y adicionales
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
        c.ruc || // ojo: legacy, puede estar seteado en algunos contactos viejos
        null;

      const extraCompanies = c.companies
        .filter((cc: any) => !primary || cc.companyId !== primary.companyId)
        .map((cc: any) => ({
          ruc:
            cc.company?.ruc ||
            cc.company?.numeroDoc ||
            null,
          name:
            cc.company?.name ||
            cc.company?.razonSocial ||
            null,
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
    logger.error({ err: error },'Error preparing export data:');
    throw error;
  }
}

/**
 * Importa contactos en lote desde un dataset ya parseado del Excel.
 *
 * En este import seguimos usando addCompanyToContact(),
 * que ya respeta la regla de NO pisar contact.ruc.
 */
export async function importContactsFromExcel(rows: Array<{
  phoneNumber: string;
  name?: string;
  dni?: string;
  companies?: Array<{
    ruc: string;
    name: string;
    role?: string;
    primary?: boolean;
  }>;
}>) {
  const results: any[] = [];

  for (const row of rows) {
    try {
      const phone = normalizePhone(row.phoneNumber);

      // getOrCreate contacto base
      let contact = await prisma.contact.findUnique({
        where: { phoneNumber: phone },
      });

      if (!contact) {
        contact = await prisma.contact.create({
          data: {
            phoneNumber: phone,
            name: row.name?.trim() || null,
            dni: row.dni && isValidDNI(row.dni) ? row.dni : null,
            state: 'REGISTERED', // o el estado que tú quieras para importados
          },
        });
      } else {
        // actualizar info básica sólo si no estaba
        const patchData: any = {};
        if (!contact.name && row.name) patchData.name = row.name.trim();
        if (!contact.dni && row.dni && isValidDNI(row.dni)) {
          patchData.dni = row.dni;
        }
        if (Object.keys(patchData).length > 0) {
          contact = await prisma.contact.update({
            where: { id: contact.id },
            data: patchData,
          });
        }
      }

      // manejar empresas declaradas en el Excel
      if (row.companies && row.companies.length > 0) {
        for (const comp of row.companies) {
          if (!comp.ruc || !comp.name) continue;
          if (!isValidRUC(comp.ruc)) continue;

          // asegurar empresa + relación
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
      logger.error({ err },'Error importing row:');
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

/**
 * Elimina un contacto por ID.
 * Borra ContactCompany, ConversationHistory asociado y luego el Contact.
 */
export async function deleteContact(contactId: string) {
  try {
    // borrar relaciones con empresas
    await prisma.contactCompany.deleteMany({
      where: { contactId },
    });

    // obtener contacto para su phoneNumber antes de borrarlo
    const existing = await prisma.contact.findUnique({
      where: { id: contactId },
    });

    if (existing) {
      await prisma.conversationHistory.deleteMany({
        where: { phoneNumber: existing.phoneNumber },
      });
    }

    // borrar contacto
    await prisma.contact.delete({
      where: { id: contactId },
    });

    return true;
  } catch (error) {
    logger.error({ err: error },'Error deleting contact:');
    throw error;
  }
}