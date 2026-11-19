import { Router } from 'express';
import { auditChannel } from '../services/analyticsOptimizer.js';
import { getChannelStats } from '../services/youtubeService.js';

const channelIdPattern = /^UC[A-Za-z0-9_-]{22}$/;

function requireCronSecret(req, res, next) {
  const supplied = req.get('x-cron-secret') || req.query.secret;
  if (!process.env.CRON_SECRET) return res.status(503).json({ error: 'CRON_SECRET is not configured.' });
  if (supplied !== process.env.CRON_SECRET) return res.status(401).json({ error: 'Invalid cron secret.' });
  next();
}

export function createAnalyticsRouter({ fetchStats = getChannelStats, runAudit = auditChannel } = {}) {
  const router = Router();

  router.get('/:channelId', async (req, res, next) => {
    try {
      const { channelId } = req.params;
      if (!channelIdPattern.test(channelId)) return res.status(400).json({ error: 'Invalid YouTube channel ID.' });
      res.json(await fetchStats(channelId));
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
