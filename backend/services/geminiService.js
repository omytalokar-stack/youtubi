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

const SCENE_COUNT = 5;
const MAX_DRAFT_CORRECTIONS = 5;
const TOPIC_STOP_WORDS = new Set([
  'about', 'after', 'again', 'also', 'been', 'before', 'being', 'could', 'from', 'have',
  'into', 'just', 'more', 'most', 'other', 'over', 'same', 'some', 'than', 'that',
  'their', 'them', 'then', 'there', 'these', 'they', 'this', 'those', 'through', 'very',
  'what', 'when', 'where', 'which', 'while', 'with', 'would', 'your', 'aaj', 'aur',
  'hai', 'hain', 'hum', 'kar', 'kya', 'mein', 'ki', 'ka', 'ke', 'ko', 'par', 'se',
  'yeh', 'woh', 'जो', 'और', 'यह', 'वह', 'क्या', 'है', 'हैं', 'का', 'की', 'के', 'में'
]);

function splitSentences(text) {
  return String(text || '').match(/[^.!?।]+[.!?।]?/gu)?.map((sentence) => sentence.trim()).filter(Boolean) || [];
}

function topicTokens(text) {
  return normalizedWords(text).filter((word) => word.length > 2 && !TOPIC_STOP_WORDS.has(word));
}

function isNearDuplicate(left, right) {
  const leftTokens = topicTokens(left);
  const rightTokens = topicTokens(right);
  const leftSet = new Set(leftTokens);
  const rightSet = new Set(rightTokens);
  const smallerSize = Math.min(leftSet.size, rightSet.size);
  if (smallerSize < 3) return false;
  const intersection = [...leftSet].filter((word) => rightSet.has(word)).length;
  const unionSize = new Set([...leftSet, ...rightSet]).size;
  return intersection / smallerSize >= 0.72 || intersection / unionSize >= 0.58;
}

export function findSimilarRecentTopic(result, recentVideos = []) {
  const current = [result.topic, result.title, result.hook, splitSentences(result.script)[0], result.script]
    .filter((value) => typeof value === 'string' && value.trim());
  for (const video of recentVideos) {
    const previous = [video.topic, video.title, video.hook, splitSentences(video.script)[0], video.script]
      .filter((value) => typeof value === 'string' && value.trim());
    if (current.some((candidate) => previous.some((item) => isNearDuplicate(candidate, item)))) {
      return video.title || video.topic || video.hook || 'a recent video';
    }
  }
  return '';
}

export function buildRecentTopicPrompt(recentVideos = []) {
  const recentTitles = recentVideos.map((video) => video.title || '').filter(Boolean);
  const recentTopics = recentVideos.map((video) => ({
    title: video.title || '',
    topic: video.topic || splitSentences(video.script)[0] || video.hook || video.title || '',
    hook: video.hook || ''
  }));
  return `Recent video titles to avoid: ${JSON.stringify(recentTitles)}. Choose a completely distinct angle or subtopic, not just different wording. Do not reuse the same central fact, story, person, event, or takeaway. Compare against these recent topics and hooks: ${JSON.stringify(recentTopics)}.`;
}

function normalizedVisualQuery(query) {
  return String(query || '').toLocaleLowerCase().replace(/[\p{P}\p{S}]/gu, ' ').trim().replace(/\s+/g, ' ');
}

function includesPrefix(query, prefix) {
  const normalizedQuery = normalizedVisualQuery(query);
  const normalizedPrefix = normalizedVisualQuery(prefix);
  return !normalizedPrefix || normalizedQuery.includes(normalizedPrefix);
}

export function validateCreativeDraft(result, recentVideos = [], visualPrefix = '') {
  if (!result || typeof result !== 'object') return 'the response must be a JSON object';
  const words = typeof result.script === 'string' ? scriptWordCount(result.script) : 0;
  if (words < 55 || words > 70) return `the script has ${words} words instead of 55-70`;
  if (!String(result.hook || '').trim() || !String(result.title || '').trim() || !String(result.topic || '').trim()) {
    return 'hook, title, and a concise topic are required';
  }
  if (scriptWordCount(result.hook) < 4 || scriptWordCount(result.hook) > 10) {
    return 'the on-screen hook must contain 4-10 words';
  }
  const sentences = splitSentences(result.script);
  if (sentences.length !== SCENE_COUNT) return `the script has ${sentences.length} sentences instead of ${SCENE_COUNT}`;
  if (sentences.some((sentence) => scriptWordCount(sentence) < 11 || scriptWordCount(sentence) > 14)) {
    return 'every spoken sentence must contain 11-14 words';
  }
  const weakOpeners = /^(?:hello\s+guys\b|kya\s+aap\s+jaante\s+hain\b|क्या\s+आप\s+जानते\s+हैं\b|doston\b.{0,80}\b(?:baat\s+kar(?:enge|te\s+hain)|talk\s+about)\b)/iu;
  if (weakOpeners.test(sentences[0]) || weakOpeners.test(String(result.hook))) {
    return 'the hook uses a forbidden weak introduction';
  }
  if (normalizedWords(result.loopEnding || '').join(' ') !== normalizedWords(sentences.at(-1)).join(' ')) {
    return 'loopEnding must exactly match the final spoken sentence';
  }
  if (!Array.isArray(result.subtitleBeats) || result.subtitleBeats.length !== SCENE_COUNT ||
      result.subtitleBeats.some((beat) => typeof beat !== 'string' || scriptWordCount(beat) < 11 || scriptWordCount(beat) > 14) ||
      normalizedWords(result.subtitleBeats.join(' ')).join(' ') !== normalizedWords(result.script).join(' ')) {
    return 'subtitleBeats must contain five 11-14 word scene beats that reproduce the script exactly';
  }
  if (!Array.isArray(result.scenes) || result.scenes.length !== SCENE_COUNT) {
    return `the draft must contain exactly ${SCENE_COUNT} scenes`;
  }
  const visualQueries = [];
  for (let index = 0; index < SCENE_COUNT; index += 1) {
    const scene = result.scenes[index];
    if (!scene || typeof scene.sentence !== 'string' || typeof scene.visualQuery !== 'string' ||
        !scene.sentence.trim() || !scene.visualQuery.trim() ||
        ['action', 'motion', 'camera', 'lighting'].some((field) => typeof scene[field] !== 'string' || !scene[field].trim())) {
      return `scene ${index + 1} needs a sentence, visualQuery, action, motion, camera, and lighting`;
    }
    if (normalizedWords(scene.sentence).join(' ') !== normalizedWords(result.subtitleBeats[index]).join(' ')) {
      return `scene ${index + 1} must align with its spoken subtitle beat`;
    }
    if (!includesPrefix(scene.visualQuery, visualPrefix)) {
      return `scene ${index + 1} visualQuery must include the channel visual search prefix`;
    }
    visualQueries.push(normalizedVisualQuery(scene.visualQuery));
  }
  if (new Set(visualQueries).size !== SCENE_COUNT) return 'all five visualQuery values must be distinct';
  const repeatedTopic = findSimilarRecentTopic(result, recentVideos);
  if (repeatedTopic) return `the topic is too similar to a recent video: "${repeatedTopic}"`;
  return null;
}

function splitIntoScenes(script) {
  const sentences = splitSentences(script);
  if (sentences.length === SCENE_COUNT) return sentences;
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
      subtitleBeats.every((beat) => typeof beat === 'string' && scriptWordCount(beat) >= 11 && scriptWordCount(beat) <= 14) &&
      normalizedWords(subtitleBeats.join(' ')).join(' ') === normalizedWords(script).join(' ')) {
    return subtitleBeats;
  }
  return splitIntoScenes(script);
}

const cameraMoves = [
  'slow push-in toward the subject',
  'gentle pan from left to right',
  'low-angle tracking move',
  'slow orbit around the subject',
  'steady pull-back revealing the full scene'
];

const motionCues = [
  'the subject moves naturally into the scene',
  'a small environmental detail shifts in the foreground',
  'the subject turns toward the focal point',
  'light and nearby objects move gently',
  'the subject settles into the final composition'
];

const lightingCues = [
  'soft directional light with natural shadows',
  'warm side light with gentle contrast',
  'diffused daylight and balanced colors',
  'subtle backlight with a clear focal point',
  'natural golden-hour light with soft shadows'
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
  if (Array.isArray(result.scenes) && result.scenes.length === SCENE_COUNT &&
      result.scenes.every((scene) => scene && typeof scene === 'object')) {
    return result.scenes.map((scene, index) => {
      const sentence = scene.sentence || splitIntoScenes(result.script)[index];
      return `ACTION: ${scene.action || sentence}; MOTION: ${scene.motion || motionCues[index]}; CAMERA: ${scene.camera || cameraMoves[index]}; LIGHTING: ${scene.lighting || lightingCues[index]}; STYLE: cinematic 3D or 2D animation with expressive character motion.`;
    });
  }
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

export function normalizeVisualQueries(result, profile = {}) {
  const prefix = String(profile.visualKeywordsPrefix || '').trim();
  const scenes = Array.isArray(result.scenes) ? result.scenes : [];
  return Array.from({ length: SCENE_COUNT }, (_, index) => {
    const sentence = scenes[index]?.sentence || splitIntoScenes(result.script)[index];
    const visualQuery = String(scenes[index]?.visualQuery || sentence).trim();
    return prefix && !includesPrefix(visualQuery, prefix) ? `${prefix}, ${visualQuery}` : visualQuery;
  });
}

export async function generateScriptDraft(prompt, generateText, validateDraft = (result) => {
  const words = typeof result.script === 'string' ? scriptWordCount(result.script) : 0;
  return words >= 55 && words <= 70 ? null : `the script has ${words} words instead of 55-70`;
}) {
  let correctionPrompt = prompt;
  for (let correction = 0; correction <= MAX_DRAFT_CORRECTIONS; correction += 1) {
    const response = await generateText(correctionPrompt);
    let result;
    try {
      result = parseJson(response);
    } catch (error) {
      if (correction === MAX_DRAFT_CORRECTIONS) {
        throw new Error(`Generated Short returned invalid JSON after ${MAX_DRAFT_CORRECTIONS} corrections: ${error.message}`);
      }
      correctionPrompt = `${prompt}

Correction required: The previous response was not valid JSON. Return a complete, valid JSON object only, with no Markdown fences or extra text.`;
      continue;
    }
    const issue = validateDraft(result);
    if (!issue) return result;
    if (correction === MAX_DRAFT_CORRECTIONS) {
      throw new Error(`Generated Short failed validation after ${MAX_DRAFT_CORRECTIONS} corrections: ${issue}.`);
    }
    const rejectedTitles = /similar to a recent video/i.test(issue)
      ? [result.title, result.topic].filter(Boolean)
      : [];
    correctionPrompt = `${prompt}

Correction required: ${issue}. Rewrite the complete JSON to satisfy every requested script, hook, loop, topic-uniqueness, scene-query, and alignment constraint. Target 62 words and keep subtitleBeats and scenes aligned exactly to the rewritten script.
${rejectedTitles.length ? `Do not reuse these rejected title or topic strings: ${JSON.stringify(rejectedTitles)}.` : ''}
Previous JSON: ${JSON.stringify(result)}`;
  }
  throw new Error('Unable to generate a valid Short draft.');
}

export async function generateShort(channelId, { onWriting } = {}) {
  await learnChannelPerformance(channelId);
  onWriting?.();
  const [profile, memory, recentVideos] = await Promise.all([
    ChannelProfile.findOne({ channelId }).lean(),
    BrainMemory.findOne({ channelId }).lean(),
    VideoLog.find({ channelId }).sort({ publishedAt: -1 }).limit(30).select('topic title hook script').lean()
  ]);
  if (!profile) throw new Error(`Channel profile not found for ${channelId}.`);
  const learningEnabled = Boolean(memory?.selfCorrectionEnabled);
  const rules = learningEnabled ? (memory.mistakeRules || []).join('\n') : '';
  const tactics = learningEnabled ? (memory.winningTactics || []).join('\n') : '';
  const winningBlueprint = learningEnabled ? memory?.winningBlueprint : '';
  const scorecard = learningEnabled ? memory?.performanceScorecard || [] : [];
  const nextVideoStrategy = learningEnabled ? memory?.nextVideoStrategy : '';
  const blueprint = profile.metadataBlueprint || {};
  const prompt = `Return only valid JSON with keys hook,topic,title,script,loopEnding,description,tags,scenes,subtitleBeats.
Create one YouTube Short for channel ${profile.channelTitle}. Niche: ${profile.niche}. Language: ${profile.language}.
Tone: ${profile.toneAndStyle}. Channel visual search prefix: ${profile.visualKeywordsPrefix || '(none)'}.
Create a fresh, specific topic that is not a duplicate or near-duplicate in meaning of any item in this strict do-not-repeat list. ${buildRecentTopicPrompt(recentVideos)} If your first idea overlaps, choose a different topic before writing.
Write a natural 55-70 word spoken script (target 62; count words separated by spaces) as exactly 5 complete chronological sentences, one per scene, with 11-14 words in every sentence. The total video is about 30 seconds, with each scene lasting about 6 seconds. The spoken opening and on-screen hook land in 0-2 seconds; body beats progress naturally and the loop-ending sentence belongs in the final scene. The first sentence must open in the middle of an action using a surprising contrast, a concrete number, or a strong curiosity gap. Make the separate on-screen hook a concise version of that opening. Do not begin the hook or script with "Doston aaj hum baat karenge", "Hello guys", or "Kya aap jaante hain" (including close variants).
Keep the middle sentences crisp and specific, revealing a new detail or question with each beat. The final sentence is the seamless-loop ending: write it so its grammar and rhythm flow directly back into the opening sentence when the video restarts. Set loopEnding to that exact final sentence.
Return exactly 5 chronological scenes. Every scenes[i].sentence must exactly match subtitleBeats[i]. Every scene must include a concise, topic-relevant visualQuery tailored to that sentence and the channel visual search prefix "${profile.visualKeywordsPrefix || ''}". All five visualQuery values must be different and describe the actual subject/action in that specific sentence; do not repeat or lightly rephrase a query. Also include action, motion, camera, and lighting strings for distinct 9:16 scene direction.
subtitleBeats must contain exactly 5 spoken sentences, 11-14 words each, and together reproduce script exactly, in order, without adding or omitting words. The renderer will display each beat as dynamic 3-5 word captions.
tags must be an array of strings and include these core tags: ${(blueprint.coreTags || []).join(', ')}.
${blueprint.titleSuffix
    ? `Append this locked suffix to the title exactly: ${JSON.stringify(blueprint.titleSuffix)}.`
    : 'There is no locked title suffix; do not add one.'}
${blueprint.fixedDescriptionFooter
    ? `Append this locked footer to the description exactly: ${JSON.stringify(blueprint.fixedDescriptionFooter)}.`
    : 'There is no locked description footer; do not add one.'}
Winning tactics: ${tactics}. Mistake rules: ${rules}.
Channel winning blueprint: ${winningBlueprint || 'Not learned yet'}.
Historical performance scorecard (winners and underperformers): ${JSON.stringify(scorecard)}.
Next-video strategy: ${nextVideoStrategy || 'Open in motion, reveal a new specific detail in every beat, and make the last sentence loop naturally to the opening.'}.
Engineer a fast opening and clear curiosity progression for retention, a natural loop for completion/replay, and accurate channel-specific packaging. Do not promise performance, imitate another creator, or make unsupported claims.
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
  }, (result) => validateCreativeDraft(result, recentVideos, profile.visualKeywordsPrefix));
  if (typeof result.script !== 'string' || !result.hook || !result.title || !Array.isArray(result.tags)) {
    throw new Error('Gemini returned an incomplete script.');
  }
  result.scenePrompts = normalizeScenePrompts(result, profile);
  result.visualQueries = normalizeVisualQueries(result, profile);
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
