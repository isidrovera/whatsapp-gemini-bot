// src/services/gemini.ts
import { getGeminiModel } from '../config/gemini.js'
import { logger } from '../utils/logger.js'

import * as conversationModel from '../models/conversation.js'
import * as contactModel from '../models/contact.js'
import * as departmentModel from '../models/department.js'
import * as productModel from '../models/product.js'
import * as workingHoursModel from '../models/workingHours.js'
import * as templateModel from '../models/template.js'
import * as autoResponseModel from '../models/autoResponse.js'
import * as calendarModel from '../models/calendar.js'
import * as systemVarModel from '../models/systemVar.js'

import * as odooService from './odoo.js'
import { replaceVariables } from '../utils/formatters.js'

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
  // Buscar plantilla en MessageTemplate: category=templates, name=menu_hint
  try {
    const list = await templateModel.getByCategory('templates')
    const tpl = list.find(t => (t.name || '').toLowerCase() === 'menu_hint')
    const content = tpl?.content?.trim()
    return content && content.length > 0 ? content : DEFAULT_MENU_HINT
  } catch {
    return DEFAULT_MENU_HINT
  }
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
         ''
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
  // Variables de empresa/flags unificadas en systemVarModel
  const systemVars = await systemVarModel.getVariablesForPrompt?.() || {}

  // Intentamos leer plantilla en MessageTemplate (category=templates, name=system_prompt)
  let tpl: string | null = null
  try {
    const list = await templateModel.getByCategory('templates')
    const found = list.find(t => (t.name || '').toLowerCase() === 'system_prompt')
    tpl = found?.content?.trim() || null
  } catch {
    tpl = null
  }

  if (!tpl) {
    tpl = `
Eres un asistente virtual profesional de {{company_name}}.
RESPONDES SIEMPRE en español, de forma clara, útil y concreta.

DISPOSICIÓN GENERAL
- Estás integrado en WhatsApp.
- Ya existen mensajes automáticos (auto-respuestas) que pueden saludar, mostrar departamentos, teléfonos, etc.
- Tu función principal es responder dudas, explicar cosas, guiar al usuario y continuar la conversación de forma natural.

REGLAS DE SALUDO Y ESTILO
1) NO saludes en todos los mensajes.
   - Solo usa un saludo si el mensaje ACTUAL del usuario es un saludo
     (por ejemplo: "hola", "buenas", "buenos días", etc.).
   - Si el usuario solo escribe una palabra como "Alquiler", "Tóner", "Servicio", etc., RESPONDE SIN SALUDO.

2) NO repitas el nombre completo del usuario en cada respuesta.
   - Puedes usar el nombre SOLO de forma ocasional cuando aporte cercanía, pero no en todos los mensajes.

3) NO repitas el teléfono principal de la empresa ni los departamentos
   a menos que el usuario lo pida explícitamente.

4) Escribe en párrafos cortos, directos y fáciles de leer.
   Evita textos muy largos o repetitivos.

USO DE CONTEXTOS
Tienes la siguiente información disponible:

- Datos de la empresa:
  {{company_name}}
  {{company_address}}
  Teléfono principal: {{company_phone}}

- Información de horarios y calendario:
  {{schedule_context}}

- Información de departamentos:
  {{departments_context}}

- Catálogo de productos y servicios:
  {{products_context}}

- Información del usuario actual (empresa, equipos, etc.):
  {{user_context}}

- Resumen de próximos días de atención:
  {{future_schedule_context}}

CÓMO USAR ESA INFORMACIÓN
- Si el usuario pregunta por horarios, días de atención, feriados, etc.,
  RESPONDE usando exclusivamente la información de horarios y calendario.
- Si pregunta por un área, departamento o contacto interno, usa la información de departamentos.
- Si pregunta por productos, tóner, insumos o servicios disponibles, usa el catálogo.
- Si hace referencia a sus equipos, puedes usar la información de {{user_context}}.

ROL CON AYUDA TÉCNICA / GUÍA
- Si el usuario hace preguntas como:
  "no sé cómo instalar AnyDesk", "cómo descargo el programa",
  "no sé usar la impresora", "cómo configuro esto", etc.,
  ENTONCES:
  → Responde tú mismo con instrucciones claras, paso a paso.
  → NO digas que tiene que hablar con un técnico para cosas simples
    si puedes explicarlo con texto.
  → Puedes dar ejemplos, pasos numerados y recomendaciones prácticas.

RELACIÓN CON SOPORTE HUMANO
- SOLO sugiere hablar con un técnico humano cuando:
  - el usuario lo pide claramente (por ejemplo: "quiero que me llame un técnico",
    "quiero una visita técnica", "necesito soporte en sitio"), o
  - el problema es claramente complejo o requiere intervención física.

- Si el negocio está FUERA DE HORARIO:
  - NO prometas atención humana inmediata.
  - SÍ puedes explicar, orientar, dar pasos, responder dudas técnicas
    y aclarar que la atención humana se realizará en horario laboral.

- Si el negocio está ABIERTO:
  - Puedes decir que un técnico se pondrá en contacto,
    pero SIN prometer una hora exacta ni tiempos concretos.

OTRAS REGLAS IMPORTANTES
- No inventes teléfonos, direcciones ni datos que no estén en el contexto.
- No inventes políticas de la empresa.
- No repitas bloques largos de información (departamentos, horarios, teléfonos)
  si ya se enviaron recientemente en la conversación.
- Si el usuario escribe solo una palabra relacionada con un departamento
  (por ejemplo "Alquiler", "Facturación", "Soporte", "Ventas"),
  entiende que se refiere a ese tema y responde en esa línea,
  sin reenviar todo el texto general de departamentos.

OBJETIVO
- Ser un asistente útil, concreto y profesional.
- Continuar la conversación donde la dejaron las auto-respuestas,
  sin volver a mandar mensajes largos de bienvenida.
- Guiar al usuario en cualquier tipo de consulta (técnica, informativa, de uso)
  con respuestas claras y accionables.

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
async function buildOutOfHoursNotice () {
  // Variables/plantillas desde systemVar + templates
  const status = await workingHoursModel.getStatusInfo(new Date())
  const [nextOpen, tz] = await Promise.all([
    workingHoursModel.getNextOpenDateTime(new Date()),
    systemVarModel.getBusinessTimezone()
  ])

  const open = status?.todayHours?.openTime || '--:--'
  const close = status?.todayHours?.closeTime || '--:--'
  const break_start = status?.todayHours?.breakStart || ''
  const break_end = status?.todayHours?.breakEnd || ''
  const break_hint = (status?.reason === 'break' && break_end) ? ` (volvemos ${break_end})` : ''
  const next_open_line = nextOpen
    ? `Volvemos a estar disponibles: ${workingHoursModel.formatDateTime(nextOpen, tz)}.`
    : 'Te responderemos apenas volvamos a estar disponibles.'

  const reasonMap: Record<string, string> = {
    holiday: 'Hoy es día no laborable',
    closure: 'Hoy nuestro local está cerrado',
    non_workday: 'Hoy no tenemos atención',
    before_open: 'Aún no abrimos',
    after_close: 'Ya cerramos por hoy',
    break: 'Estamos en horario de refrigerio',
  }
  const reason = reasonMap[status?.reason || 'closure'] || 'Estamos fuera de horario'
  const event_type = status?.reason || ''
  const event_title = status?.todayEvent?.title || ''

  const rendered =
    await renderTemplateByCategoryName('templates', 'after_hours', {
      reason, open, close, break_start, break_end, break_hint, next_open_line, event_type, event_title
    })

  return rendered || `⏰ ${reason}.\n🕒 Hoy: ${open}–${close}${break_hint}\n${next_open_line}`
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

    // 2) flujo fijo de registro
    if (
      contact.state === 'NEW' ||
      contact.state === 'WAITING_DNI' ||
      contact.state === 'WAITING_RUC' ||
      contact.state === 'SELECTING_COMPANY'
    ) {
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

    // 4) estado de negocio
    const statusInfo = await workingHoursModel.getStatusInfo(new Date())
    const isOpen = !!statusInfo?.isOpen

    // 5) señales
    const txt = (messageText || '').trim()
    const isThanks = looksLikeThanks(txt)
    const signalToner = wantsToner(txt)
    const signalService = wantsService(txt)
    const signalRemote = wantsRemote(txt)

    // 6) auto-respuesta predefinida
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
      const hint = await getMenuHintText()
      const withHint = alreadyHasHint(autoResp, hint) ? autoResp : (autoResp + hint)
      await conversationModel.save(phoneNumber, 'ASSISTANT', withHint)
      return withHint
    }

    // 7) construir prompt enriquecido
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

    // Guías suaves
    if (signalRemote) {
      const remoteGuide =
        (await renderTemplateByCategoryName('INTENT', 'INTENT_REMOTE_GUIDE', {
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
        (await renderTemplateByCategoryName('INTENT', 'INTENT_SERVICE_GUIDE', {
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
        (await renderTemplateByCategoryName('INTENT', 'INTENT_TONER_GUIDE', {
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

    // 8) Modelo + historial
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

    // 9) Acciones: enlaces Odoo
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
        // plantilla por intención (category=LINK)
        let linkTplName: 'LINK_SERVICE' | 'LINK_REMOTE' | 'LINK_TONER' = 'LINK_SERVICE'
        if (signalRemote) linkTplName = 'LINK_REMOTE'
        else if (signalToner) linkTplName = 'LINK_TONER'

        const eq = (customerInfo?.equipment && customerInfo.equipment[0]) || {}
        const linkMsg =
          (await renderTemplateByCategoryName('LINK', linkTplName, {
            link: serviceUrl,
            equipmentBrand: eq.brand || '',
            equipmentModel: eq.model || '',
            equipmentSerial: eq.serial || '',
            equipmentCount: String(customerInfo?.equipment?.length || 0),
            policy_link_label: (systemVars as any).policy_link_label || 'enlace del sistema',
            policy_remote_tool_name: (systemVars as any).policy_remote_tool_name || 'AnyDesk'
          })) ||
          `Abre este ${(systemVars as any).policy_link_label || 'enlace'} para registrar tu solicitud:\n${serviceUrl}`

        response += `\n\n${linkMsg}`
        trackLinkSent(phoneNumber, serviceUrl)
      }
    }

    // 10) Nota fuera de horario (informativa, nunca humano)
    if (!isOpen) {
      const out = await buildOutOfHoursNotice()
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

    // 12) Adjuntar hint si no es “menú completo”
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
