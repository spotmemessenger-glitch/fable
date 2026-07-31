import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { AppModule } from './app.module';

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
      express.all(`/api/${name}`, jsonBody, (req: unknown, res: BridgeResponse) => {
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
  const app = await NestFactory.create(AppModule, { cors: true });
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
bootstrap();
