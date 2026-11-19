import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { Transform, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const PROCEDURAL_SCENE_COUNT = 8;
const STOCK_API_TIMEOUT_MS = 15000;
const MAX_STOCK_CLIP_BYTES = 8 * 1024 * 1024;
const MAX_STOCK_DOWNLOAD_BYTES = 48 * 1024 * 1024;
const CALM_QUERIES = [
  'misty forest dawn',
  'gentle rain window',
  'cinematic night lights',
  'calm ocean waves',
  'soft mountain fog',
  'quiet river reflection',
  'nature leaves after rain',
  'warm city lights night'
];
const PROMPT_STOP_WORDS = new Set([
  'action', 'animation', 'camera', 'character', 'cinematic', 'lighting', 'motion',
  'scene', 'style', 'subject', 'visual', 'with', 'from', 'into', 'over', 'under'
]);

export function generateSceneAssets(scenePrompts) {
  if (!Array.isArray(scenePrompts) || scenePrompts.length !== PROCEDURAL_SCENE_COUNT) {
    throw new TypeError(`Exactly ${PROCEDURAL_SCENE_COUNT} scene prompts are required.`);
  }
  if (scenePrompts.some((prompt) => typeof prompt !== 'string' || !prompt.trim())) {
    throw new TypeError('Every procedural scene requires a non-empty prompt.');
  }
  return scenePrompts.map((prompt, index) => ({
    type: 'procedural',
    prompt: prompt.trim(),
    index
  }));
}

function makeSearchQuery(asset, index) {
  const prompt = asset.prompt.toLowerCase();
  const promptTerms = prompt.match(/[a-z]{3,}/g) || [];
  const specificTerms = promptTerms.filter((word) => !PROMPT_STOP_WORDS.has(word)).slice(0, 2);
  const moodTerms = /\b(water|ocean|river|rain|wave|lake)\b/.test(prompt)
    ? 'calm waves ocean mist'
    : /\b(night|city|light|neon)\b/.test(prompt)
      ? 'cinematic night lights rain'
      : /\b(forest|tree|nature|mountain|mist)\b/.test(prompt)
        ? 'misty forest nature dawn'
        : CALM_QUERIES[index % CALM_QUERIES.length];
  return [...specificTerms, moodTerms].join(' ');
}

function requestSignal(signal) {
  const timeout = AbortSignal.timeout(STOCK_API_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function allowedMediaUrl(rawUrl, provider) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  const allowedHosts = provider === 'pexels'
    ? ['videos.pexels.com', 'player.vimeo.com']
    : ['cdn.pixabay.com'];
  if (url.protocol !== 'https:' || !allowedHosts.includes(url.hostname) ||
      !url.pathname.toLowerCase().endsWith('.mp4')) return null;
  return url;
}

function choosePortraitVideo(files, provider) {
  const eligible = files.filter((file) => {
    const width = Number(file.width);
    const height = Number(file.height);
    return (!file.file_type || file.file_type === 'video/mp4') &&
      width >= 480 && height >= 850 && width < height &&
      width <= 1080 && height <= 1920 &&
      allowedMediaUrl(file.link || file.url, provider) &&
      (!file.size || Number(file.size) <= MAX_STOCK_CLIP_BYTES);
  });
  eligible.sort((left, right) =>
    Math.abs(Number(left.width) * Number(left.height) - 720 * 1280) -
    Math.abs(Number(right.width) * Number(right.height) - 720 * 1280)
  );
  const file = eligible[0];
  if (!file) return null;
  return {
    url: file.link || file.url,
    provider,
    size: Number(file.size) || 0
  };
}

async function searchPexels(asset, index, apiKey, signal) {
  const url = new URL('https://api.pexels.com/videos/search');
  url.search = new URLSearchParams({
    query: makeSearchQuery(asset, index),
    orientation: 'portrait',
    size: 'medium',
    per_page: '5'
  });
  const response = await fetch(url, {
    headers: { Authorization: apiKey },
    redirect: 'error',
    signal: requestSignal(signal)
  });
  if (!response.ok) throw new Error(`Pexels API returned HTTP ${response.status}.`);
  const payload = await response.json();
  return choosePortraitVideo((payload.videos || []).flatMap((video) => video.video_files || []), 'pexels');
}

async function searchPixabay(asset, index, apiKey, signal) {
  const url = new URL('https://pixabay.com/api/videos/');
  url.search = new URLSearchParams({
    key: apiKey,
    q: makeSearchQuery(asset, index),
    orientation: 'vertical',
    safesearch: 'true',
    per_page: '5'
  });
  const response = await fetch(url, { redirect: 'error', signal: requestSignal(signal) });
  if (!response.ok) throw new Error(`Pixabay API returned HTTP ${response.status}.`);
  const payload = await response.json();
  return choosePortraitVideo(
    (payload.hits || []).flatMap((hit) => Object.values(hit.videos || {})),
    'pixabay'
  );
}

async function downloadStockVideo(video, destination, signal) {
  const url = allowedMediaUrl(video.url, video.provider);
  if (!url) throw new Error(`The ${video.provider} API returned an unsupported video URL.`);
  const response = await fetch(url, {
    redirect: 'error',
    signal: requestSignal(signal)
  });
  if (!response.ok) throw new Error(`${video.provider} video returned HTTP ${response.status}.`);
  const contentType = String(response.headers.get('content-type') || '').split(';')[0].toLowerCase();
  if (contentType && contentType !== 'video/mp4' && contentType !== 'application/octet-stream') {
    throw new Error(`${video.provider} returned a non-MP4 video.`);
  }
  const contentLength = Number(response.headers.get('content-length') || video.size || 0);
  if (contentLength > MAX_STOCK_CLIP_BYTES) throw new Error(`${video.provider} video exceeds the per-clip size limit.`);
  if (!response.body) throw new Error(`${video.provider} returned an empty video response.`);

  let byteCount = 0;
  const sizeLimit = new Transform({
    transform(chunk, encoding, callback) {
      byteCount += chunk.length;
      if (byteCount > MAX_STOCK_CLIP_BYTES) return callback(new Error('Stock video exceeds the per-clip size limit.'));
      callback(null, chunk);
    }
  });
  try {
    await pipeline(Readable.fromWeb(response.body), sizeLimit, createWriteStream(destination, { flags: 'wx' }));
    return byteCount;
  } catch (error) {
    await fs.rm(destination, { force: true });
    throw error;
  }
}

export async function resolveStockSceneAssets(sceneAssets, jobDir, signal) {
  const providers = [];
  if (process.env.PEXELS_API_KEY) providers.push({
    name: 'pexels',
    search: (asset, index) => searchPexels(asset, index, process.env.PEXELS_API_KEY, signal)
  });
  if (process.env.PIXABAY_API_KEY) providers.push({
    name: 'pixabay',
    search: (asset, index) => searchPixabay(asset, index, process.env.PIXABAY_API_KEY, signal)
  });
  if (!providers.length) return sceneAssets;

  let totalBytes = 0;
  const downloadedPaths = [];
  const resolvedAssets = [];
  try {
    for (let index = 0; index < sceneAssets.length; index += 1) {
      const asset = sceneAssets[index];
      let resolvedAsset = asset;
      for (const provider of providers) {
        try {
          const video = await provider.search(asset, index);
          if (!video) continue;
          const videoPath = path.join(jobDir, `stock_scene_${index}.mp4`);
          const byteCount = await downloadStockVideo(video, videoPath, signal);
          if (totalBytes + byteCount > MAX_STOCK_DOWNLOAD_BYTES) {
            await fs.rm(videoPath, { force: true });
            console.warn('Skipping stock video because the per-job download limit was reached.');
            continue;
          }
          totalBytes += byteCount;
          downloadedPaths.push(videoPath);
          resolvedAsset = { ...asset, type: 'video', path: videoPath, source: video.provider };
          break;
        } catch (error) {
          if (signal?.aborted) throw error;
          console.warn(`Unable to retrieve ${provider.name} video for scene ${index}: ${error.message}`);
        }
      }
      resolvedAssets.push(resolvedAsset);
    }
    return resolvedAssets;
  } catch (error) {
    await Promise.all(downloadedPaths.map((filePath) => fs.rm(filePath, { force: true })));
    throw error;
  }
}
