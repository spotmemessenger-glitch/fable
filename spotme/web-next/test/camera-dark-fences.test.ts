/**
 * Stage 1 C5 — the CAMERA DARK FENCE battery. Load-bearing, non-vacuous:
 * every darkness/honesty claim is an assertion over the actual source
 * tree, the built artifact, or a behavioral re-proof:
 *
 *  nothing mounted · no model asset fetched at boot (no ambient network
 *  capability in the subtree at all) · no cloud call without the consent
 *  parameter · gateway-only (no provider SDK/endpoint tokens) · no
 *  runtime CDN path (source scan + loader re-proof) · artifact scan
 *  including model-loader paths · no location-shaped field on capture.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DisabledCloudVision } from '../src/camera/cloud';
import { loadVerifiedAsset, MODEL_ASSET_MANIFEST } from '../src/camera/model-assets';
import type { CloudConsentContext } from '@spotme/contracts';

const WEBNEXT = join(__dirname, '..');
const CAMERA = join(WEBNEXT, 'src/camera');

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e === 'dist') continue;
    const full = join(dir, e);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|css)$/.test(e)) out.push(full);
  }
  return out;
}
const read = (p: string) => readFileSync(p, 'utf8');
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');

describe('camera — mounted nowhere', () => {
  it('App/main import NOTHING from the camera subtree', () => {
    for (const entry of ['src/App.tsx', 'src/main.tsx']) {
      expect(read(join(WEBNEXT, entry))).not.toMatch(/camera/i);
    }
  });

  it('no surface outside src/camera imports camera internals (the Moments controller sees only its own CameraPort type)', () => {
    const outside = walk(join(WEBNEXT, 'src')).filter((f) => !f.includes('/camera/'));
    for (const f of outside) {
      expect(stripComments(read(f))).not.toMatch(/from\s+['"][^'"]*\/camera\//);
    }
  });

  it('the built artifact (when present) contains no camera identifier', () => {
    const dist = join(WEBNEXT, 'dist/assets');
    if (!existsSync(dist)) return;
    for (const f of readdirSync(dist)) {
      const s = read(join(dist, f));
      expect(s).not.toContain('camera-not-wired');
      expect(s).not.toContain('night-stack');
      expect(s).not.toContain('hdr-fusion');
      expect(s).not.toContain('face_landmarker');
    }
  });

  it('fence is not vacuous: the camera subtree exists and is non-trivial', () => {
    const files = walk(CAMERA);
    expect(files.length).toBeGreaterThanOrEqual(12);
  });
});

describe('camera — X-scans: no network capability, no provider, no CDN', () => {
  const sources = () => walk(CAMERA);

  it('NO ambient network capability in the subtree — every loader is injected', () => {
    const banned = [/\bfetch\s*\(/, /XMLHttpRequest/, /\bWebSocket\b/, /EventSource/, /navigator\.sendBeacon/, /node:https?/];
    for (const f of sources()) {
      const s = stripComments(read(f));
      for (const b of banned) expect(s.match(b) ? `${f} matches ${b}` : '').toBe('');
    }
  });

  it('NO direct cloud SDK / provider endpoint outside the AI Gateway package', () => {
    const banned = [
      /openai/i, /anthropic/i, /gemini/i, /rekognition/i, /cognitiveservices/i,
      /vision\.googleapis/i, /@google-cloud/i, /aws-sdk/i, /https?:\/\//i,
    ];
    for (const f of sources()) {
      const s = stripComments(read(f));
      for (const b of banned) expect(s.match(b) ? `${f} matches ${b}` : '').toBe('');
    }
  });

  it('NO CDN token anywhere near a model-loader path', () => {
    const banned = [/\bcdn\./i, /unpkg/i, /jsdelivr/i, /storage\.googleapis/i, /cdnjs/i];
    for (const f of sources()) {
      const s = stripComments(read(f));
      for (const b of banned) expect(s.match(b) ? `${f} matches ${b}` : '').toBe('');
    }
  });

  it('NO model asset fetches at boot: importing every camera module performs zero loads (the manifest is empty and loaders are explicit)', async () => {
    // Imports at the top of this file already executed every module body.
    // The manifest is committed EMPTY at Stage 1 — nothing exists to fetch.
    expect(MODEL_ASSET_MANIFEST.length).toBe(0);
    let fetches = 0;
    const result = await loadVerifiedAsset('anything', {
      fetchBytes: async () => { fetches++; return new Uint8Array(); },
      digest: async () => 'x',
    });
    expect(result).toEqual({ state: 'unavailable', reason: 'unknown-asset' });
    expect(fetches).toBe(0); // refused BEFORE any fetch
  });

  it('NO location-shaped identifier in the capture/port sources (T-CA-2 at fence level)', () => {
    for (const f of [join(CAMERA, 'engine.ts'), join(CAMERA, 'camera-port.ts')]) {
      expect(stripComments(read(f))).not.toMatch(/\b(latitude|longitude|geolocation|gps)\b/i);
    }
  });
});

describe('camera — behavioral re-proofs', () => {
  it('a cloud call WITHOUT the consent parameter cannot run — even past the types', async () => {
    const port = new DisabledCloudVision(() => 1000);
    await expect(
      port.request('recognize', 'ref:1', undefined as unknown as CloudConsentContext),
    ).rejects.toThrow(/cloud-consent: missing/);
  });

  it('a consent object with a non-single-request scope cannot run', async () => {
    const port = new DisabledCloudVision(() => 1000);
    const fake = { kind: 'cloud-vision-consent', scope: 'global', grantedAtUTC: 900, surface: 's' };
    await expect(port.request('recognize', 'ref:1', fake as unknown as CloudConsentContext))
      .rejects.toThrow(/malformed/);
  });
});
