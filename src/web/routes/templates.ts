import { Router } from 'express'
import { z } from 'zod'
import * as Templates from '../../models/template.js' // <-- importante .js en runtime ESM

const router = Router()

// ====== Schemas de validación ======
const CreateSchema = z.object({
  name: z.string().min(1),
  content: z.string().min(1),
  category: z.string().min(1),
  variables: z.string().optional(),
  isActive: z.boolean().optional(),
})

const UpdateSchema = z.object({
  name: z.string().min(1).optional(),
  content: z.string().min(1).optional(),
  category: z.string().min(1).optional(),
  variables: z.string().optional(),
  isActive: z.boolean().optional(),
})

const RenderSchema = z.object({
  content: z.string().min(1),
  variables: z.record(z.string()).default({}),
})

/**
 * GET /templates
 * Renderiza la vista EJS con la data lista para pintar tarjetas
 */
router.get('/', async (req, res) => {
  const templates = await Templates.getAll()

  res.render('templates', {
    title: 'Plantillas',
    user: req.session?.user?.name || 'Admin',
    templates,
  })
})

/**
 * GET /templates/api
 * Devuelve todas en JSON (por si quieres usarlas vía fetch más adelante)
 */
router.get('/api', async (_req, res) => {
  const data = await Templates.getAll()
  res.json(data)
})

/**
 * GET /templates/api/active
 */
router.get('/api/active', async (_req, res) => {
  const data = await Templates.getActive()
  res.json(data)
})

/**
 * GET /templates/api/category/:category
 */
router.get('/api/category/:category', async (req, res) => {
  const { category } = req.params
  const data = await Templates.getByCategory(category)
  res.json(data)
})

/**
 * GET /templates/api/:id
 */
router.get('/api/:id', async (req, res) => {
  const item = await Templates.findById(req.params.id)
  if (!item) return res.status(404).json({ error: 'Template not found' })
  res.json(item)
})

/**
 * POST /templates/api
 */
router.post('/api', async (req, res) => {
  const parsed = CreateSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() })
  }

  try {
    const created = await Templates.create(parsed.data)
    res.status(201).json(created)
  } catch (err: any) {
    res.status(400).json({ error: err?.message ?? 'Error creating template' })
  }
})

/**
 * PUT /templates/api/:id
 */
router.put('/api/:id', async (req, res) => {
  const parsed = UpdateSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() })
  }

  try {
    const updated = await Templates.update(req.params.id, parsed.data)
    res.json(updated)
  } catch (err: any) {
    if (err?.code === 'P2025') {
      return res.status(404).json({ error: 'Template not found' })
    }
    res.status(400).json({ error: err?.message ?? 'Error updating template' })
  }
})

/**
 * DELETE /templates/api/:id
 */
router.delete('/api/:id', async (req, res) => {
  try {
    const deleted = await Templates.remove(req.params.id)
    res.json(deleted)
  } catch (err: any) {
    if (err?.code === 'P2025') {
      return res.status(404).json({ error: 'Template not found' })
    }
    res.status(400).json({ error: err?.message ?? 'Error deleting template' })
  }
})

/**
 * POST /templates/api/render
 * Body: { content: string, variables?: Record<string,string> }
 * Responde preview + variables faltantes
 */
router.post('/api/render', async (req, res) => {
  const parsed = RenderSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() })
  }

  const { content, variables } = parsed.data
  const output = Templates.render(content, variables)
  const missing = Templates
    .extractVariables(content)
    .filter((k) => !(k in variables))

  res.json({ output, missing })
})

export default router
