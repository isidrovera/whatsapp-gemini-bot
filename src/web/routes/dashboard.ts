// src/web/routes/dashboard.ts
import express from 'express';
import { getPrismaClient } from '../../config/database.js';
import { logger } from '../../utils/logger.js';
import { getConnectionStatus, hasQR, getBotPhoneNumber } from '../../services/whatsapp.js';

const router = express.Router();
const prisma = getPrismaClient();

function startOfTodayLima(): Date {
  const now = new Date();
  const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima' }).format(now);
  return new Date(`${ymd}T00:00:00-05:00`);
}

// helpers de “consulta segura”
async function safeCount<T>(fn: () => Promise<T>): Promise<number> {
  try {
    const r: any = await fn();
    // si es { _count: { _all: n } } o un número
    if (typeof r === 'number') return r;
    if (r && typeof r._count?._all === 'number') return r._count._all;
    if (typeof r?.count === 'number') return r.count;
    return 0;
  } catch (e) {
    logger.debug('safeCount fallback:', (e as Error).message);
    return 0;
  }
}

async function safeList<T>(fn: () => Promise<T[]>): Promise<T[]> {
  try {
    return await fn();
  } catch (e) {
    logger.debug('safeList fallback:', (e as Error).message);
    return [];
  }
}

// Vista SSR del dashboard
router.get('/', async (_req, res) => {
  try {
    const todayStart = startOfTodayLima();

    const [
      totalContacts,
      registeredContacts,
      blockedCount,
      totalMessages,
      messagesToday,
      humanTakeovers,
      recentContacts,
      // extras (nuevas secciones)
      productsCount,
      autoResponsesCount,
      tagsCount,
      recentProducts,
    ] = await Promise.all([
      prisma.contact.count(),
      prisma.contact.count({ where: { state: 'REGISTERED' } }),
      prisma.blockedNumber.count(),
      prisma.conversationHistory.count(),
      prisma.conversationHistory.count({ where: { createdAt: { gte: todayStart } } }),
      prisma.contact.count({ where: { humanTakeoverAt: { not: null } } }),
      prisma.contact.findMany({
        take: 5,
        orderBy: { createdAt: 'desc' },
        select: { id: true, name: true, phoneNumber: true, state: true, createdAt: true, companyName: true },
      }),

      // counts “seguros” por si aún no migraste algo
      safeCount(() => prisma.product.count() as any),
      safeCount(() => prisma.autoResponse.count() as any),
      safeCount(() => prisma.tag.count() as any),

      // últimos productos SIN sku (no existe en tu schema)
      safeList(() =>
        prisma.product.findMany({
          take: 5,
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            name: true,
            category: true,
            description: true,
            price: true,
            imageUrl: true,
            isActive: true,
            createdAt: true,
          },
        })
      ),
    ]);

    const whatsappStatus = {
      connected: getConnectionStatus(),
      hasQR: hasQR(),
      botNumber: typeof getBotPhoneNumber === 'function' ? getBotPhoneNumber() : null,
    };

    res.render('dashboard', {
      title: 'Dashboard',
      stats: {
        totalContacts,
        registeredContacts,
        blockedCount,
        totalMessages,
        messagesToday,
        humanTakeovers,
        // extras de tarjetas si las usas
        productsCount,
        autoResponsesCount,
        tagsCount,
      },
      recentContacts,
      recentProducts,
      whatsappStatus,
    });
  } catch (error) {
    logger.error('Error loading dashboard:', error);
    res.status(500).send('Error loading dashboard');
  }
});

// API KPIs (opcional, mismo ajuste sin sku)
router.get('/api/kpis/today', async (_req, res) => {
  try {
    const todayStart = startOfTodayLima();

    const [
      totalContacts,
      registeredContacts,
      blockedCount,
      totalMessages,
      messagesToday,
      humanTakeovers,
      productsCount,
      autoResponsesCount,
      tagsCount,
    ] = await Promise.all([
      prisma.contact.count(),
      prisma.contact.count({ where: { state: 'REGISTERED' } }),
      prisma.blockedNumber.count(),
      prisma.conversationHistory.count(),
      prisma.conversationHistory.count({ where: { createdAt: { gte: todayStart } } }),
      prisma.contact.count({ where: { humanTakeoverAt: { not: null } } }),
      safeCount(() => prisma.product.count() as any),
      safeCount(() => prisma.autoResponse.count() as any),
      safeCount(() => prisma.tag.count() as any),
    ]);

    res.json({
      success: true,
      stats: {
        totalContacts,
        registeredContacts,
        blockedCount,
        totalMessages,
        messagesToday,
        humanTakeovers,
        productsCount,
        autoResponsesCount,
        tagsCount,
      },
      whatsappStatus: {
        connected: getConnectionStatus(),
        hasQR: hasQR(),
        botNumber: typeof getBotPhoneNumber === 'function' ? getBotPhoneNumber() : null,
      },
    });
  } catch (error) {
    logger.error('Error getting KPIs:', error);
    res.status(500).json({ success: false, error: 'Error getting KPIs' });
  }
});

export default router;
