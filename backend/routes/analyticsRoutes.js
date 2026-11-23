import { Router } from 'express';
import { auditChannel } from '../services/analyticsOptimizer.js';
import { getChannelStats } from '../services/youtubeService.js';

const channelIdPattern = /^UC[A-Za-z0-9_-]{22}$/;
const ANALYTICS_CACHE_TTL_MS = 5 * 60 * 1000;

function isYouTubeRateLimitError(error) {
  const status = Number(error?.response?.status ?? error?.status ?? error?.code);
  const reason = error?.errors?.[0]?.reason ||
    error?.response?.data?.error?.errors?.[0]?.reason || '';
  return status === 429 || /quotaExceeded|rateLimitExceeded|userRateLimitExceeded/i.test(reason);
}

function createUnavailableStats(channelId) {
  return {
    channel: { channelId, channelTitle: channelId, thumbnailUrl: '' },
    kpis: { views: 0, subscribers: 0, watchTimeMinutes: 0, videos: 0 },
    recentVideos: [],
    unavailable: true
  };
}

function requireCronSecret(req, res, next) {
  const supplied = req.get('x-cron-secret') || req.query.secret;
  if (!process.env.CRON_SECRET) return res.status(503).json({ error: 'CRON_SECRET is not configured.' });
  if (supplied !== process.env.CRON_SECRET) return res.status(401).json({ error: 'Invalid cron secret.' });
  next();
}

export function createAnalyticsRouter({
  fetchStats = getChannelStats,
  runAudit = auditChannel,
  cacheTtlMs = ANALYTICS_CACHE_TTL_MS,
  now = Date.now
} = {}) {
  const router = Router();
  const statsCache = new Map();
  const statsInFlight = new Map();

  async function getCachedStats(channelId) {
    const cached = statsCache.get(channelId);
    if (cached && now() < cached.expiresAt) return cached.value;
    if (statsInFlight.has(channelId)) return statsInFlight.get(channelId);

    const request = (async () => {
      try {
        const stats = await fetchStats(channelId);
        statsCache.set(channelId, { value: stats, expiresAt: now() + cacheTtlMs });
        return stats;
      } catch (error) {
        if (!isYouTubeRateLimitError(error)) throw error;

        const fallback = cached ? cached.value : createUnavailableStats(channelId);
        statsCache.set(channelId, { value: fallback, expiresAt: now() + cacheTtlMs });
        return fallback;
      }
    })();

    statsInFlight.set(channelId, request);
    try {
      return await request;
    } finally {
      if (statsInFlight.get(channelId) === request) statsInFlight.delete(channelId);
    }
  }

  router.get('/:channelId', async (req, res, next) => {
    try {
      const { channelId } = req.params;
      if (!channelIdPattern.test(channelId)) return res.status(400).json({ error: 'Invalid YouTube channel ID.' });
      res.json(await getCachedStats(channelId));
    } catch (error) { next(error); }
  });

  router.post('/:channelId/audit', requireCronSecret, async (req, res, next) => {
    try {
      const { channelId } = req.params;
      if (!channelIdPattern.test(channelId)) return res.status(400).json({ error: 'Invalid YouTube channel ID.' });
      const stats = await fetchStats(channelId);
      const audit = await runAudit(channelId);
      res.json({ audit, stats });
    } catch (error) { next(error); }
  });

  return router;
}

export default createAnalyticsRouter();
