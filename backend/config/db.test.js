import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import test from 'node:test';
import { connectDatabase, disconnectDatabase } from './db.js';

test('database outage fails clearly instead of using non-persistent storage', async () => {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousRender = process.env.RENDER;
  process.env.NODE_ENV = 'test';
  delete process.env.RENDER;

  try {
    await assert.rejects(
      connectDatabase('', {
        localUri: 'mongodb://127.0.0.1:1/dimag-ai-v2-test',
        serverSelectionTimeoutMS: 300
      }),
      /temporary storage is disabled/
    );
  } finally {
    await disconnectDatabase();
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previousRender === undefined) delete process.env.RENDER;
    else process.env.RENDER = previousRender;
  }
});

test('production refuses to start without a configured persistent MongoDB URI', async () => {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousRender = process.env.RENDER;
  process.env.NODE_ENV = 'production';
  delete process.env.RENDER;
  try {
    await assert.rejects(
      connectDatabase(''),
      /temporary storage is disabled/
    );
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previousRender === undefined) delete process.env.RENDER;
    else process.env.RENDER = previousRender;
  }
});
