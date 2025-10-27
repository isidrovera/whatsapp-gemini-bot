import express from 'express';
import * as autoResponseModel from '../../models/autoResponse.js';
import { logger } from '../../utils/logger.js';

const router = express.Router();

// ---------- FORM NUEVA AUTO-RESPUESTA ----------
// Página para crear nueva respuesta automática
router.get('/new', async (_req, res) => {
  try {
    // podrías precargar categorías sugeridas si tienes
    res.render('autoResponse_new', { 
      title: 'Nueva Auto-respuesta',
    });
  } catch (error) {
    logger.error('Error loading new auto-response form:', error);
    res.status(500).send('Error loading new auto-response form');
  }
});

router.head('/new', (_req, res) => {
  res.status(200).end();
});

// ---------- LISTA ----------
router.get('/', async (_req, res) => {
  try {
    const responses = await autoResponseModel.getAll();
    res.render('autoResponses', { 
      title: 'Respuestas Automáticas',
      responses
    });
  } catch (error) {
    logger.error('Error loading auto responses:', error);
    res.status(500).send('Error loading auto responses');
  }
});

// ---------- API: todas ----------
router.get('/api', async (_req, res) => {
  try {
    const responses = await autoResponseModel.getAll();
    res.json(responses);
  } catch (error) {
    logger.error('Error getting auto responses:', error);
    res.status(500).json({ error: 'Error getting auto responses' });
  }
});

// ---------- API: una por ID ----------
router.get('/api/:id', async (req, res) => {
  try {
    const response = await autoResponseModel.findById(req.params.id);
    if (!response) {
      return res.status(404).json({ error: 'Auto response not found' });
    }
    res.json(response);
  } catch (error) {
    logger.error('Error getting auto response:', error);
    res.status(500).json({ error: 'Error getting auto response' });
  }
});

// ---------- API: crear ----------
router.post('/api', async (req, res) => {
  try {
    const { trigger, response, isActive, priority, category } = req.body;
    
    if (!trigger || !response) {
      return res.status(400).json({ error: 'Trigger and response are required' });
    }

    const result = await autoResponseModel.create({
      trigger,
      response,
      isActive: isActive !== false,
      priority: priority || 1,
      category,
    });

    res.json(result);
  } catch (error) {
    logger.error('Error creating auto response:', error);
    res.status(500).json({ error: 'Error creating auto response' });
  }
});

// ---------- API: actualizar ----------
router.put('/api/:id', async (req, res) => {
  try {
    const { trigger, response, isActive, priority, category } = req.body;
    
    const result = await autoResponseModel.update(req.params.id, {
      trigger,
      response,
      isActive,
      priority,
      category,
    });

    res.json(result);
  } catch (error) {
    logger.error('Error updating auto response:', error);
    res.status(500).json({ error: 'Error updating auto response' });
  }
});

// ---------- API: eliminar ----------
router.delete('/api/:id', async (req, res) => {
  try {
    await autoResponseModel.remove(req.params.id);
    res.json({ success: true });
  } catch (error) {
    logger.error('Error deleting auto response:', error);
    res.status(500).json({ error: 'Error deleting auto response' });
  }
});

// ---------- API: probar trigger ----------
router.post('/api/test', async (req, res) => {
  try {
    const { message } = req.body;
    
    if (!message) {
      return res.status(400).json({ error: 'Message is required' });
    }

    const result = await autoResponseModel.findByTrigger(message);
    res.json(result);
  } catch (error) {
    logger.error('Error testing trigger:', error);
    res.status(500).json({ error: 'Error testing trigger' });
  }
});

export default router;
