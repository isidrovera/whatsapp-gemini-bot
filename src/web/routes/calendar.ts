import express from 'express';
import * as calendarModel from '../../models/calendar.js';
import { logger } from '../../utils/logger.js';

const router = express.Router();

// Ver página de calendario
router.get('/', async (req, res) => {
  try {
    const events = await calendarModel.getAll();
    // Pasamos también "page" por si tu layout lo usa para activar la pestaña
    res.render('calendar', {
      title: 'Calendario',
      page: 'calendar',
      events
    });
  } catch (error) {
    logger.error('Error loading calendar:', error);
    res.status(500).send('Error loading calendar');
  }
});

// API: Obtener todos los eventos
router.get('/api', async (req, res) => {
  try {
    const events = await calendarModel.getAll();
    res.json(events);
  } catch (error) {
    logger.error('Error getting events:', error);
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
  } catch (error) {
    logger.error('Error getting event:', error);
    res.status(500).json({ error: 'Error getting event' });
  }
});

// API: Crear evento
router.post('/api', async (req, res) => {
  try {
    const { title, date, type, description, isRecurring } = req.body;

    if (!title || !date || !type) {
      return res.status(400).json({ error: 'title, date and type are required' });
    }

    // 👇 IMPORTANTE: NO convertir a new Date(date).
    // Enviamos el string 'YYYY-MM-DD' tal cual. El modelo lo normaliza.
    const event = await calendarModel.create(
      title,
      date,
      type,
      description,
      isRecurring
    );

    res.json({ success: true, event });
  } catch (error) {
    logger.error('Error creating event:', error);
    res.status(500).json({ error: 'Error creating event' });
  }
});

// API: Actualizar evento
router.put('/api/:id', async (req, res) => {
  try {
    const { title, date, type, description, isRecurring } = req.body;

    const updateData = {};
    if (title !== undefined) updateData.title = title;
    // 👇 Igual que create: no convertimos a Date aquí
    if (date !== undefined) updateData.date = date;
    if (type !== undefined) updateData.type = type;
    if (description !== undefined) updateData.description = description;
    if (isRecurring !== undefined) updateData.isRecurring = isRecurring;

    const event = await calendarModel.update(req.params.id, updateData);
    res.json({ success: true, event });
  } catch (error) {
    logger.error('Error updating event:', error);
    res.status(500).json({ error: 'Error updating event' });
  }
});

// API: Eliminar evento
router.delete('/api/:id', async (req, res) => {
  try {
    await calendarModel.remove(req.params.id);
    res.json({ success: true });
  } catch (error) {
    logger.error('Error deleting event:', error);
    res.status(500).json({ error: 'Error deleting event' });
  }
});

// API: Verificar si hoy es feriado
router.get('/api/check/today', async (req, res) => {
  try {
    const todayEvent = await calendarModel.getTodayEvent();
    const isHoliday = await calendarModel.isHoliday(new Date());

    res.json({
      isHoliday,
      event: todayEvent
    });
  } catch (error) {
    logger.error('Error checking today:', error);
    res.status(500).json({ error: 'Error checking today' });
  }
});
// API: Eventos de hoy (timeline dashboard)
router.get('/api/today', async (_req, res) => {
  try {
    // Si tu calendarModel ya maneja TZ, úsalo. Si no, filtramos por fecha local Lima.
    const events = await calendarModel.getByDate?.('today') || await calendarModel.getAll();

    // Filtra a solo HOY en Lima cuando no exista getByDate
    const todayLima = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima' }).format(new Date());
    const filtered = events.filter((e: any) => {
      const d = (e.date || e.start || '').slice(0, 10);
      return d === todayLima;
    });

    const shaped = filtered.map((e: any) => ({
      title: e.title,
      start: e.start || (e.date ? `${e.date}T09:00:00-05:00` : null),
      end: e.end || (e.date ? `${e.date}T10:00:00-05:00` : null),
      location: e.location || ''
    }));

    res.json(shaped);
  } catch (error) {
    logger.error('Error getting today events:', error);
    res.status(500).json({ error: 'Error getting today events' });
  }
});

export default router;
