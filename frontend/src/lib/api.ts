const API_URL = import.meta.env.PROD
  ? '/api'
  : import.meta.env.VITE_API_URL || 'http://localhost:4000/api';

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

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
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
