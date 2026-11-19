import { Router } from 'express';
import ChannelProfile from '../models/ChannelProfile.js';
import {
  getPipelineStatus, publishNow, runScheduledTrigger, subscribeToPipelineStatus
} from '../services/queueWorkerService.js';
import { auditChannel } from '../services/analyticsOptimizer.js';
import { chatWithGemini } from '../services/geminiService.js';

const router = Router();
const channelIdPattern = /^UC[A-Za-z0-9_-]{22}$/;
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
router.get('/status/:channelId', async (req, res, next) => {
  try {
    const { channelId } = req.params;
    if (!channelIdPattern.test(channelId)) return res.status(400).json({ error: 'Invalid YouTube channel ID.' });
    if (!await ChannelProfile.exists({ channelId })) return res.status(404).json({ error: 'Channel profile not found.' });
    res.json(await getPipelineStatus(channelId));
  } catch (error) { next(error); }
});
router.get('/events/:channelId', async (req, res, next) => {
  const { channelId } = req.params;
  if (!channelIdPattern.test(channelId)) return res.status(400).json({ error: 'Invalid YouTube channel ID.' });
  let unsubscribe = () => {};
  let heartbeat;
  try {
    if (!await ChannelProfile.exists({ channelId })) return res.status(404).json({ error: 'Channel profile not found.' });
    res.set({
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'Content-Type': 'text/event-stream'
    });
    res.flushHeaders();
    const send = (status) => {
      if (!res.writableEnded && !res.destroyed) res.write(`data: ${JSON.stringify(status)}\n\n`);
    };
    unsubscribe = subscribeToPipelineStatus(channelId, send);
    heartbeat = setInterval(() => {
      if (!res.writableEnded && !res.destroyed) res.write(': keep-alive\n\n');
    }, 25000);
    heartbeat.unref();
    res.on('close', () => {
      unsubscribe();
      clearInterval(heartbeat);
    });
    send(await getPipelineStatus(channelId));
  } catch (error) {
    unsubscribe();
    clearInterval(heartbeat);
    if (res.headersSent) res.end();
    else next(error);
  }
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
