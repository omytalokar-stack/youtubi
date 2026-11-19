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
const LOCK_DURATION_MS = 15 * 60 * 1000;

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

async function acquireLock(channelId) {
  const now = new Date();
  try {
    const lock = await AutomationLock.findOneAndUpdate(
      { lockKey: LOCK_KEY, $or: [{ expiresAt: { $lte: now } }, { ownerChannelId: channelId }] },
      { $set: { ownerChannelId: channelId, expiresAt: new Date(now.getTime() + LOCK_DURATION_MS) } },
      { upsert: true, new: true, runValidators: true }
    );
    return lock.ownerChannelId === channelId;
  } catch (error) {
    if (error.code === 11000) return false;
    throw error;
  }
}

async function releaseLock(channelId) {
  await AutomationLock.deleteOne({ lockKey: LOCK_KEY, ownerChannelId: channelId });
}

async function publishChannel(channelId, profile, today) {
  if (!await acquireLock(channelId)) return { skipped: true, reason: 'Another channel is rendering or uploading.' };
  let jobDir;
  let lockLost = false;
  const heartbeat = setInterval(async () => {
    try {
      const result = await AutomationLock.updateOne(
        { lockKey: LOCK_KEY, ownerChannelId: channelId, expiresAt: { $gt: new Date() } },
        { $set: { expiresAt: new Date(Date.now() + LOCK_DURATION_MS) } }
      );
      if (!result.matchedCount) lockLost = true;
    } catch (error) {
      lockLost = true;
      console.error(`Unable to renew render lock for ${channelId}:`, error.message);
    }
  }, 60 * 1000);
  heartbeat.unref();
  const ensureLock = () => {
    if (lockLost) throw new Error('The global render lock was lost; stopping before the next pipeline step.');
  };
  try {
    jobDir = createJobDirectory(channelId);
    const generated = await generateShort(channelId);
    ensureLock();
    const sceneAssets = generateSceneAssets(generated.scenePrompts);
    ensureLock();
    const voice = await generateVoiceover(generated.script, profile.language, jobDir);
    ensureLock();
    const file = await renderShort({
      sceneAssets, audioPath: voice, hook: generated.hook,
      subtitleBeats: generated.subtitleBeats, jobDir
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
      await releaseLock(channelId);
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
