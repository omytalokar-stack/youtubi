import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildAss, buildFinalRenderArgs, buildProceduralFilter, buildSceneFfmpegArgs,
  FFMPEG_TIMEOUT_MS, FPS, OUTPUT_HEIGHT, OUTPUT_WIDTH, renderShort
} from './renderService.js';

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

test('rejects external clips instead of bypassing native scene generation', async () => {
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
    subtitleFile: 'captions.ass',
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
  assert.doesNotMatch(`${sceneFilter} ${finalFilter} ${buildProceduralFilter(asset, 0)}`, /zoompan|geq|noise|vignette/i);
});

test('removes partial scene, subtitle, and audio files when a render fails', async () => {
  const jobDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dimag_render_test_'));
  const audioPath = path.join(jobDir, 'voiceover.mp3');
  fs.writeFileSync(audioPath, 'audio');
  const sceneAssets = Array.from({ length: 8 }, () => ({ type: 'procedural', prompt: 'test scene' }));
  sceneAssets[0] = { type: 'invalid', prompt: 'bad scene' };
  try {
    await assert.rejects(renderShort({
      sceneAssets,
      audioPath,
      hook: 'hook',
      subtitleBeats: Array.from({ length: 8 }, () => 'one two three four five'),
      jobDir
    }), /Scene 0 is not a valid procedural scene/);
    for (const file of ['segment_0.mp4', 'segment_7.mp4', 'subtitles.ass', 'voiceover.mp3', 'final_short.mp4']) {
      assert.equal(fs.existsSync(path.join(jobDir, file)), false, `${file} should be removed`);
    }
  } finally {
    fs.rmSync(jobDir, { recursive: true, force: true });
  }
});
