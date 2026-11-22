import 'dotenv/config';
import express from 'express';
import mongoose from 'mongoose';
import { connectDatabase, disconnectDatabase } from './config/db.js';
import { createCorsMiddleware } from './config/cors.js';
import youtubeRoutes from './routes/youtubeRoutes.js';
import analyticsRoutes from './routes/analyticsRoutes.js';
import channelRoutes from './routes/channelRoutes.js';
import automationRoutes from './routes/automationRoutes.js';
import { runScheduledTrigger } from './services/queueWorkerService.js';

const app = express();
app.disable('x-powered-by');
app.use(createCorsMiddleware());
app.use(express.json({ limit: '1mb' }));
app.get('/api/health', (req, res) => {
  const connected = mongoose.connection.readyState === 1;
  res.status(connected ? 200 : 503).json({
    status: connected ? 'ok' : 'unavailable',
    service: 'Dimag AI V2',
    database: connected ? 'connected' : 'disconnected'
  });
});
app.use((req, res, next) => {
  if (mongoose.connection.readyState === 1) return next();
  return res.status(503).json({
    error: 'Database is unavailable. Check MONGODB_URI and Atlas network access; channel data cannot be loaded.'
  });
});
app.use('/api/youtube', youtubeRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api', channelRoutes);
app.use('/api/automation', automationRoutes);
app.use((req, res) => res.status(404).json({ error: 'Route not found.' }));
app.use((error, req, res, next) => {
  console.error(error);
  if (res.headersSent) return next(error);
  res.status(error.status || 500).json({ error: error.message || 'Internal server error.' });
});

const port = Number(process.env.PORT || 4000);
let server;
let shuttingDown = false;
let scheduledWorkerTimer;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.info(`Received ${signal}; shutting down Dimag AI V2.`);
  if (scheduledWorkerTimer) clearInterval(scheduledWorkerTimer);
  if (server) await new Promise((resolve) => server.close(resolve));
  await disconnectDatabase();
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    shutdown(signal).catch((error) => {
      console.error('Unable to shut down cleanly:', error.message);
      process.exitCode = 1;
    });
  });
}

function startServer() {
  server = app.listen(port, () => console.info(`Dimag AI V2 API listening on ${port}.`));
  scheduledWorkerTimer = setInterval(() => {
    if (mongoose.connection.readyState !== 1) return;
    runScheduledTrigger().catch((error) => {
      console.error('Internal scheduled worker check failed:', error);
    });
  }, 10 * 1000);
  scheduledWorkerTimer.unref();
}

connectDatabase().then(startServer).catch((error) => {
  console.error('Database unavailable; starting API in read-disabled mode:', error.message);
  startServer();
});

export default app;
