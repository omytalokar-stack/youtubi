import cors from 'cors';

const DEPLOYED_FRONTEND_ORIGIN = 'https://frontend-mu-blush-93.vercel.app';

export function createCorsMiddleware(
  configuredOrigins = process.env.FRONTEND_ORIGIN,
  frontendUrl = process.env.FRONTEND_URL
) {
  const origins = [configuredOrigins, frontendUrl, DEPLOYED_FRONTEND_ORIGIN]
    .filter(Boolean)
    .flatMap((value) => String(value).split(','))
    .map((origin) => origin.trim())
    .filter((origin, index, list) => origin && list.indexOf(origin) === index);

  return cors({ origin: origins });
}
