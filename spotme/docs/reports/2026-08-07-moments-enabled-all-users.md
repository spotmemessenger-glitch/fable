# Moments enabled for all verified adults — 2026-08-07

**Outcome: LIVE.** One `RuntimeFlag` row (`key='moments'`, `enabled=true`) opens
the domain to every verified adult. The `DomainAllowlist` was not touched.
Branch `mission/moments-flag-on` off `origin/master`.

## 1. Pre-check — moderation pipeline

Asked before proceeding; owner elected to proceed.

| Question | Answer |
|---|---|
| Does reporting a moment create a row? | **Yes.** `repo.createReport()` writes a `MomentReport`, the target moves `visible → reported`, an audit event is appended. |
| Does it land in a queue? | **Not a real one.** `MomentsService` does `readonly workers = new FixtureMomentWorkers()` inline; no `MOMENT_WORKERS_PORT` binding exists anywhere in `src/`. |
| Is that queue consumed? | **No — and it does not even accumulate**, being in-process memory discarded on restart. What *is* real: `moderationSink.accept()` persists a durable delivery record and emits a greppable, PII-free stderr alert (`MODERATION_ALERT`). Durable and operator-visible; no review workflow. |
| Is NCMEC wired? | **No, on three counts.** `NCMEC_API_KEY` unset → logs "was NOT filed" and returns. With the key, the CyberTipline POST is a bare `// TODO`. And `NcmecService` lives in `ModerationModule`, reachable only from `/api/moderation` and `/api/admin/reports` — **the Moments report path never calls it.** |

`moment-media/moderation.sink.ts` states it plainly: *"no automated screening,
no hash matching, no NCMEC path. Those three are the launch gate for public
availability."* None of the three is met. Recorded as instructed.

## 2–3. Change and deploy

Commit A wired `runEnableMomentsFlag` into `main.ts`; commit B reverted it.
Both were pushed before anything was deployed. `railway up` from the **repo
root**.

Captured from commit A's boot:

```
pre_runtimeflag_rows           : 0
pre_allowlist_count            : 3
before_newaccount_feed         : 404
after_newaccount_feed          : 200
after_newaccount_stories_rail  : 200
yuv2_found / eligible          : true / true
yuv2_feed / stories_rail       : 200 / 200
other_domains_still_dark       : exchange 404, discovery 404, events 404
post_allowlist_count           : 3     (unchanged)
allowlist_unchanged            : true
runtimeflag_rows_all_domains   : ["moments=true"]
```

Commit B was deployed immediately after. `FLAG_ON_BEGIN` appears **0 times** in
the running image's logs and `main.ts` holds no reference to the script.

## 4. End-to-end verification — brand-new account, after the revert

| Check | Result |
|---|---|
| `/v1/moments/feed?mode=friends` | **200** |
| `/v1/moments/stories/rail` | **200** |
| Media upload | **201** |
| Create moment | **201** |
| Asset URL | **200**, absolute, `image/jpeg` |
| Media bytes fetched | **200 `image/jpeg`** |
| Create story | **201** |
| Story appears in rail | **YES** |
| Post appears in feed | **YES**, in `mode=nearby` |
| Exchange / Discovery / Events | **404 each** — only Moments opened |

**On the `friends` feed being empty:** by design, not a defect. A brand-new
account follows nobody, so that feed has nothing in it. The post appears in
`nearby`, which is the mode the app opens on (`let mode = 'nearby'` in
`views/moments.js`).

**Storage confirmed:** asset URLs come back absolute with the correct content
type, so production runs the S3/R2 adapter. The relative-URL and
`octet-stream` defects fixed earlier are local/self-hosted correctness fixes
and were never the production path.

## 5. Revocation

```sql
DELETE FROM "RuntimeFlag" WHERE key = 'moments';
```

One row. Moments returns to dark for everyone within a single 5-second
flag-cache window — no deploy, no restart, no code change.

The three pre-existing `DomainAllowlist` rows survive and keep working: the
gate grants existence on flag **or** allowlist, so the flag made them
redundant, not broken. Revoking the flag returns those three to being the only
accounts with access.

The age gate is unaffected throughout. `requireAdult` runs *after* the flag, so
a non-adult or frozen account still gets 403 — this widened who can see the
surface, never who may bypass 18+.

## Not done

No allowlist change, no other domain's flag, no Vercel change, nothing merged.
Environment variables referenced by name only.
