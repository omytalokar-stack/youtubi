import assert from 'node:assert/strict';
import { once } from 'node:events';
import express from 'express';
import test from 'node:test';
import AutomationLock from '../models/AutomationLock.js';
import ChannelProfile from '../models/ChannelProfile.js';
import { getIstSchedule, updatePipelineStatus } from '../services/queueWorkerService.js';
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
  const originalConsoleInfo = console.info;
  const previousSecret = process.env.CRON_SECRET;
  process.env.CRON_SECRET = 'test-cron-secret';
  let markTriggerStarted;
  let markTriggerCompleted;
  const triggerStarted = new Promise((resolve) => { markTriggerStarted = resolve; });
  const triggerCompleted = new Promise((resolve) => { markTriggerCompleted = resolve; });
  ChannelProfile.find = () => {
    markTriggerStarted();
    return { lean: async () => [] };
  };
  console.info = (...args) => {
    if (args[0] === 'Scheduled trigger completed:') markTriggerCompleted(args[1]);
  };
  t.after(() => {
    ChannelProfile.find = originalFind;
    console.info = originalConsoleInfo;
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
    assert.deepEqual(await response.json(), {
      accepted: true,
      queuedChannels: 0,
      message: 'Due channel run states saved; scheduled processing started.'
    });
    await triggerStarted;
    assert.equal((await triggerCompleted).published, false);
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('persists all due channel states before acknowledging the cron trigger', async (t) => {
  const originals = {
    find: ChannelProfile.find,
    updateOne: ChannelProfile.updateOne,
    exists: ChannelProfile.exists,
    lock: AutomationLock.findOneAndUpdate,
    info: console.info,
    secret: process.env.CRON_SECRET
  };
  const channelId = `UC${'q'.repeat(22)}`;
  const schedule = getIstSchedule();
  const [hour, minute] = schedule.timeIst.split(':').map(Number);
  const scheduleMinutes = Math.max(0, hour * 60 + minute - 2);
  const publishTimeIst = `${String(Math.floor(scheduleMinutes / 60)).padStart(2, '0')}:${String(scheduleMinutes % 60).padStart(2, '0')}`;
  const writes = [];
  let markCompleted;
  const completed = new Promise((resolve) => { markCompleted = resolve; });
  process.env.CRON_SECRET = 'queue-before-ack-secret';
  ChannelProfile.find = () => ({
    lean: async () => [{
      channelId,
      autoPublishEnabled: true,
      publishTimeIst,
      lastAutoPublishedDateIst: '',
      automation: { privacyStatus: 'private', omes: { enabled: false } }
    }]
  });
  ChannelProfile.updateOne = async (filter, update) => {
    writes.push({ filter, update });
    return { matchedCount: 1 };
  };
  ChannelProfile.exists = async () => ({ _id: 'profile' });
  AutomationLock.findOneAndUpdate = async () => null;
  console.info = (...args) => {
    if (args[0] === 'Scheduled trigger completed:') markCompleted(args[1]);
  };
  t.after(() => {
    ChannelProfile.find = originals.find;
    ChannelProfile.updateOne = originals.updateOne;
    ChannelProfile.exists = originals.exists;
    AutomationLock.findOneAndUpdate = originals.lock;
    console.info = originals.info;
    if (originals.secret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = originals.secret;
  });

  const app = express();
  app.use('/api/automation', automationRoutes);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/automation/trigger`, {
      headers: { 'x-cron-secret': 'queue-before-ack-secret' }
    });
    assert.equal(response.status, 202);
    assert.equal(writes[0].filter.channelId, channelId);
    assert.equal(writes[0].update.$set['automation.lastRun.status'], 'queued');
    assert.equal((await response.json()).queuedChannels, 1);
    const result = await completed;
    assert.equal(result.results[0].reason, 'Another channel is rendering or uploading.');
    assert.equal(writes.at(-1).update.$set['automation.lastRun.status'], 'queued');

    const status = await fetch(`http://127.0.0.1:${server.address().port}/api/automation/status/${channelId}`);
    const statusBody = await status.json();
    assert.equal(statusBody.runStatus, 'queued');
    assert.equal(statusBody.reason, 'Another channel is rendering or uploading.');
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('channel status is isolated and its event stream emits later stage changes', async (t) => {
  const originalExists = ChannelProfile.exists;
  const channelId = `UC${'r'.repeat(22)}`;
  ChannelProfile.exists = async () => ({ _id: 'profile' });
  t.after(() => { ChannelProfile.exists = originalExists; });
  updatePipelineStatus(channelId, 'writing', { lastVideoTitle: 'Scoped Short' });

  const app = express();
  app.use('/api/automation', automationRoutes);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}/api/automation`;
    const invalid = await fetch(`${baseUrl}/status/not-a-channel`);
    assert.equal(invalid.status, 400);

    const response = await fetch(`${baseUrl}/status/${channelId}`);
    const status = await response.json();
    assert.equal(status.channelId, channelId);
    assert.equal(status.stage, 'writing');
    assert.equal(status.lastVideoTitle, 'Scoped Short');
    assert.ok(status.timestamp);

    const eventResponse = await fetch(`${baseUrl}/events/${channelId}`);
    assert.match(eventResponse.headers.get('content-type'), /text\/event-stream/);
    const reader = eventResponse.body.getReader();
    const initial = await reader.read();
    assert.match(new TextDecoder().decode(initial.value), /"stage":"writing"/);
    const nextEvent = reader.read();
    updatePipelineStatus(channelId, 'uploading', { lastVideoTitle: 'Scoped Short' });
    assert.match(new TextDecoder().decode((await nextEvent).value), /"stage":"uploading"/);
    await reader.cancel();
  } finally {
    server.close();
    await once(server, 'close');
  }
});
