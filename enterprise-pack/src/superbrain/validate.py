"""Verify every catalogued repository actually resolves.

A curated list nobody checked is a liability: dead links get quoted back at you
as fact. This module resolves each entry with ``git ls-remote``, which needs no
API token and is not subject to the GitHub REST rate limit.

Exit status semantics:
  0   the remote resolved and advertised refs
  128 the remote does not exist, is private, or auth was refused
"""

from __future__ import annotations

import concurrent.futures
import os
import subprocess
import time
from dataclasses import dataclass

GIT_ENV = {
    **os.environ,
    "GIT_TERMINAL_PROMPT": "0",      # never block waiting for credentials
    "GIT_ASKPASS": "echo",
    "GCM_INTERACTIVE": "never",
}


@dataclass
class CheckResult:
    slug: str
    ok: bool
    detail: str
    elapsed: float

    def to_dict(self) -> dict:
        return {"ok": self.ok, "detail": self.detail, "elapsed": round(self.elapsed, 2)}


def check_repo(slug: str, timeout: int = 25, retries: int = 1) -> CheckResult:
    """Resolve one repo. Retries once — a network blip is not a dead repo."""
    url = f"https://github.com/{slug}"
    last = "unknown"
    started = time.monotonic()
    for attempt in range(retries + 1):
        try:
            proc = subprocess.run(
                # No --heads: HEAD is a symbolic ref, not under refs/heads/*, so
                # restricting to heads makes the pattern match nothing and every
                # repo looks dead with exit 2.
                ["git", "ls-remote", "--exit-code", url, "HEAD"],
                capture_output=True, text=True, timeout=timeout, env=GIT_ENV,
            )
        except subprocess.TimeoutExpired:
            last = "timeout"
        except OSError as exc:                      # git missing, fd exhaustion
            return CheckResult(slug, False, f"exec-error: {exc}", time.monotonic() - started)
        else:
            if proc.returncode == 0:
                return CheckResult(slug, True, "ok", time.monotonic() - started)
            err = (proc.stderr or "").strip().splitlines()
            last = err[-1][:160] if err else f"exit {proc.returncode}"
            low = last.lower()
            # Definite negatives — no point retrying. Note that through an
            # authenticating proxy a missing *or private* repo surfaces as a
            # credential prompt rather than a 404; either way it is not a
            # public repo we can cite.
            if ("not found" in low or "repository" in low
                    or "could not read password" in low or "authentication" in low):
                return CheckResult(slug, False, last, time.monotonic() - started)
        if attempt < retries:
            time.sleep(1.5 * (attempt + 1))
    return CheckResult(slug, False, last, time.monotonic() - started)


def check_all(slugs: list[str], workers: int = 12, timeout: int = 25,
              progress=None) -> dict[str, CheckResult]:
    """Resolve many repos concurrently. ``progress(done, total, result)``."""
    results: dict[str, CheckResult] = {}
    total = len(slugs)
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {pool.submit(check_repo, s, timeout): s for s in slugs}
        for done, fut in enumerate(concurrent.futures.as_completed(futures), 1):
            slug = futures[fut]
            try:
                res = fut.result()
            except Exception as exc:                # never let one repo kill the run
                res = CheckResult(slug, False, f"error: {exc}", 0.0)
            results[slug] = res
            if progress:
                progress(done, total, res)
    return results


def prune_catalog(catalog_dir: str, dead: set[str], dry_run: bool = True) -> dict[str, int]:
    """Remove lines whose slug is in ``dead``. Returns per-file removal counts."""
    removed: dict[str, int] = {}
    for name in sorted(os.listdir(catalog_dir)):
        if not name.endswith(".txt"):
            continue
        path = os.path.join(catalog_dir, name)
        with open(path, encoding="utf-8") as fh:
            lines = fh.readlines()
        kept, dropped = [], 0
        for line in lines:
            stripped = line.strip()
            if stripped and not stripped.startswith("//"):
                slug = stripped.split("|", 1)[0].strip()
                if slug in dead:
                    dropped += 1
                    continue
            kept.append(line)
        if dropped:
            removed[name] = dropped
            if not dry_run:
                with open(path, "w", encoding="utf-8") as fh:
                    fh.writelines(kept)
    return removed
