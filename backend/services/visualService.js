import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { Transform, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const PROCEDURAL_SCENE_COUNT = 5;
const STOCK_API_TIMEOUT_MS = 10000;
const MAX_SCENE_IMAGE_BYTES = 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = PROCEDURAL_SCENE_COUNT * MAX_SCENE_IMAGE_BYTES;
const CALM_QUERIES = [
  'misty forest dawn',
  'gentle rain window',
  'cinematic night lights',
  'calm ocean waves',
  'soft mountain fog'
];
const PROMPT_STOP_WORDS = new Set([
  'action', 'animation', 'camera', 'character', 'cinematic', 'lighting', 'motion',
  'scene', 'style', 'subject', 'visual', 'with', 'from', 'into', 'over', 'under'
]);

export function generateSceneAssets(scenePrompts, visualQueries = []) {
  if (!Array.isArray(scenePrompts) || scenePrompts.length !== PROCEDURAL_SCENE_COUNT) {
    throw new TypeError(`Exactly ${PROCEDURAL_SCENE_COUNT} scene prompts are required.`);
  }
  if (scenePrompts.some((prompt) => typeof prompt !== 'string' || !prompt.trim())) {
    throw new TypeError('Every procedural scene requires a non-empty prompt.');
  }
  if (!Array.isArray(visualQueries) || (visualQueries.length && visualQueries.length !== PROCEDURAL_SCENE_COUNT)) {
    throw new TypeError(`Visual queries must contain exactly ${PROCEDURAL_SCENE_COUNT} entries when provided.`);
  }
  if (visualQueries.some((query) => typeof query !== 'string' || !query.trim())) {
    throw new TypeError('Every visual query must be a non-empty string.');
  }
  const normalizedQueries = visualQueries.map((query) =>
    query.toLocaleLowerCase().replace(/[\p{P}\p{S}]/gu, ' ').trim().replace(/\s+/g, ' ')
  );
  if (new Set(normalizedQueries).size !== normalizedQueries.length) {
    throw new TypeError('Every scene must have a distinct visual query.');
  }
  return scenePrompts.map((prompt, index) => ({
    type: 'procedural',
    prompt: prompt.trim(),
    visualQuery: visualQueries[index]?.trim() || '',
    index
  }));
}

function makeSearchQuery(asset, index) {
  if (asset.visualQuery) return asset.visualQuery;
  const prompt = asset.prompt.toLowerCase();
  const promptTerms = prompt.match(/[a-z]{3,}/g) || [];
  const specificTerms = promptTerms.filter((word) => !PROMPT_STOP_WORDS.has(word)).slice(0, 3);
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
    ? ['images.pexels.com']
    : ['pixabay.com', 'cdn.pixabay.com'];
  if (url.protocol !== 'https:' || !allowedHosts.includes(url.hostname) ||
      !/\.(?:jpe?g|png|webp)$/i.test(url.pathname)) return null;
  return url;
}

function choosePortraitPhoto(photos, provider, usedMedia = new Set()) {
  const eligible = photos.map((photo) => {
    const url = provider === 'pexels' ? photo.src?.portrait : photo.webformatURL;
    return {
      url,
      width: Number(photo.width || photo.webformatWidth),
      height: Number(photo.height || photo.webformatHeight),
      mediaId: `${provider}:${photo.id || url}`
    };
  }).filter((photo) =>
    photo.width >= 400 && photo.height >= 700 && photo.width < photo.height &&
    photo.width <= 1080 && photo.height <= 1920 &&
    allowedMediaUrl(photo.url, provider) &&
    !usedMedia.has(photo.mediaId) && !usedMedia.has(photo.url)
  );
  eligible.sort((left, right) =>
    Math.abs(left.width * left.height - 720 * 1280) -
    Math.abs(right.width * right.height - 720 * 1280)
  );
  const photo = eligible[0];
  return photo ? { ...photo, provider, size: 0 } : null;
}

async function searchPexels(asset, index, apiKey, signal, usedMedia) {
  const url = new URL('https://api.pexels.com/v1/search');
  url.search = new URLSearchParams({
    query: makeSearchQuery(asset, index),
    orientation: 'portrait',
    per_page: '5'
  });
  const response = await fetch(url, {
    headers: { Authorization: apiKey },
    redirect: 'error',
    signal: requestSignal(signal)
  });
  if (!response.ok) throw new Error(`Pexels API returned HTTP ${response.status}.`);
  const payload = await response.json();
  return choosePortraitPhoto(payload.photos || [], 'pexels', usedMedia);
}

async function searchPixabay(asset, index, apiKey, signal, usedMedia) {
  const url = new URL('https://pixabay.com/api/');
  url.search = new URLSearchParams({
    key: apiKey,
    q: makeSearchQuery(asset, index),
    image_type: 'photo',
    orientation: 'vertical',
    safesearch: 'true',
    per_page: '5'
  });
  const response = await fetch(url, { redirect: 'error', signal: requestSignal(signal) });
  if (!response.ok) throw new Error(`Pixabay API returned HTTP ${response.status}.`);
  const payload = await response.json();
  return choosePortraitPhoto(payload.hits || [], 'pixabay', usedMedia);
}

async function downloadSceneImage(photo, destination, signal) {
  const url = allowedMediaUrl(photo.url, photo.provider);
  if (!url) throw new Error(`The ${photo.provider} API returned an unsupported image URL.`);
  const response = await fetch(url, { redirect: 'error', signal: requestSignal(signal) });
  if (!response.ok) throw new Error(`${photo.provider} image returned HTTP ${response.status}.`);
  const contentType = String(response.headers.get('content-type') || '').split(';')[0].toLowerCase();
  if (contentType && !['image/jpeg', 'image/png', 'image/webp', 'application/octet-stream'].includes(contentType)) {
    throw new Error(`${photo.provider} returned a non-image response.`);
  }
  const contentLength = Number(response.headers.get('content-length') || photo.size || 0);
  if (contentLength > MAX_SCENE_IMAGE_BYTES) throw new Error(`${photo.provider} image exceeds the per-image size limit.`);
  if (!response.body) throw new Error(`${photo.provider} returned an empty image response.`);

  let byteCount = 0;
  const sizeLimit = new Transform({
    transform(chunk, encoding, callback) {
      byteCount += chunk.length;
      if (byteCount > MAX_SCENE_IMAGE_BYTES) return callback(new Error('Scene image exceeds the per-image size limit.'));
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

export async function resolveStockSceneAssets(sceneAssets, jobDir, signal, excludedMediaIds = []) {
  const usedMedia = new Set(excludedMediaIds instanceof Set ? excludedMediaIds : excludedMediaIds);
  const providers = [];
  if (process.env.PEXELS_API_KEY) providers.push({
    name: 'pexels',
    search: (asset, index) => searchPexels(asset, index, process.env.PEXELS_API_KEY, signal, usedMedia)
  });
  if (process.env.PIXABAY_API_KEY) providers.push({
    name: 'pixabay',
    search: (asset, index) => searchPixabay(asset, index, process.env.PIXABAY_API_KEY, signal, usedMedia)
  });
  if (!providers.length) return sceneAssets;

  let totalBytes = 0;
  const downloadedPaths = [];
  const resolvedAssets = [];
  const disabledProviders = new Set();
  let lastImageAsset;
  let reuseAvailableFrame = false;
  try {
    for (let index = 0; index < sceneAssets.length; index += 1) {
      const asset = sceneAssets[index];
      let resolvedAsset = asset;
      for (const provider of providers) {
        if (disabledProviders.has(provider.name)) continue;
        try {
          const photo = await provider.search(asset, index);
          if (!photo) continue;
          const extension = path.extname(new URL(photo.url).pathname).toLowerCase();
          const imagePath = path.join(jobDir, `scene_image_${index}${extension}`);
          const byteCount = await downloadSceneImage(photo, imagePath, signal);
          if (totalBytes + byteCount > MAX_TOTAL_IMAGE_BYTES) {
            await fs.rm(imagePath, { force: true });
            console.warn('Skipping scene image because the per-job download limit was reached.');
            continue;
          }
          totalBytes += byteCount;
          downloadedPaths.push(imagePath);
          usedMedia.add(photo.mediaId);
          usedMedia.add(photo.url);
          resolvedAsset = {
            ...asset,
            type: 'image',
            path: imagePath,
            source: photo.provider,
            mediaId: photo.mediaId,
            mediaUrl: photo.url
          };
          break;
        } catch (error) {
          if (signal?.aborted) throw error;
          if (/HTTP 429\b/.test(error.message)) {
            disabledProviders.add(provider.name);
            reuseAvailableFrame = true;
          }
          console.warn(`Unable to retrieve ${provider.name} image for scene ${index}; using a local scene visual: ${error.message}`);
        }
      }
      if (resolvedAsset.type === 'procedural' && reuseAvailableFrame && lastImageAsset) {
        resolvedAsset = {
          ...lastImageAsset,
          ...asset,
          type: 'image',
          path: lastImageAsset.path,
          source: lastImageAsset.source,
          mediaId: lastImageAsset.mediaId,
          mediaUrl: lastImageAsset.mediaUrl,
          reusedFrame: true
        };
      }
      if (resolvedAsset.type === 'image' && !resolvedAsset.reusedFrame) lastImageAsset = resolvedAsset;
      resolvedAssets.push(resolvedAsset);
    }
    return resolvedAssets;
  } catch (error) {
    await Promise.all(downloadedPaths.map((filePath) => fs.rm(filePath, { force: true })));
    throw error;
  }
}
