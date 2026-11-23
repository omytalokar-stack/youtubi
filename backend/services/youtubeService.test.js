import assert from 'node:assert/strict';
import test from 'node:test';
import ChannelProfile from '../models/ChannelProfile.js';
import YouTubeCredential from '../models/YouTubeCredential.js';
import VideoLog from '../models/VideoLog.js';
import {
  buildShortUploadRequest, fetchAnalyticsMetrics, getCachedChannelStats, getChannelAuth, getChannelVideosHistory, hasCompletePublicMetadata,
  optimizeAndPublishLatestVideo, persistChannelStats, sanitizeYoutubeTags, updateChannelVideoMetadata
} from './youtubeService.js';

test('builds dashboard statistics from saved channel and video records', async (t) => {
  const originalProfileFindOne = ChannelProfile.findOne;
  const originalVideoFind = VideoLog.find;
  t.after(() => {
    ChannelProfile.findOne = originalProfileFindOne;
    VideoLog.find = originalVideoFind;
  });
  ChannelProfile.findOne = () => ({
    lean: async () => ({
      channelTitle: 'Saved channel',
      youtubeStats: {
        subscriberCount: 20, viewCount: 100, videoCount: 5, watchTimeMinutes: 45,
        syncedAt: new Date('2026-11-18T10:00:00.000Z')
      }
    })
  });
  VideoLog.find = () => ({
    sort() { return this; },
    limit() { return this; },
    lean: async () => [{
      videoId: 'video-a', title: 'Recent Short', publishedAt: new Date('2026-11-18T10:00:00.000Z'),
      views: 50, likes: 3, impressions: 120, ctr: 4.5,
      averageViewDuration: 18, retention: 72, watchTimeMinutes: 15
    }]
  });

  assert.deepEqual(await getCachedChannelStats('UCsaved'), {
    channel: { channelId: 'UCsaved', channelTitle: 'Saved channel', thumbnailUrl: '' },
    kpis: { views: 100, subscribers: 20, watchTimeMinutes: 45, videos: 5 },
    recentVideos: [{
      videoId: 'video-a', title: 'Recent Short', publishedAt: '2026-11-18T10:00:00.000Z',
      views: 50, likes: 3, watchTimeMinutes: 15, impressions: 120, ctr: 4.5,
      averageViewDuration: 18, retention: 72
    }]
  });
});

test('sanitizes YouTube tags and keeps their combined length under 450 characters', () => {
  const tags = sanitizeYoutubeTags([
    '#Shorts😀',
    '<Coffee> "garden"',
    'shorts',
    'x'.repeat(430),
    'y'.repeat(30),
    '',
    42
  ]);
  const tagLength = tags.reduce((length, tag) =>
    length + tag.length + (tag.includes(' ') ? 2 : 0), 0) + Math.max(0, tags.length - 1);

  assert.deepEqual(tags, ['Shorts', 'Coffee garden', 'y'.repeat(30)]);
  assert.ok(tagLength < 450);
  assert.deepEqual(buildShortUploadRequest({
    title: 'Title',
    description: 'Description',
    tags: ['#Shorts😀', '<Coffee> "garden"']
  }, 'private').requestBody.snippet.tags, ['Shorts', 'Coffee garden']);
  const boundaryTags = sanitizeYoutubeTags(['a'.repeat(449), 'b']);
  assert.deepEqual(boundaryTags, ['a'.repeat(449)]);
});

test('queries only supported per-video YouTube Analytics metrics', async () => {
  const queries = [];
  const metrics = await fetchAnalyticsMetrics('auth', 'UCchannel', ['video-1'], (options) => {
    assert.deepEqual(options, { version: 'v2', auth: 'auth' });
    return {
      reports: {
        query: async (params) => {
          queries.push(params);
          return { data: { rows: [['video-1', 18, 72, 15]] } };
        }
      }
    };
  });

  assert.equal(queries.length, 1);
  assert.equal(queries[0].metrics, 'averageViewDuration,averageViewPercentage,estimatedMinutesWatched');
  assert.doesNotMatch(queries[0].metrics, /impressions|impressionClickThroughRate/);
  assert.deepEqual(metrics.get('video-1'), {
    averageViewDuration: 18,
    retention: 72,
    watchTimeMinutes: 15
  });
});

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

test('reports per-channel missing OAuth scopes and incomplete refresh-token records', async (t) => {
  const originalFindOne = YouTubeCredential.findOne;
  t.after(() => { YouTubeCredential.findOne = originalFindOne; });

  YouTubeCredential.findOne = () => ({
    lean: async () => ({ channelId: 'UCupload', scopes: ['https://www.googleapis.com/auth/youtube.readonly'] })
  });
  await assert.rejects(getChannelAuth('UCupload', 'https://www.googleapis.com/auth/youtube.upload'), {
    status: 403,
    message: /video upload permission is missing/
  });

  YouTubeCredential.findOne = () => ({
    lean: async () => ({ channelId: 'UComes', scopes: ['https://www.googleapis.com/auth/youtube.upload'] })
  });
  await assert.rejects(getChannelAuth('UComes', 'https://www.googleapis.com/auth/youtube.force-ssl'), {
    status: 403,
    message: /video editing permission is missing/
  });

  YouTubeCredential.findOne = () => ({
    lean: async () => ({
      channelId: 'UCmissing-token',
      scopes: ['https://www.googleapis.com/auth/youtube.upload'],
      refreshToken: '',
      iv: '',
      authTag: ''
    })
  });
  await assert.rejects(getChannelAuth('UCmissing-token', 'https://www.googleapis.com/auth/youtube.upload'), {
    status: 401,
    message: /refresh token is incomplete/
  });
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
    tags: ['#topic😀', '<quoted> "tag"']
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
    tags: ['topic', 'quoted tag'],
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
