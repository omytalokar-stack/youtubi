import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { generateSceneAssets, PROCEDURAL_SCENE_COUNT, resolveStockSceneAssets } from './visualService.js';

const makePrompts = () => Array.from(
  { length: PROCEDURAL_SCENE_COUNT },
  (_, index) => `Scene ${index + 1} action.`
);

test('creates five distinct local scene visuals without requiring an image provider', () => {
  const prompts = makePrompts();
  const assets = generateSceneAssets(prompts);
  assert.equal(assets.length, 5);
  assert.ok(assets.every((asset, index) =>
    asset.type === 'procedural' && asset.index === index && asset.prompt === prompts[index]
  ));
});

test('rejects missing, empty, or duplicate scene inputs', () => {
  assert.throws(() => generateSceneAssets(Array(4).fill('A scene.')), /Exactly 5 scene prompts/);
  assert.throws(() => generateSceneAssets([...Array(4).fill('A scene.'), ' ']), /non-empty prompt/);
  assert.throws(() => generateSceneAssets(makePrompts(), ['only one query']), /exactly 5 entries/);
  assert.throws(() => generateSceneAssets(makePrompts(), Array(5).fill('repeated visual query')), /distinct visual query/);
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
    const assets = generateSceneAssets(makePrompts());
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

test('uses returned lightweight photos and keeps scene-specific fallbacks for missing images', async () => {
  const previousPexelsKey = process.env.PEXELS_API_KEY;
  const previousPixabayKey = process.env.PIXABAY_API_KEY;
  const originalFetch = globalThis.fetch;
  const jobDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dimag_scene_image_test_'));
  process.env.PEXELS_API_KEY = 'test-pexels-key';
  delete process.env.PIXABAY_API_KEY;
  const requests = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    requests.push({ url, init });
    if (url.hostname === 'api.pexels.com') {
      const photos = requests.filter(({ url: requestedUrl }) => requestedUrl.hostname === 'api.pexels.com');
      return new Response(JSON.stringify({
        photos: photos.length === 1 ? [{
          id: 'one-photo',
          width: 720,
          height: 1280,
          src: { portrait: 'https://images.pexels.com/photos/1/portrait.jpeg' }
        }] : []
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(new Uint8Array([0, 1, 2, 3]), {
      status: 200,
      headers: { 'content-type': 'image/jpeg', 'content-length': '4' }
    });
  };
  try {
    const queries = Array.from({ length: 5 }, (_, index) => `topic scene visual ${index + 1}`);
    const source = generateSceneAssets(makePrompts(), queries);
    const resolved = await resolveStockSceneAssets(source, jobDir);
    assert.equal(resolved.filter((asset) => asset.type === 'image').length, 1);
    assert.equal(resolved.filter((asset) => asset.type === 'procedural').length, 4);
    assert.equal(resolved[0].source, 'pexels');
    assert.equal(resolved[0].mediaId, 'pexels:one-photo');
    assert.deepEqual([...await fs.readFile(resolved[0].path)], [0, 1, 2, 3]);
    assert.deepEqual(
      requests.filter(({ url }) => url.hostname === 'api.pexels.com')
        .map(({ url }) => url.searchParams.get('query')),
      queries
    );
    assert.equal(requests[0].init.headers.Authorization, 'test-pexels-key');
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

test('falls back to local scene visuals after an image provider rate limit', async () => {
  const previousPexelsKey = process.env.PEXELS_API_KEY;
  const previousPixabayKey = process.env.PIXABAY_API_KEY;
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  process.env.PEXELS_API_KEY = 'test-pexels-key';
  delete process.env.PIXABAY_API_KEY;
  let fetchCount = 0;
  console.warn = () => {};
  globalThis.fetch = async () => {
    fetchCount += 1;
    return new Response('rate limited', { status: 429 });
  };
  try {
    const resolved = await resolveStockSceneAssets(generateSceneAssets(makePrompts()), os.tmpdir());
    assert.equal(fetchCount, 1);
    assert.ok(resolved.every((asset) => asset.type === 'procedural'));
    assert.equal(resolved.length, 5);
  } finally {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
    if (previousPexelsKey === undefined) delete process.env.PEXELS_API_KEY;
    else process.env.PEXELS_API_KEY = previousPexelsKey;
    if (previousPixabayKey === undefined) delete process.env.PIXABAY_API_KEY;
    else process.env.PIXABAY_API_KEY = previousPixabayKey;
  }
});

test('varies an available scene image for later scenes after a provider rate limit', async () => {
  const previousPexelsKey = process.env.PEXELS_API_KEY;
  const previousPixabayKey = process.env.PIXABAY_API_KEY;
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  const jobDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dimag_rate_limit_reuse_test_'));
  process.env.PEXELS_API_KEY = 'test-pexels-key';
  delete process.env.PIXABAY_API_KEY;
  let searchCount = 0;
  console.warn = () => {};
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.hostname !== 'api.pexels.com') {
      return new Response(new Uint8Array([0, 1, 2, 3]), {
        status: 200,
        headers: { 'content-type': 'image/jpeg', 'content-length': '4' }
      });
    }
    searchCount += 1;
    if (searchCount > 1) return new Response('rate limited', { status: 429 });
    return new Response(JSON.stringify({
      photos: [{
        id: 'available-image',
        width: 720,
        height: 1280,
        src: { portrait: 'https://images.pexels.com/photos/available/portrait.jpg' }
      }]
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const resolved = await resolveStockSceneAssets(generateSceneAssets(makePrompts()), jobDir);
    assert.equal(searchCount, 2);
    assert.equal(resolved[0].type, 'image');
    assert.ok(resolved.slice(1).every((asset) =>
      asset.type === 'image' && asset.reusedFrame && asset.path === resolved[0].path
    ));
    assert.equal(new Set(resolved.map((asset) => asset.mediaId)).size, 1);
  } finally {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
    await fs.rm(jobDir, { recursive: true, force: true });
    if (previousPexelsKey === undefined) delete process.env.PEXELS_API_KEY;
    else process.env.PEXELS_API_KEY = previousPexelsKey;
    if (previousPixabayKey === undefined) delete process.env.PIXABAY_API_KEY;
    else process.env.PIXABAY_API_KEY = previousPixabayKey;
  }
});

test('uses distinct scene searches and excludes previously used photo IDs', async () => {
  const previousPexelsKey = process.env.PEXELS_API_KEY;
  const previousPixabayKey = process.env.PIXABAY_API_KEY;
  const originalFetch = globalThis.fetch;
  const jobDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dimag_unique_scene_image_test_'));
  process.env.PEXELS_API_KEY = 'test-pexels-key';
  delete process.env.PIXABAY_API_KEY;
  const searches = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.hostname === 'api.pexels.com') {
      searches.push(url.searchParams.get('query'));
      const id = searches.length;
      return new Response(JSON.stringify({
        photos: [
          { id: 'shared-history', width: 720, height: 1280, src: { portrait: 'https://images.pexels.com/photos/shared/portrait.jpg' } },
          { id: `scene-${id}`, width: 720, height: 1280, src: { portrait: `https://images.pexels.com/photos/${id}/portrait.jpg` } }
        ]
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(new Uint8Array([0, 1, 2, 3]), {
      status: 200,
      headers: { 'content-type': 'image/jpeg', 'content-length': '4' }
    });
  };
  try {
    const queries = Array.from({ length: 5 }, (_, index) => `distinct visual query ${index + 1}`);
    const assets = generateSceneAssets(makePrompts(), queries);
    const resolved = await resolveStockSceneAssets(assets, jobDir, undefined, ['pexels:shared-history']);
    assert.deepEqual(searches, queries);
    assert.equal(resolved.filter((asset) => asset.type === 'image').length, 5);
    assert.equal(new Set(resolved.map((asset) => asset.mediaId)).size, 5);
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
