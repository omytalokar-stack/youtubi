const API_URL = import.meta.env.PROD
  ? '/api'
  : import.meta.env.VITE_API_URL || 'http://localhost:4000/api';

const CHANNEL_LIST_PATH = '/youtube/channels';
const ANALYTICS_PATH = '/analytics';
const CHANNEL_LIST_CACHE_TTL_MS = 300_000;
const ANALYTICS_CACHE_TTL_MS = 300_000;
const RATE_LIMIT_CIRCUIT_BREAKER_MS = 300_000;
const PERSISTED_CACHE_PREFIX = 'dimag-api-cache:';
const RATE_LIMIT_STORAGE_KEY = 'dimag-api-rate-limited-until';

type CacheEntry = { value: unknown; expiresAt: number };

const getCache = new Map<string, CacheEntry>();
const getInFlight = new Map<string, Promise<unknown>>();
let rateLimitRetryAt = 0;

function getRateLimitRetryAt(): number {
  try {
    const stored = Number(localStorage.getItem(RATE_LIMIT_STORAGE_KEY));
    if (Number.isFinite(stored)) rateLimitRetryAt = Math.max(rateLimitRetryAt, stored);
  } catch {
    // The in-memory breaker remains active when storage is unavailable.
  }
  return rateLimitRetryAt;
}

function activateRateLimitBreaker(): void {
  rateLimitRetryAt = Date.now() + RATE_LIMIT_CIRCUIT_BREAKER_MS;
  try {
    localStorage.setItem(RATE_LIMIT_STORAGE_KEY, String(rateLimitRetryAt));
  } catch {
    // The in-memory breaker remains active when storage is unavailable.
  }
}

function isAnalyticsPath(path: string): boolean {
  return path === ANALYTICS_PATH || path.startsWith(`${ANALYTICS_PATH}/`);
}

function getCacheTtl(path: string): number {
  if (path === CHANNEL_LIST_PATH) return CHANNEL_LIST_CACHE_TTL_MS;
  if (isAnalyticsPath(path)) return ANALYTICS_CACHE_TTL_MS;
  return 0;
}

function getErrorMessage(body: unknown, status: number): string {
  if (body && typeof body === 'object') {
    const payload = body as { error?: unknown; message?: unknown };
    const error = payload.error ?? payload.message;
    if (typeof error === 'string') {
      try {
        const parsed = JSON.parse(error) as { error?: { message?: unknown }; message?: unknown };
        const message = parsed.error?.message ?? parsed.message;
        if (typeof message === 'string' && message.trim()) return `${message} (HTTP ${status})`;
      } catch {}
      return error;
    }
    if (typeof error === 'object' && error !== null && 'message' in error) {
      const message = (error as { message?: unknown }).message;
      if (typeof message === 'string') return message;
    }
  }
  return `Request failed (${status}).`;
}

function getPersistedCacheKey(path: string): string {
  return `${PERSISTED_CACHE_PREFIX}${encodeURIComponent(path)}`;
}

function readCache(path: string): CacheEntry | undefined {
  const cached = getCache.get(path);
  if (cached) return cached;

  if (!getCacheTtl(path)) return undefined;
  try {
    const stored = localStorage.getItem(getPersistedCacheKey(path));
    if (!stored) return undefined;
    const parsed: unknown = JSON.parse(stored);
    if (
      parsed && typeof parsed === 'object' &&
      'value' in parsed && 'expiresAt' in parsed &&
      typeof parsed.expiresAt === 'number'
    ) {
      const entry = parsed as CacheEntry;
      getCache.set(path, entry);
      return entry;
    }
  } catch {
    // Cache storage is best-effort; requests must still work when storage is unavailable.
  }
  return undefined;
}

function storeCache(path: string, value: unknown): void {
  const ttl = getCacheTtl(path);
  const entry = { value, expiresAt: Date.now() + ttl };
  getCache.set(path, entry);
  if (!ttl) return;
  try {
    localStorage.setItem(getPersistedCacheKey(path), JSON.stringify(entry));
  } catch {
    // Cache storage is best-effort; requests must still work when storage is unavailable.
  }
  if (path === CHANNEL_LIST_PATH && value && typeof value === 'object' && 'channels' in value) {
    try {
      localStorage.setItem('dimag-connected-channels', JSON.stringify(value.channels));
    } catch {
      // The app-level channel list is also best-effort.
    }
  }
}

function readFallbackCache(path: string): CacheEntry | undefined {
  const cached = readCache(path);
  if (cached) return cached;
  if (path !== CHANNEL_LIST_PATH) return undefined;
  try {
    const channels = localStorage.getItem('dimag-connected-channels');
    if (!channels) return undefined;
    const parsed: unknown = JSON.parse(channels);
    if (Array.isArray(parsed)) return { value: { channels: parsed }, expiresAt: 0 };
  } catch {
    // Ignore unusable fallback data and report the original request failure.
  }
  return undefined;
}

async function requestGet<T>(
  path: string,
  init?: RequestInit,
  forceRefresh = false
): Promise<T> {
  const now = Date.now();
  const cached = readCache(path);
  if (!forceRefresh && cached && now < cached.expiresAt) return cached.value as T;
  if (now < getRateLimitRetryAt()) {
    const fallback = readFallbackCache(path);
    if (fallback) return fallback.value as T;
    throw new Error('Requests are temporarily paused because the API is rate-limited.');
  }
  const inFlight = getInFlight.get(path);
  if (inFlight) return inFlight as Promise<T>;

  const request = (async () => {
    const response = await fetch(`${API_URL}${path}`, {
      ...init,
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...init?.headers }
    });
    const body = await response.json().catch(() => ({}));
    if (response.status === 429) {
      activateRateLimitBreaker();
      const fallback = readFallbackCache(path);
      if (fallback) return fallback.value as T;
    } else if (response.ok) {
      storeCache(path, body);
      return body as T;
    }
    if (!response.ok) throw new Error(getErrorMessage(body, response.status));
    return body as T;
  })();
  getInFlight.set(path, request);
  try {
    return await request;
  } finally {
    if (getInFlight.get(path) === request) getInFlight.delete(path);
  }
}

export async function api<T>(
  path: string,
  init?: RequestInit,
  options: { forceRefresh?: boolean } = {}
): Promise<T> {
  const method = (init?.method || 'GET').toUpperCase();
  if (method === 'GET') return requestGet<T>(path, init, options.forceRefresh);

  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...init?.headers }
  });
  const body = await response.json().catch(() => ({}));
  if (response.status === 429) activateRateLimitBreaker();
  if (!response.ok) throw new Error(getErrorMessage(body, response.status));
  return body as T;
}

export { API_URL };
