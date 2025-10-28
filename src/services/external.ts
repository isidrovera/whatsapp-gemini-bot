// src/services/external.ts
import axios from 'axios';
import { logger } from '../utils/logger.js';
import * as config from '../models/configuration.js';

/** Normaliza respuesta de RENIEC (v1/dni) aceptando snake/camel */
function normalizeReniec(data: any): { nombres: string; apellidoPaterno: string; apellidoMaterno: string } | null {
  if (!data || typeof data !== 'object') return null;

  const nombres =
    data.nombres ??
    data.Nombres ??
    data.nombre ??
    '';

  const apellidoPaterno =
    data.apellido_paterno ??
    data.apellidoPaterno ??
    '';

  const apellidoMaterno =
    data.apellido_materno ??
    data.apellidoMaterno ??
    '';

  if (!nombres || !(apellidoPaterno || apellidoMaterno)) {
    return null;
  }

  return {
    nombres: String(nombres).trim(),
    apellidoPaterno: String(apellidoPaterno || '').trim(),
    apellidoMaterno: String(apellidoMaterno || '').trim(),
  };
}

/** Normaliza respuesta de SUNAT (v2/sunat/ruc) aceptando snake/camel */
function normalizeSunat(data: any): {
  razonSocial: string;
  estado: string;
  condicion: string;
  direccion: string;
  distrito: string;
  provincia: string;
  departamento: string;
} | null {
  if (!data || typeof data !== 'object') return null;

  const razonSocial =
    data.razon_social ??
    data.razonSocial ??
    data.nombre ??
    data.nombre_o_razon_social ??
    '';

  if (!razonSocial) return null;

  const estado =
    data.estado ??
    data.condicion ?? // a veces "estado" viene vacío y "condicion" tiene HABIDO/NO HABIDO
    '';

  return {
    razonSocial: String(razonSocial).trim(),
    estado: String(data.estado ?? '').trim(),
    condicion: String(data.condicion ?? '').trim(),
    direccion: String(data.direccion ?? '').trim(),
    distrito: String(data.distrito ?? '').trim(),
    provincia: String(data.provincia ?? '').trim(),
    departamento: String(data.departamento ?? '').trim(),
  };
}


/**
 * Obtiene flags/token desde Settings (tabla configurations)
 * category: "external_api"
 * keys:
 *   - enabled: "true" | "false"
 *   - apis_token: token para apis.net.pe
 */
async function getExternalApiConfig(): Promise<{ enabled: boolean; token: string | null }> {
  const enabledStr = await config.get('external_api', 'enabled');
  const token = await config.get('external_api', 'apis_token'); // desencripta si aplica
  const enabled = (enabledStr || '').toLowerCase() === 'true';
  return { enabled, token: token || null };
}

/**
 * Valida DNI con apis.net.pe
 *   GET https://api.apis.net.pe/v1/dni?numero=XXXXXXXX
 * Lee token desde Settings (external_api.apis_token) y enabled (external_api.enabled)
 * Retorna null si: deshabilitado | sin token | respuesta inesperada | error
 */
export async function validateDNI(
  dni: string
): Promise<{ nombres: string; apellidoPaterno: string; apellidoMaterno: string } | null> {
  const clean = String(dni || '').replace(/\D/g, '');
  if (clean.length !== 8) {
    logger.warn(`validateDNI: DNI inválido "${dni}"`);
    return null;
  }

  const { enabled, token } = await getExternalApiConfig();

  if (!enabled) {
    logger.warn('validateDNI: external_api.enabled = false en Settings');
    return null;
  }
  if (!token) {
    logger.warn('validateDNI: external_api.apis_token vacío en Settings');
    return null;
  }

  try {
    logger.info(`Validating DNI (apis.net.pe v1) via Settings: ${clean}`);
    const url = `https://api.apis.net.pe/v1/dni?numero=${encodeURIComponent(clean)}`;

    const response = await axios.get(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
      timeout: 10000,
    });

    logger.info(`DNI DEBUG -> status=${response.status} keys=${Object.keys(response.data || {}).join(',')}`);

    if (response.status === 200 && response.data) {
      const normalized = normalizeReniec(response.data);
      if (normalized) {
        logger.info(`DNI validated: ${normalized.nombres} ${normalized.apellidoPaterno} ${normalized.apellidoMaterno}`);
        return normalized;
      }
    }

    logger.warn('validateDNI: respuesta inesperada de apis.net.pe');
    return null;
  } catch (error: any) {
    if (axios.isAxiosError(error)) {
      const status = error.response?.status;
      const body = typeof error.response?.data === 'object' ? JSON.stringify(error.response?.data) : String(error.response?.data || '');
      logger.error({ status, body }, 'RENIEC API error (apis.net.pe)');
    } else {
      logger.error({ err: error }, 'Error validating DNI');
    }
    return null;
  }
}

/**
 * Valida RUC con apis.net.pe
 *   GET https://api.apis.net.pe/v2/sunat/ruc?numero=XXXXXXXXXXX
 * Lee token desde Settings
 * Retorna null si deshabilitado/sin token/forma inesperada/error
 */
export async function validateRUC(
  ruc: string
): Promise<{ razonSocial: string; estado: string } | null> {
  const clean = String(ruc || '').replace(/\D/g, '');
  if (clean.length !== 11) {
    logger.warn(`validateRUC: RUC inválido "${ruc}"`);
    return null;
  }

  const { enabled, token } = await getExternalApiConfig();

  if (!enabled) {
    logger.warn('validateRUC: external_api.enabled = false en Settings');
    return null;
  }
  if (!token) {
    logger.warn('validateRUC: external_api.apis_token vacío en Settings');
    return null;
  }

  try {
    logger.info(`Validating RUC (apis.net.pe v2) via Settings: ${clean}`);
    const url = `https://api.apis.net.pe/v2/sunat/ruc?numero=${encodeURIComponent(clean)}`;

    const response = await axios.get(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
      timeout: 10000,
    });

    logger.info(`RUC DEBUG -> status=${response.status} keys=${Object.keys(response.data || {}).join(',')}`);

    if (response.status === 200 && response.data) {
    const normalized = normalizeSunat(response.data);
    if (normalized) {
      logger.info(
        `RUC validated: ${normalized.razonSocial} / ${normalized.estado} (${normalized.condicion})`
      );
      return normalized;
    }
  }


    logger.warn('validateRUC: respuesta inesperada de apis.net.pe');
    return null;
  } catch (error: any) {
    if (axios.isAxiosError(error)) {
      const status = error.response?.status;
      const body = typeof error.response?.data === 'object' ? JSON.stringify(error.response?.data) : String(error.response?.data || '');
      logger.error({ status, body }, 'SUNAT API error (apis.net.pe)');
    } else {
      logger.error({ err: error }, 'Error validating RUC');
    }
    return null;
  }
}
