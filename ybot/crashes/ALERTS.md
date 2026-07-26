# Ybot crash alerts — active board

Claude: on seeing this file, triage every [OPEN] line (bundle in inbox/<id>/), then mark it [FIXED]/[DIAGNOSED].

- [DIAGNOSED] 2026-07-24T09:51:04Z `20260724-152104-cded74afae` RuntimeError: SYNTHETIC TEST CRASH: crash-bridge end-to-end verification, not a real bug (count 1, triage spawned) — reported crash was synthetic (raised from a `python -c` one-liner, no ybot frame) — no defect there. BUT the triage hit a real bridge bug: `triage.log` was opened INSIDE the bundle, so on Windows the session's own open handle blocked step 6 and no bundle could ever leave `inbox/`. FIXED in `ybot/crash_reporter.py` (logs now go to `crashes/logs/<id>.log`, parent handle closed). Restart Ybot if running. See `triaged/20260724-152104-cded74afae/triage.md`.
