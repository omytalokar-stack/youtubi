import assert from 'node:assert/strict';
import { once } from 'node:events';
import express from 'express';
import test from 'node:test';
import { createCorsMiddleware } from './cors.js';

async function preflight(origin, configuredOrigins) {
  const app = express();
  app.use(createCorsMiddleware(configuredOrigins));
  app.get('/api/youtube/channels', (req, res) => res.json({ channels: [] }));

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    return await fetch(`http://127.0.0.1:${server.address().port}/api/youtube/channels`, {
      method: 'OPTIONS',
      headers: {
        Origin: origin,
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'content-type'
      }
    });
  } finally {
    server.close();
    await once(server, 'close');
  }
}

test('preflight allows the deployed frontend and configured local development origin', async () => {
  const configuredOrigins = 'http://localhost:5173';

  for (const origin of ['https://frontend-mu-blush-93.vercel.app', 'http://localhost:5173']) {
    const response = await preflight(origin, configuredOrigins);
    assert.equal(response.headers.get('access-control-allow-origin'), origin);
    assert.match(response.headers.get('access-control-allow-headers') || '', /content-type/i);
  }
});

test('preflight does not allow an unconfigured frontend origin', async () => {
  const response = await preflight('https://untrusted.example', 'http://localhost:5173');
  assert.equal(response.headers.get('access-control-allow-origin'), null);
});

test('allows FRONTEND_URL and includes CORS headers on error responses', async () => {
  const app = express();
  app.use(createCorsMiddleware('http://localhost:5173', 'https://configured.example'));
  app.get('/error', (req, res, next) => next(new Error('expected failure')));
  app.use((error, req, res, next) => res.status(500).json({ error: error.message }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    for (const origin of ['https://configured.example', 'https://frontend-mu-blush-93.vercel.app']) {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/error`, { headers: { Origin: origin } });
      assert.equal(response.status, 500);
      assert.equal(response.headers.get('access-control-allow-origin'), origin);
    }
  } finally {
    server.close();
    await once(server, 'close');
  }
});
