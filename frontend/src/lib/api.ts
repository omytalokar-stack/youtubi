const API_URL = import.meta.env.PROD
  ? '/api'
  : import.meta.env.VITE_API_URL || 'http://localhost:4000/api';

const CHANNEL_LIST_PATH = '/youtube/channels';
const CHANNEL_LIST_CACHE_TTL_MS = 30_000;
const CHANNEL_LIST_BACKOFF_BASE_MS = 30_000;
const CHANNEL_LIST_BACKOFF_MAX_MS = 15 * 60_000;
const ANALYTICS_PATH = '/analytics';
const ANALYTICS_CACHE_TTL_MS = 60_000;

let channelListCache: { value: unknown; expiresAt: number } | null = null;
let channelListInFlight: Promise<unknown> | null = null;
let channelListRetryAt = 0;
let channelListRateLimitCount = 0;
const analyticsCache = new Map<string, { value: unknown; expiresAt: number }>();
const analyticsInFlight = new Map<string, Promise<unknown>>();

function isAnalyticsPath(path: string): boolean {
  return path === ANALYTICS_PATH || path.startsWith(`${ANALYTICS_PATH}/`);
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

function getRetryAfterMs(value: string | null, now: number): number {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : 0;
}

async function requestChannelList<T>(path: string, init?: RequestInit): Promise<T> {
  const now = Date.now();
  if (channelListCache && now < channelListCache.expiresAt) {
    return channelListCache.value as T;
  }
  if (now < channelListRetryAt) {
    if (channelListCache) return channelListCache.value as T;
    throw new Error(`Channel list is temporarily rate-limited. Retry in ${Math.ceil((channelListRetryAt - now) / 1000)} seconds.`);
  }
  if (channelListInFlight) return channelListInFlight as Promise<T>;

  const request = (async () => {
    const response = await fetch(`${API_URL}${path}`, {
      ...init,
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...init?.headers }
    });
    const body = await response.json().catch(() => ({}));
    if (response.status === 429) {
      const backoffMs = Math.min(
        CHANNEL_LIST_BACKOFF_BASE_MS * (2 ** Math.min(channelListRateLimitCount, 5)),
        CHANNEL_LIST_BACKOFF_MAX_MS
      );
      channelListRateLimitCount += 1;
      channelListRetryAt = Date.now() + Math.max(
        CHANNEL_LIST_BACKOFF_BASE_MS,
        backoffMs,
        getRetryAfterMs(response.headers.get('Retry-After'), Date.now())
      );
      if (channelListCache) return channelListCache.value as T;
    } else if (response.ok) {
      channelListCache = { value: body, expiresAt: Date.now() + CHANNEL_LIST_CACHE_TTL_MS };
      channelListRateLimitCount = 0;
      channelListRetryAt = 0;
      return body as T;
    }
    if (!response.ok) throw new Error(getErrorMessage(body, response.status));
    return body as T;
  })();
  channelListInFlight = request;
  try {
    return await request;
  } finally {
    if (channelListInFlight === request) channelListInFlight = null;
  }
}

async function requestAnalytics<T>(path: string, init?: RequestInit): Promise<T> {
  const now = Date.now();
  const cached = analyticsCache.get(path);
  if (cached && now < cached.expiresAt) return cached.value as T;
  const inFlight = analyticsInFlight.get(path);
  if (inFlight) return inFlight as Promise<T>;

  const request = (async () => {
    const response = await fetch(`${API_URL}${path}`, {
      ...init,
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...init?.headers }
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(getErrorMessage(body, response.status));
    analyticsCache.set(path, { value: body, expiresAt: Date.now() + ANALYTICS_CACHE_TTL_MS });
    return body as T;
  })();
  analyticsInFlight.set(path, request);
  try {
    return await request;
  } finally {
    if (analyticsInFlight.get(path) === request) analyticsInFlight.delete(path);
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const method = (init?.method || 'GET').toUpperCase();
  if (method === 'GET' && path === CHANNEL_LIST_PATH) {
    return requestChannelList<T>(path, init);
  }
  if (method === 'GET' && isAnalyticsPath(path)) {
    return requestAnalytics<T>(path, init);
  }

  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...init?.headers }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(getErrorMessage(body, response.status));
  return body as T;
}

export { API_URL };
