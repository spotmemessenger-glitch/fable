"""superbrain — routing and verification for the Enterprise AI Engineer Pack.

Stdlib only, by design: this has to run in a fresh clone on a bare interpreter
before anything has been installed.
"""

__version__ = "1.0.0"

from .catalog import (  # noqa: F401
    Agent,
    Repo,
    Skill,
    load_agents,
    load_catalog,
    load_skills,
    parse_catalog_line,
    parse_frontmatter,
    unique_slugs,
)
from .router import classify_shape, route, search_repos, tokenize  # noqa: F401
