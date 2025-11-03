import express from 'express';
import { getPrismaClient } from '../../config/database.js';
import { logger } from '../../utils/logger.js';

// si guardaste helpers de métricas en otro archivo (por ej. src/metrics/metric.ts)
// ajusta la ruta del import:
import {
  calculateToday,
  getLastDays,
} from '../../models/metric.js'; // <-- AJUSTA ESTE PATH si tu archivo vive en otro lado

const router = express.Router();
const prisma = getPrismaClient();

/**
 * Helpers internos
 */
function startOfDay(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}
function endOfDay(date: Date): Date {
  const d = new Date(date);
  d.setHours(23, 59, 59, 999);
  return d;
}

/**
 * GET /metrics
 * Render completo de la vista metrics.ejs
 */
router.get('/', async (req, res) => {
  try {
    // Lee filtros opcionales del querystring
    const { from, to, department } = req.query as {
      from?: string;
      to?: string;
      department?: string;
    };

    // Rango de fechas (por defecto: últimos 7 días)
    const today = new Date();
    const defaultFrom = new Date(today.getTime() - 6 * 24 * 3600 * 1000); // hoy-6
    const dateFrom = from ? new Date(from + 'T00:00:00') : startOfDay(defaultFrom);
    const dateTo = to ? new Date(to + 'T23:59:59') : endOfDay(today);

    // =============================
    // 1. KPIs base / stats
    // =============================

    // Métrica de "hoy" calculada on the fly
    const todayCalc = await calculateToday();
    // (ejemplo) tasa satisfacción: placeholder fijo hasta que tengas NPS/CSAT real
    const satisfactionPct = '92%'; // demo / placeholder

    const stats = {
      totalConversations: todayCalc.totalMessages ?? 0,
      resolved: Math.round((todayCalc.totalMessages ?? 0) * 0.7), // demo
      avgResponseTime:
        todayCalc.avgResponseTime != null
          ? `${Math.round(todayCalc.avgResponseTime)}m`
          : '0m',
      satisfaction: satisfactionPct,
    };

    // =============================
    // 2. Departamentos disponibles
    // =============================
    const departments = await prisma.department.findMany({
      orderBy: { sortOrder: 'asc' },
      select: { id: true, name: true },
    });

    // =============================
    // 3. Top productos consultados
    // =============================
    // Esto es mock razonable: si aún no trackeas consultas por producto,
    // devolvemos lista vacía o algo mínimo.
    // Ajusta cuando tengas tabla "productConsultation" o similar.
    const topProducts = await prisma.product.findMany({
      take: 5,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        category: true,
        // si no tienes 'consultations', usamos 0
      },
    });

    const topProductsEnriquecidos = topProducts.map(p => ({
      ...p,
      consultations: 0, // placeholder
    }));

    // =============================
    // 4. Top keywords
    // =============================
    // Si tienes una tabla departmentKeyword/productKeyword con contador,
    // la consultas aquí. Si no, placeholder vacío.
    const topKeywords: Array<{
      keyword: string;
      category: string | null;
      count: number;
    }> = [];

    // =============================
    // 5. Actividad reciente
    // =============================
    // Tomamos las últimas 20 entradas de conversationHistory
    // Si tu schema NO tiene relaciones directas contact/department en conversationHistory,
    // hacemos una query separada para obtener esos datos
    const recentRows = await prisma.conversationHistory.findMany({
      take: 20,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        createdAt: true,
        phoneNumber: true,
        role: true,
        content: true,
      },
    });

    // Obtener información de contactos asociados a estos números
    const phoneNumbers = [...new Set(recentRows.map(r => r.phoneNumber))];
    const contacts = await prisma.contact.findMany({
      where: { phoneNumber: { in: phoneNumbers } },
      select: {
        phoneNumber: true,
        name: true,
      },
    });

    // Crear mapa de phoneNumber -> contact
    const contactMap = new Map(contacts.map(c => [c.phoneNumber, c]));

    // Si tienes departmentId en conversationHistory, descomenta esto:
    // const conversationsWithDept = await prisma.conversationHistory.findMany({
    //   where: { id: { in: recentRows.map(r => r.id) } },
    //   select: {
    //     id: true,
    //     departmentId: true,
    //     department: {
    //       select: { name: true }
    //     }
    //   }
    // });
    // const deptMap = new Map(conversationsWithDept.map(c => [c.id, c.department?.name || null]));

    const recentActivity = recentRows.map(r => {
      const contact = contactMap.get(r.phoneNumber);
      return {
        timestamp: r.createdAt,
        contactName: contact?.name || 'Desconocido',
        phoneNumber: r.phoneNumber,
        department: 'Sin departamento', // Si tienes departmentId: deptMap.get(r.id) || 'Sin departamento'
        type: 'Mensaje',
        status: 'pending',
      };
    });

    // =============================
    // 6. Tiempos de respuesta por dept
    // =============================
    // Hasta que tengas la métrica real por dept, mandamos mock vacío:
    const responseTimesByDept: Array<{
      name: string;
      avgTime: string;
      total: number;
      efficiency: number;
    }> = [];

    // =============================
    // 7. Valores default para inputs fecha en la vista
    // =============================
    const isoFrom = dateFrom.toISOString().slice(0, 10); // yyyy-mm-dd
    const isoTo = dateTo.toISOString().slice(0, 10);

    // =============================
    // Render
    // =============================
    res.render('metrics', {
      title: 'Métricas',
      user: req.session?.username || 'Admin',

      dateFrom: isoFrom,
      dateTo: isoTo,
      departments,

      stats,
      topProducts: topProductsEnriquecidos,
      topKeywords,
      recentActivity,
      responseTimesByDept,
    });
  } catch (err: any) {
    logger.error({ err, message: err?.message, stack: err?.stack }, 'Error rendering /metrics');

    // fallback para no dejarte en 404
    res.status(500).render('metrics', {
      title: 'Métricas',
      user: req.session?.username || 'Admin',
      dateFrom: '',
      dateTo: '',
      departments: [],
      stats: {
        totalConversations: 0,
        resolved: 0,
        avgResponseTime: '0m',
        satisfaction: '0%',
      },
      topProducts: [],
      topKeywords: [],
      recentActivity: [],
      responseTimesByDept: [],
    });
  }
});

/**
 * ===========================
 *  RUTAS API JSON (charts)
 * ===========================
 */

// GET /metrics/api/messages-per-hour?date=YYYY-MM-DD
router.get('/api/messages-per-hour', async (req, res) => {
  try {
    const { date } = req.query as { date?: string };

    const today = new Date();
    const limaDate =
      date ||
      new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima' }).format(
        today
      ); // YYYY-MM-DD

    // IMPORTANTE:
    // Ajusta nombres de tabla y columnas a tu schema Postgres real.
    // conversation_history, created_at, etc.
    const result = await prisma.$queryRawUnsafe<
      { hour_label: string; cnt: string }[]
    >(
      `
      WITH hours AS (
        SELECT generate_series(0, 23) AS h
      ),
      msgs AS (
        SELECT
          date_trunc(
            'hour',
            (created_at AT TIME ZONE 'America/Lima')
          ) AS dt
        FROM conversation_history
        WHERE (created_at AT TIME ZONE 'America/Lima')::date = $1::date
      )
      SELECT
        TO_CHAR((make_time(h,0,0)),'HH24:MI') AS hour_label,
        COALESCE((
          SELECT COUNT(*)::int
          FROM msgs
          WHERE EXTRACT(HOUR FROM dt) = h
        ), 0)::text AS cnt
      FROM hours
      ORDER BY h;
      `,
      limaDate
    );

    const labels = result.map((r) => r.hour_label);
    const values = result.map((r) => parseInt(r.cnt, 10));
    res.json({ labels, values, date: limaDate });
  } catch (error) {
    logger.error({ err: error }, 'Error in /metrics/api/messages-per-hour:');
    res.status(500).json({ error: 'Error getting messages per hour' });
  }
});

// GET /metrics/api/department-distribution?date=YYYY-MM-DD
router.get('/api/department-distribution', async (req, res) => {
  try {
    const { date } = req.query as { date?: string };
    const today = new Date();
    const limaDate =
      date ||
      new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima' }).format(
        today
      ); // YYYY-MM-DD

    // Ajusta nombres reales de tu schema:
    // conversation_history.department_id, department.id, department.name, created_at
    const rows = await prisma.$queryRawUnsafe<
      { name: string; cnt: string }[]
    >(
      `
      SELECT d.name, COUNT(ch.id)::text AS cnt
      FROM conversation_history ch
      JOIN department d ON d.id = ch.department_id
      WHERE (ch.created_at AT TIME ZONE 'America/Lima')::date = $1::date
      GROUP BY d.name
      ORDER BY cnt::int DESC, d.name ASC;
      `,
      limaDate
    );

    const labels = rows.map((r) => r.name);
    const values = rows.map((r) => parseInt(r.cnt, 10));
    res.json({ labels, values, date: limaDate });
  } catch (error) {
    logger.error({ err: error }, 'Error in /metrics/api/department-distribution:');
    res
      .status(500)
      .json({ error: 'Error getting department distribution' });
  }
});

// GET /metrics/api/summary
router.get('/api/summary', async (_req, res) => {
  try {
    // ventana últimos 7 días
    const now = new Date();
    const sevenDaysAgoISO = new Date(
      now.getTime() - 7 * 24 * 3600 * 1000
    ).toISOString();

    const [messagesTotal, contactsRegistered] = await Promise.all([
      prisma.conversationHistory.count(),
      prisma.contact.count({ where: { state: 'REGISTERED' } }),
    ]);

    // métrica de respuesta en últimos 7 días (placeholder basado en tu SQL original)
    const resp = await prisma.$queryRawUnsafe<
      { incoming: string; with_reply: string; tmo_hours: string }[]
    >(
      `
      WITH win AS (
        SELECT *
        FROM conversation_history
        WHERE created_at >= $1::timestamptz
      ),
      incoming AS (
        SELECT phone_number, MIN(created_at) AS first_in
        FROM win
        WHERE role = 'USER'
        GROUP BY phone_number
      ),
      first_reply AS (
        SELECT w.phone_number, MIN(w.created_at) AS first_out
        FROM win w
        JOIN incoming i ON i.phone_number = w.phone_number
        WHERE w.role = 'ASSISTANT' AND w.created_at > i.first_in
        GROUP BY w.phone_number
      )
      SELECT
        (SELECT COUNT(*)::int FROM win WHERE role='USER')::text AS incoming,
        (SELECT COUNT(*)::int FROM first_reply)::text AS with_reply,
        COALESCE((
          SELECT AVG(EXTRACT(EPOCH FROM (fr.first_out - i.first_in)))/3600.0
          FROM first_reply fr
          JOIN incoming i ON i.phone_number = fr.phone_number
        ), 0)::text AS tmo_hours;
      `,
      sevenDaysAgoISO
    );

    const rec = resp[0] || { incoming: '0', with_reply: '0', tmo_hours: '0' };
    const incoming = parseInt(rec.incoming, 10) || 0;
    const withReply = parseInt(rec.with_reply, 10) || 0;
    const response_rate_pct = incoming > 0 ? (withReply / incoming) * 100 : 0;
    const avg_first_response_hours = Number(
      parseFloat(rec.tmo_hours).toFixed(2)
    );

    res.json({
      messages_total: messagesTotal,
      contacts_registered: contactsRegistered,
      response_rate_pct: Number(response_rate_pct.toFixed(2)),
      avg_first_response_hours,
    });
  } catch (error) {
    logger.error({ err: error }, 'Error in /metrics/api/summary:');
    res
      .status(500)
      .json({ error: 'Error getting metrics summary' });
  }
});

export default router;