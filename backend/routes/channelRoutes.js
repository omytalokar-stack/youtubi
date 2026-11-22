import { createHmac, timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import ChannelProfile from '../models/ChannelProfile.js';
import BrainMemory from '../models/BrainMemory.js';
import OmesAuditLog from '../models/OmesAuditLog.js';
import { isAllowedFrontendOrigin } from '../config/cors.js';
import {
  channelCredentialExists, getChannelVideosHistory, optimizeAndPublishLatestVideo
} from '../services/youtubeService.js';

const router = Router();
const languages = ['Hindi', 'Hinglish', 'Marathi', 'English'];
const privacyStatuses = ['private', 'unlisted', 'public'];
const channelIdPattern = /^UC[A-Za-z0-9_-]{22}$/;
const publishTimePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const omesFrequencies = ['daily', 'alternate'];
const OMES_SESSION_COOKIE = 'omes_session';
const OMES_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const OMES_SESSION_COOKIE_PATH = '/api/channels';

function secretsMatch(supplied, expected) {
  if (typeof supplied !== 'string' || !expected) return false;
  const suppliedBytes = Buffer.from(supplied);
  const expectedBytes = Buffer.from(expected);
  return suppliedBytes.length === expectedBytes.length &&
    timingSafeEqual(suppliedBytes, expectedBytes);
}

function createOmesSessionToken(secret, expiresAt) {
  const payload = String(expiresAt);
  const signature = createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function getCookie(req, name) {
  const prefix = `${name}=`;
  const item = (req.get('cookie') || '').split(';').map((part) => part.trim())
    .find((part) => part.startsWith(prefix));
  return item ? item.slice(prefix.length) : '';
}

function hasValidOmesSession(req, secret = process.env.CRON_SECRET) {
  if (!secret) return false;
  const token = getCookie(req, OMES_SESSION_COOKIE);
  const separator = token.indexOf('.');
  if (separator <= 0) return false;
  const payload = token.slice(0, separator);
  const signature = token.slice(separator + 1);
  const expiresAt = Number(payload);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) return false;

  const expectedSignature = Buffer.from(
    createHmac('sha256', secret).update(payload).digest('base64url')
  );
  const suppliedSignature = Buffer.from(signature);
  return expectedSignature.length === suppliedSignature.length &&
    timingSafeEqual(expectedSignature, suppliedSignature);
}

function isTrustedFrontendRequest(req) {
  const origin = req.get('origin');
  if (origin) return isAllowedFrontendOrigin(origin);
  return req.get('sec-fetch-site') === 'same-origin';
}

function setOmesSessionCookie(req, res, token, maxAge) {
  const secure = process.env.NODE_ENV === 'production' || Boolean(process.env.RENDER) || req.secure;
  const attributes = [
    `${OMES_SESSION_COOKIE}=${token}`,
    `Path=${OMES_SESSION_COOKIE_PATH}`,
    `Max-Age=${maxAge}`,
    'HttpOnly',
    'SameSite=Lax'
  ];
  if (secure) attributes.push('Secure');
  res.append('Set-Cookie', attributes.join('; '));
}

function requireOmesAccess(req, res, next) {
  const expected = process.env.CRON_SECRET;
  if (!expected) return res.status(503).json({ error: 'CRON_SECRET is not configured.' });
  if (secretsMatch(req.get('x-cron-secret'), expected)) return next();
  if (hasValidOmesSession(req, expected) && isTrustedFrontendRequest(req)) return next();
  return res.status(401).json({ error: 'OMES access is not authorized.' });
}

function getDefaultPublishTimeIst(profile) {
  const { scheduleHourIST: hour, scheduleMinuteIST: minute } = profile.automation || {};
  if (Number.isInteger(hour) && hour >= 0 && hour <= 23 &&
      Number.isInteger(minute) && minute >= 0 && minute <= 59) {
    return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  }
  return '16:00';
}

function withScheduleDefaults(profile) {
  return {
    ...profile,
    autoPublishEnabled: profile.autoPublishEnabled ?? true,
    publishTimeIst: profile.publishTimeIst || getDefaultPublishTimeIst(profile),
    lastAutoPublishedDateIst: profile.lastAutoPublishedDateIst || ''
  };
}

router.post('/channels/omes/session', (req, res) => {
  const expected = process.env.CRON_SECRET;
  if (!expected) return res.status(503).json({ error: 'CRON_SECRET is not configured.' });
  if (!isAllowedFrontendOrigin(req.get('origin'))) {
    return res.status(403).json({ error: 'OMES access can only be unlocked from a configured frontend.' });
  }
  if (!secretsMatch(req.body?.secret, expected)) {
    return res.status(401).json({ error: 'Invalid OMES access secret.' });
  }
  const expiresAt = Date.now() + OMES_SESSION_TTL_SECONDS * 1000;
  setOmesSessionCookie(req, res, createOmesSessionToken(expected, expiresAt), OMES_SESSION_TTL_SECONDS);
  res.set('Cache-Control', 'no-store').json({ authenticated: true, expiresAt });
});

router.get('/channels/omes/session', (req, res) => {
  res.set('Cache-Control', 'no-store').json({
    authenticated: hasValidOmesSession(req),
    expiresInSeconds: OMES_SESSION_TTL_SECONDS
  });
});

router.delete('/channels/omes/session', (req, res) => {
  setOmesSessionCookie(req, res, '', 0);
  res.status(204).end();
});

router.patch('/channels/:channelId/schedule', async (req, res, next) => {
  try {
    const { channelId } = req.params;
    if (!channelIdPattern.test(channelId)) return res.status(400).json({ error: 'Invalid YouTube channel ID.' });
    const input = req.body;
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      return res.status(400).json({ error: 'A schedule object is required.' });
    }
    const keys = Object.keys(input);
    if (!keys.length || keys.some((key) => !['autoPublishEnabled', 'publishTimeIst'].includes(key))) {
      return res.status(400).json({ error: 'Only autoPublishEnabled and publishTimeIst can be updated.' });
    }
    if (input.autoPublishEnabled !== undefined && typeof input.autoPublishEnabled !== 'boolean') {
      return res.status(400).json({ error: 'autoPublishEnabled must be a boolean.' });
    }
    if (input.publishTimeIst !== undefined &&
        (typeof input.publishTimeIst !== 'string' || !publishTimePattern.test(input.publishTimeIst))) {
      return res.status(400).json({ error: 'publishTimeIst must use HH:MM 24-hour format.' });
    }

    const update = {};
    if (input.autoPublishEnabled !== undefined) update.autoPublishEnabled = input.autoPublishEnabled;
    if (input.publishTimeIst !== undefined) update.publishTimeIst = input.publishTimeIst;
    const profile = await ChannelProfile.findOneAndUpdate(
      { channelId }, { $set: update }, { new: true, runValidators: true }
    ).lean();
    if (!profile) return res.status(404).json({ error: 'Channel profile not found.' });
    res.json({ profile: withScheduleDefaults(profile) });
  } catch (error) { next(error); }
});

router.put('/channels/:channelId/omes', requireOmesAccess, async (req, res, next) => {
  try {
    const { channelId } = req.params;
    if (!channelIdPattern.test(channelId)) return res.status(400).json({ error: 'Invalid YouTube channel ID.' });
    const input = req.body;
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      return res.status(400).json({ error: 'OMES settings are required.' });
    }
    const keys = Object.keys(input);
    if (!keys.length || keys.some((key) => !['enabled', 'frequency', 'publishTimeIst'].includes(key))) {
      return res.status(400).json({ error: 'Only enabled, frequency and publishTimeIst can be updated.' });
    }
    if (input.enabled !== undefined && typeof input.enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled must be a boolean.' });
    }
    if (input.frequency !== undefined && !omesFrequencies.includes(input.frequency)) {
      return res.status(400).json({ error: 'frequency must be daily or alternate.' });
    }
    if (input.publishTimeIst !== undefined &&
        (typeof input.publishTimeIst !== 'string' || !publishTimePattern.test(input.publishTimeIst))) {
      return res.status(400).json({ error: 'publishTimeIst must use HH:MM 24-hour format.' });
    }

    const update = {};
    for (const key of keys) update[`automation.omes.${key}`] = input[key];
    const profile = await ChannelProfile.findOneAndUpdate(
      { channelId }, { $set: update }, { new: true, runValidators: true }
    ).lean();
    if (!profile) return res.status(404).json({ error: 'Channel profile not found.' });
    res.json({ profile: withScheduleDefaults(profile) });
  } catch (error) { next(error); }
});

router.post('/channels/:channelId/omes/run', requireOmesAccess, async (req, res, next) => {
  try {
    const { channelId } = req.params;
    if (!channelIdPattern.test(channelId)) return res.status(400).json({ error: 'Invalid YouTube channel ID.' });
    res.json({ result: await optimizeAndPublishLatestVideo(channelId) });
  } catch (error) { next(error); }
});

router.get('/channels/:channelId/omes/history', requireOmesAccess, async (req, res, next) => {
  try {
    const { channelId } = req.params;
    if (!channelIdPattern.test(channelId)) return res.status(400).json({ error: 'Invalid YouTube channel ID.' });
    if (!await ChannelProfile.exists({ channelId })) return res.status(404).json({ error: 'Channel profile not found.' });
    const [videos, auditLogs] = await Promise.all([
      getChannelVideosHistory(channelId, 25),
      OmesAuditLog.find({ channelId }).sort({ optimizedAt: -1 }).limit(50).lean()
    ]);
    res.json({ videos, auditLogs });
  } catch (error) { next(error); }
});

router.get('/profile/:channelId', async (req, res, next) => {
  try {
    const profile = await ChannelProfile.findOne({ channelId: req.params.channelId }).lean();
    if (!profile) return res.status(404).json({ error: 'Channel profile not found.' });
    res.json({ profile: withScheduleDefaults(profile) });
  } catch (error) { next(error); }
});
router.put('/profile/:channelId', async (req, res, next) => {
  try {
    const { channelId } = req.params;
    if (!channelIdPattern.test(channelId)) return res.status(400).json({ error: 'Invalid YouTube channel ID.' });
    if (!await channelCredentialExists(channelId)) return res.status(404).json({ error: 'YouTube channel is not connected.' });
    const input = req.body || {};
    if (input.language && !languages.includes(input.language)) return res.status(400).json({ error: 'Unsupported language.' });
    if (input.automation !== undefined &&
        (!input.automation || typeof input.automation !== 'object' || Array.isArray(input.automation))) {
      return res.status(400).json({ error: 'Automation settings must be an object.' });
    }
    if (input.automation?.privacyStatus !== undefined &&
        (typeof input.automation.privacyStatus !== 'string' || !privacyStatuses.includes(input.automation.privacyStatus))) {
      return res.status(400).json({ error: 'Unsupported privacy status.' });
    }
    if (input.automation?.scheduleHourIST !== undefined && input.automation?.scheduleMinuteIST !== undefined) {
      const occupied = await ChannelProfile.exists({
        channelId: { $ne: channelId },
        'automation.scheduleHourIST': input.automation.scheduleHourIST,
        'automation.scheduleMinuteIST': input.automation.scheduleMinuteIST
      });
      if (occupied) return res.status(409).json({ error: 'That IST schedule slot is already assigned to another channel.' });
    }
    const fields = ['niche', 'language', 'toneAndStyle', 'visualKeywordsPrefix'];
    const update = {};
    fields.forEach((field) => { if (input[field] !== undefined) update[field] = input[field]; });
    if (input.metadataBlueprint) update.metadataBlueprint = {
      titleSuffix: String(input.metadataBlueprint.titleSuffix || ''),
      fixedDescriptionFooter: String(input.metadataBlueprint.fixedDescriptionFooter || ''),
      coreTags: Array.isArray(input.metadataBlueprint.coreTags) ? input.metadataBlueprint.coreTags.map(String) : []
    };
    if (input.automation) {
      const { enabled, scheduleHourIST, scheduleMinuteIST, privacyStatus } = input.automation;
      if (scheduleHourIST !== undefined && (!Number.isInteger(scheduleHourIST) || scheduleHourIST < 0 || scheduleHourIST > 23)) return res.status(400).json({ error: 'Schedule hour must be between 0 and 23.' });
      if (scheduleMinuteIST !== undefined && (!Number.isInteger(scheduleMinuteIST) || scheduleMinuteIST < 0 || scheduleMinuteIST > 59)) return res.status(400).json({ error: 'Schedule minute must be between 0 and 59.' });
      if (enabled !== undefined) update['automation.enabled'] = Boolean(enabled);
      if (scheduleHourIST !== undefined) update['automation.scheduleHourIST'] = scheduleHourIST;
      if (scheduleMinuteIST !== undefined) update['automation.scheduleMinuteIST'] = scheduleMinuteIST;
      if (privacyStatus !== undefined) update['automation.privacyStatus'] = privacyStatus;
    }
    const profile = await ChannelProfile.findOneAndUpdate({ channelId }, { $set: update }, { new: true, runValidators: true }).lean();
    if (!profile) return res.status(404).json({ error: 'Channel profile not found.' });
    res.json({ profile: withScheduleDefaults(profile) });
  } catch (error) { next(error); }
});
router.get('/brain/:channelId', async (req, res, next) => {
  try {
    const brain = await BrainMemory.findOne({ channelId: req.params.channelId }).lean();
    if (!brain) return res.status(404).json({ error: 'Channel brain not found.' });
    res.json({ brain });
  } catch (error) { next(error); }
});
router.patch('/brain/:channelId', async (req, res, next) => {
  try {
    const brain = await BrainMemory.findOneAndUpdate(
      { channelId: req.params.channelId },
      { $set: { selfCorrectionEnabled: Boolean(req.body.selfCorrectionEnabled) }, $setOnInsert: { channelId: req.params.channelId } },
      { upsert: true, new: true, runValidators: true }
    ).lean();
    res.json({ brain });
  } catch (error) { next(error); }
});
router.post('/brain/tactic', async (req, res, next) => {
  try {
    const { channelId, text } = req.body || {};
    if (!channelId || !String(text || '').trim()) return res.status(400).json({ error: 'channelId and tactic text are required.' });
    const brain = await BrainMemory.findOneAndUpdate(
      { channelId }, { $push: { winningTactics: String(text).trim() }, $setOnInsert: { channelId } },
      { upsert: true, new: true, runValidators: true }
    ).lean();
    res.json({ brain });
  } catch (error) { next(error); }
});
router.post('/brain/mistake', async (req, res, next) => {
  try {
    const { channelId, text } = req.body || {};
    if (!channelId || !String(text || '').trim()) return res.status(400).json({ error: 'channelId and mistake rule are required.' });
    const brain = await BrainMemory.findOneAndUpdate(
      { channelId }, { $push: { mistakeRules: String(text).trim() }, $setOnInsert: { channelId } },
      { upsert: true, new: true, runValidators: true }
    ).lean();
    res.json({ brain });
  } catch (error) { next(error); }
});

export default router;
