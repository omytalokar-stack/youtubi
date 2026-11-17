import ChannelProfile from '../models/ChannelProfile.js';
import BrainMemory from '../models/BrainMemory.js';
import VideoLog from '../models/VideoLog.js';
import { fetchVideoAnalytics } from './youtubeService.js';
import { createGeminiClient, GEMINI_TEXT_MODELS, withGeminiModels } from './geminiApiKeys.js';

export async function auditChannel(channelId) {
  const profile = await ChannelProfile.findOne({ channelId }).lean();
  if (!profile) throw new Error(`Channel profile not found for ${channelId}.`);
  const videos = await VideoLog.find({ channelId }).sort({ publishedAt: -1 }).limit(7).lean();
  if (!videos.length) throw new Error('This channel has no published videos to audit.');
  const measured = await fetchVideoAnalytics(channelId, videos.map((video) => video.videoId));
  await Promise.all(measured.map((item) => VideoLog.updateOne(
    { channelId, videoId: item.videoId },
    { $set: { views: item.views, likes: item.likes, watchTimeMinutes: item.watchTimeMinutes } }
  )));
  const metrics = videos.map((video) => ({
    title: video.title,
    hook: video.hook,
    views: measured.find((item) => item.videoId === video.videoId)?.views || 0,
    likes: measured.find((item) => item.videoId === video.videoId)?.likes || 0,
    watchTimeMinutes: measured.find((item) => item.videoId === video.videoId)?.watchTimeMinutes || 0
  }));
  const text = await withGeminiModels(GEMINI_TEXT_MODELS, async (apiKey, model) => {
    const ai = createGeminiClient(apiKey);
    const result = await ai.models.generateContent({
      model,
      contents: `Analyze only these performance records from channel ${channelId}. Use only numeric evidence supplied. Return JSON exactly: {"winningTactic":"one concise actionable tactic supported by the data","mistakeRule":"one concise constraint supported by the data"}. If evidence is weak, say so in the corresponding string and do not invent explanations.\n${JSON.stringify(metrics)}`,
      config: { responseMimeType: 'application/json', temperature: 0.2 }
    });
    return result.text || '';
  });
  const result = JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
  if (!result.winningTactic || !result.mistakeRule) throw new Error('Gemini returned an incomplete analytics audit.');
  const memory = await BrainMemory.findOneAndUpdate({ channelId }, {
    $push: { winningTactics: { $each: [result.winningTactic], $slice: -50 }, mistakeRules: { $each: [result.mistakeRule], $slice: -50 } },
    $set: { lastAutoAuditAt: new Date() },
    $setOnInsert: { channelId }
  }, { upsert: true, new: true, runValidators: true });
  return { channelId, metrics, winningTactic: result.winningTactic, mistakeRule: result.mistakeRule, lastAutoAuditAt: memory.lastAutoAuditAt };
}
