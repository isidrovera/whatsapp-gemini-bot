import { getPrismaClient } from '../config/database.js';
import { logger } from '../utils/logger.js';

const prisma = getPrismaClient();

/**
 * Helper to log errors with stack consistently
 */
function logError(context: string, error: any) {
  try {
    if (error && error.stack) {
      logger.error(`${context}: ${error.message}`);
      logger.error(error.stack);
    } else {
      logger.error(`${context}: ${String(error)}`);
    }
  } catch (e) {
    console.error('Failed to log error for', context, error, e);
  }
}

/**
 * Initialize default departments
 */
export async function initDefaults() {
  try {
    const count = await prisma.department.count();

    if (count === 0) {
      logger.info('Initializing default departments...');

      const departments = [
        {
          name: 'Ventas',
          description: 'Consultas sobre productos, precios y cotizaciones',
          phoneNumber: '',
          isActive: true,
          sortOrder: 1,
        },
        {
          name: 'Soporte Técnico',
          description: 'Problemas técnicos, reparaciones y mantenimiento',
          phoneNumber: '',
          isActive: true,
          sortOrder: 2,
        },
        {
          name: 'Alquiler',
          description: 'Información sobre alquiler de equipos',
          phoneNumber: '',
          isActive: true,
          sortOrder: 3,
        },
        {
          name: 'Facturación',
          description: 'Consultas sobre facturas, pagos y comprobantes',
          phoneNumber: '',
          isActive: true,
          sortOrder: 4,
        },
      ];

      // Use createMany with skipDuplicates to avoid race conditions across multiple instances
      // createMany is more efficient and avoids P2002 when names already exist
      try {
        await prisma.department.createMany({ data: departments, skipDuplicates: true });
        logger.info('✅ Default departments initialized (createMany)');
      } catch (innerErr) {
        // As a fallback, try creating individually (idempotent) and log specifics
        logError('createMany failed, falling back to per-item create', innerErr);
        for (const dept of departments) {
          try {
            await prisma.department.create({ data: dept });
          } catch (e) {
            // if duplicate or other error, log but continue
            logError(`Error creating department ${dept.name}`, e);
          }
        }
        logger.info('✅ Default departments attempted via fallback creates');
      }
    }
  } catch (error) {
    logError('Error initializing departments', error);
  }
}

/**
 * Get all departments with their relations (optimized with batch queries)
 */
export async function getAll() {
  try {
    // Get all departments
    const departments = await prisma.department.findMany({
      orderBy: { sortOrder: 'asc' },
    });

    if (!Array.isArray(departments) || departments.length === 0) {
      return [];
    }

    const departmentIds = departments.map((d: any) => d.id);

    // 👇 CAMBIO: ya no filtramos isActive: true (para poder reactivar desde la UI)
    const [allKeywords, allContacts] = await Promise.all([
      prisma.departmentKeyword.findMany({
        where: { departmentId: { in: departmentIds } },
        orderBy: { priority: 'desc' },
      }),
      prisma.departmentContact.findMany({
        where: { departmentId: { in: departmentIds } },   // <- sin filtro isActive
        orderBy: { sortOrder: 'asc' },
      }),
    ]);

    const keywordsByDept: Record<string, any[]> = {};
    const contactsByDept: Record<string, any[]> = {};

    allKeywords.forEach((kw: any) => {
      if (!keywordsByDept[kw.departmentId]) keywordsByDept[kw.departmentId] = [];
      keywordsByDept[kw.departmentId].push(kw);
    });

    allContacts.forEach((contact: any) => {
      if (!contactsByDept[contact.departmentId]) contactsByDept[contact.departmentId] = [];
      contactsByDept[contact.departmentId].push(contact);
    });

    return departments.map((dept: any) => ({
      ...dept,
      keywords: keywordsByDept[dept.id] || [],
      contacts: contactsByDept[dept.id] || [],
    }));
  } catch (error) {
    logError('Error getting departments', error);
    return [];
  }
}

/**
 * Get only active departments with their relations
 */
export async function getActive() {
  try {
    // Get active departments
    const departments = await prisma.department.findMany({
      where: { isActive: true },
      orderBy: { sortOrder: 'asc' },
    });

    if (!Array.isArray(departments) || departments.length === 0) {
      return [];
    }

    const departmentIds = departments.map((d: any) => d.id);

    const [allKeywords, allContacts] = await Promise.all([
      prisma.departmentKeyword.findMany({
        where: { departmentId: { in: departmentIds } },
        orderBy: { priority: 'desc' },
      }),
      prisma.departmentContact.findMany({
        where: {
          departmentId: { in: departmentIds },
          isActive: true,
        },
        orderBy: { sortOrder: 'asc' },
      }),
    ]);

    const keywordsByDept: Record<string, any[]> = {};
    const contactsByDept: Record<string, any[]> = {};

    allKeywords.forEach((kw: any) => {
      if (!keywordsByDept[kw.departmentId]) keywordsByDept[kw.departmentId] = [];
      keywordsByDept[kw.departmentId].push(kw);
    });

    allContacts.forEach((contact: any) => {
      if (!contactsByDept[contact.departmentId]) contactsByDept[contact.departmentId] = [];
      contactsByDept[contact.departmentId].push(contact);
    });

    return departments.map((dept: any) => ({
      ...dept,
      keywords: keywordsByDept[dept.id] || [],
      contacts: contactsByDept[dept.id] || [],
    }));
  } catch (error) {
    logError('Error getting active departments', error);
    return [];
  }
}

/**
 * Find department by ID
 */
export async function findById(id: string) {
  try {
    const department = await prisma.department.findUnique({ where: { id } });

    if (!department) return null;

    // Fetch relations
    const [keywords, contacts] = await Promise.all([
      prisma.departmentKeyword.findMany({
        where: { departmentId: id },
        orderBy: { priority: 'desc' },
      }),
      prisma.departmentContact.findMany({
        where: { departmentId: id },
        orderBy: { sortOrder: 'asc' },
      }),
    ]);

    return {
      ...department,
      keywords,
      contacts,
    };
  } catch (error) {
    logError('Error finding department', error);
    return null;
  }
}

/**
 * Create a new department
 */
export async function create(data: any) {
  try {
    return await prisma.department.create({ data });
  } catch (error) {
    logError('Error creating department', error);
    throw error;
  }
}

/**
 * Update a department
 */
export async function update(id: string, data: any) {
  try {
    return await prisma.department.update({ where: { id }, data });
  } catch (error) {
    logError('Error updating department', error);
    throw error;
  }
}

/**
 * Delete a department
 */
export async function remove(id: string) {
  try {
    return await prisma.department.delete({ where: { id } });
  } catch (error) {
    logError('Error deleting department', error);
    throw error;
  }
}

/**
 * Toggle department active status
 */
export async function toggleActive(id: string) {
  try {
    const dept = await prisma.department.findUnique({ where: { id }, select: { isActive: true } });

    if (!dept) throw new Error('Department not found');

    return await prisma.department.update({ where: { id }, data: { isActive: !dept.isActive } });
  } catch (error) {
    logError('Error toggling department active status', error);
    throw error;
  }
}

/**
 * Bulk update sort order
 */
export async function bulkUpdateSortOrder(updates: { id: string; sortOrder: number }[]) {
  try {
    const promises = updates.map(({ id, sortOrder }) =>
      prisma.department.update({ where: { id }, data: { sortOrder } })
    );
    return await Promise.all(promises);
  } catch (error) {
    logError('Error bulk updating sort order', error);
    throw error;
  }
}

// ============================================================================
// KEYWORDS
// ============================================================================

/**
 * Add keyword to department
 */
export async function addKeyword(departmentId: string, keyword: string, priority = 1) {
  try {
    return await prisma.departmentKeyword.create({
      data: {
        departmentId,
        keyword: keyword.toLowerCase().trim(),
        priority,
      },
    });
  } catch (error) {
    logError('Error adding keyword', error);
    throw error;
  }
}

/**
 * Update keyword
 */
export async function updateKeyword(id: string, data: any) {
  try {
    const updateData: any = {};
    if (data.keyword !== undefined) updateData.keyword = data.keyword.toLowerCase().trim();
    if (data.priority !== undefined) updateData.priority = data.priority;

    return await prisma.departmentKeyword.update({ where: { id }, data: updateData });
  } catch (error) {
    logError('Error updating keyword', error);
    throw error;
  }
}

/**
 * Remove keyword
 */
export async function removeKeyword(id: string) {
  try {
    return await prisma.departmentKeyword.delete({ where: { id } });
  } catch (error) {
    logError('Error removing keyword', error);
    throw error;
  }
}

/**
 * Get all keywords with department info
 */
export async function getAllKeywords() {
  try {
    const [keywords, departments] = await Promise.all([
      prisma.departmentKeyword.findMany({
        orderBy: [
          { priority: 'desc' },
          { keyword: 'asc' },
        ],
      }),
      prisma.department.findMany({ select: { id: true, name: true } }),
    ]);

    const deptMap = new Map(departments.map((d: any) => [d.id, d]));

    return keywords.map((keyword: any) => ({
      ...keyword,
      department: deptMap.get(keyword.departmentId) || null,
    }));
  } catch (error) {
    logError('Error getting all keywords', error);
    return [];
  }
}

// ============================================================================
// CONTACTS
// ============================================================================

/**
 * Add contact to department
 */
export async function addContact(data: any) {
  try {
    return await prisma.departmentContact.create({ data });
  } catch (error) {
    logError('Error adding contact', error);
    throw error;
  }
}

/**
 * Update contact
 */
export async function updateContact(id: string, data: any) {
  try {
    return await prisma.departmentContact.update({ where: { id }, data });
  } catch (error) {
    logError('Error updating contact', error);
    throw error;
  }
}

/**
 * Remove contact
 */
export async function removeContact(id: string) {
  try {
    return await prisma.departmentContact.delete({ where: { id } });
  } catch (error) {
    logError('Error removing contact', error);
    throw error;
  }
}

/**
 * Get all contacts with department info
 */
export async function getAllContacts() {
  try {
    const [contacts, departments] = await Promise.all([
      prisma.departmentContact.findMany({ orderBy: { sortOrder: 'asc' } }),
      prisma.department.findMany({ select: { id: true, name: true, sortOrder: true } }),
    ]);

    const deptMap = new Map(departments.map((d: any) => [d.id, d]));

    const contactsWithDept = contacts.map((contact: any) => ({
      ...contact,
      department: deptMap.get(contact.departmentId) || null,
    }));

    // Sort by department sortOrder, then by contact sortOrder
    return contactsWithDept.sort((a: any, b: any) => {
      const deptOrderA = a.department?.sortOrder || 999;
      const deptOrderB = b.department?.sortOrder || 999;

      if (deptOrderA !== deptOrderB) return deptOrderA - deptOrderB;
      return a.sortOrder - b.sortOrder;
    });
  } catch (error) {
    logError('Error getting all contacts', error);
    return [];
  }
}

// ============================================================================
// STATISTICS
// ============================================================================

/**
 * Count total contacts
 */
export async function countContactsTotal() {
  try {
    return await prisma.departmentContact.count();
  } catch (error) {
    logError('Error counting contacts', error);
    return 0;
  }
}

/**
 * Count total keywords
 */
export async function countKeywordsTotal() {
  try {
    return await prisma.departmentKeyword.count();
  } catch (error) {
    logError('Error counting keywords', error);
    return 0;
  }
}

/**
 * Get contacts grouped by department
 */
export async function getContactsByDepartment() {
  try {
    // Use groupBy for efficient counting
    const result = await prisma.departmentContact.groupBy({
      by: ['departmentId'],
      _count: { id: true },
    });

    // Get department names
    const departmentIds = result.map((r: any) => r.departmentId);
    const departments = await prisma.department.findMany({
      where: { id: { in: departmentIds } },
      select: { id: true, name: true },
      orderBy: { sortOrder: 'asc' },
    });

    const deptMap = new Map(departments.map((d: any) => [d.id, d.name]));

    return result.map((r: any) => ({ name: deptMap.get(r.departmentId) || 'Unknown', contacts: r._count.id }));
  } catch (error) {
    logError('Error getting contacts by department', error);
    return [];
  }
}

/**
 * Count departments that have at least one keyword
 */
export async function countDepartmentsWithKeywords() {
  try {
    const result = await prisma.departmentKeyword.groupBy({ by: ['departmentId'] });

    return result.length;
  } catch (error) {
    logError('Error counting departments with keywords', error);
    return 0;
  }
}

// ============================================================================
// DEPARTMENT DETECTION
// ============================================================================

/**
 * Detect department from message text
 */
export async function detectDepartment(message: string) {
  try {
    const lowerMessage = (message || '').toLowerCase();

    // Get active departments
    const departments = await prisma.department.findMany({ where: { isActive: true } });

    if (!Array.isArray(departments) || departments.length === 0) return null;

    const departmentIds = departments.map((d: any) => d.id);

    // Batch fetch keywords and contacts
    const [allKeywords, allContacts] = await Promise.all([
      prisma.departmentKeyword.findMany({ where: { departmentId: { in: departmentIds } }, orderBy: { priority: 'desc' } }),
      prisma.departmentContact.findMany({ where: { departmentId: { in: departmentIds }, isActive: true } }),
    ]);

    const keywordsByDept: Record<string, any[]> = {};
    const contactsByDept: Record<string, any[]> = {};

    allKeywords.forEach((kw: any) => {
      if (!keywordsByDept[kw.departmentId]) keywordsByDept[kw.departmentId] = [];
      keywordsByDept[kw.departmentId].push(kw);
    });

    allContacts.forEach((contact: any) => {
      if (!contactsByDept[contact.departmentId]) contactsByDept[contact.departmentId] = [];
      contactsByDept[contact.departmentId].push(contact);
    });

    const departmentsWithData = departments.map((dept: any) => ({
      ...dept,
      keywords: keywordsByDept[dept.id] || [],
      contacts: contactsByDept[dept.id] || [],
    }));

    // Find best match
    let bestMatch: any = null;

    for (const dept of departmentsWithData) {
      for (const kw of dept.keywords) {
        if (kw.keyword && lowerMessage.includes(kw.keyword)) {
          if (!bestMatch || kw.priority > bestMatch.priority) {
            bestMatch = { department: dept, matchedKeyword: kw.keyword, priority: kw.priority };
          }
        }
      }
    }

    return bestMatch;
  } catch (error) {
    logError('Error detecting department', error);
    return null;
  }
}

// ============================================================================
// DEPARTMENT CONTEXT FOR AI
// ============================================================================

/**
 * Genera el bloque de texto que se inyecta en el prompt del asistente:
 * "DEPARTAMENTOS Y CONTACTOS DISPONIBLES:"
 * Usa departamentos activos, su descripción y contactos principales.
 *
 * Esto reemplaza el hardcode {{departments_context}} que antes vivía en gemini.ts
 * y permite que cambiar teléfonos / áreas ya no requiera tocar código.
 */
export async function getDepartmentsContextForAI(): Promise<string> {
  try {
    const activeDepts = await getActive(); // ya existe arriba

    if (!activeDepts || activeDepts.length === 0) {
      return 'No hay departamentos configurados actualmente.';
    }

    // armamos líneas legibles
    const lines: string[] = [];

    for (const dept of activeDepts) {
      const baseLineParts: string[] = [];
      baseLineParts.push(`• ${dept.name}: ${dept.description || ''}`.trim());

      // teléfono general del dept
      if (dept.phoneNumber) {
        baseLineParts.push(`Teléfono: ${dept.phoneNumber}`);
      }

      // mejor contacto interno activo (el primero por sortOrder)
      if (dept.contacts && dept.contacts.length > 0) {
        const primary = dept.contacts[0];
        const contactBits: string[] = [];
        if (primary.nombre) contactBits.push(primary.nombre);
        if (primary.cargo) contactBits.push(primary.cargo);
        if (primary.celular) contactBits.push(`Celular ${primary.celular}`);
        if (primary.whatsapp) contactBits.push(`WhatsApp ${primary.whatsapp}`);

        if (contactBits.length > 0) {
          baseLineParts.push(`Contacto: ${contactBits.join(' / ')}`);
        }
      }

      lines.push(baseLineParts.join(' | '));
    }

    return lines.join('\n');
  } catch (error) {
    logError('Error building departments context for AI', error);
    return 'Información de departamentos no disponible.';
  }
}