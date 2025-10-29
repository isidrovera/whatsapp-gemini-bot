// src/services/imageProcessor.ts
import { downloadMediaMessage } from '@whiskeysockets/baileys';
import type { proto } from '@whiskeysockets/baileys';
import { logger } from '../utils/logger.js';
import { getGeminiModel } from '../config/gemini.js';

// Límite recomendado por Gemini para contenido inlineData (~20MB)
const INLINE_SIZE_LIMIT_BYTES = 20 * 1024 * 1024; // 20 MB aprox

/** Resultado estructurado para cualquier medio procesado */
export interface MediaAnalysisResult {
  rawSummary: string;            // resumen breve del contenido ("Pantalla muestra error E000280-0004", "Audio describe ruido fuerte", etc.)
  ocrText?: string | null;       // texto leíble / transcripción breve
  detectedSerial?: string | null;
  detectedErrorCode?: string | null;
  detectedCompany?: string | null;
  detectedAnydesk?: string | null;
  mediaTypeClass?: string | null; // anydesk | serie | error_screen | document | hardware_damage | audio | video | pdf | otro
  tooLargeForInline?: boolean;    // true si el archivo excede el límite inline de Gemini
}

/** Tipo del medio de un mensaje entrante de WhatsApp */
export function getMediaType(
  message: proto.IWebMessageInfo
): 'image' | 'video' | 'audio' | 'document' | null {
  const content = message.message;
  if (!content) return null;
  if (content.imageMessage) return 'image';
  if (content.videoMessage) return 'video';
  if (content.audioMessage) return 'audio';
  if (content.documentMessage) return 'document';
  return null;
}

/** Descarga buffer + mime + nombre de archivo (si aplica) desde Baileys */
export async function downloadMediaFromMessage(
  message: proto.IWebMessageInfo
): Promise<{ buffer: Buffer; mimeType: string; fileName?: string }> {
  const type = getMediaType(message);
  if (!type) throw new Error('No media content in message');

  const content = message.message!;
  let mimeType = 'application/octet-stream';
  let fileName: string | undefined;

  if (type === 'image') mimeType = content.imageMessage?.mimetype || 'image/jpeg';
  if (type === 'video') mimeType = content.videoMessage?.mimetype || 'video/mp4';
  if (type === 'audio') mimeType = content.audioMessage?.mimetype || 'audio/ogg';
  if (type === 'document') {
    mimeType = content.documentMessage?.mimetype || 'application/octet-stream';
    fileName = content.documentMessage?.fileName || 'document';
  }

  logger.info(`[MEDIA] Downloading "${type}" (${mimeType}) ...`);

  const buffer = await downloadMediaMessage(
    message,
    'buffer',
    {},
    {
      logger: logger as any,
      reuploadRequest: () => Promise.resolve({} as any),
    }
  );

  if (!buffer || !(buffer instanceof Buffer)) {
    throw new Error('downloadMediaMessage returned empty buffer');
  }

  logger.info(
    `[MEDIA] Downloaded ${buffer.length} bytes (${type}) ${fileName ? `[${fileName}]` : ''}`
  );

  return { buffer, mimeType, fileName };
}

/* ------------------------- Utilidades de parsing ------------------------- */

/**
 * Gemini a veces devuelve:
 * { "summary": "...", ... }
 * y a veces
 * ```json
 * { ... }
 * ```
 * safeParseGeminiJSON intenta rescatar el bloque {...}.
 */
function safeParseGeminiJSON(raw: string): {
  summary?: string;
  ocrText?: string;
  serial?: string;
  errorCode?: string;
  anydeskId?: string;
  companyName?: string;
  class?: string;
} | null {
  if (!raw) return null;

  // intentamos ubicar el primer '{' y el último '}'
  const i = raw.indexOf('{');
  const j = raw.lastIndexOf('}');
  if (i === -1 || j === -1 || j <= i) return null;

  const json = raw.slice(i, j + 1).trim();
  try {
    return JSON.parse(json);
  } catch (err) {
    logger.warn('[GEMINI] JSON parse failed; returning null');
    return null;
  }
}

/**
 * Heurísticas locales por regex en caso el modelo no devuelva datos limpios.
 * Extraemos posibles:
 *  - ID AnyDesk (9 dígitos)
 *  - número de serie
 *  - código de error tipo E000280-0004, C2556, etc.
 *  - nombre de empresa básico
 */
function extractStructuredFieldsFromText(text: string): {
  anydesk?: string | null;
  serial?: string | null;
  errorCode?: string | null;
  company?: string | null;
} {
  const result: any = {};
  const normalized = (text || '').replace(/\s+/g, ' ').trim();

  // AnyDesk: 9 dígitos
  const anydeskRegex = /(?:anydesk|id|code|c[oó]digo)?\D*(\d{3})\s?(\d{3})\s?(\d{3})/i;
  const m1 = normalized.match(anydeskRegex);
  if (m1) {
    const joined = `${m1[1]}${m1[2]}${m1[3]}`;
    if (joined.length === 9) result.anydesk = joined;
  }

  // Serie / Serial / S/N
  const serialRegex = /(serie|serial|s\/?n)[:\s\-]*([a-z0-9\-\/]{4,})/i;
  const m2 = normalized.match(serialRegex);
  if (m2) result.serial = m2[2].trim();

  // Error code tipo "E000280-0004", "C2556", etc.
  const errorRegex = /\b([A-Z]?\d{3,4}[--–]\d{3,4}|E\d{3,4}[--–]\d{3,4}|C\d{3,5})\b/;
  const m3 = normalized.match(errorRegex);
  if (m3) result.errorCode = m3[1].replace(/[-–]/g, '-');

  // Empresa / Razón Social
  const companyRegex = /(raz[oó]n social|cliente|empresa)\s*[:\-]\s*([A-Z0-9 \-&\.]{3,})/i;
  const m4 = normalized.match(companyRegex);
  if (m4) result.company = m4[2].trim();

  return result;
}

/* --------------------------- Prompts por tipo ---------------------------- */
/**
 * Nota importante:
 * Pedimos SIEMPRE un JSON plano sin ``` ni texto extra.
 * Esto reduce la probabilidad de tener que limpiar demasiado.
 */

function buildImagePrompt() {
  return `
Devuélveme SOLO un JSON válido y nada más, sin backticks.
Analiza la IMAGEN adjunta (pantalla de impresora, error, foto de PC, etiqueta de serie, etc).
Extrae datos útiles para soporte técnico.

Formato EXACTO:
{
  "summary": "1 línea explicando qué se ve en la imagen (ej: 'Pantalla muestra error E000280-0004')",
  "ocrText": "texto leído principal, si hay",
  "serial": "número de serie si está visible",
  "errorCode": "código de error o alerta si está visible (E000280-0004, C2556, etc)",
  "anydeskId": "ID remoto de AnyDesk si aparece (9 dígitos)",
  "companyName": "nombre de la empresa/cliente visible si aparece en la imagen",
  "class": "anydesk | serie | error_screen | hardware_damage | document | otro"
}
Si algo no aplica, usa "".
`.trim();
}

function buildAudioPrompt() {
  return `
Devuélveme SOLO un JSON válido y nada más, sin backticks.
Analiza el AUDIO adjunto. Resume brevemente qué dice el usuario o qué sonido se escucha.

Formato EXACTO:
{
  "summary": "1 línea con el problema descrito en el audio",
  "ocrText": "transcripción/resumen corto del audio",
  "serial": "número de serie mencionado si lo hay",
  "errorCode": "código de error mencionado si lo hay",
  "anydeskId": "ID AnyDesk (9 dígitos) si lo dictan",
  "companyName": "nombre de empresa si se escucha",
  "class": "audio"
}
Si algo no aplica, usa "".
`.trim();
}

function buildVideoPrompt() {
  return `
Devuélveme SOLO un JSON válido y nada más, sin backticks.
Analiza el VIDEO adjunto: describe qué problema visual se ve (atasco, papel trabado, bandeja rota, pantalla con error), y qué se escucha decir.

Formato EXACTO:
{
  "summary": "1 línea sobre la falla visible o comportamiento",
  "ocrText": "transcripción/resumen corto del audio y/o texto en pantalla",
  "serial": "número de serie visible o mencionado",
  "errorCode": "código de error visible en el panel si lo hay",
  "anydeskId": "ID AnyDesk si el video muestra escritorio con AnyDesk",
  "companyName": "nombre de empresa / etiqueta si aparece",
  "class": "video"
}
Si algo no aplica, usa "".
`.trim();
}

function buildPdfPrompt() {
  return `
Devuélveme SOLO un JSON válido y nada más, sin backticks.
Analiza el DOCUMENTO adjunto (PDF/factura/reporte). Resume el contenido y extrae datos técnicos útiles (n° de serie, código de error, cliente).

Formato EXACTO:
{
  "summary": "1 línea con de qué trata el documento",
  "ocrText": "texto relevante / campos clave",
  "serial": "número de serie del equipo si existe",
  "errorCode": "código de error/reporte técnico si hay",
  "anydeskId": "ID AnyDesk si aparece",
  "companyName": "Razón Social / Cliente detectada",
  "class": "pdf"
}
Si algo no aplica, usa "".
`.trim();
}

/* ------------------------ Llamada a Gemini ------------------------ */

/**
 * En la doc que pegaste, para enviar contenido multimodal pequeño
 * se usa "generateContent({ model, contents: [...] })".
 *
 * Nuestro wrapper getGeminiModel() hoy expone:
 *   - model.generateContent(parts)
 * donde "parts" es básicamente ese arreglo `contents`.
 *
 * OJO: si el archivo pesa más de ~20MB no debemos mandarlo inline.
 */
async function geminiGenerateInline(parts: any[]): Promise<string> {
  const model = getGeminiModel();
  // IMPORTANTE: si tu wrapper actual es model.generateContent(parts)
  // y NO model.models.generateContent({...}), seguimos tu convención local.
  const res = await model.generateContent(parts);
  const txt = res?.response?.text?.() || '';
  logger.info(`[GEMINI] response length=${txt.length}`);
  return txt;
}

/* ---------------------- Helpers internos comunes ------------------- */

function buildFallbackResult(
  kind: string,
  opts?: Partial<MediaAnalysisResult>
): MediaAnalysisResult {
  return {
    rawSummary:
      opts?.rawSummary ||
      (kind === 'image'
        ? 'Imagen recibida (análisis no disponible).'
        : kind === 'video'
        ? 'Video recibido (análisis no disponible).'
        : kind === 'audio'
        ? 'Audio recibido (análisis no disponible).'
        : kind === 'document'
        ? 'Documento recibido (análisis no disponible).'
        : 'Archivo recibido (análisis no disponible).'),
    ocrText: opts?.ocrText ?? null,
    detectedSerial: opts?.detectedSerial ?? null,
    detectedErrorCode: opts?.detectedErrorCode ?? null,
    detectedCompany: opts?.detectedCompany ?? null,
    detectedAnydesk: opts?.detectedAnydesk ?? null,
    mediaTypeClass: opts?.mediaTypeClass ?? kind,
    tooLargeForInline: opts?.tooLargeForInline ?? false,
  };
}

/**
 * Dado el JSON parseado de Gemini + heurísticas locales,
 * construye el MediaAnalysisResult final (normalizado).
 */
function normalizeGeminiResult(
  parsed: any,
  rawWhole: string,
  fallbackClass: string
): MediaAnalysisResult {
  // usamos el bloque parseado si existe
  const summary = parsed?.summary?.trim() || '';
  const ocrText = parsed?.ocrText?.trim() || '';
  const serial = parsed?.serial?.trim() || '';
  const errCode = parsed?.errorCode?.trim() || '';
  const anydeskId = parsed?.anydeskId?.trim() || '';
  const companyName = parsed?.companyName?.trim() || '';
  const klass = parsed?.class?.trim() || '';

  // heurística secundaria sobre todo el texto crudo
  const joinedHeuristic = [
    summary,
    ocrText,
    serial,
    errCode,
    anydeskId,
    companyName,
    rawWhole,
  ]
    .filter(Boolean)
    .join('\n');

  const hints = extractStructuredFieldsFromText(joinedHeuristic);

  return {
    rawSummary:
      summary ||
      'Archivo recibido (resumen no disponible todavía).',
    ocrText: ocrText || null,
    detectedSerial: serial || hints.serial || null,
    detectedErrorCode: errCode || hints.errorCode || null,
    detectedCompany: companyName || hints.company || null,
    detectedAnydesk: anydeskId || hints.anydesk || null,
    mediaTypeClass: klass || fallbackClass || 'otro',
    tooLargeForInline: false,
  };
}

/* ---------------------- Procesadores por tipo de medio ------------------- */

/**
 * TODOS los processX devuelven SIEMPRE MediaAnalysisResult.
 * Ya no devolvemos null salvo caso extremo (sin buffer).
 * Esto ayuda a que whatsapp.ts y gemini.ts siempre tengan datos.
 */

export async function processImage(
  message: proto.IWebMessageInfo
): Promise<MediaAnalysisResult> {
  try {
    const { buffer, mimeType } = await downloadMediaFromMessage(message);

    // chequeo de tamaño inline
    if (buffer.length > INLINE_SIZE_LIMIT_BYTES) {
      logger.warn(
        `[IMAGE] Skipping Gemini call: file too large (${buffer.length} bytes)`
      );
      return buildFallbackResult('image', {
        rawSummary:
          'Imagen recibida. (Es muy pesada para análisis automático inmediato).',
        tooLargeForInline: true,
      });
    }

    const base64 = buffer.toString('base64');
    logger.info('[IMAGE] Analyzing with Gemini Vision ...');

    const rawResponse = await geminiGenerateInline([
      {
        inlineData: {
          mimeType,
          data: base64,
        },
      },
      { text: buildImagePrompt() },
    ]);

    const parsed = safeParseGeminiJSON(rawResponse);

    if (!parsed) {
      // no pudimos parsear el JSON -> fallback heurístico
      const hints = extractStructuredFieldsFromText(rawResponse);
      return buildFallbackResult('image', {
        rawSummary: 'Imagen recibida (pendiente de análisis).',
        ocrText: null,
        detectedSerial: hints.serial || null,
        detectedErrorCode: hints.errorCode || null,
        detectedCompany: hints.company || null,
        detectedAnydesk: hints.anydesk || null,
        mediaTypeClass: 'otro',
      });
    }

    const result = normalizeGeminiResult(parsed, rawResponse, 'image');
    logger.info('[IMAGE] Analysis:', result);
    return result;
  } catch (err: any) {
    logger.error('[IMAGE] processImage failed:', {
      message: err?.message,
      stack: err?.stack,
    });
    return buildFallbackResult('image', {
      rawSummary: 'Imagen recibida (análisis falló).',
    });
  }
}

export async function processAudio(
  message: proto.IWebMessageInfo
): Promise<MediaAnalysisResult> {
  try {
    const { buffer, mimeType } = await downloadMediaFromMessage(message);

    if (buffer.length > INLINE_SIZE_LIMIT_BYTES) {
      logger.warn(
        `[AUDIO] Skipping Gemini call: file too large (${buffer.length} bytes)`
      );
      return buildFallbackResult('audio', {
        rawSummary:
          'Audio recibido. (Archivo muy grande para análisis automático inline).',
        tooLargeForInline: true,
      });
    }

    const base64 = buffer.toString('base64');
    logger.info('[AUDIO] Analyzing with Gemini ...');

    // En audio, según la guía, es válido mandar texto primero o después.
    // Vamos a mandar primero el prompt, luego el audio.
    const rawResponse = await geminiGenerateInline([
      { text: buildAudioPrompt() },
      {
        inlineData: {
          mimeType,
          data: base64,
        },
      },
    ]);

    const parsed = safeParseGeminiJSON(rawResponse);
    if (!parsed) {
      const hints = extractStructuredFieldsFromText(rawResponse);
      return buildFallbackResult('audio', {
        rawSummary: 'Audio recibido (transcripción breve no disponible).',
        detectedSerial: hints.serial || null,
        detectedErrorCode: hints.errorCode || null,
        detectedCompany: hints.company || null,
        detectedAnydesk: hints.anydesk || null,
        mediaTypeClass: 'audio',
      });
    }

    const result = normalizeGeminiResult(parsed, rawResponse, 'audio');
    logger.info('[AUDIO] Analysis:', result);
    return result;
  } catch (err: any) {
    logger.error('[AUDIO] processAudio failed:', {
      message: err?.message,
      stack: err?.stack,
    });
    return buildFallbackResult('audio', {
      rawSummary: 'Audio recibido (análisis falló).',
    });
  }
}

export async function processVideo(
  message: proto.IWebMessageInfo
): Promise<MediaAnalysisResult> {
  try {
    const { buffer, mimeType } = await downloadMediaFromMessage(message);

    if (buffer.length > INLINE_SIZE_LIMIT_BYTES) {
      logger.warn(
        `[VIDEO] Skipping Gemini call: file too large (${buffer.length} bytes)`
      );
      return buildFallbackResult('video', {
        rawSummary:
          'Video recibido. (Demasiado grande para análisis automático inline).',
        tooLargeForInline: true,
      });
    }

    const base64 = buffer.toString('base64');
    logger.info('[VIDEO] Analyzing with Gemini ...');

    // Para video, según guía, se suele mandar primero el video y luego el texto.
    const rawResponse = await geminiGenerateInline([
      {
        inlineData: {
          mimeType,
          data: base64,
        },
      },
      { text: buildVideoPrompt() },
    ]);

    const parsed = safeParseGeminiJSON(rawResponse);
    if (!parsed) {
      const hints = extractStructuredFieldsFromText(rawResponse);
      return buildFallbackResult('video', {
        rawSummary: 'Video recibido (resumen breve no disponible).',
        detectedSerial: hints.serial || null,
        detectedErrorCode: hints.errorCode || null,
        detectedCompany: hints.company || null,
        detectedAnydesk: hints.anydesk || null,
        mediaTypeClass: 'video',
      });
    }

    const result = normalizeGeminiResult(parsed, rawResponse, 'video');
    logger.info('[VIDEO] Analysis:', result);
    return result;
  } catch (err: any) {
    logger.error('[VIDEO] processVideo failed:', {
      message: err?.message,
      stack: err?.stack,
    });
    return buildFallbackResult('video', {
      rawSummary: 'Video recibido (análisis falló).',
    });
  }
}

export async function processDocument(
  message: proto.IWebMessageInfo
): Promise<MediaAnalysisResult> {
  try {
    const { buffer, mimeType, fileName } = await downloadMediaFromMessage(
      message
    );

    const isPdf = mimeType === 'application/pdf';

    if (buffer.length > INLINE_SIZE_LIMIT_BYTES) {
      logger.warn(
        `[DOCUMENT] Skipping Gemini call: file too large (${buffer.length} bytes)`
      );
      return buildFallbackResult(isPdf ? 'pdf' : 'document', {
        rawSummary: `Documento recibido (${fileName || 'documento'}). Es muy grande para análisis inline inmediato.`,
        mediaTypeClass: isPdf ? 'pdf' : 'document',
        tooLargeForInline: true,
      });
    }

    const base64 = buffer.toString('base64');
    logger.info(
      `[DOCUMENT] Detected "${fileName || 'document'}" (${mimeType})`
    );

    // Para PDF según la guía: podemos mandar primero la instrucción y luego el inlineData
    const rawResponse = await geminiGenerateInline([
      { text: buildPdfPrompt() },
      {
        inlineData: {
          mimeType,
          data: base64,
        },
      },
    ]);

    const parsed = safeParseGeminiJSON(rawResponse);
    if (!parsed) {
      const hints = extractStructuredFieldsFromText(rawResponse);
      return buildFallbackResult(isPdf ? 'pdf' : 'document', {
        rawSummary: `Documento recibido: "${
          fileName || 'documento'
        }" (${mimeType}).`,
        detectedSerial: hints.serial || null,
        detectedErrorCode: hints.errorCode || null,
        detectedCompany: hints.company || null,
        detectedAnydesk: hints.anydesk || null,
        mediaTypeClass: isPdf ? 'pdf' : 'document',
      });
    }

    const result = normalizeGeminiResult(
      parsed,
      rawResponse,
      isPdf ? 'pdf' : 'document'
    );

    // Si Gemini devolvió class vacío pero sabemos que es pdf -> forzamos
    if ((!result.mediaTypeClass || result.mediaTypeClass === 'otro') && isPdf) {
      result.mediaTypeClass = 'pdf';
    }
    logger.info('[DOCUMENT] Analysis:', result);
    return result;
  } catch (err: any) {
    logger.error('[DOCUMENT] processDocument failed:', {
      message: err?.message,
      stack: err?.stack,
    });
    return buildFallbackResult('document', {
      rawSummary: 'Documento recibido (análisis falló).',
    });
  }
}

/** Compatibilidad: extrae AnyDesk de un resultado estructurado */
export function extractAnydeskCodeFromAnalysis(
  analysis: MediaAnalysisResult | null
): string | null {
  if (!analysis) return null;
  if (
    analysis.detectedAnydesk &&
    analysis.detectedAnydesk.replace(/\D/g, '').length === 9
  ) {
    return analysis.detectedAnydesk.replace(/\D/g, '');
  }
  return null;
}
