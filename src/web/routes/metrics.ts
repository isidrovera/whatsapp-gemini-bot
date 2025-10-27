import express from 'express';
import { getPrismaClient } from '../../config/database.js';
import { logger } from '../../utils/logger.js';

const router = express.Router();
const prisma = getPrismaClient();

// GET /api/metrics/messages-per-hour?date=YYYY-MM-DD
router.get('/api/metrics/messages-per-hour', async (req, res) => {
  try {
    const { date } = req.query as { date?: string };
    // Si no mandan fecha, usa hoy en Lima
    const today = new Date();
    const limaDate = date || new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima' })
      .format(today); // YYYY-MM-DD

    // Usamos SQL raw para agrupar por hora en TZ Lima
    // Tabla: conversationHistory (ajústala si tu nombre real difiere)
    const result = await prisma.$queryRawUnsafe<{
      hour_label: string; cnt: string;
    }[]>(
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

    const labels = result.map(r => r.hour_label);
    const values = result.map(r => parseInt(r.cnt, 10));
    res.json({ labels, values, date: limaDate });
  } catch (error) {
    logger.error('Error in messages-per-hour:', error);
    res.status(500).json({ error: 'Error getting messages per hour' });
  }
});

// GET /api/metrics/department-distribution?date=YYYY-MM-DD
router.get('/api/metrics/department-distribution', async (req, res) => {
  try {
    const { date } = req.query as { date?: string };
    const today = new Date();
    const limaDate = date || new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima' })
      .format(today); // YYYY-MM-DD

    // Ajusta los nombres de columnas/relaciones según tu esquema real
    // Supuesto: conversation_history tiene department_id (o se une a conversation/department)
    const rows = await prisma.$queryRawUnsafe<{ name: string; cnt: string }[]>(
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

    const labels = rows.map(r => r.name);
    const values = rows.map(r => parseInt(r.cnt, 10));
    res.json({ labels, values, date: limaDate });
  } catch (error) {
    logger.error('Error in department-distribution:', error);
    res.status(500).json({ error: 'Error getting department distribution' });
  }
});

// GET /api/metrics/summary  (mensajes totales, registrados, tasa respuesta, TMO)
router.get('/api/metrics/summary', async (_req, res) => {
  try {
    // Ventana para tasa y TMO: últimos 7 días en Lima
    const now = new Date();
    const sevenDaysAgoLimaISO = new Date(now.getTime() - 7 * 24 * 3600 * 1000).toISOString();

    const [messagesTotal, contactsRegistered] = await Promise.all([
      prisma.conversationHistory.count(),
      prisma.contact.count({ where: { state: 'REGISTERED' } })
    ]);

    // Tasa de respuesta: entrantes con respuesta / entrantes (últimos 7 días)
    // Supuesto: conversation_history.role IN ('USER','ASSISTANT')
    const resp = await prisma.$queryRawUnsafe<{
      incoming: string; with_reply: string; tmo_hours: string;
    }[]>(
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
      sevenDaysAgoLimaISO
    );

    const rec = resp[0] || { incoming: '0', with_reply: '0', tmo_hours: '0' };
    const incoming = parseInt(rec.incoming, 10) || 0;
    const withReply = parseInt(rec.with_reply, 10) || 0;
    const response_rate_pct = incoming > 0 ? (withReply / incoming) * 100 : 0;
    const avg_first_response_hours = Number(parseFloat(rec.tmo_hours).toFixed(2));

    res.json({
      messages_total: messagesTotal,
      contacts_registered: contactsRegistered,
      response_rate_pct: Number(response_rate_pct.toFixed(2)),
      avg_first_response_hours
    });
  } catch (error) {
    logger.error('Error in metrics summary:', error);
    res.status(500).json({ error: 'Error getting metrics summary' });
  }
});

export default router;
