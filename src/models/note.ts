import { getPrismaClient } from '../config/database.js';
import { logger } from '../utils/logger.js';

const prisma = getPrismaClient();

export async function recordDaily(data: {
  date: Date;
  totalMessages: number;
  uniqueContacts: number;
  newContacts: number;
  serviceRequests: number;
  salesInquiries: number;
  humanTakeovers: number;
  avgResponseTime?: number;
}) {
  try {
    return await prisma.conversationMetric.upsert({
      where: { date: data.date },
      update: data,
      create: data,
    });
  } catch (error) {
    logger.error({ err: error },'Error recording daily metric:');
    throw error;
  }
}

export async function getByDate(date: Date) {
  try {
    return await prisma.conversationMetric.findUnique({
      where: { date },
    });
  } catch (error) {
    logger.error({ err: error },'Error getting metric by date:');
    return null;
  }
}

export async function getByDateRange(startDate: Date, endDate: Date) {
  try {
    return await prisma.conversationMetric.findMany({
      where: {
        date: {
          gte: startDate,
          lte: endDate,
        },
      },
      orderBy: { date: 'asc' },
    });
  } catch (error) {
    logger.error({ err: error },'Error getting metrics by date range:');
    return [];
  }
}

export async function getLastDays(days: number) {
  try {
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    return await getByDateRange(startDate, endDate);
  } catch (error) {
    logger.error({ err: error },'Error getting last days metrics:');
    return [];
  }
}

// Calcular métricas del día actual
export async function calculateToday() {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    // Total de mensajes
    const totalMessages = await prisma.conversationHistory.count({
      where: {
        createdAt: {
          gte: today,
          lt: tomorrow,
        },
      },
    });

    // Contactos únicos
    const uniqueContactsData = await prisma.conversationHistory.groupBy({
      by: ['phoneNumber'],
      where: {
        createdAt: {
          gte: today,
          lt: tomorrow,
        },
      },
    });
    const uniqueContacts = uniqueContactsData.length;

    // Nuevos contactos
    const newContacts = await prisma.contact.count({
      where: {
        createdAt: {
          gte: today,
          lt: tomorrow,
        },
      },
    });

    // Human takeovers
    const humanTakeovers = await prisma.contact.count({
      where: {
        humanTakeoverAt: {
          gte: today,
          lt: tomorrow,
        },
      },
    });

    return {
      date: today,
      totalMessages,
      uniqueContacts,
      newContacts,
      serviceRequests: 0, // Se actualiza según detección
      salesInquiries: 0,  // Se actualiza según detección
      humanTakeovers,
    };
  } catch (error) {
    logger.error({ err: error },'Error calculating today metrics:');
    return null;
  }
}