/**
 * Wave 1A — R2 queue-remediation evaluation runner. IN-NETWORK ONLY.
 *
 * Emits ONE JSON object: the Dragonfly cluster topology + the 8-item acceptance
 * result for both connection modes (standalone baseline, cluster candidate).
 * Aggregate metadata only — never a URL, host, or credential.
 *
 *   node dist/scripts/wave1a/run.js
 */

import { probeTopology } from './redis-cluster';
import { runAcceptance } from './queue-accept';
import { ConnMode } from './redis-cluster';

async function main(): Promise<void> {
  const topology = await probeTopology();
  const modes = (process.env.WAVE1A_MODES || 'standalone,cluster').split(',') as ConnMode[];
  const acceptance = [];
  for (const mode of modes) {
    try {
      acceptance.push(await runAcceptance(mode));
    } catch (e) {
      acceptance.push({ mode, connected: false, passed: 0, total: 8, checks: [], error: (e as Error).message });
    }
  }
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ topology, acceptance }));
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    // eslint-disable-next-line no-console
    console.error('wave1a run error:', e instanceof Error ? e.message : e);
    process.exit(1);
  });
