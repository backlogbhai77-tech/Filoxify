const express = require('express');
const path = require('path');
const crypto = require('crypto');
const cloudinary = require('cloudinary').v2;
const { Redis } = require('@upstash/redis');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

const requiredEnv = ['CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_UPLOAD_PRESET', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'];
const missingEnv = requiredEnv.filter((key) => !process.env[key]);
const redis = process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
  ? new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN })
  : null;

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true
});

const VAULT_TTL_SECONDS = 15 * 60;
const CLEANUP_RECORD_TTL_SECONDS = 7 * 24 * 60 * 60;
// Cloudinary's configured upload path is capped at 100 MB per file in this app.
// Environment variables can lower limits to suit an account, but never raise them above this provider cap.
function boundedMb(value, fallback, max = 100) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 1 ? Math.min(max, Math.floor(parsed)) * 1024 * 1024 : fallback * 1024 * 1024;
}
const MAX_FILES = Math.max(1, Math.min(20, Number.parseInt(process.env.MAX_FILES || '20', 10) || 20));
const MAX_FILE_BYTES = boundedMb(process.env.MAX_FILE_MB, 100);
const MAX_TOTAL_BYTES = Math.min(boundedMb(process.env.MAX_TOTAL_MB, 100), 100 * 1024 * 1024);
const PIN_KEY = (pin) => `voltdrop:vault:${pin}`;
const CLEANUP_KEY = (pin) => `voltdrop:cleanup:${pin}`;
const EXPIRY_INDEX = 'voltdrop:cleanup-index';
const RATE_KEY = (bucket, key) => `voltdrop:rate:${bucket}:${key}`;

app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.set('X-Frame-Options', 'DENY');
  res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));
app.use(express.static(path.join(__dirname)));

function assertConfigured(res) {
  if (missingEnv.length || !redis) {
    res.status(503).json({ error: 'Server setup incomplete. Configure Cloudinary and Upstash Redis environment variables in Vercel.', missing: missingEnv });
    return false;
  }
  return true;
}
function validPin(pin) { return typeof pin === 'string' && /^\d{4}$/.test(pin); }
function sha256(value) { return crypto.createHash('sha256').update(String(value)).digest('hex'); }
function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  const candidate = (typeof forwarded === 'string' ? forwarded.split(',')[0] : '') || req.headers['x-real-ip'] || req.ip || 'unknown';
  return sha256(String(candidate).trim()).slice(0, 32);
}
async function rateLimit(req, res, bucket, limit, windowSeconds) {
  if (!redis) return true;
  try {
    const key = RATE_KEY(bucket, clientIp(req));
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, windowSeconds);
    if (count > limit) {
      res.set('Retry-After', String(windowSeconds));
      res.status(429).json({ error: 'Too many requests. Please wait a little and try again.' });
      return false;
    }
    return true;
  } catch (err) {
    // Fail closed for PIN lookups and transfer creation if the rate-limit store is unavailable.
    console.error('Rate limiter unavailable:', err.message);
    res.status(503).json({ error: 'Security check temporarily unavailable. Please retry shortly.' });
    return false;
  }
}
function asObject(raw) { return typeof raw === 'string' ? JSON.parse(raw) : raw; }
function normalizePublicId(value) { return String(value || '').replace(/^\/+|\/+$/g, ''); }
function matchesExpectedPublicId(actual, expected, resourceType, originalName) {
  const a = normalizePublicId(actual);
  const e = normalizePublicId(expected);
  if (!a || !e) return false;
  // Cloudinary can append the original file extension to raw assets even when
  // a server-issued public_id is supplied (common for TXT/PDF/ZIP documents).
  // Accept only the exact ID, a folder-qualified exact ID, or that ID plus the
  // extension from the server-reserved filename for raw resources.
  const candidates = [e];
  if (resourceType === 'raw') {
    const match = String(originalName || '').match(/(\.[a-z0-9]{1,10})$/i);
    if (match) candidates.push(e + match[1]);
  }
  return candidates.some(candidate => a === candidate || a.endsWith('/' + candidate));
}
function isCloudinaryUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'res.cloudinary.com' && url.pathname.startsWith(`/${process.env.CLOUDINARY_CLOUD_NAME}/`);
  } catch (_) { return false; }
}
async function reservePin({ uploadToken, expectedFiles }) {
  for (let attempt = 0; attempt < 12; attempt++) {
    const pin = String(1000 + crypto.randomInt(0, 9000));
    const now = Date.now();
    const ok = await redis.set(PIN_KEY(pin), JSON.stringify({
      status: 'uploading', files: [], expectedFiles, uploadTokenHash: sha256(uploadToken), createdAt: now
    }), { nx: true, ex: VAULT_TTL_SECONDS });
    if (ok === 'OK') {
      // A cleanup record exists before uploads begin, so failed/incomplete transfers can also be cleaned up.
      await redis.set(CLEANUP_KEY(pin), JSON.stringify({ files: expectedFiles.map(f => ({ publicId: f.publicId, alternatePublicIds: [`voltdrop_vault/${pin}/${f.publicId}`], resourceType: f.expectedResourceType || 'auto' })) }), { ex: CLEANUP_RECORD_TTL_SECONDS });
      await redis.zadd(EXPIRY_INDEX, { score: now + VAULT_TTL_SECONDS * 1000, member: pin });
      return pin;
    }
  }
  throw new Error('Could not allocate a transfer PIN. Please retry.');
}

async function cleanupExpiredAssets(maxItems = 10) {
  if (!redis) return { checked: 0, deleted: 0 };
  const now = Date.now();
  const pins = await redis.zrange(EXPIRY_INDEX, 0, now, { byScore: true, offset: 0, count: maxItems });
  let deleted = 0;
  for (const pinValue of pins || []) {
    const pin = String(pinValue);
    const cleanupRaw = await redis.get(CLEANUP_KEY(pin));
    if (cleanupRaw) {
      const record = asObject(cleanupRaw);
      let cleanupNeedsRetry = false;
      for (const asset of (record.files || [])) {
        const publicIds = [...new Set([asset.publicId, ...(asset.alternatePublicIds || [])].map(normalizePublicId).filter(Boolean))];
        if (!publicIds.length) continue;
        const types = asset.resourceType && asset.resourceType !== 'auto'
          ? [asset.resourceType, ...['image', 'video', 'raw'].filter(t => t !== asset.resourceType)]
          : ['image', 'video', 'raw'];
        let removed = false;
        let sawError = false;
        for (const publicId of publicIds) {
          for (const resourceType of types) {
            try {
              const result = await cloudinary.uploader.destroy(publicId, { resource_type: resourceType, invalidate: true });
              if (result && result.result === 'ok') { deleted++; removed = true; break; }
            } catch (err) {
              sawError = true;
              console.error('Asset cleanup attempt failed:', err.message);
            }
          }
          if (removed) break;
        }
        // Keep retrying if Cloudinary was unavailable; a missing asset is safe to ignore.
        if (sawError && !removed) cleanupNeedsRetry = true;
      }
      if (cleanupNeedsRetry) {
        await redis.zadd(EXPIRY_INDEX, { score: now + 60 * 60 * 1000, member: pin });
        continue;
      }
    }
    await redis.del(CLEANUP_KEY(pin));
    await redis.zrem(EXPIRY_INDEX, pin);
    // Delete expired metadata too, in case its TTL has not been processed yet.
    await redis.del(PIN_KEY(pin));
  }
  return { checked: (pins || []).length, deleted };
}

app.get('/api/config', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ limits: { maxFileBytes: MAX_FILE_BYTES, maxTotalBytes: MAX_TOTAL_BYTES, maxFiles: MAX_FILES } });
});

app.get('/api/health', async (_req, res) => {
  let redisOk = false;
  try { if (redis) redisOk = (await redis.ping()) === 'PONG'; } catch (_) {}
  res.status(missingEnv.length === 0 && redisOk ? 200 : 503).json({
    ok: missingEnv.length === 0 && redisOk,
    storage: 'Cloudinary',
    metadataStore: redisOk ? 'Upstash Redis connected' : 'unavailable',
    cleanupConfigured: !!(process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET && process.env.CRON_SECRET),
    missing: missingEnv
  });
});

app.post('/api/start', async (req, res) => {
  if (!assertConfigured(res)) return;
  if (!(await rateLimit(req, res, 'start', 8, 600))) return;
  try {
    const files = req.body && req.body.files;
    if (!Array.isArray(files) || files.length < 1) return res.status(400).json({ error: 'Select at least one file.' });
    if (files.length > MAX_FILES) return res.status(400).json({ error: `Maximum ${MAX_FILES} files per transfer.` });
    let total = 0;
    for (const file of files) {
      const size = Number(file && file.size);
      if (!Number.isSafeInteger(size) || size < 1 || size > MAX_FILE_BYTES) return res.status(413).json({ error: `A file exceeds the configured ${Math.floor(MAX_FILE_BYTES / 1048576)} MB per-file limit or has an invalid size.` });
      total += size;
    }
    if (total > MAX_TOTAL_BYTES) return res.status(413).json({ error: `Combined file size exceeds the configured ${Math.floor(MAX_TOTAL_BYTES / 1048576)} MB per-transfer limit.` });
    if (!process.env.CLOUDINARY_UPLOAD_PRESET) return res.status(503).json({ error: 'Missing CLOUDINARY_UPLOAD_PRESET in Vercel environment variables.' });

    // Run a small bounded cleanup batch during normal traffic as a fallback to the scheduled cleanup.
    cleanupExpiredAssets(3).catch(err => console.error('Opportunistic cleanup failed:', err.message));

    const uploadToken = crypto.randomBytes(32).toString('hex');
    const expectedFiles = files.map((file, index) => ({
      name: String(file.name || `file-${index + 1}`).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 255),
      type: String(file.type || 'application/octet-stream').slice(0, 150),
      size: Number(file.size),
      publicId: `file_${index + 1}_${crypto.randomBytes(10).toString('hex')}`,
      expectedResourceType: String(file.type || '').startsWith('video/') ? 'video' : (String(file.type || '').startsWith('image/') ? 'image' : 'raw')
    }));
    const pin = await reservePin({ uploadToken, expectedFiles });
    const uploads = expectedFiles.map((file) => ({
      name: file.name, type: file.type, size: file.size,
      cloudName: process.env.CLOUDINARY_CLOUD_NAME,
      uploadPreset: process.env.CLOUDINARY_UPLOAD_PRESET,
      folder: `voltdrop_vault/${pin}`,
      publicId: file.publicId,
      resourceType: 'auto'
    }));
    res.set('Cache-Control', 'no-store');
    res.json({ pin, uploadToken, uploads });
  } catch (err) {
    console.error('Start upload failed:', err.message);
    res.status(500).json({ error: 'Could not start upload. Check server configuration and try again.' });
  }
});

app.post('/api/complete', async (req, res) => {
  if (!assertConfigured(res)) return;
  try {
    const { pin, uploadToken, files } = req.body || {};
    if (!validPin(pin) || typeof uploadToken !== 'string' || uploadToken.length !== 64 || !Array.isArray(files) || files.length < 1 || files.length > MAX_FILES) {
      return res.status(400).json({ error: 'Invalid transfer metadata or missing upload authorization.' });
    }
    const key = PIN_KEY(pin);
    const raw = await redis.get(key);
    if (!raw) return res.status(410).json({ error: 'Transfer reservation expired. Upload again.' });
    const current = asObject(raw);
    if (!current || current.status !== 'uploading') return res.status(409).json({ error: 'This transfer PIN is not available.' });
    if (!current.uploadTokenHash || !crypto.timingSafeEqual(Buffer.from(sha256(uploadToken), 'hex'), Buffer.from(current.uploadTokenHash, 'hex'))) {
      return res.status(403).json({ error: 'Upload authorization failed. Start a new transfer.' });
    }
    if (!Array.isArray(current.expectedFiles) || files.length !== current.expectedFiles.length) {
      return res.status(400).json({ error: 'Uploaded file count does not match the reserved transfer.' });
    }
    const safeFiles = files.map((file, index) => {
      const expected = current.expectedFiles[index];
      if (!file || !isCloudinaryUrl(file.url) || !matchesExpectedPublicId(file.publicId, expected.publicId, expected.expectedResourceType, expected.name)) {
        throw new Error('A returned asset did not match the server-issued upload identifiers.');
      }
      const actualSize = Number(file.bytes);
      if (!Number.isSafeInteger(actualSize) || actualSize !== expected.size) throw new Error('An uploaded file size did not match the reserved file size.');
      const resourceType = ['image', 'video', 'raw'].includes(file.resourceType) ? file.resourceType : expected.expectedResourceType;
      return {
        name: expected.name,
        type: expected.type,
        size: expected.size,
        url: file.url,
        publicId: normalizePublicId(file.publicId),
        resourceType
      };
    });
    const now = Date.now();
    await redis.set(key, JSON.stringify({ status: 'ready', files: safeFiles, createdAt: current.createdAt || now, expiresAt: now + VAULT_TTL_SECONDS * 1000 }), { ex: VAULT_TTL_SECONDS });
    await redis.set(CLEANUP_KEY(pin), JSON.stringify({ files: safeFiles.map(f => ({ publicId: f.publicId, resourceType: f.resourceType })) }), { ex: CLEANUP_RECORD_TTL_SECONDS });
    await redis.zadd(EXPIRY_INDEX, { score: now + VAULT_TTL_SECONDS * 1000, member: pin });
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, pin, expiresIn: VAULT_TTL_SECONDS });
  } catch (err) {
    console.error('Complete upload failed:', err.message);
    res.status(400).json({ error: err.message.includes('did not match') || err.message.includes('size did not match') ? err.message : 'Files uploaded but transfer could not be verified. Please start a new transfer.' });
  }
});

app.get('/api/check/:pin', async (req, res) => {
  if (!assertConfigured(res)) return;
  if (!(await rateLimit(req, res, 'lookup', 12, 60))) return;
  const pin = req.params.pin;
  if (!validPin(pin)) return res.status(400).json({ error: 'Enter a valid 4-digit PIN.' });
  try {
    const raw = await redis.get(PIN_KEY(pin));
    if (!raw) return res.status(404).json({ error: 'Invalid PIN or transfer expired.' });
    const item = asObject(raw);
    if (item.status !== 'ready' || !Array.isArray(item.files) || !item.files.length) return res.status(409).json({ error: 'Upload is still processing. Try again shortly.' });
    res.set('Cache-Control', 'no-store');
    res.json({ files: item.files.map((file, index) => ({ name: file.name, type: file.type, size: file.size, index })) });
  } catch (err) {
    console.error('PIN lookup failed:', err.message);
    res.status(500).json({ error: 'Could not retrieve transfer. Please try again.' });
  }
});

app.get('/api/view/:pin/:index', async (req, res) => {
  if (!assertConfigured(res)) return;
  if (!(await rateLimit(req, res, 'view', 40, 60))) return;
  const { pin } = req.params;
  const index = Number(req.params.index);
  if (!validPin(pin) || !Number.isInteger(index) || index < 0 || index >= MAX_FILES) return res.status(400).send('Invalid transfer link.');
  try {
    const raw = await redis.get(PIN_KEY(pin));
    if (!raw) return res.status(404).send('Transfer expired or PIN not found.');
    const item = asObject(raw);
    const file = item.files && item.files[index];
    if (item.status !== 'ready' || !file || !file.url || !isCloudinaryUrl(file.url)) return res.status(404).send('File not found.');
    res.set('Cache-Control', 'no-store');
    return res.redirect(302, file.url);
  } catch (err) {
    console.error('File lookup failed:', err.message);
    return res.status(500).send('Could not retrieve file.');
  }
});

// Vercel Cron can call this endpoint with Authorization: Bearer $CRON_SECRET.
app.get('/api/cleanup', async (req, res) => {
  if (!process.env.CRON_SECRET || req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized.' });
  }
  if (!redis) return res.status(503).json({ error: 'Redis is not configured.' });
  if (!process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET) {
    return res.status(503).json({ error: 'Cloudinary API credentials are required for asset cleanup.' });
  }
  try {
    const result = await cleanupExpiredAssets(50);
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('Scheduled cleanup failed:', err.message);
    res.status(500).json({ error: 'Cleanup failed. Check server logs.' });
  }
});

app.get('/api/zip/:pin', (_req, res) => res.status(501).json({ error: 'ZIP bundling is not enabled. Download files individually.' }));
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));
module.exports = app;
