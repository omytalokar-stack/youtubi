import { Router } from 'express';
import multer from 'multer';
import { randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import fs from 'node:fs/promises';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { isIP } from 'node:net';
import mongoose from 'mongoose';
import ChannelProfile from '../models/ChannelProfile.js';
import HisaJob from '../models/HisaJob.js';
import { generateShort } from '../services/geminiService.js';
import {
  createJobDirectory
} from '../services/renderService.js';
import {
  getHisaFallbackWindowMs,
  getNextDueChannel,
  getScheduleDueAt,
  getTodayIST,
  publishHisaJob
} from '../services/queueWorkerService.js';
import { createHisaScenePrompts, getFlowScenesCount } from '../services/hisaScenePrompts.js';

const router = Router();
const FLOW_PROMPT_COUNT = getFlowScenesCount();
const MAX_CLIP_SIZE = 100 * 1024 * 1024;
const MAX_REDIRECTS = 3;

const upload = multer({
  storage: multer.diskStorage({
    destination: os.tmpdir(),
    filename: (req, file, callback) => callback(null, `${randomUUID()}.mp4`)
  }),
  limits: { fileSize: MAX_CLIP_SIZE, files: FLOW_PROMPT_COUNT, fields: 1, parts: FLOW_PROMPT_COUNT + 1 },
  fileFilter: (req, file, callback) => {
    if (file.mimetype !== 'video/mp4' || path.extname(file.originalname).toLowerCase() !== '.mp4') {
      return callback(new Error('Each uploaded clip must be an MP4 file.'));
    }
    callback(null, true);
  }
});

function requireHisaSecret(req, res, next) {
  const expected = process.env.CRON_SECRET;
  if (!expected) return res.status(503).json({ error: 'CRON_SECRET is not configured.' });
  const supplied = req.get('x-hisa-secret') || '';
  if (supplied !== expected) return res.status(401).json({ error: 'Invalid Hisa secret.' });
  next();
}

function inputError(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function jobResponse(job) {
  return {
    jobId: String(job._id),
    scenePrompts: Array.isArray(job.scenePrompts) && job.scenePrompts.length
      ? job.scenePrompts
      : createHisaScenePrompts(job.animationPrompts)
  };
}

router.post('/enqueue-test', async (req, res, next) => {
  try {
    const channelId = typeof req.body?.channelId === 'string' ? req.body.channelId.trim() : '';
    if (!channelId) return res.status(400).json({ error: 'channelId is required.' });
    const profile = await ChannelProfile.findOne({ channelId }).lean();
    if (!profile) return res.status(404).json({ error: 'Channel profile not found.' });

    const generated = await generateShort(channelId);
    const today = getTodayIST();
    const job = await HisaJob.create({
      channelId,
      scheduledDateIST: `${today}:test:${randomUUID()}`,
      dueAt: new Date(),
      publishDateIST: today,
      isTest: true,
      title: generated.title,
      hook: generated.hook,
      script: generated.script,
      description: generated.description,
      tags: generated.tags,
      subtitleBeats: generated.subtitleBeats,
      scenePrompts: createHisaScenePrompts(generated.scenePrompts)
    });
    return res.status(202).json({ ok: true, jobId: job._id, status: 'queued' });
  } catch (error) {
    return next(error);
  }
});

router.use(requireHisaSecret);

router.get('/next-job', async (req, res, next) => {
  try {
    const testJob = await HisaJob.findOne({ isTest: true, status: 'pending' }).sort({ createdAt: 1 });
    if (testJob) return res.json({ job: jobResponse(testJob) });

    const nextDue = await getNextDueChannel();
    if (!nextDue) return res.json({ job: null });
    const { profile, today, dueAt } = nextDue;
    if (Date.now() - dueAt.getTime() >= getHisaFallbackWindowMs()) return res.json({ job: null });
    const existing = await HisaJob.findOne({ channelId: profile.channelId, scheduledDateIST: today });
    if (existing) {
      if (existing.status === 'pending' &&
          Date.now() - existing.dueAt.getTime() < getHisaFallbackWindowMs()) {
        return res.json({ job: jobResponse(existing) });
      }
      return res.json({ job: null });
    }

    const generated = await generateShort(profile.channelId);
    if (Date.now() - dueAt.getTime() >= getHisaFallbackWindowMs()) return res.json({ job: null });
    const job = await HisaJob.create({
      channelId: profile.channelId,
      scheduledDateIST: today,
      dueAt,
      title: generated.title,
      hook: generated.hook,
      script: generated.script,
      description: generated.description,
      tags: generated.tags,
      subtitleBeats: generated.subtitleBeats,
      scenePrompts: createHisaScenePrompts(generated.scenePrompts)
    });
    return res.json({ job: jobResponse(job) });
  } catch (error) {
    if (error.code === 11000) {
      try {
        const nextDue = await getNextDueChannel();
        const existing = nextDue && await HisaJob.findOne({
          channelId: nextDue.profile.channelId,
          scheduledDateIST: nextDue.today,
          status: 'pending'
        });
        if (existing && Date.now() - existing.dueAt.getTime() < getHisaFallbackWindowMs()) {
          return res.json({ job: jobResponse(existing) });
        }
        return res.json({ job: null });
      } catch (lookupError) {
        return next(lookupError);
      }
    }
    return next(error);
  }
});

function parseMultipartClips(req, res, next) {
  if (!req.is('multipart/form-data')) return next();
  upload.array('clips', FLOW_PROMPT_COUNT)(req, res, (error) => {
    if (error) return res.status(400).json({ error: error.message });
    next();
  });
}

function isPublicAddress(address) {
  const version = isIP(address);
  if (version === 4) {
    const octets = address.split('.').map(Number);
    const [a, b] = octets;
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 0 || b === 168)) ||
      (a === 198 && (b === 18 || b === 19 || b === 51)) ||
      (a === 203 && b === 0));
  }
  if (version === 6) {
    const normalized = address.toLowerCase();
    const firstHextet = parseInt(normalized.split(':')[0] || '0', 16);
    return !normalized.startsWith('::ffff:') && firstHextet >= 0x2000 && firstHextet <= 0x3fff;
  }
  return false;
}

async function validateClipUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw inputError('Every clip URL must be a valid HTTPS URL.');
  }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) {
    throw inputError('Clip URLs must use HTTPS on the standard port.');
  }
  if (!url.pathname.toLowerCase().endsWith('.mp4')) throw inputError('Every clip URL must point to an .mp4 file.');
  if (url.hostname === 'localhost' || url.hostname.endsWith('.localhost') || url.hostname.endsWith('.local')) {
    throw inputError('Clip URLs must use a public host.');
  }
  const addresses = isIP(url.hostname)
    ? [{ address: url.hostname }]
    : await lookup(url.hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw inputError('Clip URLs must resolve only to public IP addresses.');
  }
  return { url, address: addresses[0] };
}

function requestClip(url, address) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      lookup: (hostname, options, callback) => callback(null, address.address, address.family || isIP(address.address))
    }, resolve);
    request.setTimeout(60000, () => request.destroy(new Error('Timed out downloading clip URL.')));
    request.once('error', reject);
  });
}

async function downloadClip(rawUrl, destination) {
  let currentUrl = rawUrl;
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    const { url, address } = await validateClipUrl(currentUrl);
    const response = await requestClip(url, address);
    if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
      const location = response.headers.location;
      if (!location || redirect === MAX_REDIRECTS) throw new Error('Clip URL redirected too many times.');
      response.resume();
      currentUrl = new URL(location, url).toString();
      continue;
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      response.resume();
      throw new Error(`Unable to download clip URL (HTTP ${response.statusCode}).`);
    }
    const contentType = String(response.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (contentType && contentType !== 'video/mp4' && contentType !== 'application/octet-stream') {
      response.resume();
      throw inputError('Clip URL did not return an MP4 file.');
    }
    const contentLength = Number(response.headers['content-length'] || 0);
    if (contentLength > MAX_CLIP_SIZE) {
      response.resume();
      throw inputError('Each clip must be 100 MB or smaller.');
    }
    let bytes = 0;
    const limit = new Transform({
      transform(chunk, encoding, callback) {
        bytes += chunk.length;
        if (bytes > MAX_CLIP_SIZE) return callback(inputError('Each clip must be 100 MB or smaller.'));
        callback(null, chunk);
      }
    });
    await pipeline(response, limit, await fs.open(destination, 'w').then((file) => file.createWriteStream()));
    return;
  }
  throw new Error('Unable to download clip URL.');
}

async function assertMp4File(filePath) {
  const handle = await fs.open(filePath, 'r');
  try {
    const header = Buffer.alloc(12);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (bytesRead < 8 || header.toString('ascii', 4, 8) !== 'ftyp') {
      throw inputError('Each clip must contain a valid MP4 file.');
    }
  } finally {
    await handle.close();
  }
}

router.post('/complete-job/:jobId', parseMultipartClips, async (req, res, next) => {
  let jobDir;
  let claimed = false;
  let result;
  let statusCode = 200;
  let responseBody;
  let requestError;
  try {
    if (!mongoose.isValidObjectId(req.params.jobId)) {
      statusCode = 400;
      responseBody = { error: 'jobId must be a valid MongoDB ID.' };
    } else {
      const job = await HisaJob.findById(req.params.jobId);
      if (!job) {
        statusCode = 404;
        responseBody = { error: 'Hisa job not found.' };
      } else if (job.status !== 'pending') {
        statusCode = 409;
        responseBody = { error: `Hisa job is ${job.status}.` };
      } else {
        const files = req.files || [];
        const clipUrls = req.body?.clipUrls;
        const urls = Array.isArray(clipUrls) ? clipUrls : clipUrls ? [clipUrls] : [];
        if (files.length && urls.length || files.length && files.length !== FLOW_PROMPT_COUNT ||
            urls.length && urls.length !== FLOW_PROMPT_COUNT || !files.length && !urls.length) {
          statusCode = 400;
          responseBody = { error: `Provide exactly ${FLOW_PROMPT_COUNT} MP4 files or ${FLOW_PROMPT_COUNT} MP4 clipUrls.` };
        } else if (!job.isTest && Date.now() - job.dueAt.getTime() >= getHisaFallbackWindowMs()) {
          statusCode = 409;
          responseBody = { error: 'The Hisa fallback window has elapsed.' };
        } else {
          jobDir = createJobDirectory(job.channelId);
          const clipPaths = [];
          for (let index = 0; index < FLOW_PROMPT_COUNT; index += 1) {
            const destination = path.join(jobDir, `clip_${index}.mp4`);
            if (files.length) await fs.copyFile(files[index].path, destination);
            else await downloadClip(String(urls[index]), destination);
            await assertMp4File(destination);
            clipPaths.push(destination);
          }
          const claim = await HisaJob.updateOne(
            { _id: job._id, status: 'pending', createdAt: job.createdAt },
            { $set: { status: 'processing', processingAt: new Date(), error: '' } }
          );
          if (!claim.matchedCount) {
            statusCode = 409;
            responseBody = { error: 'Hisa job is no longer available.' };
          } else {
            claimed = true;
            result = await publishHisaJob(job, clipPaths);
            if (result.skipped) {
              await HisaJob.updateOne(
                { _id: job._id, status: 'processing' },
                { $set: { status: 'pending', processingAt: null } }
              );
              claimed = false;
              statusCode = 409;
              responseBody = { error: result.reason };
            } else {
              responseBody = { jobId: job._id, status: 'completed', ...result };
            }
          }
        }
      }
    }
  } catch (error) {
    requestError = error;
    if (claimed) {
      await HisaJob.updateOne(
        { _id: req.params.jobId, status: 'processing' },
        { $set: { status: 'failed', error: error.message.slice(0, 1000) } }
      );
    }
  } finally {
    try {
      if (jobDir) await fs.rm(jobDir, { recursive: true, force: true });
      await Promise.all((req.files || []).map((file) => fs.rm(file.path, { force: true })));
    } catch (cleanupError) {
      if (requestError) console.error('Unable to clean Hisa temporary files:', cleanupError.message);
      else requestError = cleanupError;
    }
  }
  if (requestError) return next(requestError);
  return res.status(statusCode).json(responseBody);
});

export default router;
