import express from 'express';
import { getPrismaClient } from '../../config/database.js';
import { logger } from '../../utils/logger.js';
import { getConnectionStatus, hasQR, getBotPhoneNumber } from '../../services/whatsapp.js';
import * as workingHoursModel from '../../models/workingHours.js';
import * as adminModel from '../../models/admin.js'; // ✅ AGREGAR ESTA LÍNEA

const router = express.Router();
const prisma = getPrismaClient();

function startOfTodayLima(): Date {
  const now = new Date();
  const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima' }).format(now);
  return new Date(`${ymd}T00:00:00-05:00`);
}

// helpers
async function safeCount<T>(fn: () => Promise<T>): Promise<number> {
  try {
    const r: any = await fn();
    if (typeof r === 'number') return r;
    if (r && typeof r._count?._all === 'number') return r._count._all;
    if (typeof r?.count === 'number') return r.count;
    return 0;
  } catch (e: any) {
    logger.debug('safeCount fallback:', e.message);
    return 0;
  }
}

async function safeList<T>(fn: () => Promise<T[]>): Promise<T[]> {
  try {
    return await fn();
  } catch (e: any) {
    logger.debug('safeList fallback:', e.message);
    return [];
  }
}

// ============= VISTA SSR DASHBOARD =============
router.get('/', async (req, res) => { // ✅ CAMBIAR _req por req
  try {
    // ✅ AGREGAR: Obtener datos completos del admin logueado
    const adminId = req.session?.userId;
    let currentAdmin = null;
    
    if (adminId) {
      try {
        currentAdmin = await adminModel.findById(adminId);
      } catch (error) {
        logger.error('Error loading admin data:', error);
      }
    }

    const todayStart = startOfTodayLima();

    const [
      totalContacts,
      registeredContacts,
      blockedCount,
      totalMessages,
      messagesToday,
      humanTakeovers,
      recentContacts,

      // counts adicionales
      departmentsCount,
      productsCount,
      autoResponsesCount,
      tagsCount,
      templatesCount,

      // últimos productos
      recentProducts,

      // 👇 NUEVO: horarios de trabajo
      workingHours,
      workingNow,
    ] = await Promise.all([

      // contactos / mensajes / takeover
      prisma.contact.count(),
      prisma.contact.count({ where: { state: 'REGISTERED' } }),
      prisma.blockedNumber.count(),
      prisma.conversationHistory.count(),
      prisma.conversationHistory.count({ where: { createdAt: { gte: todayStart } } }),
      prisma.contact.count({ where: { humanTakeoverAt: { not: null } } }),

      // últimos contactos
      prisma.contact.findMany({
        take: 5,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          name: true,
          phoneNumber: true,
          state: true,
          createdAt: true,
          companyName: true,
        },
      }),

      // KPI departamentos
      safeCount(() => prisma.department.count() as any),

      // KPI productos
      safeCount(() => prisma.product.count() as any),

      // KPI auto-respuestas
      safeCount(() => prisma.autoResponse.count() as any),

      // KPI tags
      safeCount(() => prisma.tag.count() as any),

      // KPI plantillas
      safeCount(() => prisma.template.count() as any),

      // últimos productos
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

      // 👇 NUEVO: obtener horario de hoy
      (async () => {
        try {
          return await workingHoursModel.getTodayHours();
        } catch (e) {
          logger.debug('Error getting today hours:', e);
          return null;
        }
      })(),

      // 👇 NUEVO: verificar si está abierto ahora
      (async () => {
        try {
          return await workingHoursModel.isWorkingNow();
        } catch (e) {
          logger.debug('Error checking working now:', e);
          return false;
        }
      })(),
    ]);

    const whatsappStatus = {
      connected: getConnectionStatus(),
      hasQR: hasQR(),
      botNumber: typeof getBotPhoneNumber === 'function' ? getBotPhoneNumber() : null,
    };

    res.render('dashboard', {
      title: 'Dashboard',
      page: 'dashboard',
      stats: {
        totalContacts,
        registeredContacts,
        blockedCount,
        totalMessages,
        messagesToday,
        humanTakeovers,

        departmentsCount,
        productsCount,
        autoResponsesCount,
        tagsCount,
        templatesCount,
      },
      recentContacts,
      recentProducts,
      whatsappStatus,
      
      // 👇 NUEVO: pasar horarios a la vista
      workingHours,
      workingNow,
      
      // ✅ CAMBIAR: Pasar objeto completo del admin en lugar de solo el nombre
      user: currentAdmin, // Ahora pasa el objeto completo con id, name, email, avatar, role, etc.
      currentUser: currentAdmin, // También como currentUser por compatibilidad
    });
  } catch (error) {
    logger.error('Error loading dashboard:', error);
    res.status(500).send('Error loading dashboard');
  }
});


// ============= API KPIs (AJAX opcional) =============
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

      departmentsCount,
      productsCount,
      autoResponsesCount,
      tagsCount,
      templatesCount,

      // 👇 NUEVO: horarios
      workingHours,
      workingNow,
    ] = await Promise.all([
      prisma.contact.count(),
      prisma.contact.count({ where: { state: 'REGISTERED' } }),
      prisma.blockedNumber.count(),
      prisma.conversationHistory.count(),
      prisma.conversationHistory.count({ where: { createdAt: { gte: todayStart } } }),
      prisma.contact.count({ where: { humanTakeoverAt: { not: null } } }),

      safeCount(() => prisma.department.count() as any),
      safeCount(() => prisma.product.count() as any),
      safeCount(() => prisma.autoResponse.count() as any),
      safeCount(() => prisma.tag.count() as any),
      safeCount(() => prisma.template.count() as any),

      // 👇 NUEVO: horarios para API
      (async () => {
        try {
          return await workingHoursModel.getTodayHours();
        } catch (e) {
          return null;
        }
      })(),

      (async () => {
        try {
          return await workingHoursModel.isWorkingNow();
        } catch (e) {
          return false;
        }
      })(),
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

        departmentsCount,
        productsCount,
        autoResponsesCount,
        tagsCount,
        templatesCount,
      },
      whatsappStatus: {
        connected: getConnectionStatus(),
        hasQR: hasQR(),
        botNumber: typeof getBotPhoneNumber === 'function' ? getBotPhoneNumber() : null,
      },
      // 👇 NUEVO: incluir horarios en API
      workingHours: workingHours ? {
        dayOfWeek: workingHours.dayOfWeek,
        isWorkday: workingHours.isWorkday,
        openTime: workingHours.openTime,
        closeTime: workingHours.closeTime,
        breakStart: workingHours.breakStart,
        breakEnd: workingHours.breakEnd,
      } : null,
      workingNow,
    });
  } catch (error) {
    logger.error('Error getting KPIs:', error);
    res.status(500).json({ success: false, error: 'Error getting KPIs' });
  }
});

// ============= API: Obtener estado actual de horarios (para polling en tiempo real) =============
router.get('/api/working-status', async (_req, res) => {
  try {
    const [workingHours, workingNow] = await Promise.all([
      workingHoursModel.getTodayHours(),
      workingHoursModel.isWorkingNow(),
    ]);

    // Calcular progreso del día si está en horario laboral
    let dayProgress = 0;
    let nextChange = null;

    if (workingHours?.isWorkday && workingHours.openTime && workingHours.closeTime) {
      const now = new Date();
      const tz = 'America/Lima';
      const todayStr = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(now);
      
      const [openHour, openMin] = workingHours.openTime.split(':').map(Number);
      const [closeHour, closeMin] = workingHours.closeTime.split(':').map(Number);
      
      const open = new Date(`${todayStr}T${workingHours.openTime}:00-05:00`);
      const close = new Date(`${todayStr}T${workingHours.closeTime}:00-05:00`);
      
      const total = close.getTime() - open.getTime();
      const elapsed = Math.min(Math.max(now.getTime() - open.getTime(), 0), total);
      dayProgress = total > 0 ? Math.round((elapsed / total) * 100) : 0;

      // Determinar próximo cambio
      if (workingNow) {
        // Si está abierto, el próximo cambio es el cierre
        nextChange = {
          type: 'close',
          time: close.toISOString(),
          label: 'Cierre',
        };
      } else if (now < open) {
        // Si aún no abre, el próximo cambio es la apertura
        nextChange = {
          type: 'open',
          time: open.toISOString(),
          label: 'Apertura',
        };
      }
    }

    res.json({
      success: true,
      workingHours,
      workingNow,
      dayProgress,
      nextChange,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('Error getting working status:', error);
    res.status(500).json({ success: false, error: 'Error getting working status' });
  }
});

export default router;