# Dimag AI V2

A standalone, multi-channel YouTube Shorts studio. The React app is in `frontend/`; the Node.js 22 API and automation worker are in `backend/`.

## Local setup

1. Copy `backend/.env.example` to `backend/.env` and configure a reachable MongoDB URI, Google OAuth, Gemini, and a 32-byte `TOKEN_ENCRYPTION_KEY` (64 hex characters or base64). Set `OAUTH_STATE_SECRET` and `CRON_SECRET` to independent, high-entropy secrets. The backend refuses temporary database storage so connected-channel credentials survive restarts.
2. In Google Cloud, enable YouTube Data API v3 and YouTube Analytics API v2, configure the OAuth consent screen and the redirect URI exactly as `OAUTH_REDIRECT_URI`, and use the read-only, upload, and analytics scopes in the example.
3. Configure `frontend/.env` from `frontend/.env.example`. Set the backend's `FRONTEND_ORIGIN` to a comma-separated list of exact browser origins (for example, `https://your-project.vercel.app,http://localhost:5173`) and set `PUBLIC_APP_URL` to the deployed frontend URL. In Vercel, set `VITE_API_URL` to `https://<your-render-service>.onrender.com/api`; Vite reads it during the build, so redeploy after changing it. The Google OAuth redirect URI must remain the backend's `/api/youtube/oauth2callback` URL.
4. Install dependencies in the root, `backend/`, and `frontend/` using `npm install`, then run `npm run dev` from this directory.
5. Install FFmpeg and ffprobe on the backend host. The renderer defaults to the `ffmpeg` executable and needs FFmpeg's `libx264`, AAC, and subtitles (libass) support.

Gemini generates eight motion-focused 9:16 scene prompts and aligned narration/subtitles. Visuals are created locally with FFmpeg: animated radial gradients, moving light beams, particles, geometric shapes, whip-pan/zoom motion, and short xfade transitions. No image or video inference API is called. The renderer stitches eight 2.75-second scenes at 720×1280 and 24 fps with bold, animated captions. A render error stops publishing rather than substituting a plain fallback.

## Automation

Configure a cron provider to send `POST /api/automation/trigger` with `x-cron-secret: <CRON_SECRET>` (or the `?secret=` query parameter supported by cron-job.org). The worker checks due schedule slots in IST and handles at most one channel per request.

`POST /api/automation/audit-analytics` is protected by the same secret and requires `{ "channelId": "..." }`. The dashboard's manual audit asks for that secret at run time; it is not embedded in the frontend bundle.

Manual publishing uses the selected channel's saved privacy setting. Review that channel's blueprint and upload visibility before publishing.

## Resource and data boundaries

- Channel-specific reads and writes use `channelId`; scripts load only that channel's profile, brain memory, and 30 latest video titles/hooks. Global queries are limited to listing connected channels and reserving distinct schedule slots.
- A MongoDB global render lock serializes generation and uploads across channels.
- Use a persistent MongoDB service such as Atlas for local and Render deployments. Render's ephemeral filesystem is not a database; check the Atlas network access allowlist if the backend cannot connect.
- Connected channels receive the next distinct minute slot in IST. The requested `hour:minute` schema has 1,440 daily slots, so a strict globally unique minute schedule cannot represent more than 1,440 channels; a date-based or finer-grained scheduler is needed if that theoretical limit matters.
- All intermediate voice, video, subtitle, and render files are created in a unique directory under the operating system's temporary directory and removed in a `finally` block after the upload attempt.
- FFmpeg renders eight 2.75-second portrait scenes at 720×1280 and 24 fps, using single-threaded `ultrafast` encoding, yuv420p, and 0.18-second xfade transitions. Locally generated visuals use animated radial palettes, moving beams, particles, geometric outlines, and whip-pan/zoom motion; captions are bold, animated 2–3-word ASS chunks.
- YouTube refresh tokens are encrypted with AES-256-GCM. Keep environment files and secrets out of source control.
