// src/routes/departments.js
import express from 'express';
import * as departmentModel from '../../models/department.js';
import { logger } from '../../utils/logger.js';
import util from 'util';

const router = express.Router();

function prettyLogError(tag, error) {
  try {
    console.error(`\n🔥 [${tag}] ERROR START ------------------`);
    // util.inspect evita fallos por objetos circulares
    console.error(util.inspect(error, { depth: null, colors: true }));
    console.error('stack:', error && error.stack ? error.stack : '<no stack>');
    console.error(`🔥 [${tag}] ERROR END --------------------\n`);
  } catch (e) {
    console.error('Failed to pretty-log error:', e);
    console.error(String(error));
  }
}

/**
 * Ver página de departamentos
 */
router.get('/', async (req, res) => {
  try {
    logger.info('Loading departments page...');
    const departments = await departmentModel.getAll();

    logger.info(`Loaded ${Array.isArray(departments) ? departments.length : 0} departments`);

    // Asegurar que departments es un array
    const safeDepartments = Array.isArray(departments) ? departments : [];

    // Render normal
    res.render('departments', {
      title: 'Departamentos',
      departments: safeDepartments,
      user: req.user?.name || req.user?.username || 'Admin'
    });
  } catch (error) {
    // 1) Imprime en consola sin fiarse del logger
    prettyLogError('/departments GET', error);

    // 2) Logea con el logger (meta object para winston)
    try {
      logger.error('Error loading departments page', {
        message: error?.message,
        name: error?.name,
        stack: error?.stack,
        code: error?.code,
        meta: error?.meta || null
      });
    } catch (e) {
      // si logger falla, lo aseguramos con console
      console.error('Logger failed when logging error:', e);
    }

    // 3) Si la vista falla al renderizar, respondemos con fallback
    // En desarrollo puedes enviar el stack para ver en el browser,
    // pero en prod enviar un mensaje genérico.
    const isDev = process.env.NODE_ENV !== 'production';
    if (isDev) {
      res.status(500).send(`<pre>Internal server error\n\n${error && error.stack ? error.stack : String(error)}</pre>`);
    } else {
      res.status(500).render('departments', {
        title: 'Departamentos',
        departments: [],
        user: req.user?.name || req.user?.username || 'Admin',
        error: 'Internal server error'
      });
    }
  }
});

// API: Obtener todos los departamentos
router.get('/api', async (req, res) => {
  try {
    const departments = await departmentModel.getAll();
    res.json(departments || []);
  } catch (error) {
    prettyLogError('/departments/api GET', error);
    logger.error('Error getting departments', { message: error?.message, stack: error?.stack });
    res.status(500).json({ error: 'Error getting departments', message: error?.message });
  }
});

// API: Obtener departamento por ID
router.get('/api/:id', async (req, res) => {
  try {
    const department = await departmentModel.findById(req.params.id);
    if (!department) return res.status(404).json({ error: 'Department not found' });
    res.json(department);
  } catch (error) {
    prettyLogError('/departments/api/:id GET', error);
    logger.error('Error getting department', { message: error?.message, stack: error?.stack });
    res.status(500).json({ error: 'Error getting department', message: error?.message });
  }
});

// API: Crear departamento
router.post('/api', async (req, res) => {
  try {
    const { name, description, phoneNumber, isActive, sortOrder } = req.body;
    if (!name) return res.status(400).json({ error: 'Name is required' });

    const department = await departmentModel.create({
      name,
      description,
      phoneNumber,
      isActive: isActive !== false,
      sortOrder: sortOrder || 0,
    });

    res.json(department);
  } catch (error) {
    prettyLogError('/departments/api POST', error);
    logger.error('Error creating department', { message: error?.message, stack: error?.stack });
    res.status(500).json({ error: 'Error creating department', message: error?.message });
  }
});

// API: Actualizar departamento
router.put('/api/:id', async (req, res) => {
  try {
    const { name, description, phoneNumber, isActive, sortOrder } = req.body;
    const department = await departmentModel.update(req.params.id, {
      name,
      description,
      phoneNumber,
      isActive,
      sortOrder,
    });
    res.json(department);
  } catch (error) {
    prettyLogError('/departments/api/:id PUT', error);
    logger.error('Error updating department', { message: error?.message, stack: error?.stack });
    res.status(500).json({ error: 'Error updating department', message: error?.message });
  }
});

// API: Eliminar departamento
router.delete('/api/:id', async (req, res) => {
  try {
    await departmentModel.remove(req.params.id);
    res.json({ success: true });
  } catch (error) {
    prettyLogError('/departments/api/:id DELETE', error);
    logger.error('Error deleting department', { message: error?.message, stack: error?.stack });
    res.status(500).json({ error: 'Error deleting department', message: error?.message });
  }
});

// Resto de rutas (toggle, sort-order, keywords, contacts, etc.)...
// ---- For brevity you can keep your existing implementations but ensure
// they also call prettyLogError(...) inside all catch blocks as above.

export default router;
