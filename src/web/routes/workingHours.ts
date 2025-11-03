import express, { Request, Response } from 'express';
import * as workingHoursModel from '../../models/workingHours.js';
import { logger } from '../../utils/logger.js';

const router = express.Router();

// Ver página de horarios
router.get('/', async (_req: Request, res: Response) => {
  try {
    const hours = await workingHoursModel.getAll();
    const todayHours = await workingHoursModel.getTodayHours();
    const isWorkingNow = await workingHoursModel.isWorkingNow();

    res.render('workingHours', {
      title: 'Horarios de Trabajo',
      hours,
      todayHours,
      isWorkingNow,
      getDayName: workingHoursModel.getDayName
    });
  } catch (err: unknown) {
    logger.error({ err }, 'Error loading working hours');
    res.status(500).send('Error loading working hours');
  }
});

// API: Obtener todos los horarios
router.get('/api', async (_req: Request, res: Response) => {
  try {
    const hours = await workingHoursModel.getAll();
    res.json(hours);
  } catch (err: unknown) {
    logger.error({ err }, 'Error getting working hours');
    res.status(500).json({ error: 'Error getting working hours' });
  }
});

// API: Obtener horario por día
router.get('/api/:dayOfWeek', async (req: Request, res: Response) => {
  try {
    const dayOfWeek = parseInt(req.params.dayOfWeek, 10);
    const hours = await workingHoursModel.getByDay(dayOfWeek);

    if (!hours) {
      return res.status(404).json({ error: 'Working hours not found' });
    }

    res.json(hours);
  } catch (err: unknown) {
    logger.error({ err }, 'Error getting working hours');
    res.status(500).json({ error: 'Error getting working hours' });
  }
});

// API: Actualizar horario
router.put('/api/:dayOfWeek', async (req: Request, res: Response) => {
  try {
    const dayOfWeek = parseInt(req.params.dayOfWeek, 10);
    const { isWorkday, openTime, closeTime, breakStart, breakEnd } = req.body as {
      isWorkday?: boolean;
      openTime?: string;
      closeTime?: string;
      breakStart?: string | null;
      breakEnd?: string | null;
    };

    const updateData: Record<string, unknown> = {};
    if (isWorkday !== undefined) updateData.isWorkday = isWorkday;
    if (openTime !== undefined) updateData.openTime = openTime;
    if (closeTime !== undefined) updateData.closeTime = closeTime;
    if (breakStart !== undefined) updateData.breakStart = breakStart;
    if (breakEnd !== undefined) updateData.breakEnd = breakEnd;

    const hours = await workingHoursModel.update(dayOfWeek, updateData);
    res.json({ success: true, hours });
  } catch (err: unknown) {
    logger.error({ err }, 'Error updating working hours');
    res.status(500).json({ error: 'Error updating working hours' });
  }
});

// API: Verificar si está en horario (básico)
router.get('/api/check/now', async (_req: Request, res: Response) => {
  try {
    const isWorkingNow = await workingHoursModel.isWorkingNow();
    const todayHours = await workingHoursModel.getTodayHours();

    res.json({ isWorkingNow, todayHours });
  } catch (err: unknown) {
    logger.error({ err }, 'Error checking working status');
    res.status(500).json({ error: 'Error checking working status' });
  }
});

// API: Verificar si está en horario (extendido para dashboard)
router.get('/api/check/now/extended', async (_req: Request, res: Response) => {
  try {
    const isWorkingNow = await workingHoursModel.isWorkingNow();
    const todayHours = await workingHoursModel.getTodayHours();

    // Nombre de día local (ej: Jueves)
    const weekday_local = workingHoursModel.getDayName?.(new Date().getTime()) || '';

    // Progreso del día (simple: open->close)
    let day_progress_pct = 0;
    let next_open_at: string | null = null;

    if (todayHours?.isWorkday && todayHours.openTime && todayHours.closeTime) {
      const tz = 'America/Lima';
      const now = new Date();
      const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(now); // YYYY-MM-DD

      // Nota: si cambias de zona, ajusta el offset manual si tu servidor no tiene TZ Lima
      const open = new Date(`${ymd}T${todayHours.openTime}:00-05:00`);
      const close = new Date(`${ymd}T${todayHours.closeTime}:00-05:00`);

      const total = close.getTime() - open.getTime();
      const elapsed = Math.min(Math.max(now.getTime() - open.getTime(), 0), total);
      day_progress_pct = total > 0 ? Math.round((elapsed / total) * 100) : 0;

      if (!isWorkingNow) {
        if (now < open) {
          next_open_at = open.toISOString();
        } else {
          const next = await workingHoursModel.getNextOpenDateTime?.();
          next_open_at = next ? new Date(next).toISOString() : null;
        }
      }
    }

    res.json({
      isWorkingNow,
      todayHours,
      weekday_local,
      day_progress_pct,
      next_open_at
    });
  } catch (err: unknown) {
    logger.error({ err }, 'Error checking working status (extended)');
    res.status(500).json({ error: 'Error checking working status' });
  }
});

export default router;