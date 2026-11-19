import assert from 'node:assert/strict';
import { once } from 'node:events';
import express from 'express';
import test from 'node:test';
import ChannelProfile from '../models/ChannelProfile.js';
import channelRoutes from './channelRoutes.js';

test('new channel profiles default to an enabled 16:00 IST schedule', () => {
  const profile = new ChannelProfile({
    channelId: `UC${'d'.repeat(22)}`,
    channelTitle: 'Default schedule test'
  });
  assert.equal(profile.autoPublishEnabled, true);
  assert.equal(profile.publishTimeIst, '16:00');
  assert.equal(profile.lastAutoPublishedDateIst, '');
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
