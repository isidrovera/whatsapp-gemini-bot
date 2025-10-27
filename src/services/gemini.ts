// src/services/gemini.ts
import { getGeminiModel } from '../config/gemini.js';
import { logger } from '../utils/logger.js';
import * as conversationModel from '../models/conversation.js';
import * as contactModel from '../models/contact.js';
import * as systemVarModel from '../models/systemVar.js';
import * as calendarModel from '../models/calendar.js';
import * as workingHoursModel from '../models/workingHours.js';
import * as externalService from './external.js';
import * as odooService from './odoo.js';
import { isValidDNI, isValidRUC } from '../utils/validators.js';
import { replaceVariables } from '../utils/formatters.js';

// 🆕 RASTREADOR DE ENLACES ENVIADOS (evita duplicados)
interface LinkTracking {
  phoneNumber: string;
  lastLinkSentAt: Date;
  lastLinkUrl: string;
}

const linkTracker = new Map<string, LinkTracking>();
const LINK_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutos entre enlaces

function shouldSendNewLink(phoneNumber: string, newUrl: string): boolean {
  const tracked = linkTracker.get(phoneNumber);
  
  if (!tracked) return true;
  
  const now = new Date();
  const timeSinceLastLink = now.getTime() - tracked.lastLinkSentAt.getTime();
  
  // Si es el mismo URL y fue hace menos de 5 minutos, NO enviar
  if (tracked.lastLinkUrl === newUrl && timeSinceLastLink < LINK_COOLDOWN_MS) {
    logger.info(`[LINK-TRACKER] Skipping duplicate link for ${phoneNumber} (sent ${Math.round(timeSinceLastLink / 1000)}s ago)`);
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

/* 🆕 Detectar intención de soporte remoto (AnyDesk / conexión remota) */
function detectRemoteSupportIntent(message: string, hasImage: boolean, anydeskCode: string | null): boolean {
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

  // regla práctica: si manda imagen (pantalla con anydesk) también lo tratamos como remoto
  if (hasImage) return true;
  if (anydeskCode && anydeskCode.trim() !== '') return true;

  return remoteKeywords.some(k => lower.includes(k));
}

/* 🆕 Mensaje base para soporte remoto, que luego se mezclará con el resto */
function buildRemoteSupportHeading(customerInfo: any): string {
  const link = customerInfo?.url || '';
  const name = customerInfo?.customer_name || 'Hola';

  return (
`${name}, entiendo que necesitas asistencia remota 🧑‍💻

Por favor envíanos tu *ID de AnyDesk* (los 9 números que aparecen en tu pantalla) o una *foto donde se vea claramente tu ID*, para que un técnico pueda conectarse y ayudarte.

🔗 También te dejo el enlace de nuestro sistema, donde quedará registrado el caso:
${link}
`
  );
}

const SYSTEM_PROMPT = `Eres un asistente virtual profesional de {{company_name}}.

**INFORMACIÓN DE LA EMPRESA:**
Nombre: {{company_name}}
Descripción: {{company_description}}
📍 Dirección: {{company_address}}
📧 Email: {{company_email}}
📞 Teléfono: {{company_phone}}
🌐 Web: {{company_website}}

**DEPARTAMENTOS Y CONTACTOS DISPONIBLES:**
{{departments_context}}

**CATÁLOGO DE PRODUCTOS Y SERVICIOS:**
{{products_context}}

**HORARIOS E INFORMACIÓN DE ATENCIÓN:**
{{schedule_context}}

**INFORMACIÓN DEL USUARIO ACTUAL:**
{{user_context}}

═══════════════════════════════════════════════════════════
INSTRUCCIONES CRÍTICAS - LEE CON ATENCIÓN
═══════════════════════════════════════════════════════════

**1. CUANDO PIDAN CONTACTOS O NÚMEROS DE TELÉFONO:**

Si el usuario dice:
- "Dame un número"
- "Quiero hablar con alguien"
- "Tienes algún número"
- "Pásame un contacto"
- "Necesito hablar con..."

DEBES hacer lo siguiente INMEDIATAMENTE:

a) Mostrar TODOS los departamentos con sus contactos completos  
b) Usar EXACTAMENTE la información de "DEPARTAMENTOS Y CONTACTOS DISPONIBLES"  
c) Incluir: departamento, descripción, nombres, roles y teléfonos  
d) NO digas "no tengo acceso a números" - SÍ los tienes arriba  
e) Da los números directamente sin rodeos

Formato:
"¡Claro! Con gusto te paso nuestros contactos:

[Copia TODA la información de DEPARTAMENTOS Y CONTACTOS]

¿Con cuál departamento necesitas ayuda?"

**2. USO DE INFORMACIÓN DE EQUIPOS REGISTRADOS:**

Revisa la sección "EQUIPOS REGISTRADOS EN EL SISTEMA" en la información del usuario.

Si el cliente TIENE equipos registrados:

Para SERVICIO TÉCNICO:
- NO preguntes modelo, marca ni serie
- Menciona directamente el equipo: "Veo que tienes un [marca] [modelo] (Serie: [serie])"
- Si tiene varios equipos, pregunta: "¿Cuál de tus equipos tiene el problema?"
- Menciona que el formulario vendrá con los datos del equipo

Para SOLICITUD DE TÓNER:
- NO preguntes modelo ni marca
- Menciona el equipo directamente
- Si compró tóner antes, menciónalo

Si tiene MÚLTIPLES equipos:
"Veo que tienes:
- [Equipo 1]
- [Equipo 2]

¿Para cuál de estos equipos necesitas [servicio/tóner]?"

Si NO tiene equipos registrados:
- Sé breve
- Menciona que en el formulario podrá indicar el modelo
- NO hagas muchas preguntas

**3. PROBLEMAS TÉCNICOS, SERVICIO EN SITIO O REMOTO:**

a) Muestra empatía breve: "Entiendo, lamento ese problema"
b) Si tiene equipos registrados: menciónalo (ver punto 2)
c) Si NO tiene equipos: NO preguntes modelo/marca/serie
d) Menciona que generarás el enlace del sistema
e) El enlace se agregará automáticamente al final de tu mensaje
f) 🆕 Si el usuario pide asistencia remota / control remoto / AnyDesk:
   - PÍDELE el ID de AnyDesk o una foto clara de la pantalla de AnyDesk
   - Dile que un técnico se puede conectar
   - Esto es PRIORIDAD

Ejemplo remoto:
"Entiendo el problema. Pásame por favor tu ID de AnyDesk (los 9 números) o una foto donde se vea el ID para que un técnico se conecte. Te dejo también el enlace de nuestro sistema para registrar el caso."

**4. SOLICITUDES DE TÓNER O REPUESTOS:**

- Si tiene equipos registrados: menciónalos directamente
- Si NO tiene equipos: no preguntes marca/modelo todavía
- NO des precios detallados
- Di que vas a generar el enlace
- El enlace se agrega automáticamente

**5. CONSULTAS DE ALQUILER:**

- No hagas muchas preguntas
- Da directamente el contacto del departamento de Alquiler
- Sé breve y directo

**6. CATÁLOGO:**

- Da info básica
- No te extiendas con descripciones enormes
- Pregunta si desea generar enlace de cotización

**7. HORARIOS:**

- Si estamos fuera de horario, dilo
- Explica cuándo retomamos

═══════════════════════════════════════════════════════════
LO QUE PUEDES Y NO PUEDES HACER
═══════════════════════════════════════════════════════════

✅ SÍ PUEDES:
- Dar contactos
- Mencionar equipos del cliente
- Pedir ID de AnyDesk / foto de AnyDesk si requiere soporte remoto
- Decir que generarás el "enlace del sistema"
- Decir que el técnico se puede conectar remotamente
- Responder sobre horarios, ubicación
- Conectar con el área correcta

❌ NO PUEDES:
- Decir "ticket", "Odoo", "base de datos"
- Prometer tiempos exactos
- Hacer diagnósticos técnicos largos

✅ DI SIEMPRE:
- "enlace del sistema"
- "formulario"

═══════════════════════════════════════════════════════════
TU PERSONALIDAD
═══════════════════════════════════════════════════════════

- Breve y directo
- Profesional pero cercano
- Empático cuando hay problema
- Usa emojis apropiados (📋 🔧 🛒 📞 📟 🧑‍💻)
- Respuestas cortas (máx ~15 líneas)

═══════════════════════════════════════════════════════════
RECORDATORIO FINAL
═══════════════════════════════════════════════════════════

1. El enlace se agrega AUTOMÁTICAMENTE después de tu mensaje
2. Si el cliente tiene equipos registrados: ÚSALOS (incluye marca, modelo y serie)
3. Si pide ayuda remota: PIDE ID DE ANYDESK O FOTO CLARA DEL ANYDESK
4. No menciones "Odoo"
5. Sé rápido y claro
6. Revisa siempre "EQUIPOS REGISTRADOS EN EL SISTEMA" antes de responder`;

export async function processMessage(
  phoneNumber: string, 
  messageText: string, 
  hasImage: boolean = false,
  imageAnalysis: string | null = null,
  anydeskCode: string | null = null
): Promise<string> {
  try {
    logger.info(`Processing message for ${phoneNumber}: ${messageText.substring(0, 50)}... ${hasImage ? '[+IMAGE]' : ''}`);

    // 1. Obtener o crear contacto
    let contact = await contactModel.findByPhone(phoneNumber);
    if (!contact) {
      contact = await contactModel.create(phoneNumber);
      logger.info(`New contact created: ${phoneNumber}`);
    }

    // 2. Guardar mensaje del usuario
    let contentToSave = messageText;
    if (hasImage && imageAnalysis) {
      contentToSave += ` [IMAGEN: ${imageAnalysis.substring(0, 100)}...]`;
    }
    if (anydeskCode) {
      contentToSave += ` [ANYDESK: ${anydeskCode}]`;
    }
    await conversationModel.save(phoneNumber, 'USER', contentToSave);

    // 3. Manejar flujo de registro
    if (contact.state === 'NEW') {
      return await handleNewUserFlow(phoneNumber, messageText, contact);
    }

    if (contact.state === 'WAITING_DNI') {
      return await handleDNIInput(phoneNumber, messageText);
    }

    if (contact.state === 'WAITING_RUC') {
      return await handleRUCInput(phoneNumber, messageText);
    }

    // 4. Usuario ya registrado → flujo inteligente
    return await processWithGemini(phoneNumber, messageText, contact, hasImage, imageAnalysis, anydeskCode);
  } catch (error) {
    logger.error('Error processing message:', error);
    return 'Lo siento, ocurrió un error al procesar tu mensaje. Por favor, intenta nuevamente.';
  }
}

async function handleNewUserFlow(phoneNumber: string, messageText: string, contact: any): Promise<string> {
  const systemVars = await systemVarModel.getVariablesForPrompt();
  const companyName = systemVars.company_name;
  
  const response = `¡Hola! Bienvenido a ${companyName}.\n\nPara brindarte una mejor atención, por favor proporciona tu DNI (8 dígitos).`;
  
  await conversationModel.save(phoneNumber, 'ASSISTANT', response);
  await contactModel.updateState(phoneNumber, 'WAITING_DNI');
  
  return response;
}

async function handleDNIInput(phoneNumber: string, messageText: string): Promise<string> {
  const dni = messageText.trim();
  
  if (!isValidDNI(dni)) {
    const response = 'El DNI debe tener exactamente 8 dígitos. Por favor, inténtalo nuevamente.';
    await conversationModel.save(phoneNumber, 'ASSISTANT', response);
    return response;
  }

  logger.info(`Validating DNI: ${dni}`);
  const dniData = await externalService.validateDNI(dni);
  
  if (!dniData) {
    const response = 'No se pudo verificar el DNI. Por favor, verifica el número e inténtalo nuevamente.';
    await conversationModel.save(phoneNumber, 'ASSISTANT', response);
    return response;
  }

  const fullName = `${dniData.nombres} ${dniData.apellidoPaterno} ${dniData.apellidoMaterno}`.trim();
  await contactModel.updateDNI(phoneNumber, dni, fullName);
  
  const response = `Perfecto, ${dniData.nombres}. Tu nombre ha sido registrado: ${fullName}.\n\nAhora, por favor proporciona el RUC de tu empresa (11 dígitos).`;
  await conversationModel.save(phoneNumber, 'ASSISTANT', response);
  
  return response;
}

async function handleRUCInput(phoneNumber: string, messageText: string): Promise<string> {
  const ruc = messageText.trim();
  
  if (!isValidRUC(ruc)) {
    const response = 'El RUC debe tener exactamente 11 dígitos. Por favor, inténtalo nuevamente.';
    await conversationModel.save(phoneNumber, 'ASSISTANT', response);
    return response;
  }

  logger.info(`Validating RUC: ${ruc}`);
  const rucData = await externalService.validateRUC(ruc);
  
  if (!rucData) {
    const response = 'No se pudo verificar el RUC. Por favor, verifica el número e inténtalo nuevamente.';
    await conversationModel.save(phoneNumber, 'ASSISTANT', response);
    return response;
  }

  await contactModel.updateRUC(phoneNumber, ruc, rucData.razonSocial);
  
  const response = `¡Excelente! Se ha registrado la empresa: ${rucData.razonSocial}.\n\n✅ Registro completado exitosamente.\n\n¿En qué puedo ayudarte hoy?`;
  await conversationModel.save(phoneNumber, 'ASSISTANT', response);
  
  return response;
}

async function processWithGemini(
  phoneNumber: string, 
  messageText: string, 
  contact: any,
  hasImage: boolean = false,
  imageAnalysis: string | null = null,
  anydeskCode: string | null = null
): Promise<string> {
  try {
    logger.info(`[GEMINI] Processing: "${messageText}" ${hasImage ? '[+IMAGE]' : ''} ${anydeskCode ? '[+ANYDESK]' : ''}`);
    
    // 🔍 DETECTAR INTENCIONES
    const hasRemoteSupportIntent = detectRemoteSupportIntent(messageText, hasImage, anydeskCode);
    const hasServiceIntent = odooService.detectServiceIntent(messageText) || hasImage;
    const hasTonerIntent = odooService.detectTonerIntent(messageText);
    
    logger.info(`[GEMINI] Intent - RemoteSupport: ${hasRemoteSupportIntent}, Service: ${hasServiceIntent}, Toner: ${hasTonerIntent}`);
    
    // 🆕 OBTENER INFO COMPLETA DEL CLIENTE (incluyendo equipos de Odoo)
    let customerInfo: any = null;
    let equipmentContext = 'El cliente NO tiene equipos registrados en el sistema.';
    
    if (contact.companyName) {
        customerInfo = await odooService.getCustomerInfo(
          contact.companyName,
          contact.name || 'Usuario',
          phoneNumber
        );
        
        if (customerInfo) {
          equipmentContext = odooService.formatEquipmentContext(customerInfo);
          logger.info(`[ODOO] Found ${customerInfo.equipment.length} equipment(s) for ${contact.companyName}`);
        }
    }
    
    // Otros contextos dinámicos
    const scheduleContext = await systemVarModel.getScheduleContext();
    const departmentsContext = await systemVarModel.getDepartmentsContext();
    const productsContext = await systemVarModel.getProductsContext();
    
    // Historial reciente
    const history = await conversationModel.getHistory(phoneNumber, 10);
    
    // Variables de sistema
    const systemVars = await systemVarModel.getVariablesForPrompt();
    
    // 🆕 CONTEXTO DEL USUARIO CON EQUIPOS REGISTRADOS
    const userContext = `Nombre: ${contact.name || 'No proporcionado'}
Empresa: ${contact.companyName || 'No proporcionada'}
DNI: ${contact.dni || 'No proporcionado'}
RUC: ${contact.ruc || 'No proporcionado'}

**EQUIPOS REGISTRADOS EN EL SISTEMA:**
${equipmentContext}`;

    // System prompt listo
    const systemPrompt = replaceVariables(SYSTEM_PROMPT, {
      ...systemVars,
      schedule_context: scheduleContext,
      departments_context: departmentsContext,
      products_context: productsContext,
      user_context: userContext,
    });

    logger.debug(`[GEMINI] Context sizes - Departments: ${departmentsContext.length} chars, Products: ${productsContext.length} chars, Equipment: ${equipmentContext.length} chars`);

    // Limpiar historial para el chat de Gemini
    const geminiHistory: any[] = [];
    for (const msg of history) {
      if (msg.role === 'USER') {
        geminiHistory.push({ role: 'user', parts: [{ text: msg.content }] });
      } else if (msg.role === 'ASSISTANT') {
        geminiHistory.push({ role: 'model', parts: [{ text: msg.content }] });
      }
    }
    while (geminiHistory.length > 0 && geminiHistory[0].role !== 'user') {
      geminiHistory.shift();
    }
    const validatedHistory: any[] = [];
    let lastRole: string | null = null;
    for (const msg of geminiHistory) {
      if (lastRole === null || lastRole !== msg.role) {
        validatedHistory.push(msg);
        lastRole = msg.role;
      }
    }

    // Crear chat Gemini
    const model = await getGeminiModel();
    const chat = model.startChat({
      history: validatedHistory,
      systemInstruction: {
        role: 'system',
        parts: [{ text: systemPrompt }],
      },
    });

    // 🖼 MENSAJE FINAL ENRIQUECIDO QUE LE PASAMOS AL MODELO
    let finalMessage = messageText;
    
    if (hasImage && imageAnalysis) {
      finalMessage += `\n\n[INFORMACIÓN DE LA IMAGEN ENVIADA POR EL USUARIO]\n${imageAnalysis}`;
    }
    
    if (anydeskCode) {
      finalMessage += `\n\n[ID ANYDESK DETECTADO DEL USUARIO: ${anydeskCode}]\nIncluye este ID en tu respuesta solo una vez.`;
    }

    // 🆕 INSTRUCCIÓN EXTRA SI ES REMOTO
    if (hasRemoteSupportIntent) {
      finalMessage += `

[INSTRUCCIONES IMPORTANTES PARA TU RESPUESTA AL CLIENTE]
- El usuario está pidiendo ASISTENCIA REMOTA.
- Debes PEDIR su ID de AnyDesk (9 dígitos) o que mande una foto de la pantalla de AnyDesk.
- Di que un técnico se puede conectar.
- Mantén el tono calmado y directo.
- Recuerda que DESPUÉS se agregará un enlace del sistema automáticamente. No digas que no tienes acceso.
`;
    }

    logger.info(`[GEMINI] Sending enriched message (${finalMessage.length} chars)`);

    const result = await chat.sendMessage(finalMessage);
    let response = result.response.text();

    logger.info(`[GEMINI] Initial response: ${response.substring(0, 100)}...`);

    // 🎯 POST-PROCESAMIENTO: Agregar enlace SI corresponde y NO se envió recientemente
    // Casos que requieren link:
    // - servicio técnico normal
    // - soporte remoto (remoteSupportIntent)
    // - compra de tóner
    const needsLink = (hasServiceIntent || hasRemoteSupportIntent || hasTonerIntent);

    if (needsLink && customerInfo) {
      logger.info(`[GEMINI] Intent detected, generating link with equipment context...`);
      
      // Si tiene un solo equipo, pre-seleccionarlo
      const equipmentId = customerInfo.equipment.length === 1 
        ? customerInfo.equipment[0].id 
        : undefined;
      
      const serviceUrl = await odooService.getOdooServiceLink(
        contact.companyName,
        contact.name || 'Usuario',
        phoneNumber,
        equipmentId
      );

      if (serviceUrl && shouldSendNewLink(phoneNumber, serviceUrl)) {
        // Elegimos etiqueta humana
        let intentType = 'tu solicitud';
        if (hasRemoteSupportIntent) {
          intentType = 'asistencia remota';
        } else if (hasServiceIntent) {
          intentType = 'servicio técnico';
        } else if (hasTonerIntent) {
          intentType = 'tóner / insumos';
        }

        // Mensaje contextual según equipos
        let linkMessage = `\n\n🔗 *Enlace para ${intentType}:*\n${serviceUrl}\n\n`;

        if (hasRemoteSupportIntent) {
          // 🆕 Texto específico remoto
          linkMessage += `En este formulario puedes indicar el problema y también tu ID de AnyDesk para que un técnico se conecte. `;
        }

        if (customerInfo.equipment.length === 1) {
          const eq = customerInfo.equipment[0];
          linkMessage += `Nuestro sistema ya reconoce tu equipo ${eq.brand} ${eq.model} (Serie: ${eq.serial}).`;
        } else if (customerInfo.equipment.length > 1) {
          linkMessage += `Ahí podrás seleccionar cuál de tus ${customerInfo.equipment.length} equipos necesita atención.`;
        } else {
          linkMessage += `Ahí podrás indicar el modelo y la serie del equipo que necesita atención.`;
        }

        response += linkMessage;
        trackLinkSent(phoneNumber, serviceUrl);
        logger.info(`[GEMINI] Link added with equipment context (${customerInfo.equipment.length} equipment(s))`);
      } else if (serviceUrl) {
        logger.info(`[GEMINI] Link skipped (recently sent)`);
      } else {
        logger.warn(`[GEMINI] Could not obtain link from Odoo`);
      }
    } else if (needsLink && !customerInfo) {
      logger.info(`[GEMINI] Intent detected but no customer info from Odoo`);
      if (hasRemoteSupportIntent) {
        // fallback remoto si no hay company reconocida
        response += `\n\nPor favor envíame tu ID de AnyDesk (los 9 números) o una foto clara de tu pantalla de AnyDesk para que un técnico se conecte 🧑‍💻.`;
      }
    }

    logger.info(`[GEMINI] Final response: ${response.substring(0, 150)}...`);

    // Guardar respuesta final que se envió al cliente
    await conversationModel.save(phoneNumber, 'ASSISTANT', response);

    return response;
    
  } catch (error) {
    logger.error(`[GEMINI] Error:`, error);
    return 'Lo siento, estoy teniendo problemas para procesar tu mensaje. ¿Podrías intentarlo de nuevo?';
  }
}
