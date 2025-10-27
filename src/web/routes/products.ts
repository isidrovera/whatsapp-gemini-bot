import express from 'express';
import * as productModel from '../../models/product.js';
import { logger } from '../../utils/logger.js';

const router = express.Router();

// Ver página de productos
router.get('/', async (req, res) => {
  try {
    const products = await productModel.getAll();
    const categories = await productModel.getCategories();
    
    res.render('products', { 
      title: 'Catálogo de Productos',
      products,
      categories
    });
  } catch (error) {
    logger.error('Error loading products:', error);
    res.status(500).send('Error loading products');
  }
});

// API: Obtener todos los productos
router.get('/api', async (req, res) => {
  try {
    const { category } = req.query;
    
    let products;
    if (category) {
      products = await productModel.getByCategory(category as string);
    } else {
      products = await productModel.getAll();
    }
    
    res.json(products);
  } catch (error) {
    logger.error('Error getting products:', error);
    res.status(500).json({ error: 'Error getting products' });
  }
});

// API: Obtener categorías
router.get('/api/categories', async (req, res) => {
  try {
    const categories = await productModel.getCategories();
    res.json(categories);
  } catch (error) {
    logger.error('Error getting categories:', error);
    res.status(500).json({ error: 'Error getting categories' });
  }
});

// API: Obtener producto por ID
router.get('/api/:id', async (req, res) => {
  try {
    const product = await productModel.findById(req.params.id);
    if (!product) {
      return res.status(404).json({ error: 'Product not found' });
    }
    res.json(product);
  } catch (error) {
    logger.error('Error getting product:', error);
    res.status(500).json({ error: 'Error getting product' });
  }
});

// API: Crear producto
router.post('/api', async (req, res) => {
  try {
    const { name, category, description, price, imageUrl, isActive, sortOrder } = req.body;
    
    if (!name || !category) {
      return res.status(400).json({ error: 'Name and category are required' });
    }

    const product = await productModel.create({
      name,
      category,
      description,
      price: price ? parseFloat(price) : undefined,
      imageUrl,
      isActive: isActive !== false,
      sortOrder: sortOrder || 0,
    });

    res.json(product);
  } catch (error) {
    logger.error('Error creating product:', error);
    res.status(500).json({ error: 'Error creating product' });
  }
});

// API: Actualizar producto
router.put('/api/:id', async (req, res) => {
  try {
    const { name, category, description, price, imageUrl, isActive, sortOrder } = req.body;
    
    const product = await productModel.update(req.params.id, {
      name,
      category,
      description,
      price: price ? parseFloat(price) : undefined,
      imageUrl,
      isActive,
      sortOrder,
    });

    res.json(product);
  } catch (error) {
    logger.error('Error updating product:', error);
    res.status(500).json({ error: 'Error updating product' });
  }
});

// API: Eliminar producto
router.delete('/api/:id', async (req, res) => {
  try {
    await productModel.remove(req.params.id);
    res.json({ success: true });
  } catch (error) {
    logger.error('Error deleting product:', error);
    res.status(500).json({ error: 'Error deleting product' });
  }
});

// API: Agregar keyword
router.post('/api/:id/keywords', async (req, res) => {
  try {
    const { keyword } = req.body;
    
    if (!keyword) {
      return res.status(400).json({ error: 'Keyword is required' });
    }

    const result = await productModel.addKeyword(req.params.id, keyword);
    res.json(result);
  } catch (error) {
    logger.error('Error adding keyword:', error);
    res.status(500).json({ error: 'Error adding keyword' });
  }
});

// API: Eliminar keyword
router.delete('/api/keywords/:keywordId', async (req, res) => {
  try {
    await productModel.removeKeyword(req.params.keywordId);
    res.json({ success: true });
  } catch (error) {
    logger.error('Error removing keyword:', error);
    res.status(500).json({ error: 'Error removing keyword' });
  }
});

// API: Buscar productos por keyword
router.get('/api/search/:query', async (req, res) => {
  try {
    const results = await productModel.searchByKeyword(req.params.query);
    res.json(results);
  } catch (error) {
    logger.error('Error searching products:', error);
    res.status(500).json({ error: 'Error searching products' });
  }
});

export default router;