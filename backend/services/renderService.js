import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

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

export function createJobDirectory(channelId) {
  const safeId = channelId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return fs.mkdtempSync(path.join(os.tmpdir(), `dimag_job_${safeId}_`));
}

function assTime(seconds) {
  const centiseconds = Math.max(0, Math.round(seconds * 100));
  const hours = Math.floor(centiseconds / 360000);
  const minutes = Math.floor((centiseconds % 360000) / 6000);
  const remainder = (centiseconds % 6000) / 100;
  return `${hours}:${String(minutes).padStart(2, '0')}:${remainder.toFixed(2).padStart(5, '0')}`;
}

function groupCaptionWords(beat) {
  const words = String(beat).trim().split(/\s+/).filter(Boolean);
  const groups = [];
  while (words.length) {
    const size = words.length <= 3 ? words.length : words.length % 3 === 1 ? 2 : 3;
    groups.push(words.splice(0, size));
  }
  return groups;
}

export function buildAss(beats, hook, duration = OUTPUT_DURATION) {
  if (!Array.isArray(beats) || beats.length !== SCENE_COUNT) {
    throw new TypeError(`Exactly ${SCENE_COUNT} subtitle beats are required.`);
  }
  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: 720
PlayResY: 1280
[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,62,&H00FFFFFF,&H0000FFFF,&H0007070A,&HAA080B12,-1,0,1,4,2,2,42,42,235,1
Style: Hook,Arial,48,&H00FFFFFF,&H0000FFFF,&H0007070A,&HAA080B12,-1,0,1,4,2,8,35,35,70,1
[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  let events = '';
  const safeHook = String(hook || '').replace(/[{}\\]/g, '').replace(/\r?\n/g, ' ');
  events += `Dialogue: 1,${assTime(0)},${assTime(0.55)},Hook,,0,0,0,,${safeHook}\n`;
  const beatDuration = duration / beats.length;
  let captionIndex = 0;
  beats.forEach((beat, beatIndex) => {
    const captions = groupCaptionWords(beat);
    const captionDuration = beatDuration / captions.length;
    captions.forEach((words, index) => {
      const start = beatIndex * beatDuration + index * captionDuration;
      const end = start + captionDuration;
      const activeColor = captionIndex % 2 === 0 ? '&H0000FFFF&' : '&H00FFFF00&';
      const text = words.map((word, wordIndex) => {
        const safeWord = word.replace(/[{}\\]/g, '');
        return wordIndex === 0
          ? `{\\1c${activeColor}\\fscx115\\fscy115}${safeWord}{\\1c&H00FFFFFF&\\fscx100\\fscy100}`
          : safeWord;
      }).join(' ');
      events += `Dialogue: 0,${assTime(start)},${assTime(end)},Default,,0,0,0,,{\\fscx112\\fscy112\\t(0,100,\\fscx100\\fscy100)}${text}\n`;
      captionIndex += 1;
    });
  });
  return header + events;
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
  { c0: '0x070916', beam: '0x5cf4ff', accent: '0xff43c8' },
  { c0: '0x12070b', beam: '0xffb52e', accent: '0xff4268' },
  { c0: '0x04111b', beam: '0x42f6ef', accent: '0x66a4ff' },
  { c0: '0x07130d', beam: '0x78ff9c', accent: '0xd7ff4f' },
  { c0: '0x10091d', beam: '0x9a7cff', accent: '0xff62a8' },
  { c0: '0x0d111b', beam: '0xffdb65', accent: '0x58e6ff' },
  { c0: '0x0c0715', beam: '0xff5b82', accent: '0xffcf5a' },
  { c0: '0x07121d', beam: '0x57f7d8', accent: '0x6e8dff' }
];

function paletteForScene(asset, index) {
  const prompt = asset.prompt.toLowerCase();
  if (/\b(fire|flame|burn|sun|heat|gold)\b/.test(prompt)) return PALETTES[1];
  if (/\b(water|ocean|river|rain|ice|wave)\b/.test(prompt)) return PALETTES[2];
  if (/\b(forest|tree|leaf|nature|garden)\b/.test(prompt)) return PALETTES[3];
  if (/\b(space|star|galaxy|cosmic|night)\b/.test(prompt)) return PALETTES[4];
  return PALETTES[index % PALETTES.length];
}

export function buildProceduralFilter(asset, index) {
  const palette = paletteForScene(asset, index);
  const accentY = 330 + (index % 4) * 32;
  return [
    `drawbox=x=88:y=${accentY}:w=544:h=360:color=${palette.accent}@0.18:t=fill`,
    `drawbox=x=64:y=258:w=592:h=8:color=${palette.beam}@0.8:t=fill`,
    `drawbox=x=64:y=1014:w=592:h=8:color=${palette.beam}@0.8:t=fill`,
    'setsar=1',
    'format=yuv420p'
  ].join(',');
}

export function buildSceneFfmpegArgs(outputPath, asset, index) {
  const palette = paletteForScene(asset, index);
  const source = `color=c=${palette.c0}:s=${OUTPUT_WIDTH}x${OUTPUT_HEIGHT}:r=${FPS}:d=${SCENE_DURATION}`;
  return [
    '-hide_banner', '-loglevel', 'error',
    '-y', '-filter_threads', '1', '-threads', '1', '-f', 'lavfi', '-i', source,
    '-vf', buildProceduralFilter(asset, index),
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

async function renderScene(asset, index, outputPath, signal) {
  if (asset?.type !== 'procedural' || typeof asset.prompt !== 'string' || !asset.prompt.trim()) {
    throw new TypeError(`Scene ${index} is not a valid procedural scene.`);
  }
  await renderProceduralScene(asset, outputPath, index, signal);
  return outputPath;
}

function xfadeFilter(subtitleFile, sceneCount = SCENE_COUNT, sceneDuration = SCENE_DURATION) {
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
  const subtitleFilterPath = subtitleFile.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
  filters.push(`[${previous}]scale=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:flags=fast_bilinear,fps=${FPS},format=yuv420p,subtitles='${subtitleFilterPath}'[v]`);
  return filters.join(';');
}

export function buildFinalRenderArgs({ segmentPaths, audioPath, hasBgm, bgmPath, subtitleFile, outputPath }) {
  if (!Array.isArray(segmentPaths) || segmentPaths.length !== SCENE_COUNT) {
    throw new TypeError(`Exactly ${SCENE_COUNT} rendered scene clips are required.`);
  }
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-filter_complex_threads', '1'];
  const sceneCount = segmentPaths.length;
  const sceneDuration = SCENE_DURATION;
  for (let index = 0; index < sceneCount; index += 1) {
    args.push('-threads', '1', '-i', segmentPaths[index]);
  }
  args.push('-threads', '1', '-i', audioPath);
  if (hasBgm) args.push('-stream_loop', '-1', '-threads', '1', '-i', bgmPath);

  const voiceInput = sceneCount;
  const audioFilter = hasBgm
    ? `[${voiceInput}:a]volume=1[voice];[${voiceInput + 1}:a]volume=0.126[music];[voice][music]amix=inputs=2:duration=first[a]`
    : `[${voiceInput}:a]anull[a]`;
  args.push(
    '-filter_complex', `${audioFilter};${xfadeFilter(subtitleFile, sceneCount, sceneDuration)}`,
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
  const subtitleFile = path.join(jobDir, 'subtitles.ass');
  const outputPath = path.join(jobDir, 'final_short.mp4');
  const segmentPaths = sceneAssets.map((_, index) => path.join(jobDir, `segment_${index}.mp4`));
  let rendered = false;
  try {
    fs.writeFileSync(subtitleFile, buildAss(subtitleBeats, hook), 'utf8');
    for (let index = 0; index < sceneAssets.length; index += 1) {
      await renderScene(sceneAssets[index], index, segmentPaths[index], signal);
    }

    const bgmPath = process.env.OPTIONAL_BGM_PATH;
    const hasBgm = Boolean(bgmPath && fs.existsSync(bgmPath));
    const args = buildFinalRenderArgs({
      segmentPaths, audioPath, hasBgm, bgmPath, subtitleFile, outputPath
    });
    await execFileAsync(process.env.FFMPEG_PATH || 'ffmpeg', args, {
      timeout: FFMPEG_TIMEOUT_MS,
      maxBuffer: 50 * 1024 * 1024,
      signal
    });
    rendered = true;
    return outputPath;
  } finally {
    const cleanupPaths = [...segmentPaths, subtitleFile];
    if (isWithinJobDirectory(jobDir, audioPath)) cleanupPaths.push(audioPath);
    if (!rendered) cleanupPaths.push(outputPath);
    await Promise.all(cleanupPaths.map((filePath) => fs.promises.rm(filePath, { force: true })));
  }
}
