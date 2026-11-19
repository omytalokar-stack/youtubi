import assert from 'node:assert/strict';
import test from 'node:test';
import { getScheduleDueAt } from './queueWorkerService.js';

test('converts an IST channel schedule to the correct UTC due time', () => {
  const dueAt = getScheduleDueAt({
    automation: { scheduleHourIST: 10, scheduleMinuteIST: 15 }
  }, '2026-11-17');
  assert.equal(dueAt.toISOString(), '2026-11-17T04:45:00.000Z');
});
