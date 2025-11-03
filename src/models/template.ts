// src/models/template.ts
import { getPrismaClient } from '../config/database.js'   // ⬅️ agrega .js
import { logger } from '../utils/logger.js'               // ⬅️ agrega .js
import type { Prisma, MessageTemplate } from '@prisma/client'

const prisma = getPrismaClient()

export async function getAll(): Promise<MessageTemplate[]> {
  try {
    return await prisma.messageTemplate.findMany({
      orderBy: [
        { category: 'asc' },
        { name: 'asc' },
      ],
    })
  } catch (error) {
    logger.error({ err: error }, 'Error getting templates:')
    return []
  }
}

export async function getActive(): Promise<MessageTemplate[]> {
  try {
    return await prisma.messageTemplate.findMany({
      where: { isActive: true },
      orderBy: [
        { category: 'asc' },
        { name: 'asc' },
      ],
    })
  } catch (error) {
    logger.error({ err: error }, 'Error getting active templates:')
    return []
  }
}

export async function getByCategory(category: string): Promise<MessageTemplate[]> {
  try {
    return await prisma.messageTemplate.findMany({
      where: { category, isActive: true },
      orderBy: { name: 'asc' },
    })
  } catch (error) {
    logger.error({ err: error }, 'Error getting templates by category:')
    return []
  }
}

export async function findById(id: string): Promise<MessageTemplate | null> {
  try {
    return await prisma.messageTemplate.findUnique({ where: { id } })
  } catch (error) {
    logger.error({ err: error }, 'Error finding template:')
    return null
  }
}

type CreateTemplateInput =
  Pick<MessageTemplate, 'name' | 'content' | 'category'> &
  Partial<Pick<MessageTemplate, 'variables' | 'isActive'>>

type UpdateTemplateInput = Partial<
  Pick<MessageTemplate, 'name' | 'content' | 'category' | 'variables' | 'isActive'>
>

export async function create(data: CreateTemplateInput): Promise<MessageTemplate> {
  try {
    return await prisma.messageTemplate.create({ data })
  } catch (error) {
    logger.error({ err: error }, 'Error creating template:')
    throw error
  }
}

export async function update(id: string, data: UpdateTemplateInput): Promise<MessageTemplate> {
  try {
    return await prisma.messageTemplate.update({ where: { id }, data })
  } catch (error) {
    logger.error({ err: error }, 'Error updating template:')
    throw error
  }
}

export async function remove(id: string): Promise<MessageTemplate> {
  try {
    return await prisma.messageTemplate.delete({ where: { id } })
  } catch (error) {
    logger.error({ err: error }, 'Error deleting template:')
    throw error
  }
}

/** Renderizar template con variables: reemplaza {{clave}} por su valor. */
export function render(content: string, variables: Record<string, string>): string {
  let result = content
  for (const [key, value] of Object.entries(variables)) {
    const regex = new RegExp(`{{${key}}}`, 'g')
    result = result.replace(regex, value)
  }
  return result
}

/** Extrae variables: "Hola {{nombre}}, tu RUC es {{ruc}}" -> ['nombre','ruc'] */
export function extractVariables(content: string): string[] {
  const regex = /{{(\w+)}}/g
  const vars: string[] = []
  let m: RegExpExecArray | null
  while ((m = regex.exec(content)) !== null) {
    const key = m[1]
    if (!vars.includes(key)) vars.push(key)
  }
  return vars
}
