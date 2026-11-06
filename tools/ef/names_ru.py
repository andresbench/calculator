#!/usr/bin/env python3
"""Official Russian names for the interface → ``data/endfield/locale_ru.json``.

Two sources, in this order:

1. **The wiki**, ``Cargo:Locales`` (``data/endfield/raw/cargo/Locales.json``):
   the page name of an entity and its name in each language. CC BY-SA, like
   the rest of the wiki data.
2. **The client**, ``TableCfg/I18nTextTable_{EN,RU}.json`` from the datamine
   clone (``tools/ef/sync.py``). The two tables share keys, so an English
   string maps to the Russian one under the same key. One English string can
   sit under many keys; it is taken only when one Russian rendering clearly
   dominates (``DOMINANCE``), never by guessing.

Only names are translated: operators, skills, talents, potentials, weapons,
gear, sets, enemies and terms (elements, classes, skill types, glossary
terms, tags). Descriptions are not — they come with markup and placeholders,
and the wiki's English text stays the one the parsers read.

The output is under version control, so the export (and CI) needs no
datamine clone. Run it after ``parse.py`` and ``sync.py``::

    python3 tools/ef/names_ru.py
"""

from __future__ import annotations

import json
import sys
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "data" / "endfield"
LOCALES = DATA / "raw" / "cargo" / "Locales.json"
CLIENT = DATA / "upstream" / "endfield-data" / "TableCfg"
OUT = DATA / "locale_ru.json"

# Share of occurrences the most common Russian rendering must have.
DOMINANCE = 0.75

# Interface terms that are not entity names but appear as labels.
EXTRA_TERMS = [
    "Basic Attack", "Battle Skill", "Combo Skill", "Ultimate",
    "Final Strike", "Finisher", "Stagger", "Talent", "Potential",
    "Strength", "Agility", "Intellect", "Will",
    "Attack", "HP", "Critical Rate", "Arts Intensity", "Essence",
]


# The wiki names reactions by the noun, the client's tags by a short form
# of the same mechanic: «Combustion Duration (s)» → «Длительность
# возгорания», tag «Combust» → «Возгорание». A missing term takes its tag's
# official name; nothing is derived from inflected forms.
TERM_ALIASES = {
    "Combustion": "Combust",
    "Corrosion": "Corrode",
    "Electrification": "Electrify",
    "Solidification": "Solidify",
}


def load(name: str):
    return json.loads((DATA / name).read_text(encoding="utf-8"))


def wiki_names() -> dict[str, str]:
    """Page name → Russian name, from ``Cargo:Locales``."""
    rows = json.loads(LOCALES.read_text(encoding="utf-8"))
    out: dict[str, str] = {}
    for row in rows:
        row = row.get("title", row) if isinstance(row, dict) else row
        if row.get("Lang") == "ru" and row.get("Param") == "name" and row.get("Value"):
            out.setdefault(row["_pageName"], row["Value"].strip())
    return out


def client_names() -> dict[str, str]:
    """English string → Russian string, where the client is unambiguous."""
    if not (CLIENT / "I18nTextTable_RU.json").exists():
        print("  ! no datamine clone: wiki names only (tools/ef/sync.py)")
        return {}
    en = json.loads((CLIENT / "I18nTextTable_EN.json").read_text(encoding="utf-8"))
    ru = json.loads((CLIENT / "I18nTextTable_RU.json").read_text(encoding="utf-8"))
    seen: dict[str, Counter] = defaultdict(Counter)
    for key, text in en.items():
        if not (isinstance(text, str) and key in ru and isinstance(ru[key], str) and len(text) <= 80):
            continue
        # An untranslated copy (Russian identical to English) is a placeholder
        # key, not a rendering: it would only dilute the real translation.
        if ru[key].strip() == text.strip():
            continue
        seen[text.strip()][ru[key].strip()] += 1
    out: dict[str, str] = {}
    for text, renderings in seen.items():
        best, count = renderings.most_common(1)[0]
        if best and count / sum(renderings.values()) >= DOMINANCE:
            out[text] = best
    return out


class Translator:
    def __init__(self) -> None:
        self.wiki = wiki_names()
        self.client = client_names()
        self.stats: Counter = Counter()

    def name(self, page: str | None, english: str | None) -> str | None:
        """Russian name by wiki page first, then by the English string in the client."""
        for source, table, lookup in (("wiki", self.wiki, page), ("client", self.client, english)):
            if lookup and lookup in table and table[lookup] != english:
                self.stats[source] += 1
                return table[lookup]
        self.stats["missing"] += 1
        return None


def collect(section: dict, translate) -> dict[str, str]:
    out = {}
    for key, value in section.items():
        ru = translate(key, value)
        if ru:
            out[key] = ru
    return out


def main() -> int:
    t = Translator()
    operators = load("operators.json")
    weapons = load("weapons.json")
    gear = load("gear.json")
    enemies = load("enemies.json")
    glossary = load("glossary.json")

    out: dict = {
        "meta": {
            "sources": [
                "endfield.wiki.gg Cargo:Locales (CC BY-SA 4.0)",
                "client I18nTextTable_RU, matched by English text",
            ],
            "generator": "tools/ef/names_ru.py",
            "dominance": DOMINANCE,
        },
        "operators": {},
        "skills": {},
        "talents": {},
        "potentials": {},
    }

    for key, op in operators.items():
        ru = t.name(op.get("page") or key, op.get("name"))
        if ru:
            out["operators"][key] = ru
        for skill in op.get("skills") or []:
            name = skill.get("name")
            if name and name not in out["skills"]:
                ru = t.name(None, name)
                if ru:
                    out["skills"][name] = ru
        for talent in op.get("talents") or []:
            name = talent.get("name")
            if name and name not in out["talents"]:
                ru = t.name(None, name)
                if ru:
                    out["talents"][name] = ru
        for potential in op.get("potentials") or []:
            name = potential.get("title") or potential.get("name")
            if name and name not in out["potentials"]:
                ru = t.name(None, name)
                if ru:
                    out["potentials"][name] = ru

    out["weapons"] = collect(weapons, lambda key, w: t.name(w.get("page") or key, w.get("name")))
    out["gear"] = collect(gear.get("pieces") or {}, lambda key, g: t.name(g.get("page") or key, g.get("name")))
    out["sets"] = collect(gear.get("sets") or {}, lambda key, s: t.name(key, s.get("name") or key))
    out["enemies"] = collect(enemies, lambda key, e: t.name(e.get("page") or key, e.get("name")))

    terms: dict[str, str] = {}
    labels = set(glossary) | set(EXTRA_TERMS)
    for op in operators.values():
        labels.update(filter(None, [op.get("class"), op.get("element"), op.get("weapon_type")]))
        labels.update(op.get("tags") or [])
    for label in sorted(labels):
        ru = t.name(label, label)
        if not ru and label in TERM_ALIASES:
            ru = t.name(TERM_ALIASES[label], TERM_ALIASES[label])
        if ru:
            terms[label] = ru
    out["terms"] = terms

    OUT.write_text(json.dumps(out, ensure_ascii=False, indent=1, sort_keys=True) + "\n", encoding="utf-8")
    sizes = {k: len(v) for k, v in out.items() if k != "meta"}
    print(f"{OUT.relative_to(ROOT)}: {sizes}")
    print(f"  source: wiki {t.stats['wiki']}, client {t.stats['client']}, not found {t.stats['missing']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
