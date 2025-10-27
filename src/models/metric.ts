import { getPrismaClient } from '../config/database'
import { logger } from '../utils/logger'
import type { ConversationMetric } from '@prisma/client'

// Prisma
const prisma = getPrismaClient()

// =====================
// Helpers de fechas
// =====================
function startOfDay(date: Date): Date {
  const d = new Date(date)
  d.setHours(0, 0, 0, 0)
  return d
}

function endOfDay(date: Date): Date {
  const d = new Date(date)
  d.setHours(23, 59, 59, 999)
  return d
}

function addDays(date: Date, days: number): Date {
  const d = new Date(date)
  d.setDate(d.getDate() + days)
  return d
}

/**
 * Las columnas de ConversationMetric:
 * - date (@db.Date)
 * - totalMessages, uniqueContacts, newContacts, serviceRequests, salesInquiries, humanTakeovers, avgResponseTime
 */

// =====================
// Consultas guardadas
// =====================

/**
 * Obtiene un registro de métricas por fecha (date-only).
 * Como en Prisma el campo es @db.Date, usamos un rango [00:00, 23:59:59] de esa fecha.
 */
export async function getByDate(date: Date): Promise<ConversationMetric | null> {
  try {
    const dayStart = startOfDay(date)
    const dayEnd = endOfDay(date)

    // Como ConversationMetric.date es DATE (sin tiempo), es suficiente comparar con igualdad
    // pero para seguridad usamos range con gte/lt del día siguiente.
    const metric = await prisma.conversationMetric.findFirst({
      where: {
        date: {
          gte: dayStart,
          lte: dayEnd,
        },
      },
    })
    return metric
  } catch (e) {
    logger.error('metric.getByDate error:', e)
    return null
  }
}

/**
 * Rango de fechas inclusive (ambos extremos).
 */
export async function getByDateRange(
  startDate: Date,
  endDate: Date
): Promise<ConversationMetric[]> {
  try {
    const s = startOfDay(startDate)
    const e = endOfDay(endDate)

    return await prisma.conversationMetric.findMany({
      where: {
        date: {
          gte: s,
          lte: e,
        },
      },
      orderBy: { date: 'asc' },
    })
  } catch (e) {
    logger.error('metric.getByDateRange error:', e)
    return []
  }
}

/**
 * Últimos N días (incluye hoy).
 */
export async function getLastDays(days: number): Promise<ConversationMetric[]> {
  try {
    const today = startOfDay(new Date())
    const from = addDays(today, -Math.max(0, days - 1))

    return await prisma.conversationMetric.findMany({
      where: {
        date: {
          gte: from,
          lte: endOfDay(today),
        },
      },
      orderBy: { date: 'asc' },
    })
  } catch (e) {
    logger.error('metric.getLastDays error:', e)
    return []
  }
}

/**
 * Calcula métricas de "hoy" ON THE FLY (sin necesitar que exista fila en conversation_metrics).
 * Usa tus tablas:
 *  - ConversationHistory (totalMessages, uniqueContacts)
 *  - Contact (newContacts)
 *  - Contact.humanTakeoverAt (humanTakeovers)
 *  - avgResponseTime: si no tienes lógica aún, lo dejamos en null
 *  - serviceRequests / salesInquiries: requieren reglas de negocio → por ahora 0
 */
export async function calculateToday(): Promise<Omit<ConversationMetric, 'id'> & { id?: string }> {
  try {
    const today = new Date()
    const dayStart = startOfDay(today)
    const dayEnd = endOfDay(today)

    // Total de mensajes hoy
    const totalMessages = await prisma.conversationHistory.count({
      where: {
        createdAt: { gte: dayStart, lte: dayEnd },
      },
    })

    // Contactos únicos que hablaron hoy (distinct phoneNumber)
    const uniqueToday = await prisma.conversationHistory.findMany({
      where: {
        createdAt: { gte: dayStart, lte: dayEnd },
      },
      select: { phoneNumber: true },
      distinct: ['phoneNumber'],
    })
    const uniqueContacts = uniqueToday.length

    // Nuevos contactos creados hoy
    const newContacts = await prisma.contact.count({
      where: {
        createdAt: { gte: dayStart, lte: dayEnd },
      },
    })

    // Toma de control humana hoy (Contact.humanTakeoverAt en el día)
    const humanTakeovers = await prisma.contact.count({
      where: {
        humanTakeoverAt: { gte: dayStart, lte: dayEnd },
      },
    })

    // Por ahora 0 hasta definir reglas (ej. por keywords, tags, etc.)
    const serviceRequests = 0
    const salesInquiries = 0

    // Si quieres calcular avgResponseTime, necesitarás una tabla/relación de mensajes
    // que marque latencias bot/usuario → lo dejamos en null
    const avgResponseTime: number | null = null

    return {
      date: dayStart, // date-only semánticamente
      totalMessages,
      uniqueContacts,
      newContacts,
      serviceRequests,
      salesInquiries,
      humanTakeovers,
      avgResponseTime,
      createdAt: new Date(),
    }
  } catch (e) {
    logger.error('metric.calculateToday error:', e)
    // Fallback seguro
    return {
      date: startOfDay(new Date()),
      totalMessages: 0,
      uniqueContacts: 0,
      newContacts: 0,
      serviceRequests: 0,
      salesInquiries: 0,
      humanTakeovers: 0,
      avgResponseTime: null,
      createdAt: new Date(),
    }
  }
}
