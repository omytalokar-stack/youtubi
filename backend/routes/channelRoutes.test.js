import assert from 'node:assert/strict';
import { once } from 'node:events';
import express from 'express';
import test from 'node:test';
import ChannelProfile from '../models/ChannelProfile.js';
import YouTubeCredential from '../models/YouTubeCredential.js';
import channelRoutes from './channelRoutes.js';

test('new channel profiles default to an enabled 16:00 IST schedule', () => {
  const profile = new ChannelProfile({
    channelId: `UC${'d'.repeat(22)}`,
    channelTitle: 'Default schedule test'
  });
  assert.equal(profile.autoPublishEnabled, true);
  assert.equal(profile.publishTimeIst, '16:00');
  assert.equal(profile.lastAutoPublishedDateIst, '');
  assert.equal(profile.automation.omes.enabled, false);
  assert.equal(profile.automation.omes.frequency, 'daily');
  assert.equal(profile.automation.omes.publishTimeIst, '11:00');
  assert.equal(profile.automation.omes.lastOmesRunAt, null);
  assert.equal(profile.automation.omes.lastOptimizedVideoId, null);
  assert.equal(profile.automation.lastRun.status, 'idle');
  assert.equal(profile.validateSync(), undefined);
});

test('PATCH schedule validates channel IDs and updates only the targeted channel schedule', async (t) => {
  const originalFindOneAndUpdate = ChannelProfile.findOneAndUpdate;
  const channelId = `UC${'x'.repeat(22)}`;
  let updateCall;
  ChannelProfile.findOneAndUpdate = (filter, update, options) => {
    updateCall = { filter, update, options };
    return {
      lean: async () => ({
        channelId,
        autoPublishEnabled: false,
        publishTimeIst: '16:05',
        lastAutoPublishedDateIst: '',
        automation: { privacyStatus: 'private' }
      })
    };
  };
  t.after(() => { ChannelProfile.findOneAndUpdate = originalFindOneAndUpdate; });

  const app = express();
  app.use(express.json());
  app.use('/api', channelRoutes);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const apiUrl = `http://127.0.0.1:${server.address().port}/api`;
  try {
    const invalidId = await fetch(`${apiUrl}/channels/not-a-youtube-id/schedule`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ publishTimeIst: '16:00' })
    });
    assert.equal(invalidId.status, 400);

    const invalidTime = await fetch(`${apiUrl}/channels/${channelId}/schedule`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ publishTimeIst: '24:00' })
    });
    assert.equal(invalidTime.status, 400);

    const invalidEnabled = await fetch(`${apiUrl}/channels/${channelId}/schedule`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ autoPublishEnabled: 'true' })
    });
    assert.equal(invalidEnabled.status, 400);

    const extraScope = await fetch(`${apiUrl}/channels/${channelId}/schedule`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ autoPublishEnabled: true, channelId: `UC${'y'.repeat(22)}` })
    });
    assert.equal(extraScope.status, 400);
    assert.equal(updateCall, undefined);

    const response = await fetch(`${apiUrl}/channels/${channelId}/schedule`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ autoPublishEnabled: false, publishTimeIst: '16:05' })
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).profile.publishTimeIst, '16:05');
    assert.deepEqual(updateCall.filter, { channelId });
    assert.deepEqual(updateCall.update.$set, { autoPublishEnabled: false, publishTimeIst: '16:05' });
    assert.deepEqual(updateCall.options, { new: true, runValidators: true });
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('PUT profile persists the selected visibility only for its channel', async (t) => {
  const originalCredentialExists = YouTubeCredential.exists;
  const originalProfileExists = ChannelProfile.exists;
  const originalFindOneAndUpdate = ChannelProfile.findOneAndUpdate;
  const channelId = `UC${'p'.repeat(22)}`;
  let updateCall;
  YouTubeCredential.exists = async (filter) => filter.channelId === channelId;
  ChannelProfile.exists = async () => null;
  ChannelProfile.findOneAndUpdate = (filter, update, options) => {
    updateCall = { filter, update, options };
    return {
      lean: async () => ({
        channelId,
        channelTitle: 'Visibility test',
        automation: { privacyStatus: 'public', scheduleHourIST: 10, scheduleMinuteIST: 0 }
      })
    };
  };
  t.after(() => {
    YouTubeCredential.exists = originalCredentialExists;
    ChannelProfile.exists = originalProfileExists;
    ChannelProfile.findOneAndUpdate = originalFindOneAndUpdate;
  });

  const app = express();
  app.use(express.json());
  app.use('/api', channelRoutes);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const url = `http://127.0.0.1:${server.address().port}/api/profile/${channelId}`;
    const invalid = await fetch(url, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ automation: { privacyStatus: 'PUBLIC' } })
    });
    assert.equal(invalid.status, 400);
    assert.equal(updateCall, undefined);

    const response = await fetch(url, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ automation: { privacyStatus: 'public' } })
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.profile.automation.privacyStatus, 'public');
    assert.deepEqual(updateCall.filter, { channelId });
    assert.equal(updateCall.update.$set['automation.privacyStatus'], 'public');
    assert.deepEqual(updateCall.options, { new: true, runValidators: true });
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('OMES settings require the cron secret and update only validated per-channel options', async (t) => {
  const originalFindOneAndUpdate = ChannelProfile.findOneAndUpdate;
  const previousSecret = process.env.CRON_SECRET;
  const channelId = `UC${'o'.repeat(22)}`;
  let updateCall;
  process.env.CRON_SECRET = 'omes-test-secret';
  ChannelProfile.findOneAndUpdate = (filter, update, options) => {
    updateCall = { filter, update, options };
    return {
      lean: async () => ({ channelId, automation: { omes: { enabled: true, frequency: 'alternate', publishTimeIst: '11:20' } } })
    };
  };
  t.after(() => {
    ChannelProfile.findOneAndUpdate = originalFindOneAndUpdate;
    if (previousSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previousSecret;
  });

  const app = express();
  app.use(express.json());
  app.use('/api', channelRoutes);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const url = `http://127.0.0.1:${server.address().port}/api/channels/${channelId}/omes`;
    const unauthorized = await fetch(url, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true })
    });
    assert.equal(unauthorized.status, 401);

    const invalid = await fetch(url, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-cron-secret': 'omes-test-secret' },
      body: JSON.stringify({ frequency: 'weekly' })
    });
    assert.equal(invalid.status, 400);
    assert.equal(updateCall, undefined);

    const response = await fetch(url, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-cron-secret': 'omes-test-secret' },
      body: JSON.stringify({ enabled: true, frequency: 'alternate', publishTimeIst: '11:20' })
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).profile.automation.omes.enabled, true);
    assert.deepEqual(updateCall.filter, { channelId });
    assert.deepEqual(updateCall.update.$set, {
      'automation.omes.enabled': true,
      'automation.omes.frequency': 'alternate',
      'automation.omes.publishTimeIst': '11:20'
    });
  } finally {
    server.close();
    await once(server, 'close');
  }
});
