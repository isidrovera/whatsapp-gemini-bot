import express from 'express';
import * as templateModel from '../../models/template.js';
import { logger } from '../../utils/logger.js';

const router = express.Router();

// Ver página de plantillas
router.get('/', async (req, res) => {
  try {
    const templates = await templateModel.getAll();
    res.render('templates', { 
      title: 'Plantillas de Mensajes',
      templates
    });
  } catch (error) {
    logger.error({ err: error },'Error loading templates:');
    res.status(500).send('Error loading templates');
  }
});

// API: Obtener todas las plantillas
router.get('/api', async (req, res) => {
  try {
    const { category } = req.query;
    
    let templates;
    if (category) {
      templates = await templateModel.getByCategory(category as string);
    } else {
      templates = await templateModel.getAll();
    }
    
    res.json(templates);
  } catch (error) {
    logger.error({ err: error },'Error getting templates:');
    res.status(500).json({ error: 'Error getting templates' });
  }
});

// API: Obtener plantilla por ID
router.get('/api/:id', async (req, res) => {
  try {
    const template = await templateModel.findById(req.params.id);
    if (!template) {
      return res.status(404).json({ error: 'Template not found' });
    }
    res.json(template);
  } catch (error) {
    logger.error({ err: error },'Error getting template:');
    res.status(500).json({ error: 'Error getting template' });
  }
});

// API: Crear plantilla
router.post('/api', async (req, res) => {
  try {
    const { name, content, category, isActive } = req.body;
    
    if (!name || !content) {
      return res.status(400).json({ error: 'Name and content are required' });
    }

    // Extraer variables del contenido
    const variables = templateModel.extractVariables(content);

    const template = await templateModel.create({
      name,
      content,
      category: category || 'general',
      variables: JSON.stringify(variables),
      isActive: isActive !== false,
    });

    res.json(template);
  } catch (error) {
    logger.error({ err: error },'Error creating template:');
    res.status(500).json({ error: 'Error creating template' });
  }
});

// API: Actualizar plantilla
router.put('/api/:id', async (req, res) => {
  try {
    const { name, content, category, isActive } = req.body;
    
    let updateData: any = { name, category, isActive };
    
    if (content) {
      updateData.content = content;
      const variables = templateModel.extractVariables(content);
      updateData.variables = JSON.stringify(variables);
    }

    const template = await templateModel.update(req.params.id, updateData);
    res.json(template);
  } catch (error) {
    logger.error({ err: error },'Error updating template:');
    res.status(500).json({ error: 'Error updating template' });
  }
});

// API: Eliminar plantilla
router.delete('/api/:id', async (req, res) => {
  try {
    await templateModel.remove(req.params.id);
    res.json({ success: true });
  } catch (error) {
    logger.error({ err: error },'Error deleting template:');
    res.status(500).json({ error: 'Error deleting template' });
  }
});

// API: Renderizar plantilla con variables
router.post('/api/:id/render', async (req, res) => {
  try {
    const { variables } = req.body;
    
    const template = await templateModel.findById(req.params.id);
    if (!template) {
      return res.status(404).json({ error: 'Template not found' });
    }

    const rendered = templateModel.render(template.content, variables || {});
    res.json({ content: rendered });
  } catch (error) {
    logger.error({ err: error },'Error rendering template:');
    res.status(500).json({ error: 'Error rendering template' });
  }
});

export default router;