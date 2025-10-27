// src/config/gemini.ts
import {
  GoogleGenerativeAI,
  HarmCategory,
  HarmBlockThreshold,
  GenerativeModel,
} from '@google/generative-ai';
import { logger } from '../utils/logger.js';
import * as configModel from '../models/configuration.js';

let cachedModel: GenerativeModel | null = null;
let cachedApiKey: string | null = null;

/**
 * Obtiene el nombre del modelo SOLO desde BD, o usa default.
 */
async function getModelName(): Promise<string> {
  const modelFromDb = await configModel.get('gemini', 'model');
  return (modelFromDb && modelFromDb.trim()) || 'gemini-2.5-flash';
}

/**
 * Obtiene la API Key de Gemini SOLO desde BD.
 */
async function getApiKey(): Promise<string> {
  const apiKeyFromDb = await configModel.get('gemini', 'api_key');
  if (apiKeyFromDb && apiKeyFromDb.trim().length >= 20) {
    logger.debug('Using Gemini API key from database');
    return apiKeyFromDb.trim();
  }
  throw new Error(
    'Gemini API Key no configurada. Ve a Configuración → Gemini y guarda tu clave.'
  );
}

/**
 * Obtiene el modelo de Gemini (con caché)
 */
export async function getGeminiModel(): Promise<GenerativeModel> {
  try {
    const apiKey = await getApiKey();

    // Si el API key cambió, resetear el caché
    if (cachedApiKey && cachedApiKey !== apiKey) {
      logger.info('API key changed, resetting Gemini model cache');
      cachedModel = null;
      cachedApiKey = null;
    }

    // Si ya tenemos un modelo en caché con la misma API key, usarlo
    if (cachedModel && cachedApiKey === apiKey) {
      logger.debug('Using cached Gemini model');
      return cachedModel;
    }

    logger.info('Initializing new Gemini model...');

    const genAI = new GoogleGenerativeAI(apiKey);
    const modelName = await getModelName();

    cachedModel = genAI.getGenerativeModel({
      model: modelName,
      generationConfig: {
        temperature: 0.7,
        topP: 0.95,
        topK: 40,
        maxOutputTokens: 8192,
      },
      safetySettings: [
        {
          category: HarmCategory.HARM_CATEGORY_HARASSMENT,
          threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
        },
        {
          category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
          threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
        },
        {
          category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
          threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
        },
        {
          category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
          threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
        },
      ],
    });

    cachedApiKey = apiKey;

    logger.info(`✅ Gemini model initialized successfully (model="${modelName}")`);
    return cachedModel;
  } catch (error) {
    logger.error('Failed to initialize Gemini model:', error);
    throw error;
  }
}

/**
 * Test rápido para confirmar que Gemini responde
 */
export async function geminiSelfTest(): Promise<boolean> {
  try {
    logger.info('Running Gemini self-test...');
    const model = await getGeminiModel();
    const result = await model.generateContent('Responde solo con: OK');
    const response = result.response.text().trim();
    logger.info(`Gemini self-test response: "${response}"`);
    return response.toLowerCase().includes('ok');
  } catch (error) {
    logger.error('Gemini self-test failed:', error);
    return false;
  }
}

/**
 * Resetear el modelo en caché (útil después de cambiar configuración)
 */
export function resetGeminiModel(): void {
  cachedModel = null;
  cachedApiKey = null;
  logger.info('Gemini model cache cleared');
}

/**
 * Inicializa el cliente/modelo de Gemini (opcionalmente corre un self-test)
 */
export async function initializeGemini(runSelfTest = false): Promise<void> {
  try {
    // Fuerza a crear/cargar el modelo en caché o lanza si falta la API key
    await getGeminiModel();

    if (runSelfTest) {
      try {
        const ok = await geminiSelfTest();
        if (!ok) {
          logger.warn('Gemini self-test no respondió "OK"');
        }
      } catch (e) {
        logger.warn('Fallo el self-test de Gemini:', e);
      }
    }

    logger.info('✅ Gemini initialized successfully');
  } catch (error) {
    logger.error('❌ Failed to initialize Gemini:', error);
    throw error;
  }
}

/**
 * Genera una respuesta usando Gemini
 */
export async function generateResponse(prompt: string, context?: string): Promise<string> {
  try {
    const model = await getGeminiModel();

    const fullPrompt = context ? `${context}\n\nUsuario: ${prompt}` : prompt;

    const result = await model.generateContent(fullPrompt);
    const response = result.response;
    return response.text();
  } catch (error) {
    logger.error('Error generating Gemini response:', error);
    throw error;
  }
}

/**
 * Reinicializa Gemini (útil después de cambiar la API key en /settings)
 */
export async function reinitializeGemini(): Promise<void> {
  resetGeminiModel();
  await initializeGemini(false);
  logger.info('✅ Gemini reinitialized with new configuration');
}

/**
 * Verifica si Gemini está configurado correctamente
 */
export async function isGeminiConfigured(): Promise<boolean> {
  try {
    await getApiKey();
    return true;
  } catch {
    return false;
  }
}

/**
 * Obtiene información de configuración actual de Gemini (solo DB o default)
 */
export async function getGeminiInfo(): Promise<{
  configured: boolean;
  model: string;
  source: 'database' | 'default';
}> {
  try {
    const apiKey = await getApiKey(); // lanza si falta
    const modelFromDb = await configModel.get('gemini', 'model');
    return {
      configured: !!apiKey,
      model: (modelFromDb && modelFromDb.trim()) || 'gemini-2.5-flash',
      source: modelFromDb ? 'database' : 'default',
    };
  } catch {
    return { configured: false, model: 'gemini-2.5-flash', source: 'default' };
  }
}
