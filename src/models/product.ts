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
    logger.error('Error getting products:', error);
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
    logger.error('Error getting active products:', error);
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
    logger.error('Error getting products by category:', error);
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
    logger.error('Error finding product:', error);
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
    logger.error('Error creating product:', error);
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
    logger.error('Error updating product:', error);
    throw error;
  }
}

export async function remove(id: string) {
  try {
    return await prisma.product.delete({
      where: { id },
    });
  } catch (error) {
    logger.error('Error deleting product:', error);
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
    logger.error('Error adding product keyword:', error);
    throw error;
  }
}

export async function removeKeyword(id: string) {
  try {
    return await prisma.productKeyword.delete({
      where: { id },
    });
  } catch (error) {
    logger.error('Error removing product keyword:', error);
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
    logger.error('Error searching products by keyword:', error);
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
    logger.error('Error getting categories:', error);
    return [];
  }
}