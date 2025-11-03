// src/models/calendar.ts
import { getPrismaClient } from '../config/database.js';
import { logger } from '../utils/logger.js';

const prisma = getPrismaClient();

/** Convierte Date o 'YYYY-MM-DD' a 'YYYY-MM-DD'. */
function toYMD(input: Date | string): string {
  if (typeof input === 'string') return input.slice(0, 10);
  return input.toISOString().slice(0, 10);
}

/** Construye Date fijo UTC de medianoche: 'YYYY-MM-DDT00:00:00.000Z'. */
function ymdToUTCDate(ymd: string): Date {
  return new Date(`${ymd}T00:00:00.000Z`);
}

/** Serializa para UI: agrega dateYMD para evitar TZ shift en front. */
function serializeEvent(e: any) {
  return { ...e, dateYMD: toYMD(e.date) };
}

export async function create(
  title: string,
  date: Date | string,
  type: 'holiday' | 'special_event' | 'closure',
  description?: string,
  isRecurring?: boolean
) {
  try {
    const ymd = toYMD(date);
    const row = await prisma.calendarEvent.create({
      data: {
        title,
        date: ymdToUTCDate(ymd), // Prisma espera Date
        type,
        description,
        isRecurring: !!isRecurring,
      },
    });
    return serializeEvent(row);
  } catch (error: unknown) {
    logger.error({ err: error, title, date, type }, 'Error creating calendar event');
    throw error;
  }
}

export async function getAll() {
  try {
    const rows = await prisma.calendarEvent.findMany({ orderBy: { date: 'asc' } });
    return rows.map(serializeEvent);
  } catch (error: unknown) {
    logger.error({ err: error }, 'Error getting calendar events');
    return [];
  }
}

export async function getUpcoming(days: number = 30) {
  try {
    const todayYMD = toYMD(new Date());
    const future = new Date();
    future.setDate(future.getDate() + days);
    const futureYMD = toYMD(future);

    const rows = await prisma.calendarEvent.findMany({
      where: {
        date: {
          gte: ymdToUTCDate(todayYMD),
          lte: ymdToUTCDate(futureYMD),
        },
      },
      orderBy: { date: 'asc' },
    });
    return rows.map(serializeEvent);
  } catch (error: unknown) {
    logger.error({ err: error, days }, 'Error getting upcoming events');
    return [];
  }
}

export async function findById(id: string) {
  try {
    const row = await prisma.calendarEvent.findUnique({ where: { id } });
    return row ? serializeEvent(row) : null;
  } catch (error: unknown) {
    logger.error({ err: error, id }, 'Error finding calendar event');
    return null;
  }
}

export async function update(
  id: string,
  data: {
    title?: string;
    date?: Date | string;
    type?: 'holiday' | 'special_event' | 'closure';
    description?: string;
    isRecurring?: boolean;
  }
) {
  try {
    const payload: Record<string, unknown> = { ...data };
    if (data.date) {
      const ymd = toYMD(data.date);
      payload.date = ymdToUTCDate(ymd); // normalizamos
    }
    const row = await prisma.calendarEvent.update({ where: { id }, data: payload });
    return serializeEvent(row);
  } catch (error: unknown) {
    logger.error({ err: error, id, data }, 'Error updating calendar event');
    throw error;
  }
}

export async function remove(id: string) {
  try {
    return await prisma.calendarEvent.delete({ where: { id } });
  } catch (error: unknown) {
    logger.error({ err: error, id }, 'Error deleting calendar event');
    throw error;
  }
}

/** Busca por fecha y título (útil para evitar duplicados al sincronizar). */
export async function findByDateAndTitle(dateYMD: string, title: string) {
  try {
    const target = ymdToUTCDate(dateYMD);
    return await prisma.calendarEvent.findFirst({
      where: { date: target, title },
    });
  } catch (error: unknown) {
    logger.error({ err: error, dateYMD, title }, 'Error finding calendar event by date+title');
    return null;
  }
}

/** True si la fecha (YMD/Date) es feriado/cierre (comparación por fecha pura). */
export async function isHoliday(date: Date | string): Promise<boolean> {
  try {
    const ymd = toYMD(date);
    const found = await prisma.calendarEvent.findFirst({
      where: {
        type: { in: ['holiday', 'closure'] },
        date: ymdToUTCDate(ymd),
      },
    });
    return !!found;
  } catch (error: unknown) {
    logger.error({ err: error, date }, 'Error checking if holiday');
    return false;
  }
}

/** Evento de hoy (comparado por YMD UTC). */
export async function getTodayEvent() {
  try {
    const ymd = toYMD(new Date());
    const row = await prisma.calendarEvent.findFirst({
      where: { date: ymdToUTCDate(ymd) },
    });
    return row ? serializeEvent(row) : null;
  } catch (error: unknown) {
    logger.error({ err: error }, 'Error getting today event');
    return null;
  }
}
