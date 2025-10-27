// src/index.ts
import { logger } from './utils/logger.js'
import { getPrismaClient, disconnectDatabase } from './config/database.js'
import { initializeWhatsApp, disconnect as disconnectWhatsApp, getConnectionStatus } from './services/whatsapp.js'
import { startWebServer } from './web/server.js'

import * as systemVarModel from './models/systemVar.js'
import * as conversationModel from './models/conversation.js'
import * as adminModel from './models/admin.js'
import * as workingHoursModel from './models/workingHours.js'
import * as calendarModel from './models/calendar.js'             // 🆕 para mostrar evento de hoy
import * as holidaySync from './services/holidaySync.js'          // 🆕 sincronización de feriados

// 🆕 NUEVOS MODELOS / SERVICIOS DE NEGOCIO
import * as configModel from './models/configuration.js'          // claves de configuración unificadas
import * as departmentModel from './models/department.js'         // departamentos (routing)
import { initializeGemini } from './config/gemini.js'             // inicialización de Gemini
import { initializeOdoo } from './services/odoo.js'               // inicialización de Odoo

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

    // 3) 🆕 Inicializar configuraciones unificadas
    logger.info('⚙️  Initializing configurations...')
    await configModel.initDefaults()
    logger.info('✅ Configurations initialized')

    // 4) Variables de sistema (legacy / compat)
    logger.info('⚙️  Initializing system variables...')
    await systemVarModel.initDefaults()
    logger.info('✅ System variables initialized')

    // 5) Horarios de trabajo
    logger.info('⏰ Initializing working hours...')
    await workingHoursModel.initDefaults()
    logger.info('✅ Working hours initialized')

    // 6) 🆕 Departamentos
    logger.info('🏢 Initializing departments...')
    await departmentModel.initDefaults()
    logger.info('✅ Departments initialized')

    // 7) 🗓️ Sincronización de feriados (no bloqueante si falla)
    try {
      logger.info('🗓️ Syncing public holidays...')
      await holidaySync.syncPublicHolidays()
      logger.info('✅ Public holidays synced')
    } catch (e) {
      logger.warn('⚠️ Holiday sync failed (non-blocking):', e)
    }

    // (Opcional) Re-sincronizar cada mes
    // setInterval(() => holidaySync.syncPublicHolidays().catch(() => {}), 1000 * 60 * 60 * 24 * 30)

    // 8) 🆕 Gemini
    logger.info('🤖 Initializing Gemini AI...')
    try {
      await initializeGemini()
      logger.info('✅ Gemini AI initialized')
    } catch (error) {
      logger.warn('⚠️  Gemini initialization failed. Configure API key in Settings.')
      logger.warn(`   Visit: http://localhost:${process.env.WEB_PORT || 3000}/settings`)
    }

    // 9) 🆕 Odoo
    logger.info('🏢 Initializing Odoo ERP...')
    try {
      await initializeOdoo()
      logger.info('✅ Odoo ERP initialized')
    } catch (error) {
      logger.warn('⚠️  Odoo initialization failed. Configure credentials in Settings.')
    }

    // 10) Limpiar conversaciones antiguas (>30 días)
    logger.info('🧹 Cleaning old conversations...')
    const deletedCount = await conversationModel.deleteOld(30)
    logger.info(`✅ Deleted ${deletedCount} old conversations`)

    // 11) WhatsApp
    logger.info('📱 Initializing WhatsApp client...')
    await initializeWhatsApp()

    // Esperar conexión
    let attempts = 0
    while (!getConnectionStatus() && attempts < 60) {
      await new Promise((resolve) => setTimeout(resolve, 1000))
      attempts++
    }

    if (getConnectionStatus()) {
      logger.info('✅ WhatsApp client ready')
    } else {
      logger.warn('⚠️  WhatsApp client initialized but not connected yet')
      logger.warn('   Please scan the QR code at: http://localhost:3000/auth/qr')
    }

    // 12) Web
    logger.info('🌐 Starting web admin panel...')
    startWebServer()

    // 13) Info final
    logger.info('='.repeat(50))
    logger.info('🤖 Bot is running and ready to receive messages!')
    logger.info('📱 WhatsApp: ' + (getConnectionStatus() ? 'Connected ✅' : 'Waiting for QR scan ⏳'))
    logger.info(`🌐 Web Panel: http://localhost:${process.env.WEB_PORT || 3000}`)
    logger.info(`🔐 Login: http://localhost:${process.env.WEB_PORT || 3000}/auth/login`)
    logger.info(`⚙️  Settings: http://localhost:${process.env.WEB_PORT || 3000}/settings`)
    logger.info('='.repeat(50))

    // 14) Mostrar configuración útil (estado de atención + servicios + stats)
    await displayConfigInfo()

    // 15) Señales de terminación
    setupGracefulShutdown()

  } catch (error) {
    logger.error('❌ Fatal error starting bot:', error)
    process.exit(1)
  }
}

// 🆕 Mostrar estado de horarios/feriados, servicios y datos de negocio
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

    logger.info(`   Status: ${status.isOpen ? '✅ Open' : '🔒 Closed'}`)

    if (!status.isOpen && nextOpen) {
      logger.info(`   Next open: ${workingHoursModel.formatDateTime(nextOpen, tz)}`)
    }

    // ======= NUEVO: Estado de servicios y validaciones =======
    logger.info('')
    logger.info('🔧 Services Status:')

    const geminiApiKey = await configModel.get('gemini', 'api_key')
    const odooUrl = await configModel.get('odoo', 'url')
    const apisToken = await configModel.get('external_api', 'apis_token')

    logger.info(`   Gemini AI: ${geminiApiKey ? '✅ Configured' : '⚠️  Not configured'}`)
    logger.info(`   Odoo ERP: ${odooUrl ? '✅ Configured' : '⚠️  Not configured'}`)
    logger.info(`   APIs.net.pe: ${apisToken ? '✅ Configured' : '⚠️  Not configured'}`)

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
    logger.info(`   Configured: ${stats.configured}`)
    logger.info(`   Pending: ${stats.pending}`)
    logger.info(`   Encrypted: ${stats.encrypted}`)

    // ======= NUEVO: Departamentos activos =======
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
    logger.error('Error displaying config info:', error)
  }
}

function setupGracefulShutdown() {
  const shutdown = async (signal: string) => {
    logger.info(`\n${signal} received. Shutting down gracefully...`)

    try {
      // WhatsApp
      logger.info('Disconnecting WhatsApp...')
      await disconnectWhatsApp()

      // DB
      logger.info('Disconnecting database...')
      await disconnectDatabase()

      logger.info('✅ Shutdown complete')
      process.exit(0)
    } catch (error) {
      logger.error('Error during shutdown:', error)
      process.exit(1)
    }
  }

  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))

  process.on('uncaughtException', (error) => {
    logger.error('Uncaught Exception:', error)
    shutdown('uncaughtException')
  })

  process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled Rejection at:', promise, 'reason:', reason)
  })
}

// Iniciar bot
main()
