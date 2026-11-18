import assert from 'node:assert/strict';
import express from 'express';
import test from 'node:test';
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
