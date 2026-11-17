import assert from 'node:assert/strict';
import test from 'node:test';
import {
  generateScriptDraft,
  normalizeScenePrompts,
  normalizeSubtitleBeats,
  validateCreativeDraft
} from './geminiService.js';

const draft = (script) => JSON.stringify({ script });

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

test('reports the final word count after two corrective generations', async () => {
  let calls = 0;
  await assert.rejects(
    generateScriptDraft('Create a Short.', async () => {
      calls += 1;
      return draft(Array(75).fill('word').join(' '));
    }),
    /after two corrections: the script has 75 words/
  );
  assert.equal(calls, 3);
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
  assert.equal(validateCreativeDraft({ script }), null);
});
