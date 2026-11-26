import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';
import ChannelProfile from '../models/ChannelProfile.js';
import YouTubeCredential from '../models/YouTubeCredential.js';
import VideoLog from '../models/VideoLog.js';
import {
  buildShortUploadRequest, fetchAnalyticsMetrics, fetchOmesVideoContext, getCachedChannelStats, getChannelAuth, getChannelVideosHistory, hasCompletePublicMetadata,
  optimizeAndPublishLatestVideo, persistChannelStats, sanitizeYoutubeTags, updateChannelVideoMetadata
} from './youtubeService.js';

function makeThumbnailResponse(bytes = Buffer.from('thumbnail bytes')) {
  return {
    ok: true,
    status: 200,
    headers: { get: (name) => name === 'content-type' ? 'image/jpeg' : null },
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  };
}

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
  assert.deepEqual(sanitizeYoutubeTags(['A😀B', '#हिन्दी!!', 'under_score']), [
    'A B', 'हिन्दी', 'under score'
  ]);
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
            snippet: {
              title: 'Manually uploaded', description: 'Details', tags: ['draft-topic'], categoryId: '27',
              thumbnails: { high: { url: 'https://i.ytimg.com/vi/private-video/hqdefault.jpg' } }
            },
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
    thumbnailUrl: 'https://i.ytimg.com/vi/private-video/hqdefault.jpg',
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

test('loads both private and unlisted items from the authenticated uploads playlist', async () => {
  const history = await getChannelVideosHistory('UCchannel', 2, {
    getAuth: async (_channelId, scope) => {
      assert.match(scope, /youtube\.force-ssl$/);
      return 'owner-auth';
    },
    makeYouTube: () => ({
      channels: { list: async () => ({
        data: { items: [{ contentDetails: { relatedPlaylists: { uploads: 'uploads-id' } } }] }
      }) },
      playlistItems: { list: async (params) => {
        assert.equal(params.playlistId, 'uploads-id');
        return { data: { items: [
          { contentDetails: { videoId: 'private-video' } },
          { contentDetails: { videoId: 'unlisted-video' } }
        ] } };
      } },
      videos: { list: async (params) => {
        assert.deepEqual(params.id, ['private-video', 'unlisted-video']);
        return { data: { items: [
          { id: 'private-video', status: { privacyStatus: 'private' } },
          { id: 'unlisted-video', status: { privacyStatus: 'unlisted' } }
        ] } };
      } }
    })
  });

  assert.deepEqual(history.map((video) => video.privacyStatus), ['private', 'unlisted']);
});

test('extracts an available owner caption track and downloads the thumbnail image context', async () => {
  const calls = [];
  const context = await fetchOmesVideoContext('UCchannel', {
    videoId: 'private-video',
    privacyStatus: 'private',
    defaultAudioLanguage: 'en',
    thumbnailUrl: 'https://i.ytimg.com/vi/private-video/maxresdefault.jpg'
  }, {
    getAuth: async (channelId, scope) => {
      assert.equal(channelId, 'UCchannel');
      assert.match(scope, /youtube\.force-ssl$/);
      return 'auth';
    },
    makeYouTube: () => ({
      captions: {
        list: async (params) => {
          calls.push({ method: 'list', params });
          return { data: { items: [{ id: 'caption-track', snippet: { status: 'serving', language: 'en' } }] } };
        },
        download: async (params, options) => {
          calls.push({ method: 'download', params, options });
          return { data: Readable.from([Buffer.from('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHello <c>world</c>!')]) };
        }
      }
    }),
    fetchImage: async (url) => {
      assert.equal(url, 'https://i.ytimg.com/vi/private-video/maxresdefault.jpg');
      return makeThumbnailResponse();
    }
  });

  assert.deepEqual(calls[0], {
    method: 'list',
    params: { part: ['snippet'], videoId: 'private-video' }
  });
  assert.deepEqual(calls[1], {
    method: 'download',
    params: { id: 'caption-track', tfmt: 'vtt' },
    options: { responseType: 'stream' }
  });
  assert.equal(context.transcript, 'Hello world!');
  assert.deepEqual(context.thumbnail, {
    mimeType: 'image/jpeg',
    data: Buffer.from('thumbnail bytes').toString('base64')
  });
});

test('continues with thumbnail context when the caption track is still syncing', async () => {
  let downloaded = false;
  const context = await fetchOmesVideoContext('UCchannel', {
    videoId: 'unlisted-video',
    privacyStatus: 'unlisted',
    thumbnailUrl: 'https://i.ytimg.com/vi/unlisted-video/hqdefault.jpg'
  }, {
    getAuth: async () => 'auth',
    makeYouTube: () => ({
      captions: {
        list: async () => ({
          data: { items: [{ id: 'pending-track', snippet: { status: 'syncing' } }] }
        }),
        download: async () => { downloaded = true; throw new Error('Pending captions must not be downloaded.'); }
      }
    }),
    fetchImage: async () => makeThumbnailResponse()
  });

  assert.equal(downloaded, false);
  assert.equal(context.transcript, '');
  assert.equal(context.thumbnail.mimeType, 'image/jpeg');
});

test('continues with thumbnail context when YouTube reports that captions are processing', async () => {
  const context = await fetchOmesVideoContext('UCchannel', {
    videoId: 'private-video',
    privacyStatus: 'private',
    thumbnailUrl: 'https://i.ytimg.com/vi/private-video/hqdefault.jpg'
  }, {
    getAuth: async () => 'auth',
    makeYouTube: () => ({
      captions: {
        list: async () => {
          throw Object.assign(new Error('Caption track is still processing.'), { code: 409 });
        }
      }
    }),
    fetchImage: async () => makeThumbnailResponse()
  });

  assert.equal(context.transcript, '');
  assert.equal(context.thumbnail.mimeType, 'image/jpeg');
});

test('uses caption and thumbnail context for public OMES videos', async () => {
  const context = await fetchOmesVideoContext('UCchannel', {
    videoId: 'public-video',
    privacyStatus: 'public',
    thumbnailUrl: 'https://i.ytimg.com/vi/public-video/hqdefault.jpg'
  }, {
    getAuth: async () => 'auth',
    makeYouTube: () => ({
      captions: {
        list: async () => ({ data: { items: [] } })
      }
    }),
    fetchImage: async () => makeThumbnailResponse()
  });

  assert.equal(context.transcript, '');
  assert.equal(context.thumbnail.mimeType, 'image/jpeg');
});

test('continues OMES editing when the thumbnail request fails', async () => {
  const context = await fetchOmesVideoContext('UCchannel', {
    videoId: 'public-video',
    privacyStatus: 'public',
    thumbnailUrl: 'https://i.ytimg.com/vi/public-video/hqdefault.jpg'
  }, {
    getAuth: async () => 'auth',
    makeYouTube: () => ({
      captions: {
        list: async () => ({ data: { items: [] } })
      }
    }),
    fetchImage: async () => ({ ok: false })
  });

  assert.equal(context.transcript, '');
  assert.equal(context.thumbnail, null);
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
  let generatedWithContext;
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
    fetchVideoContext: async () => ({
      transcript: 'The video describes this story.',
      thumbnail: { mimeType: 'image/jpeg', data: 'aW1hZ2U=' }
    }),
    generateMetadata: async (_video, _history, _profile, context) => {
      generatedWithContext = context;
      return { title: 'New title', description: 'New description', tags: ['channel', 'new'] };
    },
    updateVideo: async (_channelId, video, metadata) => { updatedVideo = { video, metadata }; },
    saveAudit: async (record) => { auditRecords.push(record); },
    saveProfile: async (date, videoId) => { profileWrites.push({ date, videoId }); },
    saveVideoLog: async (video, metadata) => { videoWrites.push({ video, metadata }); },
    pruneLogs: async () => {}
  });

  assert.equal(result.skipped, false);
  assert.equal(result.videoId, 'video-2');
  assert.equal(updatedVideo.metadata.title, 'New title');
  assert.deepEqual(generatedWithContext, {
    transcript: 'The video describes this story.',
    thumbnail: { mimeType: 'image/jpeg', data: 'aW1hZ2U=' }
  });
  assert.equal(auditRecords[0].beforeTitle, 'Old title');
  assert.equal(auditRecords[0].afterTitle, 'New title');
  assert.equal(auditRecords[0].privacyAfter, 'public');
  assert.equal(profileWrites[0].videoId, 'video-2');
  assert.equal(videoWrites[0].metadata.tags.length, 2);
});

test('does not let lastOptimizedVideoId suppress a private or unlisted latest video', async () => {
  let generated = false;
  let updated = false;
  let savedVideoId;
  const result = await optimizeAndPublishLatestVideo('UCchannel', {
    findProfile: async () => ({ automation: { omes: { lastOptimizedVideoId: 'video-1' } } }),
    acquireLock: async () => true,
    releaseLock: async () => {},
    fetchHistory: async () => [{
      videoId: 'video-1',
      title: 'Private draft',
      description: 'Draft description',
      tags: ['draft'],
      privacyStatus: 'unlisted'
    }],
    fetchVideoContext: async () => ({ transcript: '', thumbnail: null }),
    generateMetadata: async () => {
      generated = true;
      return { title: 'Optimized draft', description: 'Updated description', tags: ['updated'] };
    },
    updateVideo: async () => { updated = true; },
    saveProfile: async (_runAt, videoId) => { savedVideoId = videoId; },
    saveAudit: async () => {},
    saveVideoLog: async () => {},
    pruneLogs: async () => {}
  });

  assert.equal(result.skipped, false);
  assert.equal(generated, true);
  assert.equal(updated, true);
  assert.equal(savedVideoId, 'video-1');
});
