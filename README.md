# VoltDrop / Filoxify — Phase 1 security hardening

This is an incremental upgrade of the existing v4 project. It preserves the single-page UI, direct browser-to-Cloudinary upload path, four-digit PIN UX, Upstash metadata store, and current 100 MB / 20-file limits.

## Phase 1 changes

- Per-IP Redis rate limits on transfer creation, PIN lookups and file-link requests.
- A random per-transfer upload authorization token. `/api/complete` now requires it and compares it in constant time.
- Server-issued expected file IDs are stored at `/api/start`; `/api/complete` checks the file count, Cloudinary URL host/cloud name, public ID, and actual byte count before making a transfer available.
- Safe DOM text rendering for filenames (no filename interpolation into `innerHTML`).
- Security response headers, no-store headers on transfer responses, and improved `/api/health` that pings Redis.
- Expiry cleanup index and protected `/api/cleanup` endpoint. Cleanup records outlive the short transfer metadata so Cloudinary assets can be deleted after the transfer expires. Normal traffic also processes a small bounded cleanup batch.
- Cloudinary asset cleanup requires `CLOUDINARY_API_KEY` and `CLOUDINARY_API_SECRET` to be configured in Vercel. These secrets stay server-side.

## Required Vercel environment variables

Keep existing variables:
- `CLOUDINARY_CLOUD_NAME`
- `CLOUDINARY_UPLOAD_PRESET`
- `CLOUDINARY_API_KEY`
- `CLOUDINARY_API_SECRET`
- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`

Add `CRON_SECRET` with a long random value in Vercel Production (and Preview only if you want cleanup there). Do not paste the secret into chat or commit it to GitHub. Vercel Cron sends `Authorization: Bearer <CRON_SECRET>` to the configured cleanup endpoint.

The included cron runs daily at 03:00 UTC for compatibility with Vercel Hobby schedules. The endpoint can be called more frequently by an external scheduler if your plan permits; it is protected by `CRON_SECRET`. Expired assets may therefore remain in Cloudinary until cleanup runs, although Redis transfer metadata expires after 15 minutes. Opportunistic cleanup also runs when new transfers are started.

## Deploy safely

1. Download and extract this ZIP.
2. Update the existing files in the repository root; add the new `api/cleanup.js` file.
3. Commit and push, then wait for Vercel deployment to finish.
4. Add `CRON_SECRET` in Vercel Environment Variables and redeploy if you added it after the build.
5. Open `/api/health`; it should return `ok: true`, `metadataStore: "Upstash Redis connected"`, and `cleanupConfigured: true`.
6. Test a small image and a text snippet: upload, receive PIN, fetch from a separate/private browser, open/download, and confirm unknown PIN errors are clear.
7. Do not test rate limits by repeatedly hitting the production site. If testing is needed, use Preview deployment.

## Important constraints and honest limitations

- The four-digit PIN remains for UI compatibility. Rate limits reduce brute-force attempts but do not make a four-digit PIN suitable for highly confidential files. Do not use this service for regulated or highly sensitive data yet.
- The browser still uploads through an unsigned Cloudinary preset. Restrict allowed formats and file size in Cloudinary. An unsigned preset is public; server-side validation cannot stop someone from directly abusing the preset unless the preset/account itself is restricted.
- The cleanup endpoint uses Cloudinary Admin API deletion and therefore needs valid API credentials. Test deletion in a Preview deployment before relying on automated cleanup for production data.
- The daily cron on Vercel Hobby means expired assets can remain in storage for hours. For prompt deletion, use a plan/scheduler that supports more frequent jobs.
- This does not implement resumable uploads, larger files, ZIP bundling, authentication, malware scanning, or a permanent transfer history.
- This patch has been syntax-checked locally but cannot be fully integration-tested against your live Cloudinary/Upstash accounts from here. Deploy to Preview and run the test checklist before promoting it to Production.
