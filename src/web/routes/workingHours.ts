import express from 'express';
import * as workingHoursModel from '../../models/workingHours.js';
import { logger } from '../../utils/logger.js';

const router = express.Router();

// Ver página de horarios
router.get('/', async (req, res) => {
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
  } catch (error) {
    logger.error('Error loading working hours:', error);
    res.status(500).send('Error loading working hours');
  }
});

// API: Obtener todos los horarios
router.get('/api', async (req, res) => {
  try {
    const hours = await workingHoursModel.getAll();
    res.json(hours);
  } catch (error) {
    logger.error('Error getting working hours:', error);
    res.status(500).json({ error: 'Error getting working hours' });
  }
});

// API: Obtener horario por día
router.get('/api/:dayOfWeek', async (req, res) => {
  try {
    const dayOfWeek = parseInt(req.params.dayOfWeek);
    const hours = await workingHoursModel.getByDay(dayOfWeek);
    
    if (!hours) {
      return res.status(404).json({ error: 'Working hours not found' });
    }
    
    res.json(hours);
  } catch (error) {
    logger.error('Error getting working hours:', error);
    res.status(500).json({ error: 'Error getting working hours' });
  }
});

// API: Actualizar horario
router.put('/api/:dayOfWeek', async (req, res) => {
  try {
    const dayOfWeek = parseInt(req.params.dayOfWeek);
    const { isWorkday, openTime, closeTime, breakStart, breakEnd } = req.body;
    
    const updateData: any = {};
    if (isWorkday !== undefined) updateData.isWorkday = isWorkday;
    if (openTime !== undefined) updateData.openTime = openTime;
    if (closeTime !== undefined) updateData.closeTime = closeTime;
    if (breakStart !== undefined) updateData.breakStart = breakStart;
    if (breakEnd !== undefined) updateData.breakEnd = breakEnd;

    const hours = await workingHoursModel.update(dayOfWeek, updateData);
    res.json({ success: true, hours });
  } catch (error) {
    logger.error('Error updating working hours:', error);
    res.status(500).json({ error: 'Error updating working hours' });
  }
});

// API: Verificar si está en horario
router.get('/api/check/now', async (req, res) => {
  try {
    const isWorkingNow = await workingHoursModel.isWorkingNow();
    const todayHours = await workingHoursModel.getTodayHours();
    
    res.json({ 
      isWorkingNow,
      todayHours 
    });
  } catch (error) {
    logger.error('Error checking working status:', error);
    res.status(500).json({ error: 'Error checking working status' });
  }
});
// API: Verificar si está en horario (extendido para dashboard)
router.get('/api/check/now', async (_req, res) => {
  try {
    const isWorkingNow = await workingHoursModel.isWorkingNow();
    const todayHours = await workingHoursModel.getTodayHours();

    // weekday local (Jueves, etc.)
    const weekday_local = workingHoursModel.getDayName?.(new Date()) || '';

    // Progreso del día (con base en open/close, ignorando pausa; si quieres, descuéntala)
    let day_progress_pct = 0;
    let next_open_at: string | null = null;

    if (todayHours?.isWorkday && todayHours.openTime && todayHours.closeTime) {
      // Compón rangos en TZ Lima
      const tz = 'America/Lima';
      const now = new Date();
      const todayStr = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(now); // YYYY-MM-DD
      const open = new Date(`${todayStr}T${todayHours.openTime}:00-05:00`);
      const close = new Date(`${todayStr}T${todayHours.closeTime}:00-05:00`);

      const total = close.getTime() - open.getTime();
      const elapsed = Math.min(Math.max(now.getTime() - open.getTime(), 0), total);
      day_progress_pct = total > 0 ? Math.round((elapsed / total) * 100) : 0;

      // Próxima apertura (si está cerrado y hoy no abre más, calcula mañana)
      if (!isWorkingNow) {
        // Si aún no abre hoy
        if (now < open) next_open_at = open.toISOString();
        else {
          // Busca el próximo día laborable
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
  } catch (error) {
    logger.error('Error checking working status:', error);
    res.status(500).json({ error: 'Error checking working status' });
  }
});

export default router;