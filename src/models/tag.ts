import { getPrismaClient } from '../config/database.js';
import { logger } from '../utils/logger.js';

const prisma = getPrismaClient();

export async function getAll() {
  try {
    return await prisma.tag.findMany({
      orderBy: { name: 'asc' },
    });
  } catch (error) {
    logger.error({ err: error },'Error getting tags:');
    return [];
  }
}

export async function findById(id: string) {
  try {
    return await prisma.tag.findUnique({
      where: { id },
    });
  } catch (error) {
    logger.error({ err: error },'Error finding tag:');
    return null;
  }
}

export async function create(data: {
  name: string;
  color?: string;
  description?: string;
}) {
  try {
    return await prisma.tag.create({ data });
  } catch (error) {
    logger.error({ err: error },'Error creating tag:');
    throw error;
  }
}

export async function update(id: string, data: {
  name?: string;
  color?: string;
  description?: string;
}) {
  try {
    return await prisma.tag.update({
      where: { id },
      data,
    });
  } catch (error) {
    logger.error({ err: error },'Error updating tag:');
    throw error;
  }
}

export async function remove(id: string) {
  try {
    return await prisma.tag.delete({
      where: { id },
    });
  } catch (error) {
    logger.error({ err: error },'Error deleting tag:');
    throw error;
  }
}

// Asignar tag a conversación
export async function assignToConversation(phoneNumber: string, tagId: string) {
  try {
    return await prisma.conversationTag.create({
      data: {
        phoneNumber,
        tagId,
      },
    });
  } catch (error) {
    logger.error({ err: error },'Error assigning tag:');
    throw error;
  }
}

// Remover tag de conversación
export async function removeFromConversation(phoneNumber: string, tagId: string) {
  try {
    const record = await prisma.conversationTag.findFirst({
      where: {
        phoneNumber,
        tagId,
      },
    });

    if (record) {
      return await prisma.conversationTag.delete({
        where: { id: record.id },
      });
    }

    return null;
  } catch (error) {
    logger.error({ err: error },'Error removing tag:');
    throw error;
  }
}

// Obtener tags de una conversación
export async function getByConversation(phoneNumber: string) {
  try {
    const conversationTags = await prisma.conversationTag.findMany({
      where: { phoneNumber },
      include: {
        tag: true,
      },
    });

    return conversationTags.map(ct => ct.tag);
  } catch (error) {
    logger.error({ err: error },'Error getting tags for conversation:');
    return [];
  }
}

// Obtener conversaciones por tag
export async function getConversationsByTag(tagId: string) {
  try {
    const conversationTags = await prisma.conversationTag.findMany({
      where: { tagId },
    });

    return conversationTags.map(ct => ct.phoneNumber);
  } catch (error) {
    logger.error({ err: error },'Error getting conversations by tag:');
    return [];
  }
}