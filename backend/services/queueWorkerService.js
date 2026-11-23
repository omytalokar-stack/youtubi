import fs from 'node:fs';
import ChannelProfile from '../models/ChannelProfile.js';
import AutomationLock from '../models/AutomationLock.js';
import VideoLog from '../models/VideoLog.js';
import { generateShort } from './geminiService.js';
import { generateSceneAssets } from './visualService.js';
import { generateVoiceover } from './ttsService.js';
import { createJobDirectory, renderShort } from './renderService.js';
import { getChannelStats, optimizeAndPublishLatestVideo, uploadShort } from './youtubeService.js';
import { pruneChannelLogs } from './logCleanupService.js';

const LOCK_KEY = 'GLOBAL_RENDER_WORKER';
export const RENDER_LOCK_TTL_MS = 15 * 60 * 1000;
export const RENDER_LOCK_HEARTBEAT_MS = 60 * 1000;
export const SCHEDULE_RETRY_BASE_MS = 30 * 1000;
export const SCHEDULE_RETRY_MAX_MS = 60 * 60 * 1000;
const DEFAULT_PUBLISH_TIME_IST = '16:00';
const PUBLISH_TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
let processRenderActive = false;
const pipelineStatuses = new Map();
const pipelineListeners = new Map();

export function updatePipelineStatus(channelId, stage, {
  lastVideoTitle, failedAtStage, reason, runStatus, runSource, runMode
} = {}) {
  const previous = pipelineStatuses.get(channelId);
  const status = {
    channelId,
    stage,
    lastVideoTitle: lastVideoTitle ?? previous?.lastVideoTitle ?? '',
    timestamp: new Date().toISOString(),
    reason: reason ?? previous?.reason ?? '',
    runStatus: runStatus ?? previous?.runStatus ?? '',
    runSource: runSource ?? previous?.runSource ?? '',
    runMode: runMode ?? previous?.runMode ?? '',
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
  const profile = await ChannelProfile.findOne({ channelId })
    .select('automation.lastRun').lean();
  const lastRun = profile?.automation?.lastRun;
  if (lastRun && lastRun.status !== 'idle') {
    const stage = lastRun.status === 'failed'
      ? 'failed'
      : lastRun.status === 'completed' ? 'completed'
        : lastRun.status === 'running' ? lastRun.stage
          : 'idle';
    const timestamp = lastRun.finishedAt || lastRun.startedAt;
    return {
      channelId,
      stage,
      lastVideoTitle: lastRun.title || '',
      timestamp: timestamp ? new Date(timestamp).toISOString() : new Date().toISOString(),
      reason: lastRun.reason || '',
      runStatus: lastRun.status,
      runSource: lastRun.source || '',
      runMode: lastRun.mode || '',
      ...(lastRun.failedAtStage ? { failedAtStage: lastRun.failedAtStage } : {})
    };
  }
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
  if (profile.automation?.omes?.enabled && typeof profile.automation.omes.publishTimeIst === 'string') {
    return profile.automation.omes.publishTimeIst;
  }
  if (typeof profile.publishTimeIst === 'string') return profile.publishTimeIst;
  const { scheduleHourIST: hour, scheduleMinuteIST: minute } = profile.automation || {};
  if (Number.isInteger(hour) && hour >= 0 && hour <= 23 &&
      Number.isInteger(minute) && minute >= 0 && minute <= 59) {
    return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  }
  return DEFAULT_PUBLISH_TIME_IST;
}

export function isOmesDueForSchedule(profile, current = getIstSchedule(), now = new Date()) {
  const omes = profile.automation?.omes;
  if (omes?.enabled !== true || !PUBLISH_TIME_PATTERN.test(omes.publishTimeIst || '')) return false;
  const [publishHour, publishMinute] = omes.publishTimeIst.split(':').map(Number);
  const [currentHour, currentMinute] = current.timeIst.split(':').map(Number);
  const minutesAfterSchedule = (currentHour * 60 + currentMinute) - (publishHour * 60 + publishMinute);
  if (minutesAfterSchedule < 0 || hasScheduledRunForDate(profile, current, 'omes')) return false;
  if (!omes.lastOmesRunAt) return true;

  const lastRun = new Date(omes.lastOmesRunAt);
  if (Number.isNaN(lastRun.getTime()) || lastRun > now ||
      getIstSchedule(lastRun).todayIst === current.todayIst) return false;
  if (omes.frequency === 'alternate') {
    return now.getTime() - lastRun.getTime() >= 44 * 60 * 60 * 1000;
  }
  return true;
}

export function isChannelDueForSchedule(profile, current = getIstSchedule(), now = new Date()) {
  if (profile.automation?.omes?.enabled === true) return isOmesDueForSchedule(profile, current, now);
  if (profile.autoPublishEnabled !== true ||
      profile.lastAutoPublishedDateIst === current.todayIst ||
      hasScheduledRunForDate(profile, current, 'auto-upload')) return false;
  const publishTimeIst = getChannelPublishTimeIst(profile);
  if (!PUBLISH_TIME_PATTERN.test(publishTimeIst)) return false;
  const [publishHour, publishMinute] = publishTimeIst.split(':').map(Number);
  const [currentHour, currentMinute] = current.timeIst.split(':').map(Number);
  const minutesAfterSchedule = (currentHour * 60 + currentMinute) - (publishHour * 60 + publishMinute);
  return minutesAfterSchedule >= 0;
}

function hasScheduledRunForDate(profile, current, mode) {
  const run = profile.automation?.lastRun;
  return run?.source === 'scheduled' &&
    run.mode === mode &&
    run.scheduledDateIst === current.todayIst &&
    run.scheduledTimeIst === getChannelPublishTimeIst(profile) &&
    ['queued', 'running', 'completed', 'skipped', 'failed'].includes(run.status);
}

function canResumeScheduledRun(profile, now = new Date()) {
  const run = profile.automation?.lastRun;
  const retryingPreviousFailure = run?.status === 'failed' &&
    isTransientScheduledError({ message: run.reason });
  if (!run || (!['queued', 'running'].includes(run.status) && !retryingPreviousFailure) ||
      run.source !== 'scheduled') return false;
  if (run.nextAttemptAt && new Date(run.nextAttemptAt) > now) return false;
  if (run.mode === 'omes') {
    return profile.automation?.omes?.enabled === true &&
      getChannelPublishTimeIst(profile) === run.scheduledTimeIst;
  }
  return profile.autoPublishEnabled === true &&
    profile.automation?.omes?.enabled !== true &&
    getChannelPublishTimeIst(profile) === run.scheduledTimeIst &&
    profile.lastAutoPublishedDateIst !== run.scheduledDateIst;
}

async function saveScheduledRun(channelId, run) {
  const update = {};
  for (const field of [
    'status', 'source', 'mode', 'stage', 'failedAtStage', 'reason', 'title',
    'videoId', 'scheduledDateIst', 'scheduledTimeIst', 'startedAt', 'finishedAt',
    'retryCount', 'nextAttemptAt'
  ]) {
    update[`automation.lastRun.${field}`] = run[field] ??
      (['finishedAt', 'nextAttemptAt'].includes(field) ? null : field === 'retryCount' ? 0 : '');
  }
  const result = await ChannelProfile.updateOne({ channelId }, { $set: update });
  if (result.matchedCount === 0) throw new Error(`Channel profile not found while saving scheduled status for ${channelId}.`);
}

export async function prepareScheduledRun({ now = new Date(), recordRun = saveScheduledRun } = {}) {
  const current = getIstSchedule(now);
  const profiles = await ChannelProfile.find({}).lean();
  const dueProfiles = profiles.map((profile) => ({
    ...profile,
    autoPublishEnabled: profile.autoPublishEnabled === undefined ? true : profile.autoPublishEnabled
  })).filter((profile) =>
    isChannelDueForSchedule(profile, current, now) || canResumeScheduledRun(profile, now)
  ).sort((left, right) =>
    getChannelPublishTimeIst(left).localeCompare(getChannelPublishTimeIst(right)) ||
    left.channelId.localeCompare(right.channelId)
  );
  const queuedProfiles = [];
  for (const profile of dueProfiles) {
    const previous = profile.automation?.lastRun;
    const resuming = canResumeScheduledRun(profile, now);
    const run = {
      status: 'queued',
      source: 'scheduled',
      mode: profile.automation?.omes?.enabled === true ? 'omes' : 'auto-upload',
      stage: 'queued',
      failedAtStage: '',
      reason: resuming
        ? previous.status === 'failed'
          ? `Retrying a previously failed scheduled run: ${previous.reason}`
          : 'Retrying an interrupted scheduled run.'
        : '',
      title: resuming ? previous.title || '' : '',
      videoId: resuming ? previous.videoId || '' : '',
      scheduledDateIst: resuming ? previous.scheduledDateIst : current.todayIst,
      scheduledTimeIst: getChannelPublishTimeIst(profile),
      startedAt: resuming ? previous.startedAt || now : now,
      finishedAt: null,
      retryCount: resuming ? previous.retryCount || 0 : 0,
      nextAttemptAt: null
    };
    await recordRun(profile.channelId, run);
    updatePipelineStatus(profile.channelId, 'queued', {
      lastVideoTitle: run.title,
      reason: run.reason,
      runStatus: 'queued',
      runSource: 'scheduled',
      runMode: run.mode
    });
    queuedProfiles.push({
      ...profile,
      automation: { ...profile.automation, lastRun: run }
    });
  }
  return { current, dueProfiles: queuedProfiles };
}

export function isScheduledChannelStillEligible(currentProfile, scheduledProfile, scheduledDateIst) {
  return Boolean(currentProfile &&
    currentProfile.automation?.omes?.enabled !== true &&
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
    updatePipelineStatus(channelId, stage, {
      reason: '',
      runStatus: 'running',
      runSource: autoPublished ? 'scheduled' : 'manual',
      runMode: 'auto-upload'
    });
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
      privacyStatus: profile.automation.privacyStatus,
      publishedAt: new Date()
    });
    try {
      await pruneChannelLogs(channelId);
    } catch (error) {
      console.warn(`Log cleanup failed after publishing for ${channelId}:`, error.message);
    }
    if (trackPublication) await recordPublishedDate(channelId, getTodayIST(), autoPublished);
    try {
      await getChannelStats(channelId);
    } catch (error) {
      console.warn(`YouTube statistics refresh failed after publishing for ${channelId}:`, error.message);
    }
    stage = 'completed';
    updatePipelineStatus(channelId, stage, {
      lastVideoTitle: generated.title,
      runStatus: 'completed',
      reason: ''
    });
    return { channelId, videoId, title: generated.title };
  } catch (error) {
    updatePipelineStatus(channelId, 'failed', {
      failedAtStage: stage,
      reason: error.message,
      runStatus: 'failed',
      runSource: autoPublished ? 'scheduled' : 'manual',
      runMode: 'auto-upload'
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
  if (profile.automation?.omes?.enabled === true) {
    const error = new Error('OMES is enabled for this channel; native Short generation and upload are disabled.');
    error.status = 409;
    throw error;
  }
  if (!profile.automation?.privacyStatus) throw new Error(`Channel ${channelId} has no privacy setting.`);
  return publishChannel(channelId, profile, { trackPublication: true });
}

async function saveRunStatusSafely(recordRun, channelId, run, phase) {
  try {
    await recordRun(channelId, run);
  } catch (error) {
    console.error(`Could not persist scheduled ${phase} status for ${channelId}:`, error.message);
  }
}

function isTransientScheduledError(error) {
  const status = Number(error?.status ?? error?.response?.status ?? error?.code);
  const message = `${typeof error === 'string' ? error : error?.message || ''} ${error?.code || ''}`.toLowerCase();
  return [429, 500, 502, 503, 504].includes(status) ||
    /resource_exhausted|quota|rate limit|retryable http error|temporarily unavailable|timeout|timed out|econnreset|etimedout|socket hang up|no audio|incomplete channel performance analysis|invalid video keywords|generated short failed validation/.test(message);
}

async function runScheduledTriggerOnce({
  now = new Date(), publish, publishOmes, recordRun = saveScheduledRun, prepared
} = {}) {
  const schedule = prepared || await prepareScheduledRun({ now, recordRun });
  const { current, dueProfiles } = schedule;
  const publishScheduled = publish || ((channelId, profile) =>
    publishChannel(channelId, profile, {
      trackPublication: true,
      autoPublished: true,
      scheduledDateIst: current.todayIst
    }));
  const optimizeOmes = publishOmes || optimizeAndPublishLatestVideo;
  if (!dueProfiles.length) return { published: false, results: [], reason: 'No channel is due today.' };

  const results = [];
  for (const profile of dueProfiles) {
    const { channelId } = profile;
    const isOmes = profile.automation?.omes?.enabled === true;
    const runMode = isOmes ? 'omes' : 'auto-upload';
    const queuedRun = profile.automation?.lastRun || {};
    const runningRun = {
      ...queuedRun,
      status: 'running',
      source: 'scheduled',
      mode: runMode,
      stage: isOmes ? 'optimizing' : 'dna',
      failedAtStage: '',
      reason: '',
      startedAt: queuedRun.startedAt || now,
      finishedAt: null,
      nextAttemptAt: null
    };
    await saveRunStatusSafely(recordRun, channelId, runningRun, 'running');
    updatePipelineStatus(channelId, runningRun.stage, {
      lastVideoTitle: runningRun.title || '',
      reason: '',
      runStatus: 'running',
      runSource: 'scheduled',
      runMode
    });
    try {
      const result = isOmes
        ? await optimizeOmes(channelId)
        : await publishScheduled(channelId, profile);
      const finishedAt = new Date();
      if (result.skipped) {
        const reason = result.reason || 'The scheduled channel run was skipped.';
        if (/rendering or uploading|render lock|lock/i.test(reason)) {
          const queuedRun = {
            ...runningRun,
            status: 'queued',
            stage: 'queued',
            reason,
            finishedAt: null
          };
          updatePipelineStatus(channelId, 'queued', {
            reason, runStatus: 'queued', runSource: 'scheduled', runMode
          });
          await saveRunStatusSafely(recordRun, channelId, queuedRun, 'queued');
          results.push({ ...result, channelId, published: false, retryQueued: true });
          continue;
        }
        const skippedRun = {
          ...runningRun,
          status: 'skipped',
          stage: 'idle',
          reason,
          finishedAt,
          nextAttemptAt: null
        };
        updatePipelineStatus(channelId, 'idle', {
          reason, runStatus: 'skipped', runSource: 'scheduled', runMode
        });
        await saveRunStatusSafely(recordRun, channelId, skippedRun, 'skipped');
        results.push({ ...result, channelId, published: false });
        continue;
      }
      const title = result.title || result.metadata?.title || '';
      const videoId = result.videoId || '';
      const completedRun = {
        ...runningRun,
        status: 'completed',
        stage: 'completed',
        reason: '',
        title,
        videoId,
        finishedAt,
        retryCount: 0,
        nextAttemptAt: null
      };
      updatePipelineStatus(channelId, 'completed', {
        lastVideoTitle: title,
        reason: '',
        runStatus: 'completed',
        runSource: 'scheduled',
        runMode
      });
      await saveRunStatusSafely(recordRun, channelId, completedRun, 'completed');
      results.push({ ...result, channelId, published: true });
    } catch (error) {
      const failedAtStage = pipelineStatuses.get(channelId)?.failedAtStage ||
        (isOmes ? 'optimizing' : pipelineStatuses.get(channelId)?.stage || 'dna');
      if (isTransientScheduledError(error)) {
        const retryCount = (runningRun.retryCount || 0) + 1;
        const retryDelay = Math.min(
          SCHEDULE_RETRY_BASE_MS * (2 ** (retryCount - 1)),
          SCHEDULE_RETRY_MAX_MS
        );
        const retryRun = {
          ...runningRun,
          status: 'queued',
          stage: 'queued',
          reason: `Temporary provider failure; retrying automatically: ${error.message}`,
          failedAtStage: '',
          retryCount,
          nextAttemptAt: new Date(Date.now() + retryDelay),
          finishedAt: null
        };
        updatePipelineStatus(channelId, 'queued', {
          reason: retryRun.reason,
          runStatus: 'queued',
          runSource: 'scheduled',
          runMode
        });
        await saveRunStatusSafely(recordRun, channelId, retryRun, 'queued retry');
        console.warn(`Scheduled ${isOmes ? 'OMES optimization' : 'publish'} is queued for automatic retry: ${channelId}: ${error.message}`);
        results.push({ channelId, published: false, retryQueued: true, error: error.message });
        continue;
      }
      const failedRun = {
        ...runningRun,
        status: 'failed',
        stage: 'failed',
        failedAtStage,
        reason: error.message,
        finishedAt: new Date(),
        nextAttemptAt: null
      };
      updatePipelineStatus(channelId, 'failed', {
        failedAtStage, reason: error.message, runStatus: 'failed',
        runSource: 'scheduled', runMode
      });
      await saveRunStatusSafely(recordRun, channelId, failedRun, 'failed');
      console.error(`Scheduled ${isOmes ? 'OMES optimization' : 'publish'} failed for ${channelId}:`, error.message);
      results.push({ channelId, published: false, error: error.message });
    }
  }
  return { published: results.some((result) => result.published), results };
}

let scheduledTriggerActive = false;
let scheduledTriggerPending = false;

export async function runScheduledTrigger(options = {}) {
  if (scheduledTriggerActive) {
    scheduledTriggerPending = true;
    return { published: false, results: [], pending: true, reason: 'Scheduled trigger queued behind the active worker.' };
  }
  scheduledTriggerActive = true;
  try {
    let callOptions = { ...options };
    while (true) {
      scheduledTriggerPending = false;
      const result = await runScheduledTriggerOnce(callOptions);
      if (!scheduledTriggerPending) return result;
      const { prepared: _prepared, ...freshOptions } = callOptions;
      callOptions = freshOptions;
    }
  } finally {
    scheduledTriggerActive = false;
  }
}
