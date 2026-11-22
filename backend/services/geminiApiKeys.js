import { GoogleGenAI } from '@google/genai';

function getConfiguredKeys() {
  const configuredKeys = [
    process.env.GEMINI_API_KEY,
    process.env.GEMINI_API_KEY_2,
    ...(process.env.GEMINI_API_KEYS || '').split(',')
  ].filter((key) => typeof key === 'string').map((key) => key.trim()).filter(Boolean);
  return [...new Set(configuredKeys)];
}

let nextIndex = 0;
const backoffStatuses = new Set([404, 429, 503]);
const retryBackoffMs = 1500;
const keyCooldownUntil = new Map();
const keyCooldownMs = 60 * 1000;

export const GEMINI_TEXT_MODELS = [
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-2.0-flash'
];

function statusCode(error) {
  if (!error || typeof error !== 'object') return undefined;
  const status = Number(error.status ?? error.response?.status);
  if (Number.isInteger(status) && status > 0) return status;
  const details = `${error.code || ''} ${error.message || ''}`;
  if (/NOT_FOUND/i.test(details)) return 404;
  if (/RESOURCE_EXHAUSTED/i.test(details)) return 429;
  if (/UNAVAILABLE/i.test(details)) return 503;
  return undefined;
}

function shouldRetryKey(error) {
  const status = statusCode(error);
  return status === undefined || [401, 403, 404, 429].includes(status) || status >= 500;
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function selectAvailableKey(keys) {
  const now = Date.now();
  for (let offset = 0; offset < keys.length; offset += 1) {
    const index = (nextIndex + offset) % keys.length;
    const key = keys[index];
    if ((keyCooldownUntil.get(key) || 0) <= now) {
      nextIndex = (index + 1) % keys.length;
      return key;
    }
  }
  const key = keys[nextIndex];
  nextIndex = (nextIndex + 1) % keys.length;
  return key;
}

function putKeyOnCooldown(apiKey, error) {
  const status = statusCode(error);
  if ([401, 403, 429, 503].includes(status) || status === undefined) {
    keyCooldownUntil.set(apiKey, Date.now() + keyCooldownMs);
  }
}

export function resetGeminiKeyStateForTests() {
  nextIndex = 0;
  keyCooldownUntil.clear();
}

export function createGeminiClient(apiKey) {
  return new GoogleGenAI({ apiKey, httpOptions: { retryOptions: { attempts: 1 } } });
}

export async function withGeminiKey(operation, attempts) {
  const keys = getConfiguredKeys();
  if (!keys.length) throw new Error('Configure at least one Gemini API key.');
  const requestedAttempts = Number.isInteger(attempts) ? attempts : keys.length;
  const maxAttempts = Math.max(1, Math.min(requestedAttempts, keys.length));
  let lastError;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const key = selectAvailableKey(keys);
    try {
      const result = await operation(key);
      keyCooldownUntil.delete(key);
      return result;
    } catch (error) {
      lastError = error;
      if (!shouldRetryKey(error)) throw error;
      putKeyOnCooldown(key, error);
      if (backoffStatuses.has(statusCode(error)) && attempt + 1 < maxAttempts) {
        await delay(retryBackoffMs);
      }
    }
  }
  throw lastError || new Error('Gemini request failed.');
}

export async function withGeminiModels(models, operation) {
  if (!Array.isArray(models) || !models.length || models.some((model) => typeof model !== 'string' || !model.trim())) {
    throw new TypeError('At least one valid Gemini model is required.');
  }
  let lastError;
  for (let index = 0; index < models.length; index += 1) {
    try {
      return await withGeminiKey((apiKey) => operation(apiKey, models[index]));
    } catch (error) {
      lastError = error;
      if (!backoffStatuses.has(statusCode(error)) || index + 1 === models.length) throw error;
      await delay(retryBackoffMs);
    }
  }
  throw lastError || new Error('Gemini model fallback failed.');
}
