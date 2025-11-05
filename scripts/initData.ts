// src/scripts/initData.ts
import { getPrismaClient } from '../config/database.js'
import { logger } from '../utils/logger.js'

import * as templateModel from '../models/template.js'
import * as autoResponseModel from '../models/autoResponse.js'

const prisma = getPrismaClient()

async function ensureTemplate(category: string, name: string, content: string, variables?: string[]) {
  const existing = await templateModel.getByCategory(category)
  const found = existing.find(t => (t.name || '').toLowerCase() === name.toLowerCase())
  if (found) {
    logger.info({ category, name }, '[SEED] Template exists — skipping')
    return found
  }

  const created = await templateModel.create({
    category,
    name,
    content,
    variables: variables ?? null,
    isActive: true,
  })
  logger.info({ category, name }, '[SEED] Template created')
  return created
}

async function ensureAutoResponse(
  trigger: string,
  response: string,
  priority = 1,
  category: string | null = null,
  isActive = true
) {
  const all = await autoResponseModel.getAll()
  const found = all.find(r => (r.trigger || '').trim().toLowerCase() === trigger.trim().toLowerCase())
  if (found) {
    logger.info({ trigger }, '[SEED] AutoResponse exists — skipping')
    return found
  }

  const created = await autoResponseModel.create({
    trigger,
    response,
    priority,
    category,
    isActive,
  })
  logger.info({ trigger }, '[SEED] AutoResponse created')
  return created
}

async function main() {
  logger.info('[SEED] Initializing templates & auto-responses…')

  // =========================
  // TEMPLATES
  // =========================
  await ensureTemplate(
    'MAIN_MENU',
    'DEFAULT',
    [
      '🙌 *¿En qué puedo ayudarte?*',
      '',
      'Elige una opción o escribe tu consulta:',
      '1️⃣ Servicio técnico',
      '2️⃣ Tóner / Insumos',
      '3️⃣ Asistencia remota',
      '4️⃣ Cambiar empresa',
    ].join('\n')
  )

  await ensureTemplate(
    'OUT_OF_HOURS',
    'DEFAULT',
    [
      '⏰ En este momento estamos *fuera de horario*.',
      '{{schedule_context}}',
      '',
      'Si tu caso es *URGENTE* podemos tomar nota, pero la atención humana se realizará en horario laboral.',
    ].join('\n'),
    ['schedule_context']
  )

  await ensureTemplate(
    'ESCALATE_HUMAN',
    'DEFAULT',
    [
      '⚠ Entendido. Voy a derivar tu caso a soporte humano. ',
      'Por favor cuéntame brevemente el problema para priorizarlo 🙏.',
      '',
      '☎ {{company_name}} {{company_phone}}',
    ].join('\n'),
    ['company_name', 'company_phone']
  )

  await ensureTemplate(
    'LINK_SERVICE',
    'DEFAULT',
    [
      '🧾 He generado tu {{policy_link_label}} para registrar servicio técnico:',
      '{{link}}',
      '',
      'Equipos vinculados: {{equipmentCount}}',
      '{{equipmentBrand}}{{equipmentModel}}{{equipmentSerial}}'
        ? 'Si corresponde: {{equipmentBrand}} {{equipmentModel}} (SN: {{equipmentSerial}})'
        : '',
    ].join('\n'),
    ['policy_link_label', 'link', 'equipmentCount', 'equipmentBrand', 'equipmentModel', 'equipmentSerial']
  )

  await ensureTemplate(
    'LINK_REMOTE',
    'DEFAULT',
    [
      '🖥️ Para soporte remoto usa *{{policy_remote_tool_name}}*:',
      '👉 {{link}}',
      '',
      'Un técnico humano se conectará en el horario de atención.',
    ].join('\n'),
    ['policy_remote_tool_name', 'link']
  )

  await ensureTemplate(
    'LINK_TONER',
    'DEFAULT',
    [
      '🛒 Solicitud de tóner/insumos registrada:',
      '👉 {{link}}',
      '',
      'Equipos vinculados: {{equipmentCount}}',
      '{{equipmentBrand}}{{equipmentModel}}{{equipmentSerial}}'
        ? 'Si corresponde: {{equipmentBrand}} {{equipmentModel}} (SN: {{equipmentSerial}})'
        : '',
    ].join('\n'),
    ['link', 'equipmentCount', 'equipmentBrand', 'equipmentModel', 'equipmentSerial']
  )

  await ensureTemplate(
    'REGISTRATION_PENDING',
    'DEFAULT',
    'Estoy validando tus datos, {{nombre}}. Ya casi terminamos el registro 👍.',
    ['nombre']
  )

  await ensureTemplate(
    'INTENT_REMOTE_GUIDE',
    'DEFAULT',
    [
      'Para *asistencia remota* usaremos {{policy_remote_tool_name}}.',
      'Si ya tienes tu ID, compártelo (9 dígitos). ',
      'Si no, ingresa al enlace y sigue las instrucciones.',
      'Si tienes capturas de pantalla del error, envíalas 📷.',
    ].join('\n'),
    ['policy_remote_tool_name']
  )

  await ensureTemplate(
    'INTENT_SERVICE_GUIDE',
    'DEFAULT',
    [
      'Parece un *caso de servicio técnico*. ',
      '¿Puedes detallar el problema (mensaje de error, atasco, modelo/serie)? ',
      'Te generaré un enlace para registrar el ticket.',
    ].join('\n')
  )

  await ensureTemplate(
    'INTENT_TONER_GUIDE',
    'DEFAULT',
    [
      'Perfecto, para *tóner/insumos* necesito *modelo o serie* y *color*. ',
      'Con eso genero el {{policy_link_label}}.',
    ].join('\n'),
    ['policy_link_label']
  )

  // =========================
  // AUTO-RESPUESTAS
  // =========================
  await ensureAutoResponse(
    'menu',
    [
      '📋 *Menú rápido*',
      '1️⃣ Servicio técnico',
      '2️⃣ Tóner / Insumos',
      '3️⃣ Asistencia remota',
      '4️⃣ Cambiar empresa',
      '',
      'También puedes escribir tu consulta libremente.',
    ].join('\n'),
    1,
    'MENU'
  )

  await ensureAutoResponse(
    '/^(hola|buenas\\s*(tardes|noches|dias?)|buen\\s*d[ií]a)/i',
    '¡Hola {{nombre}}! ¿En qué puedo ayudarte hoy? Si quieres ver opciones, escribe *menu*.',
    2,
    'SALUDO'
  )

  await ensureAutoResponse(
    'tóner,toner,cartucho,insumo',
    '¿Para qué equipo necesitas tóner/insumos? Dime *modelo o serie* y *color*. También puedo generar un enlace de pedido.',
    3,
    'TONER'
  )

  await ensureAutoResponse(
    'soporte,fallo,error,atasco,mantenimiento,no imprime,no jala,atascada',
    'Entendido. Cuéntame el *problema*, y si tienes *serie/modelo* mejor. Puedo crear el enlace para servicio técnico.',
    4,
    'SERVICIO'
  )

  await ensureAutoResponse(
    'remoto,asistencia remota,control remoto,conéctate,conectarse,conexión remota,anydesk',
    'Para soporte remoto, comparte tu *ID (9 dígitos)* o dime si necesitas el enlace de descarga.',
    5,
    'REMOTO'
  )

  await ensureAutoResponse(
    '/gracias|muchas gracias|listo|ok,? gracias/i',
    '¡Con gusto, {{nombre}}! Si luego necesitas algo más, escribe *menu* para ver opciones. 😊',
    10,
    'CIERRE'
  )

  logger.info('✅ Seed completed.')
}

main()
  .catch(err => {
    logger.error({ err }, '[SEED] Failed')
    process.exitCode = 1
  })
  .finally(async () => {
    try { await prisma.$disconnect() } catch {}
  })
