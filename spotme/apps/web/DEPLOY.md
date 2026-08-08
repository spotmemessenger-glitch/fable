# Deploying the Spot Me web app

Two hosts, and they must agree: static app on Vercel, API + realtime gateway on
Railway. The username registry, guest identity and the room gateway are all the
same backend — point the app at the wrong host and you get names claimed in one
place and conversations keyed to ids from another.

## Live

| Piece | URL |
|---|---|
| Web app | https://spotme-messenger.vercel.app |
| Backend API + `/rooms` socket | https://api-production-0a4ca.up.railway.app |
| Railway project | `spotme-backend` (services: `api`, `Postgres`) |

## Deploy

```bash
cd spotme/web
VITE_SPOTME_SERVER="https://api-production-0a4ca.up.railway.app" npx vercel build --prod
npx vercel deploy --prebuilt --prod
```

**Why `--prebuilt` and not a cloud build:** `package.json` depends on
`spotme-core` through a `file:..` path — a directory *outside* this folder. A
Vercel build that only uploads `spotme/web` cannot resolve it. Building locally
resolves the path, then only the output is uploaded.

**Why the env var is set on the build command:** Vite bakes it into the bundle
(`src/lib/api.js`). It is not read at runtime, so changing it means rebuilding.
With it unset the app assumes same-origin, which is what `npm run dev` wants —
Vite proxies `/api` and `/socket.io` to `localhost:4000`.

Two settings in `vercel.json` were previously empty strings, which is why every
path 404'd: with no build command Vercel produced no `dist` to serve.

## Backend

```bash
cd spotme/backend
railway up            # Dockerfile build; migrations run at boot
```

Environment variables live in Railway (`DATABASE_URL` references the Postgres
service, plus the JWT secrets). Nothing secret is committed.

Dormant until their vendor keys are added there: push (`VAPID`/FCM), cloud
translation, voice cloning. Each degrades quietly rather than breaking the app.
