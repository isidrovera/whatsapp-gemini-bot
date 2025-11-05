// scripts/initData.ts
import 'dotenv/config'
import { logger } from '../src/utils/logger.js'

import * as configuration from '../src/models/configuration.js'
import * as autoResponseModel from '../src/models/autoResponse.js'
import * as templateModel from '../src/models/template.js'
import * as tagModel from '../src/models/tag.js'

async function ensureTemplatesInConfiguration() {
  logger.info('Seeding: templates en configuration (main_menu / after_hours / break / holiday)...')

  // MAIN MENU (dinámico, se puede editar desde panel)
  const existingMain = await configuration.get('templates', 'main_menu')
  if (!existingMain) {
    const value =
`👋 Hola {{customer_name}}{{#company_name}} ({{company_name}}){{/company_name}}

Por favor elige una opción:
1️⃣ Solicitud de *servicio técnico en sitio*
2️⃣ Solicitud de *tóner / suministros*
3️⃣ *Asistencia remota* ({{policy_remote_tool_name}})
4️⃣ *Cambiar empresa activa*
5️⃣ Hablar con un *Técnico*

📝 Escribe el número de la opción, o escribe *menu* para volver aquí.`
      .replace('{{policy_remote_tool_name}}', '{{policy_remote_tool_name}}') // mantener variable
    await configuration.set('templates', 'main_menu', value, false)
    logger.info('✔ templates.main_menu creado')
  } else {
    logger.info('↪ templates.main_menu ya existe (OK)')
  }

  // AFTER HOURS
  const existingAfter = await configuration.get('templates', 'after_hours_message')
  if (!existingAfter) {
    await configuration.set(
      'templates',
      'after_hours_message',
      '⏰ {{reason}}.\n🕒 Hoy: {{open}}–{{close}}{{break_hint}}\n{{next_open_line}}\n\nSi tu caso es *URGENTE*, responde *URGENTE* y te derivamos a soporte.',
      false
    )
    logger.info('✔ templates.after_hours_message creado')
  } else {
    logger.info('↪ templates.after_hours_message ya existe (OK)')
  }

  // BREAK
  const existingBreak = await configuration.get('templates', 'break_message')
  if (!existingBreak) {
    await configuration.set(
      'templates',
      'break_message',
      '⏰ Estamos en horario de refrigerio ({{break_start}}–{{break_end}}). Retomamos a las {{break_end}}.\n{{next_open_line}}',
      false
    )
    logger.info('✔ templates.break_message creado')
  } else {
    logger.info('↪ templates.break_message ya existe (OK)')
  }

  // HOLIDAY
  const existingHoliday = await configuration.get('templates', 'holiday_message')
  if (!existingHoliday) {
    await configuration.set(
      'templates',
      'holiday_message',
      '⛱️ Hoy es {{event_type}}: {{event_title}}. Por ello, no tenemos atención hoy.\n{{next_open_line}}',
      false
    )
    logger.info('✔ templates.holiday_message creado')
  } else {
    logger.info('↪ templates.holiday_message ya existe (OK)')
  }
}

async function ensureSystemPrompt() {
  logger.info('Seeding: ai_prompt.system_prompt (si falta)...')
  const existing = await configuration.get('ai_prompt', 'system_prompt')
  if (!existing) {
    const prompt =
`Eres un asistente virtual profesional de {{company_name}}. Respondes SIEMPRE en español.
Usa la información de configuración, políticas y contexto de usuario.
No inventes datos. Sé breve y útil. Ofrece escribir "menu" para ver opciones cuando corresponda.`
    await configuration.set('ai_prompt', 'system_prompt', prompt, false)
    logger.info('✔ ai_prompt.system_prompt creado')
  } else {
    logger.info('↪ ai_prompt.system_prompt ya existe (OK)')
  }
}

async function ensurePolicyDefaults() {
  logger.info('Seeding: policy defaults (si faltan)...')

  const ensure = async (key: string, value: string) => {
    const v = await configuration.get('policy', key)
    if (!v) {
      await configuration.set('policy', key, value, false)
      logger.info(`✔ policy.${key} creado`)
    } else {
      logger.info(`↪ policy.${key} ya existe (OK)`)
    }
  }

  await ensure('link_label', 'enlace del sistema')
  await ensure('remote_tool_name', 'AnyDesk')
  await ensure('tone_style', 'profesional_cercano_con_emojis')
  await ensure('allow_direct_phone_share', 'true')
  await ensure('allow_field_visit_commitment', 'false')
}

async function ensureHumanTag() {
  logger.info('Seeding: tag HUMANO (si falta)...')
  const all = await tagModel.getAll()
  const exists = all.some((t: any) => (t.name || '').toUpperCase() === 'HUMANO')
  if (!exists) {
    await tagModel.create({
      name: 'HUMANO',
      color: '#ff0000',
      description: 'Escalado a soporte humano urgente',
    })
    logger.info('✔ Tag HUMANO creado')
  } else {
    logger.info('↪ Tag HUMANO ya existe (OK)')
  }
}

async function ensureAutoResponses() {
  logger.info('Seeding: auto-responses básicas (si faltan)...')
  const existing = await autoResponseModel.getAll()
  const hasTrigger = (t: string) =>
    existing.some(r => (r.trigger || '').trim().toLowerCase() === t.trim().toLowerCase())

  const candidates = [
    {
      trigger: 'menu',
      response:
        'Aquí tienes el menú principal 👇\n\n{{templates.main_menu || "Escribe *1*, *2*, *3*, *4* o *5*"}}',
      priority: 1,
      category: 'core',
    },
    {
      trigger: 'hola,buenas,hi,buenos días,buenas tardes,buenas noches',
      response:
        '¡Hola! 👋 ¿En qué puedo ayudarte hoy?\n\nSi quieres ver las opciones disponibles, escribe *menu*.',
      priority: 2,
      category: 'saludo',
    },
    {
      trigger: 'gracias,muchas gracias,grac',
      response:
        '¡Con gusto! 🙌 Si necesitas algo más, escribe *menu* para ver opciones.',
      priority: 3,
      category: 'cortesia',
    },
    {
      trigger: 'ayuda,opciones,que puedo hacer',
      response:
        'Puedo ayudarte con soporte, tóner y asistencia remota. Escribe *menu* para ver el listado.',
      priority: 4,
      category: 'ayuda',
    },
  ]

  for (const c of candidates) {
    if (!hasTrigger(c.trigger)) {
      await autoResponseModel.create({
        trigger: c.trigger,
        response: c.response,
        priority: c.priority,
        category: c.category,
        isActive: true,
      })
      logger.info(`✔ Auto-response creada: "${c.trigger}"`)
    } else {
      logger.info(`↪ Auto-response ya existe: "${c.trigger}" (OK)`)
    }
  }
}

async function ensureMessageTemplatesTableHasExamples() {
  // Opcional: ejemplos en tabla messageTemplate (por si la usas además del configuration)
  logger.info('Seeding: ejemplos mínimos en messageTemplate (opcional)...')

  const ensureTemplate = async (category: string, name: string, content: string) => {
    const list = await templateModel.getByCategory(category)
    const found = list.find(t => t.name === name)
    if (!found) {
      await templateModel.create({ category, name, content, isActive: true })
      logger.info(`✔ messageTemplate: ${category}/${name} creado`)
    } else {
      logger.info(`↪ messageTemplate: ${category}/${name} ya existe (OK)`)
    }
  }

  await ensureTemplate(
    'templates',
    'urgent_human_message',
    '⚠ Entendido. Estoy derivando tu caso a soporte humano ahora mismo. Un técnico te responderá en breve.'
  )

  await ensureTemplate(
    'menu',
    'main_menu',
    'Este es un ejemplo alternativo de menú en messageTemplate (edítalo si decides usar esta fuente).'
  )
}

async function main() {
  logger.info('==== initData.ts: bootstrap inicial ====')

  // 1) Defaults de configuration (incluye categorias clave, pero no fuerza valores encriptados)
  await configuration.initDefaults()

  // 2) Plantillas base en configuration (main_menu/after_hours/break/holiday)
  await ensureTemplatesInConfiguration()

  // 3) System prompt base
  await ensureSystemPrompt()

  // 4) Políticas por defecto (si faltan)
  await ensurePolicyDefaults()

  // 5) Tag HUMANO
  await ensureHumanTag()

  // 6) Auto-respuestas básicas
  await ensureAutoResponses()

  // 7) Ejemplos en messageTemplate (opcional)
  await ensureMessageTemplatesTableHasExamples()

  // 8) Validación crítica (por ejemplo, Gemini API Key)
  const critical = await configuration.validateCritical()
  if (!critical.isValid) {
    logger.warn({ missing: critical.missing }, '⚠ Faltan configuraciones críticas')
  } else {
    logger.info('✔ Configuraciones críticas OK')
  }

  logger.info('✅ initData.ts finalizado')
}

main().catch(err => {
  logger.error({ err }, 'initData.ts failed')
  process.exit(1)
})
