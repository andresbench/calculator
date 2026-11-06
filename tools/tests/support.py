"""Shared fixtures: the versioned wiki snapshot in ``data/endfield/``.

Tests read the parsed JSON that is under version control, never the
generated bundle or the roster, so a clean clone runs them as they are.
"""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "data" / "endfield"


@lru_cache(maxsize=None)
def operators() -> dict:
    return json.loads((DATA / "operators.json").read_text(encoding="utf-8"))


def skill(operator: str, skill_type: str) -> dict:
    """The first skill of that type: Arcane's two stances share their numbers' shape."""
    return next(s for s in operators()[operator]["skills"] if s["type"] == skill_type)


def row(stats: list[dict], label: str) -> dict:
    return next(r for r in stats if r["label"] == label)
