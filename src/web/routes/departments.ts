// src/web/routes/departments.ts
import express, { Request, Response } from 'express'
import * as departmentModel from '../../models/department.js'
import { logger } from '../../utils/logger.js'
import util from 'util'

const router = express.Router()

/** Normaliza cualquier error (unknown) a info segura para log y response */
function getErrInfo(err: unknown): { message: string; stack?: string } {
  if (err instanceof Error) return { message: err.message, stack: err.stack }
  // Prisma a veces trae objetos planos
  try {
    if (typeof err === 'object' && err !== null) {
      return { message: util.inspect(err, { depth: 1 }) }
    }
  } catch { /* ignore */ }
  return { message: String(err ?? 'Unknown error') }
}

/** Pretty print a consola (opcional en dev) */
function prettyLogError(tag: string, err: unknown) {
  const info = getErrInfo(err)
  // Usa console solo como respaldo; pino es el principal
  // Evita reventar si hay objetos circulares
  console.error(`\n🔥 [${tag}] ERROR START ------------------`)
  try {
    console.error(util.inspect(err, { depth: null, colors: true }))
  } catch {
    console.error(String(err))
  }
  console.error('stack:', info.stack ?? '<no stack>')
  console.error(`🔥 [${tag}] ERROR END --------------------\n`)
}

/** Obtiene nombre de usuario de forma segura sin depender de tipos extra */
function getUserName(req: Request): string {
  const anyReq = req as any
  return (
    anyReq?.user?.name ||
    anyReq?.user?.username ||
    anyReq?.session?.user?.name ||
    anyReq?.session?.user?.username ||
    'Admin'
  )
}

/**
 * Página: Departamentos
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    logger.info('Loading departments page...')
    const departments = await departmentModel.getAll()
    const safeDepartments = Array.isArray(departments) ? departments : []
    logger.info({ count: safeDepartments.length }, 'Departments loaded')

    res.render('departments', {
      title: 'Departamentos',
      departments: safeDepartments,
      user: getUserName(req),
    })
  } catch (err: unknown) {
    prettyLogError('/departments GET', err)
    const info = getErrInfo(err)
    logger.error({ err, ...info }, 'Error loading departments page')

    const isDev = process.env.NODE_ENV !== 'production'
    if (isDev) {
      res
        .status(500)
        .send(`<pre>Internal server error\n\n${info.stack ?? info.message}</pre>`)
    } else {
      res.status(500).render('departments', {
        title: 'Departamentos',
        departments: [],
        user: getUserName(req),
        error: 'Internal server error',
      })
    }
  }
})

/**
 * API: listar todos
 */
router.get('/api', async (_req: Request, res: Response) => {
  try {
    const departments = await departmentModel.getAll()
    res.json(Array.isArray(departments) ? departments : [])
  } catch (err: unknown) {
    prettyLogError('/departments/api GET', err)
    const info = getErrInfo(err)
    logger.error({ err, ...info }, 'Error getting departments')
    res.status(500).json({ error: 'Error getting departments', message: info.message })
  }
})

/**
 * API: obtener por id
 */
router.get('/api/:id', async (req: Request, res: Response) => {
  try {
    const department = await departmentModel.findById(req.params.id)
    if (!department) return res.status(404).json({ error: 'Department not found' })
    res.json(department)
  } catch (err: unknown) {
    prettyLogError('/departments/api/:id GET', err)
    const info = getErrInfo(err)
    logger.error({ err, ...info }, 'Error getting department')
    res.status(500).json({ error: 'Error getting department', message: info.message })
  }
})

/**
 * API: crear
 */
router.post('/api', async (req: Request, res: Response) => {
  try {
    const { name, description, phoneNumber, isActive, sortOrder } = req.body ?? {}
    if (!name) return res.status(400).json({ error: 'Name is required' })

    const department = await departmentModel.create({
      name,
      description,
      phoneNumber,
      isActive: isActive !== false,
      sortOrder: sortOrder ?? 0,
    })
    res.json(department)
  } catch (err: unknown) {
    prettyLogError('/departments/api POST', err)
    const info = getErrInfo(err)
    logger.error({ err, ...info }, 'Error creating department')
    res.status(500).json({ error: 'Error creating department', message: info.message })
  }
})

/**
 * API: actualizar
 */
router.put('/api/:id', async (req: Request, res: Response) => {
  try {
    const { name, description, phoneNumber, isActive, sortOrder } = req.body ?? {}
    const department = await departmentModel.update(req.params.id, {
      name,
      description,
      phoneNumber,
      isActive,
      sortOrder,
    })
    res.json(department)
  } catch (err: unknown) {
    prettyLogError('/departments/api/:id PUT', err)
    const info = getErrInfo(err)
    logger.error({ err, ...info }, 'Error updating department')
    res.status(500).json({ error: 'Error updating department', message: info.message })
  }
})

/**
 * API: eliminar
 */
router.delete('/api/:id', async (req: Request, res: Response) => {
  try {
    await departmentModel.remove(req.params.id)
    res.json({ success: true })
  } catch (err: unknown) {
    prettyLogError('/departments/api/:id DELETE', err)
    const info = getErrInfo(err)
    logger.error({ err, ...info }, 'Error deleting department')
    res.status(500).json({ error: 'Error deleting department', message: info.message })
  }
})

/**
 * API: agregar keyword
 */
router.post('/api/:id/keywords', async (req: Request, res: Response) => {
  try {
    const departmentId = req.params.id
    const { keyword, priority } = req.body ?? {}
    if (!keyword || String(keyword).trim() === '') {
      return res.status(400).json({ error: 'keyword is required' })
    }

    const created = await departmentModel.addKeyword(departmentId, String(keyword), priority ?? 1)
    res.json(created)
  } catch (err: unknown) {
    prettyLogError('/departments/api/:id/keywords POST', err)
    const info = getErrInfo(err)
    const code = (err as any)?.code
    logger.error({ err, code, ...info }, 'Error adding keyword')

    if (code === 'P2002') {
      return res.status(409).json({ error: 'Keyword already exists for this department' })
    }
    res.status(500).json({ error: 'Error adding keyword', message: info.message })
  }
})

/**
 * API: actualizar keyword
 */
router.put('/api/keywords/:keywordId', async (req: Request, res: Response) => {
  try {
    const { keywordId } = req.params
    const { keyword, priority } = req.body ?? {}
    const updated = await departmentModel.updateKeyword(keywordId, { keyword, priority })
    res.json(updated)
  } catch (err: unknown) {
    prettyLogError('/departments/api/keywords/:keywordId PUT', err)
    const info = getErrInfo(err)
    logger.error({ err, ...info }, 'Error updating keyword')
    res.status(500).json({ error: 'Error updating keyword', message: info.message })
  }
})

/**
 * API: eliminar keyword
 */
router.delete('/api/keywords/:keywordId', async (req: Request, res: Response) => {
  try {
    const { keywordId } = req.params
    await departmentModel.removeKeyword(keywordId)
    res.json({ success: true })
  } catch (err: unknown) {
    prettyLogError('/departments/api/keywords/:keywordId DELETE', err)
    const info = getErrInfo(err)
    logger.error({ err, ...info }, 'Error removing keyword')
    res.status(500).json({ error: 'Error removing keyword', message: info.message })
  }
})

/**
 * API: agregar contacto
 */
router.post('/api/:id/contacts', async (req: Request, res: Response) => {
  try {
    const departmentId = req.params.id
    const { name, phoneNumber, role, isActive, sortOrder } = req.body ?? {}
    if (!name || !phoneNumber) {
      return res.status(400).json({ error: 'name and phoneNumber are required' })
    }
    const created = await departmentModel.addContact({
      departmentId,
      name,
      phoneNumber,
      role: role ?? null,
      isActive: isActive !== false,
      sortOrder: sortOrder ?? 0,
    })
    res.json(created)
  } catch (err: unknown) {
    prettyLogError('/departments/api/:id/contacts POST', err)
    const info = getErrInfo(err)
    logger.error({ err, ...info }, 'Error adding contact')
    res.status(500).json({ error: 'Error adding contact', message: info.message })
  }
})

/**
 * API: actualizar contacto
 */
router.put('/api/contacts/:contactId', async (req: Request, res: Response) => {
  try {
    const { contactId } = req.params
    const { name, phoneNumber, role, isActive, sortOrder } = req.body ?? {}
    const updated = await departmentModel.updateContact(contactId, {
      name,
      phoneNumber,
      role,
      isActive,
      sortOrder,
    })
    res.json(updated)
  } catch (err: unknown) {
    prettyLogError('/departments/api/contacts/:contactId PUT', err)
    const info = getErrInfo(err)
    logger.error({ err, ...info }, 'Error updating contact')
    res.status(500).json({ error: 'Error updating contact', message: info.message })
  }
})

/**
 * API: eliminar contacto
 */
router.delete('/api/contacts/:contactId', async (req: Request, res: Response) => {
  try {
    const { contactId } = req.params
    await departmentModel.removeContact(contactId)
    res.json({ success: true })
  } catch (err: unknown) {
    prettyLogError('/departments/api/contacts/:contactId DELETE', err)
    const info = getErrInfo(err)
    logger.error({ err, ...info }, 'Error removing contact')
    res.status(500).json({ error: 'Error removing contact', message: info.message })
  }
})

export default router
