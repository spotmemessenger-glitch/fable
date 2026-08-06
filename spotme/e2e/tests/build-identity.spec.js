/**
 * Proves the backend under test was built from THIS source.
 *
 * WHY THIS IS NOT PARANOIA. `npm run build` in spotme/backend used to emit
 * nothing and exit 0 — nest-cli deleted dist/ while tsconfig's incremental
 * build-info survived outside it, so TypeScript concluded the output was
 * current. The failure was invisible precisely because a stale dist/ looks
 * exactly like a fresh one. Asserting "dist/main.js exists" does not catch it;
 * asserting that the RUNNING process reports the CURRENT source's identity does.
 *
 * The build id is a hash of source paths and contents, computed by
 * scripts/build-id.mjs at build time. It is safe to expose — no secret, no
 * environment value, no path, no dependency inventory — and it is recomputed
 * here independently rather than read from dist/, so this test does not trust
 * the artefact it is checking.
 */
import { test, expect } from '@playwright/test'
import { API } from '../playwright.config.js'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

/** Recomputed from source, by the same script the build uses. Independent of
 *  whatever happens to be sitting in dist/. */
const expected = execFileSync('node', ['scripts/build-id.mjs'], {
  cwd: new URL('../../backend', import.meta.url).pathname,
  encoding: 'utf8',
}).trim()

test('the build identity is a real hash, not a placeholder', () => {
  expect(expected).toMatch(/^[a-f0-9]{16}$/)
})

test('THE RUNNING BACKEND REPORTS THE CURRENT SOURCE IDENTITY', async ({ request }) => {
  const res = await request.get(`${API}/api/version`)
  expect(res.ok(), 'the version endpoint must be reachable').toBe(true)
  const { buildId } = await res.json()

  // 'unknown' means the process was started from source rather than from the
  // compiled artefact. That is not what this suite is for.
  expect(buildId, 'the backend was not started from a compiled dist/').not.toBe('unknown')
  expect(buildId,
    'the running backend was built from DIFFERENT source than this checkout — ' +
    'a stale dist/ is being served, which is the incremental-build bug this exists to catch')
    .toBe(expected)
})

test('…and the artefact on disk agrees, so nothing is being served from memory', () => {
  const onDisk = readFileSync(new URL('../../backend/dist/BUILD_ID', import.meta.url).pathname, 'utf8').trim()
  expect(onDisk).toBe(expected)
})

test('the version endpoint leaks nothing else', async ({ request }) => {
  const body = await (await request.get(`${API}/api/version`)).json()
  // Exactly one field. A version endpoint that grows an env dump or a dependency
  // list is a reconnaissance surface, and it grows one commit at a time.
  expect(Object.keys(body)).toEqual(['buildId'])
})
