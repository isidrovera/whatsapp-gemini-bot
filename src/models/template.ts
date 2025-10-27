// src/models/messageTemplate.ts
import { getPrismaClient } from '../config/database'   // ⬅️ sin .js
import { logger } from '../utils/logger'               // ⬅️ sin .js
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
    logger.error('Error getting templates:', error)
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
    logger.error('Error getting active templates:', error)
    return []
  }
}

export async function getByCategory(category: string): Promise<MessageTemplate[]> {
  try {
    return await prisma.messageTemplate.findMany({
      where: {
        category,
        isActive: true,
      },
      orderBy: { name: 'asc' },
    })
  } catch (error) {
    logger.error('Error getting templates by category:', error)
    return []
  }
}

export async function findById(id: string): Promise<MessageTemplate | null> {
  try {
    return await prisma.messageTemplate.findUnique({
      where: { id },
    })
  } catch (error) {
    logger.error('Error finding template:', error)
    return null
  }
}

// Tipos de entrada seguros para create/update
type CreateTemplateInput = Pick<MessageTemplate, 'name' | 'content' | 'category'> &
  Partial<Pick<MessageTemplate, 'variables' | 'isActive'>>

type UpdateTemplateInput = Partial<
  Pick<MessageTemplate, 'name' | 'content' | 'category' | 'variables' | 'isActive'>
>

export async function create(data: CreateTemplateInput): Promise<MessageTemplate> {
  try {
    return await prisma.messageTemplate.create({ data })
  } catch (error) {
    logger.error('Error creating template:', error)
    throw error
  }
}

export async function update(id: string, data: UpdateTemplateInput): Promise<MessageTemplate> {
  try {
    return await prisma.messageTemplate.update({
      where: { id },
      data,
    })
  } catch (error) {
    logger.error('Error updating template:', error)
    throw error
  }
}

export async function remove(id: string): Promise<MessageTemplate> {
  try {
    return await prisma.messageTemplate.delete({
      where: { id },
    })
  } catch (error) {
    logger.error('Error deleting template:', error)
    throw error
  }
}

/**
 * Renderizar template con variables: reemplaza {{clave}} por su valor.
 * Si faltan variables, las deja tal cual (útil para depurar).
 */
export function render(
  content: string,
  variables: Record<string, string>
): string {
  let result = content

  // Si tus claves pueden tener caracteres especiales, habría que escapar.
  // Aquí asumimos claves tipo \w (coincide con extractVariables).
  for (const [key, value] of Object.entries(variables)) {
    const regex = new RegExp(`{{${key}}}`, 'g')
    result = result.replace(regex, value)
  }

  return result
}

/**
 * Extraer variables de un template: devuelve ['nombre', 'ruc'] para
 * "Hola {{nombre}}, tu RUC es {{ruc}}"
 */
export function extractVariables(content: string): string[] {
  const regex = /{{(\w+)}}/g
  const variables: string[] = []
  let match: RegExpExecArray | null

  while ((match = regex.exec(content)) !== null) {
    const key = match[1]
    if (!variables.includes(key)) variables.push(key)
  }

  return variables
}
