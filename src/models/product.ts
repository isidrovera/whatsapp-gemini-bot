import { getPrismaClient } from '../config/database.js';
import { logger } from '../utils/logger.js';

const prisma = getPrismaClient();

export async function getAll() {
  try {
    return await prisma.product.findMany({
      include: {
        keywords: true,
      },
      orderBy: [
        { category: 'asc' },
        { sortOrder: 'asc' },
      ],
    });
  } catch (error) {
    logger.error({ err: error },'Error getting products:');
    return [];
  }
}

export async function getActive() {
  try {
    return await prisma.product.findMany({
      where: { isActive: true },
      include: {
        keywords: true,
      },
      orderBy: [
        { category: 'asc' },
        { sortOrder: 'asc' },
      ],
    });
  } catch (error) {
    logger.error({ err: error },'Error getting active products:');
    return [];
  }
}

export async function getByCategory(category: string) {
  try {
    return await prisma.product.findMany({
      where: {
        category,
        isActive: true,
      },
      include: {
        keywords: true,
      },
      orderBy: { sortOrder: 'asc' },
    });
  } catch (error) {
    logger.error({ err: error },'Error getting products by category:');
    return [];
  }
}

export async function findById(id: string) {
  try {
    return await prisma.product.findUnique({
      where: { id },
      include: {
        keywords: true,
      },
    });
  } catch (error) {
    logger.error({ err: error },'Error finding product:');
    return null;
  }
}

export async function create(data: {
  name: string;
  category: string;
  description?: string;
  price?: number;
  imageUrl?: string;
  isActive?: boolean;
  sortOrder?: number;
}) {
  try {
    return await prisma.product.create({ data });
  } catch (error) {
    logger.error({ err: error },'Error creating product:');
    throw error;
  }
}

export async function update(id: string, data: {
  name?: string;
  category?: string;
  description?: string;
  price?: number;
  imageUrl?: string;
  isActive?: boolean;
  sortOrder?: number;
}) {
  try {
    return await prisma.product.update({
      where: { id },
      data,
    });
  } catch (error) {
    logger.error({ err: error },'Error updating product:');
    throw error;
  }
}

export async function remove(id: string) {
  try {
    return await prisma.product.delete({
      where: { id },
    });
  } catch (error) {
    logger.error({ err: error },'Error deleting product:');
    throw error;
  }
}

// Keywords
export async function addKeyword(productId: string, keyword: string) {
  try {
    return await prisma.productKeyword.create({
      data: {
        productId,
        keyword: keyword.toLowerCase().trim(),
      },
    });
  } catch (error) {
    logger.error({ err: error },'Error adding product keyword:');
    throw error;
  }
}

export async function removeKeyword(id: string) {
  try {
    return await prisma.productKeyword.delete({
      where: { id },
    });
  } catch (error) {
    logger.error({ err: error },'Error removing product keyword:');
    throw error;
  }
}

// Búsqueda de productos por keywords
export async function searchByKeyword(message: string) {
  try {
    const lowerMessage = message.toLowerCase();
    
    const products = await prisma.product.findMany({
      where: { isActive: true },
      include: {
        keywords: true,
      },
    });

    const matches: Array<{
      product: any;
      matchedKeywords: string[];
      relevance: number;
    }> = [];

    for (const product of products) {
      const matchedKeywords: string[] = [];
      
      for (const kw of product.keywords) {
        if (lowerMessage.includes(kw.keyword)) {
          matchedKeywords.push(kw.keyword);
        }
      }

      if (matchedKeywords.length > 0) {
        matches.push({
          product,
          matchedKeywords,
          relevance: matchedKeywords.length,
        });
      }
    }

    // Ordenar por relevancia (más keywords coincidentes primero)
    matches.sort((a, b) => b.relevance - a.relevance);

    return matches;
  } catch (error) {
    logger.error({ err: error },'Error searching products by keyword:');
    return [];
  }
}

export async function getCategories() {
  try {
    const products = await prisma.product.findMany({
      where: { isActive: true },
      select: { category: true },
      distinct: ['category'],
    });

    return products.map(p => p.category);
  } catch (error) {
    logger.error({ err: error },'Error getting categories:');
    return [];
  }
}

// ======================================================
// CONTEXTO DE PRODUCTOS / SERVICIOS PARA IA
// ======================================================

/**
 * Devuelve un resumen legible de los productos/servicios activos,
 * agrupados por categoría.
 *
 * Esto alimenta {{products_context}} en el prompt dinámico.
 */
export async function getProductsContextForAI(): Promise<string> {
  try {
    const products = await getActive(); // ya existe en tu archivo

    if (!products || products.length === 0) {
      return 'No hay productos o servicios publicados actualmente.';
    }

    // agrupar por categoría
    const byCategory: Record<string, { name: string; description?: string | null }[]> = {};

    for (const p of products) {
      if (!byCategory[p.category]) {
        byCategory[p.category] = [];
      }
      byCategory[p.category].push({
        name: p.name,
        description: p.description || '',
      });
    }

    // Formato legible para IA
    const blocks: string[] = [];

    for (const category of Object.keys(byCategory)) {
      blocks.push(`Categoría: ${category}`);
      for (const item of byCategory[category]) {
        const lineParts: string[] = [];
        lineParts.push(`- ${item.name}`);
        if (item.description) {
          lineParts.push(`${item.description}`);
        }
        blocks.push(lineParts.join(' | '));
      }
      blocks.push(''); // línea en blanco entre categorías
    }

    return blocks.join('\n').trim();
  } catch (error) {
    logger.error({ err: error },'Error building products context for AI:');
    return 'Catálogo no disponible.';
  }
}