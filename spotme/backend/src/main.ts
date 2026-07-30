import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { AppModule } from './app.module';

// TS compiles `import()` to `require` under CommonJS; this keeps it a real
// dynamic import so the ESM handlers in spotme/web/api load correctly.
const dynamicImport = new Function('p', 'return import(p)') as (p: string) => Promise<{ default?: unknown }>;

/**
 * Bridge the existing Vercel serverless handlers (spotme/web/api/*.js) onto
 * this server at the same /api/* paths. They are plain (req, res) functions —
 * Express-compatible — and each degrades gracefully when its vendor env vars
 * are absent, exactly as it does on Vercel. `username` is deliberately NOT
 * bridged: the registry now lives in the User table (username.controller.ts).
 */
async function mountWebApiBridge(app: INestApplication) {
  const express = app.getHttpAdapter().getInstance();
  const apiDir = join(process.cwd(), '..', 'web', 'api');
  // `push` is NOT bridged: PushController owns /api/push now. The old handler
  // stored subscriptions in Upstash and had the sender poke the recipient,
  // which the server can do better and more honestly from the event log.
  for (const name of ['turn', 'translate', 'voice', 'knock', 'presence']) {
    try {
      const mod = await dynamicImport(pathToFileURL(join(apiDir, `${name}.js`)).href);
      const handler = mod.default;
      if (typeof handler !== 'function') continue;
      express.all(`/api/${name}`, (req: unknown, res: { status: (n: number) => { json: (b: unknown) => void } }) => {
        Promise.resolve((handler as (rq: unknown, rs: unknown) => unknown)(req, res)).catch((e: unknown) => {
          res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
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
  await mountWebApiBridge(app);
  const port = process.env.PORT ? Number(process.env.PORT) : 4000;
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`Spot Me backend listening on :${port}`);
}
bootstrap();
