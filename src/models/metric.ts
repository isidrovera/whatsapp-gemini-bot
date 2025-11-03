import { getPrismaClient } from '../config/database.js'
import { logger } from '../utils/logger.js'
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
 * Para mayor robustez usamos rango [gte: startOfDay, lt: nextDayStart].
 */
export async function getByDate(date: Date): Promise<ConversationMetric | null> {
  try {
    const dayStart = startOfDay(date)
    const nextDay = addDays(dayStart, 1)

    const metric = await prisma.conversationMetric.findFirst({
      where: {
        date: {
          gte: dayStart,
          lt: nextDay,
        },
      },
    })
    return metric
  } catch (err) {
    logger.error({ err }, 'metric.getByDate error:')
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
    const eNext = addDays(startOfDay(endDate), 1)

    return await prisma.conversationMetric.findMany({
      where: {
        date: {
          gte: s,
          lt: eNext,
        },
      },
      orderBy: { date: 'asc' },
    })
  } catch (err) {
    logger.error({ err }, 'metric.getByDateRange error:')
    return []
  }
}

/**
 * Últimos N días (incluye hoy).
 */
export async function getLastDays(days: number): Promise<ConversationMetric[]> {
  try {
    const todayStart = startOfDay(new Date())
    const from = addDays(todayStart, -Math.max(0, days - 1))
    const tomorrowStart = addDays(todayStart, 1)

    return await prisma.conversationMetric.findMany({
      where: {
        date: {
          gte: from,
          lt: tomorrowStart,
        },
      },
      orderBy: { date: 'asc' },
    })
  } catch (err) {
    logger.error({ err }, 'metric.getLastDays error:')
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

    // Por ahora 0 hasta definir reglas
    const serviceRequests = 0
    const salesInquiries = 0

    // Sin lógica de latencias por ahora
    const avgResponseTime: number | null = null

    return {
      date: dayStart, // semánticamente date-only
      totalMessages,
      uniqueContacts,
      newContacts,
      serviceRequests,
      salesInquiries,
      humanTakeovers,
      avgResponseTime,
      createdAt: new Date(),
      // updatedAt: new Date(), // Descomenta si tu esquema lo exige
    }
  } catch (err) {
    logger.error({ err }, 'metric.calculateToday error:')
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
      // updatedAt: new Date(), // Descomenta si tu esquema lo exige
    }
  }
}
