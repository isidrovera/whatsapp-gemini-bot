// src/services/gemini.ts
import { getGeminiModel } from '../config/gemini.js'
import { logger } from '../utils/logger.js'

import * as conversationModel from '../models/conversation.js'
import * as contactModel from '../models/contact.js'
import * as configurationModel from '../models/configuration.js'
import * as departmentModel from '../models/department.js'
import * as productModel from '../models/product.js'
import * as workingHoursModel from '../models/workingHours.js'
import * as templateModel from '../models/template.js'
import * as autoResponseModel from '../models/autoResponse.js'
import * as calendarModel from '../models/calendar.js'

import * as odooService from './odoo.js'

import { replaceVariables } from '../utils/formatters.js'

/* ========================================================================== */
/*  TIPOS BÁSICOS                                                             */
/* ========================================================================== */
type ContactLike = {
  id: string
  name: string | null
  dni: string | null
  phoneNumber: string
  billysId: string | null
  ruc?: string | null
  companyName?: string | null
  state: string
  isBlocked: boolean
  humanTakeoverAt: Date | null
  nextAction?: string | null
  companies?: any[]
}

/* ========================================================================== */
/*  TRACKER LINKS (cooldown)                                                  */
/* ========================================================================== */
interface LinkTracking {
  phoneNumber: string
  lastLinkSentAt: Date
  lastLinkUrl: string
}
const linkTracker = new Map<string, LinkTracking>()
const LINK_COOLDOWN_MS = 5 * 60 * 1000 // 5 min

function shouldSendNewLink (phoneNumber: string, newUrl: string): boolean {
  const tracked = linkTracker.get(phoneNumber)
  if (!tracked) return true
  const now = Date.now()
  const elapsed = now - tracked.lastLinkSentAt.getTime()
  if (tracked.lastLinkUrl === newUrl && elapsed < LINK_COOLDOWN_MS) {
    logger.info(
      { phoneNumber, elapsedSec: Math.round(elapsed / 1000), url: newUrl },
      '[LINK-TRACKER] Skipping duplicate link'
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

/* ========================================================================== */
/*  HINT MENÚ (centralizado + dedupe)                                         */
/* ========================================================================== */
const DEFAULT_MENU_HINT = '\n\nSi quieres ver el *menú de opciones*, escribe *menu*.'

async function getMenuHintText (): Promise<string> {
  // Permite personalizar desde configuration
  const custom = await configurationModel.get('templates', 'menu_hint')
  return (custom && custom.trim()) || DEFAULT_MENU_HINT
}

function looksLikeMenuFull (text: string): boolean {
  if (!text) return false
  const lower = text.toLowerCase()
  const hasListNumbers = lower.includes('1') && lower.includes('2')
  const hasKeywords =
    lower.includes('servicio') ||
    lower.includes('tóner') ||
    lower.includes('asistencia remota') ||
    lower.includes('empresa') ||
    lower.includes('técnico')
  const greeting =
    lower.includes('por favor elige') ||
    lower.includes('elige una opción') ||
    lower.includes('elige una opcion')
  return hasListNumbers && hasKeywords && greeting
}

function alreadyHasHint (text: string, hint: string): boolean {
  if (!text) return false
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase()
  return norm(text).includes(norm(hint))
}

/* ========================================================================== */
/*  CONTEXTO DINÁMICO PARA EL MODELO                                          */
/* ========================================================================== */
async function buildUserContext (contact: ContactLike, phoneNumber: string) {
  const primary = contactModel.resolvePrimaryCompany(contact as any)
  const activeCompanyName = primary.companyName || contact.companyName || null
  const activeCompanyRUC = primary.ruc || contact.ruc || null

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
        {
          company: activeCompanyName,
          equipments: customerInfo.equipment?.length || 0
        },
        '[ODOO] Customer equipment found'
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
  return { userContext, customerInfo, activeCompanyName, activeCompanyRUC }
}

async function buildScheduleContext () {
  return workingHoursModel.getScheduleContextForAI?.() ||
         (await (await import('../models/systemVar.js')).getScheduleContext?.()) ||
         '' // fallback si no existe helper
}

async function buildDepartmentsContext () {
  return departmentModel.getDepartmentsContextForAI?.() ||
         (await (await import('../models/systemVar.js')).getDepartmentsContext?.()) ||
         ''
}

async function buildProductsContext () {
  return productModel.getProductsContextForAI?.() ||
         (await (await import('../models/systemVar.js')).getProductsContext?.()) ||
         ''
}

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
      lines.push(`• ${dayName} ${d.toISOString().slice(0, 10)}: NO ATIENDE (no laboral)`)
      continue
    }

    const oh = status.todayHours
    const base = `• ${dayName} ${d.toISOString().slice(0, 10)}: ${oh.openTime} - ${oh.closeTime}`
    if (oh.breakStart && oh.breakEnd) lines.push(`${base} (break ${oh.breakStart}-${oh.breakEnd})`)
    else lines.push(base)
  }

  return lines.join('\n')
}

async function getSystemPrompt (
  baseUserContext: string,
  departmentsContext: string,
  productsContext: string,
  scheduleContext: string,
  futureScheduleContext: string
) {
  const systemVars = await configurationModel.getForSystemVariables?.() || {}

  let tpl = await configurationModel.get('ai_prompt', 'system_prompt')
  if (!tpl || !tpl.trim()) {
    tpl = `
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
- Si te preguntan horarios "mañana", "sábado", "feriado", responde SOLO con lo que sale en HORARIOS/CALENDARIO.
- Si te preguntan por un área o interno, usa DEPARTAMENTOS.
- Si te preguntan por servicios/insumos, usa CATÁLOGO.
- No inventes datos que no estén en estos bloques.
- Sé breve.
`.trim()
  }

  const systemPrompt = replaceVariables(tpl, {
    ...systemVars,
    departments_context: departmentsContext,
    products_context: productsContext,
    schedule_context: scheduleContext,
    future_schedule_context: futureScheduleContext,
    user_context: baseUserContext
  })

  return { systemPrompt, systemVars }
}

/* ========================================================================== */
/*  INTENTOS (señales suaves+heurísticas)                                      */
/* ========================================================================== */
function looksLikeThanks (text: string): boolean {
  const lower = (text || '').toLowerCase()
  return /(gracias|muchas gracias|mil gracias|te agradezco|thank)/i.test(lower)
}

function wantsToner (text: string): boolean {
  const lower = (text || '').toLowerCase()
  return /t[oó]ner|cartucho|insumo/i.test(lower)
}

function wantsService (text: string): boolean {
  const lower = (text || '').toLowerCase()
  return /(fall|soporte|mantenimiento|no imprime|atasc|no jala|error|repar)/i.test(lower)
}

function wantsRemote (text: string): boolean {
  const lower = (text || '').toLowerCase()
  return /(asistencia remota|control remoto|soporte remoto|anydesk|teamviewer|con[eé]ctate)/i.test(lower)
}

/* ========================================================================== */
/*  PLANTILLAS (helpers)                                                       */
/* ========================================================================== */
async function renderTemplateByCategoryName (
  category: string,
  name: string,
  vars: Record<string,string>
): Promise<string | null> {
  try {
    const list = await templateModel.getByCategory(category)
    const t = list.find(x => (x.name || '').toLowerCase() === name.toLowerCase())
    const raw = t?.content || ''
    if (!raw) return null
    return templateModel.render(raw, vars)
  } catch (err) {
    logger.error({ err, category, name }, '[TEMPLATE] renderTemplateByCategoryName error')
    return null
  }
}

/* ========================================================================== */
/*  POLÍTICA FUERA DE HORARIO (NO HUMANO)                                      */
/* ========================================================================== */
async function buildOutOfHoursNotice (scheduleContext: string) {
  // Si existe plantilla OUT_OF_HOURS la usamos, si no fallback corto:
  const rendered = await renderTemplateByCategoryName('templates', 'OUT_OF_HOURS', {
    schedule_context: scheduleContext
  })
  return rendered || `⏰ En este momento estamos fuera de horario.\n${scheduleContext}\nPuedes registrar tu solicitud y la atenderemos al abrir.`
}

/* ========================================================================== */
/*  MENSAJE DE DESPEDIDA (agradecimiento)                                      */
/* ========================================================================== */
async function buildFarewell (systemVars: Record<string,string>) {
  const rendered = await renderTemplateByCategoryName('templates', 'farewell', {
    company_name: systemVars.company_name || '',
    company_phone: systemVars.company_phone || ''
  })
  return rendered || '¡Gracias a ti! 😊 Si necesitas algo más, aquí estaré.'
}

/* ========================================================================== */
/*  PROCESADOR PRINCIPAL                                                       */
/* ========================================================================== */
export async function processMessage (
  phoneNumber: string,
  messageText: string,
  hasMedia: boolean = false,
  mediaAnalysisJson: string | null = null,
  anydeskCode: string | null = null,
  // opcionales para futuras extensiones (compat hacia atrás):
  mediaTypeClass: string | null = null,
  detectedErrorCode: string | null = null,
  detectedSerial: string | null = null
): Promise<string> {
  try {
    logger.info(
      { phoneNumber, preview: (messageText||'').substring(0, 120), hasMedia },
      '[GEMINI] Processing'
    )

    // 0) contacto asegurado
    let found = await contactModel.findByPhone(phoneNumber)
    if (!found) {
      const created = await contactModel.create(phoneNumber)
      found = created as any
    }
    const contact: ContactLike = found as ContactLike

    // 1) guardar mensaje del usuario (+resumen de media si aplica)
    let contentToSave = messageText || ''
    if (hasMedia && mediaAnalysisJson) {
      contentToSave += ` [MEDIA ANALYSIS: ${mediaAnalysisJson.substring(0, 200)}...]`
    }
    if (anydeskCode) contentToSave += ` [ANYDESK: ${anydeskCode}]`
    await conversationModel.save(phoneNumber, 'USER', contentToSave)

    // 2) Si el contacto está en flujo FIJO (registro), Gemini NO decide
    if (
      contact.state === 'NEW' ||
      contact.state === 'WAITING_DNI' ||
      contact.state === 'WAITING_RUC' ||
      contact.state === 'SELECTING_COMPANY'
    ) {
      // Plantilla breve de “registro en curso”
      const pending =
        (await renderTemplateByCategoryName('templates', 'REGISTRATION_PENDING', {
          nombre: contact.name || 'Cliente'
        })) ||
        'Estoy validando tus datos para poder ayudarte 👍. Ya casi terminamos el registro.'
      await conversationModel.save(phoneNumber, 'ASSISTANT', pending)
      return pending
    }

    // 3) contexto dinámico
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
    const { systemPrompt, systemVars } = await getSystemPrompt(
      userContext,
      departmentsContext,
      productsContext,
      scheduleContext,
      futureScheduleContext
    )

    // 4) estado de negocio (NUNCA humano fuera de horario)
    const statusInfo = await workingHoursModel.getStatusInfo(new Date())
    const isOpen = !!statusInfo?.isOpen

    // 5) señales de intención rápidas
    const txt = (messageText || '').trim()
    const isThanks = looksLikeThanks(txt)
    const signalToner = wantsToner(txt)
    const signalService = wantsService(txt)
    const signalRemote = wantsRemote(txt)

    // 6) auto-respuesta predefinida (alias “menu”, saludos simples, etc.)
    //    — sigue existiendo como atajo opcional; si no hay, cae a Gemini
    const autoResp = await autoResponseModel.findAndProcessResponse(
      messageText,
      {
        contact: {
          name: contact.name || null,
          dni: contact.dni || null,
          phoneNumber,
          companyName: activeCompanyName || null,
          ruc: activeCompanyRUC || null
        },
        company: {
          razonSocial: activeCompanyName || null,
          numeroDoc: activeCompanyRUC || null,
          name: activeCompanyName || null,
          ruc: activeCompanyRUC || null
        },
        customVars: {}
      }
    )
    if (autoResp) {
      // No añadir hint si ya lo trae el template
      const hint = await getMenuHintText()
      const withHint = alreadyHasHint(autoResp, hint) ? autoResp : (autoResp + hint)
      await conversationModel.save(phoneNumber, 'ASSISTANT', withHint)
      return withHint
    }

    // 7) construir mensaje enriquecido para Gemini
    let finalToModel = txt

    if (hasMedia && mediaAnalysisJson) {
      finalToModel += `

[ANÁLISIS DEL ARCHIVO ENVIADO POR EL USUARIO]
${mediaAnalysisJson}
`
    }
    if (detectedErrorCode) {
      finalToModel += `

[CÓDIGO DE ERROR DETECTADO: ${detectedErrorCode}]
Explica en lenguaje simple lo que implica y ofrece registrar servicio en sitio (sin prometer hora exacta).
`
    }
    if (detectedSerial) {
      finalToModel += `

[NÚMERO DE SERIE DETECTADO: ${detectedSerial}]
Inclúyelo en la respuesta para que el técnico identifique el equipo.
`
    }
    if (anydeskCode) {
      finalToModel += `

[ID REMOTO DETECTADO (e.g. AnyDesk): ${anydeskCode}]
Inclúyelo una sola vez en la respuesta y ofrece conexión remota *solo si está en horario de atención*.
Si está fuera de horario, indica que se atenderá al abrir.
`
    }

    // Guías suaves según señales
    if (signalRemote) {
      const remoteGuide =
        (await renderTemplateByCategoryName('templates', 'INTENT_REMOTE_GUIDE', {
          policy_remote_tool_name: systemVars.policy_remote_tool_name || 'AnyDesk',
          policy_link_label: systemVars.policy_link_label || 'enlace del sistema'
        })) ||
        `El usuario solicita soporte remoto (${systemVars.policy_remote_tool_name || 'AnyDesk'}).
Pídele su ID (9 dígitos) si no lo dio aún.`
      finalToModel += `

[GUÍA - ASISTENCIA REMOTA]
${remoteGuide}
`
    }
    if (signalService) {
      const serviceGuide =
        (await renderTemplateByCategoryName('templates', 'INTENT_SERVICE_GUIDE', {
          policy_link_label: systemVars.policy_link_label || 'enlace del sistema'
        })) ||
        `El usuario reporta falla. Pídele detalles y ofrece registrar servicio técnico en sitio.`
      finalToModel += `

[GUÍA - SERVICIO TÉCNICO]
${serviceGuide}
`
    }
    if (signalToner) {
      const tonerGuide =
        (await renderTemplateByCategoryName('templates', 'INTENT_TONER_GUIDE', {
          policy_link_label: systemVars.policy_link_label || 'enlace del sistema'
        })) ||
        `El usuario solicita tóner/insumos. Pídele modelo/serie y color.`
      finalToModel += `

[GUÍA - TÓNER / INSUMOS]
${tonerGuide}
`
    }

    // Restricciones por horario (NUNCA humano fuera de horario)
    if (!isOpen) {
      finalToModel += `

[RESTRICCIÓN HORARIA]
El negocio está CERRADO. NO ofrezcas ni derives a humano. 
Sí puedes: brindar información, generar enlaces Odoo (servicio/tóner) o dejar instrucciones.
Aclara que se atenderá al abrir.
`
    } else {
      finalToModel += `

[REGLA]
Si el usuario pide humano en horario de atención, puedes sugerir que un técnico lo contactará.
(La derivación real la maneja el backend, no prometas tiempos exactos.)
`
    }

    // 8) Modelo + historial reciente
    const recent = await conversationModel.getHistory(phoneNumber, 10)
    const history: any[] = []
    for (const m of recent) {
      if (m.role === 'USER') history.push({ role: 'user', parts: [{ text: m.content }] })
      if (m.role === 'ASSISTANT') history.push({ role: 'model', parts: [{ text: m.content }] })
    }
    while (history.length > 0 && history[0].role !== 'user') history.shift()

    const model = await getGeminiModel()
    const chat = model.startChat({
      history,
      systemInstruction: { role: 'system', parts: [{ text: systemPrompt }] }
    })

    logger.info({ len: finalToModel.length }, '[GEMINI] Send enriched')
    const result = await chat.sendMessage(finalToModel)
    let response = result.response.text() || ''

    logger.info({ preview: response.substring(0, 160) }, '[GEMINI] Raw response')

    // 9) Acciones: enlaces Odoo (sin humano fuera de horario)
    const needsLink = signalRemote || signalService || signalToner
    if (needsLink && activeCompanyName) {
      const equipmentId =
        customerInfo?.equipment?.length === 1 ? customerInfo.equipment[0].id : undefined

      const serviceUrl = await odooService.getOdooServiceLink(
        activeCompanyName,
        contact.name || 'Usuario',
        phoneNumber,
        equipmentId
      )

      if (serviceUrl && shouldSendNewLink(phoneNumber, serviceUrl)) {
        // plantilla de “attachment” según intención
        let linkTplName = 'LINK_SERVICE'
        if (signalRemote) linkTplName = 'LINK_REMOTE'
        else if (signalToner) linkTplName = 'LINK_TONER'

        const eq = (customerInfo?.equipment && customerInfo.equipment[0]) || {}
        const linkMsg =
          (await renderTemplateByCategoryName('templates', linkTplName, {
            link: serviceUrl,
            equipmentBrand: eq.brand || '',
            equipmentModel: eq.model || '',
            equipmentSerial: eq.serial || '',
            equipmentCount: String(customerInfo?.equipment?.length || 0),
            policy_link_label: systemVars.policy_link_label || 'enlace del sistema',
            policy_remote_tool_name: systemVars.policy_remote_tool_name || 'AnyDesk'
          })) ||
          `Abre este ${systemVars.policy_link_label || 'enlace'} para registrar tu solicitud:\n${serviceUrl}`

        response += `\n\n${linkMsg}`
        trackLinkSent(phoneNumber, serviceUrl)
      }
    }

    // 10) Nota fuera de horario (informativa, nunca humano)
    if (!isOpen) {
      const out = await buildOutOfHoursNotice(scheduleContext)
      response += `\n\n${out}`
    }

    // 11) Cierre “gracias” → despedida + hint
    const hint = await getMenuHintText()
    if (isThanks) {
      const bye = await buildFarewell(systemVars)
      let finalBye = bye
      if (!alreadyHasHint(finalBye, hint)) finalBye += hint
      await conversationModel.save(phoneNumber, 'ASSISTANT', finalBye)
      return finalBye
    }

    // 12) Adjuntar hint una sola vez si no es “menú completo”
    if (!looksLikeMenuFull(response) && !alreadyHasHint(response, hint)) {
      response += hint
    }

    // 13) Guardar y devolver
    await conversationModel.save(phoneNumber, 'ASSISTANT', response)
    return response

  } catch (error) {
    logger.error({ err: error }, '[GEMINI] Error')
    return 'Lo siento, estoy teniendo problemas para procesar tu mensaje. ¿Podrías intentarlo de nuevo?'
  }
}
