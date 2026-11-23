import assert from 'node:assert/strict';
import { once } from 'node:events';
import express from 'express';
import test from 'node:test';
import { createApiRateLimiter } from './rateLimiter.js';

async function withServer(app, run) {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
    await once(server, 'close');
  }
}

test('limits general API requests and reports when clients may retry', async () => {
  const app = express();
  app.use(createApiRateLimiter({ windowMs: 60_000, max: 1 }));
  app.get('/api/resource', (req, res) => res.json({ ok: true }));

  await withServer(app, async (baseUrl) => {
    const first = await fetch(`${baseUrl}/api/resource`);
    const second = await fetch(`${baseUrl}/api/resource`);
    assert.equal(first.status, 200);
    assert.equal(second.status, 429);
    assert.equal(second.headers.get('ratelimit-limit'), '1');
    assert.ok(Number(second.headers.get('retry-after')) > 0);
  });
});

test('does not strictly limit health, automation trigger, or dashboard GET requests', async () => {
  const app = express();
  app.use(createApiRateLimiter({ windowMs: 60_000, max: 1 }));
  app.all(['/api/health', '/api/automation/trigger'], (req, res) => res.sendStatus(204));
  app.get('*', (req, res) => res.sendStatus(204));
  app.post('/api/analytics/:channelId/audit', (req, res) => res.sendStatus(204));

  await withServer(app, async (baseUrl) => {
    for (const path of [
      '/api/health',
      '/api/automation/trigger',
      '/api/youtube/channels',
      '/api/youtube/stats/UCaaaaaaaaaaaaaaaaaaaaaa',
      '/api/analytics/UCaaaaaaaaaaaaaaaaaaaaaa',
      '/api/dna/UCaaaaaaaaaaaaaaaaaaaaaa',
      '/api/agent/UCaaaaaaaaaaaaaaaaaaaaaa',
      '/api/settings/UCaaaaaaaaaaaaaaaaaaaaaa',
      '/api/profile/UCaaaaaaaaaaaaaaaaaaaaaa',
      '/api/brain/UCaaaaaaaaaaaaaaaaaaaaaa',
      '/api/automation/status/UCaaaaaaaaaaaaaaaaaaaaaa',
      '/api/automation/events/UCaaaaaaaaaaaaaaaaaaaaaa',
      '/api/channels/omes/UCaaaaaaaaaaaaaaaaaaaaaa/history'
    ]) {
      for (let request = 0; request < 2; request += 1) {
        const response = await fetch(`${baseUrl}${path}`);
        assert.equal(response.status, 204, path);
      }
    }
    const auditUrl = `${baseUrl}/api/analytics/UCaaaaaaaaaaaaaaaaaaaaaa/audit`;
    assert.equal((await fetch(auditUrl, { method: 'POST' })).status, 204);
    assert.equal((await fetch(auditUrl, { method: 'POST' })).status, 429);
  });
});

test('trust proxy uses the client address instead of a shared proxy address', async () => {
  const app = express();
  app.set('trust proxy', 1);
  app.use(createApiRateLimiter({ windowMs: 60_000, max: 1 }));
  app.get('/api/resource', (req, res) => res.json({ ok: true }));

  await withServer(app, async (baseUrl) => {
    for (const clientIp of ['198.51.100.10', '198.51.100.11']) {
      const response = await fetch(`${baseUrl}/api/resource`, {
        headers: { 'X-Forwarded-For': clientIp }
      });
      assert.equal(response.status, 200);
    }
  });
});
