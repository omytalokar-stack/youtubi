import ChannelProfile from '../models/ChannelProfile.js';
import BrainMemory from '../models/BrainMemory.js';
import VideoLog from '../models/VideoLog.js';
import { fetchRecentVideoAnalytics } from './youtubeService.js';
import { createGeminiClient, GEMINI_TEXT_MODELS, withGeminiModels } from './geminiApiKeys.js';

function median(values) {
  const sorted = values.slice().sort((left, right) => left - right);
  if (!sorted.length) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function metricsForScore(video) {
  const ageDays = Math.max(1, (Date.now() - new Date(video.publishedAt || Date.now()).getTime()) / 86400000);
  return {
    viewVelocity: Number(video.views || 0) / ageDays,
    impressionVelocity: Number(video.impressions || 0) / ageDays,
    ctr: Number(video.ctr || 0),
    retention: Number(video.retention || 0),
    averageViewDuration: Number(video.averageViewDuration || 0),
    likeRate: Number(video.views) > 0 ? Number(video.likes || 0) / Number(video.views) : 0
  };
}

export function classifyPerformance(videos) {
  if (!videos.length) return [];
  const metrics = videos.map(metricsForScore);
  const baselines = Object.keys(metrics[0]).reduce((result, key) => {
    result[key] = median(metrics.map((item) => item[key]).filter((value) => value > 0));
    return result;
  }, {});
  const scored = videos.map((video, index) => {
    const components = Object.entries(metrics[index])
      .filter(([key, value]) => value > 0 && baselines[key] > 0)
      .map(([key, value]) => Math.min(value / baselines[key], 3));
    return { ...video, performanceScore: components.length ? components.reduce((sum, value) => sum + value, 0) / components.length : 0 };
  });
  const scoreMedian = median(scored.map((video) => video.performanceScore));
  return scored.map((video) => ({
    ...video,
    classification: video.performanceScore > 0 && video.performanceScore >= scoreMedian ? 'winner' : 'underperformer'
  }));
}

function parseJson(text) {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  return JSON.parse(cleaned);
}

function scorecardEntry(video) {
  return {
    videoId: video.videoId,
    title: video.title,
    classification: video.classification,
    score: video.performanceScore,
    views: video.views,
    impressions: video.impressions,
    ctr: video.ctr,
    averageViewDuration: video.averageViewDuration,
    retention: video.retention,
    likes: video.likes,
    publishedAt: video.publishedAt ? new Date(video.publishedAt) : null
  };
}

async function extractPatterns(channelId, classifiedVideos) {
  const winners = classifiedVideos.filter((video) => video.classification === 'winner');
  const underperformers = classifiedVideos.filter((video) => video.classification === 'underperformer');
  const text = await withGeminiModels(GEMINI_TEXT_MODELS, async (apiKey, model) => {
    const ai = createGeminiClient(apiKey);
    const response = await ai.models.generateContent({
      model,
      contents: `You are analyzing performance for YouTube channel ${channelId}. Use only these records and do not claim causation that the sample cannot support. Winners are ranked relative to this channel's recent videos using views/impressions velocity, CTR, average view duration, retention, and likes per view. Return JSON exactly with string fields winningFormula, winningTactic, mistakeRule, and nextVideoStrategy. The formula should describe supported hook, pacing, topic, title, or tag patterns in winners. The mistake rule should describe a supported contrast in underperformers; if there is no supported pattern, explicitly say evidence is insufficient. The next strategy must be a practical next-Short recommendation focused on the opening 3 seconds, completion/rewatch, and accurate CTR packaging, without promising results.\nWinners: ${JSON.stringify(winners.slice(0, 12))}\nUnderperformers: ${JSON.stringify(underperformers.slice(0, 12))}`,
      config: { responseMimeType: 'application/json', temperature: 0.2 }
    });
    return response.text || '';
  });
  const result = parseJson(text);
  for (const field of ['winningFormula', 'winningTactic', 'mistakeRule', 'nextVideoStrategy']) {
    if (typeof result[field] !== 'string' || !result[field].trim()) {
      throw new Error(`Gemini returned an incomplete channel performance analysis (${field}).`);
    }
  }
  return result;
}

export async function learnChannelPerformance(channelId) {
  const [profile, recentVideos, loggedVideos] = await Promise.all([
    ChannelProfile.findOne({ channelId }).lean(),
    fetchRecentVideoAnalytics(channelId, 30),
    VideoLog.find({ channelId }).sort({ publishedAt: -1 }).limit(50)
      .select('videoId hook script title tags').lean()
  ]);
  if (!profile) throw new Error(`Channel profile not found for ${channelId}.`);
  if (!recentVideos.length) return { channelId, scorecard: [], learned: false };

  const logsById = new Map(loggedVideos.map((video) => [video.videoId, video]));
  const classifiedVideos = classifyPerformance(recentVideos.map((video) => ({
    ...video,
    hook: logsById.get(video.videoId)?.hook || '',
    script: logsById.get(video.videoId)?.script || '',
    tags: video.tags?.length ? video.tags : (logsById.get(video.videoId)?.tags || []),
    title: video.title || logsById.get(video.videoId)?.title || ''
  })));
  await Promise.all(classifiedVideos.map((video) => VideoLog.updateOne(
    { channelId, videoId: video.videoId },
    { $set: {
      views: video.views,
      impressions: video.impressions,
      ctr: video.ctr,
      averageViewDuration: video.averageViewDuration,
      retention: video.retention,
      likes: video.likes
    } }
  )));

  const patterns = await extractPatterns(channelId, classifiedVideos);
  const memory = await BrainMemory.findOneAndUpdate({ channelId }, {
    $push: {
      winningTactics: { $each: [patterns.winningTactic], $slice: -50 },
      mistakeRules: { $each: [patterns.mistakeRule], $slice: -50 }
    },
    $set: {
      winningBlueprint: patterns.winningFormula,
      nextVideoStrategy: patterns.nextVideoStrategy,
      performanceScorecard: classifiedVideos.map(scorecardEntry),
      lastAutoAuditAt: new Date()
    },
    $setOnInsert: { channelId }
  }, { upsert: true, new: true, runValidators: true });

  return {
    channelId,
    scorecard: memory.performanceScorecard,
    winningFormula: patterns.winningFormula,
    winningTactic: patterns.winningTactic,
    mistakeRule: patterns.mistakeRule,
    nextVideoStrategy: patterns.nextVideoStrategy,
    lastAutoAuditAt: memory.lastAutoAuditAt,
    learned: true
  };
}

export async function auditChannel(channelId) {
  const analysis = await learnChannelPerformance(channelId);
  if (!analysis.learned) throw new Error('This channel has no recent videos to audit.');
  return analysis;
}
