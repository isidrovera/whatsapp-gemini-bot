// src/services/gemini.ts

import { getGeminiModel } from '../config/gemini.js'
import { logger } from '../utils/logger.js'

import * as conversationModel from '../models/conversation.js'
import * as contactModel from '../models/contact.js'
import * as companyModel from '../models/company.js'
import * as configurationModel from '../models/configuration.js'
import * as departmentModel from '../models/department.js'
import * as productModel from '../models/product.js'
import * as workingHoursModel from '../models/workingHours.js'
import * as tagModel from '../models/tag.js'
import * as templateModel from '../models/template.js'
import * as autoResponseModel from '../models/autoResponse.js'
import * as calendarModel from '../models/calendar.js'

import * as odooService from './odoo.js'
import * as externalService from './external.js'

import { replaceVariables } from '../utils/formatters.js'

// ============================================================================
// TRACKER DE ENLACES
// ============================================================================
interface LinkTracking {
  phoneNumber: string
  lastLinkSentAt: Date
  lastLinkUrl: string
}
const linkTracker = new Map<string, LinkTracking>()
const LINK_COOLDOWN_MS = 5 * 60 * 1000 // 5 minutos

function shouldSendNewLink (phoneNumber: string, newUrl: string): boolean {
  const tracked = linkTracker.get(phoneNumber)
  if (!tracked) return true
  const now = Date.now()
  const elapsed = now - tracked.lastLinkSentAt.getTime()
  if (tracked.lastLinkUrl === newUrl && elapsed < LINK_COOLDOWN_MS) {
    logger.info(
      `[LINK-TRACKER] Skipping duplicate link for ${phoneNumber} (sent ${Math.round(
        elapsed / 1000
      )}s ago)`
    )
    return false
  }
  return true
}
function trackLinkSent (phoneNumber: string, url: string) {
  linkTracker.set(phoneNumber, {
    phoneNumber,
    lastLinkSentAt: new Date(),
    lastLinkUrl: url
  })
}

// ============================================================================
// MENÚ / HINT
// ============================================================================

// Antes aquí mostrabas todo el menú. Ahora SOLO mostramos el “si quieres ver el menú…”
function buildMenuHint (): string {
  return '\n\n Si quieres ver el *menú de opciones* escribe *menu* .'
}

function looksLikeMenuAnswer (text: string): boolean {
  if (!text) return false
  const lower = text.toLowerCase()
  const hasListNumbers =
    lower.includes('1') &&
    lower.includes('2') &&
    lower.includes('3') &&
    lower.includes('4')
  const hasKeywords =
    lower.includes('servicio técnico') ||
    lower.includes('tóner') ||
    lower.includes('asistencia remota') ||
    lower.includes('cambiar empresa')
  const isGreetingMenu =
    lower.includes('por favor elige una opción') ||
    lower.includes('por favor elige una opcion')
  return hasListNumbers && hasKeywords && isGreetingMenu
}

// ============================================================================
// HELPERS DE CONTEXTO (DINÁMICO)
// ============================================================================
async function buildUserContext (contact: any, phoneNumber: string) {
  const primaryData = contactModel.resolvePrimaryCompany(contact)

  const activeCompanyName =
    primaryData.companyName || contact.companyName || null
  const activeCompanyRUC = primaryData.ruc || contact.ruc || null

  let equipmentContext = 'El cliente NO tiene equipos registrados en el sistema.'
  let customerInfo: any = null

  if (activeCompanyName) {
    customerInfo = await odooService.getCustomerInfo(
      activeCompanyName,
      contact.name || 'Usuario',
      phoneNumber
    )
    if (customerInfo) {
      equipmentContext = odooService.formatEquipmentContext(customerInfo)
      logger.info(
        `[ODOO] Found ${customerInfo.equipment.length} equipment(s) for ${activeCompanyName}`
      )
    }
  }

  const userContext = `Nombre: ${contact.name || 'No proporcionado'}
Empresa activa: ${activeCompanyName || 'No proporcionada'}
RUC activo: ${activeCompanyRUC || 'No proporcionado'}
DNI: ${contact.dni || 'No proporcionado'}
Estado interno: ${contact.state || 'N/A'}

EQUIPOS REGISTRADOS EN EL SISTEMA:
${equipmentContext}
`

  return {
    userContext,
    customerInfo,
    activeCompanyName,
    activeCompanyRUC
  }
}

async function buildScheduleContext () {
  return workingHoursModel.getScheduleContextForAI()
}
async function buildDepartmentsContext () {
  return departmentModel.getDepartmentsContextForAI()
}
async function buildProductsContext () {
  return productModel.getProductsContextForAI()
}

/**
 * Calendario de los próximos días para que Gemini pueda contestar:
 * "mañana trabajan?", "el sábado?", "1 de noviembre?"
 */
async function buildFutureScheduleSnippet () {
  const today = new Date()
  const lines: string[] = []
  lines.push('CALENDARIO DE ATENCIÓN (próximos días desde BD):')

  for (let i = 0; i < 7; i++) {
    const d = new Date(today)
    d.setDate(d.getDate() + i)

    const status = await workingHoursModel.getStatusInfo(d)
    const dayName = workingHoursModel.getDayName(d.getDay())
    const isHoliday = await calendarModel.isHoliday(d)

    if (isHoliday) {
      const ev = (calendarModel as any).getEventByDate
        ? await (calendarModel as any).getEventByDate(d)
        : null
      lines.push(
        `• ${dayName} ${d.toISOString().slice(0, 10)}: NO ATIENDE (feriado/cierre) ${ev?.title ? `→ ${ev.title}` : ''}`
      )
      continue
    }

    if (!status.todayHours || !status.todayHours.isWorkday) {
      lines.push(
        `• ${dayName} ${d.toISOString().slice(0, 10)}: NO ATIENDE (no laboral)`
      )
      continue
    }

    const oh = status.todayHours
    const base = `• ${dayName} ${d.toISOString().slice(0, 10)}: ${oh.openTime} - ${oh.closeTime}`
    if (oh.breakStart && oh.breakEnd) {
      lines.push(`${base} (break ${oh.breakStart}-${oh.breakEnd})`)
    } else {
      lines.push(base)
    }
  }

  return lines.join('\n')
}

async function buildSystemPrompt (
  baseUserContext: string,
  departmentsContext: string,
  productsContext: string,
  scheduleContext: string,
  futureScheduleContext: string
) {
  const systemVars = await configurationModel.getForSystemVariables()

  let systemPromptTemplate =
    (await configurationModel.get('ai_prompt', 'system_prompt')) || ''

  if (!systemPromptTemplate || systemPromptTemplate.trim() === '') {
    systemPromptTemplate = `
Eres un asistente virtual profesional de {{company_name}}. RESPONDES SIEMPRE en español.

INFORMACIÓN DE LA EMPRESA:
{{company_name}}
{{company_address}}
Tel: {{company_phone}}

DEPARTAMENTOS (desde BD):
{{departments_context}}

CATÁLOGO (desde BD):
{{products_context}}

HORARIOS HOY:
{{schedule_context}}

HORARIOS PRÓXIMOS DÍAS:
{{future_schedule_context}}

USUARIO ACTUAL:
{{user_context}}

REGLAS:
- Si te preguntan horarios "mañana", "sábado", "feriado", "1 de noviembre", responde SOLO con lo que sale en HORARIOS y CALENDARIO.
- Si te preguntan por un área o interno, usa DEPARTAMENTOS.
- Si te preguntan por servicios, costos o insumos, usa CATÁLOGO.
- No inventes datos que no estén en estos bloques.
- Sé breve.
`
  }

  const systemPrompt = replaceVariables(systemPromptTemplate, {
    ...systemVars,
    departments_context: departmentsContext,
    products_context: productsContext,
    schedule_context: scheduleContext,
    future_schedule_context: futureScheduleContext,
    user_context: baseUserContext
  })

  return {
    systemPrompt,
    systemVars
  }
}

// ============================================================================
// INTENTS
// ============================================================================
function detectRemoteSupportIntent (
  messageText: string,
  hasMedia: boolean,
  anydeskCode: string | null,
  remoteToolName: string,
  mediaTypeClass: string | null
): boolean {
  const lower = (messageText || '').toLowerCase()

  if (anydeskCode && anydeskCode.trim() !== '') return true
  if (mediaTypeClass === 'anydesk') return true

  const remoteKeywords = [
    'asistencia remota',
    'control remoto',
    'soporte remoto',
    'conéctate',
    'conectarse',
    'conexión remota',
    remoteToolName.toLowerCase(),
    'puedes tomar control',
    'pueden ingresar',
    'pueden entrar'
  ]

  return remoteKeywords.some(k => lower.includes(k))
}

async function detectIntents (
  messageText: string,
  hasMedia: boolean,
  anydeskCode: string | null,
  remoteToolName: string,
  mediaTypeClass: string | null
) {
  const deptMatch = await departmentModel.detectDepartment(messageText)
  const productMatches = await productModel.searchByKeyword(messageText)

  const wantsRemote = detectRemoteSupportIntent(
    messageText,
    hasMedia,
    anydeskCode,
    remoteToolName,
    mediaTypeClass
  )

  const lower = messageText.toLowerCase()

  const wantsToner =
    lower.includes('tóner') ||
    lower.includes('toner') ||
    lower.includes('cartucho') ||
    lower.includes('insumo') ||
    (productMatches.length > 0 &&
      productMatches[0].product?.category?.toLowerCase?.().includes('tóner'))

  let wantsService =
    lower.includes('fall') ||
    lower.includes('soporte') ||
    lower.includes('mantenimiento') ||
    lower.includes('no imprime') ||
    lower.includes('atasco') ||
    lower.includes('atascada') ||
    lower.includes('no jala') ||
    lower.includes('error') ||
    (deptMatch?.department?.name || '').toLowerCase().includes('soporte')

  if (
    mediaTypeClass === 'error_screen' ||
    mediaTypeClass === 'hardware_damage' ||
    mediaTypeClass === 'video'
  ) {
    wantsService = true
  }

  return {
    deptMatch,
    productMatches,
    wantsRemote,
    wantsToner,
    wantsService
  }
}

// ============================================================================
// TEMPLATES
// ============================================================================
async function renderTemplateByCategory (
  category: string,
  vars: Record<string, string>
): Promise<string | null> {
  try {
    const list = await templateModel.getByCategory(category)
    if (!list || list.length === 0) return null
    const t = list[0]
    const raw = t.content || ''
    return templateModel.render(raw, vars)
  } catch (err) {
    logger.error('[TEMPLATE] Error rendering template:', err)
    return null
  }
}

async function buildLinkAttachmentMessage (
  category: string,
  linkUrl: string,
  customerInfo: any,
  systemVars: Record<string, string>,
  remoteToolName: string
): Promise<string | null> {
  if (!linkUrl) return null

  let equipmentBrand = ''
  let equipmentModel = ''
  let equipmentSerial = ''
  let equipmentCount = '0'

  if (customerInfo && Array.isArray(customerInfo.equipment)) {
    equipmentCount = String(customerInfo.equipment.length || 0)

    if (customerInfo.equipment.length === 1) {
      const eq = customerInfo.equipment[0]
      equipmentBrand = eq.brand || ''
      equipmentModel = eq.model || ''
      equipmentSerial = eq.serial || ''
    }
  }

  const vars = {
    link: linkUrl,
    equipmentBrand,
    equipmentModel,
    equipmentSerial,
    equipmentCount,
    policy_link_label: systemVars.policy_link_label || 'enlace del sistema',
    policy_remote_tool_name: remoteToolName || 'AnyDesk'
  }

  const rendered = await renderTemplateByCategory(category, vars)
  return rendered
}

async function buildEscalateHumanMessage (systemVars: Record<string, string>) {
  const rendered = await renderTemplateByCategory('ESCALATE_HUMAN', {
    company_name: systemVars.company_name || '',
    company_phone: systemVars.company_phone || ''
  })

  return (
    rendered ||
    '⚠ Entendido. Voy a derivar tu caso a soporte humano ahora mismo. Por favor dime brevemente qué está pasando para priorizarlo 🙏.'
  )
}

async function buildOutOfHoursNotice (scheduleContext: string) {
  const rendered = await renderTemplateByCategory('OUT_OF_HOURS', {
    schedule_context: scheduleContext
  })

  return (
    rendered ||
    `⏰ En este momento estamos fuera de horario. ${scheduleContext}\nSi tu caso es URGENTE responde *URGENTE* y te derivamos a soporte humano.`
  )
}

// ============================================================================
// TAG HUMANO
// ============================================================================
async function ensureHumanTag (phoneNumber: string) {
  let allTags = await tagModel.getAll()
  let humanTag = allTags.find(
    (t: any) => (t.name || '').toUpperCase() === 'HUMANO'
  )

  if (!humanTag) {
    humanTag = await tagModel.create({
      name: 'HUMANO',
      color: '#ff0000',
      description: 'Escalado a soporte humano urgente'
    })

    allTags = await tagModel.getAll()
  }

  const convTags = await tagModel.getByConversation(phoneNumber)
  const already = convTags.some(
    (t: any) => (t.name || '').toUpperCase() === 'HUMANO'
  )
  if (!already) {
    await tagModel.assignToConversation(phoneNumber, humanTag.id)
  }
}

// ============================================================================
// MAIN FLOW
// ============================================================================
export async function processMessage (
  phoneNumber: string,
  messageText: string,
  hasMedia: boolean = false,
  mediaAnalysisJson: string | null = null,
  anydeskCode: string | null = null,
  mediaTypeClass: string | null = null,
  detectedErrorCode: string | null = null,
  detectedSerial: string | null = null
): Promise<string> {
  try {
    logger.info(
      `Processing message for ${phoneNumber}: ${messageText.substring(
        0,
        80
      )}... ${hasMedia ? '[+MEDIA]' : ''}`
    )

    // 0. contacto
    let contact = await contactModel.findByPhone(phoneNumber)
    if (!contact) {
      contact = await contactModel.create(phoneNumber)
      logger.info(`New contact created: ${phoneNumber}`)
    }

    // 1. guardar mensaje user
    let contentToSave = messageText
    if (hasMedia && mediaAnalysisJson) {
      contentToSave += ` [MEDIA ANALYSIS: ${mediaAnalysisJson.substring(0, 180)}...]`
    }
    if (anydeskCode) {
      contentToSave += ` [ANYDESK: ${anydeskCode}]`
    }
    await conversationModel.save(phoneNumber, 'USER', contentToSave)

    // 2. estados de registro breves
    if (
      contact.state === 'NEW' ||
      contact.state === 'WAITING_DNI' ||
      contact.state === 'WAITING_RUC' ||
      contact.state === 'SELECTING_COMPANY'
    ) {
      const pendingMsg =
        (await renderTemplateByCategory('REGISTRATION_PENDING', {
          nombre: contact.name || 'Cliente'
        })) ||
        'Estoy validando tus datos para poder ayudarte 👍. Ya casi terminamos el registro.'
      await conversationModel.save(phoneNumber, 'ASSISTANT', pendingMsg)
      return pendingMsg
    }

    // 3. "URGENTE" fuera de horario
    const statusInfoEarly = await workingHoursModel.getStatusInfo(new Date())
    const isClosedEarly = !statusInfoEarly.isOpen
    const txtLower = messageText.trim().toLowerCase()
    const isEscalationKeyword =
      txtLower.includes('urgente') ||
      txtLower.includes('es urgente') ||
      txtLower.includes('emergencia')

    if (isClosedEarly && isEscalationKeyword) {
      await ensureHumanTag(phoneNumber)

      const { userContext } = await buildUserContext(contact, phoneNumber)
      const departmentsContext = await buildDepartmentsContext()
      const productsContext = await buildProductsContext()
      const scheduleContext = await buildScheduleContext()
      const futureScheduleContext = await buildFutureScheduleSnippet()

      const { systemVars } = await buildSystemPrompt(
        userContext,
        departmentsContext,
        productsContext,
        scheduleContext,
        futureScheduleContext
      )

      let humanEscalationMsg = await buildEscalateHumanMessage(systemVars)

      // aquí SÍ le pegamos el hint de menú, por si espera
      humanEscalationMsg += buildMenuHint()

      await conversationModel.save(
        phoneNumber,
        'ASSISTANT',
        humanEscalationMsg
      )
      return humanEscalationMsg
    }

    // 4. contexto dinámico
    const {
      userContext,
      customerInfo,
      activeCompanyName,
      activeCompanyRUC
    } = await buildUserContext(contact, phoneNumber)

    const departmentsContext = await buildDepartmentsContext()
    const productsContext = await buildProductsContext()
    const scheduleContext = await buildScheduleContext()
    const futureScheduleContext = await buildFutureScheduleSnippet()

    const { systemPrompt, systemVars } = await buildSystemPrompt(
      userContext,
      departmentsContext,
      productsContext,
      scheduleContext,
      futureScheduleContext
    )

    // 5. historial
    const recentHistory = await conversationModel.getHistory(phoneNumber, 10)
    const geminiHistory: any[] = []
    for (const msg of recentHistory) {
      if (msg.role === 'USER') {
        geminiHistory.push({ role: 'user', parts: [{ text: msg.content }] })
      } else if (msg.role === 'ASSISTANT') {
        geminiHistory.push({ role: 'model', parts: [{ text: msg.content }] })
      }
    }
    while (geminiHistory.length > 0 && geminiHistory[0].role !== 'user') {
      geminiHistory.shift()
    }
    const validatedHistory: any[] = []
    let lastRole: string | null = null
    for (const msg of geminiHistory) {
      if (lastRole === null || lastRole !== msg.role) {
        validatedHistory.push(msg)
        lastRole = msg.role
      }
    }

    // 6. tags activos
    const conversationTags = await tagModel.getByConversation(phoneNumber)
    const tagNames = conversationTags.map((t: any) =>
      (t.name || '').toUpperCase()
    )

    let forceHuman = false
    if (tagNames.includes('HUMANO')) {
      const takeoverAt = contact.humanTakeoverAt
      if (takeoverAt) {
        const elapsedMs = Date.now() - takeoverAt.getTime()
        if (elapsedMs < 60 * 60 * 1000) {
          forceHuman = true
        } else {
          logger.debug(
            `[HUMAN-GUARD] HUMANO tag present but humanTakeoverAt is stale (+${Math.round(
              elapsedMs / 1000
            )}s) → Gemini allowed`
          )
        }
      } else {
        logger.debug(
          '[HUMAN-GUARD] HUMANO tag present but no humanTakeoverAt → Gemini allowed'
        )
      }
    }

    logger.debug('[FLOW] forceHuman decision:', {
      forceHuman,
      hasHumanTag: tagNames.includes('HUMANO'),
      humanTakeoverAt: contact.humanTakeoverAt || null
    })

    // 7. intents
    const {
      deptMatch,
      productMatches,
      wantsRemote,
      wantsToner,
      wantsService
    } = await detectIntents(
      messageText,
      hasMedia,
      anydeskCode,
      systemVars.policy_remote_tool_name || 'AnyDesk',
      mediaTypeClass
    )

    // 8. autoResponse directa
    if (!forceHuman) {
      const autoResp = await autoResponseModel.findAndProcessResponse(
        messageText,
        {
          contact: {
            name: contact.name || null,
            dni: contact.dni || null,
            phoneNumber: phoneNumber,
            companyName: activeCompanyName || null,
            ruc: activeCompanyRUC || null
          },
          company: {
            razonSocial: activeCompanyName || null,
            numeroDoc: activeCompanyRUC || null,
            name: activeCompanyName || null,
            ruc: activeCompanyRUC || null
          },
          product:
            productMatches && productMatches[0]
              ? {
                  name: productMatches[0].product.name || '',
                  category: productMatches[0].product.category || '',
                  price: productMatches[0].product.price ?? null
                }
              : undefined
        }
      )

      if (autoResp) {
        // a la respuesta automática también le pegamos el hint
        const withHint = autoResp + buildMenuHint()
        await conversationModel.save(phoneNumber, 'ASSISTANT', withHint)
        return withHint
      }
    }

    // 9. mensaje enriquecido para el modelo
    let finalMessageToModel = messageText

    if (hasMedia && mediaAnalysisJson) {
      finalMessageToModel += `

[ANÁLISIS TÉCNICO DEL ARCHIVO QUE EL USUARIO ENVIÓ]
${mediaAnalysisJson}
`
    }

    if (detectedErrorCode) {
      finalMessageToModel += `

[CÓDIGO DE ERROR DETECTADO: ${detectedErrorCode}]
Explica en lenguaje simple lo que implica este tipo de error,
pregunta si el equipo está totalmente detenido o todavía imprime/escanea,
y ofrece ayuda para registrar servicio técnico en sitio.
NO prometas hora exacta.
`
    }

    if (detectedSerial) {
      finalMessageToModel += `

[NÚMERO DE SERIE DETECTADO DEL EQUIPO: ${detectedSerial}]
Inclúyelo en la respuesta para que el técnico identifique el equipo.
`
    }

    if (anydeskCode) {
      finalMessageToModel += `

[ID REMOTO (${systemVars.policy_remote_tool_name || 'AnyDesk'}) DETECTADO DEL USUARIO: ${anydeskCode}]
Inclúyelo una sola vez en la respuesta y ofrece conexión remota de un técnico humano 👨‍💻.
`
    }

    if (wantsRemote) {
      const remoteGuide =
        (await renderTemplateByCategory('INTENT_REMOTE_GUIDE', {
          policy_remote_tool_name:
            systemVars.policy_remote_tool_name || 'AnyDesk',
          policy_link_label:
            systemVars.policy_link_label || 'enlace del sistema'
        })) ||
        `El usuario solicita soporte remoto (${systemVars.policy_remote_tool_name ||
          'AnyDesk'}). Pídele su ID (9 dígitos) si no lo dio aún.`
      finalMessageToModel += `

[GUÍA - ASISTENCIA REMOTA]
${remoteGuide}
`
    }

    if (wantsService) {
      const serviceGuide =
        (await renderTemplateByCategory('INTENT_SERVICE_GUIDE', {
          policy_link_label:
            systemVars.policy_link_label || 'enlace del sistema'
        })) ||
        `El usuario reporta una falla física. Pídele más detalles y ofrece registrar servicio técnico.`
      finalMessageToModel += `

[GUÍA - SERVICIO TÉCNICO]
${serviceGuide}
`
    }

    if (wantsToner) {
      const tonerGuide =
        (await renderTemplateByCategory('INTENT_TONER_GUIDE', {
          policy_link_label:
            systemVars.policy_link_label || 'enlace del sistema'
        })) ||
        `El usuario solicita tóner / insumos. Pídele modelo/serie y color.`
      finalMessageToModel += `

[GUÍA - TÓNER / INSUMOS]
${tonerGuide}
`
    }

    if (!wantsRemote) {
      if (wantsService) {
        finalMessageToModel += `

[RESTRICCIÓN]
No pidas AnyDesk porque el usuario no lo pidió. Prioriza visita / registro de servicio.
`
      } else {
        finalMessageToModel += `

[RESTRICCIÓN]
No pidas AnyDesk si el usuario no lo pide.
`
      }
    } else {
      finalMessageToModel += `

[RESTRICCIÓN]
El usuario SÍ pide remoto. Pide o confirma el ID UNA sola vez.
`
    }

    // 10. forzar humano
    if (forceHuman) {
      let humanMsg = await buildEscalateHumanMessage(systemVars)
      humanMsg += buildMenuHint()
      await conversationModel.save(phoneNumber, 'ASSISTANT', humanMsg)
      return humanMsg
    }

    // 11. Llamar a Gemini
    const model = await getGeminiModel()
    const chat = model.startChat({
      history: validatedHistory,
      systemInstruction: {
        role: 'system',
        parts: [{ text: systemPrompt }]
      }
    })

    logger.info(
      `[GEMINI] Sending enriched message (${finalMessageToModel.length} chars)`
    )
    const result = await chat.sendMessage(finalMessageToModel)
    let response = result.response.text() || ''

    logger.info(
      `[GEMINI] Initial response: ${response.substring(0, 160)}...`
    )

    // 12. enlaces / odoo
    const needsLink = wantsRemote || wantsService || wantsToner

    if (needsLink && activeCompanyName && customerInfo) {
      const equipmentId =
        customerInfo.equipment && customerInfo.equipment.length === 1
          ? customerInfo.equipment[0].id
          : undefined

      const serviceUrl = await odooService.getOdooServiceLink(
        activeCompanyName,
        contact.name || 'Usuario',
        phoneNumber,
        equipmentId
      )

      if (serviceUrl && shouldSendNewLink(phoneNumber, serviceUrl)) {
        let linkCategory = 'LINK_SERVICE'
        if (wantsRemote) linkCategory = 'LINK_REMOTE'
        else if (wantsToner) linkCategory = 'LINK_TONER'

        const linkMsg = await buildLinkAttachmentMessage(
          linkCategory,
          serviceUrl,
          customerInfo,
          systemVars,
          systemVars.policy_remote_tool_name || 'AnyDesk'
        )

        if (linkMsg) {
          response += `\n\n${linkMsg}`
        }

        trackLinkSent(phoneNumber, serviceUrl)
        logger.info(
          `[GEMINI] Link added with equipment context (${customerInfo.equipment?.length || 0} equipment(s))`
        )
      } else if (serviceUrl) {
        logger.info('[GEMINI] Link skipped (recently sent)')
      } else {
        logger.warn('[GEMINI] Could not obtain link from Odoo')
      }
    } else if (needsLink && !customerInfo) {
      if (wantsRemote) {
        const remoteFallback =
          (await renderTemplateByCategory(
            'REMOTE_FALLBACK_NO_CUSTOMER',
            {
              policy_remote_tool_name:
                systemVars.policy_remote_tool_name || 'AnyDesk'
            }
          )) ||
          `Por favor envíame tu ID de ${systemVars.policy_remote_tool_name ||
            'AnyDesk'} (9 dígitos) o una foto clara de tu pantalla 🧑‍💻.`
        response += `\n\n${remoteFallback}`
      } else {
        const genericFallback =
          (await renderTemplateByCategory(
            'SERVICE_FALLBACK_NO_CUSTOMER',
            {
              policy_link_label:
                systemVars.policy_link_label || 'enlace del sistema'
            }
          )) ||
          `Necesito validar tu empresa registrada para poder generar el ${systemVars.policy_link_label ||
            'enlace del sistema'}. ¿Me confirmas razón social o RUC?`
        response += `\n\n${genericFallback}`
      }
    }

    // nota fuera de horario
    const statusInfo = await workingHoursModel.getStatusInfo(new Date())
    if (!statusInfo.isOpen) {
      const outOfHours = await buildOutOfHoursNotice(scheduleContext)
      if (outOfHours) {
        response += `\n\n${outOfHours}`
      }
    }

    // si Gemini básicamente mandó el menú, no pegamos nada
    if (!looksLikeMenuAnswer(response)) {
      response += buildMenuHint()
    }

    // 13. guardar
    await conversationModel.save(phoneNumber, 'ASSISTANT', response)

    return response
  } catch (error) {
    logger.error('[GEMINI] Error:', error)
    return 'Lo siento, estoy teniendo problemas para procesar tu mensaje. ¿Podrías intentarlo de nuevo?'
  }
}
