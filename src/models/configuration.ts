// src/models/configuration.ts
import { getPrismaClient } from '../config/database.js'
import { logger } from '../utils/logger.js'
import crypto from 'crypto'

const prisma = getPrismaClient()

// ==============================
// Encriptación
// ==============================

// Clave de encriptación (debe estar en .env). Para AES-256 necesitamos 32 bytes.
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'default-encryption-key-change-me-32ch'
const ALGORITHM = 'aes-256-cbc'

// Helpers
function toKey32(key: string): Buffer {
  return Buffer.from(key.padEnd(32, '0').slice(0, 32))
}
function safeTrim(v: string | null | undefined): string {
  return (v ?? '').trim()
}

// Encriptar valor sensible
function encrypt(text: string): string {
  const key = toKey32(ENCRYPTION_KEY)
  const iv = crypto.randomBytes(16)
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv)
  let encrypted = cipher.update(text, 'utf8', 'hex')
  encrypted += cipher.final('hex')
  return iv.toString('hex') + ':' + encrypted
}

// Desencriptar valor sensible
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
  } catch (error) {
    logger.error('Error decrypting value:', error)
    // Como fallback, retorna tal cual
    return text
  }
}

// ==============================
// Defaults & Bootstrap
// ==============================

/**
 * Inicializa las configuraciones por defecto de forma idempotente.
 * - Usa upsert por (category, key)
 * - NO sobreescribe valores existentes del usuario
 * - Encripta valores por defecto que deban ser sensibles
 */
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

      // APIs EXTERNAS
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
    ] as const

    for (const cfg of defaults) {
      // Si el default tiene valor y es sensible, lo encriptamos antes de crear
      const valueToStore =
        cfg.isEncrypted && safeTrim(cfg.value).length > 0
          ? encrypt(cfg.value)
          : cfg.value

      await prisma.configuration.upsert({
        where: { category_key: { category: cfg.category, key: cfg.key } }, // @@unique([category, key])
        create: {
          category: cfg.category,
          key: cfg.key,
          value: valueToStore,
          isEncrypted: cfg.isEncrypted,
          description: cfg.description,
        },
        update: {
          // No tocar el value existente del usuario; solo metadatos
          description: cfg.description,
          // Opcionalmente podrías normalizar isEncrypted si cambió en schema de defaults
          // isEncrypted: cfg.isEncrypted,
        },
      })
    }

    logger.info('✅ Default configurations initialized')
  } catch (error) {
    logger.error('Error initializing configurations:', error)
    // Si prefieres que index.ts detecte y no imprima "✅", descomenta:
    // throw error
  }
}

// ==============================
// CRUD Lectura / Escritura
// ==============================

export async function get(category: string, key: string): Promise<string | null> {
  try {
    const config = await prisma.configuration.findUnique({
      where: {
        category_key: {
          category,
          key,
        },
      },
    });

    if (!config) {
      logger.debug(`Config not found in DB: ${category}.${key} (will use fallback if available)`);
      return null;
    }

    // Desencriptar si es necesario
    if (config.isEncrypted && config.value) {
      return decrypt(config.value);
    }

    return config.value;
  } catch (error) {
    // Cambiar de ERROR a DEBUG para no alarmar
    logger.debug(`Config ${category}.${key} not found in database, using fallback`);
    return null;
  }
}

export async function set(
  category: string,
  key: string,
  value: string,
  isEncrypted: boolean = false
): Promise<void> {
  try {
    const valueToStore = isEncrypted ? encrypt(value) : value

    await prisma.configuration.upsert({
      where: { category_key: { category, key } },
      update: { value: valueToStore, isEncrypted, updatedAt: new Date() },
      create: { category, key, value: valueToStore, isEncrypted },
    })

    logger.info(`Configuration updated: ${category}.${key}`)
  } catch (error) {
    logger.error(`Error setting config ${category}.${key}:`, error)
    throw error
  }
}

export async function getByCategory(category: string) {
  try {
    const configs = await prisma.configuration.findMany({
      where: { category },
      orderBy: { key: 'asc' },
    })

    const result: { [key: string]: string | null } = {}

    for (const config of configs) {
      if (config.value) {
        result[config.key] = config.isEncrypted ? decrypt(config.value) : config.value
      } else {
        result[config.key] = null
      }
    }

    return result
  } catch (error) {
    logger.error(`Error getting configs for category ${category}:`, error)
    return {}
  }
}

export async function getAll() {
  try {
    const configs = await prisma.configuration.findMany({
      orderBy: [{ category: 'asc' }, { key: 'asc' }],
    })

    return configs.map(config => ({
      id: config.id,
      category: config.category,
      key: config.key,
      value: config.isEncrypted ? '********' : config.value, // Ocultar valores encriptados
      isEncrypted: config.isEncrypted,
      description: config.description,
      updatedAt: config.updatedAt,
    }))
  } catch (error) {
    logger.error('Error getting all configs:', error)
    return []
  }
}

export async function getAllDecrypted() {
  try {
    const configs = await prisma.configuration.findMany({
      orderBy: [{ category: 'asc' }, { key: 'asc' }],
    })

    return configs.map(config => ({
      id: config.id,
      category: config.category,
      key: config.key,
      value: config.value && config.isEncrypted ? decrypt(config.value) : config.value,
      isEncrypted: config.isEncrypted,
      description: config.description,
      updatedAt: config.updatedAt,
    }))
  } catch (error) {
    logger.error('Error getting all decrypted configs:', error)
    return []
  }
}

// Obtener múltiples configuraciones a la vez
export async function getMultiple(configs: Array<{ category: string; key: string }>) {
  try {
    const result: { [key: string]: string | null } = {}

    for (const { category, key } of configs) {
      result[`${category}.${key}`] = await get(category, key)
    }

    return result
  } catch (error) {
    logger.error('Error getting multiple configs:', error)
    return {}
  }
}

// Verificar si una configuración está completa
export async function isConfigured(category: string, key: string): Promise<boolean> {
  const value = await get(category, key)
  return safeTrim(value).length > 0
}

// Verificar si una categoría completa está configurada (al menos un valor no vacío)
export async function isCategoryConfigured(category: string): Promise<boolean> {
  try {
    const configs = await getByCategory(category)
    return Object.values(configs).some(v => safeTrim(v).length > 0)
  } catch (error) {
    logger.error(`Error checking category ${category}:`, error)
    return false
  }
}

// ==============================
// Compat: Variables para SystemVar
// ==============================

export async function getForSystemVariables(): Promise<{ [key: string]: string }> {
  try {
    const companyConfigs = await getByCategory('company')

    return {
      company_name: companyConfigs.name || 'Mi Empresa',
      company_description: companyConfigs.description || '',
      company_address: companyConfigs.address || '',
      company_email: companyConfigs.email || '',
      company_website: companyConfigs.website || '',
      company_phone: companyConfigs.main_phone || '',
    }
  } catch (error) {
    logger.error('Error getting configs for system variables:', error)
    return {}
  }
}

// ==============================
// Import/Export & Reset
// ==============================

export async function exportAll() {
  try {
    const configs = await getAllDecrypted()
    return JSON.stringify(configs, null, 2)
  } catch (error) {
    logger.error('Error exporting configs:', error)
    return null
  }
}

export async function importAll(jsonData: string) {
  try {
    const configs = JSON.parse(jsonData)

    for (const config of configs) {
      // Preservar encriptación original del backup
      const isEncrypted = !!config.isEncrypted
      const value = config.value || ''
      await set(config.category, config.key, value, isEncrypted)
    }

    logger.info('✅ Configurations imported successfully')
    return true
  } catch (error) {
    logger.error('Error importing configs:', error)
    return false
  }
}

// Resetear una categoría a valores por defecto
export async function resetCategory(category: string) {
  try {
    await prisma.configuration.deleteMany({ where: { category } })
    await initDefaults()
    logger.info(`✅ Category ${category} reset to defaults`)
    return true
  } catch (error) {
    logger.error(`Error resetting category ${category}:`, error)
    return false
  }
}

// ==============================
// Validaciones & Estadísticas
// ==============================

export async function validateCritical(): Promise<{
  isValid: boolean
  missing: string[]
}> {
  // Agrega aquí las claves críticas que quieras exigir
  const critical = [
    { category: 'gemini', key: 'api_key', name: 'Gemini API Key' },
    // { category: 'odoo', key: 'url', name: 'Odoo URL' }, // si lo quieres obligatorio, descomenta
  ]

  const missing: string[] = []

  for (const { category, key, name } of critical) {
    const v = await get(category, key)
    if (!v || safeTrim(v).length === 0) {
      missing.push(name)
    }
  }

  return { isValid: missing.length === 0, missing }
}

export async function getStats() {
  try {
    const all = await prisma.configuration.findMany()

    const total = all.length
    const configured = all.filter(c => safeTrim(c.value).length > 0).length
    const encrypted = all.filter(c => c.isEncrypted).length
    const pending = total - configured

    return { total, encrypted, configured, pending }
  } catch (error) {
    logger.error('Error getting config stats:', error)
    return { total: 0, encrypted: 0, configured: 0, pending: 0 }
  }
}
