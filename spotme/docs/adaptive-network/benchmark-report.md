# Benchmark report — adaptive network production layer (P2D)

**Discipline (V2 §8 / ADR-002):** a number without an environment is not a
result. These are **CPU costs of the production logic** under deterministic
fakes and a manual clock — what a phone's main thread pays per operation —
NOT radio/network measurements (those are the P10 native matrix, ADR-012 §11).

## Recorded run

```
node v22.22.2 · Intel(R) Xeon(R) Processor @ 2.10GHz ×4 · 15.7 GiB RAM
deterministic fakes, manual clock; CPU cost of production logic only

benchmark                                                             n       p50       p95       p99       max
ranking scoreAll (8 candidates)                                       20000   4.3µs     8.9µs     31.5µs    547.1µs
supervisor tick (sample+health+predict+decide enqueue, 4 transports)  10000   4.1µs     11.5µs    42.5µs    4.93ms
migration handoff (connect+attach+resend 5 in-flight)                 2000    21.6µs    52.5µs    100.8µs   6.35ms
mesh convergence 25-node grid corner→corner (CPU per run)             200     2.57ms    3.23ms    9.93ms    22.73ms
mesh convergence 25-node grid (SIMULATED radio ms, mean)              200     8.00ms    (mean — 8 hops × 1ms link latency = the flooding minimum)
receive pipeline accept (dedup+reorder, 33% duplicates)               100000  1.7µs     8.8µs     11.7µs    1.86ms
dedup window accept (rolling eviction)                                200000  1.5µs     2.8µs     3.5µs     1.91ms
outbox drain pass (window-bounded wave over 2k backlog)               66      79.3µs    395.4µs   1.11ms    1.11ms
```

Reproduce: `cd web && node test/bench/adaptive-network.bench.mjs`.

## Against the ADR-012 §11 targets

| Target | Result | Verdict |
|---|---|---|
| Selection < 1 ms for N ≤ 8 | 4.3 µs p50 / 31.5 µs p99 | **pass ×30+ headroom** |
| 0 spurious switches within margin under noise | 6 simulated hours, 10,800 decisions, 0 switches (stress suite) | **pass** |
| Failover ≤ one decision tick on disqualified incumbent | switch fires in the same tick (supervisor suite) | **pass** |
| Mesh delivery ≥ 0.95 within TTL | 25/25 grid nodes reached; corner→corner at the 8-hop minimum | **pass** (sim) |
| Dedup 100 % within window, bounded memory | exactly-once over 5,000 churned envelopes; window ≤ capacity under 50k replay | **pass** |
| Ordering: gaps held until filled | pipeline + stress suites | **pass** |
| BLE end-to-end latency / battery | **deferred to P10 native matrix** — web cannot measure a radio it cannot open | honest gap |

## Battery / CPU / RAM strategy (what keeps these numbers cheap in the field)

- **Passive monitoring:** quality() reads what real traffic already measured;
  no probe frames exist to be sent. The 2 s tick costs ~4 µs.
- **Duty cycling:** scan schedules by battery band with a receive-only floor
  (<15 %); UNAVAILABLE transports are never probed on a timer.
- **Bounded everything:** dedup window, seen-sets (capacity + TTL), event log
  ring, reassembler partials, credit trail, QoS queue with a shed valve —
  every structure has a cap the stress suite hammers.
- **AIMD drain:** the congestion window collapses under failure, so a bad
  link costs retries-per-backoff, not a hot loop; backoff is jittered so a
  fleet cannot thundering-herd.
- **Tree-shaken while dark:** the production bundle contains zero supervisor
  code (string-scanned in CI-able form via the fence + build).
