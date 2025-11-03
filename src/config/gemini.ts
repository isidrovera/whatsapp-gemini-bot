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
  logger.debug('[GEMINI-CONFIG] Getting model name from database...');
  
  try {
    const modelFromDb = await configModel.get('gemini', 'model');
    
    if (modelFromDb && modelFromDb.trim()) {
      logger.info(`[GEMINI-CONFIG] ✓ Model from database: "${modelFromDb.trim()}"`);
      return modelFromDb.trim();
    }
    
    logger.info('[GEMINI-CONFIG] No model in database, using default: "gemini-2.5-flash"');
    return 'gemini-2.5-flash';
  } catch (err: any) {
    logger.error('[GEMINI-CONFIG] Error getting model name from database');
    logger.error(`[GEMINI-CONFIG]   Error: ${err?.message || 'Unknown'}`);
    logger.warn('[GEMINI-CONFIG] Falling back to default model: "gemini-2.5-flash"');
    return 'gemini-2.5-flash';
  }
}

/**
 * Obtiene la API Key de Gemini SOLO desde BD.
 */
async function getApiKey(): Promise<string> {
  logger.debug('[GEMINI-CONFIG] Retrieving API key from database...');
  
  try {
    const apiKeyFromDb = await configModel.get('gemini', 'api_key');
    
    logger.debug('[GEMINI-CONFIG] API key query completed');
    logger.debug(`[GEMINI-CONFIG]   Has value: ${!!apiKeyFromDb}`);
    logger.debug(`[GEMINI-CONFIG]   Length: ${apiKeyFromDb?.length || 0} chars`);
    
    if (apiKeyFromDb && apiKeyFromDb.trim().length >= 20) {
      const key = apiKeyFromDb.trim();
      const maskedKey = key.substring(0, 8) + '...' + key.substring(key.length - 4);
      logger.info(`[GEMINI-CONFIG] ✓ API key found in database: ${maskedKey}`);
      logger.debug('[GEMINI-CONFIG] Using Gemini API key from database');
      return key;
    }
    
    logger.error('[GEMINI-CONFIG] ✗ API key is missing or too short');
    logger.error(`[GEMINI-CONFIG]   Received length: ${apiKeyFromDb?.trim().length || 0} (minimum: 20)`);
    
    throw new Error(
      'Gemini API Key no configurada. Ve a Configuración → Gemini y guarda tu clave.'
    );
  } catch (err: any) {
    if (err.message?.includes('no configurada')) {
      throw err; // Re-lanzar el error de configuración
    }
    
    logger.error('[GEMINI-CONFIG] Error accessing database for API key');
    logger.error(`[GEMINI-CONFIG]   Error type: ${err?.constructor?.name || 'Unknown'}`);
    logger.error(`[GEMINI-CONFIG]   Error message: ${err?.message || 'Unknown'}`);
    
    if (err?.stack) {
      logger.error('[GEMINI-CONFIG]   Stack trace:');
      logger.error(err.stack);
    }
    
    throw new Error('Error al obtener API key de Gemini desde la base de datos');
  }
}

/**
 * Obtiene el modelo de Gemini (con caché)
 */
export async function getGeminiModel(): Promise<GenerativeModel> {
  logger.info('[GEMINI-CONFIG] ═════════════════════════════════════════');
  logger.info('[GEMINI-CONFIG] getGeminiModel() called');
  logger.info('[GEMINI-CONFIG] ═════════════════════════════════════════');
  
  try {
    logger.debug('[GEMINI-CONFIG] Step 1: Retrieving API key...');
    const apiKey = await getApiKey();
    logger.info('[GEMINI-CONFIG] ✓ API key retrieved successfully');

    // Si el API key cambió, resetear el caché
    logger.debug('[GEMINI-CONFIG] Step 2: Checking cache status...');
    logger.debug(`[GEMINI-CONFIG]   Has cached model: ${!!cachedModel}`);
    logger.debug(`[GEMINI-CONFIG]   Has cached API key: ${!!cachedApiKey}`);
    
    if (cachedApiKey && cachedApiKey !== apiKey) {
      logger.info('[GEMINI-CONFIG] ⚠ API key changed, resetting cache');
      logger.debug({ oldKeyPrefix: cachedApiKey.substring(0, 8), newKeyPrefix: apiKey.substring(0, 8) }, '[GEMINI-CONFIG] Keys diff');
      cachedModel = null;
      cachedApiKey = null;
    }

    // Si ya tenemos un modelo en caché con la misma API key, usarlo
    if (cachedModel && cachedApiKey === apiKey) {
      logger.info('[GEMINI-CONFIG] ✓ Using cached Gemini model (no initialization needed)');
      logger.debug('[GEMINI-CONFIG] Cache hit - returning existing model');
      logger.info('[GEMINI-CONFIG] ═════════════════════════════════════════');
      return cachedModel;
    }

    logger.info('[GEMINI-CONFIG] Step 3: Initializing new Gemini model...');
    logger.debug('[GEMINI-CONFIG] Cache miss - creating new model instance');

    logger.debug('[GEMINI-CONFIG] Step 3.1: Creating GoogleGenerativeAI client...');
    const genAI = new GoogleGenerativeAI(apiKey);
    logger.debug('[GEMINI-CONFIG] ✓ Client created');

    logger.debug('[GEMINI-CONFIG] Step 3.2: Getting model name...');
    const modelName = await getModelName();
    logger.info(`[GEMINI-CONFIG] ✓ Model name: "${modelName}"`);

    logger.debug('[GEMINI-CONFIG] Step 3.3: Configuring model parameters...');
    const modelConfig = {
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
    };

    logger.debug({
      model: modelConfig.model,
      temperature: modelConfig.generationConfig.temperature,
      topP: modelConfig.generationConfig.topP,
      topK: modelConfig.generationConfig.topK,
      maxOutputTokens: modelConfig.generationConfig.maxOutputTokens,
      safetySettingsCount: modelConfig.safetySettings.length,
    }, '[GEMINI-CONFIG] Configuration');

    logger.debug('[GEMINI-CONFIG] Step 3.4: Creating generative model instance...');
    cachedModel = genAI.getGenerativeModel(modelConfig);
    cachedApiKey = apiKey;
    
    logger.info('[GEMINI-CONFIG] ✓✓✓ Model instance created successfully');
    logger.debug('[GEMINI-CONFIG] Model cached for future requests');

    logger.info('[GEMINI-CONFIG] ═════════════════════════════════════════');
    logger.info(`[GEMINI-CONFIG] ✅ Gemini model initialized (model="${modelName}")`);
    logger.info('[GEMINI-CONFIG] ═════════════════════════════════════════');
    
    return cachedModel;
  } catch (error: any) {
    logger.error('[GEMINI-CONFIG] ═════════════════════════════════════════');
    logger.error('[GEMINI-CONFIG] ✗✗✗ FAILED TO INITIALIZE GEMINI MODEL ✗✗✗');
    logger.error('[GEMINI-CONFIG] ═════════════════════════════════════════');
    logger.error('[GEMINI-CONFIG] Error details:');
    logger.error(`[GEMINI-CONFIG]   Type: ${error?.constructor?.name || 'Unknown'}`);
    logger.error(`[GEMINI-CONFIG]   Message: ${error?.message || 'Unknown error'}`);
    logger.error(`[GEMINI-CONFIG]   Code: ${error?.code || 'N/A'}`);
    logger.error(`[GEMINI-CONFIG]   Status: ${error?.status || 'N/A'}`);
    
    if (error?.response) {
      logger.error({ response: error.response }, '[GEMINI-CONFIG]   Response');
    }
    
    if (error?.stack) {
      logger.error('[GEMINI-CONFIG]   Stack trace:');
      logger.error(error.stack);
    }
    
    logger.error('[GEMINI-CONFIG] ═════════════════════════════════════════');
    throw error;
  }
}

/**
 * Test rápido para confirmar que Gemini responde
 */
export async function geminiSelfTest(): Promise<boolean> {
  logger.info('[GEMINI-TEST] ═════════════════════════════════════════');
  logger.info('[GEMINI-TEST] Running Gemini self-test...');
  logger.info('[GEMINI-TEST] ═════════════════════════════════════════');
  
  try {
    logger.debug('[GEMINI-TEST] Step 1: Getting model instance...');
    const model = await getGeminiModel();
    logger.debug('[GEMINI-TEST] ✓ Model obtained');
    
    logger.debug('[GEMINI-TEST] Step 2: Sending test prompt...');
    const testPrompt = 'Responde solo con: OK';
    logger.debug(`[GEMINI-TEST]   Prompt: "${testPrompt}"`);
    
    const startTime = Date.now();
    const result = await model.generateContent(testPrompt);
    const elapsed = Date.now() - startTime;
    
    logger.debug(`[GEMINI-TEST] ✓ Response received in ${elapsed}ms`);
    
    logger.debug('[GEMINI-TEST] Step 3: Extracting response text...');
    const response = result.response.text().trim();
    
    logger.info(`[GEMINI-TEST] Response: "${response}"`);
    
    const success = response.toLowerCase().includes('ok');
    
    if (success) {
      logger.info('[GEMINI-TEST] ✓✓✓ Self-test PASSED');
    } else {
      logger.warn('[GEMINI-TEST] ⚠ Self-test response unexpected');
      logger.warn(`[GEMINI-TEST]   Expected: contains "ok"`);
      logger.warn(`[GEMINI-TEST]   Received: "${response}"`);
    }
    
    logger.info('[GEMINI-TEST] ═════════════════════════════════════════');
    return success;
  } catch (error: any) {
    logger.error('[GEMINI-TEST] ═════════════════════════════════════════');
    logger.error('[GEMINI-TEST] ✗✗✗ Self-test FAILED ✗✗✗');
    logger.error('[GEMINI-TEST] ═════════════════════════════════════════');
    logger.error(`[GEMINI-TEST] Error type: ${error?.constructor?.name || 'Unknown'}`);
    logger.error(`[GEMINI-TEST] Error message: ${error?.message || 'Unknown'}`);
    
    if (error?.code) {
      logger.error(`[GEMINI-TEST] Error code: ${error.code}`);
    }
    
    if (error?.status) {
      logger.error(`[GEMINI-TEST] HTTP status: ${error.status}`);
    }
    
    if (error?.response) {
      logger.error({ response: error.response }, '[GEMINI-TEST] Error response');
    }
    
    if (error?.stack) {
      logger.error('[GEMINI-TEST] Stack trace:');
      logger.error(error.stack);
    }
    
    logger.error('[GEMINI-TEST] ═════════════════════════════════════════');
    return false;
  }
}

/**
 * Resetear el modelo en caché (útil después de cambiar configuración)
 */
export function resetGeminiModel(): void {
  logger.info('[GEMINI-CONFIG] ═════════════════════════════════════════');
  logger.info('[GEMINI-CONFIG] Resetting Gemini model cache...');
  
  const hadCachedModel = !!cachedModel;
  const hadCachedKey = !!cachedApiKey;
  
  cachedModel = null;
  cachedApiKey = null;
  
  logger.info('[GEMINI-CONFIG] ✓ Cache cleared');
  logger.debug(`[GEMINI-CONFIG]   Had cached model: ${hadCachedModel}`);
  logger.debug(`[GEMINI-CONFIG]   Had cached key: ${hadCachedKey}`);
  logger.info('[GEMINI-CONFIG] ═════════════════════════════════════════');
}

/**
 * Inicializa el cliente/modelo de Gemini (opcionalmente corre un self-test)
 */
export async function initializeGemini(runSelfTest = false): Promise<void> {
  logger.info('[GEMINI-INIT] ═════════════════════════════════════════');
  logger.info('[GEMINI-INIT] Initializing Gemini...');
  logger.info(`[GEMINI-INIT] Self-test enabled: ${runSelfTest}`);
  logger.info('[GEMINI-INIT] ═════════════════════════════════════════');
  
  try {
    logger.debug('[GEMINI-INIT] Step 1: Loading/creating model...');
    
    // Fuerza a crear/cargar el modelo en caché o lanza si falta la API key
    await getGeminiModel();
    
    logger.info('[GEMINI-INIT] ✓ Model loaded successfully');

    if (runSelfTest) {
      logger.debug('[GEMINI-INIT] Step 2: Running self-test...');
      
      try {
        const ok = await geminiSelfTest();
        
        if (!ok) {
          logger.warn('[GEMINI-INIT] ⚠ Self-test did not return expected response');
        } else {
          logger.info('[GEMINI-INIT] ✓ Self-test passed');
        }
      } catch (e: any) {
        logger.warn('[GEMINI-INIT] ⚠ Self-test failed');
        logger.warn(`[GEMINI-INIT]   Error: ${e?.message || 'Unknown'}`);
      }
    } else {
      logger.debug('[GEMINI-INIT] Skipping self-test (not requested)');
    }

    logger.info('[GEMINI-INIT] ═════════════════════════════════════════');
    logger.info('[GEMINI-INIT] ✅ Gemini initialized successfully');
    logger.info('[GEMINI-INIT] ═════════════════════════════════════════');
  } catch (error: any) {
    logger.error('[GEMINI-INIT] ═════════════════════════════════════════');
    logger.error('[GEMINI-INIT] ❌ Failed to initialize Gemini');
    logger.error('[GEMINI-INIT] ═════════════════════════════════════════');
    logger.error(`[GEMINI-INIT] Error: ${error?.message || 'Unknown'}`);
    
    if (error?.stack) {
      logger.error('[GEMINI-INIT] Stack trace:');
      logger.error(error.stack);
    }
    
    logger.error('[GEMINI-INIT] ═════════════════════════════════════════');
    throw error;
  }
}

/**
 * Genera una respuesta usando Gemini
 */
export async function generateResponse(prompt: string, context?: string): Promise<string> {
  logger.info('[GEMINI-GENERATE] ═════════════════════════════════════════');
  logger.info('[GEMINI-GENERATE] Generating response...');
  logger.debug(`[GEMINI-GENERATE] Prompt length: ${prompt?.length || 0} chars`);
  logger.debug(`[GEMINI-GENERATE] Has context: ${!!context}`);
  
  if (context) {
    logger.debug(`[GEMINI-GENERATE] Context length: ${context.length} chars`);
  }
  
  try {
    logger.debug('[GEMINI-GENERATE] Step 1: Getting model...');
    const model = await getGeminiModel();
    logger.debug('[GEMINI-GENERATE] ✓ Model obtained');

    logger.debug('[GEMINI-GENERATE] Step 2: Building full prompt...');
    const fullPrompt = context ? `${context}\n\nUsuario: ${prompt}` : prompt;
    logger.debug(`[GEMINI-GENERATE] Full prompt length: ${fullPrompt.length} chars`);
    logger.debug(`[GEMINI-GENERATE] Prompt preview: ${fullPrompt.substring(0, 150)}...`);

    logger.debug('[GEMINI-GENERATE] Step 3: Calling generateContent()...');
    const startTime = Date.now();
    
    const result = await model.generateContent(fullPrompt);
    
    const elapsed = Date.now() - startTime;
    logger.info(`[GEMINI-GENERATE] ✓ Response received in ${elapsed}ms`);
    
    logger.debug('[GEMINI-GENERATE] Step 4: Extracting text from response...');
    const response = result.response;
    const responseText = response.text();
    
    logger.info(`[GEMINI-GENERATE] ✓ Response extracted: ${responseText.length} chars`);
    logger.debug(`[GEMINI-GENERATE] Response preview: ${responseText.substring(0, 200)}...`);
    
    logger.info('[GEMINI-GENERATE] ═════════════════════════════════════════');
    logger.info('[GEMINI-GENERATE] ✓✓✓ Response generated successfully');
    logger.info('[GEMINI-GENERATE] ═════════════════════════════════════════');
    
    return responseText;
  } catch (error: any) {
    logger.error('[GEMINI-GENERATE] ═════════════════════════════════════════');
    logger.error('[GEMINI-GENERATE] ✗✗✗ Error generating response ✗✗✗');
    logger.error('[GEMINI-GENERATE] ═════════════════════════════════════════');
    logger.error(`[GEMINI-GENERATE] Error type: ${error?.constructor?.name || 'Unknown'}`);
    logger.error(`[GEMINI-GENERATE] Error message: ${error?.message || 'Unknown'}`);
    logger.error(`[GEMINI-GENERATE] Error code: ${error?.code || 'N/A'}`);
    
    if (error?.response) {
      logger.error({ response: error.response }, '[GEMINI-GENERATE] Error response');
    }
    
    if (error?.stack) {
      logger.error('[GEMINI-GENERATE] Stack trace:');
      logger.error(error.stack);
    }
    
    logger.error('[GEMINI-GENERATE] ═════════════════════════════════════════');
    throw error;
  }
}

/**
 * Reinicializa Gemini (útil después de cambiar la API key en /settings)
 */
export async function reinitializeGemini(): Promise<void> {
  logger.info('[GEMINI-REINIT] ═════════════════════════════════════════');
  logger.info('[GEMINI-REINIT] Reinitializing Gemini with new config...');
  logger.info('[GEMINI-REINIT] ═════════════════════════════════════════');
  
  try {
    logger.debug('[GEMINI-REINIT] Step 1: Resetting cache...');
    resetGeminiModel();
    
    logger.debug('[GEMINI-REINIT] Step 2: Initializing with new config...');
    await initializeGemini(false);
    
    logger.info('[GEMINI-REINIT] ═════════════════════════════════════════');
    logger.info('[GEMINI-REINIT] ✅ Gemini reinitialized successfully');
    logger.info('[GEMINI-REINIT] ═════════════════════════════════════════');
  } catch (error: any) {
    logger.error('[GEMINI-REINIT] ═════════════════════════════════════════');
    logger.error('[GEMINI-REINIT] ❌ Reinitialization failed');
    logger.error('[GEMINI-REINIT] ═════════════════════════════════════════');
    logger.error(`[GEMINI-REINIT] Error: ${error?.message || 'Unknown'}`);
    
    if (error?.stack) {
      logger.error(error.stack);
    }
    
    logger.error('[GEMINI-REINIT] ═════════════════════════════════════════');
    throw error;
  }
}

/**
 * Verifica si Gemini está configurado correctamente
 */
export async function isGeminiConfigured(): Promise<boolean> {
  logger.debug('[GEMINI-CHECK] Checking if Gemini is configured...');
  
  try {
    await getApiKey();
    logger.info('[GEMINI-CHECK] ✓ Gemini is configured');
    return true;
  } catch (error: any) {
    logger.warn('[GEMINI-CHECK] ✗ Gemini is NOT configured');
    logger.debug(`[GEMINI-CHECK]   Reason: ${error?.message || 'Unknown'}`);
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
  logger.debug('[GEMINI-INFO] Getting Gemini configuration info...');
  
  try {
    logger.debug('[GEMINI-INFO] Step 1: Checking API key...');
    const apiKey = await getApiKey(); // lanza si falta
    logger.debug('[GEMINI-INFO] ✓ API key exists');
    
    logger.debug('[GEMINI-INFO] Step 2: Getting model name...');
    const modelFromDb = await configModel.get('gemini', 'model');
    
    const modelName = (modelFromDb && modelFromDb.trim()) || 'gemini-2.5-flash';
    const source: 'database' | 'default' = modelFromDb ? 'database' : 'default';
    
    const info = {
      configured: !!apiKey,
      model: modelName,
      source,
    };
    
    logger.info({ info }, '[GEMINI-INFO] Configuration info');
    return info;
  } catch (error: any) {
    logger.warn('[GEMINI-INFO] Could not get full configuration info');
    logger.debug(`[GEMINI-INFO]   Error: ${error?.message || 'Unknown'}`);
    
    const fallbackInfo = {
      configured: false,
      model: 'gemini-2.5-flash',
      source: 'default' as const,
    };
    
    logger.debug({ fallbackInfo }, '[GEMINI-INFO] Returning fallback info');
    return fallbackInfo;
  }
}
