/**
 * Encrypt / decrypt small secrets (exchange API keys) with AES-256-GCM.
 * Key: TRADING_ENCRYPTION_KEY — 32 bytes as 64 hex chars (openssl rand -hex 32).
 * Without it, automated trading stays disabled (nothing can be stored).
 */
const crypto = require('crypto');

function key() {
  const k = process.env.TRADING_ENCRYPTION_KEY || '';
  if (!/^[0-9a-fA-F]{64}$/.test(k)) return null;
  return Buffer.from(k, 'hex');
}

const isConfigured = () => !!key();

function encrypt(plain) {
  const k = key();
  if (!k) throw new Error('TRADING_ENCRYPTION_KEY is not set (64 hex chars)');
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', k, iv);
  const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), enc.toString('base64')].join(':');
}

function decrypt(box) {
  const k = key();
  if (!k) throw new Error('TRADING_ENCRYPTION_KEY is not set');
  const [v, iv, tag, enc] = String(box).split(':');
  if (v !== 'v1') throw new Error('Unknown secret format');
  const d = crypto.createDecipheriv('aes-256-gcm', k, Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(enc, 'base64')), d.final()]).toString('utf8');
}

module.exports = { encrypt, decrypt, isConfigured };
