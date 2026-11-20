# Dimag AI V2 — Project ki Detailed Report

**Report ki scope:** Yeh report `dimag-ai-v2/` wale multi-channel YouTube Shorts Studio par based hai. Vercel par isi project ka `frontend/` deploy hota hai. Workspace ke top-level `src/` mein ek alag/legacy frontend bhi hai; use is report ke deployed V2 architecture ke saath mix na karein.

## 1. Ek nazar mein

Dimag AI V2 ek web app hai jo YouTube creators ko apne channel ki style set karne, analytics dekhne, AI se Shorts ke ideas/scripts banane aur generated Short ko YouTube par upload ya schedule karne mein madad karta hai.

Iske teen mukhya parts hain:

1. **Frontend:** React + TypeScript + Vite; user ko studio, channel selector, forms aur progress status dikhata hai.
2. **Backend:** Node.js + Express; Google/YouTube APIs, Gemini, video rendering aur scheduling ko coordinate karta hai.
3. **Persistent data:** MongoDB; channel profile, encrypted YouTube credentials, brain memory, video records aur render lock save karta hai.

Deployed arrangement mein frontend Vercel par aur API alag Node service par chalti hai (README mein Render ka setup diya hai). Frontend build ke waqt `VITE_API_URL` se backend API ka pata set hota hai.

## 2. Technology aur folder structure

| Hissa | Technology / zimmedari |
|---|---|
| UI | React 19, TypeScript, Vite, Lucide icons, custom CSS |
| API | Node.js 22+, Express 4 |
| Database | MongoDB + Mongoose |
| AI text/chat | Google Gemini API (`@google/genai`) |
| Voice | Gemini text-to-speech; generated audio ko FFmpeg se MP3 banaya jata hai |
| Video | FFmpeg / ffprobe; portrait scenes, captions, transitions aur audio mix |
| YouTube | Google OAuth, YouTube Data API v3, YouTube Analytics API v2 |
| PWA | Web app manifest, service worker, browser install support |

```text
dimag-ai-v2/
  frontend/
    src/App.tsx                 app layout aur tab selection
    src/context/AppContext.tsx  selected channel aur shared app data
    src/components/             sidebar, dialogs aur studio tabs
    src/lib/api.ts              frontend se backend API calls
    public/                     icons, manifest aur offline app shell
  backend/
    server.js                   Express API start aur MongoDB connection
    routes/                     HTTP endpoints
    services/                   OAuth, Gemini, analytics, queue, render, upload
    models/                     MongoDB schemas
    assets/fonts/               bundled Devanagari caption font
```

## 3. User app mein kya karta hai

### Analytics

- Channel ke total views, subscribers, watch time aur video count dikhte hain.
- Recent videos ki views, likes, CTR, average view duration aur watch-time details YouTube se sync hoti hain; kuch Analytics metrics permission/data availability par depend karte hain.
- **Run Auto-Audit Now** backend ko latest channel performance analyze karne ko kehta hai. Is UI action ke liye operator backend ka `CRON_SECRET` type karta hai; secret browser bundle mein hard-code nahi hai.

### Channel DNA

Selected channel ke liye alag creative blueprint set hota hai:

- Niche aur content language (Hindi, Hinglish, Marathi, English)
- Tone/style aur optional visual keywords
- Title suffix, fixed description footer aur core tags
- Default upload privacy (private, unlisted, public)

Yeh values AI script prompt aur YouTube upload metadata mein use hoti hain. Profile channel ID se keyed hai, isliye ek channel ke rules doosre channel ke prompt mein use karne ke liye nahi padhe jate.

### Gemini Studio

Yeh selected channel ke niche, language aur tone ke context mein Gemini chat hai. Frontend current conversation ke aakhri messages bhejta hai; backend prompt mein adhiktam pichhle 10 conversation turns shamil karta hai. Naya channel select karne par chat UI history reset hoti hai. Important factual claims publish karne se pehle verify karne chahiye.

### Agent Brain

- Manual **Create & Publish Short Now** flow shuru karta hai.
- Pipeline ki stages dikhata hai: channel learning, writing, rendering, YouTube upload.
- Server-sent events (SSE) se live updates leta hai aur active pipeline ke dauran har 5 second status poll karta hai.
- Winning tactics, mistake rules aur self-correction toggle manage karta hai.

### Settings

- YouTube channels connect/list karna
- PWA install state aur iOS Safari instructions
- Har channel ka daily auto-upload toggle/time (IST)
- OMES mode toggle, frequency/time, manual run aur upload/optimization history
- Upload privacy aur webhook schedule instructions

## 4. YouTube account connect karne ka flow

1. Frontend backend ke `/api/youtube/auth-url` se Google authorization URL mangta hai.
2. Backend YouTube read-only, upload, Analytics read-only aur `youtube.force-ssl` scopes ke saath Google consent flow shuru karta hai. Existing channels ko video editing se pehle updated scope ke liye reconnect/consent dena hota hai.
3. Google redirect ke baad `/api/youtube/oauth2callback` OAuth state signature aur expiry check karta hai.
4. Backend refresh token ko AES-256-GCM se encrypt karke MongoDB mein rakhta hai; token ka IV aur auth tag bhi record ke saath save hota hai.
5. Account ke channel(s) discover hote hain. Har channel ke liye profile aur brain-memory record ensure kiye jate hain.
6. User frontend mein connected channel select karta hai. App channel profile, brain aur initial stats load karta hai.

OAuth redirect URI Google Cloud configuration aur backend `OAUTH_REDIRECT_URI` mein bilkul match hona chahiye. Refresh token na milne par connect operation error deta hai; token plaintext mein database mein save nahi hota.

## 5. Short banane aur upload karne ka end-to-end pipeline

Manual aur scheduled publishing ek hi backend pipeline ka upyog karte hain:

1. **Channel selection / profile:** Selected channel ki profile, automation privacy aur usi channel ka brain memory read hota hai.
2. **Performance learning:** Backend us channel ke latest videos (adhiktam 30) aur analytics metrics mangta hai. Recent performance ke relative winners/underperformers classify karke Gemini se supported patterns aur agle video ki strategy nikalta hai.
3. **Script aur metadata:** Gemini se JSON banwaya jata hai jisme hook, concise topic, title, 55–70 shabdon ka spoken script, loop ending, description, tags, aath scenes aur aath subtitle beats hote hain. Prompt mein usi channel ke aakhri 30 topics/titles/hooks ki strict do-not-repeat list di jati hai. Server weak opening, galat sentence/word counts, loop mismatch, duplicate ya near-duplicate recent topic, duplicate visual query aur subtitle/scene mismatch ko reject karta hai. Gemini ko correction ke liye adhiktam do retries milte hain; phir bhi invalid ho to job fail hoti hai.
4. **Blueprint apply:** Channel ka title suffix, description footer aur core tags generated metadata mein jode/lock kiye jate hain.
5. **Voiceover:** Gemini TTS script ko selected language ke liye voice mein banata hai. Audio ko FFmpeg se MP3 mein convert kiya jata hai.
6. **Visual scenes:** Har scene mein apne spoken sentence se aligned visual search query hoti hai, jisme channel ka configured visual prefix bhi shamil hota hai. Pexels/Pixabay API keys hon to backend vertical MP4 B-roll search karta hai aur current Short aur usi channel ke aakhri 30 logs mein saved media IDs/URLs ko skip karta hai. Alag clip na mile to scene procedural colored visual ban jata hai; ek hi clip ko doosre scene mein repeat nahi kiya jata.
7. **Captions aur render:** Hook 0–2 second tak top par rehta hai; subtitles scene-wise timed word groups hote hain. Aathva sentence ending shot mein aata hai aur script ka final sentence opening se loop karne ke liye likha jata hai. Devanagari font, black outline/shadow aur dark caption box use hote hain; scenes transitions ke saath jod kar voice ke neeche halki synthesized ambient sound mix hoti hai.
8. **YouTube upload:** Video channel ke saved privacy status ke saath upload hota hai. Title/description/tags metadata bheje jate hain.
9. **Record aur cleanup:** Video ID, topic, title, script, hook, tags, publish time aur use hue stock media IDs `VideoLog` mein save hote hain; stats refresh ki koshish hoti hai. Temporary job files success/failure ke baad clean up hote hain.

### Render ki technical details

- 8 scenes × 2.75 seconds, lagbhag 20.7 seconds final duration (overlap transitions ke baad)
- 720 × 1280 portrait, 24 FPS, H.264 (`libx264`), AAC, `yuv420p`
- 0.18-second xfade transitions; har render process par 8 minute timeout
- Single-threaded sequential FFmpeg processing, `ultrafast` preset aur 720p frame size memory ko bounded rakhte hain; existing crop expressions subtle zoom/pan dete hain
- Caption groups chhote timed word-groups hote hain; hook pehle 2 seconds top par, subtitles scene ke beech mein aate hain
- Stock video download par per-clip aur per-job size limits aur approved HTTPS media hosts check hote hain
- Render failure ko khaali/fake video se replace nahi kiya jata; publishing ruk kar error status set hota hai

**Important:** Gemini yahan script/scene descriptions aur voice banata hai. Source code ke mutabik Gemini se actual scene-image/video generation nahi hota. Visual layer ya to configured Pexels/Pixabay portrait clips hai ya FFmpeg ke procedural abstract scenes.

## 6. Analytics se “Brain” kaise seekhta hai

1. YouTube Data API se channel aur recent video metadata/stats milte hain.
2. YouTube Analytics API se available impressions, CTR, average view duration, retention aur watch time mangte hain. Permission ya API restrictions par kuch metrics zero/absent ho sakte hain; code unavailable metrics ko warning karta hai, fabricated values nahi banata.
3. Pichhle videos ke view/impression velocity, CTR, retention, average view duration aur likes-per-view ko usi channel ke medians ke muqable score kiya jata hai. Har ratio ko 3 par cap karke average score banta hai; median ya usse upar score wala video relative “winner” hota hai.
4. Gemini winners/underperformers ka limited sample dekhkar `winningFormula`, `winningTactic`, `mistakeRule`, `nextVideoStrategy` deta hai. Prompt ko correlation ko causation kehne se mana kiya gaya hai; evidence kam ho to explicitly batana hai.
5. Scorecard aur learned notes usi channel ke `BrainMemory` mein save hote hain. Next Short ke prompt mein learning enable ho to yeh memory aur recent titles/hooks repeat se bachne ke liye di jati hai.

Iska matlab “winner” apne channel ke recent sample ke andar relative label hai—viral hone ki guarantee ya doosre channels se benchmark nahi. Topic similarity check token overlap par based hai aur prompt Gemini ko meaning-level repetition se bachne ko bhi kehta hai; paraphrase/synonym ko har baar pakadne ki guarantee nahi. Isi tarah 90%+ APV ya YouTube Repetitious Content decision ko koi prompt/test guarantee nahi kar sakta; actual viewer response aur platform review par nirbhar karta hai.

## 7. Scheduled automation

- Har channel ka IST publish time aur auto-upload enable state profile mein rehta hai.
- OMES ON hone par scheduler us channel ke liye Short generation/upload ko bypass karke latest completed manual upload ko optimize aur Public karta hai. OMES ka apna IST time hai; `daily` roz run karta hai, `alternate` pichhle run se kam-se-kam 44 ghante baad.
- Settings ka manual OMES run wahi secret-protected operation chalata hai, lekin user ko pehle public visibility change confirm karni hoti hai. Private history access aur `videos.update` ke liye `youtube.force-ssl` OAuth scope zaroori hai. Existing Google consent ko reconnect karke refresh karna pad sakta hai; YouTube Studio drafts uploads playlist se hamesha accessible nahi hote.
- `cron-job.org` ya kisi scheduler ko har alag channel IST publish-time par daily `/api/automation/trigger` GET/POST bhejna hota hai. `CRON_SECRET` set ho to sahi `x-cron-secret` header dena zaroori hai.
- `202 Accepted` se pehle due channel queue MongoDB mein save hoti hai; phir due channels ek ke baad ek process hote hain. Render restart se queued/running job ruk jaaye to agla trigger usse original 25-minute schedule window ke baad bhi recover kar sakta hai.
- Schedule ke baad 25 minute tak naya run start hota hai; aaj publish ho chuka channel dobara auto-publish nahi hota. Har channel ka last run status, failure stage, skip reason aur error `/api/automation/status/:channelId` mein restart ke baad bhi milta hai.
- Due channels ek ke baad ek process hote hain; MongoDB global render lock ek samay par ek channel ko render/upload karne deta hai.
- Lock ka TTL 15 minute hai, har minute heartbeat renew hoti hai. Lock lose hone par active render abort karne ki koshish hoti hai.
- Frontend schedule save karna scheduler ko khud se start nahi karta; external cron trigger configure rehna zaroori hai.

## 8. Backend API ka sankshipt naksha

Sab routes `/api` ke neeche hain:

| Route | Kaam |
|---|---|
| `GET /health` | API aur MongoDB connection ka health status |
| `GET /youtube/auth-url` | Google OAuth URL |
| `GET /youtube/oauth2callback` | Google callback, token save, app par redirect |
| `GET /youtube/channels` | Connected channel list |
| `GET /youtube/stats/:channelId` | Channel stats |
| `GET /analytics/:channelId` | Analytics sync |
| `POST /analytics/:channelId/audit` | Secret-protected analytics audit |
| `GET/PUT /profile/:channelId` | Channel profile read/update |
| `PATCH /channels/:channelId/schedule` | Auto-publish schedule update |
| `PUT /channels/:channelId/omes` | Secret-protected OMES configuration update |
| `POST /channels/:channelId/omes/run` | Secret-protected manual optimize/publish |
| `GET /channels/:channelId/omes/history` | Secret-protected recent uploads and OMES audit history |
| `GET/PATCH /brain/:channelId` | Brain memory read/self-correction toggle |
| `POST /brain/tactic`, `POST /brain/mistake` | Manual brain notes |
| `POST /automation/publish/:channelId` | Background manual publish start |
| `GET /automation/status/:channelId` | Pipeline status |
| `GET /automation/events/:channelId` | SSE status stream |
| `GET/POST /automation/trigger` | Secret-protected scheduler trigger |
| `POST /automation/audit-analytics` | Secret-protected audit endpoint |
| `POST /automation/chat` | Channel-context Gemini chat |

API ka MongoDB connection unavailable ho to `/health` 503 deta hai aur business routes ko bhi database-unavailable response milta hai; backend in-memory database fallback use nahi karta.

## 9. Database mein kya save hota hai

- **`YouTubeCredential`:** channel ID/title, thumbnail, encrypted refresh token + IV/auth tag, granted scopes.
- **`ChannelProfile`:** niche/language/tone/visual prefix, metadata rules, privacy, IST schedule aur synced channel totals.
- **`BrainMemory`:** self-correction switch, winning tactics, mistake rules, next strategy aur performance scorecard.
- **`VideoLog`:** uploaded/recent video topic, generated hook/script/tags, analytics metrics aur per-video used stock media IDs.
- **`OmesAuditLog`:** OMES metadata title/tag-count/visibility before-after audit.
- **`AutomationLock`:** global render-worker owner aur lock expiry.

Channel-related records `channelId` se keyed hote hain. Cleanup sirf MongoDB ke log documents par kaam karta hai: 45 din se purane records, har channel ke 50 se zyada history/audit records aur dono log collections mila kar 300 se zyada documents prune hote hain. YouTube videos kabhi delete nahi hote. MongoDB persistent hona chahiye; production ephemeral storage par bharosa nahi karna chahiye.

## 10. Security aur data handling ke design points

- YouTube refresh tokens database mein AES-256-GCM encrypted hote hain; `TOKEN_ENCRYPTION_KEY` 32-byte key hona chahiye.
- OAuth state HMAC-SHA256 signed hota hai, random nonce rakhta hai aur 10 minute ke baad expire hota hai.
- Scheduler/audit triggers `CRON_SECRET` check karte hain. Secret ke bina yeh protected endpoints 503 dete hain.
- OMES settings/history/manual-run endpoints bhi wahi secret header maangte hain; frontend secret ko sirf page memory mein rakhta hai, local storage ya build bundle mein nahi.
- CORS configured browser origins ko allow karta hai, lekin **CORS authentication nahi hota**.
- Script, brain memory aur channel profile per-channel read hote hain; logs/temp job directories channel/job identifiers se alag rakhe jate hain.
- Secret values ko `.env` files ya frontend bundle mein commit nahi karna; report mein sirf variable names diye gaye hain.

**Deployment se pehle dekhne layak access-control point:** `automationRoutes.js` mein manual `/publish/:channelId` aur `/chat` handlers `CRON_SECRET` middleware use nahi karte. Publicly reachable backend ke liye owner ko ensure karna chahiye ki in actions par uchit user authentication/authorization ya equivalent access restriction ho. Sirf CORS is restriction ka substitute nahi hai.

## 11. Run aur deploy ka high-level tareeqa

### Local development

1. `backend/.env.example` ko `backend/.env` aur `frontend/.env.example` ko `frontend/.env` ke roop mein configure karein; real credentials sirf apne local/hosting secret manager mein rakhein.
2. Backend ke liye persistent MongoDB, Google OAuth credentials/scopes, Gemini key aur 32-byte encryption key set karein.
3. Backend aur frontend dependencies install karein:

   ```text
   npm install
   npm --prefix backend install
   npm --prefix frontend install
   ```

4. FFmpeg/ffprobe install karke executable PATH mein rakhein (ya backend env mein paths set karein).
5. Project root se `npm run dev` chalayein. Backend default port `4000`, frontend Vite dev server default port `5173`.

### Production

- Frontend build: `frontend/` ke andar `npm run build` (TypeScript project build + Vite bundle).
- Vercel par `frontend/` project deploy hota hai; `VITE_API_URL` Vite build-time setting hai. Is value ko badalne par frontend redeploy chahiye.
- Backend alag persistent Node.js hosting service par chalta hai aur MongoDB Atlas jaisi persistent database ko connect karta hai.
- Google OAuth redirect URI, `PUBLIC_APP_URL`, backend CORS origins, `FRONTEND_ORIGIN`/`FRONTEND_URL`, Vercel API URL aur scheduler webhook ko ek-doosre se match/configure karna hota hai.
- Scheduler ke liye cron-job.org timezone `Asia/Kolkata` rakhein; har alag channel schedule ke liye us waqt ka daily trigger configure karein.

## 12. PWA / offline vyavahar

App browser se installable PWA hai. Service worker app shell, hashed JS/CSS assets, manifest aur icons cache karta hai. Network na ho to cached shell khul sakta hai; `/api` requests service worker cache nahi karta, isliye offline mode mein live YouTube/Gemini/backend data ya publishing available nahi hoti.

## 13. Current verification aur next steps

- Report banate waqt V2 frontend ka production build successful tha.
- Latest checked production deployment `https://frontend-mu-blush-93.vercel.app` ne HTTP 200 diya.
- GitHub `main` par latest app change commit `7eeed9c` tha.
- Agar app mein channel load nahi hota, pehle backend `/api/health`, MongoDB Atlas allowlist/connection, `VITE_API_URL`, Google OAuth redirect aur backend environment settings check karein.
- Public use badhane se pehle manual publish/chat API access control review karna uchit hai.

