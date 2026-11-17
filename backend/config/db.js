import mongoose from 'mongoose';

const DEFAULT_LOCAL_URI = 'mongodb://127.0.0.1:27017/dimag-ai-v2';

function logConnectionError(error) {
  console.error('MongoDB connection error:', error.message);
}

export async function connectDatabase(uri = process.env.MONGODB_URI, options = {}) {
  const production = process.env.NODE_ENV === 'production' || Boolean(process.env.RENDER);
  const localUri = options.localUri || DEFAULT_LOCAL_URI;
  const timeout = options.serverSelectionTimeoutMS || 10000;
  const candidates = production ? [uri].filter(Boolean) : [uri, localUri].filter(Boolean);
  const seen = new Set();
  let lastError = null;

  mongoose.connection.off('error', logConnectionError);
  mongoose.connection.on('error', logConnectionError);

  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    try {
      await mongoose.connect(candidate, { serverSelectionTimeoutMS: timeout });
      console.info(candidate === localUri
        ? 'Connected to local MongoDB.'
        : 'Connected to the configured MongoDB database.');
      return;
    } catch (error) {
      lastError = error;
      console.warn(`MongoDB connection failed for ${candidate === localUri ? 'local MongoDB' : 'configured MONGODB_URI'}: ${error.message}`);
    }
  }

  throw new Error(
    `MongoDB is unavailable. Configure a reachable MONGODB_URI or start local MongoDB; temporary storage is disabled so channel credentials are not lost on restart. ${lastError?.message || ''}`.trim()
  );
}

export async function disconnectDatabase() {
  await mongoose.disconnect();
}
