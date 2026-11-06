#!/usr/bin/env python3
"""The roster: reading, checking against the data, and a summary.

The roster is edited by hand, so a typo in a name is a matter of time. This
module catches them at once: a name missing from ``operators.json`` must fail
with a clear error rather than silently drop out of the calculations.

Run as a script, it prints a summary::

    python3 tools/ef/roster.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "data" / "endfield"
ROSTER = ROOT / "roster" / "endfield.yaml"
PROFILE = ROOT / "roster" / "endfield.profile.yaml"


def load_operators() -> dict:
    with (DATA / "operators.json").open(encoding="utf-8") as handle:
        return json.load(handle)


def load_roster() -> dict:
    with ROSTER.open(encoding="utf-8") as handle:
        return yaml.safe_load(handle)


def load_profile() -> dict:
    """Imported from the Enka showcase: {operator name: data}."""
    if not PROFILE.exists():
        return {}
    with PROFILE.open(encoding="utf-8") as handle:
        data = yaml.safe_load(handle) or {}
    return data.get("operators") or {}


def resolve_key(name: str, entry: dict, operators: dict) -> str | None:
    """A roster name → the key in ``operators.json``.

    Endministrator exists in the data as two records (male/female), so the
    name by itself is not a key.
    """
    if name in operators:
        return name
    variant = (entry or {}).get("variant")
    if variant and f"{name} ({variant})" in operators:
        return f"{name} ({variant})"
    for candidate in (f"{name} (female)", f"{name} (male)"):
        if candidate in operators:
            return candidate
    return None


def owned(strict: bool = True) -> dict[str, dict]:
    """{data key: roster entry, filled in with defaults}."""
    operators = load_operators()
    roster = load_roster()
    defaults = roster.get("defaults") or {}
    profile = load_profile()

    result: dict[str, dict] = {}
    unknown: list[str] = []

    for name, entry in (roster.get("operators") or {}).items():
        entry = dict(entry or {})
        key = resolve_key(name, entry, operators)
        if key is None:
            unknown.append(name)
            continue
        # Mark what was set by hand, what came from the showcase, and what was
        # filled in from defaults: for a calculation that is the difference
        # between fact and assumption. Showcase data beats hand-written — it is
        # from the game.
        from_profile = profile.get(operators[key]["name"], {})
        from_profile = {k: v for k, v in from_profile.items() if not k.startswith("_")}
        merged = {**defaults, **entry, **from_profile, "roster_name": name, "key": key}
        merged["specified"] = sorted(
            (set(entry) | set(from_profile)) - {"variant", "elite_uncertain"}
        )
        merged["from_profile"] = sorted(from_profile)
        result[key] = merged

    if unknown:
        message = (
            "The roster has operators missing from the data: "
            + ", ".join(sorted(unknown))
            + ". Check the spelling or update the data (tools/ef/fetch.py)."
        )
        if strict:
            raise KeyError(message)
        print(f"! {message}", file=sys.stderr)

    return result


def main() -> int:
    operators = load_operators()
    mine = owned(strict=False)

    imported = sum(1 for e in mine.values() if e.get("from_profile"))
    print(f"Endfield roster: {len(mine)} operators of {len(operators)} in the data")
    if imported:
        print(f"  of them with Enka showcase data: {imported}")
    print()

    by_element: dict[str, list] = {}
    unknown_fields = {"potential": 0, "skills": 0, "weapon": 0, "gear": 0}

    for key, entry in sorted(mine.items(), key=lambda kv: -kv[1]["level"]):
        record = operators[key]
        by_element.setdefault(record["element"] or "?", []).append(record["name"])
        for field in unknown_fields:
            if field not in entry.get("specified", []):
                unknown_fields[field] += 1

    print("By element:")
    for element, names in sorted(by_element.items(), key=lambda kv: -len(kv[1])):
        print(f"  {element:9} {len(names):2}  {', '.join(sorted(names))}")

    print("\nBy class:")
    by_class: dict[str, list] = {}
    for key in mine:
        record = operators[key]
        by_class.setdefault(record["class"] or "?", []).append(record["name"])
    for klass, names in sorted(by_class.items(), key=lambda kv: -len(kv[1])):
        print(f"  {klass:10} {len(names):2}  {', '.join(sorted(names))}")

    print("\nNot set by hand — taken from defaults, i.e. an assumption:")
    for field, count in unknown_fields.items():
        if count:
            default = load_roster().get("defaults", {}).get(field)
            print(f"  {field:10} for {count} of {len(mine)}  (default: {default})")

    missing = sorted(
        operators[k]["name"]
        for k in operators
        if k not in mine and not operators[k].get("upcoming") and "(male)" not in k
    )
    if missing:
        print(f"\nNot in the account ({len(missing)}): {', '.join(missing)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
