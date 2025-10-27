import { config } from 'dotenv';
import { z } from 'zod';

config();

/**
 * Schema de variables de entorno CRÍTICAS del sistema
 * Solo incluye configuraciones necesarias para el arranque
 * Las demás configs se gestionan desde la base de datos
 */
const envSchema = z.object({
  // Base de datos (CRÍTICO)
  DATABASE_URL: z.string().min(1, 'DATABASE_URL es requerida'),
  
  // Web Server
  WEB_PORT: z.string().default('3000'),
  
  // Seguridad
  SESSION_SECRET: z.string().min(20, 'SESSION_SECRET debe tener al menos 20 caracteres'),
  
  // Entorno
  NODE_ENV: z.enum(['development', 'production']).default('development'),
});

// Validar y exportar
export const env = envSchema.parse(process.env);

// Helper para verificar si estamos en producción
export const isProduction = env.NODE_ENV === 'production';
export const isDevelopment = env.NODE_ENV === 'development';