"""Catalog and registry loading for the Enterprise AI Engineer Pack.

Stdlib only. The catalog is plain text so it stays diffable and reviewable:

    owner/repo | tag,tag,tag | one line on why it matters

Lines beginning with ``//`` are comments; blank lines are ignored.
"""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass, field, asdict
from typing import Iterable

PACK_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
CATALOG_DIR = os.path.join(PACK_ROOT, "catalog")
AGENTS_DIR = os.path.join(PACK_ROOT, "agents")
SKILLS_DIR = os.path.join(PACK_ROOT, "skills")
COMPANY_DIR = os.path.join(PACK_ROOT, "company-maps")
VERIFY_FILE = os.path.join(CATALOG_DIR, "verified.json")

REPO_RE = re.compile(r"^[A-Za-z0-9][\w.-]*/[\w.-]+$")


class CatalogError(ValueError):
    """Raised when a catalog line cannot be parsed."""


@dataclass(frozen=True)
class Repo:
    slug: str            # owner/repo
    domain: str          # catalog file it came from
    tags: tuple[str, ...]
    note: str

    @property
    def url(self) -> str:
        return f"https://github.com/{self.slug}"

    @property
    def owner(self) -> str:
        return self.slug.split("/", 1)[0]

    def haystack(self) -> str:
        return f"{self.slug} {self.domain} {' '.join(self.tags)} {self.note}".lower()

    def to_dict(self) -> dict:
        d = asdict(self)
        d["tags"] = list(self.tags)
        d["url"] = self.url
        return d


@dataclass
class Agent:
    name: str
    description: str = ""
    domains: tuple[str, ...] = ()
    triggers: tuple[str, ...] = ()
    model: str = ""
    path: str = ""
    body: str = field(default="", repr=False)

    def haystack(self) -> str:
        return " ".join(
            [self.name, self.description, " ".join(self.domains), " ".join(self.triggers)]
        ).lower()


@dataclass
class Skill:
    name: str
    description: str = ""
    path: str = ""

    def haystack(self) -> str:
        return f"{self.name} {self.description}".lower()


def parse_catalog_line(line: str, domain: str, lineno: int = 0) -> Repo:
    """Parse one ``owner/repo | tags | note`` line."""
    parts = [p.strip() for p in line.split("|")]
    if len(parts) < 2:
        raise CatalogError(f"{domain}:{lineno}: expected 'slug | tags | note', got {line!r}")
    slug = parts[0]
    if not REPO_RE.match(slug):
        raise CatalogError(f"{domain}:{lineno}: {slug!r} is not a valid owner/repo")
    tags = tuple(t.strip().lower() for t in parts[1].split(",") if t.strip())
    note = parts[2] if len(parts) > 2 else ""
    return Repo(slug=slug, domain=domain, tags=tags, note=note)


def load_catalog_file(path: str) -> list[Repo]:
    domain = os.path.splitext(os.path.basename(path))[0]
    repos: list[Repo] = []
    with open(path, encoding="utf-8") as fh:
        for lineno, raw in enumerate(fh, 1):
            line = raw.strip()
            if not line or line.startswith("//"):
                continue
            repos.append(parse_catalog_line(line, domain, lineno))
    return repos


def load_catalog(catalog_dir: str = CATALOG_DIR) -> list[Repo]:
    """Load every ``*.txt`` catalog file, sorted by domain then slug."""
    repos: list[Repo] = []
    if not os.path.isdir(catalog_dir):
        return repos
    for name in sorted(os.listdir(catalog_dir)):
        if name.endswith(".txt"):
            repos.extend(load_catalog_file(os.path.join(catalog_dir, name)))
    return repos


def unique_slugs(repos: Iterable[Repo]) -> list[str]:
    """Distinct repo slugs, order preserved. A repo may serve several domains."""
    seen: dict[str, None] = {}
    for r in repos:
        seen.setdefault(r.slug, None)
    return list(seen)


# --------------------------------------------------------------------------
# Frontmatter: a deliberately small parser. `key: value`, and comma lists.
# We do not depend on PyYAML — this pack must run on a bare interpreter.
# --------------------------------------------------------------------------

def parse_frontmatter(text: str) -> tuple[dict[str, str], str]:
    """Split ``---`` fenced frontmatter from the body. Returns (fields, body)."""
    if not text.startswith("---"):
        return {}, text
    lines = text.splitlines()
    end = None
    for i, line in enumerate(lines[1:], 1):
        if line.strip() == "---":
            end = i
            break
    if end is None:
        return {}, text
    fields: dict[str, str] = {}
    key = None
    for line in lines[1:end]:
        if not line.strip():
            continue
        if line.startswith((" ", "\t")) and key:      # simple continuation
            fields[key] = f"{fields[key]} {line.strip()}".strip()
            continue
        if ":" not in line:
            continue
        key, value = line.split(":", 1)
        key = key.strip()
        fields[key] = value.strip().strip('"').strip("'")
    return fields, "\n".join(lines[end + 1:]).lstrip("\n")


def _csv(value: str) -> tuple[str, ...]:
    return tuple(v.strip().lower() for v in value.split(",") if v.strip())


def load_agents(agents_dir: str = AGENTS_DIR) -> list[Agent]:
    agents: list[Agent] = []
    if not os.path.isdir(agents_dir):
        return agents
    for name in sorted(os.listdir(agents_dir)):
        if not name.endswith(".md"):
            continue
        path = os.path.join(agents_dir, name)
        with open(path, encoding="utf-8") as fh:
            fields, body = parse_frontmatter(fh.read())
        agents.append(
            Agent(
                name=fields.get("name", os.path.splitext(name)[0]),
                description=fields.get("description", ""),
                domains=_csv(fields.get("domains", "")),
                triggers=_csv(fields.get("triggers", "")),
                model=fields.get("model", ""),
                path=path,
                body=body,
            )
        )
    return agents


def load_skills(skills_dir: str = SKILLS_DIR) -> list[Skill]:
    skills: list[Skill] = []
    if not os.path.isdir(skills_dir):
        return skills
    for name in sorted(os.listdir(skills_dir)):
        path = os.path.join(skills_dir, name, "SKILL.md")
        if not os.path.isfile(path):
            continue
        with open(path, encoding="utf-8") as fh:
            fields, _ = parse_frontmatter(fh.read())
        skills.append(
            Skill(
                name=fields.get("name", name),
                description=fields.get("description", ""),
                path=path,
            )
        )
    return skills


def load_verification(path: str = VERIFY_FILE) -> dict:
    """Load the recorded git ls-remote results, or an empty record."""
    if not os.path.isfile(path):
        return {"checked_at": None, "results": {}}
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def save_verification(record: dict, path: str = VERIFY_FILE) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(record, fh, indent=1, sort_keys=True)
        fh.write("\n")
