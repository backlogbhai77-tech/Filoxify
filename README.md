# VoltDrop / Filoxify — repaired Vercel deployment

This repair keeps the existing single-page interface and replaces the fragile upload/storage flow.

## What changed

- Files upload directly from the browser to Cloudinary using short-lived signed parameters. Your Cloudinary API secret is never sent to the browser.
- PIN metadata is stored in Upstash Redis, not a process-local JavaScript object, so separate Vercel function instances can retrieve the same transfer.
- Multiple uploaded files are listed on the receive screen.
- Upload errors from the API and Cloudinary are shown instead of silently failing.
- API credentials are read from environment variables.
- The app currently caps a transfer at 100 MB total, each file at 100 MB, and 20 files. Cloudinary account limits still apply.
- PINs expire 15 minutes after upload completion (and unfinished reservations also expire).

## Important security action

The original uploaded `server.js` contained a Cloudinary API key and API secret. Treat that secret as compromised:
1. Open Cloudinary Console and rotate/revoke the exposed API secret.
2. Add the new credentials only to Vercel Environment Variables.
3. Remove the old credentials from Git history if this repository was public or shared. Rotating the secret is still necessary even after removing it from Git.

## Required setup

### 1. Create an Upstash Redis database
Create a Redis database in Upstash and copy its REST URL and REST token.

### 2. Set Vercel environment variables
In **Vercel → Project → Settings → Environment Variables**, add:

- `CLOUDINARY_CLOUD_NAME`
- `CLOUDINARY_API_KEY`
- `CLOUDINARY_API_SECRET` (the newly rotated secret)
- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`

Use the same values for Preview and Production environments as needed. Do not put secrets in `index.html`, `NEXT_PUBLIC_*` variables, or GitHub.

### 3. Deploy
Replace the repository contents with the contents of this ZIP, commit and push, then redeploy in Vercel. The `api/[...path].js` catch-all function routes `/api/*` requests to Express; the static homepage remains `index.html`. Do not add a catch-all rewrite sending every URL to `index.html` or `/server.js`.

### 4. Verify configuration
Open `https://YOUR-DEPLOYMENT/api/health`. It should return `ok: true` and an empty `missing` array. If not, fix the listed environment variables and redeploy.

## Test checklist

Before uploading a real file, open `https://YOUR-DEPLOYMENT/api/health`. It must return JSON (not an HTML page) and show `ok: true`. If it returns HTML/404, verify Vercel Project Settings → Build & Development Settings → Root Directory points to the folder containing `index.html`, `server.js`, `package.json`, `vercel.json`, and `api/`.

1. Open the app and upload one small image or text file.
2. Wait for the PIN to appear.
3. Open the app in a separate/private browser session and enter the PIN.
4. Confirm the file is listed and its Open / Download link works.
5. Repeat with multiple files and a text snippet.
6. Confirm an unknown PIN returns a clear error.

## Limits and known constraints

- The browser sends file bytes directly to Cloudinary, avoiding Vercel's request-body limit for uploads routed through a Vercel Function.
- This build is intentionally configured for 100 MB total per transfer. Cloudinary's account/plan and resource-type limits can be lower. It does **not** claim reliable 500 MB uploads.
- Transfers are temporary and expire after 15 minutes. This is a temporary file-transfer service, not permanent storage.
- PINs are four digits for compatibility with the existing UI. They are convenient but have only 9,000 possible values; avoid using this app for confidential or sensitive documents without adding stronger access controls and rate limiting.
- ZIP bundling is not implemented; files are downloaded individually. The previous `/api/zip` route did not actually create a ZIP.
- If Cloudinary upload succeeds but saving the metadata fails, an orphaned Cloudinary asset may remain until you clean it up.
