// src/index.ts
import { logger } from './utils/logger.js'
import { getPrismaClient, disconnectDatabase } from './config/database.js'
import {
  initializeWhatsApp,
  disconnect as disconnectWhatsApp,
  getConnectionStatus
} from './services/whatsapp.js'
import { startWebServer } from './web/server.js'

import * as systemVarModel from './models/systemVar.js'
import * as conversationModel from './models/conversation.js'
import * as adminModel from './models/admin.js'
import * as workingHoursModel from './models/workingHours.js'
import * as calendarModel from './models/calendar.js'
import * as holidaySync from './services/holidaySync.js'
import * as contactModel from './models/contact.js'

import * as configModel from './models/configuration.js'
import * as departmentModel from './models/department.js'
import { initializeGemini } from './config/gemini.js'
import { initializeOdoo } from './services/odoo.js'

// 👇 NUEVO: siembras directas desde los modelos
import { ensureDefaults as ensureTemplateDefaults } from './models/template.js'
import { ensureDefaults as ensureAutoResponseDefaults } from './models/autoResponse.js'

// ==============================
// Protección contra hot-reload
// ==============================
declare global {
  // Variables globales para evitar duplicar instancias
  var __appInitialized: boolean | undefined
  var __appIntervals: NodeJS.Timeout[] | undefined
}

// Limpiar intervalos anteriores si existen (por hot-reload)
if (global.__appIntervals && global.__appIntervals.length > 0) {
  logger.warn(`⚠️  Hot-reload detected. Cleaning ${global.__appIntervals.length} old intervals...`)
  global.__appIntervals.forEach(clearInterval)
  global.__appIntervals = []
}

// Prevenir re-inicialización completa en hot-reload
if (global.__appInitialized) {
  logger.warn('⚠️  App already initialized. Skipping re-initialization (hot-reload detected).')
  logger.warn('   To force full restart, stop the process completely (Ctrl+C) and restart.')
  process.exit(0) // Salir para que tsx watch reinicie limpio
}

// Inicializar array de intervalos
if (!global.__appIntervals) {
  global.__appIntervals = []
}

// Flags por ENV
const ENABLE_HOLIDAYS_RESYNC = (process.env.ENABLE_HOLIDAYS_RESYNC ?? 'false').toLowerCase() === 'true'
const ENABLE_HEARTBEAT = (process.env.ENABLE_HEARTBEAT ?? 'false').toLowerCase() === 'true'

// Periodos (ms)
const HOLIDAYS_RESYNC_MS = Math.max(
  1000 * 60 * 60 * 24 * 7,
  Number(process.env.HOLIDAYS_RESYNC_MS || (1000 * 60 * 60 * 24 * 30))
) // >= 7 días

const HEARTBEAT_MS = Math.max(
  60_000,
  Number(process.env.HEARTBEAT_MS || 300_000)
) // >= 60s

async function main() {
  try {
    logger.info('🚀 Starting WhatsApp Gemini Bot...')
    logger.info('='.repeat(50))

    // 1) DB
    logger.info('📊 Connecting to database...')
    const prisma = getPrismaClient()
    await prisma.$connect()
    logger.info('✅ Database connected')

    // 2) Admin
    logger.info('👤 Initializing admin users...')
    await adminModel.initDefaultAdmin()
    logger.info('✅ Admin users initialized')

    // 3) Configuraciones unificadas
    logger.info('⚙️  Initializing configurations...')
    await configModel.initDefaults()
    logger.info('✅ Configurations initialized')

    // 4) Variables de sistema
    logger.info('⚙️  Initializing system variables...')
    await systemVarModel.initDefaults()
    logger.info('✅ System variables initialized')

    // 5) Horarios de trabajo
    logger.info('⏰ Initializing working hours...')
    await workingHoursModel.initDefaults()
    logger.info('✅ Working hours initialized')

    // 6) Departamentos
    logger.info('🏢 Initializing departments...')
    await departmentModel.initDefaults()
    logger.info('✅ Departments initialized')

    // 7) Sincronización de feriados (UNA SOLA VEZ al inicio)
    logger.info('🗓️  Syncing public holidays...')
    try {
      await holidaySync.syncPublicHolidays()
      logger.info('✅ Public holidays synced')
    } catch (e) {
      logger.warn({ err: e }, '⚠️  Holiday sync failed (non-blocking)')
    }

    // 7.1) 👇 NUEVO: Seeds idempotentes desde los modelos (sin initData.ts)
    logger.info('📝 Seeding message templates (idempotent)...')
    await ensureTemplateDefaults()
    logger.info('✅ Templates ensured')

    logger.info('🤖 Seeding auto-responses (idempotent)...')
    await ensureAutoResponseDefaults()
    logger.info('✅ Auto-responses ensured')

    // 8) Gemini
    logger.info('🤖 Initializing Gemini AI...')
    try {
      await initializeGemini()
      logger.info('✅ Gemini AI initialized')
    } catch (error) {
      logger.warn('⚠️  Gemini initialization failed. Configure API key in Settings.')
      logger.warn(`   Visit: http://localhost:${process.env.WEB_PORT || 3000}/settings`)
    }

    // 9) Odoo
    logger.info('🏢 Initializing Odoo ERP...')
    try {
      await initializeOdoo()
      logger.info('✅ Odoo ERP initialized')
    } catch (error) {
      logger.warn('⚠️  Odoo initialization failed. Configure credentials in Settings.')
    }

    // 10) Limpiar conversaciones antiguas
    logger.info('🧹 Cleaning old conversations...')
    const deletedCount = await conversationModel.deleteOld(30)
    logger.info(`✅ Deleted ${deletedCount} old conversations`)

    // 11) Web server
    logger.info('🌐 Starting web admin panel...')
    startWebServer()
    logger.info('✅ Web admin panel started')

    // 12) WhatsApp
    logger.info('📱 Initializing WhatsApp client...')
    await initializeWhatsApp()

    let attempts = 0
    while (!getConnectionStatus() && attempts < 60) {
      await new Promise((resolve) => setTimeout(resolve, 1000))
      attempts++
      if (attempts % 10 === 0) {
        logger.info(`⏳ Waiting for WhatsApp connection... (${attempts}s)`)
      }
    }

    if (getConnectionStatus()) {
      logger.info('✅ WhatsApp client ready')
    } else {
      logger.warn('⚠️  WhatsApp did not connect within 60s')
      logger.warn(`   Please scan the QR code at: http://localhost:${process.env.WEB_PORT || 3000}/auth/qr`)
    }

    // 13) Logs finales
    logger.info('='.repeat(50))
    logger.info('🤖 Bot is running and ready to receive messages!')
    logger.info('📱 WhatsApp: ' + (getConnectionStatus() ? 'Connected ✅' : 'Waiting for QR scan ⏳'))
    logger.info(`🌐 Web Panel:  http://localhost:${process.env.WEB_PORT || 3000}`)
    logger.info(`🔐 Login:      http://localhost:${process.env.WEB_PORT || 3000}/auth/login`)
    logger.info(`⚙️  Settings:   http://localhost:${process.env.WEB_PORT || 3000}/settings`)
    logger.info('='.repeat(50))

    // 14) Config info
    await displayConfigInfo()

    // 15) Heartbeat (solo si está habilitado)
    if (ENABLE_HEARTBEAT) {
      const heartbeatInterval = setInterval(() => {
        logger.info(`🫀 Health: WhatsApp=${getConnectionStatus() ? 'Connected' : 'Disconnected'}`)
      }, HEARTBEAT_MS)

      global.__appIntervals!.push(heartbeatInterval)
      logger.info(`🫀 Heartbeat enabled (every ${Math.round(HEARTBEAT_MS / 1000)}s)`)
    } else {
      logger.info('🫀 Heartbeat disabled (set ENABLE_HEARTBEAT=true to enable)')
    }

    // 16) Re-sincronización de feriados (solo si está habilitado)
    if (ENABLE_HOLIDAYS_RESYNC) {
      const holidaysInterval = setInterval(() => {
        holidaySync
          .syncPublicHolidays()
          .then(() => logger.info('🗓️  Monthly public holidays re-sync: ✅ OK'))
          .catch((e) => logger.warn({ err: e }, '⚠️  Monthly holiday re-sync failed'))
      }, HOLIDAYS_RESYNC_MS)

      global.__appIntervals!.push(holidaysInterval)
      logger.info(`🗓️  Holiday re-sync enabled (every ${Math.round(HOLIDAYS_RESYNC_MS / (1000 * 60 * 60 * 24))} days)`)
    } else {
      logger.info('🗓️  Holiday re-sync disabled (set ENABLE_HOLIDAYS_RESYNC=true to enable)')
    }

    // 17) Auto-liberación de human takeovers expirados
    const autoReleaseTakeoverEnabled = (await configModel.get('system', 'auto_release_takeover_enabled')) === 'true'
    
    if (autoReleaseTakeoverEnabled) {
      const intervalSeconds = parseInt((await configModel.get('system', 'auto_release_check_interval')) || '300')
      const AUTO_RELEASE_CHECK_MS = Math.max(60_000, intervalSeconds * 1000) // Mínimo 1 minuto

      const autoReleaseInterval = setInterval(() => {
        contactModel
          .autoReleaseExpiredTakeovers()
          .then((count) => {
            if (count > 0) {
              logger.info(`🔓 Auto-release: ${count} takeover(s) liberado(s)`)
            }
          })
          .catch((e) => logger.warn({ err: e }, '⚠️  Auto-release takeover failed'))
      }, AUTO_RELEASE_CHECK_MS)

      global.__appIntervals!.push(autoReleaseInterval)
      logger.info(`🔓 Auto-release takeover enabled (every ${Math.round(AUTO_RELEASE_CHECK_MS / 1000)}s)`)
    } else {
      logger.info('🔓 Auto-release takeover disabled (enable in Settings → System)')
    }

    // 18) Señales de terminación
    setupGracefulShutdown()

    // Marcar como inicializado
    global.__appInitialized = true
  } catch (error) {
    logger.error({ err: error }, '❌ Fatal error starting bot:')
    process.exit(1)
  }
}

async function displayConfigInfo() {
  try {
    const now = new Date()
    const tz = await systemVarModel.getBusinessTimezone()

    const status = await workingHoursModel.getStatusInfo(now)
    const nextOpen = await workingHoursModel.getNextOpenDateTime(now)
    const todayEvent = await calendarModel.getTodayEvent()

    logger.info('')
    logger.info('📋 Configuration:')

    const dayName = workingHoursModel.getDayName(now.getDay())
    logger.info(`   Today: ${dayName}`)

    if (status.todayHours && status.todayHours.isWorkday) {
      logger.info(`   Hours: ${status.todayHours.openTime} - ${status.todayHours.closeTime}`)
      if (status.todayHours.breakStart && status.todayHours.breakEnd) {
        logger.info(`   Break: ${status.todayHours.breakStart} - ${status.todayHours.breakEnd}`)
      }
    } else {
      logger.info('   Hours: Closed (Non-working day)')
    }

    if (todayEvent) {
      logger.info(`   Calendar: ${todayEvent.title} (${todayEvent.type})`)
    }

    logger.info(`   Status: ${status.isOpen ? '✅ Open' : `🔒 Closed (${status.reason || 'unknown'})`}`)

    if (!status.isOpen && nextOpen) {
      logger.info(`   Next open: ${workingHoursModel.formatDateTime(nextOpen, tz)}`)
    }

    logger.info('')
    logger.info('🔧 Services Status:')

    const geminiApiKey = await configModel.get('gemini', 'api_key')
    const odooUrl = await configModel.get('odoo', 'url')
    const apisToken = await configModel.get('external_api', 'apis_token')

    logger.info(`   Gemini AI: ${geminiApiKey ? '✅ Configured' : '⚠️  Not configured'}`)
    if (!geminiApiKey) {
      logger.warn(`   🔧 Configure at /settings → category: gemini, key: api_key`)
    }

    logger.info(`   Odoo ERP: ${odooUrl ? '✅ Configured' : '⚠️  Not configured'}`)
    if (!odooUrl) {
      logger.warn(`   🔧 Configure at /settings → category: odoo, key: url`)
    }

    logger.info(`   APIs.net.pe: ${apisToken ? '✅ Configured' : '⚠️  Not configured'}`)
    if (!apisToken) {
      logger.warn(`   🔧 Configure at /settings → category: external_api, key: apis_token`)
    }

    const validation = await configModel.validateCritical()
    if (!validation.isValid) {
      logger.warn('')
      logger.warn('⚠️  Missing critical configurations:')
      validation.missing.forEach(item => logger.warn(`   ❌ ${item}`))
      logger.warn(`   Please visit: http://localhost:${process.env.WEB_PORT || 3000}/settings`)
    }

    const stats = await configModel.getStats()
    logger.info('')
    logger.info('📊 Configuration Stats:')
    logger.info(`   Total configs: ${stats.total}`)
    logger.info(`   Configured:    ${stats.configured}`)
    logger.info(`   Pending:       ${stats.pending}`)
    logger.info(`   Encrypted:     ${stats.encrypted}`)

    const departments = await departmentModel.getActive()
    logger.info('')
    logger.info('🏢 Active Departments:')
    if (departments.length > 0) {
      departments.forEach((dept: any) => {
        const contactCount = dept.contacts?.length || 0
        const keywordCount = dept.keywords?.length || 0
        logger.info(`   - ${dept.name} (${contactCount} contacts, ${keywordCount} keywords)`)
      })
    } else {
      logger.info('   No departments configured')
    }

    logger.info('')
  } catch (error) {
    logger.error({ err: error }, 'Error displaying config info:')
  }
}

function setupGracefulShutdown() {
  const shutdown = async (signal: string) => {
    logger.info(`\n${signal} received. Shutting down gracefully...`)

    try {
      // Limpiar intervalos
      if (global.__appIntervals && global.__appIntervals.length > 0) {
        logger.info(`🧹 Clearing ${global.__appIntervals.length} intervals...`)
        global.__appIntervals.forEach(clearInterval)
        global.__appIntervals = []
      }

      logger.info('Disconnecting WhatsApp...')
      await disconnectWhatsApp()

      logger.info('Disconnecting database...')
      await disconnectDatabase()

      // Resetear flag
      global.__appInitialized = false

      logger.info('✅ Shutdown complete')
      process.exit(0)
    } catch (error) {
      logger.error({ err: error }, 'Error during shutdown:')
      process.exit(1)
    }
  }

  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))

  process.on('uncaughtException', (error) => {
    logger.error({ err: error }, 'Uncaught Exception:')
    shutdown('uncaughtException')
  })

  process.on('unhandledRejection', (reason, promise) => {
    logger.error({ err: reason as any }, 'Unhandled Rejection at:', promise, 'reason:', reason)
  })
}

main()