import cors from 'cors';

const DEPLOYED_FRONTEND_ORIGIN = 'https://frontend-mu-blush-93.vercel.app';

function getAllowedOrigins(
  configuredOrigins = process.env.FRONTEND_ORIGIN,
  frontendUrl = process.env.FRONTEND_URL
) {
  return [configuredOrigins, frontendUrl, DEPLOYED_FRONTEND_ORIGIN]
    .filter(Boolean)
    .flatMap((value) => String(value).split(','))
    .map((origin) => origin.trim())
    .filter((origin, index, list) => origin && list.indexOf(origin) === index);
}

export function isAllowedFrontendOrigin(origin) {
  return Boolean(origin) && getAllowedOrigins().includes(origin);
}

export function createCorsMiddleware(configuredOrigins, frontendUrl) {
  return cors({
    origin: getAllowedOrigins(configuredOrigins, frontendUrl),
    credentials: true
  });
}
