import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolveStockSceneAssets } from './visualService.js';

const execFileAsync = promisify(execFile);
const SCENE_COUNT = 8;
const SCENE_DURATION = 2.75;
const TRANSITION_DURATION = 0.18;
export const OUTPUT_WIDTH = 720;
export const OUTPUT_HEIGHT = 1280;
export const FPS = 24;
export const FFMPEG_TIMEOUT_MS = 480000;
const FRAME_COUNT = Math.round(SCENE_DURATION * FPS);
const TRANSITIONS = ['smoothleft', 'wipeleft', 'smoothup', 'dissolve', 'slideright', 'smoothdown', 'wiperight'];
const OUTPUT_DURATION = SCENE_COUNT * SCENE_DURATION - (SCENE_COUNT - 1) * TRANSITION_DURATION;
const SERVICE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const BUNDLED_CAPTION_FONT = path.resolve(SERVICE_DIRECTORY, '../assets/fonts/NotoSansDevanagari.ttf');
const SYSTEM_CAPTION_FONTS = [
  '/usr/share/fonts/truetype/noto/NotoSansDevanagari-Bold.ttf',
  '/usr/share/fonts/truetype/noto/NotoSansDevanagari.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  '/usr/share/fonts/TTF/DejaVuSans-Bold.ttf',
  '/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf',
  'C:\\Windows\\Fonts\\Nirmala.ttc',
  'C:\\Windows\\Fonts\\arialuni.ttf'
];

export function createJobDirectory(channelId) {
  const safeId = channelId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return fs.mkdtempSync(path.join(os.tmpdir(), `dimag_job_${safeId}_`));
}

export function resolveCaptionFontPath() {
  const configuredFont = process.env.CAPTION_FONT_PATH;
  if (configuredFont) {
    const resolved = path.resolve(configuredFont);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      throw new Error(`CAPTION_FONT_PATH does not point to a readable font file: ${resolved}`);
    }
    return resolved;
  }
  const fontPath = [BUNDLED_CAPTION_FONT, ...SYSTEM_CAPTION_FONTS].find((candidate) =>
    fs.existsSync(candidate) && fs.statSync(candidate).isFile()
  );
  if (!fontPath) {
    throw new Error('No caption font is available. Install Noto Sans Devanagari or set CAPTION_FONT_PATH.');
  }
  return fontPath;
}

export function groupCaptionWords(beat) {
  const words = String(beat).trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const groupCount = Math.ceil(words.length / 5);
  const baseSize = Math.floor(words.length / groupCount);
  const extraWords = words.length % groupCount;
  const groups = [];
  let offset = 0;
  for (let index = 0; index < groupCount; index += 1) {
    const size = baseSize + (index < extraWords ? 1 : 0);
    groups.push(words.slice(offset, offset + size));
    offset += size;
  }
  return groups;
}

export function buildCaptionEvents(beats, hook, duration = OUTPUT_DURATION) {
  if (!Array.isArray(beats) || beats.length !== SCENE_COUNT) {
    throw new TypeError(`Exactly ${SCENE_COUNT} subtitle beats are required.`);
  }
  if (!Number.isFinite(duration) || duration <= 0) throw new RangeError('Caption duration must be positive.');
  const events = [];
  const cleanHook = String(hook || '').replace(/\s+/g, ' ').trim();
  if (cleanHook) events.push({ text: cleanHook, start: 0, end: Math.min(0.8, duration), position: 'top' });
  const beatDuration = duration / beats.length;
  beats.forEach((beat, beatIndex) => {
    const captions = groupCaptionWords(beat);
    const captionDuration = beatDuration / captions.length;
    captions.forEach((words, captionIndex) => {
      const start = beatIndex * beatDuration + captionIndex * captionDuration;
      events.push({
        text: words.join(' '),
        start,
        end: start + captionDuration,
        position: 'center'
      });
    });
  });
  return events;
}

function escapeFilterPath(value) {
  return path.resolve(value).replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

export function buildCaptionFilter(event, fontPath, textFilePath) {
  const y = event.position === 'top' ? '150' : '(h-text_h)/2';
  return `drawtext=fontfile='${escapeFilterPath(fontPath)}':textfile='${escapeFilterPath(textFilePath)}':expansion=none:text_shaping=1:fontcolor=white:fontsize=48:borderw=1.25:bordercolor=white:shadowcolor=black@0.75:shadowx=2:shadowy=2:box=1:boxcolor=black@0.55:boxborderw=18:x=(w-text_w)/2:y=${y}:enable='between(t,${event.start.toFixed(3)},${event.end.toFixed(3)})'`;
}

function encodeArgs(outputPath) {
  return [
    '-threads', '1',
    '-preset', 'ultrafast',
    '-crf', '26',
    '-pix_fmt', 'yuv420p',
    '-s', `${OUTPUT_WIDTH}x${OUTPUT_HEIGHT}`,
    '-r', String(FPS),
    '-an',
    outputPath
  ];
}

const PALETTES = [
  { base: '0x102632', mid: '0x355158', accent: '0x637b74', light: '0xb49b7b' },
  { base: '0x18202d', mid: '0x3a4351', accent: '0x62697a', light: '0xb79a83' },
  { base: '0x0d2530', mid: '0x164758', accent: '0x3e737d', light: '0x91aba3' },
  { base: '0x14271f', mid: '0x294638', accent: '0x55715e', light: '0xc0ad83' },
  { base: '0x1e1b31', mid: '0x35384e', accent: '0x665c72', light: '0xc39c8b' },
  { base: '0x202534', mid: '0x394252', accent: '0x63717b', light: '0xc5ac86' },
  { base: '0x29202a', mid: '0x4d3844', accent: '0x795b59', light: '0xd0a780' },
  { base: '0x10252b', mid: '0x20515a', accent: '0x457a78', light: '0xb0b08b' }
];

function paletteForScene(asset, index) {
  const prompt = asset.prompt.toLowerCase();
  if (/\b(water|ocean|river|rain|ice|wave|lake)\b/.test(prompt)) return PALETTES[2];
  if (/\b(forest|tree|leaf|nature|garden|mountain)\b/.test(prompt)) return PALETTES[3];
  if (/\b(space|star|galaxy|cosmic|night|city|light)\b/.test(prompt)) return PALETTES[4];
  return PALETTES[index % PALETTES.length];
}

export function buildProceduralFilter(asset, index) {
  const palette = paletteForScene(asset, index);
  const phase = (index * 0.41).toFixed(2);
  return [
    `drawbox=x=42:y=210:w=708:h=560:color=${palette.mid}@0.58:t=fill`,
    `drawbox=x=330:y=665:w=430:h=610:color=${palette.accent}@0.45:t=fill`,
    `drawbox=x=0:y=72:w=792:h=160:color=${palette.light}@0.2:t=fill`,
    `crop=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:x='36+24*sin(t*0.22+${phase})':y='64+40*cos(t*0.18+${phase})'`,
    'eq=brightness=-0.12:contrast=1.08:saturation=1.12',
    'setsar=1',
    'format=yuv420p'
  ].join(',');
}

export function buildSceneFfmpegArgs(outputPath, asset, index) {
  const palette = paletteForScene(asset, index);
  const source = `color=c=${palette.base}:s=792x1408:r=${FPS}:d=${SCENE_DURATION}`;
  return [
    '-hide_banner', '-loglevel', 'error',
    '-y', '-filter_threads', '1', '-threads', '1', '-f', 'lavfi', '-i', source,
    '-vf', buildProceduralFilter(asset, index),
    '-frames:v', String(FRAME_COUNT),
    ...encodeArgs(outputPath)
  ];
}

export function buildVideoFilter(index) {
  const phase = (index * 0.41).toFixed(2);
  return [
    `scale=792:1408:force_original_aspect_ratio=increase:flags=fast_bilinear`,
    `crop=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:x='36+24*sin(t*0.22+${phase})':y='64+40*cos(t*0.18+${phase})'`,
    'eq=brightness=-0.12:contrast=1.08:saturation=1.12',
    `fps=${FPS}`,
    'setsar=1',
    'format=yuv420p'
  ].join(',');
}

export function buildVideoFfmpegArgs(outputPath, videoPath, index) {
  return [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-filter_threads', '1', '-threads', '1', '-stream_loop', '-1', '-i', videoPath,
    '-vf', buildVideoFilter(index),
    '-frames:v', String(FRAME_COUNT),
    ...encodeArgs(outputPath)
  ];
}

async function renderProceduralScene(asset, outputPath, index, signal) {
  await execFileAsync(process.env.FFMPEG_PATH || 'ffmpeg', buildSceneFfmpegArgs(outputPath, asset, index), {
    timeout: FFMPEG_TIMEOUT_MS,
    maxBuffer: 50 * 1024 * 1024,
    signal
  });
}

async function renderVideoScene(asset, outputPath, index, signal) {
  if (typeof asset.path !== 'string' || !fs.existsSync(asset.path)) {
    throw new TypeError(`Stock video scene ${index} is not available.`);
  }
  await execFileAsync(process.env.FFMPEG_PATH || 'ffmpeg', buildVideoFfmpegArgs(outputPath, asset.path, index), {
    timeout: FFMPEG_TIMEOUT_MS,
    maxBuffer: 50 * 1024 * 1024,
    signal
  });
}

async function renderScene(asset, index, outputPath, signal) {
  if (asset?.type === 'video') {
    await renderVideoScene(asset, outputPath, index, signal);
    return outputPath;
  }
  if (asset?.type !== 'procedural' || typeof asset.prompt !== 'string' || !asset.prompt.trim()) {
    throw new TypeError(`Scene ${index} is not a valid procedural scene.`);
  }
  await renderProceduralScene(asset, outputPath, index, signal);
  return outputPath;
}

function xfadeFilter(captionFilters, sceneCount = SCENE_COUNT, sceneDuration = SCENE_DURATION) {
  const filters = [];
  for (let index = 0; index < sceneCount; index += 1) {
    filters.push(`[${index}:v]settb=AVTB,setpts=PTS-STARTPTS[v${index}]`);
  }
  let previous = 'v0';
  for (let index = 1; index < sceneCount; index += 1) {
    const output = `xf${index}`;
    const transition = TRANSITIONS[(index - 1) % TRANSITIONS.length];
    const offset = (index * (sceneDuration - TRANSITION_DURATION)).toFixed(2);
    filters.push(`[${previous}][v${index}]xfade=transition=${transition}:duration=${TRANSITION_DURATION}:offset=${offset}[${output}]`);
    previous = output;
  }
  const captions = captionFilters.length ? `,${captionFilters.join(',')}` : '';
  filters.push(`[${previous}]scale=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:flags=fast_bilinear,fps=${FPS},format=yuv420p${captions}[v]`);
  return filters.join(';');
}

export function buildFinalRenderArgs({
  segmentPaths, audioPath, hasBgm, bgmPath, captionFilters = [], outputPath
}) {
  if (!Array.isArray(segmentPaths) || segmentPaths.length !== SCENE_COUNT) {
    throw new TypeError(`Exactly ${SCENE_COUNT} rendered scene clips are required.`);
  }
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-filter_threads', '1', '-filter_complex_threads', '1'];
  const sceneCount = segmentPaths.length;
  const sceneDuration = SCENE_DURATION;
  for (let index = 0; index < sceneCount; index += 1) {
    args.push('-threads', '1', '-i', segmentPaths[index]);
  }
  args.push('-threads', '1', '-i', audioPath);
  if (hasBgm) args.push('-stream_loop', '-1', '-threads', '1', '-i', bgmPath);

  const voiceInput = sceneCount;
  const ambientTone = `aevalsrc=0.42*sin(2*PI*110*t)+0.30*sin(2*PI*164.81*t)+0.18*sin(2*PI*220*t):s=48000:c=stereo:d=${OUTPUT_DURATION},volume=0.1,lowpass=f=900[ambient]`;
  const audioFilter = hasBgm
    ? `${ambientTone};[${voiceInput}:a]volume=1[voice];[${voiceInput + 1}:a]volume=0.08[music];[ambient][music]amix=inputs=2:duration=longest:normalize=0[bed];[voice][bed]amix=inputs=2:duration=first:normalize=0[a]`
    : `${ambientTone};[${voiceInput}:a]volume=1[voice];[voice][ambient]amix=inputs=2:duration=first:normalize=0[a]`;
  args.push(
    '-filter_complex', `${audioFilter};${xfadeFilter(captionFilters, sceneCount, sceneDuration)}`,
    '-map', '[v]', '-map', '[a]', '-shortest',
    '-s', `${OUTPUT_WIDTH}x${OUTPUT_HEIGHT}`, '-r', String(FPS),
    '-c:v', 'libx264', '-threads', '1', '-preset', 'ultrafast',
    '-crf', '26', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', outputPath
  );
  return args;
}

function isWithinJobDirectory(jobDir, filePath) {
  if (!filePath) return false;
  const relative = path.relative(path.resolve(jobDir), path.resolve(filePath));
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export async function renderShort({ sceneAssets, audioPath, hook, subtitleBeats, jobDir, signal }) {
  if (!Array.isArray(sceneAssets) || sceneAssets.length !== SCENE_COUNT) {
    throw new TypeError(`Exactly ${SCENE_COUNT} generated scenes are required.`);
  }
  const outputPath = path.join(jobDir, 'final_short.mp4');
  const segmentPaths = sceneAssets.map((_, index) => path.join(jobDir, `segment_${index}.mp4`));
  const captionPaths = [];
  let resolvedAssets = sceneAssets;
  let rendered = false;
  try {
    const fontPath = resolveCaptionFontPath();
    const captionEvents = buildCaptionEvents(subtitleBeats, hook);
    const captionFilters = captionEvents.map((event, index) => {
      const textPath = path.join(jobDir, `caption_${index}.txt`);
      captionPaths.push(textPath);
      fs.writeFileSync(textPath, event.text, 'utf8');
      return buildCaptionFilter(event, fontPath, textPath);
    });
    resolvedAssets = await resolveStockSceneAssets(sceneAssets, jobDir, signal);
    for (let index = 0; index < resolvedAssets.length; index += 1) {
      await renderScene(resolvedAssets[index], index, segmentPaths[index], signal);
    }

    const bgmPath = process.env.OPTIONAL_BGM_PATH;
    const hasBgm = Boolean(bgmPath && fs.existsSync(bgmPath));
    const args = buildFinalRenderArgs({
      segmentPaths, audioPath, hasBgm, bgmPath, captionFilters, outputPath
    });
    await execFileAsync(process.env.FFMPEG_PATH || 'ffmpeg', args, {
      timeout: FFMPEG_TIMEOUT_MS,
      maxBuffer: 50 * 1024 * 1024,
      signal
    });
    rendered = true;
    return outputPath;
  } finally {
    const cleanupPaths = [
      ...segmentPaths,
      ...captionPaths,
      ...resolvedAssets.filter((asset) => asset.type === 'video').map((asset) => asset.path)
    ];
    if (isWithinJobDirectory(jobDir, audioPath)) cleanupPaths.push(audioPath);
    if (!rendered) cleanupPaths.push(outputPath);
    await Promise.all(cleanupPaths.map((filePath) => fs.promises.rm(filePath, { force: true })));
  }
}
