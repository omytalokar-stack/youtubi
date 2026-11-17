import cors from 'cors';

export function createCorsMiddleware(configuredOrigins = process.env.FRONTEND_ORIGIN) {
  const origins = (configuredOrigins || 'http://localhost:5173')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  if (origins.length === 0) {
    throw new Error('FRONTEND_ORIGIN must contain at least one allowed frontend origin.');
  }

  return cors({ origin: origins });
}
