import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const execFileAsync = promisify(execFile);
const SCENE_COUNT = 8;
const SCENE_DURATION = 2.75;
const TRANSITION_DURATION = 0.18;
const FPS = 24;
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
    '-an',
    outputPath
  ];
}

const PALETTES = [
  { c0: '0x070916', c1: '0x31104f', c2: '0x0b3450', c3: '0x11182d', beam: '0x5cf4ff', accent: '0xff43c8' },
  { c0: '0x12070b', c1: '0x6a1e16', c2: '0x422008', c3: '0x1b1019', beam: '0xffb52e', accent: '0xff4268' },
  { c0: '0x04111b', c1: '0x064c68', c2: '0x12356c', c3: '0x091326', beam: '0x42f6ef', accent: '0x66a4ff' },
  { c0: '0x07130d', c1: '0x1d582e', c2: '0x264b58', c3: '0x101a22', beam: '0x78ff9c', accent: '0xd7ff4f' },
  { c0: '0x10091d', c1: '0x44206c', c2: '0x152d67', c3: '0x111126', beam: '0x9a7cff', accent: '0xff62a8' },
  { c0: '0x0d111b', c1: '0x344452', c2: '0x58401f', c3: '0x171526', beam: '0xffdb65', accent: '0x58e6ff' },
  { c0: '0x0c0715', c1: '0x4b1641', c2: '0x5b2820', c3: '0x17101d', beam: '0xff5b82', accent: '0xffcf5a' },
  { c0: '0x07121d', c1: '0x173b6d', c2: '0x1f605f', c3: '0x0b1725', beam: '0x57f7d8', accent: '0x6e8dff' }
];

function paletteForScene(asset, index) {
  const prompt = asset.prompt.toLowerCase();
  if (/\b(fire|flame|burn|sun|heat|gold)\b/.test(prompt)) return PALETTES[1];
  if (/\b(water|ocean|river|rain|ice|wave)\b/.test(prompt)) return PALETTES[2];
  if (/\b(forest|tree|leaf|nature|garden)\b/.test(prompt)) return PALETTES[3];
  if (/\b(space|star|galaxy|cosmic|night)\b/.test(prompt)) return PALETTES[4];
  return PALETTES[index % PALETTES.length];
}

function proceduralFilter(asset, index) {
  const palette = paletteForScene(asset, index);
  const phase = (index * 0.73).toFixed(2);
  const filters = [
    `drawbox=x='280+380*sin(t*3+${phase})':y=0:w=170:h=1422:color=${palette.beam}@0.16:t=fill`,
    `drawbox=x='320+250*cos(t*4+${phase})':y=0:w=54:h=1422:color=${palette.accent}@0.12:t=fill`,
    `drawbox=x='280+180*sin(t*2.2+${phase})':y='250+160*cos(t*2.8+${phase})':w=260:h=260:color=${palette.accent}@0.76:t=9`,
    `drawbox=x='350+180*cos(t*2.5+${phase})':y='900+200*sin(t*3.1+${phase})':w=220:h=220:color=${palette.beam}@0.74:t=8`,
    `drawbox=x='400+300*sin(t*4+${phase})':y='700+500*cos(t*3+${phase})':w=9:h=9:color=${palette.beam}@0.92:t=fill`,
    `drawbox=x='400+300*cos(t*5+${phase})':y='700+500*sin(t*4+${phase})':w=7:h=7:color=${palette.accent}@0.94:t=fill`,
    `drawbox=x='400+350*sin(t*3+${phase})':y='710+500*cos(t*5+${phase})':w=8:h=8:color=${palette.beam}@0.9:t=fill`,
    `drawbox=x='400+250*cos(t*4+${phase})':y='710+500*sin(t*7+${phase})':w=6:h=6:color=${palette.accent}@0.9:t=fill`,
    `rotate='0.012*sin(t*3+${phase})':c=black`,
    `zoompan=z='min(zoom+0.002,1.14)':x='(iw-iw/zoom)*(0.5+0.48*sin(on/7+${phase}))':y='(ih-ih/zoom)*(0.5+0.12*sin(on/12+${phase}))':d=1:s=720x1280:fps=${FPS}`,
    'vignette=PI/5:eval=frame',
    'eq=contrast=1.12:saturation=1.28',
    'setsar=1',
    'format=yuv420p'
  ];
  return filters.join(',');
}

async function renderProceduralScene(asset, outputPath, index) {
  const palette = paletteForScene(asset, index);
  const source = [
    `gradients=s=800x1422:r=${FPS}:d=${SCENE_DURATION}`,
    `c0=${palette.c0}:c1=${palette.c1}:c2=${palette.c2}:c3=${palette.c3}`,
    `n=4:type=radial:speed=${0.08 + (index % 4) * 0.025}`
  ].join(':');
  await execFileAsync(process.env.FFMPEG_PATH || 'ffmpeg', [
    '-hide_banner', '-loglevel', 'error',
    '-y', '-filter_threads', '1', '-f', 'lavfi', '-i', source,
    '-vf', proceduralFilter(asset, index),
    '-frames:v', String(FRAME_COUNT),
    ...encodeArgs(outputPath)
  ], { timeout: 120000, maxBuffer: 50 * 1024 * 1024 });
}

async function renderScene(asset, index, jobDir) {
  const outputPath = path.join(jobDir, `segment_${index}.mp4`);
  if (asset?.type !== 'procedural' || typeof asset.prompt !== 'string' || !asset.prompt.trim()) {
    throw new TypeError(`Scene ${index} is not a valid procedural scene.`);
  }
  await renderProceduralScene(asset, outputPath, index);
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
  filters.push(`[${previous}]fps=${FPS},format=yuv420p,subtitles='${subtitleFilterPath}'[v]`);
  return filters.join(';');
}

export async function renderShort({ sceneAssets, audioPath, hook, subtitleBeats, jobDir }) {
  if (!Array.isArray(sceneAssets) || sceneAssets.length !== SCENE_COUNT) {
    throw new TypeError(`Exactly ${SCENE_COUNT} generated scenes are required.`);
  }
  const subtitleFile = path.join(jobDir, 'subtitles.ass');
  const output = path.join(jobDir, 'final_short.mp4');
  fs.writeFileSync(subtitleFile, buildAss(subtitleBeats, hook), 'utf8');
  const segmentPaths = [];
  for (let index = 0; index < sceneAssets.length; index += 1) {
    segmentPaths.push(await renderScene(sceneAssets[index], index, jobDir));
  }

  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-filter_complex_threads', '1'];
  const sceneCount = sceneAssets.length;
  const sceneDuration = SCENE_DURATION;
  for (let index = 0; index < sceneCount; index += 1) {
    args.push('-threads', '1', '-i', segmentPaths[index]);
  }
  args.push('-threads', '1', '-i', audioPath);
  const hasBgm = Boolean(process.env.OPTIONAL_BGM_PATH && fs.existsSync(process.env.OPTIONAL_BGM_PATH));
  if (hasBgm) args.push('-stream_loop', '-1', '-threads', '1', '-i', process.env.OPTIONAL_BGM_PATH);

  const voiceInput = sceneCount;
  const audioFilter = hasBgm
    ? `[${voiceInput}:a]volume=1[voice];[${voiceInput + 1}:a]volume=0.126[music];[voice][music]amix=inputs=2:duration=first[a]`
    : `[${voiceInput}:a]anull[a]`;
  args.push(
    '-filter_complex', `${audioFilter};${xfadeFilter(subtitleFile, sceneCount, sceneDuration)}`,
    '-map', '[v]', '-map', '[a]', '-shortest',
    '-c:v', 'libx264', '-threads', '1', '-preset', 'ultrafast',
    '-crf', '26', '-pix_fmt', 'yuv420p', '-r', String(FPS),
    '-c:a', 'aac', '-b:a', '128k', output
  );
  await execFileAsync(process.env.FFMPEG_PATH || 'ffmpeg', args, { timeout: 300000, maxBuffer: 50 * 1024 * 1024 });
  return output;
}
