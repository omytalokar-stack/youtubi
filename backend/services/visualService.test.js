import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { generateSceneAssets, PROCEDURAL_SCENE_COUNT, resolveStockSceneAssets } from './visualService.js';

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
  assert.throws(() => generateSceneAssets(Array(8).fill('A scene.'), ['only one query']), /exactly 8 entries/);
  assert.throws(() => generateSceneAssets(
    Array(8).fill('A scene.'),
    Array(8).fill('repeated visual query')
  ), /distinct visual query/);
});

test('does not contact stock providers unless an API key is configured', async () => {
  const previousPexelsKey = process.env.PEXELS_API_KEY;
  const previousPixabayKey = process.env.PIXABAY_API_KEY;
  const originalFetch = globalThis.fetch;
  delete process.env.PEXELS_API_KEY;
  delete process.env.PIXABAY_API_KEY;
  let fetchCount = 0;
  globalThis.fetch = async () => { fetchCount += 1; throw new Error('unexpected network request'); };
  try {
    const assets = generateSceneAssets(Array.from({ length: 8 }, () => 'A misty forest scene.'));
    assert.deepEqual(await resolveStockSceneAssets(assets, os.tmpdir()), assets);
    assert.equal(fetchCount, 0);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousPexelsKey === undefined) delete process.env.PEXELS_API_KEY;
    else process.env.PEXELS_API_KEY = previousPexelsKey;
    if (previousPixabayKey === undefined) delete process.env.PIXABAY_API_KEY;
    else process.env.PIXABAY_API_KEY = previousPixabayKey;
  }
});

test('retrieves a vertical Pexels clip and writes it into the render job directory', async () => {
  const previousPexelsKey = process.env.PEXELS_API_KEY;
  const previousPixabayKey = process.env.PIXABAY_API_KEY;
  const originalFetch = globalThis.fetch;
  const jobDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dimag_stock_test_'));
  process.env.PEXELS_API_KEY = 'test-pexels-key';
  delete process.env.PIXABAY_API_KEY;
  const requests = [];
  let searchCount = 0;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    requests.push({ url, init });
    if (url.hostname === 'api.pexels.com') {
      searchCount += 1;
      return new Response(JSON.stringify({
        videos: searchCount === 1 ? [{
          video_files: [{
            file_type: 'video/mp4',
            width: 720,
            height: 1280,
            link: 'https://videos.pexels.com/video-files/sample.mp4'
          }]
        }] : []
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(new Uint8Array([0, 1, 2, 3]), {
      status: 200,
      headers: { 'content-type': 'video/mp4', 'content-length': '4' }
    });
  };
  try {
    const source = generateSceneAssets([
      'A slow scene of calm ocean waves.',
      ...Array.from({ length: 7 }, () => 'A misty forest at dawn.')
    ]);
    const assets = await resolveStockSceneAssets(source, jobDir);
    assert.equal(assets[0].type, 'video');
    assert.equal(assets[0].source, 'pexels');
    assert.deepEqual([...await fs.readFile(assets[0].path)], [0, 1, 2, 3]);
    assert.equal(requests.length, 9);
    assert.equal(requests[0].init.headers.Authorization, 'test-pexels-key');
    assert.match(requests[0].url.searchParams.get('query'), /calm waves ocean mist/);
    assert.equal(requests[0].url.searchParams.get('orientation'), 'portrait');
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(jobDir, { recursive: true, force: true });
    if (previousPexelsKey === undefined) delete process.env.PEXELS_API_KEY;
    else process.env.PEXELS_API_KEY = previousPexelsKey;
    if (previousPixabayKey === undefined) delete process.env.PIXABAY_API_KEY;
    else process.env.PIXABAY_API_KEY = previousPixabayKey;
  }
});

test('uses sentence-specific searches and excludes repeated stock IDs within and across Shorts', async () => {
  const previousPexelsKey = process.env.PEXELS_API_KEY;
  const previousPixabayKey = process.env.PIXABAY_API_KEY;
  const originalFetch = globalThis.fetch;
  const jobDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dimag_unique_stock_test_'));
  process.env.PEXELS_API_KEY = 'test-pexels-key';
  delete process.env.PIXABAY_API_KEY;
  const searches = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.hostname === 'api.pexels.com') {
      searches.push(url.searchParams.get('query'));
      const current = searches.length;
      const files = ['shared-history', `scene-${current}`].map((id) => ({
        file_type: 'video/mp4',
        width: 720,
        height: 1280,
        link: `https://videos.pexels.com/video-files/${id}.mp4`
      }));
      return new Response(JSON.stringify({
        videos: [{ id: current === 1 ? 'shared-history' : 'shared-history', video_files: [files[0]] },
          { id: `scene-${current}`, video_files: [files[1]] }]
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(new Uint8Array([0, 1, 2, 3]), {
      status: 200,
      headers: { 'content-type': 'video/mp4', 'content-length': '4' }
    });
  };
  try {
    const queries = Array.from({ length: 8 }, (_, index) => `visual query ${index + 1}`);
    const assets = generateSceneAssets(Array.from({ length: 8 }, (_, index) => `Sentence ${index + 1}.`), queries);
    const resolved = await resolveStockSceneAssets(assets, jobDir, undefined, ['pexels:shared-history']);
    assert.deepEqual(searches, queries);
    assert.equal(resolved.filter((asset) => asset.type === 'video').length, 8);
    assert.equal(new Set(resolved.map((asset) => asset.mediaId)).size, 8);
    assert.ok(resolved.every((asset) => asset.mediaId !== 'pexels:shared-history'));
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(jobDir, { recursive: true, force: true });
    if (previousPexelsKey === undefined) delete process.env.PEXELS_API_KEY;
    else process.env.PEXELS_API_KEY = previousPexelsKey;
    if (previousPixabayKey === undefined) delete process.env.PIXABAY_API_KEY;
    else process.env.PIXABAY_API_KEY = previousPixabayKey;
  }
});
