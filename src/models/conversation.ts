import { getPrismaClient } from '../config/database.js';
import { logger } from '../utils/logger.js';

const prisma = getPrismaClient();

export async function save(phoneNumber: string, role: 'USER' | 'ASSISTANT' | 'SYSTEM', content: string) {
  try {
    return await prisma.conversationHistory.create({
      data: {
        phoneNumber,
        role,
        content,
      },
    });
  } catch (error) {
    logger.error({ err: error },'Error saving conversation:');
    throw error;
  }
}

export async function getHistory(phoneNumber: string, limit: number = 10) {
  try {
    const history = await prisma.conversationHistory.findMany({
      where: { phoneNumber },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    return history.reverse();
  } catch (error) {
    logger.error({ err: error },'Error getting conversation history:');
    return [];
  }
}

export async function deleteOld(days: number = 30) {
  try {
    const date = new Date();
    date.setDate(date.getDate() - days);
    
    const result = await prisma.conversationHistory.deleteMany({
      where: {
        createdAt: {
          lt: date,
        },
      },
    });
    
    logger.info(`Deleted ${result.count} old conversation records`);
    return result.count;
  } catch (error) {
    logger.error({ err: error },'Error deleting old conversations:');
    return 0;
  }
}

export async function getStatistics(phoneNumber: string) {
  try {
    const total = await prisma.conversationHistory.count({
      where: { phoneNumber },
    });
    
    const userMessages = await prisma.conversationHistory.count({
      where: { phoneNumber, role: 'USER' },
    });
    
    const assistantMessages = await prisma.conversationHistory.count({
      where: { phoneNumber, role: 'ASSISTANT' },
    });
    
    return {
      total,
      userMessages,
      assistantMessages,
    };
  } catch (error) {
    logger.error({ err: error },'Error getting conversation statistics:');
    return { total: 0, userMessages: 0, assistantMessages: 0 };
  }
}