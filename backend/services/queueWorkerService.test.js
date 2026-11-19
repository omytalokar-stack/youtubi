import assert from 'node:assert/strict';
import test from 'node:test';
import AutomationLock from '../models/AutomationLock.js';
import ChannelProfile from '../models/ChannelProfile.js';
import {
  acquireRenderLock, getIstSchedule, isChannelDueForSchedule, renewRenderLock,
  getPipelineStatus, RENDER_LOCK_HEARTBEAT_MS, RENDER_LOCK_TTL_MS, recordPublishedDate,
  runScheduledTrigger, subscribeToPipelineStatus, updatePipelineStatus,
  SCHEDULE_WINDOW_MINUTES
} from './queueWorkerService.js';

test('matches channel schedules only at or within the 25-minute IST window', () => {
  const current = getIstSchedule(new Date('2026-11-18T10:30:00.000Z'));
  const profile = {
    autoPublishEnabled: true,
    publishTimeIst: '16:00',
    lastAutoPublishedDateIst: ''
  };
  assert.deepEqual(current, { todayIst: '2026-11-18', timeIst: '16:00' });
  assert.equal(SCHEDULE_WINDOW_MINUTES, 25);
  assert.equal(isChannelDueForSchedule(profile, current), true);
  assert.equal(isChannelDueForSchedule(profile, { ...current, timeIst: '16:25' }), true);
  assert.equal(isChannelDueForSchedule(profile, { ...current, timeIst: '16:26' }), false);
  assert.equal(isChannelDueForSchedule(profile, { ...current, timeIst: '15:59' }), false);
  assert.equal(isChannelDueForSchedule({ ...profile, autoPublishEnabled: undefined }, current), false);
});

test('does not reschedule a channel already published on the current IST date', () => {
  const current = { todayIst: '2026-11-18', timeIst: '16:00' };
  assert.equal(isChannelDueForSchedule({
    autoPublishEnabled: true,
    publishTimeIst: '16:00',
    lastAutoPublishedDateIst: current.todayIst
  }, current), false);
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
