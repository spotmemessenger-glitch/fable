/**
 * Static export build for Hostinger shared hosting.
 * Next.js forbids POST route handlers under `output: "export"`, so the API
 * directory is parked during the build; the exported site calls the
 * Vercel-hosted API instead (NEXT_PUBLIC_AGENT_API).
 */
import { renameSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";

const API = "app/api";
const PARKED = ".api-parked";

if (existsSync(API)) renameSync(API, PARKED);
try {
  execSync("npx next build --turbopack", {
    stdio: "inherit",
    env: {
      ...process.env,
      STATIC_EXPORT: "1",
      NEXT_PUBLIC_AGENT_API: process.env.NEXT_PUBLIC_AGENT_API ?? "https://ysnap.vercel.app",
    },
  });
} finally {
  if (existsSync(PARKED)) renameSync(PARKED, API);
}
