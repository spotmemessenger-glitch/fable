"""The instrumentation must never be the thing that breaks a run, and must be
free when disabled — otherwise measuring changes what it measures.
"""
from __future__ import annotations

import importlib
import json
import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def _perf(enabled: bool):
    """Re-import perf with YBOT_PERF set, since ENABLED is read at import time."""
    os.environ["YBOT_PERF"] = "1" if enabled else ""
    import ybot.perf as perf

    importlib.reload(perf)
    perf.reset()
    return perf


def test_disabled_records_nothing_and_costs_nothing():
    perf = _perf(False)
    with perf.span("x"):
        pass
    perf.count("c")
    perf.record("y", 5.0)
    assert perf.stats() == {}


def test_disabled_span_is_a_shared_singleton():
    """No allocation per call site when off — the whole point of the _NoOp."""
    perf = _perf(False)
    assert perf.span("a") is perf.span("b")


def test_enabled_records_durations_and_counters():
    perf = _perf(True)
    with perf.span("work"):
        pass
    perf.count("hits", 3)

    st = perf.stats()
    assert st["work"]["count"] == 1
    assert st["work"]["total_ms"] >= 0
    assert perf._counters["hits"] == 3


def test_span_records_even_when_the_block_raises():
    """A span around failing code must still be measured, and must re-raise."""
    perf = _perf(True)
    with pytest.raises(ValueError):
        with perf.span("boom"):
            raise ValueError("expected")
    assert perf.stats()["boom"]["count"] == 1


def test_stats_rank_by_total_time():
    """The report's whole job is to put the biggest cost first."""
    perf = _perf(True)
    perf.record("small", 1.0)
    perf.record("big", 100.0)
    perf.record("mid", 10.0)
    assert list(perf.stats()) == ["big", "mid", "small"]


def test_percentiles():
    perf = _perf(True)
    for v in range(1, 101):  # 1..100
        perf.record("s", float(v))
    s = perf.stats()["s"]
    assert s["p50_ms"] == pytest.approx(50.5, abs=0.6)
    assert s["p95_ms"] == pytest.approx(95.05, abs=0.6)
    assert s["max_ms"] == 100.0


def test_dump_round_trips(tmp_path):
    perf = _perf(True)
    perf.record("s", 4.0)
    perf.count("c", 2)
    out = tmp_path / "p.json"
    perf.dump(str(out))

    data = json.loads(out.read_text())
    assert data["spans"]["s"]["count"] == 1
    assert data["counters"]["c"] == 2


def test_compare_reports_both_runs(tmp_path, capsys):
    perf = _perf(True)
    perf.record("s", 100.0)
    before = tmp_path / "b.json"
    perf.dump(str(before))

    perf.reset()
    perf.record("s", 50.0)
    after = tmp_path / "a.json"
    perf.dump(str(after))

    perf.compare(str(before), str(after))
    assert "-50%" in capsys.readouterr().out
