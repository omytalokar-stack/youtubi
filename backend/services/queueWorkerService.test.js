import assert from 'node:assert/strict';
import test from 'node:test';
import { getHisaFallbackWindowMs, getScheduleDueAt } from './queueWorkerService.js';

test('uses the documented Hisa fallback window and validates overrides', () => {
  const previousWindow = process.env.HISA_FALLBACK_WINDOW_MINUTES;
  try {
    delete process.env.HISA_FALLBACK_WINDOW_MINUTES;
    assert.equal(getHisaFallbackWindowMs(), 15 * 60 * 1000);

    process.env.HISA_FALLBACK_WINDOW_MINUTES = '30';
    assert.equal(getHisaFallbackWindowMs(), 30 * 60 * 1000);

    process.env.HISA_FALLBACK_WINDOW_MINUTES = '0';
    assert.throws(() => getHisaFallbackWindowMs(), /integer from 1 to 1440/);
  } finally {
    if (previousWindow === undefined) delete process.env.HISA_FALLBACK_WINDOW_MINUTES;
    else process.env.HISA_FALLBACK_WINDOW_MINUTES = previousWindow;
  }
});

test('converts an IST channel schedule to the correct UTC due time', () => {
  const dueAt = getScheduleDueAt({
    automation: { scheduleHourIST: 10, scheduleMinuteIST: 15 }
  }, '2026-11-17');
  assert.equal(dueAt.toISOString(), '2026-11-17T04:45:00.000Z');
});
