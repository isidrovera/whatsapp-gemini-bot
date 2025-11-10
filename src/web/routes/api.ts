// src/web/routes/api.ts
import express, { Request, Response } from 'express';
import { logger } from '../../utils/logger.js';
import {
  sendDirectMessage,
  sendMediaToPhone,
} from '../../services/whatsapp.js';
import { validateApiKey } from '../middleware/auth.js';

const router = express.Router();

// Extiende Request para incluir la propiedad que inyecta el middleware
interface RequestWithApiKey extends Request {
  apiKey?: { 
    id: string;
    name: string;
  };
}

interface SendMessageRequest {
  to: string;
  message: string;
}

interface SendMediaRequest {
  to: string;
  caption?: string;
  url?: string;
}

// ================================
// POST /api/send-message
// Enviar mensaje de texto por WhatsApp
// Protegido con validateApiKey (x-api-key)
// ================================
router.post(
  '/send-message',
  validateApiKey,
  async (req: Request, res: Response) => {
    const r = req as RequestWithApiKey;
    try {
      const { to, message } = req.body as SendMessageRequest;

      // Validaciones básicas
      if (!to || !message) {
        return res.status(400).json({
          success: false,
          error: 'Los campos "to" y "message" son requeridos',
        });
      }

      // Validar formato de teléfono (debe venir con código de país)
      const cleanPhone = to.replace(/\D/g, '');
      if (cleanPhone.length < 10) {
        return res.status(400).json({
          success: false,
          error:
            'Formato de teléfono inválido. Debe incluir código de país (ej: 51987654321)',
        });
      }

      logger.info(
        { apiKey: r.apiKey?.name ?? 'unknown-key', to: cleanPhone },
        '[API] Sending message'
      );

      // ahora usamos sendDirectMessage, que devuelve resp de Baileys
      const result = await sendDirectMessage(cleanPhone, message);

      return res.status(200).json({
        success: true,
        data: {
          to: cleanPhone,
          message,
          messageId: result?.key?.id || null,
          sentAt: new Date().toISOString(),
        },
      });
    } catch (e) {
      logger.error({ err: e }, '[API] Error sending message');
      const err = e as any;
      return res.status(500).json({
        success: false,
        error: 'Error al enviar mensaje',
        details: err?.message,
      });
    }
  }
);

// ================================
// POST /api/send-media
// Enviar archivo multimedia al WhatsApp del cliente
//
// Content-Type esperado: multipart/form-data
// Campos soportados:
//   - "to": "51987654321" (requerido)
//   - "caption": "opcional texto"
//   - "file": archivo subido (Buffer)
//   - O alternativamente "url": "https://..." (pendiente implementar)
// ================================
router.post(
  '/send-media',
  validateApiKey,
  async (req: Request, res: Response) => {
    const r = req as RequestWithApiKey;
    try {
      const { to, caption, url } = req.body as SendMediaRequest;
      const file = (req as any).files?.file;

      // Validaciones
      if (!to) {
        return res.status(400).json({
          success: false,
          error: 'El campo "to" es requerido',
        });
      }

      const cleanPhone = to.replace(/\D/g, '');
      if (cleanPhone.length < 10) {
        return res.status(400).json({
          success: false,
          error:
            'Formato de teléfono inválido. Debe incluir código de país (ej: 51987654321)',
        });
      }

      if (!file && !url) {
        return res.status(400).json({
          success: false,
          error: 'Debe proporcionar un archivo (file) o una URL (url)',
        });
      }

      logger.info(
        { apiKey: r.apiKey?.name ?? 'unknown-key', to: cleanPhone, hasFile: !!file, hasUrl: !!url },
        '[API] Sending media'
      );

      let result: any = null;

      if (file) {
        // Enviar el archivo que subieron vía multipart/form-data
        result = await sendMediaToPhone(cleanPhone, {
          buffer: file.data as Buffer, // si Multer tipa distinto, forzamos a Buffer
          mime: file.mimetype as string,
          fileName: file.name as string,
          caption,
        });
      } else if (url) {
        // (Pendiente) soportar enviar desde URL remota.
        // Para no romper el server, devolvemos 501.
        return res.status(501).json({
          success: false,
          error:
            'Enviar media por URL aún no está implementado en este servidor',
        });
      }

      return res.status(200).json({
        success: true,
        data: {
          to: cleanPhone,
          caption: caption || '',
          messageId: result?.key?.id || null,
          sentAt: new Date().toISOString(),
        },
      });
    } catch (e) {
      logger.error({ err: e }, '[API] Error sending media');
      const err = e as any;
      return res.status(500).json({
        success: false,
        error: 'Error al enviar archivo multimedia',
        details: err?.message,
      });
    }
  }
);
// ================================
// GET /api/groups
// Obtener lista de grupos de WhatsApp
// Protegido con validateApiKey (x-api-key)
// ================================
router.get(
  '/groups',
  validateApiKey,
  async (req: Request, res: Response) => {
    const r = req as RequestWithApiKey;
    try {
      logger.info(
        { apiKey: r.apiKey?.name ?? 'unknown-key' },
        '[API] Getting WhatsApp groups'
      );

      // Obtener grupos de WhatsApp
      const { getWhatsAppGroups } = await import('../../services/whatsapp.js');
      
      const groups = await getWhatsAppGroups();

      logger.info(`[API] Found ${groups.length} groups`);

      return res.status(200).json({
        success: true,
        data: groups,
      });
    } catch (e) {
      logger.error({ err: e }, '[API] Error getting groups');
      const err = e as any;
      return res.status(500).json({
        success: false,
        error: 'Error al obtener grupos de WhatsApp',
        details: err?.message,
      });
    }
  }
);
export default router;