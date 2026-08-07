# Backend deploy + Moments grant for @yuv2 — 2026-08-07

**Outcome: deploy succeeded, grant did NOT happen. The script hit its
pre-existing-rows guard and stopped without writing. @yuv2 has no allowlist
row. One owner decision is required before a re-run.**

Branch `mission/moments-grant-yuv2`, based on `origin/master` `fb2c7e0`.
`feat/slice-0-frontend-migration` untouched.

## 1. Restart first — PASS

Redeployed the running image so the seven previously-staged secrets went live.

| Check | Result |
|---|---|
| `/health` | 200 `{"status":"ok"}` |
| `/ready` | 200 `db: up`, `redis: up` |
| Socket.IO handshake | 200, `upgrades:["websocket"]` |
| Sign in (guest auth) | token minted — proves the rotated `JWT_ACCESS_SECRET` is live and correct |
| Moments, non-allowlisted | 404 |

Nothing broke, so the rotation is sound.

## 2–3. Deploy commit A + capture — done, after one self-inflicted retry

`railway up` from the **repo root** (not `spotme/backend`) — no `lstat
snapshot-target-unpack` failure.

**First attempt deployed the wrong script, my error.** `git checkout <A> --
spotme/backend/src/main.ts` restored only `main.ts`, leaving `owner-grant.ts`
at commit B's state (master's `domain='discovery'` version). That run
therefore targeted discovery with the owner email. It returned
`STOP_NO_INVITEE_ACCOUNTS_FOUND` with `pre_allowlist_count: 0`, which is
**before** the upsert — so **nothing was written and no discovery row was
touched**. Corrected by checking out the whole `spotme/backend/src` tree from
A and verifying the diff was empty before redeploying.

## 4. Revert deployed — done before this report

Commit B is live. `OWNER_GRANT_BEGIN` appears **0 times** in the running
image's logs; `main.ts` carries no reference to `runOwnerGrant`. `/health` and
`/ready` green after the revert.

## 5. Result — STOP, owner decision required

```
invitees_located        : ["yu***"]      <- @yuv2 found and ELIGIBLE
invitees_not_eligible   : []             <- age/status are fine
pre_allowlist_count     : 3
pre_allowlist_notes     : ["M1b browser probe (revocable)",
                           "M1b browser probe (revocable)",
                           "owner"]
status                  : STOP_PREEXISTING_ALLOWLIST_ROWS
```

The `moments` allowlist already contained three rows belonging to nobody in
the current invited set. The script refuses to proceed in that state and
deletes nothing — it is the guard doing its job, not a failure.

Consequence: **no row was created for @yuv2, and Moments is still dark for
that account.**

### Verified after the revert

| Assertion | Result |
|---|---|
| @yuv2 → 200 on Moments | **NOT MET** — no row was written |
| Non-allowlisted → 404 on `/v1/moments/feed` | **PASS** |
| RuntimeFlag rows for `moments` | **zero** — none created, no flag flipped |
| Discovery allowlist | untouched |

### The decision

Three rows exist under `domain='moments'`. Two are self-described as
revocable probes; one is `owner`. Options, all owner-retained:

1. Add @yuv2 to `INVITED` alongside the existing rows' owners, so the set
   matches reality and the guard passes.
2. Delete the two probe rows first, keep `owner`, then re-run with both in the
   set.
3. Leave as is.

Nothing here should be decided by removing the guard.

## Not done, per mission

No RuntimeFlag row, no flag flipped, no Vercel change, nothing merged,
`spotme/app` and `spotme/mobile` untouched.

Environment variables referenced by name only. No user id recorded — the
script masks selectors.
