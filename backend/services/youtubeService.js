import { google } from 'googleapis';
import YouTubeCredential from '../models/YouTubeCredential.js';
import ChannelProfile from '../models/ChannelProfile.js';
import BrainMemory from '../models/BrainMemory.js';
import { decryptToken, encryptToken, signOAuthState } from './cryptoService.js';

function createOAuthClient() {
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, OAUTH_REDIRECT_URI } = process.env;
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !OAUTH_REDIRECT_URI) throw new Error('Google OAuth environment settings are incomplete.');
  return new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, OAUTH_REDIRECT_URI);
}

function scopes() {
  return (process.env.YOUTUBE_SCOPES || 'https://www.googleapis.com/auth/youtube.upload,https://www.googleapis.com/auth/youtube.readonly,https://www.googleapis.com/auth/yt-analytics.readonly')
    .split(',').map((scope) => scope.trim()).filter(Boolean);
}

async function ensureChannelDocuments(channelId, channelTitle) {
  if (!await ChannelProfile.exists({ channelId })) {
    let profile;
    for (let attempt = 0; attempt < 5 && !profile; attempt += 1) {
      const profiles = await ChannelProfile.find({}).select('automation.scheduleHourIST automation.scheduleMinuteIST').lean();
      const occupied = new Set(profiles.map((item) => `${item.automation.scheduleHourIST}:${item.automation.scheduleMinuteIST}`));
      const firstSlot = 10 * 60;
      let slot = -1;
      for (let offset = 0; offset < 1440; offset += 1) {
        const minuteOfDay = (firstSlot + offset) % 1440;
        if (!occupied.has(`${Math.floor(minuteOfDay / 60)}:${minuteOfDay % 60}`)) {
          slot = minuteOfDay;
          break;
        }
      }
      if (slot < 0) throw new Error('All 1,440 IST minute schedule slots are assigned. Free a slot before adding another channel.');
      try {
        profile = await ChannelProfile.create({
          channelId, channelTitle,
          automation: { scheduleHourIST: Math.floor(slot / 60), scheduleMinuteIST: slot % 60 }
        });
      } catch (error) {
        if (error.code !== 11000) throw error;
      }
    }
    if (!profile) throw new Error('Could not reserve a unique IST schedule slot after several attempts.');
  }
  await BrainMemory.findOneAndUpdate(
    { channelId }, { $setOnInsert: { channelId } }, { upsert: true, new: true }
  );
}

export function getAuthorizationUrl() {
  const oauth2 = createOAuthClient();
  return oauth2.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent select_account',
    scope: scopes(),
    state: signOAuthState({ purpose: 'youtube-connect' })
  });
}

export async function connectYouTubeAccount(code) {
  const oauth2 = createOAuthClient();
  const { tokens } = await oauth2.getToken(code);
  if (!tokens.refresh_token) throw new Error('Google did not return a refresh token. Revoke the app grant and connect again.');
  oauth2.setCredentials(tokens);
  const youtube = google.youtube({ version: 'v3', auth: oauth2 });
  const response = await youtube.channels.list({ part: ['snippet'], mine: true, maxResults: 50 });
  const channels = response.data.items || [];
  for (const channel of channels) {
    const channelId = channel.id;
    const encrypted = encryptToken(tokens.refresh_token);
    const channelTitle = channel.snippet?.title || channelId;
    await YouTubeCredential.findOneAndUpdate({ channelId }, {
      channelId, channelTitle, thumbnailUrl: channel.snippet?.thumbnails?.default?.url || '',
      ...encrypted, scopes: tokens.scope?.split(' ') || scopes()
    }, { upsert: true, new: true, runValidators: true });
    await ensureChannelDocuments(channelId, channelTitle);
  }
  return channels.map((channel) => ({
    channelId: channel.id,
    channelTitle: channel.snippet?.title || channel.id,
    thumbnailUrl: channel.snippet?.thumbnails?.default?.url || ''
  }));
}

export async function getChannelAuth(channelId) {
  const credential = await YouTubeCredential.findOne({ channelId }).lean();
  if (!credential) throw new Error(`YouTube channel ${channelId} is not connected.`);
  const oauth2 = createOAuthClient();
  oauth2.setCredentials({ refresh_token: decryptToken(credential) });
  return oauth2;
}

export async function listConnectedChannels() {
  return YouTubeCredential.find({}).select('channelId channelTitle thumbnailUrl').sort({ channelTitle: 1 }).lean();
}

export async function getChannelStats(channelId) {
  const auth = await getChannelAuth(channelId);
  const youtube = google.youtube({ version: 'v3', auth });
  const [channelResponse, videoResponse] = await Promise.all([
    youtube.channels.list({ part: ['statistics', 'snippet'], id: [channelId] }),
    youtube.search.list({ part: ['snippet'], channelId, type: ['video'], order: 'date', maxResults: 10 })
  ]);
  const channel = channelResponse.data.items?.[0];
  if (!channel) throw new Error(`YouTube returned no channel for ${channelId}.`);
  const videoIds = (videoResponse.data.items || []).map((video) => video.id?.videoId).filter(Boolean);
  const details = videoIds.length ? await youtube.videos.list({ part: ['statistics', 'snippet'], id: videoIds }) : { data: { items: [] } };
  const analytics = google.youtubeAnalytics({ version: 'v2', auth });
  let watchTimeMinutes = 0;
  const watchByVideo = new Map();
  try {
    const end = new Date();
    const start = new Date(end.getTime() - 28 * 86400000);
    const dateString = (date) => date.toISOString().slice(0, 10);
    const report = await analytics.reports.query({
      ids: 'channel==MINE', startDate: dateString(start), endDate: dateString(end),
      metrics: 'estimatedMinutesWatched'
    });
    watchTimeMinutes = Number(report.data.rows?.[0]?.[0] || 0);
    if (videoIds.length) {
      const videoReport = await analytics.reports.query({
        ids: 'channel==MINE', startDate: dateString(start), endDate: dateString(end),
        dimensions: 'video', metrics: 'estimatedMinutesWatched', filters: `video==${videoIds.join(',')}`
      });
      (videoReport.data.rows || []).forEach(([id, minutes]) => watchByVideo.set(id, Number(minutes)));
    }
  } catch (error) {
    if (error.code !== 403 && error.code !== 400) throw error;
    console.warn(`YouTube Analytics unavailable for ${channelId}: ${error.message}`);
  }
  return {
    channel: { channelId, channelTitle: channel.snippet?.title, thumbnailUrl: channel.snippet?.thumbnails?.default?.url || '' },
    kpis: {
      views: Number(channel.statistics?.viewCount || 0),
      subscribers: Number(channel.statistics?.subscriberCount || 0),
      watchTimeMinutes,
      videos: Number(channel.statistics?.videoCount || 0)
    },
    recentVideos: (details.data.items || []).map((video) => ({
      videoId: video.id, title: video.snippet?.title || '', publishedAt: video.snippet?.publishedAt || '',
      views: Number(video.statistics?.viewCount || 0), likes: Number(video.statistics?.likeCount || 0),
      watchTimeMinutes: watchByVideo.get(video.id) || 0
    }))
  };
}

export async function fetchVideoAnalytics(channelId, videoIds) {
  const auth = await getChannelAuth(channelId);
  const youtube = google.youtube({ version: 'v3', auth });
  const response = await youtube.videos.list({ part: ['statistics'], id: videoIds });
  const byId = new Map((response.data.items || []).map((item) => [item.id, item.statistics || {}]));
  const analytics = google.youtubeAnalytics({ version: 'v2', auth });
  const endDate = new Date().toISOString().slice(0, 10);
  const startDate = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
  let watchByVideo = new Map();
  try {
    const report = await analytics.reports.query({
      ids: 'channel==MINE', startDate, endDate, dimensions: 'video',
      metrics: 'estimatedMinutesWatched', filters: `video==${videoIds.join(',')}`
    });
    watchByVideo = new Map((report.data.rows || []).map(([id, minutes]) => [id, Number(minutes)]));
  } catch (error) {
    if (error.code !== 403 && error.code !== 400) throw error;
    console.warn(`Per-video watch-time unavailable for ${channelId}: ${error.message}`);
  }
  return videoIds.map((videoId) => ({
    videoId,
    views: Number(byId.get(videoId)?.viewCount || 0),
    likes: Number(byId.get(videoId)?.likeCount || 0),
    watchTimeMinutes: watchByVideo.get(videoId) || 0
  }));
}

export async function uploadShort(channelId, filePath, metadata, privacyStatus) {
  const auth = await getChannelAuth(channelId);
  const youtube = google.youtube({ version: 'v3', auth });
  const response = await youtube.videos.insert({
    part: ['snippet', 'status'],
    requestBody: {
      snippet: {
        title: metadata.title,
        description: metadata.description,
        tags: metadata.tags,
        categoryId: '22'
      },
      status: { privacyStatus, selfDeclaredMadeForKids: false }
    },
    media: { body: (await import('node:fs')).createReadStream(filePath) }
  });
  if (!response.data.id) throw new Error('YouTube upload completed without returning a video ID.');
  return response.data.id;
}

export async function channelCredentialExists(channelId) {
  return Boolean(await YouTubeCredential.exists({ channelId }));
}
