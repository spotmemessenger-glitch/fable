/**
 * Spot Me — end-to-end configuration.
 *
 * WHY THIS EXISTS. Every suite in this repo so far runs a module against a fake.
 * That is the right shape for a state machine or a transcript encoder, and it
 * cannot answer the question A5 actually depends on: does the gate in
 * `rooms.js` refuse a send in a real browser, against a real server. The A5
 * enforcement PR ships a source-level tripwire for that gate and says plainly it
 * is not a proof. This is where the proof goes.
 *
 * DETERMINISTIC BY CONSTRUCTION, not by convention:
 *   - every account is created through /api/auth/guest, where the id, username
 *     and secret are all CLIENT-CHOSEN, so a run's accounts are a pure function
 *     of its run id and cleanup needs no search
 *   - the run id is in every account, so two runs cannot collide and a crashed
 *     run leaves rows that are trivially identifiable
 *   - one worker, no retries locally: a flaky e2e that passes on retry is a
 *     flaky e2e that will pass on retry in CI too, and then nobody looks
 *
 * NO PRODUCTION CREDENTIALS, EVER. The backend is started by this config with a
 * throwaway secret against a throwaway database. There is no code path here that
 * reads a real one, and `secrets` in the CI job is deliberately empty.
 */
import { defineConfig, devices } from '@playwright/test'

const API_PORT = Number(process.env.E2E_API_PORT || 3311)
const WEB_PORT = Number(process.env.E2E_WEB_PORT || 4317)
export const API = `http://127.0.0.1:${API_PORT}`
export const WEB = `http://127.0.0.1:${WEB_PORT}`

/** Throwaway. The backend refuses to boot on anything under 32 characters —
 *  a guard worth keeping, so this is long rather than the guard weakened. */
const E2E_JWT = 'e2e-only-not-a-real-key-0123456789abcdefghijklmnop'
const E2E_DB = process.env.E2E_DATABASE_URL ||
  'postgresql://postgres:postgres@localhost:5432/spotme_e2e?schema=public'

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,          // shared database; ordering beats speed here
  workers: 1,
  forbidOnly: !!process.env.CI,  // a stray .only would silently shrink the suite
  retries: 0,                    // see the header — a retry hides exactly what this suite is for
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],

  use: {
    baseURL: WEB,
    /* ON FAILURE ONLY. A trace per passing test is hundreds of megabytes of
     * artefact nobody opens, and it slows every run to produce evidence for the
     * case that needs none. */
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },

  /* E2E_CHROMIUM lets a sandbox point at a browser it already has.
   *
   * CI downloads its own via `playwright install --with-deps chromium`, which is
   * the normal path and is what the workflow does. Some development containers
   * ship a pinned Chromium and forbid the download; without an override, the
   * suite is simply unrunnable there, which means it stops being run before a
   * change is pushed. An env var costs nothing and keeps the local loop honest.
   *
   * Unset in CI. Deliberately not defaulted to a path — a wrong hard-coded
   * executable would be a confusing failure everywhere else. */
  projects: [{
    name: 'chromium',
    use: {
      ...devices['Desktop Chrome'],
      ...(process.env.E2E_CHROMIUM ? { launchOptions: { executablePath: process.env.E2E_CHROMIUM } } : {}),
    },
  }],

  webServer: [
    {
      /* FROM THE COMPILED ARTEFACT, never `nest start`, `ts-node` or a dev
       * server. The point of this suite is to exercise what actually ships, and
       * a source-run would not have a BUILD_ID at all — which is why the build
       * identity check treats 'unknown' as a failure rather than a skip.
       *
       * `tee` because the log-hygiene spec has to READ what the backend printed.
       * Playwright pipes webServer output to its own reporter, where a test
       * cannot reach it. */
      command: 'sh -c "mkdir -p test-results && node ../backend/dist/main.js 2>&1 | tee test-results/backend.log"',
      url: `${API}/api/username?q=probe`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        DATABASE_URL: E2E_DB,
        JWT_ACCESS_SECRET: E2E_JWT,
        PORT: String(API_PORT),
        NODE_ENV: 'test',
      },
    },
    {
      /* `vite dev`, not a build-then-preview. Vite reads VITE_-prefixed vars
       * from the environment at server start, so pointing the app at this run's
       * backend costs nothing; a preview would need the variable at BUILD time
       * and a full rebuild per run. */
      command: 'npx vite --port ' + WEB_PORT + ' --strictPort --host 127.0.0.1',
      cwd: '../apps/web',
      url: WEB,
      reuseExistingServer: !process.env.CI,
      timeout: 90_000,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { VITE_SPOTME_SERVER: API },
    },
  ],
})
