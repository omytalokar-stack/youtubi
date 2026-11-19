import assert from 'node:assert/strict';
import { once } from 'node:events';
import express from 'express';
import test from 'node:test';
import { createAnalyticsRouter } from './analyticsRoutes.js';

const channelId = `UC${'a'.repeat(22)}`;

test('GET analytics syncs and returns statistics for only the requested channel', async () => {
  const calls = [];
  const stats = { channel: { channelId }, kpis: { views: 12 }, recentVideos: [] };
  const app = express();
  app.use('/api/analytics', createAnalyticsRouter({
    fetchStats: async (id) => { calls.push(id); return stats; }
  }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/analytics/${channelId}`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), stats);
    assert.deepEqual(calls, [channelId]);
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('POST analytics audit authenticates and syncs before auditing the same channel', async (t) => {
  const previousSecret = process.env.CRON_SECRET;
  process.env.CRON_SECRET = 'analytics-test-secret';
  const calls = [];
  const stats = { channel: { channelId }, kpis: { views: 12 }, recentVideos: [] };
  const audit = { learned: true, winningTactic: 'Use a direct opening.' };
  const app = express();
  app.use('/api/analytics', createAnalyticsRouter({
    fetchStats: async (id) => { calls.push(`stats:${id}`); return stats; },
    runAudit: async (id) => { calls.push(`audit:${id}`); return audit; }
  }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    if (previousSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previousSecret;
  });
  try {
    const url = `http://127.0.0.1:${server.address().port}/api/analytics/${channelId}/audit`;
    assert.equal((await fetch(url, { method: 'POST' })).status, 401);
    const response = await fetch(url, { method: 'POST', headers: { 'x-cron-secret': 'analytics-test-secret' } });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { audit, stats });
    assert.deepEqual(calls, [`stats:${channelId}`, `audit:${channelId}`]);
    assert.equal((await fetch(`http://127.0.0.1:${server.address().port}/api/analytics/not-a-channel/audit`, {
      method: 'POST', headers: { 'x-cron-secret': 'analytics-test-secret' }
    })).status, 400);
  } finally {
    server.close();
    await once(server, 'close');
  }
});
