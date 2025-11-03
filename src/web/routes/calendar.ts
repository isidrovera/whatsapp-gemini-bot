// src/web/routes/calendar.ts
import express from 'express';
import * as calendarModel from '../../models/calendar.js';
import { logger } from '../../utils/logger.js';

const router = express.Router();

/* ================= Tipos y helpers ================= */

type EventType = 'holiday' | 'special_event' | 'closure';

const ALLOWED_TYPES = ['holiday', 'special_event', 'closure'] as const;

function parseEventType(value: unknown): EventType {
  if (typeof value === 'string' && (ALLOWED_TYPES as readonly string[]).includes(value)) {
    return value as EventType;
  }
  throw new Error('Invalid event type');
}

// ===== Tipos de request body =====
type CreateEventBody = {
  title: string;
  date: string; // esperado 'YYYY-MM-DD'
  type: EventType;
  description?: string;
  isRecurring?: boolean;
};

type UpdateEventBody = Partial<{
  title: string;
  date: string; // 'YYYY-MM-DD'
  type: EventType;
  description?: string;
  isRecurring?: boolean;
}>;

/* ================= Rutas ================= */

// Ver página de calendario
router.get('/', async (_req, res) => {
  try {
    const events = await calendarModel.getAll();
    res.render('calendar', {
      title: 'Calendario',
      page: 'calendar',
      events
    });
  } catch (err) {
    logger.error({ err }, 'Error loading calendar');
    res.status(500).send('Error loading calendar');
  }
});

// API: Obtener todos los eventos
router.get('/api', async (_req, res) => {
  try {
    const events = await calendarModel.getAll();
    res.json(events);
  } catch (err) {
    logger.error({ err }, 'Error getting events');
    res.status(500).json({ error: 'Error getting events' });
  }
});

// API: Obtener evento por ID
router.get('/api/:id', async (req, res) => {
  try {
    const event = await calendarModel.findById(req.params.id);
    if (!event) {
      return res.status(404).json({ error: 'Event not found' });
    }
    res.json(event);
  } catch (err) {
    logger.error({ err }, 'Error getting event');
    res.status(500).json({ error: 'Error getting event' });
  }
});

// API: Crear evento
router.post('/api', async (req, res) => {
  try {
    const { title, date, type, description, isRecurring } = req.body as Partial<CreateEventBody> & { type?: unknown };

    if (!title || !date || type === undefined) {
      return res.status(400).json({ error: 'title, date and type are required' });
    }

    // NO convertir a new Date(date). Mandamos 'YYYY-MM-DD' tal cual.
    const eventType = parseEventType(type);

    const event = await calendarModel.create(
      title,
      date,
      eventType,
      description,
      isRecurring
    );

    res.json({ success: true, event });
  } catch (err: any) {
    if (err?.message === 'Invalid event type') {
      return res.status(400).json({ error: 'Invalid event type. Use: holiday | special_event | closure' });
    }
    logger.error({ err }, 'Error creating event');
    res.status(500).json({ error: 'Error creating event' });
  }
});

// API: Actualizar evento
router.put('/api/:id', async (req, res) => {
  try {
    const { title, date, type, description, isRecurring } = req.body as Partial<CreateEventBody> & { type?: unknown };

    const updateData: UpdateEventBody = {};
    if (title !== undefined) updateData.title = title;
    if (date !== undefined) updateData.date = date;
    if (type !== undefined) updateData.type = parseEventType(type);
    if (description !== undefined) updateData.description = description;
    if (isRecurring !== undefined) updateData.isRecurring = isRecurring;

    const event = await calendarModel.update(req.params.id, updateData as {
      title?: string;
      date?: string | Date;
      type?: EventType;
      description?: string;
      isRecurring?: boolean;
    });

    res.json({ success: true, event });
  } catch (err: any) {
    if (err?.message === 'Invalid event type') {
      return res.status(400).json({ error: 'Invalid event type. Use: holiday | special_event | closure' });
    }
    logger.error({ err }, 'Error updating event');
    res.status(500).json({ error: 'Error updating event' });
  }
});

// API: Eliminar evento
router.delete('/api/:id', async (req, res) => {
  try {
    await calendarModel.remove(req.params.id);
    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, 'Error deleting event');
    res.status(500).json({ error: 'Error deleting event' });
  }
});

// API: Verificar si hoy es feriado
router.get('/api/check/today', async (_req, res) => {
  try {
    const todayEvent = await calendarModel.getTodayEvent();
    const isHoliday = await calendarModel.isHoliday(new Date());

    res.json({
      isHoliday,
      event: todayEvent
    });
  } catch (err) {
    logger.error({ err }, 'Error checking today');
    res.status(500).json({ error: 'Error checking today' });
  }
});

// API: Eventos de hoy (timeline dashboard)
router.get('/api/today', async (_req, res) => {
  try {
    const maybeGetByDate = (calendarModel as any).getByDate as
      | ((date: string) => Promise<any[]>)
      | undefined;

    // Fecha de hoy en Lima (YYYY-MM-DD)
    const todayLima = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima' })
      .format(new Date());

    const events = maybeGetByDate
      ? await maybeGetByDate(todayLima)
      : await calendarModel.getAll();

    // Si no hubo getByDate, filtramos a solo HOY en Lima
    const filtered = maybeGetByDate
      ? events
      : (events as any[]).filter((e) => {
          const d = String(e.date || e.start || '').slice(0, 10);
          return d === todayLima;
        });

    const shaped = (filtered as any[]).map((e) => ({
      title: e.title,
      start: e.start || (e.date ? `${e.date}T09:00:00-05:00` : null),
      end: e.end || (e.date ? `${e.date}T10:00:00-05:00` : null),
      location: e.location || ''
    }));

    res.json(shaped);
  } catch (err) {
    logger.error({ err }, 'Error getting today events');
    res.status(500).json({ error: 'Error getting today events' });
  }
});

export default router;
