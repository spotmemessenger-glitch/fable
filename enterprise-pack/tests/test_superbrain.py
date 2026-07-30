"""Tests for the superbrain catalog, router and validator plumbing.

Run from enterprise-pack/:  PYTHONPATH=src python3 -m pytest tests/ -q
(or plain `python3 tests/test_superbrain.py` — falls back to a mini runner).
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from superbrain import catalog as cat
from superbrain import router as rt


def test_parse_catalog_line_full():
    repo = cat.parse_catalog_line(
        "apache/kafka | streaming,log | The event backbone", "data", 1)
    assert repo.slug == "apache/kafka"
    assert repo.domain == "data"
    assert repo.tags == ("streaming", "log")
    assert repo.note == "The event backbone"
    assert repo.url == "https://github.com/apache/kafka"


def test_parse_catalog_line_rejects_bad_slug():
    for bad in ("no-slash | a | b", "a/b/c | t | n", "| t | n"):
        try:
            cat.parse_catalog_line(bad, "x", 1)
        except cat.CatalogError:
            continue
        raise AssertionError(f"{bad!r} should not parse")


def test_frontmatter_roundtrip():
    fields, body = cat.parse_frontmatter(
        "---\nname: tester\ndescription: does things\n---\n# Body\ntext\n")
    assert fields["name"] == "tester"
    assert fields["description"] == "does things"
    assert body.startswith("# Body")


def test_frontmatter_absent():
    fields, body = cat.parse_frontmatter("just a body")
    assert fields == {} and body == "just a body"


def test_real_catalog_loads_and_is_clean():
    repos = cat.load_catalog()
    assert len(repos) > 1000, f"catalog unexpectedly small: {len(repos)}"
    slugs = cat.unique_slugs(repos)
    assert len(slugs) > 1000
    for r in repos:
        assert r.tags, f"{r.slug} has no tags"
        assert r.note, f"{r.slug} has no note"


def test_real_catalog_is_fully_verified():
    record = cat.load_verification()
    results = record.get("results", {})
    assert results, "verification has never been run"
    unresolved = [s for s in cat.unique_slugs(cat.load_catalog())
                  if not results.get(s, {}).get("ok")]
    assert unresolved == [], f"{len(unresolved)} catalog repos unverified: {unresolved[:5]}"


def test_tokenize_expands_synonyms_and_drops_stopwords():
    toks = rt.tokenize("How should we harden the k8s cluster?")
    assert "kubernetes" in toks
    assert "harden" in toks
    assert "the" not in toks and "we" not in toks


def test_classify_shape():
    assert rt.classify_shape("fix the crash in login") == "bugfix"
    assert rt.classify_shape("the API is slow, optimize p99 latency") == "performance"
    assert rt.classify_shape("audit our auth for vulnerabilities") == "security"
    assert rt.classify_shape("migrate the legacy monolith") == "migration"


def test_search_ranks_specific_over_generic():
    repos = cat.load_catalog()
    hits = rt.search_repos(repos, "kafka change data capture", limit=10)
    top_slugs = [h.item.slug for h in hits[:6]]
    assert any("debezium" in s or "kafka" in s or "confluent" in s
               for s in top_slugs), f"CDC query missed the mark: {top_slugs}"


def test_route_returns_complete_structure():
    repos = cat.load_catalog()
    agents = cat.load_agents()
    skills = cat.load_skills()
    result = rt.route("harden our REST API against injection", repos, agents, skills)
    assert result["shape"] == "security"
    assert result["pipeline"][0] == "security-engineer"
    assert result["repos"], "no repos routed"
    assert result["agents"], "no agents routed"
    assert result["agents"][0]["name"] == "security-engineer"


def test_agents_all_have_routable_metadata():
    agents = cat.load_agents()
    assert len(agents) >= 20, f"expected the full specialist set, got {len(agents)}"
    for a in agents:
        assert a.description, f"{a.name} missing description"
        assert a.triggers, f"{a.name} missing triggers"
        assert a.body, f"{a.name} has an empty body"


def test_vendor_routing_hits_vendor_agents():
    repos, agents, skills = cat.load_catalog(), cat.load_agents(), cat.load_skills()
    cases = {
        "deploy AKS with bicep and entra workload identity": "microsoft-enterprise-engineer",
        "jetpack compose app talking to cloud run": "google-cloud-android-engineer",
        "swiftui app with coreml on-device inference": "apple-platform-engineer",
        "tensorrt int4 quantization throughput on the gpu": "nvidia-cuda-engineer",
        "clean abap and a fiori frontend on btp": "sap-enterprise-engineer",
        "zos cobol batch modernization": "ibm-mainframe-engineer",
    }
    for task, expected in cases.items():
        result = rt.route(task, repos, agents, skills)
        names = [a["name"] for a in result["agents"]]
        assert expected in names[:2], f"{task!r} routed to {names[:3]}, wanted {expected}"


if __name__ == "__main__":
    failures = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                print(f"ok    {name}")
            except AssertionError as exc:
                failures += 1
                print(f"FAIL  {name}: {exc}")
    raise SystemExit(1 if failures else 0)
