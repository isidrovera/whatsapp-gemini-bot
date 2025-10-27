// src/services/odoo.ts
import { logger } from '../utils/logger.js'
import fetch from 'node-fetch'
import { get as getConfig } from '../models/configuration.js'

export interface OdooEquipment {
  id: number;
  brand: string;
  model: string;
  serial: string;
  type: string;
  status: string;
  contract_start?: string;
  contract_end?: string;
}

export interface OdooCustomerInfo {
  url: string;
  customer_name: string;
  customer_id: number;
  equipment: OdooEquipment[];
  last_toner_purchase?: {
    product: string;
    model: string;
    date: string;
  };
}

interface OdooResponse {
  result?: OdooCustomerInfo;
  error?: any;
  message?: string;
}

/**
 * Normaliza una cadena para comparaciones/lógicas internas.
 * (Ahora mismo no lo estamos usando activamente, pero lo dejamos utilitario.)
 */
function normalize(str: string) {
  return (str || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .trim()
}

/**
 * Mapea el estado interno de Odoo (estado_alquiler_id)
 * a un texto humano amigable para el cliente.
 */
function humanStatus(raw?: string): string {
  if (!raw) return 'Estado desconocido';

  const map: Record<string, string> = {
    sin_revisar: 'Sin revisar',
    revisada: 'Revisada en taller',
    lista: 'Lista para entrega',
    alquilada: 'En alquiler (activo)',
    con_problemas: 'Con problemas reportados',
    partes: 'Para repuestos',
    externo: 'Equipo externo',
    vendida: 'Equipo vendido',
  };

  return map[raw] || raw;
}

/**
 * Inicialización/health-check de Odoo.
 * - Verifica que el endpoint responde.
 * - Lanza error si no se puede conectar.
 */
export async function initializeOdoo(): Promise<void> {
  logger.info('[ODOO] Initializing Odoo integration...')
  try {
    const baseUrl = await getConfig('odoo', 'url')
    if (!baseUrl) {
      throw new Error('Missing configuration odoo.url')
    }

    const resp = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'call',
        params: { name: 'ping' },
      }),
    })

    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}`)
    }

    const data = (await resp.json()) as OdooResponse
    if (data?.error) {
      logger.warn('[ODOO] Health-check returned error payload:', data.error)
    }

    logger.info('[ODOO] Odoo integration ready ✅')
  } catch (err: any) {
    logger.error('[ODOO] Health-check failed:', err?.message ?? err)
    throw new Error(`Odoo initialization failed: ${err?.message ?? String(err)}`)
  }
}

/**
 * Obtiene información completa del cliente desde Odoo.
 * Incluye: link para la web pública, equipos, y (opcional) última compra de tóner.
 */
export async function getCustomerInfo(
  companyName: string,
  userName: string,
  phoneNumber: string
): Promise<OdooCustomerInfo | null> {
  try {
    const ODOO_SEARCH_URL = await getConfig('odoo', 'url')
    if (!ODOO_SEARCH_URL) {
      logger.warn('[ODOO] odoo.url not configured in settings')
      return null
    }

    logger.info(`[ODOO] Getting customer info for: ${companyName}`)

    const odooResponse = await fetch(ODOO_SEARCH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'call',
        params: { name: companyName },
      }),
    })

    if (!odooResponse.ok) {
      logger.warn(`[ODOO] HTTP ${odooResponse.status} from Odoo endpoint`)
      return null
    }

    const data = (await odooResponse.json()) as OdooResponse

    // data.result viene de customer_search() en Odoo
    if (data.result?.url) {
      // Agregamos los parámetros dinámicos al URL público que verá el cliente
      const baseUrl = data.result.url
      const fullUrl =
        `${baseUrl}` +
        `&user_name=${encodeURIComponent(userName)}` +
        `&phone_number=${encodeURIComponent(phoneNumber)}`

      const customerInfo: OdooCustomerInfo = {
        url: fullUrl,
        customer_name: data.result.customer_name,
        customer_id: data.result.customer_id,
        equipment: data.result.equipment || [],
        last_toner_purchase: data.result.last_toner_purchase,
      }

      logger.info(
        `[ODOO] Customer info obtained: ${customerInfo.equipment.length} equipment(s) found`
      )
      return customerInfo
    } else {
      logger.warn(
        `[ODOO] No URL found in response for company: ${companyName}`
      )
      if (data.message) {
        logger.info(`[ODOO] Message: ${data.message}`)
      }
      return null
    }
  } catch (error) {
    logger.error('[ODOO] Error connecting to Odoo API:', error)
    return null
  }
}

/**
 * Retorna solo el enlace público al portal técnico,
 * opcionalmente apuntando a un equipo específico.
 * (Mantiene compatibilidad con código anterior.)
 */
export async function getOdooServiceLink(
  companyName: string,
  userName: string,
  phoneNumber: string,
  equipmentId?: number  // para pre-seleccionar el equipo
): Promise<string | null> {
  const customerInfo = await getCustomerInfo(companyName, userName, phoneNumber)

  if (!customerInfo) {
    return null
  }

  let url = customerInfo.url

  // Si se especifica un equipo, lo agregamos a la URL
  if (equipmentId) {
    url += `&equipment_id=${equipmentId}`
  }

  return url
}

/**
 * Formatea la info del cliente (equipos, estado, etc.)
 * para que el modelo (Gemini) tenga contexto y pueda responderle
 * al cliente en WhatsApp con datos reales.
 */
export function formatEquipmentContext(customerInfo: OdooCustomerInfo | null): string {
  if (!customerInfo || !customerInfo.equipment || customerInfo.equipment.length === 0) {
    return 'El cliente NO tiene equipos registrados en el sistema.';
  }

  let context = `Equipos del cliente:\n`;

  customerInfo.equipment.forEach((eq, index) => {
    const startFormatted = eq.contract_start
      ? new Date(eq.contract_start).toLocaleDateString('es-PE')
      : null;
    const endFormatted = eq.contract_end
      ? new Date(eq.contract_end).toLocaleDateString('es-PE')
      : null;

    context += `\n${index + 1}. ${eq.brand || 'Sin marca'} ${eq.model || ''}\n`;
    context += `   Serie: ${eq.serial || 'Sin serie'}\n`;
    context += `   Estado: ${humanStatus(eq.status)}\n`;
    context += `   Tipo: ${eq.type === 'alquilado' ? 'Equipo Alquilado ✅' : 'Propiedad del Cliente'}\n`;

    if (startFormatted) {
      context += `   Contrato desde: ${startFormatted}\n`;
    }
    if (endFormatted) {
      context += `   Contrato hasta: ${endFormatted}\n`;
    }
  });

  if (customerInfo.last_toner_purchase) {
    context += `\nÚltima compra de tóner:\n`;
    context += `   Producto: ${customerInfo.last_toner_purchase.product}\n`;
    context += `   Modelo: ${customerInfo.last_toner_purchase.model}\n`;
    context += `   Fecha: ${new Date(customerInfo.last_toner_purchase.date).toLocaleDateString('es-PE')}\n`;
  }

  return context;
}

/**
 * Detecta si el usuario está pidiendo soporte técnico / visita técnica.
 */
export function detectServiceIntent(message: string): boolean {
  const serviceKeywords = [
    'servicio', 'tecnico', 'técnico', 'reparar', 'reparación',
    'falla', 'problema', 'no funciona', 'no imprime', 'error',
    'atascado', 'atasco', 'ayuda', 'asistencia', 'anydesk',
    'soporte', 'arreglar', 'revisar', 'mantenimiento', 'visita',
    'ir tecnico', 'que vaya el tecnico', 'venir tecnico'
  ];
  const lowerMessage = message.toLowerCase();
  return serviceKeywords.some(k => lowerMessage.includes(k));
}

/**
 * Detecta si el usuario está pidiendo tóner / consumible.
 */
export function detectTonerIntent(message: string): boolean {
  const tonerKeywords = [
    'toner', 'tóner', 'tonner', 'tinta', 'cartucho',
    'consumible', 'consumibles', 'recarga', 'comprar',
  ];
  const lowerMessage = message.toLowerCase();
  return tonerKeywords.some(k => lowerMessage.includes(k));
}
