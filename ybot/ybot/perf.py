"""Latency instrumentation: measure first, optimise second.

Off by default and effectively free when off — `span()` returns a shared no-op
object, so an uninstrumented run pays one attribute lookup per call site and
allocates nothing. Enable with YBOT_PERF=1.

Durations are kept as raw samples per span name so we can report percentiles
rather than means. A mean hides the thing that actually hurts a desktop agent:
the occasional 2-second accessibility-tree walk that makes the assistant feel
broken, while the average still reads fine.

Usage:

    from .perf import span, report, dump

    with span("screen.capture"):
        ...
    with span("screen.capture.resize"):   # dotted names nest in the report
        ...

    report()             # table to stdout
    dump("before.json")  # machine-readable, for A/B against a later run
"""
from __future__ import annotations

import json
import os
import time
from collections import defaultdict
from contextlib import contextmanager
from typing import Iterator

ENABLED = os.environ.get("YBOT_PERF", "").strip().lower() in ("1", "true", "yes", "on")

_samples: dict[str, list[float]] = defaultdict(list)
_counters: dict[str, int] = defaultdict(int)


class _NoOp:
    """Returned when instrumentation is off. Cheaper than a generator-based CM."""

    __slots__ = ()

    def __enter__(self) -> "_NoOp":
        return self

    def __exit__(self, *exc) -> bool:
        return False


_NOOP = _NoOp()


@contextmanager
def _timed(name: str) -> Iterator[None]:
    t0 = time.perf_counter()
    try:
        yield
    finally:
        _samples[name].append((time.perf_counter() - t0) * 1000.0)


def span(name: str):
    """Time a block of code. No-op unless YBOT_PERF is set."""
    if not ENABLED:
        return _NOOP
    return _timed(name)


def count(name: str, n: int = 1) -> None:
    """Increment a counter — poll iterations, cache hits, retries, tokens."""
    if ENABLED:
        _counters[name] += n


def record(name: str, ms: float) -> None:
    """Record a duration measured elsewhere (e.g. an API call already timed)."""
    if ENABLED:
        _samples[name].append(ms)


def _pct(sorted_vals: list[float], p: float) -> float:
    if not sorted_vals:
        return 0.0
    k = (len(sorted_vals) - 1) * p
    lo, hi = int(k), min(int(k) + 1, len(sorted_vals) - 1)
    return sorted_vals[lo] + (sorted_vals[hi] - sorted_vals[lo]) * (k - lo)


def stats() -> dict[str, dict[str, float]]:
    """Per-span aggregates, sorted by total time — the ranking that matters."""
    out: dict[str, dict[str, float]] = {}
    for name, vals in _samples.items():
        s = sorted(vals)
        out[name] = {
            "count": len(s),
            "total_ms": sum(s),
            "mean_ms": sum(s) / len(s),
            "p50_ms": _pct(s, 0.50),
            "p95_ms": _pct(s, 0.95),
            "max_ms": s[-1],
        }
    return dict(sorted(out.items(), key=lambda kv: kv[1]["total_ms"], reverse=True))


def report(title: str = "ybot latency") -> None:
    """Print spans ranked by total time spent — highest-impact bottleneck first."""
    if not ENABLED:
        print("perf: disabled (set YBOT_PERF=1 to measure)")
        return
    st = stats()
    if not st and not _counters:
        print("perf: nothing recorded")
        return

    print(f"\n=== {title} ===")
    print(f"{'span':<34}{'n':>6}{'total':>10}{'mean':>9}{'p50':>9}{'p95':>9}{'max':>9}")
    print("-" * 86)
    for name, s in st.items():
        print(
            f"{name:<34}{int(s['count']):>6}{s['total_ms']:>9.0f}ms"
            f"{s['mean_ms']:>8.1f}ms{s['p50_ms']:>8.1f}ms"
            f"{s['p95_ms']:>8.1f}ms{s['max_ms']:>8.1f}ms"
        )
    if _counters:
        print("\ncounters:")
        for name, n in sorted(_counters.items(), key=lambda kv: -kv[1]):
            print(f"  {name:<40}{n:>10}")


def dump(path: str) -> None:
    """Write stats to JSON so a later run can be diffed against this one."""
    if not ENABLED:
        return
    with open(path, "w", encoding="utf-8") as fh:
        json.dump({"spans": stats(), "counters": dict(_counters)}, fh, indent=2)


def compare(before_path: str, after_path: str) -> None:
    """Print the delta between two dumps. Every optimisation must show up here."""
    with open(before_path, encoding="utf-8") as fh:
        before = json.load(fh)["spans"]
    with open(after_path, encoding="utf-8") as fh:
        after = json.load(fh)["spans"]

    print(f"\n=== {before_path} -> {after_path} ===")
    print(f"{'span':<34}{'p50 before':>12}{'p50 after':>12}{'change':>12}")
    print("-" * 70)
    for name in sorted(set(before) | set(after)):
        b = before.get(name, {}).get("p50_ms", 0.0)
        a = after.get(name, {}).get("p50_ms", 0.0)
        if b and a:
            pct = (a - b) / b * 100.0
            verdict = f"{pct:+.0f}%"
        else:
            verdict = "new" if a else "gone"
        print(f"{name:<34}{b:>10.1f}ms{a:>10.1f}ms{verdict:>12}")


def reset() -> None:
    _samples.clear()
    _counters.clear()
