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

    logger.info('[WEB-SEND] Step 1: Input validation', {
      phoneNumber,
      messageLength: message.length,
      hasMessage: !!message,
      timestamp: new Date().toISOString()
    });

    if (!message) {
      logger.warn('[WEB-SEND] ❌ Empty message received');
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
    let botNumber = null;
    let statusInfo = { connected: false, hasQR: false, botNumber: null };
    
    try {
      isConnected = getConnectionStatus();
      logger.info('[WEB-SEND] Connection status obtained:', { isConnected });
    } catch (err: any) {
      logger.error('[WEB-SEND] ❌ Error getting connection status:', {
        error: err?.message,
        stack: err?.stack
      });
    }

    try {
      botNumber = getBotPhoneNumber();
      logger.info('[WEB-SEND] Bot number obtained:', { botNumber });
    } catch (err: any) {
      logger.error('[WEB-SEND] ❌ Error getting bot number:', {
        error: err?.message
      });
    }

    try {
      statusInfo = getStatusForDashboard();
      logger.info('[WEB-SEND] Status info obtained:', statusInfo);
    } catch (err: any) {
      logger.error('[WEB-SEND] ❌ Error getting status info:', {
        error: err?.message
      });
    }

    logger.info('[WEB-SEND] Connection check complete:', {
      isConnected,
      botNumber,
      hasQR: statusInfo.hasQR
    });

    if (!isConnected) {
      logger.error('[WEB-SEND] ❌ WhatsApp not connected');
      
      return res.status(503).json({
        success: false,
        error: 'WhatsApp no está conectado. Por favor, escanea el código QR primero.',
        notConnected: true,
        debug: {
          isConnected,
          hasQR: statusInfo.hasQR,
          botNumber
        }
      });
    }

    logger.info('[WEB-SEND] ✅ WhatsApp is connected, proceeding...');

    // ============================================
    // PASO 3: Normalizar teléfono
    // ============================================
    logger.info('[WEB-SEND] Step 3: Normalizing phone number...');
    
    try {
      normalizedPhone = normalizePhone(phoneNumber);
      
      logger.info('[WEB-SEND] Phone normalization complete:', {
        original: phoneNumber,
        normalized: normalizedPhone,
        length: normalizedPhone.length
      });
    } catch (err: any) {
      logger.error('[WEB-SEND] ❌ Error normalizing phone:', {
        error: err?.message,
        phoneNumber
      });
      
      return res.status(400).json({
        success: false,
        error: 'Error al procesar el número de teléfono'
      });
    }

    if (!normalizedPhone || normalizedPhone.length < 10) {
      logger.error('[WEB-SEND] ❌ Invalid phone number after normalization', {
        original: phoneNumber,
        normalized: normalizedPhone
      });
      
      return res.status(400).json({
        success: false,
        error: 'Número de teléfono inválido'
      });
    }

    // ============================================
    // PASO 4: Verificar bloqueos
    // ============================================
    logger.info('[WEB-SEND] Step 4: Checking block status...');
    
    let contact = null;
    let blocked = null;
    
    try {
      [contact, blocked] = await Promise.all([
        prisma.contact.findUnique({ where: { phoneNumber: normalizedPhone } }),
        prisma.blocked.findUnique({ where: { phoneNumber: normalizedPhone } })
      ]);

      logger.info('[WEB-SEND] Block check complete:', {
        contactFound: !!contact,
        contactBlocked: contact?.isBlocked,
        explicitlyBlocked: !!blocked
      });
    } catch (err: any) {
      logger.error('[WEB-SEND] ⚠️ Error checking blocks (continuing):', {
        error: err?.message
      });
    }

    if (contact?.isBlocked || blocked) {
      logger.warn('[WEB-SEND] ⚠️ Contact is blocked', {
        phoneNumber: normalizedPhone
      });
      
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
      logger.info('[WEB-SEND] WhatsApp existence verified:', {
        phoneNumber: normalizedPhone,
        exists
      });
    } catch (err: any) {
      logger.warn('[WEB-SEND] ⚠️ Could not verify existence (continuing):', {
        error: err?.message
      });
    }

    if (!exists) {
      logger.warn('[WEB-SEND] ⚠️ Number may not be on WhatsApp', {
        phoneNumber: normalizedPhone
      });
      
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
    
    logger.info('[WEB-SEND] JID constructed:', {
      normalizedPhone,
      jid
    });

    // ============================================
    // PASO 7: Enviar mensaje
    // ============================================
    logger.info('[WEB-SEND] Step 7: Sending message...', {
      jid,
      messageLength: message.length,
      messagePreview: message.substring(0, 50) + '...'
    });

    let result: any;
    try {
      result = await sendMessage(jid, message);
      
      logger.info('[WEB-SEND] ✅ Message sent successfully!', {
        jid,
        messageId: result?.key?.id
      });

    } catch (sendError: any) {
      logger.error('[WEB-SEND] ❌ sendMessage() failed:', {
        errorName: sendError?.name,
        errorMessage: sendError?.message,
        errorCode: sendError?.code,
        errorStack: sendError?.stack?.split('\n').slice(0, 3).join('\n')
      });

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
          lastMessageAt: new Date(),
        },
        create: {
          phoneNumber: normalizedPhone,
          name: normalizedPhone,
          lastMessageAt: new Date(),
          isBlocked: false,
        },
      });

      logger.info('[WEB-SEND] ✅ Database updated');

    } catch (dbError: any) {
      logger.error('[WEB-SEND] ⚠️ Database error (message was sent):', {
        error: dbError?.message
      });
    }

    // ============================================
    // PASO 9: Respuesta exitosa
    // ============================================
    const duration = Date.now() - startTime;
    
    logger.info('[WEB-SEND] ========== SUCCESS ==========', {
      phoneNumber: normalizedPhone,
      duration: `${duration}ms`
    });

    res.json({
      success: true,
      message: 'Mensaje enviado correctamente',
      messageId: result?.key?.id
    });

  } catch (error: any) {
    const duration = Date.now() - startTime;
    
    logger.error('[WEB-SEND] ========== FAILED ==========', {
      phoneNumber: normalizedPhone || 'unknown',
      duration: `${duration}ms`,
      errorName: error?.name,
      errorMessage: error?.message,
      errorCode: error?.code,
      errorStack: error?.stack?.split('\n').slice(0, 5).join('\n')
    });

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
    logger.info(`[WEB-SEND] Attempting to send media to ${normalizedPhone}`);

    // Verificar bloqueo interno
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

    // Verificar existencia en WhatsApp
    logger.info(`[WEB-SEND] Checking if ${normalizedPhone} exists on WhatsApp`);
    let exists = true;
    try {
      exists = await onWhatsAppExists(normalizedPhone);
    } catch (err) {
      logger.warn(`[WEB-SEND] Could not verify WhatsApp existence for ${normalizedPhone}:`, err);
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

    logger.info(`[WEB-SEND] Sending media to ${normalizedPhone}`, {
      mime,
      fileName: file.originalname,
      size: file.size,
      kind
    });

    // Intentar enviar
    try {
      const resp = await sendMedia(jid, {
        buffer: file.buffer,
        mime,
        fileName: file.originalname,
        caption,
        kind,
      });

      logger.info(`[WEB-SEND] ✅ Media sent successfully to ${normalizedPhone}`, {
        messageId: resp?.key?.id
      });

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
          lastMessageAt: new Date() 
        },
        create: { 
          phoneNumber: normalizedPhone, 
          name: normalizedPhone, 
          isBlocked: false, 
          lastMessageAt: new Date() 
        },
      });

      res.json({ 
        success: true, 
        messageId: resp?.key?.id || null,
        message: 'Archivo enviado correctamente'
      });

    } catch (sendError: any) {
      logger.error('[WEB-SEND] Error in sendMedia:', {
        error: sendError?.message,
        stack: sendError?.stack,
        code: sendError?.code,
        data: sendError?.data
      });

      throw sendError;
    }

  } catch (error: any) {
    logger.error('[WEB-SEND] Error sending media', {
      name: error?.name,
      code: error?.code || error?.status,
      msg: error?.message,
      stack: error?.stack,
    });

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