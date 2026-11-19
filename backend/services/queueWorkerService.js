import fs from 'node:fs';
import ChannelProfile from '../models/ChannelProfile.js';
import AutomationLock from '../models/AutomationLock.js';
import VideoLog from '../models/VideoLog.js';
import { generateShort } from './geminiService.js';
import { generateSceneAssets } from './visualService.js';
import { generateVoiceover } from './ttsService.js';
import { createJobDirectory, renderShort } from './renderService.js';
import { uploadShort } from './youtubeService.js';

const LOCK_KEY = 'GLOBAL_RENDER_WORKER';
export const RENDER_LOCK_TTL_MS = 15 * 60 * 1000;
export const RENDER_LOCK_HEARTBEAT_MS = 60 * 1000;
let processRenderActive = false;

function istSchedule(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(date);
  const value = (type) => parts.find((part) => part.type === type)?.value;
  return { today: `${value('year')}-${value('month')}-${value('day')}`, hour: Number(value('hour')), minute: Number(value('minute')) };
}

export function getTodayIST() {
  return istSchedule().today;
}

export function getScheduleDueAt(profile, today) {
  const [year, month, day] = today.split('-').map(Number);
  const minuteOfDay = profile.automation.scheduleHourIST * 60 + profile.automation.scheduleMinuteIST;
  return new Date(Date.UTC(year, month - 1, day, Math.floor(minuteOfDay / 60), minuteOfDay % 60) - 330 * 60 * 1000);
}

export async function getNextDueChannel() {
  const current = istSchedule();
  const nowMinutes = current.hour * 60 + current.minute;
  const profiles = await ChannelProfile.find({ 'automation.enabled': true })
    .sort({ 'automation.scheduleHourIST': 1, 'automation.scheduleMinuteIST': 1, channelId: 1 }).lean();
  const profile = profiles.find((item) => {
    const schedule = item.automation.scheduleHourIST * 60 + item.automation.scheduleMinuteIST;
    return schedule <= nowMinutes && item.automation.lastPublishedDateIST !== current.today;
  });
  return profile ? { profile, today: current.today, dueAt: getScheduleDueAt(profile, current.today) } : null;
}

export async function acquireRenderLock(channelId) {
  const now = new Date();
  try {
    const lock = await AutomationLock.findOneAndUpdate(
      { lockKey: LOCK_KEY, expiresAt: { $lte: now } },
      { $set: { ownerChannelId: channelId, expiresAt: new Date(now.getTime() + RENDER_LOCK_TTL_MS) } },
      { upsert: true, new: true, runValidators: true }
    );
    return Boolean(lock && lock.ownerChannelId === channelId);
  } catch (error) {
    if (error.code === 11000) return false;
    throw error;
  }
}

export async function renewRenderLock(channelId, controller) {
  try {
    const result = await AutomationLock.updateOne(
      { lockKey: LOCK_KEY, ownerChannelId: channelId, expiresAt: { $gt: new Date() } },
      { $set: { expiresAt: new Date(Date.now() + RENDER_LOCK_TTL_MS) } }
    );
    if (result.matchedCount) return true;
    if (!controller.signal.aborted) {
      controller.abort(new Error('The global render lock was lost; stopping the active FFmpeg process.'));
    }
    return false;
  } catch (error) {
    if (!controller.signal.aborted) {
      controller.abort(new Error('The global render lock could not be renewed; stopping the active FFmpeg process.'));
    }
    console.error(`Unable to renew render lock for ${channelId}:`, error.message);
    return false;
  }
}

async function releaseLock(channelId) {
  await AutomationLock.deleteOne({ lockKey: LOCK_KEY, ownerChannelId: channelId });
}

async function publishChannel(channelId, profile, today) {
  if (processRenderActive) return { skipped: true, reason: 'Another channel is rendering or uploading.' };
  if (!await acquireRenderLock(channelId)) return { skipped: true, reason: 'Another channel is rendering or uploading.' };
  processRenderActive = true;
  const renderController = new AbortController();
  let jobDir;
  let lockLost = false;
  const heartbeat = setInterval(async () => {
    lockLost = !(await renewRenderLock(channelId, renderController));
  }, RENDER_LOCK_HEARTBEAT_MS);
  heartbeat.unref();
  const ensureLock = () => {
    if (lockLost || renderController.signal.aborted) {
      throw new Error('The global render lock was lost; stopping before the next pipeline step.');
    }
  };
  try {
    jobDir = createJobDirectory(channelId);
    const generated = await generateShort(channelId);
    ensureLock();
    const sceneAssets = generateSceneAssets(generated.scenePrompts);
    ensureLock();
    const voice = await generateVoiceover(generated.script, profile.language, jobDir, renderController.signal);
    ensureLock();
    const file = await renderShort({
      sceneAssets, audioPath: voice, hook: generated.hook,
      subtitleBeats: generated.subtitleBeats, jobDir, signal: renderController.signal
    });
    ensureLock();
    const videoId = await uploadShort(channelId, file, generated, profile.automation.privacyStatus);
    await VideoLog.create({
      channelId, videoId, title: generated.title, hook: generated.hook,
      script: generated.script, tags: generated.tags, publishedAt: new Date()
    });
    await ChannelProfile.updateOne({ channelId }, { $set: { 'automation.lastPublishedDateIST': today } });
    return { channelId, videoId, title: generated.title };
  } finally {
    clearInterval(heartbeat);
    try {
      if (jobDir) fs.rmSync(jobDir, { recursive: true, force: true });
    } finally {
      try {
        await releaseLock(channelId);
      } finally {
        processRenderActive = false;
      }
    }
  }
}

export async function publishNow(channelId) {
  const profile = await ChannelProfile.findOne({ channelId }).lean();
  if (!profile) throw new Error(`Channel profile not found for ${channelId}.`);
  if (!profile.automation?.privacyStatus) throw new Error(`Channel ${channelId} has no privacy setting.`);
  return publishChannel(channelId, profile, istSchedule().today);
}

export async function runScheduledTrigger() {
  const next = await getNextDueChannel();
  if (!next) return { published: false, reason: 'No channel is due today.' };
  const { profile, today } = next;
  const result = await publishChannel(profile.channelId, profile, today);
  return { published: !result.skipped, ...result };
}
