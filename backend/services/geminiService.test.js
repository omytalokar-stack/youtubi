import assert from 'node:assert/strict';
import test from 'node:test';
import {
  findSimilarRecentTopic,
  generateScriptDraft,
  normalizeScenePrompts,
  normalizeSubtitleBeats,
  normalizeVisualQueries,
  validateCreativeDraft
} from './geminiService.js';

const draft = (script) => JSON.stringify({ script });
const scenes = [
  'What vanished before the mug could cool?',
  'The chef plants one seed inside a coffee mug.',
  'Warm steam wakes roots beneath the dark soil.',
  'By morning, green leaves lean toward sunlight.',
  'He adds no garden, lamp, or special equipment.',
  'A spoonful of water keeps each stem growing.',
  'Then the cup travels beside his open laptop.',
  'That explains what vanished before the mug cooled.'
];
const validDraft = (overrides = {}) => {
  const subtitleBeats = overrides.subtitleBeats || scenes;
  return {
    hook: 'What vanished before the mug cooled?',
    topic: 'A seed grows inside a coffee mug',
    title: 'The surprising coffee mug garden',
    script: subtitleBeats.join(' '),
    loopEnding: subtitleBeats[subtitleBeats.length - 1],
    description: 'A tiny indoor gardening experiment.',
    tags: ['gardening'],
    subtitleBeats,
    scenes: subtitleBeats.map((sentence, index) => ({
      sentence,
      visualQuery: `distinct scene ${index + 1} ${sentence}`,
      action: sentence,
      motion: 'A clear subject moves through the frame.',
      camera: 'A slow, steady tracking shot.',
      lighting: 'Soft, natural morning light.'
    })),
    ...overrides
  };
};

test('regenerates an overlong Gemini script before rejecting it', async () => {
  const responses = [
    draft(Array(75).fill('word').join(' ')),
    draft(Array(62).fill('word').join(' '))
  ];
  let calls = 0;
  const result = await generateScriptDraft('Create a Short.', async (prompt) => {
    if (calls > 0) assert.match(prompt, /Correction required/);
    return responses[calls++];
  });
  assert.equal(result.script.trim().split(/\s+/).length, 62);
  assert.equal(calls, 2);
});

test('reports the final word count after three corrective generations', async () => {
  let calls = 0;
  await assert.rejects(
    generateScriptDraft('Create a Short.', async () => {
      calls += 1;
      return draft(Array(75).fill('word').join(' '));
    }),
    /after 3 corrections: the script has 75 words/
  );
  assert.equal(calls, 4);
});

test('regenerates a malformed Gemini response instead of failing before correction', async () => {
  let calls = 0;
  let correctionPrompt = '';
  const result = await generateScriptDraft('Create a Short.', async (prompt) => {
    if (calls++ === 0) return '{"script":';
    correctionPrompt = prompt;
    return JSON.stringify(validDraft());
  });
  assert.equal(result.topic, validDraft().topic);
  assert.match(correctionPrompt, /previous response was not valid JSON/i);
  assert.equal(calls, 2);
});

test('does not retry Gemini transport errors as malformed JSON', async () => {
  let calls = 0;
  await assert.rejects(
    generateScriptDraft('Create a Short.', async () => {
      calls += 1;
      throw new Error('Gemini transport failed.');
    }),
    /Gemini transport failed/
  );
  assert.equal(calls, 1);
});

test('normalizes legacy scene output into eight cinematic animation prompts', () => {
  const scenePrompts = normalizeScenePrompts({
    script: Array.from({ length: 64 }, (_, index) => `word${index}`).join(' '),
    sceneQueries: ['A person finds a letter.', 'They open a door.', 'They run outside.', 'They celebrate.']
  }, { channelTitle: 'Test channel', niche: 'Stories' });
  assert.equal(scenePrompts.length, 8);
  for (const prompt of scenePrompts) {
    for (const label of ['ACTION:', 'MOTION:', 'CAMERA:', 'LIGHTING:']) assert.ok(prompt.includes(label));
    assert.match(prompt, /glowing particles/);
    assert.match(prompt, /cinematic 3D or 2D animation/);
  }
  assert.equal(new Set(scenePrompts).size, 8);
});

test('splits subtitles into eight exact chunks when generated beats are invalid', () => {
  const script = Array.from({ length: 64 }, (_, index) => `word${index}`).join(' ');
  const beats = normalizeSubtitleBeats(script, ['one invalid beat']);
  assert.equal(beats.length, 8);
  assert.equal(beats.join(' '), script);
  assert.ok(beats.every((beat) => beat.split(/\s+/).length >= 5 && beat.split(/\s+/).length <= 10));
  assert.equal(normalizeSubtitleBeats(script, ['one invalid beat']).length, 8);
});

test('requires a retention-ready eight-scene script with aligned unique visual queries', () => {
  const result = validDraft();
  assert.equal(validateCreativeDraft(result), null);
  const duplicateQuery = validDraft();
  duplicateQuery.scenes[1].visualQuery = duplicateQuery.scenes[0].visualQuery;
  assert.match(validateCreativeDraft(duplicateQuery), /visualQuery values must be distinct/);
  const misaligned = validDraft();
  misaligned.scenes[0].sentence = 'A different sentence is placed here.';
  assert.match(validateCreativeDraft(misaligned), /must align with its spoken subtitle beat/);
});

test('rejects weak openings, broken loop endings, and repeated channel topics', () => {
  const weakOpening = validDraft();
  weakOpening.hook = 'Hello guys, listen to this story.';
  assert.match(validateCreativeDraft(weakOpening), /forbidden weak introduction/);
  const brokenLoop = validDraft({ loopEnding: 'Tomorrow, we try another tiny garden.' });
  assert.match(validateCreativeDraft(brokenLoop), /loopEnding must exactly match/);
  const history = [{ title: 'A coffee mug garden', topic: 'A seed grows inside a coffee mug' }];
  assert.match(validateCreativeDraft(validDraft(), history), /too similar to a recent video/);
  assert.match(findSimilarRecentTopic(validDraft(), history), /coffee mug garden/);
});

test('regenerates a topic that overlaps a recent upload before accepting a new idea', async () => {
  const history = [{ title: 'A coffee mug garden', topic: 'A seed grows inside a coffee mug' }];
  const repeated = validDraft();
  const freshSentences = [
    'An ancient map hides a coastline no sailor could find.',
    'Researchers spot the missing shore beneath desert sand.',
    'Satellites reveal a river where oceans once reached.',
    'Tiny fossils confirm the dry valley held waves.',
    'One erased border concealed a vanished fishing town.',
    'Local stories placed its harbor beside the dunes.',
    'New scans uncover foundations below shifting sand.',
    'That explains why the ancient map hid a coastline.'
  ];
  const fresh = validDraft({
    hook: 'Where did this vanished shoreline go?',
    topic: 'An erased coastline emerges beneath desert dunes',
    title: 'The coastline hidden beneath desert sand',
    script: freshSentences.join(' '),
    loopEnding: freshSentences.at(-1),
    subtitleBeats: freshSentences,
    scenes: freshSentences.map((sentence, index) => ({
      sentence,
      visualQuery: `distinct map scene ${index + 1} ${sentence}`,
      action: sentence,
      motion: 'Sand moves across a wide landscape.',
      camera: 'A slow, steady tracking shot.',
      lighting: 'Soft, natural morning light.'
    }))
  });
  let calls = 0;
  const result = await generateScriptDraft(
    'Create a Short.',
    async (prompt) => {
      if (calls > 0) assert.match(prompt, /too similar to a recent video/);
      return JSON.stringify(calls++ === 0 ? repeated : fresh);
    },
    (candidate) => validateCreativeDraft(candidate, history)
  );
  assert.equal(result.topic, fresh.topic);
  assert.equal(calls, 2);
});

test('adds the channel visual search prefix to every scene query', () => {
  const queries = normalizeVisualQueries(validDraft(), { visualKeywordsPrefix: 'cinematic India' });
  assert.equal(queries.length, 8);
  assert.ok(queries.every((query) => query.startsWith('cinematic India, ')));
});
