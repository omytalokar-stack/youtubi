import assert from 'node:assert/strict';
import test from 'node:test';
import ChannelProfile from '../models/ChannelProfile.js';
import VideoLog from '../models/VideoLog.js';
import { buildShortUploadRequest, persistChannelStats } from './youtubeService.js';

test('persists channel KPIs and recent video analytics in the matching channel scope', async (t) => {
  const originalProfileUpdate = ChannelProfile.findOneAndUpdate;
  const originalVideoBulkWrite = VideoLog.bulkWrite;
  const channelId = `UC${'s'.repeat(22)}`;
  let profileWrite;
  let videoWrite;
  ChannelProfile.findOneAndUpdate = async (...args) => {
    profileWrite = args;
    return { channelId };
  };
  VideoLog.bulkWrite = async (operations) => { videoWrite = operations; };
  t.after(() => {
    ChannelProfile.findOneAndUpdate = originalProfileUpdate;
    VideoLog.bulkWrite = originalVideoBulkWrite;
  });

  await persistChannelStats(channelId, {
    kpis: { views: 100, subscribers: 20, videos: 5, watchTimeMinutes: 45 },
    recentVideos: [{
      videoId: 'video-a', title: 'Recent Short', publishedAt: '2026-11-18T10:00:00.000Z',
      views: 50, likes: 3, impressions: 120, ctr: 4.5,
      averageViewDuration: 18, retention: 72, watchTimeMinutes: 15
    }]
  });

  assert.deepEqual(profileWrite[0], { channelId });
  assert.deepEqual(profileWrite[1].$set.youtubeStats, {
    subscriberCount: 20, viewCount: 100, videoCount: 5, watchTimeMinutes: 45,
    syncedAt: profileWrite[1].$set.youtubeStats.syncedAt
  });
  assert.ok(profileWrite[1].$set.youtubeStats.syncedAt instanceof Date);
  assert.deepEqual(videoWrite[0].updateOne.filter, { channelId, videoId: 'video-a' });
  assert.equal(videoWrite[0].updateOne.update.$set.ctr, 4.5);
  assert.equal(videoWrite[0].updateOne.update.$set.retention, 72);
});

test('keeps the saved visibility unchanged in every YouTube upload request', () => {
  const metadata = { title: 'Channel Short', description: 'Description', tags: ['shorts'] };
  for (const privacyStatus of ['public', 'private', 'unlisted']) {
    const request = buildShortUploadRequest(metadata, privacyStatus);
    assert.equal(request.requestBody.status.privacyStatus, privacyStatus);
    assert.deepEqual(request.part, ['snippet', 'status']);
  }
  assert.throws(() => buildShortUploadRequest(metadata, 'PUBLIC'), /Unsupported YouTube privacy status/);
});
