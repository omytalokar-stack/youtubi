import assert from 'node:assert/strict';
import test from 'node:test';

process.env.GEMINI_API_KEY = 'test-key-one';
process.env.GEMINI_API_KEY_2 = 'test-key-two';
process.env.GEMINI_API_KEYS = '';

const { withGeminiKey, withGeminiModels } = await import('./geminiApiKeys.js');

test('withGeminiKey rotates keys and retries 404, 429, and 503 responses', async () => {
  for (const status of [404, 429, 503]) {
    const seenKeys = [];
    let call = 0;
    const result = await withGeminiKey(async (key) => {
      seenKeys.push(key);
      if (call++ === 0) throw Object.assign(new Error('Retryable response'), { status });
      return 'ok';
    });
    assert.equal(result, 'ok');
    assert.deepEqual(seenKeys, ['test-key-one', 'test-key-two']);
  }
});

test('withGeminiModels falls back in order while continuing key rotation', async () => {
  const calls = [];
  const result = await withGeminiModels(['model-a', 'model-b', 'model-c'], async (key, model) => {
    calls.push({ key, model });
    if (model === 'model-a') throw Object.assign(new Error('Model unavailable'), { status: 404 });
    return model;
  });
  assert.equal(result, 'model-b');
  assert.deepEqual(calls.map(({ model }) => model), ['model-a', 'model-a', 'model-b']);
  assert.notEqual(calls[0].key, calls[1].key);
});
