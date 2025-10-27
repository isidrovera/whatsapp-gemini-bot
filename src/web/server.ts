// src/web/server.ts
import express from 'express';
import session from 'express-session';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import util from 'util';
import fileUpload from 'express-fileupload'; // usado SOLO para /api (send-media)
import { logger } from '../utils/logger.js';

// Rutas existentes
import authRouter from './routes/auth.js';
import dashboardRouter from './routes/dashboard.js';
import contactsRouter from './routes/contacts.js';
import blockedRouter from './routes/blocked.js';
import conversationsRouter from './routes/conversations.js';
import calendarRouter from './routes/calendar.js';
import workingHoursRouter from './routes/workingHours.js';
import adminUsersRouter from './routes/adminUsers.js';

// Rutas nuevas del panel
import settingsRouter from './routes/settings.js';
import departmentsRouter from './routes/departments.js';
import productsRouter from './routes/products.js';
import autoResponsesRouter from './routes/autoResponses.js';
import tagsRouter from './routes/tags.js';
import templatesRouter from './routes/templates.js';
import metricsRouter from './routes/metrics.js';

// Admin de API keys (interno)
import apiKeysRouter from './routes/apiKeys.js';

// API pública (envío WhatsApp vía token)
import apiRouter from './routes/api.js';

// Middleware de auth
import { requireAuth } from './middleware/auth.js';

//Compañias
import companiesRouter from './routes/companies.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.WEB_PORT || 3000;
const isDev = process.env.NODE_ENV !== 'production';

function prettyConsoleLogError(tag: string, err: any) {
  try {
    console.error(`\n🔥 [${tag}] ERROR START ------------------`);
    console.error(util.inspect(err, { depth: null, colors: true }));
    console.error('stack:', err && err.stack ? err.stack : '<no stack>');
    console.error(`🔥 [${tag}] ERROR END --------------------\n`);
  } catch (e) {
    console.error('Failed to pretty-log error', e);
    console.error(String(err));
  }
}

// ======================
// Middlewares globales
// ======================
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// ⚠ IMPORTANTE ⚠
// Quitamos el app.use(fileUpload(...)) global.
// Si lo dejas global, intercepta TODOS los multipart/form-data
// y luego multer (en /blocked/api/import) recibe el request roto
// => "Unexpected end of form"
// En su lugar, más abajo lo aplicamos SOLO en /api (público).

// ======================
// SESSION
// ======================
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'whatsapp-bot-secret-key-change-me',
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === 'production',
      httpOnly: true,
      maxAge: 24 * 60 * 60 * 1000, // 24h
    },
  })
);

// ======================
// VIEWS
// ======================
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Helper global para las vistas
app.use((req, res, next) => {
  res.locals.page = req.path.split('/')[1] || 'dashboard';
  res.locals.user = req.session?.username || null;
  next();
});

// ======================
// RUTAS PÚBLICAS
// ======================

// Login / logout / QR / etc.
app.use('/auth', authRouter);

// API pública externa
// - NO usa requireAuth (sesión web)
// - Valida con API key adentro de apiRouter
// - Necesita fileUpload SOLO para /api/send-media
//
// Entonces montamos un "sub-app" con fileUpload ANTES de apiRouter,
// pero NO lo aplicamos al resto del panel.
const publicApiApp = express.Router();

// este middleware SOLO afecta rutas dentro de /api
publicApiApp.use(
  fileUpload({
    useTempFiles: false,
    createParentPath: false,
    limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB
    abortOnLimit: true,
  })
);

// ahora montamos las rutas públicas reales
publicApiApp.use('/', apiRouter);

// y finalmente lo colgamos en /api
app.use('/api', publicApiApp);

// ======================
// RUTAS PRIVADAS (panel)
// ======================

// Dashboard y operaciones principales
app.use('/', requireAuth, dashboardRouter);
app.use('/contacts', requireAuth, contactsRouter);
app.use('/blocked', requireAuth, blockedRouter); // ← multer vive adentro de este router
app.use('/conversations', requireAuth, conversationsRouter);

// Gestión de tiempo y horarios
app.use('/calendar', requireAuth, calendarRouter);
app.use('/working-hours', requireAuth, workingHoursRouter);

// Administración
app.use('/admin-users', requireAuth, adminUsersRouter);
app.use('/settings', requireAuth, settingsRouter);

// Gestión empresarial / bot
app.use('/departments', requireAuth, departmentsRouter);
app.use('/products', requireAuth, productsRouter);
app.use('/auto-responses', requireAuth, autoResponsesRouter);
app.use('/tags', requireAuth, tagsRouter);
app.use('/templates', requireAuth, templatesRouter);
app.use('/metrics', requireAuth, metricsRouter);
app.use('/companies', requireAuth, companiesRouter);


// Gestión de API keys desde el panel interno
app.use('/api-keys', requireAuth, apiKeysRouter);

// ======================
// 404 handler
// ======================
app.use((req, res) => {
  res.status(404).send('Not Found');
});

// ======================
// Error handler
// ======================
app.use(
  (
    err: any,
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
  ) => {
    // consola bonita
    prettyConsoleLogError('Web server', err);

    // logger estructurado
    try {
      logger.error('Web server error', {
        message: err?.message,
        name: err?.name,
        stack: err?.stack,
        code: err?.code,
        meta: err?.meta || null,
        url: req.originalUrl,
        method: req.method,
      });
    } catch (e) {
      console.error('Logger failed while logging error:', e);
    }

    // respuesta al cliente
    if (isDev) {
      res
        .status(500)
        .send(
          `<pre>Internal server error\n\n${
            err && err.stack ? err.stack : String(err)
          }</pre>`
        );
    } else {
      res.status(500).send('Internal server error');
    }
  }
);

// ======================
// Global process handlers
// ======================
process.on('unhandledRejection', (reason) => {
  try {
    prettyConsoleLogError('unhandledRejection', reason);
    logger.error('Unhandled Rejection', {
      reason:
        reason && (reason as any).stack
          ? (reason as any).stack
          : reason,
    });
  } catch (e) {
    console.error('Error logging unhandledRejection', e);
  }
});

process.on('uncaughtException', (err) => {
  try {
    prettyConsoleLogError('uncaughtException', err);
    logger.error('Uncaught Exception', {
      message: err?.message,
      stack: err?.stack,
    });
  } catch (e) {
    console.error('Error logging uncaughtException', e);
  } finally {
    if (process.env.NODE_ENV === 'production') {
      process.exit(1);
    }
  }
});

// ======================
// startWebServer()
// ======================
export function startWebServer() {
  app.listen(PORT, () => {
    logger.info(`✅ Web admin panel: http://localhost:${PORT}`);
    logger.info('');
    logger.info('📋 Available routes:');
    logger.info('   🔐 Auth:           /auth/login');
    logger.info('   📊 Dashboard:      /');
    logger.info('   👥 Contacts:       /contacts');
    logger.info('   💬 Conversations:  /conversations');
    logger.info('   🚫 Blocked:        /blocked');
    logger.info('');
    logger.info('   📅 Calendar:       /calendar');
    logger.info('   ⏰ Working Hours:  /working-hours');
    logger.info('');
    logger.info('   🏢 Departments:    /departments');
    logger.info('   📦 Products:       /products');
    logger.info('   🤖 Auto Responses: /auto-responses');
    logger.info('   🏷️  Tags:           /tags');
    logger.info('   📝 Templates:      /templates');
    logger.info('   📊 Metrics:        /metrics');
    logger.info('');
    logger.info('   👥 Admin Users:    /admin-users');
    logger.info('   🔑 API Keys:       /api-keys');
    logger.info('   ⚙️  Settings:       /settings');
    logger.info('');
    logger.info('🌐 Public API base:   /api');
    logger.info('   -> POST /api/send-message');
    logger.info('   -> POST /api/send-media');
    logger.info('');
    logger.info('📦 Contacts extras (panel interno):');
    logger.info('   -> GET    /contacts/api-export         (exportar contactos/multiempresa)');
    logger.info('   -> POST   /contacts/api-import         (importar desde Excel parseado)');
    logger.info('   -> POST   /contacts/api/:contactId/company                (agregar empresa)');
    logger.info('   -> POST   /contacts/api/:contactId/company/:companyId/primary  (marcar primaria)');
    logger.info('   -> DELETE /contacts/api/:contactId/company/:companyId     (quitar empresa)');
    logger.info('   -> PUT    /contacts/api/contact/:contactId                (editar contacto)');
    logger.info('   -> DELETE /contacts/api/contact/:contactId                (eliminar contacto)');
    logger.info('');
  });
}

export default app;
