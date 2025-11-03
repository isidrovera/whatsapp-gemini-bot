// src/web/routes/conversations.ts
import express from 'express';
import multer from 'multer';
import { getPrismaClient } from '../../config/database.js';
import { logger } from '../../utils/logger.js';
import { sendMessage, sendMedia, getConnectionStatus, onWhatsAppExists } from '../../services/whatsapp.js';
import { normalizePhone } from '../../utils/validators.js';

const router = express.Router();
const prisma = getPrismaClient();

/** ========== Multer para media ========== **/
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
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
      contacts,
      page: 'conversations'
    });
  } catch (error) {
    logger.error({ err: error }, 'Error loading conversations:');
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
    logger.error({ err: error }, 'Error getting conversation:');
    res.status(500).json({ error: 'Error getting conversation' });
  }
});

/** ========== Envío de texto ========== **/
router.post('/api/:phoneNumber/send', async (req, res) => {
  const startTime = Date.now();
  let normalizedPhone = '';

  try {
    // ============================================
    // PASO 1: Validación de entrada
    // ============================================
    logger.info('[WEB-SEND] ========== STARTING MESSAGE SEND ==========');

    const { phoneNumber } = req.params;
    const raw = (req.body?.message || '').toString();
    const message = raw.trim();

    logger.info({
      phoneNumber,
      messageLength: message.length,
      hasMessage: !!message,
      timestamp: new Date().toISOString()
    }, '[WEB-SEND] Step 1: Input validation');

    if (!message) {
      logger.warn({}, '[WEB-SEND] ❌ Empty message received');
      return res.status(400).json({
        success: false,
        error: 'El mensaje no puede estar vacío'
      });
    }

    // ============================================
    // PASO 2: Verificar conexión de WhatsApp
    // ============================================
    logger.info('[WEB-SEND] Step 2: Checking WhatsApp connection...');

    let isConnected = false;
    try {
      isConnected = getConnectionStatus();
      logger.info({ isConnected }, '[WEB-SEND] Connection status obtained:');
    } catch (err: any) {
      logger.error({ error: err?.message, stack: err?.stack }, '[WEB-SEND] ❌ Error getting connection status:');
    }

    if (!isConnected) {
      logger.error({}, '[WEB-SEND] ❌ WhatsApp not connected');
      return res.status(503).json({
        success: false,
        error: 'WhatsApp no está conectado. Por favor, escanea el código QR primero.',
        notConnected: true
      });
    }

    logger.info('[WEB-SEND] ✅ WhatsApp is connected, proceeding...');

    // ============================================
    // PASO 3: Normalizar teléfono
    // ============================================
    logger.info('[WEB-SEND] Step 3: Normalizing phone number...');

    try {
      normalizedPhone = normalizePhone(phoneNumber);

      logger.info({
        original: phoneNumber,
        normalized: normalizedPhone,
        length: normalizedPhone.length
      }, '[WEB-SEND] Phone normalization complete:');
    } catch (err: any) {
      logger.error({ error: err?.message, phoneNumber }, '[WEB-SEND] ❌ Error normalizing phone:');

      return res.status(400).json({
        success: false,
        error: 'Error al procesar el número de teléfono'
      });
    }

    if (!normalizedPhone || normalizedPhone.length < 10) {
      logger.error({ original: phoneNumber, normalized: normalizedPhone }, '[WEB-SEND] ❌ Invalid phone number after normalization');

      return res.status(400).json({
        success: false,
        error: 'Número de teléfono inválido'
      });
    }

    // ============================================
    // PASO 4: Verificar bloqueos (solo usando contact.isBlocked)
    // ============================================
    logger.info('[WEB-SEND] Step 4: Checking block status...');

    let contact: { isBlocked?: boolean } | null = null;
    try {
      contact = await prisma.contact.findUnique({ where: { phoneNumber: normalizedPhone } });
      logger.info({
        contactFound: !!contact,
        contactBlocked: !!contact?.isBlocked
      }, '[WEB-SEND] Block check complete:');
    } catch (err: any) {
      logger.error({ error: err?.message }, '[WEB-SEND] ⚠️ Error checking contact block (continuing):');
    }

    if (contact?.isBlocked) {
      logger.warn({ phoneNumber: normalizedPhone }, '[WEB-SEND] ⚠️ Contact is blocked');
      return res.status(403).json({
        success: false,
        error: 'Este contacto está bloqueado.',
        isBlocked: true
      });
    }

    // ============================================
    // PASO 5: Verificar existencia en WhatsApp
    // ============================================
    logger.info('[WEB-SEND] Step 5: Verifying WhatsApp existence...');

    let exists = true;
    try {
      exists = await onWhatsAppExists(normalizedPhone);
      logger.info({
        phoneNumber: normalizedPhone,
        exists
      }, '[WEB-SEND] WhatsApp existence verified:');
    } catch (err: any) {
      logger.warn({ error: err?.message }, '[WEB-SEND] ⚠️ Could not verify existence (continuing):');
    }

    if (!exists) {
      logger.warn({ phoneNumber: normalizedPhone }, '[WEB-SEND] ⚠️ Number may not be on WhatsApp');
      return res.status(400).json({
        success: false,
        error: 'El número no está registrado en WhatsApp.'
      });
    }

    // ============================================
    // PASO 6: Construir JID
    // ============================================
    logger.info('[WEB-SEND] Step 6: Building JID...');

    const jid = normalizedPhone.includes('@')
      ? normalizedPhone
      : `${normalizedPhone}@s.whatsapp.net`;

    logger.info({
      normalizedPhone,
      jid
    }, '[WEB-SEND] JID constructed:');

    // ============================================
    // PASO 7: Enviar mensaje
    // ============================================
    logger.info({
      jid,
      messageLength: message.length,
      messagePreview: message.substring(0, 50) + '...'
    }, '[WEB-SEND] Step 7: Sending message...');

    let result: any;
    try {
      result = await sendMessage(jid, message);

      logger.info({
        jid,
        messageId: result?.key?.id
      }, '[WEB-SEND] ✅ Message sent successfully!');

    } catch (sendError: any) {
      logger.error({
        errorName: sendError?.name,
        errorMessage: sendError?.message,
        errorCode: sendError?.code,
        errorStack: sendError?.stack?.split('\n').slice(0, 3).join('\n')
      }, '[WEB-SEND] ❌ sendMessage() failed:');

      throw sendError;
    }

    // ============================================
    // PASO 8: Guardar en BD
    // ============================================
    logger.info('[WEB-SEND] Step 8: Saving to database...');

    try {
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
        },
        create: {
          phoneNumber: normalizedPhone,
          name: normalizedPhone,
          isBlocked: false,
        },
      });

      logger.info('[WEB-SEND] ✅ Database updated');

    } catch (dbError: any) {
      logger.error({ error: dbError?.message }, '[WEB-SEND] ⚠️ Database error (message was sent):');
    }

    // ============================================
    // PASO 9: Respuesta exitosa
    // ============================================
    const duration = Date.now() - startTime;

    logger.info({
      phoneNumber: normalizedPhone,
      duration: `${duration}ms`
    }, '[WEB-SEND] ========== SUCCESS ==========');

    res.json({
      success: true,
      message: 'Mensaje enviado correctamente',
      messageId: result?.key?.id
    });

  } catch (error: any) {
    const duration = Date.now() - startTime;

    logger.error({
      phoneNumber: normalizedPhone || 'unknown',
      duration: `${duration}ms`,
      errorName: error?.name,
      errorMessage: error?.message,
      errorCode: error?.code,
      errorStack: error?.stack?.split('\n').slice(0, 5).join('\n')
    }, '[WEB-SEND] ========== FAILED ==========');

    let errorMessage = 'Error al enviar el mensaje';
    let statusCode = 500;

    const errMsg = error?.message?.toLowerCase() || '';

    if (errMsg.includes('not ready') || errMsg.includes('not connected')) {
      errorMessage = 'WhatsApp no está conectado. Escanea el QR primero.';
      statusCode = 503;
    } else if (errMsg.includes('invalid')) {
      errorMessage = 'Número de teléfono inválido.';
      statusCode = 400;
    } else if (errMsg.includes('timeout')) {
      errorMessage = 'Tiempo de espera agotado. Intenta de nuevo.';
      statusCode = 504;
    } else if (error?.message) {
      errorMessage = error.message;
    }

    res.status(statusCode).json({
      success: false,
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
      return res.status(400).json({
        success: false,
        error: 'Falta archivo (campo "file").'
      });
    }

    // Verificar conexión
    const isConnected = getConnectionStatus();
    if (!isConnected) {
      return res.status(503).json({
        success: false,
        error: 'WhatsApp no está conectado. Por favor, escanea el QR.',
        notConnected: true,
      });
    }

    const normalizedPhone = normalizePhone(phoneNumber);
    logger.info({ phoneNumber: normalizedPhone }, `[WEB-SEND] Attempting to send media to ${normalizedPhone}`);

    // Verificar bloqueo por contact.isBlocked
    const contact = await prisma.contact.findUnique({ where: { phoneNumber: normalizedPhone } });
    if (contact?.isBlocked) {
      return res.status(403).json({
        success: false,
        error: 'Este contacto está bloqueado y no puede recibir mensajes del bot.',
        isBlocked: true,
      });
    }

    // Verificar existencia en WhatsApp
    logger.info({ phoneNumber: normalizedPhone }, `[WEB-SEND] Checking if ${normalizedPhone} exists on WhatsApp`);
    let exists = true;
    try {
      exists = await onWhatsAppExists(normalizedPhone);
    } catch (err: any) {
      logger.warn({ error: err?.message }, `[WEB-SEND] Could not verify WhatsApp existence for ${normalizedPhone}:`);
    }

    if (!exists) {
      return res.status(400).json({
        success: false,
        error: 'El número no está registrado en WhatsApp.'
      });
    }

    // Construir JID
    const jid = normalizedPhone.includes('@')
      ? normalizedPhone
      : `${normalizedPhone}@s.whatsapp.net`;

    const mime = file.mimetype || 'application/octet-stream';
    const kind = (mime.split('/')[0] || 'application') as 'image' | 'video' | 'audio' | 'application';

    logger.info({
      mime,
      fileName: file.originalname,
      size: file.size,
      kind
    }, `[WEB-SEND] Sending media to ${normalizedPhone}`);

    // Intentar enviar
    try {
      const resp = await sendMedia(jid, {
        buffer: file.buffer,
        mime,
        fileName: file.originalname,
        caption,
        kind,
      });

      logger.info({
        messageId: resp?.key?.id
      }, `[WEB-SEND] ✅ Media sent successfully to ${normalizedPhone}`);

      // Guardar en historial
      await prisma.conversationHistory.create({
        data: {
          phoneNumber: normalizedPhone,
          role: 'ASSISTANT',
          content: caption || `📎 ${file.originalname}`,
        },
      });

      // Actualizar contacto
      await prisma.contact.upsert({
        where: { phoneNumber: normalizedPhone },
        update: {
          updatedAt: new Date(),
        },
        create: {
          phoneNumber: normalizedPhone,
          name: normalizedPhone,
          isBlocked: false,
        },
      });

      res.json({
        success: true,
        messageId: resp?.key?.id || null,
        message: 'Archivo enviado correctamente'
      });

    } catch (sendError: any) {
      logger.error({
        error: sendError?.message,
        stack: sendError?.stack,
        code: sendError?.code,
        data: sendError?.data
      }, '[WEB-SEND] Error in sendMedia:');

      throw sendError;
    }

  } catch (error: any) {
    logger.error({
      name: error?.name,
      code: error?.code || error?.status,
      msg: error?.message,
      stack: error?.stack,
    }, '[WEB-SEND] Error sending media');

    let errorMessage = 'Error al enviar archivo';

    if (error?.message?.includes('not ready') || error?.message?.includes('Not connected')) {
      errorMessage = 'WhatsApp no está conectado. Escanea el QR.';
    } else if (error?.message?.includes('timeout')) {
      errorMessage = 'Tiempo de espera agotado. Intenta de nuevo.';
    } else if (error?.message) {
      errorMessage = error.message;
    }

    res.status(500).json({
      success: false,
      error: errorMessage,
      details: error?.message || 'Unknown error'
    });
  }
});

/** ========== Polling de nuevos mensajes (optimizado) ========== **/
router.get('/api/new-messages/check', async (req, res) => {
  try {
    const { lastCheck } = req.query as { lastCheck?: string };
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
      contact: map.get(m.phoneNumber) || { name: null as string | null, phoneNumber: m.phoneNumber, isBlocked: false },
    }));

    res.json({ hasNew: true, messages: messagesWithContacts, count: newMessages.length });
  } catch (error) {
    logger.error({ err: error }, 'Error checking new messages:');
    res.status(500).json({ error: 'Error checking new messages' });
  }
});

/** ========== Bloqueo / desbloqueo (solo contact.isBlocked) ========== **/
router.patch('/api/:phoneNumber/block', async (req, res) => {
  try {
    const { phoneNumber } = req.params;
    const { isBlocked } = req.body as { isBlocked: boolean; reason?: string };
    const normalizedPhone = normalizePhone(phoneNumber);

    logger.info({ phoneNumber: normalizedPhone, isBlocked }, `[BLOCK-UPDATE] ${isBlocked ? 'Blocking' : 'Unblocking'} contact ${normalizedPhone}`);

    // Asegura que exista el contacto
    await prisma.contact.upsert({
      where: { phoneNumber: normalizedPhone },
      update: { isBlocked, updatedAt: new Date() },
      create: { phoneNumber: normalizedPhone, name: normalizedPhone, isBlocked }
    });

    logger.info({ phoneNumber: normalizedPhone, isBlocked }, `[BLOCK-UPDATE] ✅ Contact ${normalizedPhone} ${isBlocked ? 'blocked' : 'unblocked'} successfully`);
    res.json({ success: true });
  } catch (error) {
    logger.error({ err: error }, '[BLOCK-UPDATE] Error updating block status:');
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

    logger.info({ phoneNumber: normalizedPhone, count: result.count }, `[DELETE] Deleted ${result.count} messages for ${normalizedPhone}`);
    res.json({ success: true, message: 'Conversación eliminada', count: result.count });
  } catch (error) {
    logger.error({ err: error }, '[DELETE] Error deleting conversation:');
    res.status(500).json({ error: 'Error deleting conversation' });
  }
});

/** ========== Estado de conexión ========== **/
router.get('/api/connection-status', (_req, res) => {
  try {
    const connected = getConnectionStatus();
    res.json({ connected });
  } catch (error) {
    logger.error({ err: error }, 'Error checking connection status:');
    res.json({ connected: false });
  }
});

/** ========== Conversaciones recientes (para dashboard) ========== **/
// Derivado de conversationHistory (último mensaje por contacto)
router.get('/api/recent', async (req, res) => {
  try {
    const limitParam = (req.query.limit as string) || '10';
    const limit = Math.min(parseInt(limitParam, 10) || 10, 50);

    // Tomar los últimos N mensajes (de cualquier rol) y agrupar por phoneNumber, quedándonos con el más reciente por número
    const latest = await prisma.conversationHistory.findMany({
      orderBy: { createdAt: 'desc' },
      take: 200, // sobre-muestrea para agrupar
      select: { id: true, phoneNumber: true, content: true, createdAt: true, role: true }
    });

    const seen = new Set<string>();
    const perContact: Array<{
      phoneNumber: string;
      lastMessage: { content: string; createdAt: Date; role: string } | null;
    }> = [];

    for (const m of latest) {
      if (!seen.has(m.phoneNumber)) {
        seen.add(m.phoneNumber);
        perContact.push({
          phoneNumber: m.phoneNumber,
          lastMessage: { content: m.content, createdAt: m.createdAt, role: m.role }
        });
      }
      if (perContact.length >= limit) break;
    }

    const phones = perContact.map(p => p.phoneNumber);
    const contacts = await prisma.contact.findMany({
      where: { phoneNumber: { in: phones } },
      select: { phoneNumber: true, name: true }
    });
    const map = new Map(contacts.map(c => [c.phoneNumber, c]));

    const data = perContact.map((p, idx) => {
      const c = map.get(p.phoneNumber);
      return {
        conversation_id: `${p.phoneNumber}-${idx}`, // no hay tabla conversation; id sintético
        contact_name: c?.name || p.phoneNumber,
        phone_e164: p.phoneNumber,
        last_message: p.lastMessage?.content || '',
        last_message_at: p.lastMessage?.createdAt || null,
        status: 'pending'
      };
    });

    res.json(data);
  } catch (error) {
    logger.error({ err: error }, 'Error getting recent conversations:');
    res.status(500).json({ error: 'Error getting recent conversations' });
  }
});

export default router;