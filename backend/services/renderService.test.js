import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildCaptionEvents, buildCaptionFilter, buildFinalRenderArgs, buildProceduralFilter,
  buildSceneFfmpegArgs, buildVideoFilter, buildVideoFfmpegArgs, FFMPEG_TIMEOUT_MS,
  FPS, OUTPUT_HEIGHT, OUTPUT_WIDTH, renderShort, resolveCaptionFontPath
} from './renderService.js';

test('builds centered 3-5 word captions with a bundled Devanagari-capable font', () => {
  const events = buildCaptionEvents(
    Array.from({ length: 8 }, () => 'one two three four five six seven'),
    'Mindful breathing starts now'
  );
  const beatCaptions = events.filter((event) => event.position === 'center');
  assert.equal(beatCaptions.length, 16);
  for (const event of beatCaptions) {
    assert.ok(event.text.split(/\s+/).length >= 3 && event.text.split(/\s+/).length <= 5);
    assert.ok(event.end > event.start);
  }
  const fontPath = resolveCaptionFontPath();
  assert.equal(fs.existsSync(fontPath), true);
  const filter = buildCaptionFilter(beatCaptions[0], fontPath, 'caption_0.txt');
  assert.match(filter, /fontfile=/);
  assert.match(filter, /text_shaping=1/);
  assert.match(filter, /fontsize=48/);
  assert.match(filter, /box=1:boxcolor=black@0\.55:boxborderw=18/);
  assert.match(filter, /shadowcolor=black@0\.75/);
});

test('balances long subtitle beats so the final caption does not collapse to one or two words', () => {
  const events = buildCaptionEvents(
    Array.from({ length: 8 }, (_, index) => index === 0
      ? 'one two three four five six seven eight nine ten eleven'
      : 'one two three'),
    ''
  );
  const firstBeatEvents = events.slice(0, 3);
  assert.deepEqual(firstBeatEvents.map((event) => event.text.split(/\s+/).length), [4, 4, 3]);
});

test('requires exactly eight subtitle beats', () => {
  assert.throws(() => buildCaptionEvents(['one beat'], 'Test hook'), /Exactly 8 subtitle beats/);
});

test('requires exactly eight scenes before rendering', async () => {
  const sceneAssets = Array.from({ length: 5 }, (_, index) => ({ type: 'video', path: `clip-${index}.mp4` }));
  await assert.rejects(
    renderShort({ sceneAssets, audioPath: '', hook: '', subtitleBeats: [], jobDir: '' }),
    /Exactly 8 generated scenes/
  );
});

test('builds low-resource 720x1280 24fps FFmpeg commands without expensive filters', () => {
  const asset = { type: 'procedural', prompt: 'A glowing mountain at night' };
  const sceneArgs = buildSceneFfmpegArgs('scene.mp4', asset, 0);
  const sceneFilter = sceneArgs[sceneArgs.indexOf('-vf') + 1];
  const finalArgs = buildFinalRenderArgs({
    segmentPaths: Array.from({ length: 8 }, (_, index) => `scene-${index}.mp4`),
    audioPath: 'voice.mp3',
    hasBgm: false,
    captionFilters: [buildCaptionFilter(
      { text: 'Mindful breathing', start: 0, end: 1, position: 'center' },
      resolveCaptionFontPath(),
      'caption_0.txt'
    )],
    outputPath: 'final.mp4'
  });
  const finalFilter = finalArgs[finalArgs.indexOf('-filter_complex') + 1];
  const argumentsText = [...sceneArgs, ...finalArgs].join(' ');

  assert.equal(OUTPUT_WIDTH, 720);
  assert.equal(OUTPUT_HEIGHT, 1280);
  assert.equal(FPS, 24);
  assert.equal(FFMPEG_TIMEOUT_MS, 480000);
  assert.match(argumentsText, /720x1280/);
  assert.ok(sceneArgs.includes('24'));
  assert.equal(sceneArgs[sceneArgs.indexOf('-preset') + 1], 'ultrafast');
  assert.equal(sceneArgs[sceneArgs.indexOf('-threads') + 1], '1');
  assert.ok(sceneArgs.includes('yuv420p'));
  assert.match(sceneFilter, /drawbox/);
  assert.match(finalArgs.join(' '), /-r 24/);
  assert.match(finalArgs.join(' '), /-threads 1/);
  const videoFilter = buildVideoFilter(1);
  const videoArgs = buildVideoFfmpegArgs('scene.mp4', 'stock.mp4', 1);
  assert.match(sceneFilter, /crop=720:1280/);
  assert.match(sceneArgs[sceneArgs.indexOf('-i') + 1], /s=792x1408/);
  assert.match(videoFilter, /crop=720:1280/);
  assert.match(videoFilter, /eq=brightness=-0\.12:contrast=1\.08:saturation=1\.12/);
  assert.match(videoArgs.join(' '), /720x1280/);
  assert.match(videoArgs.join(' '), /-threads 1/);
  assert.doesNotMatch(
    `${sceneFilter} ${finalFilter} ${videoFilter} ${buildProceduralFilter(asset, 0)}`,
    /zoompan|geq|noise|vignette/i
  );
  assert.match(finalFilter, /drawtext=/);
  assert.match(finalFilter, /aevalsrc=/);
  assert.match(finalFilter, /volume=0\.1/);
});

test('removes partial scene, subtitle, and audio files when a render fails', async () => {
  const jobDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dimag_render_test_'));
  const audioPath = path.join(jobDir, 'voiceover.mp3');
  fs.writeFileSync(audioPath, 'audio');
  const sceneAssets = Array.from({ length: 8 }, () => ({ type: 'procedural', prompt: 'test scene' }));
  sceneAssets[0] = { type: 'invalid', prompt: 'bad scene' };
  const previousPexelsKey = process.env.PEXELS_API_KEY;
  const previousPixabayKey = process.env.PIXABAY_API_KEY;
  delete process.env.PEXELS_API_KEY;
  delete process.env.PIXABAY_API_KEY;
  try {
    await assert.rejects(renderShort({
      sceneAssets,
      audioPath,
      hook: 'hook',
      subtitleBeats: Array.from({ length: 8 }, () => 'one two three four five'),
      jobDir
    }), /Scene 0 is not a valid procedural scene/);
    for (const file of ['segment_0.mp4', 'segment_7.mp4', 'caption_0.txt', 'caption_16.txt', 'voiceover.mp3', 'final_short.mp4']) {
      assert.equal(fs.existsSync(path.join(jobDir, file)), false, `${file} should be removed`);
    }
  } finally {
    fs.rmSync(jobDir, { recursive: true, force: true });
    if (previousPexelsKey === undefined) delete process.env.PEXELS_API_KEY;
    else process.env.PEXELS_API_KEY = previousPexelsKey;
    if (previousPixabayKey === undefined) delete process.env.PIXABAY_API_KEY;
    else process.env.PIXABAY_API_KEY = previousPixabayKey;
  }
});
