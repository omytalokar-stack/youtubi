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
