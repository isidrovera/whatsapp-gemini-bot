// src/models/configuration.ts
import { getPrismaClient } from '../config/database.js'
import { logger } from '../utils/logger.js'
import crypto from 'crypto'

const prisma = getPrismaClient()

// ==============================
// Encriptación
// ==============================
const ENCRYPTION_KEY =
  process.env.ENCRYPTION_KEY || 'default-encryption-key-change-me-32ch'
const ALGORITHM = 'aes-256-cbc'

function toKey32(key: string): Buffer {
  return Buffer.from(key.padEnd(32, '0').slice(0, 32))
}
function safeTrim(v: string | null | undefined): string {
  return (v ?? '').trim()
}

function encrypt(text: string): string {
  const key = toKey32(ENCRYPTION_KEY)
  const iv = crypto.randomBytes(16)
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv)
  let encrypted = cipher.update(text, 'utf8', 'hex')
  encrypted += cipher.final('hex')
  return iv.toString('hex') + ':' + encrypted
}

function decrypt(text: string): string {
  try {
    const key = toKey32(ENCRYPTION_KEY)
    const parts = text.split(':')
    const iv = Buffer.from(parts[0], 'hex')
    const encryptedText = parts[1]
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv)
    let decrypted = decipher.update(encryptedText, 'hex', 'utf8')
    decrypted += decipher.final('utf8')
    return decrypted
  } catch (error: unknown) {
    logger.error({ err: error }, 'Error decrypting value')
    return text
  }
}

// ==============================
// Defaults & Bootstrap (solo lo necesario)
// ==============================
export async function initDefaults(): Promise<void> {
  try {
    logger.info('Initializing default configurations...')

    const defaults = [
      // GEMINI
      { category: 'gemini', key: 'api_key', value: '', isEncrypted: true, description: 'Gemini API Key' },
      { category: 'gemini', key: 'model', value: 'gemini-2.5-flash', isEncrypted: false, description: 'Modelo de Gemini' },

      // ODOO
      { category: 'odoo', key: 'url', value: '', isEncrypted: false, description: 'URL de Odoo' },
      { category: 'odoo', key: 'database', value: '', isEncrypted: false, description: 'Base de datos Odoo' },
      { category: 'odoo', key: 'username', value: '', isEncrypted: false, description: 'Usuario Odoo' },
      { category: 'odoo', key: 'password', value: '', isEncrypted: true, description: 'Contraseña Odoo' },
      { category: 'odoo', key: 'enabled', value: 'false', isEncrypted: false, description: 'Habilitar integración Odoo' },

      // APIs EXTERNAS (DNI/RUC)
      { category: 'external_api', key: 'apis_token', value: '', isEncrypted: true, description: 'Token APIs.net.pe (DNI/RUC)' },
      { category: 'external_api', key: 'enabled', value: 'false', isEncrypted: false, description: 'Habilitar validación DNI/RUC' },

      // SISTEMA
      { category: 'system', key: 'web_port', value: '3000', isEncrypted: false, description: 'Puerto del servidor web' },
      { category: 'system', key: 'session_secret', value: crypto.randomBytes(32).toString('hex'), isEncrypted: true, description: 'Secret para sesiones' },
      { category: 'system', key: 'bot_name', value: 'Asistente Virtual', isEncrypted: false, description: 'Nombre del bot' },
      { category: 'system', key: 'auto_response_enabled', value: 'true', isEncrypted: false, description: 'Habilitar respuestas automáticas' },
      { category: 'system', key: 'department_routing_enabled', value: 'true', isEncrypted: false, description: 'Habilitar enrutamiento por departamentos' },

      // EMPRESA
      { category: 'company', key: 'name', value: 'Mi Empresa', isEncrypted: false, description: 'Nombre de la empresa' },
      { category: 'company', key: 'description', value: 'Empresa de servicios', isEncrypted: false, description: 'Descripción de la empresa' },
      { category: 'company', key: 'address', value: '', isEncrypted: false, description: 'Dirección' },
      { category: 'company', key: 'email', value: '', isEncrypted: false, description: 'Email de contacto' },
      { category: 'company', key: 'website', value: '', isEncrypted: false, description: 'Sitio web' },
      { category: 'company', key: 'main_phone', value: '', isEncrypted: false, description: 'Teléfono principal' },

      // POLÍTICAS / TONO
      { category: 'policy', key: 'tone_style', value: 'profesional_cercano_con_emojis', isEncrypted: false, description: 'Tono de respuesta' },
      { category: 'policy', key: 'link_label', value: 'enlace del sistema', isEncrypted: false, description: 'Etiqueta del link de tickets' },
      { category: 'policy', key: 'remote_tool_name', value: 'AnyDesk', isEncrypted: false, description: 'Herramienta de soporte remoto' },
      { category: 'policy', key: 'allow_direct_phone_share', value: 'true', isEncrypted: false, description: '¿Puede dar números directos?' },
      { category: 'policy', key: 'allow_field_visit_commitment', value: 'false', isEncrypted: false, description: '¿Puede prometer visita inmediata?' },

      // PROMPT BASE DEL ASISTENTE
      { category: 'ai_prompt', key: 'system_prompt', value: '', isEncrypted: false, description: 'System prompt base' },

      // TEMPLATES (dinámicos, solo textos – los horarios/feriados reales van por sus modelos)
      { category: 'templates', key: 'main_menu', value: '', isEncrypted: false, description: 'Plantilla del menú principal del bot' },
      { category: 'templates', key: 'after_hours', value: '⏰ {{reason}}.\n🕒 Hoy: {{open}}–{{close}}{{break_hint}}\n{{next_open_line}}', isEncrypted: false, description: 'Plantilla para fuera de horario' },
      { category: 'templates', key: 'break', value: '⏰ Estamos en refrigerio ({{break_start}}–{{break_end}}). Retomamos a las {{break_end}}.\n{{next_open_line}}', isEncrypted: false, description: 'Plantilla para horario de break' },
      { category: 'templates', key: 'holiday', value: '⛱️ Hoy es {{event_type}}: {{event_title}}. No atendemos hoy.\n{{next_open_line}}', isEncrypted: false, description: 'Plantilla para días feriados' },
    ] as const

    for (const cfg of defaults) {
      const valueToStore =
        cfg.isEncrypted && safeTrim(cfg.value).length > 0
          ? encrypt(cfg.value)
          : cfg.value

      await prisma.configuration.upsert({
        where: { category_key: { category: cfg.category, key: cfg.key } },
        create: {
          category: cfg.category,
          key: cfg.key,
          value: valueToStore,
          isEncrypted: cfg.isEncrypted,
          description: cfg.description,
        },
        update: { description: cfg.description },
      })
    }

    logger.info('✅ Default configurations initialized')
  } catch (error: unknown) {
    logger.error({ err: error }, 'Error initializing configurations')
  }
}

// ==============================
// CRUD Lectura / Escritura
// ==============================
export async function get(category: string, key: string): Promise<string | null> {
  try {
    const config = await prisma.configuration.findUnique({
      where: { category_key: { category, key } },
    })
    if (!config) return null
    return config.isEncrypted && config.value ? decrypt(config.value) : config.value
  } catch (error: unknown) {
    logger.debug({ category, key, err: error }, 'Config read failed')
    return null
  }
}

export async function set(
  category: string,
  key: string,
  value: string,
  isEncrypted = false
): Promise<void> {
  try {
    const valueToStore = isEncrypted ? encrypt(value) : value
    await prisma.configuration.upsert({
      where: { category_key: { category, key } },
      update: { value: valueToStore, isEncrypted, updatedAt: new Date() },
      create: { category, key, value: valueToStore, isEncrypted },
    })
    logger.info({ category, key }, 'Configuration updated')
  } catch (error: unknown) {
    logger.error({ err: error, category, key }, 'Error setting config')
    throw error
  }
}

export async function getByCategory(category: string) {
  try {
    const configs = await prisma.configuration.findMany({
      where: { category },
      orderBy: { key: 'asc' },
    })
    const result: Record<string, string | null> = {}
    for (const c of configs) {
      result[c.key] = c.value ? (c.isEncrypted ? decrypt(c.value) : c.value) : null
    }
    return result
  } catch (error: unknown) {
    logger.error({ err: error, category }, 'Error getting configs by category')
    return {}
  }
}

export async function getAll() {
  try {
    const configs = await prisma.configuration.findMany({
      orderBy: [{ category: 'asc' }, { key: 'asc' }],
    })
    return configs.map(c => ({
      id: c.id,
      category: c.category,
      key: c.key,
      value: c.isEncrypted ? '********' : c.value,
      isEncrypted: c.isEncrypted,
      description: c.description,
      updatedAt: c.updatedAt,
    }))
  } catch (error: unknown) {
    logger.error({ err: error }, 'Error getting all configs')
    return []
  }
}

export async function getAllDecrypted() {
  try {
    const configs = await prisma.configuration.findMany({
      orderBy: [{ category: 'asc' }, { key: 'asc' }],
    })
    return configs.map(c => ({
      id: c.id,
      category: c.category,
      key: c.key,
      value: c.value && c.isEncrypted ? decrypt(c.value) : c.value,
      isEncrypted: c.isEncrypted,
      description: c.description,
      updatedAt: c.updatedAt,
    }))
  } catch (error: unknown) {
    logger.error({ err: error }, 'Error getting all decrypted configs')
    return []
  }
}

export async function getMultiple(configs: Array<{ category: string; key: string }>) {
  try {
    const result: Record<string, string | null> = {}
    for (const { category, key } of configs) {
      result[`${category}.${key}`] = await get(category, key)
    }
    return result
  } catch (error: unknown) {
    logger.error({ err: error }, 'Error getting multiple configs')
    return {}
  }
}

export async function isConfigured(category: string, key: string): Promise<boolean> {
  const value = await get(category, key)
  return safeTrim(value).length > 0
}

export async function isCategoryConfigured(category: string): Promise<boolean> {
  try {
    const configs = await getByCategory(category)
    return Object.values(configs).some(v => safeTrim(v).length > 0)
  } catch (error: unknown) {
    logger.error({ err: error, category }, 'Error checking category configured')
    return false
  }
}

// ==============================
// Variables para IA / Plantillas
// ==============================
export async function getForSystemVariables(): Promise<Record<string, string>> {
  try {
    const company = await getByCategory('company')
    const policy = await getByCategory('policy')
    return {
      // Identidad pública
      company_name: company['name'] || 'Mi Empresa',
      company_description: company['description'] || '',
      company_address: company['address'] || '',
      company_email: company['email'] || '',
      company_website: company['website'] || '',
      company_phone: company['main_phone'] || '',

      // Política / tono
      policy_tone_style: policy['tone_style'] || 'profesional_cercano_con_emojis',
      policy_link_label: policy['link_label'] || 'enlace del sistema',
      policy_remote_tool_name: policy['remote_tool_name'] || 'AnyDesk',
      policy_allow_direct_phone_share: policy['allow_direct_phone_share'] || 'true',
      policy_allow_field_visit_commitment: policy['allow_field_visit_commitment'] || 'false',
    }
  } catch (error: unknown) {
    logger.error({ err: error }, 'Error getting configs for system variables')
    return {}
  }
}

export async function getTemplate(key: string): Promise<string | null> {
  return get('templates', key)
}

// ==============================
// Import / Export / Reset / Stats
// ==============================
export async function exportAll() {
  try {
    const configs = await getAllDecrypted()
    return JSON.stringify(configs, null, 2)
  } catch (error: unknown) {
    logger.error({ err: error }, 'Error exporting configs')
    return null
  }
}

export async function importAll(jsonData: string) {
  try {
    const configs = JSON.parse(jsonData)
    for (const c of configs) {
      await set(c.category, c.key, c.value || '', !!c.isEncrypted)
    }
    logger.info('✅ Configurations imported successfully')
    return true
  } catch (error: unknown) {
    logger.error({ err: error }, 'Error importing configs')
    return false
  }
}

export async function resetCategory(category: string) {
  try {
    await prisma.configuration.deleteMany({ where: { category } })
    await initDefaults()
    logger.info({ category }, '✅ Category reset to defaults')
    return true
  } catch (error: unknown) {
    logger.error({ err: error, category }, 'Error resetting category')
    return false
  }
}

export async function validateCritical(): Promise<{ isValid: boolean; missing: string[] }> {
  const critical = [{ category: 'gemini', key: 'api_key', name: 'Gemini API Key' }]
  const missing: string[] = []
  for (const c of critical) {
    const v = await get(c.category, c.key)
    if (!v || safeTrim(v).length === 0) missing.push(c.name)
  }
  return { isValid: missing.length === 0, missing }
}

export async function getStats() {
  try {
    const all = await prisma.configuration.findMany()
    const total = all.length
    const configured = all.filter(c => safeTrim(c.value).length > 0).length
    const encrypted = all.filter(c => c.isEncrypted).length
    return { total, encrypted, configured, pending: total - configured }
  } catch (error: unknown) {
    logger.error({ err: error }, 'Error getting config stats')
    return { total: 0, encrypted: 0, configured: 0, pending: 0 }
  }
}
