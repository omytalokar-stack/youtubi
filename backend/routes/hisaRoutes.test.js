import assert from 'node:assert/strict';
import express from 'express';
import test from 'node:test';
import HisaJob from '../models/HisaJob.js';
import { createHisaScenePrompts } from '../services/hisaScenePrompts.js';
import hisaRoutes from './hisaRoutes.js';

test('all Hisa endpoints require the CRON_SECRET in x-hisa-secret', async (t) => {
  const previousSecret = process.env.CRON_SECRET;
  process.env.CRON_SECRET = 'test-hisa-secret';
  const app = express();
  app.use(express.json());
  app.use('/api/hisa', hisaRoutes);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => {
    server.close();
    if (previousSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previousSecret;
  });

  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}/api/hisa`;
  const nextJob = await fetch(`${baseUrl}/next-job`);
  assert.equal(nextJob.status, 401);

  const completeJob = await fetch(`${baseUrl}/complete-job/not-a-job`, { method: 'POST' });
  assert.equal(completeJob.status, 401);

  const enqueueTest = await fetch(`${baseUrl}/enqueue-test`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}'
  });
  assert.equal(enqueueTest.status, 400);
});

test('creates the configured number of Flow scene prompts, defaulting to three', (t) => {
  const previousCount = process.env.FLOW_SCENES_COUNT;
  t.after(() => {
    if (previousCount === undefined) delete process.env.FLOW_SCENES_COUNT;
    else process.env.FLOW_SCENES_COUNT = previousCount;
  });

  const sourcePrompts = Array.from({ length: 8 }, (_, index) => `scene ${index + 1}`);
  delete process.env.FLOW_SCENES_COUNT;
  assert.equal(createHisaScenePrompts(sourcePrompts).length, 3);

  process.env.FLOW_SCENES_COUNT = '1';
  assert.equal(createHisaScenePrompts(sourcePrompts).length, 1);
  process.env.FLOW_SCENES_COUNT = '5';
  assert.equal(createHisaScenePrompts(sourcePrompts).length, 5);
  process.env.FLOW_SCENES_COUNT = '6';
  assert.throws(() => createHisaScenePrompts(sourcePrompts), /FLOW_SCENES_COUNT/);
});

test('next-job returns exactly the worker jobId and scenePrompts fields', async (t) => {
  const previousSecret = process.env.CRON_SECRET;
  const originalFindOne = HisaJob.findOne;
  const scenePrompts = Array.from(
    { length: Number(process.env.FLOW_SCENES_COUNT || 3) },
    (_, index) => `prompt ${index + 1}`
  );
  process.env.CRON_SECRET = 'test-hisa-secret';
  HisaJob.findOne = () => ({
    sort: async () => ({ _id: 'worker-job-123', scenePrompts })
  });

  const app = express();
  app.use('/api/hisa', hisaRoutes);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => {
    server.close();
    HisaJob.findOne = originalFindOne;
    if (previousSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previousSecret;
  });

  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/hisa/next-job`, {
    headers: { 'x-hisa-secret': 'test-hisa-secret' }
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    job: { jobId: 'worker-job-123', scenePrompts }
  });
});
