import assert from 'node:assert/strict';
import test from 'node:test';
import ChannelProfile from '../models/ChannelProfile.js';
import VideoLog from '../models/VideoLog.js';
import {
  buildShortUploadRequest, getChannelVideosHistory, hasCompletePublicMetadata,
  optimizeAndPublishLatestVideo, persistChannelStats, updateChannelVideoMetadata
} from './youtubeService.js';

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

test('loads uploads playlist video metadata including private visibility and audience declarations', async () => {
  const calls = [];
  const history = await getChannelVideosHistory('UCchannel', 25, {
    getAuth: async (channelId, scope) => {
      assert.equal(channelId, 'UCchannel');
      assert.match(scope, /youtube\.force-ssl$/);
      return 'auth';
    },
    makeYouTube: (auth) => {
      assert.equal(auth, 'auth');
      return {
        channels: { list: async (params) => {
          calls.push(params);
          return { data: { items: [{ contentDetails: { relatedPlaylists: { uploads: 'uploads-id' } } }] } };
        } },
        playlistItems: { list: async (params) => {
          calls.push(params);
          return { data: { items: [{ contentDetails: { videoId: 'private-video' } }] } };
        } },
        videos: { list: async (params) => {
          calls.push(params);
          return { data: { items: [{
            id: 'private-video',
            snippet: { title: 'Manually uploaded', description: 'Details', tags: ['draft-topic'], categoryId: '27' },
            status: { privacyStatus: 'private', selfDeclaredMadeForKids: false },
            statistics: { viewCount: '42', likeCount: '3' }
          }] } };
        } }
      };
    }
  });

  assert.equal(calls[0].part[0], 'contentDetails');
  assert.equal(calls[1].playlistId, 'uploads-id');
  assert.deepEqual(calls[2].id, ['private-video']);
  assert.deepEqual(history[0], {
    videoId: 'private-video',
    title: 'Manually uploaded',
    description: 'Details',
    tags: ['draft-topic'],
    categoryId: '27',
    defaultLanguage: undefined,
    defaultAudioLanguage: undefined,
    publishedAt: '',
    privacyStatus: 'private',
    selfDeclaredMadeForKids: false,
    embeddable: undefined,
    license: undefined,
    publicStatsViewable: undefined,
    views: 42,
    likes: 3
  });
});

test('updates metadata and publishes while preserving the existing made-for-kids declaration', async () => {
  let updateRequest;
  await updateChannelVideoMetadata('UCchannel', {
    videoId: 'video-1',
    categoryId: '27',
    selfDeclaredMadeForKids: false,
    embeddable: true
  }, {
    title: 'Optimized title',
    description: 'Optimized description',
    tags: ['topic']
  }, {
    getAuth: async (_channelId, scope) => {
      assert.match(scope, /youtube\.force-ssl$/);
      return 'auth';
    },
    makeYouTube: () => ({ videos: { update: async (request) => { updateRequest = request; } } })
  });

  assert.deepEqual(updateRequest.part, ['snippet', 'status']);
  assert.deepEqual(updateRequest.requestBody.snippet, {
    title: 'Optimized title',
    description: 'Optimized description',
    tags: ['topic'],
    categoryId: '27'
  });
  assert.deepEqual(updateRequest.requestBody.status, {
    privacyStatus: 'public',
    selfDeclaredMadeForKids: false,
    embeddable: true
  });
});

test('credit-saver skips Gemini and update when the latest video is already optimized and public', async () => {
  let generated = false;
  let updated = false;
  let released = false;
  let savedRun;
  const result = await optimizeAndPublishLatestVideo('UCchannel', {
    findProfile: async () => ({ automation: { omes: { lastOptimizedVideoId: 'video-1' } } }),
    acquireLock: async () => true,
    releaseLock: async () => { released = true; },
    saveProfile: async (runAt, videoId) => { savedRun = { runAt, videoId }; },
    fetchHistory: async () => [{
      videoId: 'video-1',
      title: 'Complete title',
      description: 'Complete description',
      tags: ['topic'],
      privacyStatus: 'public'
    }],
    generateMetadata: async () => { generated = true; },
    updateVideo: async () => { updated = true; }
  });

  assert.equal(result.skipped, true);
  assert.match(result.reason, /already optimized/);
  assert.equal(generated, false);
  assert.equal(updated, false);
  assert.equal(released, true);
  assert.ok(savedRun.runAt instanceof Date);
  assert.equal(savedRun.videoId, 'video-1');
  assert.equal(hasCompletePublicMetadata({ title: 'Title', description: 'Description', tags: ['tag'], privacyStatus: 'public' }), true);
  assert.equal(hasCompletePublicMetadata({ title: 'Title', description: '', tags: ['tag'], privacyStatus: 'public' }), false);
});

test('records alternate-mode attempts when no uploaded video exists', async () => {
  let savedRun;
  const result = await optimizeAndPublishLatestVideo('UCchannel', {
    findProfile: async () => ({ automation: { omes: { lastOptimizedVideoId: null } } }),
    acquireLock: async () => true,
    releaseLock: async () => {},
    fetchHistory: async () => [],
    saveProfile: async (runAt, videoId) => { savedRun = { runAt, videoId }; },
    generateMetadata: async () => assert.fail('Gemini must not run without an uploaded video')
  });

  assert.equal(result.skipped, true);
  assert.match(result.reason, /No uploaded/);
  assert.ok(savedRun.runAt instanceof Date);
  assert.equal(savedRun.videoId, null);
});

test('optimizes and records audit details for the latest uploaded video', async () => {
  const auditRecords = [];
  const profileWrites = [];
  const videoWrites = [];
  let updatedVideo;
  const result = await optimizeAndPublishLatestVideo('UCchannel', {
    findProfile: async () => ({ metadataBlueprint: { coreTags: ['channel'] } }),
    acquireLock: async () => true,
    releaseLock: async () => {},
    fetchHistory: async () => [{
      videoId: 'video-2',
      title: 'Old title',
      description: 'Old description',
      tags: ['old'],
      privacyStatus: 'unlisted',
      views: 17,
      likes: 2
    }],
    generateMetadata: async () => ({ title: 'New title', description: 'New description', tags: ['channel', 'new'] }),
    updateVideo: async (_channelId, video, metadata) => { updatedVideo = { video, metadata }; },
    saveAudit: async (record) => { auditRecords.push(record); },
    saveProfile: async (date, videoId) => { profileWrites.push({ date, videoId }); },
    saveVideoLog: async (video, metadata) => { videoWrites.push({ video, metadata }); },
    pruneLogs: async () => {}
  });

  assert.equal(result.skipped, false);
  assert.equal(result.videoId, 'video-2');
  assert.equal(updatedVideo.metadata.title, 'New title');
  assert.equal(auditRecords[0].beforeTitle, 'Old title');
  assert.equal(auditRecords[0].afterTitle, 'New title');
  assert.equal(auditRecords[0].privacyAfter, 'public');
  assert.equal(profileWrites[0].videoId, 'video-2');
  assert.equal(videoWrites[0].metadata.tags.length, 2);
});
