import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { AppModule } from './app.module';
import { PrismaService } from './prisma/prisma.service';
import { createGuestAuthGate, GateUser } from './middleware/guestAuth';
import { JwtService } from '@nestjs/jwt';

// TS compiles `import()` to `require` under CommonJS; this keeps it a real
// dynamic import so the ESM handlers in spotme/web/api load correctly.
const dynamicImport = new Function('p', 'return import(p)') as (p: string) => Promise<{ default?: unknown }>;

/** The slice of the Express response the bridge itself touches. */
type BridgeResponse = {
  headersSent: boolean;
  status: (n: number) => { json: (b: unknown) => void };
};

/**
 * Bridge the existing Vercel serverless handlers (spotme/web/api/*.js) onto
 * this server at the same /api/* paths. They are plain (req, res) functions —
 * Express-compatible — and each degrades gracefully when its vendor env vars
 * are absent, exactly as it does on Vercel. `username` is deliberately NOT
 * bridged: the registry now lives in the User table (username.controller.ts).
 */
async function mountWebApiBridge(app: INestApplication) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { json } = require('express') as { json: (o?: unknown) => unknown };
  // Voice cloning posts audio, so the default 100kb limit is too small.
  const jsonBody = json({ limit: '8mb' });
  const express = app.getHttpAdapter().getInstance();
  // Overridable because the deployed image lays these out differently from the
  // repo. Getting this wrong is silent: the handlers simply never mount and
  // every /api/* call 404s at runtime — which is exactly how translation,
  // TURN credentials and voice cloning were dead in production while every
  // local test passed.
  const apiDir = process.env.WEB_API_DIR || join(process.cwd(), '..', 'web', 'api');

  /* THE DELETED-ACCOUNT CHECK THE BRIDGED HANDLERS DO NOT DO.
   *
   * Each handler verifies its own token, which proves the token was signed by
   * us and nothing more. Whether the account still EXISTS is a database
   * question none of them asks — so a purged user's access token went on
   * working here for its full remaining lifetime, while `/api/auth/*` refused
   * it. One gate in front of all five, so the next handler someone bridges
   * inherits it instead of having to remember. */
  const prisma = app.get(PrismaService);
  const jwt = app.get(JwtService);
  const gate = createGuestAuthGate(async (token: string): Promise<GateUser | null> => {
    const payload = jwt.verify<{ sub?: string }>(token, {
      secret: process.env.JWT_ACCESS_SECRET,
    });
    if (!payload?.sub) return null;
    return prisma.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, username: true, deletedAt: true },
    });
  });
  /* `turn` is deliberately NOT gated. It is fetched once at boot, BEFORE
   * onboarding can have produced a token, and `readyRTC()` caches its result
   * for the life of the page — so a 401 there would pin a session to STUN-only
   * relaying for reasons that have nothing to do with the caller. It is
   * unauthenticated today and that is its own finding, recorded in the handoff;
   * it wants a fix that does not depend on a token existing yet. */
  const GATED = new Set(['translate', 'voice', 'knock', 'presence']);
  // `push` is NOT bridged: PushController owns /api/push now. The old handler
  // stored subscriptions in Upstash and had the sender poke the recipient,
  // which the server can do better and more honestly from the event log.
  for (const name of ['turn', 'translate', 'voice', 'knock', 'presence']) {
    try {
      const mod = await dynamicImport(pathToFileURL(join(apiDir, `${name}.js`)).href);
      const handler = mod.default;
      if (typeof handler !== 'function') continue;
      // These routes are registered before Nest installs its own body parser
      // (that happens during listen()), and Express runs middleware in
      // registration order — so without this the handlers see req.body
      // undefined and answer "need q" to a request that plainly had one.
      const guards = GATED.has(name) ? [jsonBody, gate] : [jsonBody];
      express.all(`/api/${name}`, ...guards, (req: unknown, res: BridgeResponse) => {
        Promise.resolve((handler as (rq: unknown, rs: unknown) => unknown)(req, res)).catch((e: unknown) => {
          // Log the detail, return none of it. This used to answer 500 with the
          // raw error message, which for a vendor proxy names the vendor, the
          // model and often the pricing tier — the exact thing translate.js
          // takes care never to relay from its own catch block. The handlers
          // answer their own errors; anything reaching here is a bug in ours.
          // eslint-disable-next-line no-console
          console.error(`api bridge: /api/${name} threw:`, e);
          // A handler that already answered (or double-sent) leaves headers
          // flushed; writing again throws ERR_HTTP_HEADERS_SENT and turns a
          // handled failure into an unhandled rejection.
          if (res.headersSent) return;
          res.status(500).json({ error: 'service unavailable' });
        });
      });
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(`web api bridge: ${name} not mounted:`, e instanceof Error ? e.message : String(e));
    }
  }
}

async function bootstrap() {
  /* REFUSE TO BOOT WITH A SIGNING KEY ANYONE CAN READ.
   *
   * Six places sign or verify with `process.env.JWT_ACCESS_SECRET ||
   * 'dev-only-secret'`. That fallback is published in this repository, so if the
   * variable is ever unset or blank on the host, the server comes up looking
   * completely healthy while anyone who has seen the source can forge
   * `{ sub: <any user id>, role: 'ADMIN' }` and be that person, or be staff.
   *
   * A missing secret is a deployment mistake, and the moment to find out is at
   * boot, in the logs, not afterwards. */
  const jwtSecret = process.env.JWT_ACCESS_SECRET;
  if (!jwtSecret || jwtSecret.length < 32) {
    throw new Error(
      'JWT_ACCESS_SECRET must be set to at least 32 characters. ' +
        'Refusing to boot: the fallback signing key is public, and anyone could mint admin tokens with it.',
    );
  }

  const app = await NestFactory.create(AppModule, { cors: true });

  /* THE BUILD IDENTITY. A hash of this backend's SOURCE, computed at build time
   * by scripts/build-id.mjs and written into dist/BUILD_ID.
   *
   * It exists so a test can prove the process it is talking to was built from
   * the source in front of it. Hashing the ARTEFACT would prove nothing — a
   * stale dist/ hashes itself and matches — and a stale dist/ that looked
   * plausible is exactly what hid the incremental-build bug, where the build
   * emitted nothing and still exited 0.
   *
   * SAFE BY CONSTRUCTION: a hash of file paths and contents. No secret, no
   * environment value, no path, no dependency inventory. Anyone can recompute
   * it from a checkout, which is the whole point. Registered on the raw adapter
   * so it sits outside the global prefix logic and cannot pick up guards that
   * would make it unavailable to a health check.
   *
   * Absent in a source-run (ts-node, nest start) — reported as 'unknown'
   * rather than crashing, and the e2e proof fails on 'unknown', which is
   * correct: that is not the artefact under test. */
  const buildId = (() => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { readFileSync } = require('fs') as typeof import('fs');
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { join } = require('path') as typeof import('path');
      return readFileSync(join(__dirname, 'BUILD_ID'), 'utf8').trim();
    } catch {
      return 'unknown';
    }
  })();
  app
    .getHttpAdapter()
    .getInstance()
    .get('/api/version', (_req: unknown, res: { json: (b: unknown) => void }) => {
      res.json({ buildId });
    });
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
  );
  app.setGlobalPrefix('api');

  /* Encrypted media slices arrive as raw bytes, not JSON.
   *
   * Registered HERE, before listen() installs Nest's own JSON parser, for the
   * same reason the web-api bridge below is: Express runs middleware in
   * registration order, so a later raw parser would never see the request and
   * the route would get an empty `req.body` — a silent failure that looks like
   * "the upload did nothing". 16 MB is one 8 MB slice plus headroom; it is
   * ciphertext, so nothing here inspects it. */
  {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { raw } = require('express') as { raw: (o?: unknown) => unknown };
    app.getHttpAdapter().getInstance().use(
      '/api/v2/media/local',
      raw({ type: '*/*', limit: '16mb' }),
    );
  }

  await mountWebApiBridge(app);
  const port = process.env.PORT ? Number(process.env.PORT) : 4000;
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`Spot Me backend listening on :${port}`);
}
// A bare `bootstrap()` meant any failure to start — Postgres unreachable, port
// taken, the assertion above — died as an unhandled rejection with no usable
// line in the Railway log.
bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('fatal: Spot Me backend failed to start —', err instanceof Error ? err.message : err);
  process.exit(1);
});
