// src/services/gemini.ts
import { getGeminiModel } from '../config/gemini.js';
import { logger } from '../utils/logger.js';
import * as conversationModel from '../models/conversation.js';
import * as contactModel from '../models/contact.js';
import * as systemVarModel from '../models/systemVar.js';

// (siguen existiendo pero ya no controlan el flujo principal desde acá)
import * as calendarModel from '../models/calendar.js';
import * as workingHoursModel from '../models/workingHours.js';

// Validadores básicos
import { isValidDNI, isValidRUC } from '../utils/validators.js';

// API integración externa (RENIEC / SUNAT)
import * as externalService from './external.js';

// Odoo
import * as odooService from './odoo.js';

// Utilidad para interpolar plantillas
import { replaceVariables } from '../utils/formatters.js';

/* ============================================================
   TRACKER DE ENLACES → para no spamear el mismo link varias veces
   ============================================================ */
interface LinkTracking {
  phoneNumber: string;
  lastLinkSentAt: Date;
  lastLinkUrl: string;
}

const linkTracker = new Map<string, LinkTracking>();
const LINK_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutos

function shouldSendNewLink(phoneNumber: string, newUrl: string): boolean {
  const tracked = linkTracker.get(phoneNumber);

  if (!tracked) return true;

  const now = new Date();
  const timeSinceLastLink = now.getTime() - tracked.lastLinkSentAt.getTime();

  // Si es el mismo URL y fue hace menos de 5 minutos, NO enviar
  if (tracked.lastLinkUrl === newUrl && timeSinceLastLink < LINK_COOLDOWN_MS) {
    logger.info(
      `[LINK-TRACKER] Skipping duplicate link for ${phoneNumber} (sent ${Math.round(
        timeSinceLastLink / 1000
      )}s ago)`
    );
    return false;
  }

  return true;
}

function trackLinkSent(phoneNumber: string, url: string) {
  linkTracker.set(phoneNumber, {
    phoneNumber,
    lastLinkSentAt: new Date(),
    lastLinkUrl: url,
  });
}

/* ============================================================
   DETECCIÓN DE INTENCIONES DEL MENSAJE
   ============================================================ */

/**
 * El usuario está pidiendo control remoto / AnyDesk / asistencia remota?
 */
function detectRemoteSupportIntent(
  message: string,
  hasImage: boolean,
  anydeskCode: string | null
): boolean {
  const remoteKeywords = [
    'anydesk',
    'asistencia remota',
    'control remoto',
    'soporte remoto',
    'conectarse',
    'conéctate',
    'conexion remota',
    'conexión remota',
    'id anydesk',
    'pueden entrar',
    'pueden ingresar',
    'pueden tomar control',
    'puedes tomar control',
    'me ayudan remoto',
    'me ayudan en remoto',
  ];
  const lower = message.toLowerCase();

  // Si mandó imagen (por ej screenshot de anydesk) consideramos remoto
  if (hasImage) return true;
  if (anydeskCode && anydeskCode.trim() !== '') return true;

  return remoteKeywords.some((k) => lower.includes(k));
}

/**
 * Acá nos apoyamos en detectServiceIntent / detectTonerIntent del servicio Odoo.
 */
function detectServiceOrTonerIntents(message: string) {
  const lower = message.toLowerCase();
  const wantsService = odooService.detectServiceIntent(lower);
  const wantsToner = odooService.detectTonerIntent(lower);
  return { wantsService, wantsToner };
}

/* ============================================================
   SYSTEM PROMPT BASE
   (Mantiene tu filosofía / tono / reglas de respuesta)
   ============================================================ */

const SYSTEM_PROMPT = `Eres un asistente virtual profesional de {{company_name}}.

INFORMACIÓN DE LA EMPRESA:
Nombre: {{company_name}}
Descripción: {{company_description}}
📍 Dirección: {{company_address}}
📧 Email: {{company_email}}
📞 Teléfono: {{company_phone}}
🌐 Web: {{company_website}}

DEPARTAMENTOS Y CONTACTOS DISPONIBLES:
{{departments_context}}

CATÁLOGO DE PRODUCTOS Y SERVICIOS:
{{products_context}}

HORARIOS E INFORMACIÓN DE ATENCIÓN:
{{schedule_context}}

INFORMACIÓN DEL USUARIO ACTUAL:
{{user_context}}

═══════════════════════════════════════════════════
INSTRUCCIONES CLAVE
═══════════════════════════════════════════════════

1. CONTACTOS / TELÉFONOS
Si el usuario pide "un número", "hablar con alguien", "contacto", "teléfono" o similar:
- Responde INMEDIATAMENTE con TODOS los contactos disponibles en "DEPARTAMENTOS Y CONTACTOS DISPONIBLES".
- Incluye nombre del área, descripción breve, persona de contacto y número(s).
- No digas que no tienes acceso. SÍ tienes acceso a esa información.

Termina preguntando: "¿Con cuál departamento necesitas ayuda?"

2. EQUIPOS REGISTRADOS
Antes de responder, revisa "EQUIPOS REGISTRADOS EN EL SISTEMA" dentro de INFORMACIÓN DEL USUARIO ACTUAL.

Si HAY equipos:
- Para servicio técnico: NO preguntes marca/modelo/serie desde cero.
  Usa directamente los datos que ya están.
- Para tóner: menciona el/los equipos y pregunta para cuál necesita insumos.
- Si hay varios equipos, preséntalos como lista numerada y pide que elija.

Si NO hay equipos:
- Sé breve.
- Di que en el formulario podrá indicar el modelo/serie.
- No hagas muchas preguntas técnicas.

3. SOPORTE REMOTO / ANYDESK
Si el usuario necesita conexión remota o soporte remoto:
- Pídele el ID de AnyDesk (9 dígitos) O que mande una foto clara donde se vea la pantalla de AnyDesk.
- Di que un técnico puede conectarse.
- Menciona que se registrará el caso en "nuestro sistema".
- Mantén tono tranquilo y profesional.

4. ENLACES DEL SISTEMA
No digas "Odoo", "ticket interno" ni "base de datos".
Di "te dejo el enlace de nuestro sistema" o "formulario".
Ese enlace se te proporcionará externamente y lo debes incluir en la respuesta si lo tienes.

5. TÓNER / SUMINISTROS
- Sé directo.
- Pregunta color / tipo de tóner si es relevante.
- Menciona que lo puede solicitar en el enlace.
- No des precios precisos ni prometas tiempos exactos.

6. HUMANO
Si el usuario pide hablar con una persona, dile que puedes derivar a un técnico .

7. ESTILO
- Profesional pero cercano.
- Usa emojis apropiados (📋 🔧 🖨 📞 📟 🧑‍💻).
- Respuestas cortas (máx ~15 líneas).
- No repitas la misma información muchas veces.

8. IMPORTANTE
- No digas "no tengo acceso a tus datos".
- No digas "no sé tu empresa".
- Ya tienes la empresa activa en INFORMACIÓN DEL USUARIO ACTUAL -> úsala.
- No vuelvas a pedir DNI o RUC si ya están en INFORMACIÓN DEL USUARIO ACTUAL.
- No pidas el nombre del usuario si ya está en INFORMACIÓN DEL USUARIO ACTUAL.

9. PALABRAS CLAVE
Siempre llama al formulario "enlace del sistema" o "formulario", nunca "Odoo".
Nunca prometas horarios exactos de visita, sólo "un técnico puede coordinar contigo".
`;

/* ============================================================
   API PRINCIPAL: processMessage
   ============================================================ */

/**
 * processMessage
 * - whatsapp.ts SIEMPRE llama esto al final si el mensaje no fue
 *   manejado completamente por menú ni estados directos.
 *
 * - Aquí hacemos:
 *   1) asegurar contacto
 *   2) guardar conversación en BD
 *   3) armar contexto y hablar con Gemini
 *   4) si detectamos intención (servicio técnico / tóner / remoto)
 *      intentamos generar y adjuntar el enlace del sistema
 *
 * NOTA IMPORTANTE:
 *   ESTE ARCHIVO YA NO maneja estados tipo WAITING_DNI,
 *   WAITING_RUC, SELECTING_COMPANY, MENU, etc.
 *   Eso lo maneja whatsapp.ts.
 */
export async function processMessage(
  phoneNumber: string,
  messageText: string,
  hasImage: boolean = false,
  imageAnalysis: string | null = null,
  anydeskCode: string | null = null
): Promise<string> {
  try {
    logger.info(
      `Processing message for ${phoneNumber}: ${messageText.substring(
        0,
        80
      )}... ${hasImage ? '[+IMAGE]' : ''}`
    );

    // 1. Obtener o crear contacto
    let contact = await contactModel.findByPhone(phoneNumber);
    if (!contact) {
      contact = await contactModel.create(phoneNumber);
      logger.info(`New contact created: ${phoneNumber}`);
    }

    // 2. Guardar mensaje del usuario en la conversación
    let contentToSave = messageText;
    if (hasImage && imageAnalysis) {
      contentToSave += ` [IMAGEN: ${imageAnalysis.substring(0, 180)}...]`;
    }
    if (anydeskCode) {
      contentToSave += ` [ANYDESK: ${anydeskCode}]`;
    }

    await conversationModel.save(phoneNumber, 'USER', contentToSave);

    // 3. NO manejamos registro aquí. Si el contacto todavía está
    //    en fase de registro, sólo devolvemos una confirmación genérica,
    //    porque whatsapp.ts ya se encargó de pedir DNI/RUC/etc.
    if (
      contact.state === 'NEW' ||
      contact.state === 'WAITING_DNI' ||
      contact.state === 'WAITING_RUC' ||
      contact.state === 'SELECTING_COMPANY'
    ) {
      const fallbackMsg =
        'Estoy validando tus datos para poder ayudarte 👍. ' +
        'Ya casi terminamos el registro.';
      await conversationModel.save(phoneNumber, 'ASSISTANT', fallbackMsg);
      return fallbackMsg;
    }

    // 4. A partir de aquí asumimos que el contacto ya tiene al menos
    //    un nombre y (posiblemente) una empresa asociada como primaria
    //    (companyName y ruc en contact o en contact.companies)
    //
    //    Vamos a armar el contexto que enviamos al modelo Gemini:
    //    - Info de empresa primaria
    //    - Equipos desde Odoo
    //    - Datos de la empresa (vars del sistema)
    //    - Horario / departamentos / productos

    // Empresa primaria calculada (con fallback legacy)
    const primaryData = contactModel.resolvePrimaryCompany(contact);
    const activeCompanyName = primaryData.companyName || contact.companyName || null;
    const activeCompanyRUC = primaryData.ruc || contact.ruc || null;

    // Traer información del cliente desde Odoo (equipos, último tóner, etc.)
    let customerInfo: any = null;
    let equipmentContext = 'El cliente NO tiene equipos registrados en el sistema.';
    if (activeCompanyName) {
      customerInfo = await odooService.getCustomerInfo(
        activeCompanyName,
        contact.name || 'Usuario',
        phoneNumber
      );

      if (customerInfo) {
        equipmentContext = odooService.formatEquipmentContext(customerInfo);
        logger.info(
          `[ODOO] Found ${customerInfo.equipment.length} equipment(s) for ${activeCompanyName}`
        );
      }
    }

    // Otros contextos dinámicos del sistema
    const scheduleContext = await systemVarModel.getScheduleContext();
    const departmentsContext = await systemVarModel.getDepartmentsContext();
    const productsContext = await systemVarModel.getProductsContext();

    // Historial reciente de conversación
    // (últimos 10 mensajes, role USER / ASSISTANT)
    const history = await conversationModel.getHistory(phoneNumber, 10);

    // Variables estáticas de sistema (company_name, etc.)
    const systemVars = await systemVarModel.getVariablesForPrompt();

    // User context que se inyecta al prompt
    const userContext = `Nombre: ${contact.name || 'No proporcionado'}
Empresa activa: ${activeCompanyName || 'No proporcionada'}
RUC activo: ${activeCompanyRUC || 'No proporcionado'}
DNI: ${contact.dni || 'No proporcionado'}
Estado interno: ${contact.state || 'N/A'}

EQUIPOS REGISTRADOS EN EL SISTEMA:
${equipmentContext}
`;

    // Armamos el system prompt final con variables
    const systemPrompt = replaceVariables(SYSTEM_PROMPT, {
      ...systemVars,
      schedule_context: scheduleContext,
      departments_context: departmentsContext,
      products_context: productsContext,
      user_context: userContext,
    });

    logger.debug(
      `[GEMINI] Context sizes - Departments: ${departmentsContext.length} chars, Products: ${productsContext.length} chars, Equipment: ${equipmentContext.length} chars`
    );

    // Normalizar el historial a formato Gemini
    const geminiHistory: any[] = [];
    for (const msg of history) {
      if (msg.role === 'USER') {
        geminiHistory.push({ role: 'user', parts: [{ text: msg.content }] });
      } else if (msg.role === 'ASSISTANT') {
        geminiHistory.push({ role: 'model', parts: [{ text: msg.content }] });
      }
    }

    // Aseguramos que el primer mensaje en history que le pasamos sea del usuario
    while (geminiHistory.length > 0 && geminiHistory[0].role !== 'user') {
      geminiHistory.shift();
    }

    // Limpiar alternancia role user/model para que no explote
    const validatedHistory: any[] = [];
    let lastRole: string | null = null;
    for (const msg of geminiHistory) {
      if (lastRole === null || lastRole !== msg.role) {
        validatedHistory.push(msg);
        lastRole = msg.role;
      }
    }

    // Creamos la sesión de chat Gemini con systemInstruction
    const model = await getGeminiModel();
    const chat = model.startChat({
      history: validatedHistory,
      systemInstruction: {
        role: 'system',
        parts: [{ text: systemPrompt }],
      },
    });

    // Mensaje enriquecido para Gemini
    let finalMessage = messageText;

    if (hasImage && imageAnalysis) {
      finalMessage += `

[INFORMACIÓN DE LA IMAGEN ENVIADA POR EL USUARIO]
${imageAnalysis}
`;
    }

    if (anydeskCode) {
      finalMessage += `

[ID ANYDESK DETECTADO DEL USUARIO: ${anydeskCode}]
Incluye este ID en tu respuesta solo una vez.
`;
    }

    // Pista extra para Gemini cuando sea remoto
    const hasRemoteSupportIntent = detectRemoteSupportIntent(
      messageText,
      hasImage,
      anydeskCode
    );
    if (hasRemoteSupportIntent) {
      finalMessage += `

[INSTRUCCIONES PARA TU RESPUESTA AL CLIENTE - ASISTENCIA REMOTA]
- El usuario está pidiendo ASISTENCIA REMOTA (control remoto).
- PÍDELE su ID de AnyDesk (9 dígitos) o que mande una foto donde se vea claramente el ID AnyDesk.
- Dile que un técnico puede conectarse.
- Menciona que registraremos su caso en el sistema.
- Mantén el tono profesional y cercano.
- Recuerda que luego le daremos un enlace del sistema.
`;
    }

    // Enviar el mensaje al modelo
    logger.info(
      `[GEMINI] Sending enriched message (${finalMessage.length} chars)`
    );
    const result = await chat.sendMessage(finalMessage);
    let response = result.response.text() || '';

    logger.info(`[GEMINI] Initial response: ${response.substring(0, 120)}...`);

    // ======================================================
    // POST-PROCESAMIENTO: decidir si agregamos el enlace
    // ======================================================

    const { wantsService, wantsToner } =
      detectServiceOrTonerIntents(messageText);

    const needsLink =
      hasRemoteSupportIntent || wantsService || wantsToner;

    if (needsLink && activeCompanyName && customerInfo) {
      // Si tiene un solo equipo, intentamos pre-seleccionar ese ID
      const equipmentId =
        customerInfo.equipment && customerInfo.equipment.length === 1
          ? customerInfo.equipment[0].id
          : undefined;

      // Generamos URL desde Odoo
      const serviceUrl = await odooService.getOdooServiceLink(
        activeCompanyName,
        contact.name || 'Usuario',
        phoneNumber,
        equipmentId
      );

      if (serviceUrl && shouldSendNewLink(phoneNumber, serviceUrl)) {
        // Etiqueta humana del enlace
        let intentType = 'tu solicitud';
        if (hasRemoteSupportIntent) {
          intentType = 'asistencia remota';
        } else if (wantsService) {
          intentType = 'servicio técnico';
        } else if (wantsToner) {
          intentType = 'tóner / insumos';
        }

        // Mensaje contextual según equipos
        let linkMessage = `\n\n🔗 *Enlace para ${intentType}:*\n${serviceUrl}\n\n`;

        if (hasRemoteSupportIntent) {
          linkMessage +=
            `En este formulario puedes indicar el problema y tu ID de AnyDesk para que un técnico se conecte. `;
        }

        if (customerInfo.equipment?.length === 1) {
          const eq = customerInfo.equipment[0];
          linkMessage += `Nuestro sistema ya reconoce tu equipo ${eq.brand} ${eq.model} (Serie: ${eq.serial}).`;
        } else if (customerInfo.equipment?.length > 1) {
          linkMessage += `Ahí podrás seleccionar cuál de tus ${customerInfo.equipment.length} equipos necesita atención.`;
        } else {
          linkMessage +=
            `Ahí podrás indicar el modelo y la serie del equipo que necesita atención.`;
        }

        response += linkMessage;
        trackLinkSent(phoneNumber, serviceUrl);

        logger.info(
          `[GEMINI] Link added with equipment context (${customerInfo.equipment?.length || 0} equipment(s))`
        );
      } else if (serviceUrl) {
        logger.info(`[GEMINI] Link skipped (recently sent)`);
      } else {
        logger.warn(`[GEMINI] Could not obtain link from Odoo`);
      }
    } else if (needsLink && !customerInfo) {
      // No pudimos traer info de la empresa/equipos
      if (hasRemoteSupportIntent) {
        response +=
          `\n\nPor favor envíame tu ID de AnyDesk (los 9 números) o una foto clara de tu pantalla de AnyDesk para que un técnico se conecte 🧑‍💻.`;
      } else {
        response +=
          `\n\nNecesito validar tu empresa registrada para poder generar el enlace del sistema. ¿Me confirmas la razón social o el RUC, por favor?`;
      }
    }

    // 5. Guardar respuesta final del asistente en la DB
    await conversationModel.save(phoneNumber, 'ASSISTANT', response);

    // 6. Regresar respuesta final (esto es lo que whatsapp.ts le manda al usuario)
    return response;
  } catch (error) {
    logger.error(`[GEMINI] Error:`, error);
    return 'Lo siento, estoy teniendo problemas para procesar tu mensaje. ¿Podrías intentarlo de nuevo?';
  }
}
