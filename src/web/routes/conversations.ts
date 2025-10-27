// src/web/routes/conversations.ts
import express from 'express';
import multer from 'multer';
import { getPrismaClient } from '../../config/database.js';
import { logger } from '../../utils/logger.js';
import { sendMessage, sendMedia, getConnectionStatus, onWhatsAppExists } from '../../services/whatsapp.js';
import { extractPhoneFromJid, normalizePhone } from '../../utils/validators.js';

const router = express.Router();
const prisma = getPrismaClient();

/** ========== Multer para media ========== **/
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB (ajusta si necesitas más)
  fileFilter: (_req, file, cb) => {
    const ok = [
      'image/', 'video/', 'audio/',
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/zip',
      'application/x-zip-compressed'
    ];
    const isOk = ok.some(p => file.mimetype.startsWith(p)) || ok.includes(file.mimetype);
    if (!isOk) return cb(new Error(`Tipo de archivo no permitido: ${file.mimetype}`));
    cb(null, true);
  }
});

/** ========== Página de conversaciones ========== **/
router.get('/', async (_req, res) => {
  try {
    const contacts = await prisma.contact.findMany({
      include: {
        conversations: {
          take: 1,
          orderBy: { createdAt: 'desc' },
        },
      },
      orderBy: { updatedAt: 'desc' },
    });

    res.render('conversations', {
      title: 'Conversaciones',
      contacts
    });
  } catch (error) {
    logger.error('Error loading conversations:', error);
    res.status(500).send('Error loading conversations');
  }
});

/** ========== Historial de un contacto ========== **/
router.get('/api/:phoneNumber', async (req, res) => {
  try {
    const { phoneNumber } = req.params;
    const normalizedPhone = normalizePhone(phoneNumber);

    const [messages, contact] = await Promise.all([
      prisma.conversationHistory.findMany({
        where: { phoneNumber: normalizedPhone },
        orderBy: { createdAt: 'asc' },
      }),
      prisma.contact.findUnique({ where: { phoneNumber: normalizedPhone } }),
    ]);

    res.json({ contact, messages });
  } catch (error) {
    logger.error('Error getting conversation:', error);
    res.status(500).json({ error: 'Error getting conversation' });
  }
});

/** ========== Envío de texto ========== **/
router.post('/api/:phoneNumber/send', async (req, res) => {
  try {
    const { phoneNumber } = req.params;
    const raw = (req.body?.message || '').toString();
    const message = raw.trim();

    if (!message) {
      return res.status(400).json({ error: 'El mensaje no puede estar vacío' });
    }

    if (!getConnectionStatus()) {
      return res.status(503).json({
        error: 'WhatsApp no está conectado. Por favor, escanea el código QR primero.',
        notConnected: true
      });
    }

    const normalizedPhone = normalizePhone(phoneNumber);
    logger.info(`[WEB-SEND] Attempting to send message to ${normalizedPhone}`);

    // Bloqueo "interno"
    const [contact, blocked] = await Promise.all([
      prisma.contact.findUnique({ where: { phoneNumber: normalizedPhone } }),
      prisma.blocked.findUnique({ where: { phoneNumber: normalizedPhone } })
    ]);

    if (contact?.isBlocked || blocked) {
      logger.warn(`[WEB-SEND] Contact ${normalizedPhone} is blocked (internal user)`);
      return res.status(403).json({
        error: 'Este contacto está bloqueado. Es un usuario interno y no puede recibir mensajes del bot.',
        isBlocked: true
      });
    }

    // (Opcional) Verificar existencia en WhatsApp para dar error más claro
    const exists = await onWhatsAppExists(normalizedPhone).catch(() => true);
    if (!exists) {
      return res.status(400).json({ error: 'El número no está registrado en WhatsApp.' });
    }

    const jid = normalizedPhone.includes('@') ? normalizedPhone : `${normalizedPhone}@s.whatsapp.net`;
    logger.info(`[WEB-SEND] Sending to JID: ${jid}`);

    await sendMessage(jid, message);
    logger.info(`[WEB-SEND] ✅ Message sent successfully to ${normalizedPhone}`);

    await prisma.conversationHistory.create({
      data: {
        phoneNumber: normalizedPhone,
        role: 'ASSISTANT',
        content: message,
      },
    });

    await prisma.contact.upsert({
      where: { phoneNumber: normalizedPhone },
      update: {
        updatedAt: new Date(),
        lastMessageAt: new Date(),
      },
      create: {
        phoneNumber: normalizedPhone,
        name: normalizedPhone,
        lastMessageAt: new Date(),
        isBlocked: false,
      },
    });

    res.json({
      success: true,
      message: 'Mensaje enviado correctamente'
    });
  } catch (error: any) {
    logger.error('[WEB-SEND] Error sending message', {
      name: error?.name,
      code: error?.code || error?.status,
      msg: error?.message,
      stack: error?.stack,
    });

    let errorMessage = 'Error al enviar el mensaje';
    if (error?.message?.includes('not ready')) errorMessage = 'WhatsApp no está conectado. Escanea el QR.';
    else if (error?.message?.includes('Invalid')) errorMessage = 'Número de teléfono inválido.';

    res.status(500).json({
      error: errorMessage,
      details: error?.message || 'Unknown error'
    });
  }
});

/** ========== Envío de MEDIA (foto / video / audio / archivo) ========== **/
router.post('/api/:phoneNumber/send-media', upload.single('file'), async (req, res) => {
  try {
    const { phoneNumber } = req.params;
    const caption = (req.body?.caption || '').toString().slice(0, 1000);
    const file = req.file;

    if (!file) {
      return res.status(400).json({ success: false, error: 'Falta archivo (campo "file").' });
    }

    if (!getConnectionStatus()) {
      return res.status(503).json({
        success: false,
        error: 'WhatsApp no está conectado. Por favor, escanea el QR.',
        notConnected: true,
      });
    }

    const normalizedPhone = normalizePhone(phoneNumber);

    // Bloqueo "interno" (igual que en texto)
    const [contact, blocked] = await Promise.all([
      prisma.contact.findUnique({ where: { phoneNumber: normalizedPhone } }),
      prisma.blocked.findUnique({ where: { phoneNumber: normalizedPhone } })
    ]);

    if (contact?.isBlocked || blocked) {
      return res.status(403).json({
        success: false,
        error: 'Este contacto está bloqueado. Es un usuario interno y no puede recibir mensajes del bot.',
        isBlocked: true,
      });
    }

    // (Opcional) existencia en WhatsApp
    const exists = await onWhatsAppExists(normalizedPhone).catch(() => true);
    if (!exists) {
      return res.status(400).json({ success: false, error: 'El número no está registrado en WhatsApp.' });
    }

    const jid = normalizedPhone.includes('@') ? normalizedPhone : `${normalizedPhone}@s.whatsapp.net`;
    const mime = file.mimetype || 'application/octet-stream';
    const kind = (mime.split('/')[0] || 'application') as 'image' | 'video' | 'audio' | 'application';

    logger.info(`[WEB-SEND] Sending media to ${normalizedPhone} (${mime}, ${file.originalname})`);

    const resp = await sendMedia(jid, {
      buffer: file.buffer,
      mime,
      fileName: file.originalname,
      caption,
      kind,
    });

    // Historial luego de envío OK (solo contenido textual/filename por compatibilidad con tu DB actual)
    await prisma.conversationHistory.create({
      data: {
        phoneNumber: normalizedPhone,
        role: 'ASSISTANT',
        content: caption || file.originalname,
      },
    });

    await prisma.contact.upsert({
      where: { phoneNumber: normalizedPhone },
      update: { updatedAt: new Date(), lastMessageAt: new Date() },
      create: { phoneNumber: normalizedPhone, name: normalizedPhone, isBlocked: false, lastMessageAt: new Date() },
    });

    res.json({ success: true, messageId: resp?.key?.id || null });
  } catch (error: any) {
    logger.error('[WEB-SEND] Error sending media', {
      name: error?.name,
      code: error?.code || error?.status,
      msg: error?.message,
      stack: error?.stack,
    });
    res.status(500).json({ success: false, error: error?.message || 'Error al enviar archivo' });
  }
});

/** ========== Polling de nuevos mensajes (optimizado) ========== **/
router.get('/api/new-messages/check', async (req, res) => {
  try {
    const { lastCheck } = req.query;
    const lastCheckDate = lastCheck ? new Date(String(lastCheck)) : new Date(Date.now() - 60_000);

    const newMessages = await prisma.conversationHistory.findMany({
      where: {
        createdAt: { gt: lastCheckDate },
        role: 'USER',
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: { id: true, phoneNumber: true, content: true, createdAt: true },
    });

    if (!newMessages.length) {
      return res.json({ hasNew: false, messages: [], count: 0 });
    }

    const phones = [...new Set(newMessages.map(m => m.phoneNumber))];
    const contacts = await prisma.contact.findMany({
      where: { phoneNumber: { in: phones } },
      select: { phoneNumber: true, name: true, isBlocked: true },
    });
    const map = new Map(contacts.map(c => [c.phoneNumber, c]));

    const messagesWithContacts = newMessages.map(m => ({
      ...m,
      contact: map.get(m.phoneNumber) || { name: null, phoneNumber: m.phoneNumber, isBlocked: false },
    }));

    res.json({ hasNew: true, messages: messagesWithContacts, count: newMessages.length });
  } catch (error) {
    logger.error('Error checking new messages:', error);
    res.status(500).json({ error: 'Error checking new messages' });
  }
});

/** ========== Bloqueo / desbloqueo ========== **/
router.patch('/api/:phoneNumber/block', async (req, res) => {
  try {
    const { phoneNumber } = req.params;
    const { isBlocked, reason } = req.body;
    const normalizedPhone = normalizePhone(phoneNumber);

    logger.info(`[BLOCK-UPDATE] ${isBlocked ? 'Blocking' : 'Unblocking'} contact ${normalizedPhone}`);

    if (isBlocked) {
      await prisma.blocked.upsert({
        where: { phoneNumber: normalizedPhone },
        update: {
          reason: reason || 'Usuario interno',
          updatedAt: new Date(),
        },
        create: {
          phoneNumber: normalizedPhone,
          type: 'USER',
          reason: reason || 'Usuario interno',
        },
      });

      await prisma.contact.upsert({
        where: { phoneNumber: normalizedPhone },
        update: { isBlocked: true, updatedAt: new Date() },
        create: { phoneNumber: normalizedPhone, name: normalizedPhone, isBlocked: true },
      });

      logger.info(`[BLOCK-UPDATE] ✅ Contact ${normalizedPhone} blocked successfully`);
    } else {
      await prisma.blocked.deleteMany({ where: { phoneNumber: normalizedPhone } });
      await prisma.contact.update({
        where: { phoneNumber: normalizedPhone },
        data: { isBlocked: false, updatedAt: new Date() },
      });

      logger.info(`[BLOCK-UPDATE] ✅ Contact ${normalizedPhone} unblocked successfully`);
    }

    res.json({ success: true });
  } catch (error) {
    logger.error('[BLOCK-UPDATE] Error updating block status:', error);
    res.status(500).json({ error: 'Error updating block status' });
  }
});

/** ========== Eliminar conversación ========== **/
router.delete('/api/:phoneNumber', async (req, res) => {
  try {
    const { phoneNumber } = req.params;
    const normalizedPhone = normalizePhone(phoneNumber);

    const result = await prisma.conversationHistory.deleteMany({
      where: { phoneNumber: normalizedPhone },
    });

    logger.info(`[DELETE] Deleted ${result.count} messages for ${normalizedPhone}`);
    res.json({ success: true, message: 'Conversación eliminada', count: result.count });
  } catch (error) {
    logger.error('[DELETE] Error deleting conversation:', error);
    res.status(500).json({ error: 'Error deleting conversation' });
  }
});

/** ========== Estado de conexión ========== **/
router.get('/api/connection-status', (_req, res) => {
  try {
    const connected = getConnectionStatus();
    res.json({ connected });
  } catch (error) {
    logger.error('Error checking connection status:', error);
    res.json({ connected: false });
  }
});

/** ========== Conversaciones recientes (para dashboard) ========== **/
router.get('/api/recent', async (req, res) => {
  try {
    const limit = Math.min(parseInt((req.query.limit as string) || '10', 10), 50);
    const convs = await prisma.conversation.findMany({
      take: limit,
      orderBy: { lastMessageAt: 'desc' },
      include: {
        contact: { select: { name: true, phoneNumber: true } },
        lastMessage: { select: { content: true, createdAt: true } }
      }
    });

    const data = convs.map(c => ({
      conversation_id: c.id,
      contact_name: c.contact?.name || c.contact?.phoneNumber || '',
      phone_e164: c.contact?.phoneNumber || '',
      last_message: c.lastMessage?.content || '',
      last_message_at: c.lastMessage?.createdAt || c.lastMessageAt,
      status: c.status || 'pending'
    }));

    res.json(data);
  } catch (error) {
    logger.error('Error getting recent conversations:', error);
    res.status(500).json({ error: 'Error getting recent conversations' });
  }
});

export default router;
