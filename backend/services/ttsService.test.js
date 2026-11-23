import assert from 'node:assert/strict';
import test from 'node:test';
import { generateTtsAudio, sanitizeNarrationText } from './ttsService.js';

const audioResponse = (data = 'AQID') => ({
  candidates: [{ content: { parts: [{ inlineData: { data, mimeType: 'audio/L16;rate=16000' } }] } }]
});

test('strips unsupported markdown and special characters from retry narration', () => {
  assert.equal(
    sanitizeNarrationText('**Hello #World😀!** [site](https://example.com)'),
    'Hello World! site'
  );
});

test('retries missing TTS audio with backoff and sanitized narration', async () => {
  const prompts = [];
  const backoffs = [];
  const result = await generateTtsAudio('**Hello #World😀!**', 'English', async (text) => {
    prompts.push(text);
    return prompts.length === 1 ? audioResponse('') : audioResponse();
  }, async (milliseconds) => backoffs.push(milliseconds));

  assert.deepEqual(prompts, ['**Hello #World😀!**', 'Hello World!']);
  assert.deepEqual(backoffs, [500]);
  assert.deepEqual(result.data, Buffer.from('AQID', 'base64'));
  assert.equal(result.mimeType, 'audio/L16;rate=16000');
});

test('caps empty-audio retries at three attempts with exponential backoff', async () => {
  const prompts = [];
  const backoffs = [];
  await assert.rejects(
    generateTtsAudio('**Narration**', 'English', async (text) => {
      prompts.push(text);
      return audioResponse('');
    }, async (milliseconds) => backoffs.push(milliseconds)),
    /Gemini TTS returned no audio after 3 attempts/
  );

  assert.equal(prompts.length, 3);
  assert.deepEqual(prompts, ['**Narration**', 'Narration', 'Narration']);
  assert.deepEqual(backoffs, [500, 1000]);
});
