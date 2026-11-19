# Dimag AI V2

A standalone, multi-channel YouTube Shorts studio. The React app is in `frontend/`; the Node.js 22 API and automation worker are in `backend/`.

## Local setup

1. Copy `backend/.env.example` to `backend/.env` and configure a reachable MongoDB URI, Google OAuth, Gemini, and a 32-byte `TOKEN_ENCRYPTION_KEY` (64 hex characters or base64). Set `OAUTH_STATE_SECRET` and `CRON_SECRET` to independent, high-entropy secrets. The backend refuses temporary database storage so connected-channel credentials survive restarts.
2. In Google Cloud, enable YouTube Data API v3 and YouTube Analytics API v2, configure the OAuth consent screen and the redirect URI exactly as `OAUTH_REDIRECT_URI`, and use the read-only, upload, and analytics scopes in the example.
3. Configure `frontend/.env` from `frontend/.env.example`. Set the backend's `FRONTEND_ORIGIN` and/or `FRONTEND_URL` to comma-separated exact browser origins (for example, `https://your-project.vercel.app,http://localhost:5173`); the deployed `https://frontend-mu-blush-93.vercel.app` origin is always allowed. Set `PUBLIC_APP_URL` to the deployed frontend URL. In Vercel, set `VITE_API_URL` to `https://<your-render-service>.onrender.com/api`; Vite reads it during the build, so redeploy after changing it. The Google OAuth redirect URI must remain the backend's `/api/youtube/oauth2callback` URL.
4. Install dependencies in the root, `backend/`, and `frontend/` using `npm install`, then run `npm run dev` from this directory.
5. Install FFmpeg and ffprobe on the backend host. The renderer defaults to the `ffmpeg` executable and needs FFmpeg's `libx264`, AAC, FreeType drawtext, and crop/scale filters. Optional Pexels or Pixabay API keys enable licensed stock B-roll; bundled Noto Sans Devanagari keeps Latin and Hindi captions available without host font setup.

Gemini generates eight motion-focused 9:16 scene prompts and aligned narration/subtitles. When `PEXELS_API_KEY` or `PIXABAY_API_KEY` is configured, the backend searches for portrait calming B-roll; if no clip is available, it uses locally generated multi-tone scenes with a slow crop-pan. FFmpeg applies a light cinematic grade, centered timed drawtext captions, and a quiet synthesized ambient pad under the narration. The renderer stitches eight 2.75-second scenes at 720×1280 and 24 fps with single-threaded ultrafast encoding and yuv420p output. A render error stops publishing rather than substituting an empty fallback.

## Automation

Configure a cron provider to send `POST /api/automation/trigger` at least once per minute with `x-cron-secret: <CRON_SECRET>` (or the `?secret=` query parameter supported by cron-job.org). The worker checks due schedule slots in IST and uses the native Gemini, voiceover, FFmpeg rendering, and YouTube upload pipeline directly. Manual `POST /api/automation/publish/:channelId` requests return `202 Accepted` while that same pipeline runs in the background.

`POST /api/automation/audit-analytics` is protected by the same secret and requires `{ "channelId": "..." }`. The dashboard's manual audit asks for that secret at run time; it is not embedded in the frontend bundle.

Before each Short, the backend fetches up to 30 recent channel videos, classifies relative winners and underperformers using view/impression velocity, CTR, retention, average view duration, and likes, then saves the performance scorecard and learned formulas/guardrails to that channel's Agent Brain. This requires the YouTube Analytics read-only scope; unavailable analytics metrics are logged and left as zero rather than fabricated. Manual publishing uses the selected channel's saved privacy setting. Review that channel's blueprint and upload visibility before publishing.

## Resource and data boundaries

- Channel-specific reads and writes use `channelId`; scripts load only that channel's profile, brain memory, and 30 latest video titles/hooks. Global queries are limited to listing connected channels and reserving distinct schedule slots.
- A MongoDB global render lock serializes generation and uploads across channels.
- Use a persistent MongoDB service such as Atlas for local and Render deployments. Render's ephemeral filesystem is not a database; check the Atlas network access allowlist if the backend cannot connect.
- Connected channels receive the next distinct minute slot in IST. The requested `hour:minute` schema has 1,440 daily slots, so a strict globally unique minute schedule cannot represent more than 1,440 channels; a date-based or finer-grained scheduler is needed if that theoretical limit matters.
- All intermediate voice, scene, subtitle, and render files are created in a unique directory under the operating system's temporary directory. Scene/audio inputs are removed in render `finally` blocks, partial outputs are removed on failure, and the full job directory is removed after upload.
- FFmpeg renders eight 2.75-second portrait scenes at 720×1280 and 24 fps, using one thread, the `ultrafast` preset, yuv420p, lightweight crop/drawbox/equalizer filters, and 0.18-second xfade transitions. Every render command has an eight-minute timeout. A global render lock has a 15-minute TTL and a one-minute heartbeat; loss of the lock aborts the active FFmpeg process.
- Captions use the bundled Noto Sans Devanagari font through FFmpeg drawtext, with 48px white text, a translucent dark box, shadow, and 3–5-word timed groups. Stock clips are size-limited, downloaded only from the configured provider, and normalized to the same 720×1280/24fps render format.
- YouTube refresh tokens are encrypted with AES-256-GCM. Keep environment files and secrets out of source control.
