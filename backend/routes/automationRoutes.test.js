import assert from 'node:assert/strict';
import { once } from 'node:events';
import express from 'express';
import test from 'node:test';
import ChannelProfile from '../models/ChannelProfile.js';
import automationRoutes from './automationRoutes.js';

test('manual publish acknowledges immediately and reports background failures', async () => {
  const originalFindOne = ChannelProfile.findOne;
  const originalConsoleError = console.error;
  let backgroundFailure;
  const failed = new Promise((resolve) => { backgroundFailure = resolve; });
  ChannelProfile.findOne = () => ({ lean: async () => { throw new Error('simulated publish failure'); } });
  console.error = (...args) => backgroundFailure(args);

  const app = express();
  app.use('/api/automation', automationRoutes);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/automation/publish/channel-123`, {
      method: 'POST'
    });
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), {
      accepted: true,
      channelId: 'channel-123',
      message: 'Native Short generation and publishing started.'
    });
    const [message, error] = await failed;
    assert.match(message, /Background publish failed for channel-123/);
    assert.match(error.message, /simulated publish failure/);
  } finally {
    server.close();
    await once(server, 'close');
    ChannelProfile.findOne = originalFindOne;
    console.error = originalConsoleError;
  }
});

test('GET trigger accepts cron-job.org webhooks with the configured cron secret', async (t) => {
  const originalFind = ChannelProfile.find;
  const previousSecret = process.env.CRON_SECRET;
  process.env.CRON_SECRET = 'test-cron-secret';
  let markTriggerStarted;
  const triggerStarted = new Promise((resolve) => { markTriggerStarted = resolve; });
  ChannelProfile.find = () => {
    markTriggerStarted();
    return { lean: async () => [] };
  };
  t.after(() => {
    ChannelProfile.find = originalFind;
    if (previousSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previousSecret;
  });

  const app = express();
  app.use('/api/automation', automationRoutes);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const url = `http://127.0.0.1:${server.address().port}/api/automation/trigger`;
    const unauthorized = await fetch(url);
    assert.equal(unauthorized.status, 401);

    const response = await fetch(url, { headers: { 'x-cron-secret': 'test-cron-secret' } });
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { accepted: true, message: 'Scheduled upload check started.' });
    await triggerStarted;
  } finally {
    server.close();
    await once(server, 'close');
  }
});
