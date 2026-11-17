import assert from 'node:assert/strict';
import test from 'node:test';
import { generateSceneAssets, PROCEDURAL_SCENE_COUNT } from './visualService.js';

test('creates eight local procedural scenes without a visual provider', () => {
  const prompts = Array.from({ length: PROCEDURAL_SCENE_COUNT }, (_, index) => `Scene ${index} action.`);
  const assets = generateSceneAssets(prompts);
  assert.equal(assets.length, 8);
  assert.ok(assets.every((asset, index) =>
    asset.type === 'procedural' && asset.index === index && asset.prompt === prompts[index]
  ));
});

test('rejects missing or empty procedural scene prompts', () => {
  assert.throws(() => generateSceneAssets(Array(7).fill('A scene.')), /Exactly 8 scene prompts/);
  assert.throws(() => generateSceneAssets([...Array(7).fill('A scene.'), ' ']), /non-empty prompt/);
});
