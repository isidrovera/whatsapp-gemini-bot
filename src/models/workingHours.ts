import { getPrismaClient } from '../config/database.js';
import { logger } from '../utils/logger.js';
import * as calendarModel from './calendar.js'; // <- usa tu archivo real

const prisma = getPrismaClient();

/** =========================
 * INIT & CRUD BÁSICO
 * ========================== */
export async function initDefaults() {
  try {
    const count = await prisma.workingHours.count();

    if (count === 0) {
      logger.info('Initializing default working hours...');

      const defaultHours = [
        // Domingo - Cerrado
        { dayOfWeek: 0, isWorkday: false, openTime: null, closeTime: null, breakStart: null, breakEnd: null },

        // Lunes a Miércoles: 8:30 - 18:30
        { dayOfWeek: 1, isWorkday: true, openTime: '08:30', closeTime: '18:30', breakStart: '13:00', breakEnd: '14:00' },
        { dayOfWeek: 2, isWorkday: true, openTime: '08:30', closeTime: '18:30', breakStart: '13:00', breakEnd: '14:00' },
        { dayOfWeek: 3, isWorkday: true, openTime: '08:30', closeTime: '18:30', breakStart: '13:00', breakEnd: '14:00' },

        // Jueves y Viernes: 8:30 - 18:00
        { dayOfWeek: 4, isWorkday: true, openTime: '08:30', closeTime: '18:00', breakStart: '13:00', breakEnd: '14:00' },
        { dayOfWeek: 5, isWorkday: true, openTime: '08:30', closeTime: '18:00', breakStart: '13:00', breakEnd: '14:00' },

        // Sábado: 9:00 - 13:00
        { dayOfWeek: 6, isWorkday: true, openTime: '09:00', closeTime: '13:00', breakStart: null, breakEnd: null },
      ];

      for (const hours of defaultHours) {
        await prisma.workingHours.create({ data: hours });
      }

      logger.info('✅ Default working hours initialized');
    }
  } catch (error) {
    logger.error('Error initializing working hours:', error);
  }
}

export async function getAll() {
  try {
    return await prisma.workingHours.findMany({ orderBy: { dayOfWeek: 'asc' } });
  } catch (error) {
    logger.error('Error getting working hours:', error);
    return [];
  }
}

export async function getByDay(dayOfWeek: number) {
  try {
    return await prisma.workingHours.findUnique({ where: { dayOfWeek } });
  } catch (error) {
    logger.error('Error getting working hours by day:', error);
    return null;
  }
}

export async function update(
  dayOfWeek: number,
  data: {
    isWorkday?: boolean;
    openTime?: string | null;
    closeTime?: string | null;
    breakStart?: string | null;
    breakEnd?: string | null;
  }
) {
  try {
    return await prisma.workingHours.update({ where: { dayOfWeek }, data });
  } catch (error) {
    logger.error('Error updating working hours:', error);
    throw error;
  }
}

/** =========================
 * Nombres de días y utilidades simples
 * ========================== */
export function getDayName(dayOfWeek: number): string {
  const days = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
  return days[dayOfWeek] || 'Desconocido';
}
export function formatHHMM(s?: string | null) {
  return s ?? '--:--';
}
export function formatDateTime(d: Date, timeZone = 'America/Lima'): string {
  const opts: Intl.DateTimeFormatOptions = {
    timeZone,
    weekday: 'long',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  };
  return new Intl.DateTimeFormat('es-PE', opts).format(d);
}

/** =========================
 * Helpers de horario + feriados
 * ========================== */
function parseHHMM(s?: string | null): { h: number; m: number } | null {
  if (!s) return null;
  const [hh, mm] = s.split(':').map(Number);
  if (Number.isFinite(hh) && Number.isFinite(mm)) return { h: hh, m: mm };
  return null;
}
function timeToMinutes(t: { h: number; m: number }) {
  return t.h * 60 + t.m;
}
function nowLocalMinutes(now = new Date()) {
  return now.getHours() * 60 + now.getMinutes();
}
function addDays(d: Date, n: number) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
function startOfDay(d: Date) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

export type WorkStatusReason =
  | 'holiday'
  | 'closure'
  | 'non_workday'
  | 'before_open'
  | 'after_close'
  | 'break'
  | null;

export interface WorkStatusInfo {
  isOpen: boolean;
  reason: WorkStatusReason;
  todayHours: Awaited<ReturnType<typeof getByDay>> | null;
  todayEvent: Awaited<ReturnType<typeof calendarModel.getTodayEvent>> | null;
  nextOpenAt?: Date | null;
}

export async function isWorkingNow(): Promise<boolean> {
  const s = await getStatusInfo(new Date());
  return s.isOpen;
}

export async function getTodayHours() {
  const now = new Date();
  return await getByDay(now.getDay());
}

export async function getStatusInfo(now: Date = new Date()): Promise<WorkStatusInfo> {
  // Feriado/cierre del calendario tiene prioridad
  const isHoliday = await calendarModel.isHoliday(now);
  if (isHoliday) {
    const todayEvent = await calendarModel.getTodayEvent();
    return {
      isOpen: false,
      reason: (todayEvent?.type as any) || 'holiday',
      todayHours: await getByDay(now.getDay()),
      todayEvent,
      nextOpenAt: null,
    };
  }

  const hours = await getByDay(now.getDay());
  if (!hours || !hours.isWorkday) {
    return { isOpen: false, reason: 'non_workday', todayHours: hours, todayEvent: null, nextOpenAt: null };
  }

  const open = parseHHMM(hours.openTime);
  const close = parseHHMM(hours.closeTime);
  const brS = parseHHMM(hours.breakStart);
  const brE = parseHHMM(hours.breakEnd);

  if (!open || !close) {
    return { isOpen: false, reason: 'non_workday', todayHours: hours, todayEvent: null, nextOpenAt: null };
  }

  const nowMin = nowLocalMinutes(now);
  const openMin = timeToMinutes(open);
  const closeMin = timeToMinutes(close);

  if (nowMin < openMin) {
    return { isOpen: false, reason: 'before_open', todayHours: hours, todayEvent: null, nextOpenAt: null };
  }
  if (nowMin > closeMin) {
    return { isOpen: false, reason: 'after_close', todayHours: hours, todayEvent: null, nextOpenAt: null };
  }

  if (brS && brE) {
    const bS = timeToMinutes(brS);
    const bE = timeToMinutes(brE);
    if (nowMin >= bS && nowMin <= bE) {
      return { isOpen: false, reason: 'break', todayHours: hours, todayEvent: null, nextOpenAt: null };
    }
  }

  return { isOpen: true, reason: null, todayHours: hours, todayEvent: null, nextOpenAt: null };
}

export async function getNextOpenDateTime(from: Date = new Date()): Promise<Date | null> {
  const todayHoliday = await calendarModel.isHoliday(from);
  if (!todayHoliday) {
    const status = await getStatusInfo(from);
    if (status.todayHours && status.todayHours.isWorkday) {
      const open = parseHHMM(status.todayHours.openTime);
      const close = parseHHMM(status.todayHours.closeTime);
      const brE = parseHHMM(status.todayHours.breakEnd);

      if (open && close) {
        if (status.reason === 'before_open') {
          const next = new Date(from);
          next.setHours(open.h, open.m, 0, 0);
          return next;
        }
        if (status.reason === 'break' && brE) {
          const next = new Date(from);
          next.setHours(brE.h, brE.m, 0, 0);
          return next;
        }
        if (status.isOpen) {
          return new Date(from);
        }
      }
    }
  }

  // Buscar próximos 14 días el primer hábil no feriado
  for (let i = 1; i <= 14; i++) {
    const d = addDays(startOfDay(from), i);
    const holiday = await calendarModel.isHoliday(d);
    if (holiday) continue;
    const wh = await getByDay(d.getDay());
    if (wh && wh.isWorkday) {
      const open = parseHHMM(wh.openTime);
      if (!open) continue;
      const next = new Date(d);
      next.setHours(open.h, open.m, 0, 0);
      return next;
    }
  }
  return null;
}

// ======================================
// CONTEXTO DE HORARIO PARA IA
// ======================================

/**
 * Genera el bloque de texto que se inyecta como {{schedule_context}}.
 * Explica al modelo:
 * - si estamos atendiendo ahora o no
 * - cuál es el horario de hoy
 * - cuándo volvemos a estar disponibles si estamos cerrados
 *
 * Esto reemplaza la parte fija de horarios que tenías quemada en el SYSTEM_PROMPT.
 */
export async function getScheduleContextForAI(): Promise<string> {
  try {
    const now = new Date();
    const status = await getStatusInfo(now);

    const dayHours = status.todayHours;
    const openTime = dayHours?.openTime ?? '--:--';
    const closeTime = dayHours?.closeTime ?? '--:--';
    const breakStart = dayHours?.breakStart ?? null;
    const breakEnd = dayHours?.breakEnd ?? null;

    let line1 = '';
    if (status.isOpen) {
      line1 = 'En este momento estamos atendiendo ✅.';
    } else {
      // razón puede ser: feriado, break, fuera de horario, etc.
      if (status.reason === 'holiday' || status.reason === 'closure') {
        line1 = 'En este momento no estamos atendiendo (cierre programado / feriado).';
      } else if (status.reason === 'break') {
        line1 = 'En este momento estamos en break / almuerzo y retomamos en breve.';
      } else if (status.reason === 'before_open') {
        line1 = 'Aún no abrimos, pero abrimos más tarde hoy.';
      } else if (status.reason === 'after_close') {
        line1 = 'Ya cerramos por hoy.';
      } else if (status.reason === 'non_workday') {
        line1 = 'Hoy no es día laboral.';
      } else {
        line1 = 'En este momento no estamos atendiendo.';
      }
    }

    let line2 = `Horario de hoy: ${openTime} - ${closeTime}`;
    if (breakStart && breakEnd) {
      line2 += ` (break ${breakStart}-${breakEnd})`;
    }

    let line3 = '';
    if (!status.isOpen) {
      const next = await getNextOpenDateTime(now);
      if (next) {
        line3 = `Volvemos a estar disponibles el ${formatDateTime(next, 'America/Lima')}.`;
      }
    }

    // concatenar
    return [line1, line2, line3].filter(Boolean).join('\n');
  } catch (error) {
    logger.error('Error building schedule context for AI:', error);
    return 'Información de horario no disponible en este momento.';
  }
}