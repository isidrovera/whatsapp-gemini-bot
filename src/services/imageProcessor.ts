import { downloadMediaMessage } from '@whiskeysockets/baileys';
import { logger } from '../utils/logger.js';
import { getGeminiModel } from '../config/gemini.js';
import type { proto } from '@whiskeysockets/baileys';

/**
 * Determina el tipo de medio del mensaje
 */
export function getMediaType(message: proto.IWebMessageInfo): 'image' | 'video' | 'audio' | 'document' | null {
  const content = message.message;
  
  if (!content) return null;
  
  if (content.imageMessage) return 'image';
  if (content.videoMessage) return 'video';
  if (content.audioMessage) return 'audio';
  if (content.documentMessage) return 'document';
  
  return null;
}

/**
 * Descarga y procesa una imagen con Gemini Vision
 */
export async function processImage(message: proto.IWebMessageInfo): Promise<string | null> {
  try {
    logger.info('[IMAGE] Downloading image from message...');
    
    const buffer = await downloadMediaMessage(
      message,
      'buffer',
      {},
      {
        logger: logger as any,
        reuploadRequest: () => Promise.resolve({} as any),
      }
    );

    if (!buffer) {
      logger.error('[IMAGE] Failed to download image');
      return null;
    }

    const base64Image = buffer.toString('base64');
    logger.info(`[IMAGE] Image downloaded successfully (${buffer.length} bytes)`);

    const analysis = await analyzeImageWithGemini(base64Image);
    
    return analysis;

  } catch (error) {
    logger.error('[IMAGE] Error processing image:', error);
    return null;
  }
}

/**
 * Procesa un video (extrae frame y analiza)
 */
export async function processVideo(message: proto.IWebMessageInfo): Promise<string | null> {
  try {
    logger.info('[VIDEO] Video detected');
    
    // Por ahora, Gemini no soporta video directamente en la API básica
    // Retornamos un mensaje indicando que se recibió un video
    const caption = message.message?.videoMessage?.caption;
    
    return `El usuario envió un video${caption ? ` con el mensaje: "${caption}"` : ''}. Los videos aún no pueden ser analizados automáticamente.`;

  } catch (error) {
    logger.error('[VIDEO] Error processing video:', error);
    return null;
  }
}

/**
 * Procesa un audio (transcripción futura)
 */
export async function processAudio(message: proto.IWebMessageInfo): Promise<string | null> {
  try {
    logger.info('[AUDIO] Audio detected');
    
    // Por ahora, retornamos un mensaje indicando que se recibió audio
    // En el futuro se puede integrar Whisper API para transcripción
    
    return `El usuario envió un mensaje de audio/voz. Los audios aún no pueden ser transcritos automáticamente.`;

  } catch (error) {
    logger.error('[AUDIO] Error processing audio:', error);
    return null;
  }
}

/**
 * Procesa un documento
 */
export async function processDocument(message: proto.IWebMessageInfo): Promise<string | null> {
  try {
    const doc = message.message?.documentMessage;
    const fileName = doc?.fileName || 'documento';
    const mimeType = doc?.mimetype || 'desconocido';
    
    logger.info(`[DOCUMENT] Document detected: ${fileName} (${mimeType})`);
    
    return `El usuario envió un documento: "${fileName}" (tipo: ${mimeType})`;

  } catch (error) {
    logger.error('[DOCUMENT] Error processing document:', error);
    return null;
  }
}

/**
 * Analiza una imagen con Gemini Vision
 */
async function analyzeImageWithGemini(base64Image: string): Promise<string | null> {
  try {
    logger.info('[GEMINI-VISION] Analyzing image...');
    
    const model = getGeminiModel();
    
    const prompt = `Analiza esta imagen cuidadosamente y describe:

1. ¿Es una captura de pantalla de AnyDesk? Si es así, extrae el código de 9 dígitos exactamente como aparece.
2. ¿Es una foto de error de impresora o fotocopiadora? Si es así, describe el error visible.
3. ¿Qué tipo de imagen es y qué información relevante contiene para soporte técnico?

Sé preciso y conciso. Si ves un código de AnyDesk, repórtalo en el formato: "Código AnyDesk: XXX XXX XXX"`;

    const result = await model.generateContent([
      {
        inlineData: {
          mimeType: 'image/jpeg',
          data: base64Image,
        },
      },
      { text: prompt },
    ]);

    const analysis = result.response.text();
    logger.info(`[GEMINI-VISION] Analysis complete: ${analysis.substring(0, 100)}...`);
    
    return analysis;

  } catch (error) {
    logger.error('[GEMINI-VISION] Error analyzing image:', error);
    return null;
  }
}

/**
 * Extrae código de AnyDesk de un texto de análisis
 */
export function extractAnydeskCode(text: string): string | null {
  const patterns = [
    /anydesk.*?(\d{3}\s*\d{3}\s*\d{3})/i,
    /código.*?(\d{3}\s*\d{3}\s*\d{3})/i,
    /code.*?(\d{3}\s*\d{3}\s*\d{3})/i,
    /(\d{3}\s*\d{3}\s*\d{3})/,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      const code = match[1].replace(/\s/g, '');
      if (code.length === 9) {
        return code;
      }
    }
  }

  return null;
}