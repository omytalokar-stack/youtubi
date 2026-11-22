const DEFAULT_WINDOW_MS = 15 * 60 * 1000;
const DEFAULT_MAX_REQUESTS = 600;
const EXEMPT_PATHS = new Set([
  '/api/health',
  '/api/automation/trigger'
]);

export function createApiRateLimiter({
  windowMs = DEFAULT_WINDOW_MS,
  max = DEFAULT_MAX_REQUESTS,
  now = Date.now
} = {}) {
  const requestsByIp = new Map();
  const cleanup = setInterval(() => {
    const currentTime = now();
    for (const [ip, entry] of requestsByIp) {
      if (currentTime >= entry.resetAt) requestsByIp.delete(ip);
    }
  }, windowMs);
  cleanup.unref();

  return function apiRateLimiter(req, res, next) {
    if (!req.path.startsWith('/api/')) return next();
    if (EXEMPT_PATHS.has(req.path) ||
        (req.method === 'GET' && req.path === '/api/youtube/channels')) {
      return next();
    }

    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const currentTime = now();
    let entry = requestsByIp.get(ip);
    if (!entry || currentTime >= entry.resetAt) {
      entry = { count: 0, resetAt: currentTime + windowMs };
      requestsByIp.set(ip, entry);
    }

    entry.count += 1;
    const remaining = Math.max(0, max - entry.count);
    res.set('RateLimit-Limit', String(max));
    res.set('RateLimit-Remaining', String(remaining));
    res.set('RateLimit-Reset', String(Math.ceil(entry.resetAt / 1000)));

    if (entry.count > max) {
      res.set('Retry-After', String(Math.max(1, Math.ceil((entry.resetAt - currentTime) / 1000))));
      return res.status(429).json({ error: 'Too many requests. Please retry later.' });
    }
    return next();
  };
}
