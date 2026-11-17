import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

function encryptionKey() {
  const key = process.env.TOKEN_ENCRYPTION_KEY;
  if (!key) throw new Error('TOKEN_ENCRYPTION_KEY is required.');
  const decoded = /^[a-fA-F0-9]{64}$/.test(key) ? Buffer.from(key, 'hex') : Buffer.from(key, 'base64');
  if (decoded.length !== 32) throw new Error('TOKEN_ENCRYPTION_KEY must be a 64-character hex string or a base64-encoded 32-byte key.');
  return decoded;
}

export function encryptToken(value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return { refreshToken: encrypted.toString('base64'), iv: iv.toString('base64'), authTag: cipher.getAuthTag().toString('base64') };
}

export function decryptToken(record) {
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(record.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(record.authTag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(record.refreshToken, 'base64')),
    decipher.final()
  ]).toString('utf8');
}

export function signOAuthState(payload) {
  const secret = process.env.OAUTH_STATE_SECRET;
  if (!secret) throw new Error('OAUTH_STATE_SECRET is required.');
  const body = Buffer.from(JSON.stringify({ ...payload, nonce: randomBytes(16).toString('hex'), issuedAt: Date.now() })).toString('base64url');
  const signature = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${signature}`;
}

export function verifyOAuthState(state) {
  const secret = process.env.OAUTH_STATE_SECRET;
  if (!secret || typeof state !== 'string') throw new Error('Invalid OAuth state.');
  const [body, signature, extra] = state.split('.');
  if (!body || !signature || extra) throw new Error('Invalid OAuth state.');
  const expected = createHmac('sha256', secret).update(body).digest();
  const actual = Buffer.from(signature, 'base64url');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error('Invalid OAuth state signature.');
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  if (Date.now() - payload.issuedAt > 10 * 60 * 1000 || payload.issuedAt > Date.now() + 30000) throw new Error('OAuth state expired.');
  return payload;
}
