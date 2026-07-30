"""Routing: turn a task sentence into specialists, repos, skills and a pipeline.

Deterministic and dependency-free on purpose. The router is the part of the
"super brain" that runs before any model call, so it must be cheap, explainable
and testable. Every score can be traced back to a matched token.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass

from .catalog import Agent, Repo, Skill

STOPWORDS = {
    "the", "and", "for", "with", "that", "this", "from", "into", "our", "your",
    "a", "an", "of", "to", "in", "on", "is", "are", "be", "it", "we", "i",
    "how", "do", "does", "can", "should", "need", "want", "please", "make",
    "help", "some", "any", "all", "new", "use", "using", "up", "out",
    # Words that appear in so many notes they carry no routing signal.
    "app", "apps", "code", "system", "project", "work", "thing", "stuff",
}

# Vocabulary drift is the main reason keyword routers fail. Normalise first.
SYNONYMS = {
    "k8s": "kubernetes", "kube": "kubernetes", "eks": "kubernetes",
    "aks": "kubernetes", "gke": "kubernetes", "ocp": "kubernetes",
    "gcp": "google", "vertex": "google", "android": "google",
    "azure": "microsoft", "dotnet": "microsoft", ".net": "microsoft",
    "csharp": "microsoft", "m365": "microsoft", "powershell": "microsoft",
    "ios": "apple", "macos": "apple", "swiftui": "apple", "xcode": "apple",
    "cuda": "nvidia", "gpu": "nvidia", "tensorrt": "nvidia",
    "jvm": "java", "spring": "java", "abap": "sap", "fiori": "sap",
    "zos": "mainframe", "cobol": "mainframe", "db2": "ibm",
    "iac": "terraform", "gitops": "kubernetes", "sre": "observability",
    "cicd": "cicd", "ci": "cicd",
    "appsec": "security", "infosec": "security", "pentest": "security",
    "vuln": "security", "cve": "security", "oauth": "identity",
    "sso": "identity", "iam": "identity", "rbac": "authorization",
    "llm": "llm", "genai": "llm", "gpt": "llm", "rag": "rag",
    "embedding": "embeddings", "vectordb": "vectordb", "agent": "agents",
    "etl": "data-engineering", "elt": "data-engineering",
    "warehouse": "data-engineering", "lakehouse": "lakehouse",
    "qa": "testing", "e2e": "e2e", "unit": "testing", "perf": "performance",
    "latency": "performance", "throughput": "performance",
    "slow": "performance", "ux": "design-system", "ui": "frontend",
    "frontend": "frontend", "backend": "backend", "api": "api",
    "graphql": "graphql", "grpc": "rpc", "mobile": "mobile",
    "salesforce": "salesforce", "erp": "erp", "rpa": "rpa",
    "migrate": "modernization", "migration": "modernization",
    "legacy": "modernization", "modernise": "modernization",
    "modernize": "modernization",
}

# Task shape -> ordered pipeline of agent roles. Mirrors the routing table in
# CLAUDE.md so the pack agrees with the repo's existing convention.
PIPELINES: dict[str, tuple[str, ...]] = {
    "bugfix": ("researcher", "coder", "tester"),
    "feature": ("architect", "coder", "tester", "reviewer"),
    "refactor": ("architect", "coder", "reviewer"),
    "performance": ("performance-engineer", "coder", "tester"),
    "security": ("security-engineer", "reviewer", "tester"),
    "migration": ("architect", "integration-engineer", "coder", "tester", "reviewer"),
    "research": ("researcher", "architect"),
}

SHAPE_HINTS: dict[str, tuple[str, ...]] = {
    "bugfix": ("bug", "fix", "broken", "crash", "error", "regression", "failing"),
    "performance": ("performance", "slow", "latency", "throughput", "optimize",
                    "optimise", "profil", "memory", "cost"),
    "security": ("security", "vulnerab", "cve", "hardening", "audit", "compliance",
                 "injection", "secret", "threat"),
    "migration": ("migrat", "modernization", "legacy", "port", "upgrade", "replatform"),
    "refactor": ("refactor", "cleanup", "restructure", "tech debt", "debt"),
    "research": ("research", "compare", "evaluate", "investigate", "options", "which"),
    "feature": ("feature", "implement", "add", "build", "create", "design"),
}


@dataclass
class Scored:
    item: object
    score: float
    matched: tuple[str, ...]

    def to_dict(self) -> dict:
        item = self.item
        base = item.to_dict() if hasattr(item, "to_dict") else {"name": getattr(item, "name", str(item))}
        base["score"] = round(self.score, 2)
        base["matched"] = list(self.matched)
        return base


def tokenize(text: str) -> list[str]:
    """Lowercase, split, drop stopwords, expand synonyms. Order preserved."""
    raw = [t for t in re.split(r"[^a-z0-9.+#-]+", text.lower()) if t]
    out: list[str] = []
    for tok in raw:
        tok = tok.strip(".-")
        if len(tok) < 2 or tok in STOPWORDS:
            continue
        out.append(tok)
        mapped = SYNONYMS.get(tok)
        if mapped and mapped != tok:
            out.append(mapped)
    # de-duplicate, keep order
    seen: dict[str, None] = {}
    for tok in out:
        seen.setdefault(tok, None)
    return list(seen)


def classify_shape(task: str) -> str:
    """Best-guess task shape; drives which pipeline is proposed."""
    low = task.lower()
    best, best_hits = "feature", 0
    for shape, hints in SHAPE_HINTS.items():
        hits = sum(1 for h in hints if h in low)
        if hits > best_hits:
            best, best_hits = shape, hits
    return best


def build_idf(repos: list[Repo]) -> dict[str, float]:
    """Inverse document frequency over the catalog.

    Without this the router ranks on how common a word is. "pipeline" appears
    in CI/CD, data and ML entries alike, so an unweighted match buries the term
    that actually carries the question ("cdc", "kafka"). Rare token, loud vote.
    """
    n = max(len(repos), 1)
    df: dict[str, int] = {}
    for repo in repos:
        seen = set(repo.tags) | set(re.split(r"[^a-z0-9]+", repo.haystack()))
        for tok in seen:
            if tok:
                df[tok] = df.get(tok, 0) + 1
    return {tok: math.log(n / (1 + count)) + 0.25 for tok, count in df.items()}


def _weight(tok: str, idf: dict[str, float] | None) -> float:
    if not idf:
        return 1.0
    # An unseen token is maximally specific, but capped so typos cannot dominate.
    return min(idf.get(tok, 4.0), 6.0) / 3.0


def tag_tokens(tags: tuple[str, ...]) -> set[str]:
    """Tags plus their hyphen parts, so 'injection' finds 'prompt-injection'."""
    out: set[str] = set()
    for tag in tags:
        out.add(tag)
        out.update(p for p in tag.split("-") if len(p) > 2)
    return out


def score_repo(repo: Repo, tokens: list[str], idf: dict[str, float] | None = None) -> Scored:
    score = 0.0
    matched: list[str] = []
    slug_low = repo.slug.lower()
    note_low = repo.note.lower()
    tags = tag_tokens(repo.tags)
    for tok in tokens:
        hit = 0.0
        # Only stem words long enough that the plural is unambiguous.
        stems = {tok} if len(tok) < 5 else {tok, f"{tok}s", tok.rstrip("s")}
        if stems & tags:
            hit += 5.0
        if tok == repo.domain or tok in repo.domain.split("-"):
            hit += 3.0
        if tok in slug_low:
            hit += 3.0
        elif tok in note_low:
            hit += 1.0
        if hit:
            score += hit * _weight(tok, idf)
            matched.append(tok)
    # Reward breadth of match over one very strong tag hit.
    if len(matched) > 1:
        score *= 1.0 + 0.15 * (len(matched) - 1)
    return Scored(repo, score, tuple(matched))


def score_agent(agent: Agent, tokens: list[str]) -> Scored:
    score = 0.0
    matched: list[str] = []
    desc = agent.description.lower()
    for tok in tokens:
        hit = 0.0
        if tok in agent.triggers:
            hit += 6.0
        if tok in agent.domains:
            hit += 4.0
        if tok in agent.name.lower():
            hit += 3.0
        elif tok in desc:
            hit += 1.0
        if hit:
            score += hit
            matched.append(tok)
    if len(matched) > 1:
        score *= 1.0 + 0.15 * (len(matched) - 1)
    return Scored(agent, score, tuple(matched))


def score_skill(skill: Skill, tokens: list[str]) -> Scored:
    hay = skill.haystack()
    matched = [t for t in tokens if t in hay]
    return Scored(skill, float(len(matched) * 2), tuple(matched))


def _top(scored: list[Scored], limit: int) -> list[Scored]:
    ranked = [s for s in scored if s.score > 0]
    ranked.sort(key=lambda s: (-s.score, getattr(s.item, "slug", getattr(s.item, "name", ""))))
    return ranked[:limit]


def search_repos(repos: list[Repo], query: str, limit: int = 20,
                 domain: str | None = None) -> list[Scored]:
    tokens = tokenize(query)
    idf = build_idf(repos)
    pool = [r for r in repos if domain is None or r.domain == domain]
    return _top([score_repo(r, tokens, idf) for r in pool], limit)


def route(task: str, repos: list[Repo], agents: list[Agent], skills: list[Skill],
          repo_limit: int = 12, agent_limit: int = 4) -> dict:
    """The main entry point: task -> everything needed to start work."""
    tokens = tokenize(task)
    shape = classify_shape(task)
    idf = build_idf(repos)

    # The task shape is independent evidence of intent, read from the verbs
    # ("harden", "optimise") rather than the nouns. It decides the pipeline, so
    # the agent list must agree with the pipeline shown beside it: the classified
    # owner leads, and the remaining specialists follow by match score. Without
    # this, "harden our REST API against injection" lists the backend architect
    # first purely because the sentence is dense with backend nouns, contradicting
    # its own security pipeline.
    lead_name = (PIPELINES.get(shape, ()) or ("",))[0]
    ranked = _top([score_agent(a, tokens) for a in agents], len(agents))
    lead = next((s for s in ranked if s.item.name == lead_name), None)
    if lead is None:
        lead = next((Scored(a, 0.0, ("shape:" + shape,))
                     for a in agents if a.name == lead_name), None)
    top_agents = ([lead] if lead else []) + [s for s in ranked if s is not lead]
    top_agents = top_agents[:agent_limit]
    top_repos = _top([score_repo(r, tokens, idf) for r in repos], repo_limit)
    top_skills = _top([score_skill(s, tokens) for s in skills], 5)

    # Domains that actually matched, so the caller knows which corner of the
    # catalog is in play rather than just a flat list.
    domains: dict[str, float] = {}
    for s in top_repos:
        domains[s.item.domain] = domains.get(s.item.domain, 0.0) + s.score
    ranked_domains = sorted(domains.items(), key=lambda kv: -kv[1])

    return {
        "task": task,
        "shape": shape,
        "tokens": tokens,
        "pipeline": list(PIPELINES.get(shape, PIPELINES["feature"])),
        "agents": [s.to_dict() for s in top_agents],
        "skills": [s.to_dict() for s in top_skills],
        "repos": [s.to_dict() for s in top_repos],
        "domains": [{"domain": d, "score": round(sc, 2)} for d, sc in ranked_domains],
    }
