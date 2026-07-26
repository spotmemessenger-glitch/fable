# Triage — `20260724-152104-cded74afae`

**Verdict: the reported crash was synthetic (no defect), but carrying out this triage
exposed a real, unrelated defect in the bridge itself — now FIXED.**

## 1. The reported crash — not a bug

```
RuntimeError: SYNTHETIC TEST CRASH: crash-bridge end-to-end verification, not a real bug
```

Evidence it was a deliberate test, not an Ybot failure:

- `traceback.txt` has one frame — `File "<string>", line 6, in <module>` — so the raise came
  from a `python -c` one-liner, not from any module in this repo.
- `crash.json` `argv` is `["-c"]`, confirming the same.
- No `ybot/` frame appears anywhere in the traceback, so no product code path is implicated.

Capture worked exactly as designed: `sys.excepthook` fired (`source: "main"`), the bundle and
fingerprint `cded74afae` were written, dedupe recorded `count: 1`, the spawn budget logged
1 of 3, the lock was taken, `ALERTS.md` got its `[OPEN]` line, and a headless triage session
was spawned. `keys_present` being all `false` is expected, not a finding — the one-liner never
loaded `fable/.env`.

## 2. The real defect — found by hitting it

**Step 6 of the bridge's own protocol could never succeed on Windows.**

`_spawn_triage` opened the triage session's stdout at `crashes/inbox/<id>/triage.log` —
*inside the bundle it tells that same session to move*. The handle stays open for the
session's entire life, and Windows refuses to move a directory containing an open file.

Reproduced directly during this triage:

```
mv: cannot move 'inbox/20260724-152104-cded74afae' -> 'triaged/...': Permission denied
# file-by-file isolates the culprit:
moved crash.json / traceback.txt / triage.md
mv: cannot move '.../triage.log': Device or resource busy
```

Impact: **every** triage session on this machine would file its verdict and then fail to
clear its bundle out of `inbox/`, leaving bundles that look permanently untriaged. The same
handle was also never closed in the parent, so a still-running Ybot leaked it per crash.

### Fix (implemented)

`ybot/crash_reporter.py`

- **line 45** — added `LOGS = CRASHES / "logs"`.
- **lines 148-159** — the log now goes to `crashes/logs/<id>.log`, outside the bundle, and is
  opened in a `with` block so the parent closes its copy once the child has inherited it.
  Comment records why, so it is not "tidied" back inside later.
- **lines 20-23** — docstring folder layout corrected to match.

Verified: `py_compile` OK; `LOGS` resolves to `crashes\logs`; `_spawn_triage` no longer
references `bundle / "triage.log"`; and the bundle directory moved cleanly once the log was
no longer inside it.

Scope note: only the crash path the triage actually exercised was touched. The synthetic
`RuntimeError` itself implicates nothing and no code was changed on its account.

## 3. Restart needed?

**Yes, if Ybot is running** — `crash_reporter` is imported once at `ybot/main.py:4` and
installed at `main.py:16`, so a live process still holds the old `_spawn_triage`. The next
launch picks up the fix. Nothing else needs doing; the reported crash required no restart.

## 4. Known leftover

`crashes/inbox/20260724-152104-cded74afae/triage.log` (and its now-otherwise-empty directory)
could not be removed: it is *this* session's own stdout, locked until this session exits.
It is the last artifact of the old layout and is safe to delete manually. Future crashes are
unaffected — their logs land in `crashes/logs/`.

## 5. Observed during the fix, not mine

`crash_reporter.py` was modified by another process while this triage ran: a new
`_lock_is_stale()` helper (lines 102-117) and a lock payload change from pid to bundle name
(line 129). Those changes are complementary to this fix, not conflicting — flagging them only
so the edits are not mistaken for part of this triage.
