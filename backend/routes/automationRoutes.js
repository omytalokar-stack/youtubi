import { Router } from 'express';
import { publishNow, runScheduledTrigger } from '../services/queueWorkerService.js';
import { auditChannel } from '../services/analyticsOptimizer.js';
import { chatWithGemini } from '../services/geminiService.js';

const router = Router();

function requireCronSecret(req, res, next) {
  const supplied = req.get('x-cron-secret') || req.query.secret;
  if (!process.env.CRON_SECRET) return res.status(503).json({ error: 'CRON_SECRET is not configured.' });
  if (supplied !== process.env.CRON_SECRET) return res.status(401).json({ error: 'Invalid cron secret.' });
  next();
}

router.post('/publish/:channelId', async (req, res, next) => {
  const { channelId } = req.params;
  res.status(202).json({ accepted: true, channelId, message: 'Native Short generation and publishing started.' });
  setImmediate(() => {
    publishNow(channelId).catch((error) => {
      console.error(`Background publish failed for ${channelId}:`, error);
    });
  });
});
router.post('/trigger', requireCronSecret, async (req, res, next) => {
  try { res.json(await runScheduledTrigger()); } catch (error) { next(error); }
});
router.post('/audit-analytics', requireCronSecret, async (req, res, next) => {
  try {
    const channelId = req.body?.channelId;
    if (!channelId) return res.status(400).json({ error: 'channelId is required.' });
    res.json({ audit: await auditChannel(channelId) });
  } catch (error) { next(error); }
});
router.post('/chat', async (req, res, next) => {
  try {
    const { channelId, message, history } = req.body || {};
    if (!channelId || !String(message || '').trim()) return res.status(400).json({ error: 'channelId and message are required.' });
    res.json({ response: await chatWithGemini(channelId, String(message), Array.isArray(history) ? history : []) });
  } catch (error) { next(error); }
});

export default router;
