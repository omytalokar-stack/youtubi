import assert from 'node:assert/strict';
import test from 'node:test';
import AutomationLock from '../models/AutomationLock.js';
import {
  acquireRenderLock, getScheduleDueAt, renewRenderLock,
  RENDER_LOCK_HEARTBEAT_MS, RENDER_LOCK_TTL_MS
} from './queueWorkerService.js';

test('converts an IST channel schedule to the correct UTC due time', () => {
  const dueAt = getScheduleDueAt({
    automation: { scheduleHourIST: 10, scheduleMinuteIST: 15 }
  }, '2026-11-17');
  assert.equal(dueAt.toISOString(), '2026-11-17T04:45:00.000Z');
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
