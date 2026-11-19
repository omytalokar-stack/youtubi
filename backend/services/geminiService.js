import ChannelProfile from '../models/ChannelProfile.js';
import BrainMemory from '../models/BrainMemory.js';
import VideoLog from '../models/VideoLog.js';
import { learnChannelPerformance } from './analyticsOptimizer.js';
import { createGeminiClient, GEMINI_TEXT_MODELS, withGeminiModels } from './geminiApiKeys.js';

function parseJson(text) {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  return JSON.parse(cleaned);
}

function scriptWordCount(script) {
  return script.trim().split(/\s+/).filter(Boolean).length;
}

function normalizedWords(text) {
  return String(text).toLocaleLowerCase().replace(/[\p{P}\p{S}]/gu, ' ').trim().split(/\s+/).filter(Boolean);
}

export function validateCreativeDraft(result) {
  const words = typeof result.script === 'string' ? scriptWordCount(result.script) : 0;
  if (words < 55 || words > 70) return `the script has ${words} words instead of 55-70`;
  return null;
}

const SCENE_COUNT = 8;

function splitIntoScenes(script) {
  const words = script.trim().split(/\s+/).filter(Boolean);
  const baseSize = Math.floor(words.length / SCENE_COUNT);
  const extraWords = words.length % SCENE_COUNT;
  const beats = [];
  let offset = 0;
  for (let index = 0; index < SCENE_COUNT; index += 1) {
    const size = baseSize + (index < extraWords ? 1 : 0);
    beats.push(words.slice(offset, offset + size).join(' '));
    offset += size;
  }
  return beats;
}

export function normalizeSubtitleBeats(script, subtitleBeats) {
  if (Array.isArray(subtitleBeats) &&
      subtitleBeats.length === SCENE_COUNT &&
      subtitleBeats.every((beat) => typeof beat === 'string' && scriptWordCount(beat) >= 5 && scriptWordCount(beat) <= 10) &&
      normalizedWords(subtitleBeats.join(' ')).join(' ') === normalizedWords(script).join(' ')) {
    return subtitleBeats;
  }
  return splitIntoScenes(script);
}

const cameraMoves = [
  'rapid push-in to the subject',
  'whip-pan reveal from left to right',
  'low-angle tracking move',
  'fast orbit around the subject',
  'sharp tilt-up reveal',
  'snap zoom through the foreground',
  'sideways tracking shot with a sudden stop',
  'fast pull-back revealing the full scene'
];

const motionCues = [
  'the character bursts into decisive action',
  'the subject darts across the frame',
  'the character pivots and drives forward',
  'the subject reaches toward the focal point',
  'the character turns sharply into motion',
  'the subject jumps through a burst of light',
  'the character spins and points toward the horizon',
  'the subject races past the camera'
];

const lightingCues = [
  'dramatic warm key light with deep shadows',
  'cool cyan edge light and high contrast',
  'golden side light with cinematic shadows',
  'soft backlight with a bright moving highlight',
  'moody low-key lighting with a sharp rim',
  'electric magenta glow against deep shadows',
  'bright teal beams crossing a dark background',
  'pulsing violet backlight with a warm foreground'
];

function sourceScenePrompts(result) {
  const raw = Array.isArray(result.scenePrompts) ? result.scenePrompts
    : Array.isArray(result.sceneQueries) ? result.sceneQueries
      : Array.isArray(result.scenes) ? result.scenes
        : typeof result.scenePrompts === 'string' ? result.scenePrompts.split(/\r?\n/)
          : [];
  return raw.filter((prompt) => typeof prompt === 'string' && prompt.trim()).map((prompt) =>
    prompt.trim().replace(/^\s*(?:scene\s*)?\d+[.): -]\s*/i, '')
  );
}

export function normalizeScenePrompts(result, profile = {}) {
  const prompts = sourceScenePrompts(result);
  if (prompts.length === SCENE_COUNT && prompts.every((prompt) =>
    ['action:', 'motion:', 'camera:', 'lighting:'].every((label) => prompt.toLowerCase().includes(label))
  )) {
    return prompts.map((prompt) => `${prompt} STYLE: cinematic 3D or 2D animation with glowing particles and expressive character motion.`);
  }
  const scriptBeats = splitIntoScenes(result.script);
  const context = [profile.channelTitle, profile.niche, profile.visualKeywordsPrefix].filter(Boolean).join(', ');
  return Array.from({ length: SCENE_COUNT }, (_, index) => {
    const source = prompts.length
      ? prompts[Math.min(prompts.length - 1, Math.floor(index * prompts.length / SCENE_COUNT))]
      : scriptBeats[index];
    const action = [source, `story moment: ${scriptBeats[index]}`, context].filter(Boolean).join('; ')
      .replace(/\b(?:action|motion|camera|lighting):/gi, '')
      .replace(/\s+/g, ' ')
      .trim();
    return `ACTION: ${action}; MOTION: ${motionCues[index]} with glowing particles trailing the movement; CAMERA: ${cameraMoves[index]}; LIGHTING: ${lightingCues[index]}; STYLE: cinematic 3D or 2D animation.`;
  });
}

export async function generateScriptDraft(prompt, generateText, validateDraft = (result) => {
  const words = typeof result.script === 'string' ? scriptWordCount(result.script) : 0;
  return words >= 55 && words <= 70 ? null : `the script has ${words} words instead of 55-70`;
}) {
  let result = parseJson(await generateText(prompt));
  for (let correction = 0; correction <= 2; correction += 1) {
    const issue = validateDraft(result);
    if (!issue) return result;
    if (correction === 2) throw new Error(`Generated Short failed validation after two corrections: ${issue}.`);
    result = parseJson(await generateText(`${prompt}

Correction required: ${issue}. Rewrite the JSON to satisfy every requested count and alignment constraint. Target 62 words in the script and ensure subtitleBeats cover only the rewritten script.
Previous JSON: ${JSON.stringify(result)}`));
  }
  throw new Error('Unable to generate a script within the required word count.');
}

export async function generateShort(channelId, { onWriting } = {}) {
  await learnChannelPerformance(channelId);
  onWriting?.();
  const [profile, memory, recentVideos] = await Promise.all([
    ChannelProfile.findOne({ channelId }).lean(),
    BrainMemory.findOne({ channelId }).lean(),
    VideoLog.find({ channelId }).sort({ publishedAt: -1 }).limit(30).select('title hook').lean()
  ]);
  if (!profile) throw new Error(`Channel profile not found for ${channelId}.`);
  const learningEnabled = Boolean(memory?.selfCorrectionEnabled);
  const rules = learningEnabled ? (memory.mistakeRules || []).join('\n') : '';
  const tactics = learningEnabled ? (memory.winningTactics || []).join('\n') : '';
  const winningBlueprint = learningEnabled ? memory?.winningBlueprint : '';
  const scorecard = learningEnabled ? memory?.performanceScorecard || [] : [];
  const nextVideoStrategy = learningEnabled ? memory?.nextVideoStrategy : '';
  const blueprint = profile.metadataBlueprint || {};
  const prompt = `Return only JSON with keys hook,title,script,description,tags,scenePrompts,subtitleBeats.
Create one YouTube Short for channel ${profile.channelTitle}. Niche: ${profile.niche}. Language: ${profile.language}.
Tone: ${profile.toneAndStyle}. Visual prefix: ${profile.visualKeywordsPrefix}.
Write a natural 55-70 word spoken script (target 62; count words separated by spaces), a compelling hook, and exactly 8 chronological English animation prompts for 9:16 vertical scenes, each designed for 2.5-3 seconds.
Each scenePrompts entry must describe a distinct high-action moment using exactly these labeled clauses: ACTION (character action), MOTION (visible movement, glowing particles), CAMERA (camera movement), and LIGHTING (lighting); also specify a cinematic 3D or 2D animation style.
subtitleBeats must contain exactly 8 spoken chunks, one per scene, with 5-10 words each. Together they must reproduce the script exactly, in order, without adding or omitting words. The renderer will display each beat as fast 2-3 word captions.
tags must be an array of strings and include these core tags: ${(blueprint.coreTags || []).join(', ')}.
Append this locked suffix to the title: ${blueprint.titleSuffix || '(none)'}.
Append this locked footer to the description: ${blueprint.fixedDescriptionFooter || '(none)'}.
Avoid these recent titles/hooks: ${JSON.stringify(recentVideos)}.
Winning tactics: ${tactics}. Mistake rules: ${rules}.
Channel winning blueprint: ${winningBlueprint || 'Not learned yet'}.
Historical performance scorecard (winners and underperformers): ${JSON.stringify(scorecard)}.
Next-video strategy: ${nextVideoStrategy || 'Use an immediate, specific 3-second hook; keep visual and spoken pacing tight; end with a visual or idea that can loop naturally.'}.
Engineer the opening for 3-second retention, the ending for completion and replay, and the title/tags for accurate channel-specific CTR. Follow the performance evidence above; do not make unsupported promises or claims.
Do not invent channel analytics or claim unsupported facts.`;
  const result = await generateScriptDraft(prompt, async (draftPrompt) => {
    return withGeminiModels(GEMINI_TEXT_MODELS, async (apiKey, model) => {
      const ai = createGeminiClient(apiKey);
      const response = await ai.models.generateContent({
        model,
        contents: draftPrompt,
        config: { responseMimeType: 'application/json', temperature: 0.8 }
      });
      return response.text || '';
    });
  }, validateCreativeDraft);
  if (typeof result.script !== 'string' || !result.hook || !result.title || !Array.isArray(result.tags)) {
    throw new Error('Gemini returned an incomplete script.');
  }
  result.scenePrompts = normalizeScenePrompts(result, profile);
  result.subtitleBeats = normalizeSubtitleBeats(result.script, result.subtitleBeats);
  const suffix = String(blueprint.titleSuffix || '').trim();
  const title = String(result.title).trim();
  result.title = suffix && title.endsWith(suffix) ? title : `${title}${suffix ? ` ${suffix}` : ''}`;
  const footer = String(blueprint.fixedDescriptionFooter || '').trim();
  const description = String(result.description || '').trim();
  result.description = footer && !description.endsWith(footer) ? `${description}${description ? '\n\n' : ''}${footer}` : description;
  result.tags = [...new Set([...(result.tags || []), ...(blueprint.coreTags || [])])];
  return result;
}

export async function chatWithGemini(channelId, message, history = []) {
  const profile = await ChannelProfile.findOne({ channelId }).lean();
  if (!profile) throw new Error(`Channel profile not found for ${channelId}.`);
  const prompt = `You are Dimag AI Studio for YouTube channel "${profile.channelTitle}" (${profile.channelId}).
Use only this channel's configuration: niche=${profile.niche}, language=${profile.language}, tone=${profile.toneAndStyle}.
Do not claim access to unprovided data or use information from another channel.
Conversation: ${JSON.stringify(history.slice(-10))}\nUser: ${message}`;
  return withGeminiModels(GEMINI_TEXT_MODELS, async (apiKey, model) => {
    const ai = createGeminiClient(apiKey);
    const response = await ai.models.generateContent({ model, contents: prompt });
    return response.text || '';
  });
}
