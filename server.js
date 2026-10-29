const express = require('express');
const path = require('path');
const crypto = require('crypto');
const cloudinary = require('cloudinary').v2;
const { Redis } = require('@upstash/redis');

const app = express();
app.disable('x-powered-by');

const requiredEnv = ['CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'];
const missingEnv = requiredEnv.filter((key) => !process.env[key]);

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true
});

const redis = process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
  ? new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN })
  : null;

const VAULT_TTL_SECONDS = 15 * 60;
const MAX_FILES = 20;
const MAX_FILE_BYTES = 100 * 1024 * 1024; // Cloudinary/account limits may be lower.
const MAX_TOTAL_BYTES = 100 * 1024 * 1024;
const PIN_KEY = (pin) => `voltdrop:vault:${pin}`;

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));
app.use(express.static(path.join(__dirname)));

function assertConfigured(res) {
  if (missingEnv.length || !redis) {
    res.status(503).json({
      error: 'Server setup incomplete. Configure Cloudinary and Upstash Redis environment variables in Vercel.',
      missing: missingEnv
    });
    return false;
  }
  return true;
}

function validPin(pin) {
  return typeof pin === 'string' && /^\d{4}$/.test(pin);
}

async function reservePin() {
  for (let attempt = 0; attempt < 12; attempt++) {
    const pin = String(1000 + crypto.randomInt(0, 9000));
    const ok = await redis.set(PIN_KEY(pin), JSON.stringify({
      status: 'uploading',
      files: [],
      createdAt: Date.now()
    }), { nx: true, ex: VAULT_TTL_SECONDS });
    if (ok === 'OK') return pin;
  }
  throw new Error('Could not allocate a transfer PIN. Please retry.');
}

app.get('/api/health', (_req, res) => {
  res.json({
    ok: missingEnv.length === 0 && !!redis,
    storage: 'Cloudinary',
    metadataStore: redis ? 'Upstash Redis' : 'not configured',
    missing: missingEnv
  });
});

// Returns signed Cloudinary upload parameters. The API secret never reaches the browser.
app.post('/api/start', async (req, res) => {
  if (!assertConfigured(res)) return;
  try {
    const files = req.body && req.body.files;
    if (!Array.isArray(files) || files.length < 1) {
      return res.status(400).json({ error: 'Select at least one file.' });
    }
    if (files.length > MAX_FILES) {
      return res.status(400).json({ error: `Maximum ${MAX_FILES} files per transfer.` });
    }
    let total = 0;
    for (const file of files) {
      const size = Number(file && file.size);
      if (!Number.isFinite(size) || size < 0 || size > MAX_FILE_BYTES) {
        return res.status(413).json({ error: 'A file exceeds the configured 100 MB per-file limit.' });
      }
      total += size;
    }
    if (total > MAX_TOTAL_BYTES) {
      return res.status(413).json({ error: 'Combined file size exceeds the configured 100 MB per-transfer limit.' });
    }

    const pin = await reservePin();
    const uploads = files.map((file, index) => {
      const timestamp = Math.floor(Date.now() / 1000);
      const folder = `voltdrop_vault/${pin}`;
      const public_id = `file_${index + 1}_${crypto.randomBytes(5).toString('hex')}`;
      const params = { folder, public_id, timestamp };
      return {
        name: String(file.name || `file-${index + 1}`).slice(0, 255),
        type: String(file.type || 'application/octet-stream').slice(0, 150),
        size: Number(file.size),
        cloudName: process.env.CLOUDINARY_CLOUD_NAME,
        apiKey: process.env.CLOUDINARY_API_KEY,
        resourceType: 'auto',
        params,
        signature: cloudinary.utils.api_sign_request(params, process.env.CLOUDINARY_API_SECRET)
      };
    });
    res.json({ pin, uploads });
  } catch (err) {
    console.error('Start upload failed:', err.message);
    res.status(500).json({ error: 'Could not start upload. Check server configuration and try again.' });
  }
});

// Persist the uploaded file URLs against the PIN so any Vercel instance can retrieve them.
app.post('/api/complete', async (req, res) => {
  if (!assertConfigured(res)) return;
  try {
    const { pin, files } = req.body || {};
    if (!validPin(pin) || !Array.isArray(files) || files.length < 1 || files.length > MAX_FILES) {
      return res.status(400).json({ error: 'Invalid transfer metadata.' });
    }
    const key = PIN_KEY(pin);
    const raw = await redis.get(key);
    if (!raw) return res.status(410).json({ error: 'Transfer reservation expired. Upload again.' });
    const current = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!current || current.status !== 'uploading') {
      return res.status(409).json({ error: 'This transfer PIN is not available.' });
    }
    const safeFiles = files.map((file) => {
      if (!file || typeof file.url !== 'string' || !file.url.startsWith('https://res.cloudinary.com/')) {
        throw new Error('Invalid Cloudinary upload response.');
      }
      return {
        name: String(file.name || 'download').slice(0, 255),
        type: String(file.type || 'application/octet-stream').slice(0, 150),
        size: Number(file.size) || 0,
        url: file.url,
        publicId: String(file.publicId || ''),
        resourceType: String(file.resourceType || 'raw')
      };
    });
    await redis.set(key, JSON.stringify({
      status: 'ready',
      files: safeFiles,
      createdAt: current.createdAt || Date.now()
    }), { ex: VAULT_TTL_SECONDS });
    res.json({ ok: true, pin, expiresIn: VAULT_TTL_SECONDS });
  } catch (err) {
    console.error('Complete upload failed:', err.message);
    res.status(500).json({ error: 'Files uploaded but transfer could not be saved. Please retry.' });
  }
});

app.get('/api/check/:pin', async (req, res) => {
  if (!assertConfigured(res)) return;
  const pin = req.params.pin;
  if (!validPin(pin)) return res.status(400).json({ error: 'Enter a valid 4-digit PIN.' });
  try {
    const raw = await redis.get(PIN_KEY(pin));
    if (!raw) return res.status(404).json({ error: 'Invalid PIN or transfer expired.' });
    const item = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (item.status !== 'ready' || !Array.isArray(item.files) || !item.files.length) {
      return res.status(409).json({ error: 'Upload is still processing. Try again shortly.' });
    }
    res.json({
      files: item.files.map((file, index) => ({
        name: file.name,
        type: file.type,
        size: file.size,
        index
      }))
    });
  } catch (err) {
    console.error('PIN lookup failed:', err.message);
    res.status(500).json({ error: 'Could not retrieve transfer. Please try again.' });
  }
});

app.get('/api/view/:pin/:index', async (req, res) => {
  if (!assertConfigured(res)) return;
  const { pin } = req.params;
  const index = Number(req.params.index);
  if (!validPin(pin) || !Number.isInteger(index) || index < 0 || index >= MAX_FILES) {
    return res.status(400).send('Invalid transfer link.');
  }
  try {
    const raw = await redis.get(PIN_KEY(pin));
    if (!raw) return res.status(404).send('Transfer expired or PIN not found.');
    const item = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const file = item.files && item.files[index];
    if (item.status !== 'ready' || !file || !file.url) return res.status(404).send('File not found.');
    return res.redirect(302, file.url);
  } catch (err) {
    console.error('File lookup failed:', err.message);
    return res.status(500).send('Could not retrieve file.');
  }
});

app.get('/api/zip/:pin', (_req, res) => {
  // This endpoint intentionally does not pretend to create a ZIP. Multiple files
  // are offered individually by the receiver UI until a real ZIP service is added.
  res.status(501).json({ error: 'ZIP bundling is not enabled. Download files individually.' });
});

app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));

module.exports = app;
