import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAss } from './renderService.js';

test('builds energetic two-to-three word captions for all eight beats', () => {
  const ass = buildAss(Array.from({ length: 8 }, () => 'one two three four five six seven'), 'Test hook');
  const captionEvents = ass.split(/\r?\n/).filter((line) => line.startsWith('Dialogue: 0,'));
  assert.equal(captionEvents.length, 24);
  for (const event of captionEvents) {
    const text = event.slice(event.lastIndexOf(',,') + 2).replace(/\{[^}]*\}/g, '').trim();
    assert.ok(text.split(/\s+/).length >= 2 && text.split(/\s+/).length <= 3);
  }
  assert.match(ass, /&H0000FFFF&/);
  assert.match(ass, /&H00FFFF00&/);
});

test('requires exactly eight subtitle beats', () => {
  assert.throws(() => buildAss(['one beat'], 'Test hook'), /Exactly 8 subtitle beats/);
});
