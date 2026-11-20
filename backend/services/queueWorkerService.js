import fs from 'node:fs';
import ChannelProfile from '../models/ChannelProfile.js';
import AutomationLock from '../models/AutomationLock.js';
import VideoLog from '../models/VideoLog.js';
import { generateShort } from './geminiService.js';
import { generateSceneAssets } from './visualService.js';
import { generateVoiceover } from './ttsService.js';
import { createJobDirectory, renderShort } from './renderService.js';
import { getChannelStats, uploadShort } from './youtubeService.js';

const LOCK_KEY = 'GLOBAL_RENDER_WORKER';
export const RENDER_LOCK_TTL_MS = 15 * 60 * 1000;
export const RENDER_LOCK_HEARTBEAT_MS = 60 * 1000;
export const SCHEDULE_WINDOW_MINUTES = 25;
const DEFAULT_PUBLISH_TIME_IST = '16:00';
const PUBLISH_TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
let processRenderActive = false;
const pipelineStatuses = new Map();
const pipelineListeners = new Map();

export function updatePipelineStatus(channelId, stage, { lastVideoTitle, failedAtStage } = {}) {
  const previous = pipelineStatuses.get(channelId);
  const status = {
    channelId,
    stage,
    lastVideoTitle: lastVideoTitle ?? previous?.lastVideoTitle ?? '',
    timestamp: new Date().toISOString(),
    ...(failedAtStage ? { failedAtStage } : {})
  };
  pipelineStatuses.set(channelId, status);
  for (const listener of pipelineListeners.get(channelId) || []) {
    try {
      listener(status);
    } catch (error) {
      console.warn(`Could not send pipeline status to a listener for ${channelId}:`, error.message);
    }
  }
  return status;
}

export async function getPipelineStatus(channelId) {
  const current = pipelineStatuses.get(channelId);
  if (current) return current;
  const lastVideo = await VideoLog.findOne({ channelId })
    .sort({ publishedAt: -1 }).select('title publishedAt').lean();
  return {
    channelId,
    stage: 'idle',
    lastVideoTitle: lastVideo?.title || '',
    timestamp: lastVideo?.publishedAt ? new Date(lastVideo.publishedAt).toISOString() : new Date().toISOString()
  };
}

export function subscribeToPipelineStatus(channelId, listener) {
  const listeners = pipelineListeners.get(channelId) || new Set();
  listeners.add(listener);
  pipelineListeners.set(channelId, listeners);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) pipelineListeners.delete(channelId);
  };
}

export function getIstSchedule(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(date);
  const value = (type) => parts.find((part) => part.type === type)?.value;
  return {
    todayIst: `${value('year')}-${value('month')}-${value('day')}`,
    timeIst: `${value('hour')}:${value('minute')}`
  };
}

export function getTodayIST() {
  return getIstSchedule().todayIst;
}

function getChannelPublishTimeIst(profile) {
  if (typeof profile.publishTimeIst === 'string') return profile.publishTimeIst;
  const { scheduleHourIST: hour, scheduleMinuteIST: minute } = profile.automation || {};
  if (Number.isInteger(hour) && hour >= 0 && hour <= 23 &&
      Number.isInteger(minute) && minute >= 0 && minute <= 59) {
    return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  }
  return DEFAULT_PUBLISH_TIME_IST;
}

export function isChannelDueForSchedule(profile, current = getIstSchedule()) {
  if (profile.autoPublishEnabled !== true ||
      profile.lastAutoPublishedDateIst === current.todayIst) return false;
  const publishTimeIst = getChannelPublishTimeIst(profile);
  if (!PUBLISH_TIME_PATTERN.test(publishTimeIst)) return false;
  const [publishHour, publishMinute] = publishTimeIst.split(':').map(Number);
  const [currentHour, currentMinute] = current.timeIst.split(':').map(Number);
  const minutesAfterSchedule = (currentHour * 60 + currentMinute) - (publishHour * 60 + publishMinute);
  return minutesAfterSchedule >= 0 && minutesAfterSchedule <= SCHEDULE_WINDOW_MINUTES;
}

export function isScheduledChannelStillEligible(currentProfile, scheduledProfile, scheduledDateIst) {
  return Boolean(currentProfile &&
    (currentProfile.autoPublishEnabled ?? true) &&
    getChannelPublishTimeIst(currentProfile) === getChannelPublishTimeIst(scheduledProfile) &&
    currentProfile.lastAutoPublishedDateIst !== scheduledDateIst);
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

export async function recordPublishedDate(channelId, todayIst, autoPublished = false) {
  const fields = { 'automation.lastPublishedDateIST': todayIst };
  if (autoPublished) fields.lastAutoPublishedDateIst = todayIst;
  await ChannelProfile.updateOne({ channelId }, { $set: fields });
}

async function publishChannel(channelId, profile, {
  trackPublication = false, autoPublished = false, scheduledDateIst
} = {}) {
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
  let stage = 'dna';
  try {
    if (autoPublished) {
      const currentProfile = await ChannelProfile.findOne({ channelId }).lean();
      if (!isScheduledChannelStillEligible(currentProfile, profile, scheduledDateIst)) {
        return { skipped: true, reason: 'Channel is no longer due for an automatic upload.' };
      }
      profile = currentProfile;
    }
    updatePipelineStatus(channelId, stage);
    jobDir = createJobDirectory(channelId);
    const generated = await generateShort(channelId, {
      onWriting: () => {
        stage = 'writing';
        updatePipelineStatus(channelId, stage);
      }
    });
    ensureLock();
    updatePipelineStatus(channelId, stage, { lastVideoTitle: generated.title });
    stage = 'rendering';
    updatePipelineStatus(channelId, stage, { lastVideoTitle: generated.title });
    const sceneAssets = generateSceneAssets(generated.scenePrompts, generated.visualQueries);
    const recentVideoMedia = await VideoLog.find({ channelId })
      .sort({ publishedAt: -1 }).limit(30).select('visualMediaIds').lean();
    const excludedMediaIds = new Set(recentVideoMedia.flatMap((video) => video.visualMediaIds || []));
    ensureLock();
    const voice = await generateVoiceover(generated.script, profile.language, jobDir, renderController.signal);
    ensureLock();
    const render = await renderShort({
      sceneAssets, audioPath: voice, hook: generated.hook,
      subtitleBeats: generated.subtitleBeats, jobDir, signal: renderController.signal,
      excludedMediaIds
    });
    ensureLock();
    stage = 'uploading';
    updatePipelineStatus(channelId, stage, { lastVideoTitle: generated.title });
    const videoId = await uploadShort(channelId, render.outputPath, generated, profile.automation.privacyStatus);
    await VideoLog.create({
      channelId, videoId, topic: generated.topic, title: generated.title, hook: generated.hook,
      script: generated.script, tags: generated.tags, visualMediaIds: render.visualMediaIds,
      publishedAt: new Date()
    });
    if (trackPublication) await recordPublishedDate(channelId, getTodayIST(), autoPublished);
    try {
      await getChannelStats(channelId);
    } catch (error) {
      console.warn(`YouTube statistics refresh failed after publishing for ${channelId}:`, error.message);
    }
    stage = 'completed';
    updatePipelineStatus(channelId, stage, { lastVideoTitle: generated.title });
    return { channelId, videoId, title: generated.title };
  } catch (error) {
    updatePipelineStatus(channelId, 'failed', {
      failedAtStage: stage
    });
    throw error;
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
  return publishChannel(channelId, profile, { trackPublication: true });
}

export async function runScheduledTrigger({ now = new Date(), publish } = {}) {
  const current = getIstSchedule(now);
  const publishScheduled = publish || ((channelId, profile) =>
    publishChannel(channelId, profile, {
      trackPublication: true,
      autoPublished: true,
      scheduledDateIst: current.todayIst
    }));
  const profiles = await ChannelProfile.find({}).lean();
  const dueProfiles = profiles.map((profile) => ({
    ...profile,
    autoPublishEnabled: profile.autoPublishEnabled === undefined ? true : profile.autoPublishEnabled
  })).filter((profile) => isChannelDueForSchedule(profile, current))
    .sort((left, right) =>
      getChannelPublishTimeIst(left).localeCompare(getChannelPublishTimeIst(right)) ||
      left.channelId.localeCompare(right.channelId)
    );
  if (!dueProfiles.length) return { published: false, results: [], reason: 'No channel is due today.' };

  const results = [];
  for (const profile of dueProfiles) {
    const { channelId } = profile;
    try {
      const result = await publishScheduled(channelId, profile);
      if (result.skipped) {
        results.push({ ...result, channelId, published: false });
        continue;
      }
      results.push({ ...result, channelId, published: true });
    } catch (error) {
      console.error(`Scheduled publish failed for ${channelId}:`, error.message);
      results.push({ channelId, published: false, error: error.message });
    }
  }
  return { published: results.some((result) => result.published), results };
}
