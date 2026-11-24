import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import AutomationLock from '../models/AutomationLock.js';
import ChannelProfile from '../models/ChannelProfile.js';
import {
  acquireRenderLock, getIstSchedule, isChannelDueForSchedule, isOmesDueForSchedule, renewRenderLock,
  getPipelineStatus, isScheduledChannelStillEligible, RENDER_LOCK_HEARTBEAT_MS,
  RENDER_LOCK_TTL_MS, recordPublishedDate, publishNow, prepareScheduledRun,
  runScheduledTrigger, subscribeToPipelineStatus, updatePipelineStatus,
  SCHEDULE_RETRY_BASE_MS, uploadShortWithCleanup
} from './queueWorkerService.js';

test('removes the complete job directory as soon as upload resolves or fails', async (t) => {
  const successfulJob = fs.mkdtempSync(path.join(os.tmpdir(), 'dimag_upload_cleanup_test_'));
  const failedJob = fs.mkdtempSync(path.join(os.tmpdir(), 'dimag_upload_cleanup_test_'));
  t.after(() => {
    fs.rmSync(successfulJob, { recursive: true, force: true });
    fs.rmSync(failedJob, { recursive: true, force: true });
  });
  fs.writeFileSync(path.join(successfulJob, 'final_short.mp4'), 'video');
  fs.writeFileSync(path.join(failedJob, 'final_short.mp4'), 'video');
  let outputExistedDuringUpload = false;

  const videoId = await uploadShortWithCleanup(async () => {
    outputExistedDuringUpload = fs.existsSync(path.join(successfulJob, 'final_short.mp4'));
    return 'uploaded-video';
  }, successfulJob);

  assert.equal(videoId, 'uploaded-video');
  assert.equal(outputExistedDuringUpload, true);
  assert.equal(fs.existsSync(successfulJob), false);
  await assert.rejects(
    uploadShortWithCleanup(async () => { throw new Error('YouTube upload failed.'); }, failedJob),
    /YouTube upload failed/
  );
  assert.equal(fs.existsSync(failedJob), false);
});

test('catches up scheduled channels any time after their IST publish time on the same day', () => {
  const current = getIstSchedule(new Date('2026-11-18T10:30:00.000Z'));
  const profile = {
    autoPublishEnabled: true,
    publishTimeIst: '16:00',
    lastAutoPublishedDateIst: ''
  };
  assert.deepEqual(current, { todayIst: '2026-11-18', timeIst: '16:00' });
  assert.equal(isChannelDueForSchedule(profile, current), true);
  assert.equal(isChannelDueForSchedule(profile, { ...current, timeIst: '16:25' }), true);
  assert.equal(isChannelDueForSchedule(profile, { ...current, timeIst: '23:59' }), true);
  assert.equal(isChannelDueForSchedule(profile, { ...current, timeIst: '15:59' }), false);
  assert.equal(isChannelDueForSchedule({ ...profile, autoPublishEnabled: undefined }, current), false);
});

test('formats IST schedules in 24-hour time across midnight', () => {
  assert.deepEqual(getIstSchedule(new Date('2026-11-18T18:20:00.000Z')), {
    todayIst: '2026-11-18',
    timeIst: '23:50'
  });
  assert.deepEqual(getIstSchedule(new Date('2026-11-18T18:35:00.000Z')), {
    todayIst: '2026-11-19',
    timeIst: '00:05'
  });
});

test('does not reschedule a channel already published on the current IST date', () => {
  const current = { todayIst: '2026-11-18', timeIst: '16:00' };
  assert.equal(isChannelDueForSchedule({
    autoPublishEnabled: true,
    publishTimeIst: '16:00',
    lastAutoPublishedDateIst: current.todayIst
  }, current), false);
});

test('catches up OMES after its IST time and enforces the alternate-day cooldown', () => {
  const now = new Date('2026-11-18T05:30:00.000Z');
  const current = getIstSchedule(now);
  const daily = { automation: { omes: { enabled: true, frequency: 'daily', publishTimeIst: '11:00' } } };
  assert.equal(isChannelDueForSchedule(daily, current, now), true);
  assert.equal(isOmesDueForSchedule(daily, { ...current, timeIst: '22:30' }, now), true);
  assert.equal(isOmesDueForSchedule(daily, { ...current, timeIst: '10:59' }, now), false);

  const alternate = {
    automation: {
      omes: { enabled: true, frequency: 'alternate', publishTimeIst: '11:00', lastOmesRunAt: '2026-11-16T05:30:00.000Z' }
    }
  };
  assert.equal(isOmesDueForSchedule(alternate, current, now), true);
  assert.equal(isOmesDueForSchedule({
    ...alternate,
    automation: { omes: { ...alternate.automation.omes, lastOmesRunAt: '2026-11-16T10:30:00.000Z' } }
  }, current, now), false);
  assert.equal(isOmesDueForSchedule({
    ...daily,
    automation: { omes: { ...daily.automation.omes, lastOmesRunAt: now } }
  }, current, now), false);
});

test('keeps a queued channel eligible after its scheduled time if its schedule is unchanged', () => {
  const scheduledProfile = {
    autoPublishEnabled: true,
    publishTimeIst: '16:00',
    lastAutoPublishedDateIst: ''
  };
  assert.equal(isScheduledChannelStillEligible({
    ...scheduledProfile,
    lastAutoPublishedDateIst: ''
  }, scheduledProfile, '2026-11-18'), true);
  assert.equal(isScheduledChannelStillEligible({
    ...scheduledProfile,
    autoPublishEnabled: false
  }, scheduledProfile, '2026-11-18'), false);
  assert.equal(isScheduledChannelStillEligible({
    ...scheduledProfile,
    publishTimeIst: '17:00'
  }, scheduledProfile, '2026-11-18'), false);
  assert.equal(isScheduledChannelStillEligible({
    ...scheduledProfile,
    lastAutoPublishedDateIst: '2026-11-18'
  }, scheduledProfile, '2026-11-18'), false);
  assert.equal(isScheduledChannelStillEligible({
    ...scheduledProfile,
    automation: { omes: { enabled: true } }
  }, scheduledProfile, '2026-11-18'), false);
});

test('does not repeat a terminal failure or bypass a queued retry delay', async (t) => {
  const originalFind = ChannelProfile.find;
  t.after(() => { ChannelProfile.find = originalFind; });
  const channelId = `UC${'x'.repeat(22)}`;
  const currentDate = '2026-11-18';
  const baseProfile = {
    channelId,
    autoPublishEnabled: true,
    publishTimeIst: '16:00',
    lastAutoPublishedDateIst: '',
    automation: { omes: { enabled: false } }
  };
  const terminalProfile = {
    ...baseProfile,
    automation: {
      ...baseProfile.automation,
      lastRun: {
        status: 'failed',
        source: 'scheduled',
        mode: 'auto-upload',
        scheduledDateIst: currentDate,
        scheduledTimeIst: '16:00'
      }
    }
  };
  ChannelProfile.find = () => ({ lean: async () => [terminalProfile] });
  assert.equal(isChannelDueForSchedule(
    terminalProfile,
    { todayIst: currentDate, timeIst: '23:00' },
    new Date('2026-11-18T17:30:00.000Z')
  ), false);

  const retryProfile = {
    ...baseProfile,
    automation: {
      ...baseProfile.automation,
      lastRun: {
        status: 'queued',
        source: 'scheduled',
        mode: 'auto-upload',
        scheduledDateIst: currentDate,
        scheduledTimeIst: '16:00',
        retryCount: 1,
        nextAttemptAt: new Date('2026-11-18T10:31:00.000Z')
      }
    }
  };
  ChannelProfile.find = () => ({ lean: async () => [retryProfile] });
  const tooEarly = await prepareScheduledRun({ now: new Date('2026-11-18T10:30:30.000Z') });
  assert.equal(tooEarly.dueProfiles.length, 0);

  const afterDelay = await prepareScheduledRun({
    now: new Date('2026-11-18T10:32:00.000Z'),
    recordRun: async () => {}
  });
  assert.equal(afterDelay.dueProfiles.length, 1);
  assert.equal(afterDelay.dueProfiles[0].automation.lastRun.retryCount, 1);
  assert.equal(afterDelay.dueProfiles[0].automation.lastRun.nextAttemptAt, null);
});

test('runs due channels sequentially in isolated channelId scopes', async (t) => {
  const originalFind = ChannelProfile.find;
  const channelA = `UC${'a'.repeat(22)}`;
  const channelB = `UC${'b'.repeat(22)}`;
  const legacyChannel = `UC${'f'.repeat(22)}`;
  const today = '2026-11-18';
  const profiles = [
    { channelId: channelA, autoPublishEnabled: true, publishTimeIst: '16:00', lastAutoPublishedDateIst: '' },
    { channelId: channelB, autoPublishEnabled: true, publishTimeIst: '15:40', lastAutoPublishedDateIst: '' },
    { channelId: `UC${'c'.repeat(22)}`, autoPublishEnabled: true, publishTimeIst: '15:40', lastAutoPublishedDateIst: today },
    { channelId: `UC${'d'.repeat(22)}`, autoPublishEnabled: false, publishTimeIst: '15:40', lastAutoPublishedDateIst: '' },
    { channelId: `UC${'e'.repeat(22)}`, autoPublishEnabled: true, publishTimeIst: '16:26', lastAutoPublishedDateIst: '' },
    { channelId: legacyChannel, automation: { scheduleHourIST: 15, scheduleMinuteIST: 50 }, lastAutoPublishedDateIst: '' }
  ];
  const executionOrder = [];
  ChannelProfile.find = (filter) => {
    assert.deepEqual(filter, {});
    return { lean: async () => profiles };
  };
  t.after(() => { ChannelProfile.find = originalFind; });

  const result = await runScheduledTrigger({
    now: new Date('2026-11-18T10:30:00.000Z'),
    recordRun: async () => {},
    publish: async (channelId, profile) => {
      assert.equal(profile.channelId, channelId);
      executionOrder.push(`start:${channelId}`);
      await Promise.resolve();
      executionOrder.push(`done:${channelId}`);
      return { channelId, videoId: `video-${channelId}` };
    }
  });

  assert.equal(result.published, true);
  assert.deepEqual(executionOrder, [
    `start:${channelB}`, `done:${channelB}`,
    `start:${legacyChannel}`, `done:${legacyChannel}`,
    `start:${channelA}`, `done:${channelA}`
  ]);
  assert.deepEqual(result.results.map(({ channelId }) => channelId), [channelB, legacyChannel, channelA]);
});

test('recovers persisted scheduled runs even after their original IST window has passed', async (t) => {
  const originalFind = ChannelProfile.find;
  const channelId = `UC${'q'.repeat(22)}`;
  const interruptedRun = {
    status: 'running',
    source: 'scheduled',
    mode: 'auto-upload',
    scheduledDateIst: '2026-11-17',
    scheduledTimeIst: '16:00',
    startedAt: new Date('2026-11-17T10:30:00.000Z')
  };
  ChannelProfile.find = () => ({
    lean: async () => [{
      channelId,
      autoPublishEnabled: true,
      publishTimeIst: '16:00',
      lastAutoPublishedDateIst: '',
      automation: { omes: { enabled: false }, lastRun: interruptedRun }
    }]
  });
  t.after(() => { ChannelProfile.find = originalFind; });
  const persisted = [];

  const prepared = await prepareScheduledRun({
    now: new Date('2026-11-18T18:00:00.000Z'),
    recordRun: async (id, run) => persisted.push({ id, run })
  });

  assert.deepEqual(prepared.dueProfiles.map((profile) => profile.channelId), [channelId]);
  assert.equal(persisted[0].run.status, 'queued');
  assert.equal(persisted[0].run.scheduledDateIst, '2026-11-17');
  assert.match(persisted[0].run.reason, /interrupted/);
});

test('retries persisted retryable failures, including OMES, without requiring auto-upload', async (t) => {
  const originalFind = ChannelProfile.find;
  const currentDate = '2026-11-23';
  const profiles = [
    {
      channelId: `UC${'t'.repeat(22)}`,
      autoPublishEnabled: true,
      publishTimeIst: '16:00',
      lastAutoPublishedDateIst: '',
      automation: {
        omes: { enabled: false },
        lastRun: {
          status: 'failed',
          source: 'scheduled',
          mode: 'auto-upload',
          scheduledDateIst: currentDate,
          scheduledTimeIst: '16:00',
          reason: 'Gemini TTS returned no audio after 3 attempts.',
          retryCount: 0
        }
      }
    },
    {
      channelId: `UC${'s'.repeat(22)}`,
      autoPublishEnabled: true,
      publishTimeIst: '16:00',
      lastAutoPublishedDateIst: '',
      automation: {
        omes: { enabled: false },
        lastRun: {
          status: 'failed',
          source: 'scheduled',
          mode: 'auto-upload',
          scheduledDateIst: currentDate,
          scheduledTimeIst: '16:00',
          reason: 'Generated Short failed validation after 3 corrections: every spoken sentence must contain 11-14 words.',
          retryCount: 0
        }
      }
    },
    {
      channelId: `UC${'o'.repeat(22)}`,
      autoPublishEnabled: false,
      automation: {
        omes: {
          enabled: true,
          frequency: 'daily',
          publishTimeIst: '23:30',
          lastOmesRunAt: new Date('2026-11-22T18:00:00.000Z')
        },
        lastRun: {
          status: 'failed',
          source: 'scheduled',
          mode: 'omes',
          scheduledDateIst: currentDate,
          scheduledTimeIst: '23:30',
          reason: 'Retryable HTTP Error:',
          retryCount: 0
        }
      }
    },
    {
      channelId: `UC${'p'.repeat(22)}`,
      autoPublishEnabled: true,
      publishTimeIst: '16:00',
      lastAutoPublishedDateIst: '',
      automation: {
        omes: { enabled: false },
        lastRun: {
          status: 'failed',
          source: 'scheduled',
          mode: 'auto-upload',
          scheduledDateIst: currentDate,
          scheduledTimeIst: '16:00',
          reason: 'Permanent configuration error.',
          retryCount: 0
        }
      }
    }
  ];
  const saved = [];
  ChannelProfile.find = () => ({ lean: async () => profiles });
  t.after(() => { ChannelProfile.find = originalFind; });

  const prepared = await prepareScheduledRun({
    now: new Date('2026-11-23T18:06:00.000Z'),
    recordRun: async (channelId, run) => saved.push({ channelId, run })
  });

  assert.deepEqual(prepared.dueProfiles.map((profile) => profile.channelId), [
    profiles[1].channelId,
    profiles[0].channelId,
    profiles[2].channelId
  ]);
  assert.equal(prepared.dueProfiles[0].automation.lastRun.mode, 'auto-upload');
  assert.equal(prepared.dueProfiles[1].automation.lastRun.mode, 'auto-upload');
  assert.equal(prepared.dueProfiles[2].automation.lastRun.mode, 'omes');
  assert.ok(saved.every(({ run }) => /previously failed/.test(run.reason)));
  assert.ok(saved.every(({ run }) => run.scheduledDateIst === currentDate));
});

test('records automatic publication dates using only the matching channel ID', async (t) => {
  const originalUpdateOne = ChannelProfile.updateOne;
  const channelId = `UC${'z'.repeat(22)}`;
  let update;
  ChannelProfile.updateOne = async (filter, changes) => {
    update = { filter, changes };
    return { matchedCount: 1 };
  };
  t.after(() => { ChannelProfile.updateOne = originalUpdateOne; });

  await recordPublishedDate(channelId, '2026-11-18', true);

  assert.deepEqual(update.filter, { channelId });
  assert.deepEqual(update.changes.$set, {
    'automation.lastPublishedDateIST': '2026-11-18',
    lastAutoPublishedDateIst: '2026-11-18'
  });
});

test('temporary provider failures remain queued for the 10-second scheduled worker', async (t) => {
  const originalFind = ChannelProfile.find;
  const channelId = `UC${'r'.repeat(22)}`;
  const persisted = [];
  const now = new Date();
  const publishTimeIst = getIstSchedule(now).timeIst;
  ChannelProfile.find = () => ({
    lean: async () => [{
      channelId,
      autoPublishEnabled: true,
      publishTimeIst,
      lastAutoPublishedDateIst: '',
      automation: { omes: { enabled: false } }
    }]
  });
  t.after(() => { ChannelProfile.find = originalFind; });

  const result = await runScheduledTrigger({
    now,
    recordRun: async (id, run) => persisted.push({ id, run }),
    publish: async () => {
      throw Object.assign(new Error('Gemini quota temporarily exhausted'), { status: 429 });
    }
  });

  assert.equal(result.results[0].retryQueued, true);
  assert.equal(persisted.at(-1).run.status, 'queued');
  assert.match(persisted.at(-1).run.reason, /retrying automatically/);
  assert.equal(persisted.at(-1).run.retryCount, 1);
  assert.ok(persisted.at(-1).run.nextAttemptAt > now);
  assert.ok(persisted.at(-1).run.nextAttemptAt <= new Date(now.getTime() + SCHEDULE_RETRY_BASE_MS + 1000));
});

test('routes due OMES channels to optimization instead of native video generation', async (t) => {
  const originalFind = ChannelProfile.find;
  const channelId = `UC${'m'.repeat(22)}`;
  let optimized = 0;
  let generated = 0;
  ChannelProfile.find = () => ({
    lean: async () => [{
      channelId,
      autoPublishEnabled: false,
      automation: {
        privacyStatus: 'private',
        omes: { enabled: true, frequency: 'daily', publishTimeIst: '11:00', lastOmesRunAt: null }
      }
    }]
  });
  t.after(() => { ChannelProfile.find = originalFind; });

  const result = await runScheduledTrigger({
    now: new Date('2026-11-18T05:30:00.000Z'),
    recordRun: async () => {},
    publish: async () => { generated += 1; },
    publishOmes: async (requestedChannelId) => {
      optimized += 1;
      assert.equal(requestedChannelId, channelId);
      return { videoId: 'manual-upload', title: 'Optimized metadata' };
    }
  });

  assert.equal(optimized, 1);
  assert.equal(generated, 0);
  assert.equal(result.published, true);
});

test('manual native publish refuses channels with OMES enabled', async (t) => {
  const originalFindOne = ChannelProfile.findOne;
  ChannelProfile.findOne = () => ({
    lean: async () => ({ channelId: 'UCchannel', automation: { omes: { enabled: true } } })
  });
  t.after(() => { ChannelProfile.findOne = originalFindOne; });

  await assert.rejects(publishNow('UCchannel'), {
    message: /OMES is enabled/,
    status: 409
  });
});

test('global render lock rejects a concurrent manual or scheduled job', async (t) => {
  const originalFindOneAndUpdate = AutomationLock.findOneAndUpdate;
  let occupied = false;
  AutomationLock.findOneAndUpdate = async (filter, update, options) => {
    assert.equal(filter.lockKey, 'GLOBAL_RENDER_WORKER');
    assert.equal(Object.hasOwn(filter, 'ownerChannelId'), false);
    assert.equal(options.upsert, true);
    if (occupied) {
      const error = new Error('Duplicate active lock.');
      error.code = 11000;
      throw error;
    }
    occupied = true;
    return { ownerChannelId: update.$set.ownerChannelId };
  };
  t.after(() => { AutomationLock.findOneAndUpdate = originalFindOneAndUpdate; });

  const locks = await Promise.all([
    acquireRenderLock('manual-channel'),
    acquireRenderLock('scheduled-channel')
  ]);
  assert.equal(locks.filter(Boolean).length, 1);
  assert.equal(locks.includes(false), true);
  assert.ok(RENDER_LOCK_TTL_MS >= 15 * 60 * 1000);
  assert.ok(RENDER_LOCK_HEARTBEAT_MS < RENDER_LOCK_TTL_MS);
});

test('recovers expired render locks and keeps a MongoDB TTL index as a cleanup backstop', async (t) => {
  const originalFindOneAndUpdate = AutomationLock.findOneAndUpdate;
  let observedFilter;
  AutomationLock.findOneAndUpdate = async (filter, update, options) => {
    observedFilter = filter;
    assert.ok(update.$set.expiresAt.getTime() > Date.now());
    assert.equal(options.upsert, true);
    return { ownerChannelId: 'recovered-channel' };
  };
  t.after(() => { AutomationLock.findOneAndUpdate = originalFindOneAndUpdate; });

  assert.equal(await acquireRenderLock('recovered-channel'), true);
  assert.ok(observedFilter.expiresAt.$lte instanceof Date);
  assert.ok(AutomationLock.schema.indexes().some(([keys, options]) =>
    keys.expiresAt === 1 && options.expireAfterSeconds === 0
  ));
});

test('returns the last scheduled failure and reason after process-local state is lost', async (t) => {
  const originalFindOne = ChannelProfile.findOne;
  const channelId = `UC${'w'.repeat(22)}`;
  ChannelProfile.findOne = () => ({
    select: (selection) => {
      assert.equal(selection, 'automation.lastRun');
      return {
        lean: async () => ({
          automation: {
            lastRun: {
              status: 'failed',
              source: 'scheduled',
              mode: 'auto-upload',
              stage: 'failed',
              failedAtStage: 'uploading',
              reason: 'YouTube quota exceeded.',
              title: 'Scheduled Short',
              startedAt: new Date('2026-11-18T10:00:00.000Z'),
              finishedAt: new Date('2026-11-18T10:02:00.000Z')
            }
          }
        })
      };
    }
  });
  t.after(() => { ChannelProfile.findOne = originalFindOne; });

  const status = await getPipelineStatus(channelId);

  assert.equal(status.stage, 'failed');
  assert.equal(status.reason, 'YouTube quota exceeded.');
  assert.equal(status.failedAtStage, 'uploading');
  assert.equal(status.lastVideoTitle, 'Scheduled Short');
  assert.equal(status.runStatus, 'failed');
});

test('aborts the active render when its heartbeat cannot renew the global lock', async (t) => {
  const originalUpdateOne = AutomationLock.updateOne;
  AutomationLock.updateOne = async () => ({ matchedCount: 0 });
  t.after(() => { AutomationLock.updateOne = originalUpdateOne; });

  const controller = new AbortController();
  assert.equal(await renewRenderLock('channel-a', controller), false);
  assert.equal(controller.signal.aborted, true);
  assert.match(controller.signal.reason.message, /lock was lost/);
});

test('publishes channel-scoped pipeline stages and preserves the generated video title', async () => {
  const channelId = `UC${'j'.repeat(22)}`;
  const otherChannelId = `UC${'k'.repeat(22)}`;
  const events = [];
  const unsubscribe = subscribeToPipelineStatus(channelId, (status) => events.push(status));
  const active = updatePipelineStatus(channelId, 'rendering', { lastVideoTitle: 'A new Short' });
  updatePipelineStatus(otherChannelId, 'uploading', { lastVideoTitle: 'Another Short' });
  const status = await getPipelineStatus(channelId);
  const otherStatus = await getPipelineStatus(otherChannelId);
  unsubscribe();

  assert.equal(active.channelId, channelId);
  assert.equal(active.stage, 'rendering');
  assert.equal(status.lastVideoTitle, 'A new Short');
  assert.equal(status.timestamp, active.timestamp);
  assert.equal(otherStatus.channelId, otherChannelId);
  assert.equal(otherStatus.lastVideoTitle, 'Another Short');
  assert.deepEqual(events.map((event) => event.stage), ['rendering']);
});
