import { Router } from 'express';
import { publishNow, runScheduledTrigger } from '../services/queueWorkerService.js';
import { auditChannel } from '../services/analyticsOptimizer.js';
import { chatWithGemini } from '../services/geminiService.js';

const router = Router();
let scheduledTriggerRunning = false;
let scheduledTriggerPending = false;

function requireCronSecret(req, res, next) {
  const supplied = req.get('x-cron-secret') || req.query.secret;
  if (!process.env.CRON_SECRET) return res.status(503).json({ error: 'CRON_SECRET is not configured.' });
  if (supplied !== process.env.CRON_SECRET) return res.status(401).json({ error: 'Invalid cron secret.' });
  next();
}

function triggerScheduled(req, res) {
  if (scheduledTriggerRunning) scheduledTriggerPending = true;
  else {
    scheduledTriggerRunning = true;
    setImmediate(async () => {
      do {
        scheduledTriggerPending = false;
        try {
          console.info('Scheduled trigger completed:', await runScheduledTrigger());
        } catch (error) {
          console.error('Scheduled trigger failed:', error);
        }
      } while (scheduledTriggerPending);
      scheduledTriggerRunning = false;
    });
  }
  res.status(202).json({ accepted: true, message: 'Scheduled upload check started.' });
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
router.get('/trigger', requireCronSecret, triggerScheduled);
router.post('/trigger', requireCronSecret, triggerScheduled);
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
