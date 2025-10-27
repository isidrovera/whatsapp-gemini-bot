// src/models/contact.ts
import { getPrismaClient } from '../config/database.js';
import { logger } from '../utils/logger.js';
import { normalizePhone } from '../utils/validators.js';

const prisma = getPrismaClient();

/* -------------------------------------------------
 * HELPERS INTERNOS
 * ------------------------------------------------- */

/**
 * Busca la empresa (Company) por RUC. Si no existe, la crea.
 */
async function getOrCreateCompany(ruc: string, name: string) {
  const cleanedRuc = ruc?.trim();
  const cleanedName = name?.trim();

  if (!cleanedRuc || !cleanedName) {
    throw new Error('RUC y razón social requeridos para la empresa');
  }

  // Primero intentamos encontrar por RUC
  const existing = await prisma.company.findUnique({
    where: { ruc: cleanedRuc },
  });

  if (existing) return existing;

  // Crear si no existe
  return prisma.company.create({
    data: {
      ruc: cleanedRuc,
      name: cleanedName,
    },
  });
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
 * Retorna { companyName, ruc } para la empresa primaria del contacto.
 * Si no hay primaria, intenta la primera. Si no hay ninguna, cae a los campos legacy.
 *
 * ⚠ Esta función la usa whatsapp.ts (buildMainMenu, generateOdooLinkForContact)
 * así que debe ser exportada.
 */
export function resolvePrimaryCompany(contact: any) {
  // contact.companies: ContactCompany[] con { isPrimary, role, company: { name, ruc } }

  if (contact?.companies && contact.companies.length > 0) {
    // buscar la primary explícita
    const primary = contact.companies.find((cc: any) => cc.isPrimary);
    const chosen = primary || contact.companies[0];
    if (chosen && chosen.company) {
      return {
        companyName: chosen.company.name,
        ruc: chosen.company.ruc,
      };
    }
  }

  // fallback legacy
  return {
    companyName: contact?.companyName ?? null,
    ruc: contact?.ruc ?? null,
  };
}

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
    logger.error('Error finding contact by phone:', error);
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
    logger.error('Error finding contact by billysId:', error);
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
    logger.error('Error getting all contacts:', error);
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
    logger.error('Error checking registration:', error);
    return false;
  }
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
    logger.error('Error creating contact:', error);
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
    logger.error('Error linking billysId:', error);
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
    logger.error('Error updating DNI:', error);
    throw error;
  }
}

/**
 * Actualiza RUC y razón social; pasa a REGISTERED
 * Ahora también crea/relaciona Company y la marca como primaria.
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

    // 2. asegurar company
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
        ruc,
        companyName,
        state: 'REGISTERED',
      },
    });
  } catch (error) {
    logger.error('Error updating RUC:', error);
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
    logger.error('Error updating state:', error);
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
    logger.error('Error updating contact info:', error);
    throw error;
  }
}

/* -------------------------------------------------
 * MULTIEMPRESA
 * ------------------------------------------------- */

/**
 * Agrega o asegura una empresa en el contacto.
 * Si isPrimary = true, la deja como principal.
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

      // también reflejarla en legacy contact.companyName/ruc
      await prisma.contact.update({
        where: { id: contactId },
        data: {
          companyName: company.name,
          ruc: company.ruc,
        },
      });
    }

    return pivot;
  } catch (error) {
    logger.error('Error adding company to contact:', error);
    throw error;
  }
}

/**
 * Cambia la empresa principal del contacto
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

    // 3. reflejar en contacto legacy
    await prisma.contact.update({
      where: { id: contactId },
      data: {
        companyName: pivot.company.name,
        ruc: pivot.company.ruc,
      },
    });

    return true;
  } catch (error) {
    logger.error('Error setting primary company:', error);
    throw error;
  }
}

/**
 * Quita una empresa del contacto
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

    // borrar
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

        // reflejar en contacto legacy
        await prisma.contact.update({
          where: { id: contactId },
          data: {
            companyName: remaining.company.name,
            ruc: remaining.company.ruc,
          },
        });
      } else {
        // si ya no tiene empresas, limpiamos legacy
        await prisma.contact.update({
          where: { id: contactId },
          data: {
            companyName: null,
            ruc: null,
          },
        });
      }
    }

    return true;
  } catch (error) {
    logger.error('Error removing company from contact:', error);
    throw error;
  }
}

/* -------------------------------------------------
 * TAKEOVER HUMANO / BLOQUEO / BOT
 * ------------------------------------------------- */

export async function setHumanTakeover(phoneNumber: string) {
  try {
    const phone = normalizePhone(phoneNumber);
    logger.info(`[CONTACT] Setting human takeover for ${phone}`);
    return await prisma.contact.update({
      where: { phoneNumber: phone },
      data: {
        humanTakeoverAt: new Date(),
      },
    });
  } catch (error) {
    logger.error('Error setting human takeover:', error);
    throw error;
  }
}

export async function releaseHumanTakeover(phoneNumber: string) {
  try {
    const phone = normalizePhone(phoneNumber);
    logger.info(`[CONTACT] Releasing human takeover for ${phone}`);
    return await prisma.contact.update({
      where: { phoneNumber: phone },
      data: {
        humanTakeoverAt: null,
      },
    });
  } catch (error) {
    logger.error('Error releasing human takeover:', error);
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
    logger.error('Error checking if bot should respond:', error);
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
    logger.error('Error blocking contact:', error);
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

    // no eliminamos forzosamente el registro de BlockedNumber (auditoría),
    // pero podrías hacerlo si quieres
    return updated;
  } catch (error) {
    logger.error('Error unblocking contact:', error);
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
        fallback?.company?.name ?? c.companyName ?? null;
      const primaryCompanyRuc =
        fallback?.company?.ruc ?? c.ruc ?? null;

      const extraCompanies = c.companies
        .filter((cc: any) => !primary || cc.companyId !== primary.companyId)
        .map((cc: any) => ({
          ruc: cc.company?.ruc || null,
          name: cc.company?.name || null,
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
    logger.error('Error preparing export data:', error);
    throw error;
  }
}

/**
 * Importa contactos en lote desde un dataset ya parseado del Excel.
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
            state: 'REGISTERED', // puedes ajustarlo si quieres otro estado para importados
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

      // manejar empresas
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
      logger.error('Error importing row:', err);
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
 * Borra Contact, ContactCompany, y ConversationHistory asociado.
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
    logger.error('Error deleting contact:', error);
    throw error;
  }
}
