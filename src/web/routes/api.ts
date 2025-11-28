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

      const rawTo = to.toString().trim();
      if (!rawTo) {
        return res.status(400).json({
          success: false,
          error: 'El campo "to" está vacío',
        });
      }

      let targetForSend = rawTo; // lo que enviaremos a sendDirectMessage
      let forLog = rawTo;        // lo que mostramos en log

      if (rawTo.includes('@')) {
        // Caso JID directo (grupo o contacto)
        // Permitimos:
        //   - *@g.us  (grupo)
        //   - *@s.whatsapp.net (contacto)
        //   - *status@broadcast (sistema)
        const allowed = /@(g\.us|s\.whatsapp\.net|broadcast)$/;
        if (!allowed.test(rawTo)) {
          return res.status(400).json({
            success: false,
            error:
              'Formato de JID inválido en "to". Se esperaba *@g.us o *@s.whatsapp.net',
          });
        }
      } else {
        // Caso número normal → validamos como antes
        const cleanPhone = rawTo.replace(/\D/g, '');
        if (cleanPhone.length < 10) {
          return res.status(400).json({
            success: false,
            error:
              'Formato de teléfono inválido. Debe incluir código de país (ej: 51987654321)',
          });
        }
        targetForSend = cleanPhone; // sendDirectMessage se encargará de agregar @s.whatsapp.net
        forLog = cleanPhone;
      }

      logger.info(
        { apiKey: r.apiKey?.name ?? 'unknown-key', to: forLog },
        '[API] Sending message'
      );

      // ahora usamos sendDirectMessage con número O JID
      const result = await sendDirectMessage(targetForSend, message);

      return res.status(200).json({
        success: true,
        data: {
          to: targetForSend,
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

      let target = (to || '').trim();
      const isJid = target.includes('@');

      if (!isJid) {
        // 👉 Número normal
        const cleanPhone = target.replace(/\D/g, '');
        if (cleanPhone.length < 10) {
          return res.status(400).json({
            success: false,
            error:
              'Formato de teléfono inválido. Debe incluir código de país (ej: 51987654321)',
          });
        }
        target = cleanPhone;
      }
      // Si es JID, lo usamos tal cual (grupo/contacto)

      if (!file && !url) {
        return res.status(400).json({
          success: false,
          error: 'Debe proporcionar un archivo (file) o una URL (url)',
        });
      }

      logger.info(
        {
          apiKey: r.apiKey?.name ?? 'unknown-key',
          to: target,
          isJid,
          hasFile: !!file,
          hasUrl: !!url,
        },
        '[API] Sending media'
      );

      let result: any = null;

      if (file) {
        // Enviar el archivo que subieron vía multipart/form-data
        result = await sendMediaToPhone(target, {
          buffer: file.data as Buffer,
          mime: file.mimetype as string,
          fileName: file.name as string,
          caption,
        });
      } else if (url) {
        // (Pendiente) soportar enviar desde URL remota.
        return res.status(501).json({
          success: false,
          error:
            'Enviar media por URL aún no está implementado en este servidor',
        });
      }

      return res.status(200).json({
        success: true,
        data: {
          to: target,
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