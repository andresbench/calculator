#!/usr/bin/env python3
"""Phase 2: raw Endfield data → normalised JSON.

The input is what ``tools/ef/fetch.py`` stored; the output is files in
``data/endfield/`` that can be queried programmatically:

* ``operators.json`` — metadata, stat curves, skills with tables over
  12 levels, talents, potentials, base skills;
* ``weapons.json``  — weapons with their skills;
* ``gear.json``     — gear with stats and set bonuses;
* ``enemies.json``  — HP/DEF/resistances and Stagger, needed for any damage;
* ``glossary.json`` — mechanic terms from the Lua module;
* ``factory.json``  — the AIC factory: buildings, recipes, items, flow.

Percentages become fractions (24% → 0.24) right here: the calculator will
multiply anyway, and a "24%" string is just postponed parsing.
"""

from __future__ import annotations

import argparse
import html
import json
import os
import re
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from tools.common.luadata import parse_assignment
from tools.common.store import manifest_entry, manifest_titles, redirect_target, safe_filename
from tools.common.wikitext import (
    find_templates,
    find_templates_deep,
    glossary_aliases,
    glossary_terms,
    parse_number_list,
    section,
    split_tabber,
    strip_markup,
)

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "data" / "endfield"
RAW = DATA / "raw"

# Six points on stat curves — confirmed by Template:Operator data.
STAT_BREAKPOINTS = [
    "base",
    "elite1_lv20",
    "elite2_lv40",
    "elite3_lv60",
    "elite4_lv80",
    "elite4_lv90",
]

SKILL_SLOTS = {
    "1": "Basic Attack",
    "2": "Battle Skill",
    "3": "Combo Skill",
    "4": "Ultimate",
}

SKILL_LEVELS = 12

ATTRIBUTE_KEYS = ["HP", "ATK", "STR", "AGL", "INT", "WIL"]

# Enemy resistances in the template come as wphysical/wfire/… — these are
# multipliers from the Resistance Multiplier formula, 1 = no resistance.
ENEMY_RESIST_KEYS = {
    "wphysical": "Physical",
    "wfire": "Heat",
    "welectric": "Electric",
    "wice": "Cryo",
    "wnature": "Nature",
    "waether": "Aether",
}


def load_cargo(name: str) -> list[dict]:
    """A Cargo table with HTML entities decoded.

    Cargo returns some strings already escaped: ``GearSets.GearSet`` arrives
    as ``Aburrey&#39;s Legacy``, while ``GearStats.SetName`` arrives as
    ``Aburrey's Legacy``. Without decoding, a set's key and the link to it from
    an item stop matching, and the set is silently lost.
    """
    path = RAW / "cargo" / f"{name}.json"
    if not path.exists():
        return []
    with path.open(encoding="utf-8") as handle:
        rows = json.load(handle)
    return [
        {
            key: html.unescape(value) if isinstance(value, str) else value
            for key, value in row.items()
        }
        for row in rows
    ]


def load_manifest() -> dict:
    path = DATA / "_manifest.json"
    if not path.exists():
        return {}
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


def read_page(kind: str, title: str) -> str | None:
    path = RAW / kind / (safe_filename(title) + ".wiki")
    if not path.exists():
        return None
    text = path.read_text(encoding="utf-8")
    return None if redirect_target(text) else text


_REPORTED_REDIRECTS: set[Path] = set()


def raw_pages(directory: Path) -> list[tuple[Path, str]]:
    """``[(path, text)]`` for the ``*.wiki`` files in a raw directory, redirects
    left out.

    A ``#REDIRECT [[…]]`` page is an alias, not content; four of them used to
    come out as mechanics with an ``overview`` reading "#REDIRECT Arts Burst"
    (audit B33). Each skipped page is printed once per run.
    """
    pages: list[tuple[Path, str]] = []
    for path in sorted(directory.glob("*.wiki")) if directory.exists() else []:
        text = path.read_text(encoding="utf-8")
        target = redirect_target(text)
        if target is None:
            pages.append((path, text))
        elif path not in _REPORTED_REDIRECTS:
            _REPORTED_REDIRECTS.add(path)
            print(f"  - skipped redirect: {path.relative_to(DATA)} → {target}")
    return pages


class ModuleError(Exception):
    """A Lua module did not parse: the file built from it must not be written."""


def parse_module(path: Path, label: str) -> dict | list:
    """``parse_assignment(…, "data")`` that fails loudly.

    A failure used to print a line and carry on with ``{}``, and the build
    wrote an empty JSON and exited 0 (audit B34). Now it stops the file.
    """
    try:
        return parse_assignment(path.read_text(encoding="utf-8"), "data")
    except Exception as exc:  # noqa: BLE001 — wrapped, not swallowed
        raise ModuleError(f"{label}: {exc}") from exc


def describe(raw: str) -> dict:
    """Description text + machine links to the glossary.

    Terms are kept as a separate list: they are what turns a description from
    a string into linked data — through them an agent reaches the mechanic.
    """
    return {
        "text": strip_markup(raw),
        "terms": glossary_terms(raw),
    }


def parse_stat_row(value: str) -> dict | None:
    """"BATK SEQ 1 Multiplier, 24%, 26%, …" → a label and 12 values.

    Trap: for skills with several sequences the wiki puts them in ONE stat row
    one after another — N blocks of 12 values. The blocks differ in meaning:
    Mi Fu's "SP Cost" holds 12×100 (MOVE 1), then 12×50 and 12×50 (MOVE 2 and
    3); Camille's combo has two blocks of zeros after the 12 real cooldowns.
    So extra blocks can be neither cut off (losing the cost of MOVE 2/3) nor
    kept as a flat list: then values[-1] returns another sequence's value —
    zero instead of an 18 s cooldown for Camille.

    The row is split into blocks: ``values`` is always the first sequence's
    curve (12 values), and ``sequences`` appears only when there is more than
    one sequence.
    """
    label, _, rest = value.partition(",")
    label = label.strip()
    if not label or not rest.strip():
        return None
    values = parse_number_list(rest)
    row = {
        "label": label,
        "values": values,
        "is_percent": "%" in rest,
    }
    if len(values) > SKILL_LEVELS and len(values) % SKILL_LEVELS == 0:
        blocks = [
            values[i : i + SKILL_LEVELS]
            for i in range(0, len(values), SKILL_LEVELS)
        ]
        row["values"] = blocks[0]
        row["sequences"] = blocks
    return row


def parse_operator_page(text: str) -> dict:
    record: dict = {}
    if find_templates(text, "Upcoming"):
        record["upcoming"] = True

    infoboxes = find_templates(text, "Operator infobox")
    if infoboxes:
        params = infoboxes[0]["params"]
        record.update(
            {
                "rarity": int(params["rarity"]) if params.get("rarity", "").isdigit() else None,
                "class": params.get("class") or None,
                "weapon_type": params.get("weapon") or None,
                "element": params.get("element") or None,
                "faction": params.get("faction") or None,
                "tags": [t.strip() for t in params.get("tags", "").split(",") if t.strip()],
                "main_attribute": params.get("main") or None,
                "sub_attribute": params.get("sub") or None,
                "headhunting": params.get("headhunting") or None,
                "race": params.get("race") or None,
            }
        )

    data_blocks = find_templates(text, "Operator data")
    if data_blocks:
        params = data_blocks[0]["params"]
        attributes = {}
        for key in ATTRIBUTE_KEYS:
            values = parse_number_list(params.get(key, ""))
            if values:
                attributes[key] = dict(zip(STAT_BREAKPOINTS, values))
        record["attributes"] = attributes
        record["breakpoints"] = STAT_BREAKPOINTS

        crit = parse_number_list(params.get("CR", ""))
        speed = parse_number_list(params.get("AS", ""))
        record["crit_rate"] = crit[0] if crit else None
        record["attack_speed"] = speed[0] if speed else None
        record["attack_range"] = params.get("AR") or None

        record["elite_costs"] = {
            f"elite{n}": strip_markup(params[f"e{n}"])
            for n in range(1, 5)
            if params.get(f"e{n}")
        }
        record["potentials"] = [
            {
                "rank": n,
                "title": strip_markup(params.get(f"pot{n}t", "")),
                **describe(params[f"pot{n}"]),
            }
            for n in range(1, 7)
            if params.get(f"pot{n}")
        ]

    # Battle skills may be split into tabs: Arcane has two stances with the
    # same names but different numbers. The tab label is part of the data;
    # without it the variants cannot be told apart.
    skills = []
    combat_section = section(text, "Combat Skills") or text
    for variant, chunk in split_tabber(combat_section):
      for block in find_templates(chunk, "Combat skill"):
        params = block["params"]
        slot_templates = find_templates(params.get("type", ""), "SB")
        slot = slot_templates[0]["params"].get("1") if slot_templates else None
        stats = []
        for index in range(1, 21):
            row = params.get(f"stat{index}")
            if not row:
                continue
            parsed = parse_stat_row(row)
            if parsed:
                stats.append(parsed)
        skills.append(
            {
                "name": strip_markup(params.get("name", "")),
                "variant": variant,
                "slot": int(slot) if slot and slot.isdigit() else None,
                "type": SKILL_SLOTS.get(slot or "", None),
                "icon": params.get("icon") or None,
                **describe(params.get("desc", "")),
                "stats": stats,
            }
        )
    record["skills"] = skills
    variants = [v for v in {s["variant"] for s in skills} if v]
    if variants:
        record["skill_variants"] = sorted(variants)

    talents = []
    for block in find_templates(text, "Operator talent"):
        params = block["params"]
        levels = []
        for index in range(1, 7):
            condition = params.get(f"cond{index}", "").strip()
            description = params.get(f"desc{index}", "").strip()
            if not condition and not description:
                continue
            levels.append({"condition": strip_markup(condition), **describe(description)})
        talents.append(
            {
                "name": strip_markup(params.get("name", "")),
                "icon": params.get("icon") or None,
                "levels": levels,
            }
        )
    record["talents"] = talents

    base_skills = []
    for block in find_templates(text, "Operator base skill"):
        params = block["params"]
        levels = []
        for index in range(1, 5):
            description = params.get(f"desc{index}", "").strip()
            if not description:
                continue
            levels.append(
                {
                    "postfix": params.get(f"postfix{index}", "").strip() or None,
                    "condition": strip_markup(params.get(f"cond{index}", "")),
                    **describe(description),
                }
            )
        base_skills.append(
            {
                "name": strip_markup(params.get("name", "")),
                "facility": params.get("facility") or None,
                "levels": levels,
            }
        )
    record["base_skills"] = base_skills

    return record


def build_operators(manifest: dict) -> dict:
    rows = load_cargo("Operators")
    operators: dict[str, dict] = {}

    # One page may produce several Cargo rows: for Endministrator those are the
    # male and female variants. The key is made composite, or one variant
    # silently overwrites the other.
    page_counts: dict[str, int] = {}
    for row in rows:
        page_counts[row["_pageName"]] = page_counts.get(row["_pageName"], 0) + 1

    for row in rows:
        page = row["_pageName"]
        name = row.get("Operator") or page
        key = name
        if page_counts[page] > 1:
            gender = (row.get("Gender") or "").strip().lower()
            key = f"{name} ({gender})" if gender else name

        record = {
            "key": key,
            "name": name,
            "page": page,
            "id": row.get("Id") or None,
            "gender": row.get("Gender") or None,
            "rarity": int(row["Rarity"]) if str(row.get("Rarity", "")).isdigit() else None,
            "class": row.get("Class") or None,
            "element": row.get("Element") or None,
            "weapon_type": row.get("Weapon") or None,
            "faction": row.get("Faction") or None,
            "main_attribute": row.get("MainAttr") or None,
            "sub_attribute": row.get("SubAttr") or None,
            "tags": [t.strip() for t in (row.get("Tags") or "").split(",") if t.strip()],
        }

        text = read_page("operators", page)
        if text:
            parsed = parse_operator_page(text)
            # Cargo is the source of truth for metadata, the page for numbers:
            # fields from the page must not overwrite non-empty Cargo values.
            for field, value in parsed.items():
                if value in (None, [], {}, ""):
                    continue
                if record.get(field) in (None, [], {}, ""):
                    record[field] = value
                elif field not in record:
                    record[field] = value
            for field in ("attributes", "skills", "talents", "base_skills",
                          "potentials", "elite_costs", "crit_rate",
                          "attack_speed", "attack_range", "breakpoints"):
                if field in parsed:
                    record[field] = parsed[field]

        entry = manifest_entry(manifest, "operators", page) or {}
        record["source"] = {"page": page, "revid": entry.get("revid")}
        operators[key] = record

    return operators


def load_weapon_skill_effects() -> dict:
    """``Module:Weapon skill/data`` — weapon skill effects.

    The text is stored as a template with placeholders ``{0}``, ``{1}``…, and
    the values as separate rows over 9 refinement ranks.

    IMPORTANT about units: numbers are stored as in the module, i.e. "as shown
    in game". Where the text has ``%``, the value 5.0 means 5 %, not 5.0 as a
    fraction. This is NOT the convention of the operators' skill multipliers,
    which are converted to fractions here. They cannot be forced into one: some
    effects are flat ("Agility +{0}"), and dividing those by 100 would be a lie.
    """
    path = RAW / "modules" / (safe_filename("Module:Weapon skill/data") + ".wiki")
    if not path.exists():
        return {}
    table = parse_module(path, "Module:Weapon skill/data")

    effects: dict[str, dict] = {}
    for key, entry in table.items():
        if not isinstance(entry, dict):
            continue
        rows = entry.get("values") or []
        if isinstance(rows, dict):
            rows = [rows[i] for i in sorted(rows)]
        normalised = []
        for row in rows:
            if isinstance(row, dict):
                row = [row[i] for i in sorted(row)]
            normalised.append(list(row) if isinstance(row, list) else [row])
        raw_text = entry.get("text") or ""
        effects[key] = {
            "key": key,
            "text_template": strip_markup(raw_text),
            "terms": glossary_terms(raw_text),
            "values_by_rank": normalised,
            "ranks": len(normalised[0]) if normalised else 0,
        }
    return effects


def build_weapons(manifest: dict) -> dict:
    skills_by_weapon = {row["Weapon"]: row for row in load_cargo("WeaponSkills")}
    effects = load_weapon_skill_effects()
    weapons: dict[str, dict] = {}

    for row in load_cargo("Weapons"):
        page = row["_pageName"]
        name = row.get("Weapon") or page
        record = {
            "key": name,
            "name": name,
            "page": page,
            "id": row.get("Id") or None,
            "type": row.get("Type") or None,
            "rarity": int(row["Rarity"]) if str(row.get("Rarity", "")).isdigit() else None,
            "manufacturer": row.get("Manufacturer") or None,
            "source_of_acquisition": row.get("Source") or None,
            "skill_name": row.get("Skill") or None,
        }

        # A weapon has up to three skill components: usually two generic stat
        # bonuses and one named effect. Cargo gives their keys, the module the
        # effects themselves.
        skill_row = skills_by_weapon.get(name)
        if skill_row:
            components = []
            for index in (1, 2, 3):
                key = skill_row.get(f"Skill{index}")
                if not key:
                    continue
                component = {"key": key, "tag": skill_row.get(f"SkillTag{index}")}
                effect = effects.get(key)
                if effect:
                    component.update(
                        {
                            "text_template": effect["text_template"],
                            "values_by_rank": effect["values_by_rank"],
                            "terms": effect["terms"],
                        }
                    )
                else:
                    component["unresolved"] = True
                components.append(component)
            record["skill_components"] = components

        text = read_page("weapons", page)
        if text:
            blocks = find_templates(text, "Weapon data")
            if blocks:
                params = blocks[0]["params"]
                attack = parse_number_list(params.get("BATK", ""))
                if attack:
                    record["base_attack"] = dict(zip(STAT_BREAKPOINTS, attack))
                if params.get("pot"):
                    record["potential"] = describe(params["pot"])
            skill_blocks = find_templates(text, "Weapon skill")
            if skill_blocks:
                params = skill_blocks[0]["params"]
                record["skill"] = {
                    "weapon_type": params.get("1"),
                    "stat1": params.get("2"),
                    "stat2": params.get("3"),
                    "name": params.get("4"),
                }

        record["source"] = {"page": page, "revid": (manifest_entry(manifest, "weapons", page) or {}).get("revid")}
        weapons[name] = record

    return weapons


def build_gear() -> dict:
    stats_by_gear = {row["Gear"]: row for row in load_cargo("GearStats")}
    sets = {
        row["GearSet"]: {
            "name": row["GearSet"],
            "level": int(row["Level"]) if str(row.get("Level", "")).isdigit() else None,
            "region": row.get("Region") or None,
            "manufacturer": row.get("Manufacturer") or None,
            **describe(row.get("Effect") or ""),
        }
        for row in load_cargo("GearSets")
    }

    # The second source of bonus text is the `Gear data` template on every item
    # page. Item pages are edited more often than set pages, so on a mismatch
    # they are trusted: Frontiers has 14 items agreeing with each other against
    # one set page with text copied from Hot Work.
    from_pieces: dict[str, Counter] = {}
    # Cargo returns "+13.5%" already as the fraction 0.135, and the percent
    # sign is lost. For attributes that decides everything: "Agility +41" and
    # "Secondary Attribute +13.5%" are one stat name with different units. The
    # marker is taken from the wikitext.
    percent_by_page: dict[str, dict[str, bool]] = {}
    for path, text in raw_pages(RAW / "gear"):
        blocks = find_templates(text, "Gear data")
        if not blocks:
            continue
        params = blocks[0]["params"]
        percent_by_page[path.stem] = {
            kind: "%" in (params.get(f"{prefix}value") or "")
            for prefix, kind in (("p", "primary"), ("s", "secondary"), ("t", "tertiary"))
            if params.get(f"{prefix}stat")
        }
        set_name = (params.get("setname") or "").strip()
        effect = (params.get("seteffect") or "").strip()
        if set_name and effect:
            from_pieces.setdefault(set_name, Counter())[effect] += 1

    # The set registry is the union of two sources, not just the GearSets table.
    # A set may have no page of its own (and hence no GearSets row) while items
    # already refer to it through GearStats.SetName. Such a set used to vanish
    # without a trace; now it enters the registry with empty text and
    # effect_known=false, so the gap is visible rather than silent.
    for row in load_cargo("GearStats"):
        name = (row.get("SetName") or "").strip()
        if name and name not in sets:
            sets[name] = {
                "name": name,
                "level": None,
                "region": None,
                "manufacturer": None,
                "text": "",
                "terms": [],
            }
    for name, record in sets.items():
        votes = from_pieces.get(name)
        if votes:
            winner, count = votes.most_common(1)[0]
            piece_text = describe(winner)
            if piece_text["text"] and piece_text["text"] != record.get("text"):
                record["set_page_text"] = record.get("text") or None
                record.update(piece_text)
                record["effect_source"] = f"item pages ({count})"
                record["conflict"] = bool(record["set_page_text"])
            else:
                record.setdefault("effect_source", "set page and item pages agree")
        elif record.get("text"):
            record["effect_source"] = "set page only"
        record["effect_known"] = bool(record.get("text"))

    pieces: dict[str, dict] = {}
    for row in load_cargo("Gears"):
        name = row.get("Gear") or row["_pageName"]
        stat_row = stats_by_gear.get(name, {})
        percent = percent_by_page.get(row["_pageName"], {})

        stats = []
        for prefix, kind in (("P", "primary"), ("S", "secondary"), ("T", "tertiary")):
            stat_name = stat_row.get(f"{prefix}Stat")
            if not stat_name:
                continue
            values = [
                float(stat_row[f"{prefix}Value{i}"])
                for i in range(4)
                if stat_row.get(f"{prefix}Value{i}") not in (None, "")
            ]
            entry = {"slot": kind, "stat": stat_name, "values": values}
            if kind in percent:
                entry["is_percent"] = percent[kind]
            stats.append(entry)

        pieces[name] = {
            "key": name,
            "name": name,
            "page": row["_pageName"],
            "type": row.get("Type") or None,
            "rarity": int(row["Rarity"]) if str(row.get("Rarity", "")).isdigit() else None,
            "level": int(row["Level"]) if str(row.get("Level", "")).isdigit() else None,
            "artifice": row.get("Artifice") in ("1", "yes", "true", True),
            "region": row.get("Region") or None,
            "manufacturer": row.get("Manufacturer") or None,
            "set": stat_row.get("SetName") or None,
            "defense": int(stat_row["Defense"]) if str(stat_row.get("Defense", "")).isdigit() else None,
            "stats": stats,
        }

    # A set without its own page has neither a level nor a region — they are
    # taken from the items, where they are the same.
    for name, record in sets.items():
        if record.get("level") is not None:
            continue
        members = [p for p in pieces.values() if p.get("set") == name]
        levels = {p.get("level") for p in members if p.get("level")}
        regions = {p.get("region") for p in members if p.get("region")}
        if len(levels) == 1:
            record["level"] = levels.pop()
        if len(regions) == 1:
            record["region"] = regions.pop()

    return {"pieces": pieces, "sets": sets}


def build_enemies(manifest: dict) -> dict:
    enemies: dict[str, dict] = {}

    for row in load_cargo("Enemies"):
        page = row["_pageName"]
        name = row.get("Enemy") or page
        record = {
            "key": name,
            "name": name,
            "page": page,
            "id": row.get("Id") or None,
            "type": row.get("Type") or None,
            "class": row.get("Class") or None,
        }

        text = read_page("enemies", page)
        if text:
            blocks = find_templates(text, "Enemy data")
            if blocks:
                params = blocks[0]["params"]
                for key in ("HP", "ATK", "DEF"):
                    values = parse_number_list(params.get(key, ""))
                    if values:
                        record[key.lower()] = values
                # Resistances: multipliers from the formula, 1.0 = no resistance.
                resistances = {}
                for source, element in ENEMY_RESIST_KEYS.items():
                    values = parse_number_list(params.get(source, ""))
                    if values:
                        resistances[element] = values[0]
                if resistances:
                    record["resistances"] = resistances
                # Field meanings come from Template:Enemy data (revid 60912),
                # where they are labelled by the table headers:
                #
                #   SHP → Stagger HP          size of the stagger gauge
                #   SR  → Stagger Recovery    seconds in the stun
                #   SD  → Finisher ATK Mult   finisher damage multiplier
                #   SPG → Finisher SP Gain    how much SP the finisher gives
                #
                # Until 2026-09-12 the parser called SD "stagger decay" and SPG
                # "stagger gauge". Both names were made up: the enemy page has
                # no labels, and nobody had looked in the template.
                for source, field in (
                    ("SHP", "stagger_hp"), ("SR", "stagger_recovery"),
                    ("SD", "finisher_multiplier"), ("SPG", "finisher_sp"),
                    ("AR", "attack_range"), ("Weight", "weight"),
                ):
                    values = parse_number_list(params.get(source, ""))
                    if values:
                        record[field] = values[0]

        record["source"] = {"page": page, "revid": (manifest_entry(manifest, "enemies", page) or {}).get("revid")}
        enemies[name] = record

    return enemies


def collect_aliases() -> dict[str, list[str]]:
    """Term synonyms collected across all pages.

    The source is the markup itself: ``{{G|Vulnerable|Vulnerability}}`` says
    that in the text this term is called "Vulnerability". No need to guess the
    morphology — the wiki states it explicitly.
    """
    aliases: dict[str, set] = {}
    for kind in ("operators", "weapons", "enemies", "gear_sets", "mechanics"):
        for _path, text in raw_pages(RAW / kind):
            for term, label in glossary_aliases(text):
                aliases.setdefault(term, set()).add(label)
    return {term: sorted(labels) for term, labels in aliases.items()}


def build_glossary() -> dict:
    glossary: dict[str, dict] = {}
    aliases = collect_aliases()
    for module in ("Module:Glossary/misc", "Module:Glossary/narrative"):
        path = RAW / "modules" / (safe_filename(module) + ".wiki")
        if not path.exists():
            continue
        table = parse_module(path, module)
        for term, entry in table.items():
            if term in ("Test", "Temp") or not isinstance(entry, dict):
                continue
            glossary[term] = {
                "term": term,
                "name": entry.get("name") or term,
                "title": entry.get("title") or None,
                # Descriptions use their own pseudo-tags like <phys>…</span>
                # instead of valid HTML — cleaned the same way as wikitext.
                "description": strip_markup(entry.get("desc") or ""),
                "aliases": aliases.get(term, []),
                "source_module": module,
            }
    return glossary


# --------------------------------------------------------------- mechanics

_ROW_RE = re.compile(r"<tr[^>]*>(.*?)</tr>", re.S | re.I)
_CELL_RE = re.compile(r"<(th|td)[^>]*>(.*?)</\1>", re.S | re.I)


def parse_html_table(html: str) -> list[dict]:
    """Numeric tables on mechanic pages are laid out in raw HTML.

    They hold the values by Status Level — what is found neither in skill
    descriptions nor in the glossary.
    """
    rows = []
    for match in _ROW_RE.finditer(html):
        cells = [strip_markup(c[1]).strip() for c in _CELL_RE.findall(match.group(1))]
        if any(cells):
            rows.append(cells)
    if len(rows) < 2:
        return []
    header, *body = rows
    return [dict(zip(header, cells)) for cells in body if len(cells) == len(header)]


def parse_interactions_section(text: str, origin: str) -> dict:
    """Curated interaction lists from mechanic pages.

    The wiki itself lists which operators, weapons and gear sets work with a
    mechanic. That is more reliable than deriving links by regexes over skill
    texts: there it is easy both to miss something and to invent extras.
    """
    result: dict[str, list] = {"operators": [], "weapons": [], "gear_sets": []}

    for block in find_templates_deep(text, "Operator table row"):
        name = strip_markup(block["params"].get("name", "")).strip()
        content = block["params"].get("content", "")
        skills = find_templates_deep(content, "Operator table row/Combat skill")
        if not name:
            continue
        if not skills:
            result["operators"].append(
                {"operator": name, "origin": origin, **describe(content)}
            )
            continue
        for skill in skills:
            params = skill["params"]
            result["operators"].append(
                {
                    "operator": name,
                    "origin": origin,
                    "skill": strip_markup(params.get("name", "")).strip(),
                    "skill_type": strip_markup(params.get("type", "")).strip(),
                    **describe(params.get("content", "")),
                }
            )

    for block in find_templates_deep(text, "Template:Weapon_list_row") + find_templates_deep(
        text, "Weapon_list_row"
    ):
        result["weapons"].append(
            {
                "weapon": strip_markup(block["params"].get("name", "")).strip(),
                **describe(block["params"].get("content", "")),
            }
        )

    for block in find_templates_deep(text, "GearSetsTable"):
        content = block["params"].get("content", "")
        for chunk in re.split(r"<tr>", content):
            names = re.findall(r"\[\[([^\]|]+)(?:\|[^\]]*)?\]\]", chunk)
            if not names:
                continue
            result["gear_sets"].append({"set": names[0].strip(), **describe(chunk)})

    return {key: value for key, value in result.items() if value}


def parse_interactions(text: str) -> dict:
    """Interactions split into sources and other links.

    The ``Sources`` section lists those who APPLY the mechanic, and
    ``Interactions`` those who work with it somehow. The difference matters:
    the first answers "who turns this mechanic on", the second "who needs it".
    """
    merged: dict[str, list] = {}
    sections = {"Sources": "source", "Interactions": "interaction"}
    seen: set = set()

    for heading, origin in sections.items():
        body = section(text, heading)
        if not body:
            continue
        for key, rows in parse_interactions_section(body, origin).items():
            for row in rows:
                marker = (key, row.get("operator") or row.get("weapon") or row.get("set"),
                          row.get("skill"), origin)
                if marker in seen:
                    continue
                seen.add(marker)
                merged.setdefault(key, []).append(row)
    return merged


_HTML_TABLE_RE = re.compile(r"<table[^>]*mrfz-wtable.*?</table>", re.S | re.I)

_HEADING_RE = re.compile(r"^==\s*([^=\n][^=\n]*?)\s*==\s*$", re.M)
# Sections that add nothing to the mechanic.
_SKIP_SECTIONS = {"navigation", "reference", "references", "gallery", "changelog",
                  "trivia", "media", "see also"}


def split_sections(text: str) -> dict:
    """Every ``==Heading==`` section of the page, not one chosen.

    Only ``Overview`` used to be taken, which lost the ``Calculations``
    section — exactly where the wiki spells out which effects add up and which
    multiply, and by what formulas Arts Intensity scales: the multiplier group
    layout.
    """
    marks = list(_HEADING_RE.finditer(text))
    out: dict[str, str] = {}
    for index, match in enumerate(marks):
        title = match.group(1).strip()
        if title.lower() in _SKIP_SECTIONS:
            continue
        end = marks[index + 1].start() if index + 1 < len(marks) else len(text)
        body = text[match.end():end]
        # HTML tables are already parsed into record["tables"]; left in the
        # text, strip_markup flattens them into an unreadable mush like
        # "Arts IntensityArts Intensity Multiplier 0100% 100150%".
        body = _HTML_TABLE_RE.sub("", body)
        body = clean_formulas(body)
        body = plain_text(body)
        if body:
            out[title] = body
    return out


_MATH_RE = re.compile(r"<math>(.*?)</math>", re.S)


def clean_formulas(text: str) -> str:
    """``<math>`` → a formula readable on one line.

    Formulas from mechanic pages are the most valuable thing there, and they
    must not be lost with the tags. LaTeX is brought to a form that can be
    read by eye and parsed with a regex.
    """

    def take_group(text: str, start: int) -> tuple[str, int]:
        """The content of ``{...}`` from position ``start``, accounting for nesting."""
        depth = 0
        for index in range(start, len(text)):
            if text[index] == "{":
                depth += 1
            elif text[index] == "}":
                depth -= 1
                if depth == 0:
                    return text[start + 1:index], index + 1
        return "", start

    def expand_frac(body: str) -> str:
        r"""``\dfrac{a}{b}`` → ``(a)/(b)``.

        Braces are counted by hand: the Arts Intensity denominator looks like
        ``{{Arts\,Intensity}+300}``, and a lazy regex stops at the first closing
        brace, silently turning the formula into a wrong one.
        """
        pattern = re.compile(r"\\[dt]?frac\s*(?=\{)")
        while True:
            match = pattern.search(body)
            if not match:
                return body
            numerator, after = take_group(body, match.end())
            while after < len(body) and body[after] in " \t":
                after += 1
            if after >= len(body) or body[after] != "{":
                return body
            denominator, end = take_group(body, after)
            body = f"{body[:match.start()]}({numerator})/({denominator}){body[end:]}"

    def render(match: re.Match) -> str:
        body = expand_frac(match.group(1))
        body = re.sub(r"\\(?:left|right|,|;|!)", " ", body)
        body = re.sub(r"\\times", "*", body)
        body = re.sub(r"\\[a-zA-Z]+", " ", body)
        body = body.replace("{", "").replace("}", "")
        return "  FORMULA: " + " ".join(body.split())

    return _MATH_RE.sub(render, text)


def build_mechanics(manifest: dict, kind: str = "mechanics") -> dict:
    """Mechanic pages → numbers, formulas and interaction lists."""
    mechanics: dict[str, dict] = {}

    # The file name is not the title: "Item/Natural Resources" is stored as
    # "Item~Natural Resources", and the revid manifest does not find it by that.
    titles = manifest_titles(manifest, kind)
    for path, text in raw_pages(RAW / kind):
        title = titles.get(path.stem, path.stem)
        record: dict = {"name": title, "page": title,
                        "source": {"revid": (manifest_entry(manifest, kind, title) or {}).get("revid")}}

        tables = [parse_html_table(t) for t in _HTML_TABLE_RE.findall(text)]
        tables = [t for t in tables if t]
        if tables:
            record["tables"] = tables

        interactions = parse_interactions(text)
        if interactions:
            record["interactions"] = interactions

        sections = split_sections(text)
        if sections:
            record["sections"] = sections
        # overview is kept for backward compatibility with tools and notes
        # already written.
        overview = sections.get("Overview") or sections.get("Mechanics")
        if overview:
            record["overview"] = overview

        # A page without sections still carries meaning in its infobox and
        # lead paragraph — such pages (Arts Intensity, Attribute, Stagger…) used
        # to be silently dropped by a filter on the number of keys.
        lead = plain_text(clean_formulas(re.split(r"^==", text, maxsplit=1, flags=re.M)[0]))
        if not sections and not tables and not interactions:
            if lead:
                record["overview"] = lead
        elif lead:
            # And on a page with sections the lead paragraph was lost entirely.
            # On Flow Rate it is exactly where the limits are: belt 30/min, pipe
            # 120/min.
            record["lead"] = lead

        if len(record) > 3:
            mechanics[title] = record
    return mechanics


# --------------------------------------------------------------- factory

# ``{{I|Xiragen|g=0}}`` is an item link with an icon. strip_markup does not know
# this template and leaves "Xiragen xg=0", so it is expanded beforehand.
_ITEM_LINK_RE = re.compile(r"\{\{\s*I\s*\|([^{}|]+)(?:\|[^{}]*)?\}\}")
# The recipe table on a building page is built from the same Module:Recipe that
# is parsed in full — in the text it is only noise.
# There may be a nested template inside: ``facility={{PAGENAME}}``.
_RECIPE_TABLE_RE = re.compile(r"\{\{\s*RecipeTable(?:[^{}]|\{\{[^{}]*\}\})*\}\}")

# Modules with factory item descriptions. The other Module:Item/* are currency,
# gifts, profiles and the like, unrelated to production.
FACTORY_ITEM_MODULES = ["AIC Products", "Naturals", "Seeds"]


def plain_text(raw: str) -> str:
    raw = _RECIPE_TABLE_RE.sub("", raw)
    raw = _ITEM_LINK_RE.sub(lambda m: m.group(1).strip(), raw)
    return strip_markup(raw)


def load_recipes() -> list[dict]:
    """Every Module:Recipe/* in one list.

    Time in the module is seconds per cycle, quantities are units per cycle
    (for liquids and gases, units — the same as in Flow Rate). Manual assembly
    recipes (Construct, Crafting) have no time and no building.
    """
    recipes: list[dict] = []
    for path in sorted((RAW / "modules").glob("Module__Recipe~*.wiki")):
        module = path.stem.split("~", 1)[1]
        table = parse_module(path, f"Module:Recipe/{module}")
        for entry in table:
            if not isinstance(entry, dict):
                continue
            recipes.append({
                "module": module,
                "facility": entry.get("facility") or None,
                "mode": entry.get("mode") or None,
                "time": entry.get("time"),
                # The module spells the field with a typo: enviroment.
                "environment": entry.get("enviroment") or None,
                "event": entry.get("eventName") or None if entry.get("event") else None,
                "category": entry.get("category") or None,
                "ingredients": [{"item": i["item"], "count": i["count"]}
                                for i in entry.get("ingredients") or []],
                "products": [{"item": p["item"], "count": p["count"]}
                             for p in entry.get("products") or []],
            })
    return recipes


def build_factory(manifest: dict) -> dict:
    """The factory: buildings, recipes, items and AIC mechanic pages.

    The miner, pump and extractor pages carry no extraction rates — they are on
    ``Item/Natural Resources`` (the mechanics section) and depend on the
    deposit's purity, not on the building.
    """
    recipes = load_recipes()

    facilities: dict[str, dict] = {}
    rows = {row["_pageName"]: row for row in load_cargo("Facilities")}
    pages = [path.stem for path, _text in raw_pages(RAW / "facilities")]
    for page in sorted(set(rows) | set(pages)):
        row = rows.get(page, {})
        record: dict = {
            "name": row.get("Facility") or page,
            "id": row.get("Id") or None,
            "type": row.get("Type") or None,
            "rarity": int(row["Rarity"]) if (row.get("Rarity") or "").isdigit() else None,
        }
        text = read_page("facilities", page)
        if text:
            infobox = find_templates(text, "Facility infobox") or find_templates(text, "Item infobox")
            params = infobox[0]["params"] if infobox else {}
            record["id"] = record["id"] or params.get("filename") or None
            record["type"] = record["type"] or params.get("type") or None
            if record["rarity"] is None and (params.get("rarity") or "").strip().isdigit():
                record["rarity"] = int(params["rarity"])
            power = (params.get("power") or row.get("Power") or "").strip()
            # An empty field is not "zero" but "not given": some buildings need
            # no power, and for some the wiki simply did not fill it in.
            record["power"] = int(power) if power.isdigit() else None
            description = find_templates(text, "Item description")
            if description:
                record["description"] = strip_markup(description[0]["params"].get("1", ""))
            usage = plain_text(section(text, "Usage"))
            if usage:
                record["usage"] = usage
            acquisition = plain_text(section(text, "Acquisition"))
            if acquisition:
                record["acquisition"] = acquisition
        name = record["name"]
        record["build_cost"] = next(
            (r["ingredients"] for r in recipes
             if r["module"] == "Construct" and any(p["item"] == name for p in r["products"])),
            None,
        )
        record["modes"] = sorted({r["mode"] for r in recipes
                                  if r["facility"] == name and r["mode"]})
        record["recipe_count"] = sum(1 for r in recipes if r["facility"] == name)
        record["source"] = {"page": page, "revid": (manifest_entry(manifest, "facilities", page) or {}).get("revid")}
        facilities[name] = record

    items: dict[str, dict] = {}
    for module in FACTORY_ITEM_MODULES:
        path = RAW / "modules" / (safe_filename(f"Module:Item/{module}") + ".wiki")
        if not path.exists():
            continue
        table = parse_module(path, f"Module:Item/{module}")
        for key, entry in table.items():
            if not isinstance(entry, dict):
                continue
            items[key] = {
                "name": entry.get("name") or key,
                "category": module,
                "tier": entry.get("tier"),
                "use": strip_markup(entry.get("use") or ""),
                "obtain": strip_markup(entry.get("obtain") or "") or None,
                "made_by": sorted({r["facility"] or r["module"] for r in recipes
                                   if any(p["item"] == key for p in r["products"])}),
                "used_by": sorted({r["facility"] or r["module"] for r in recipes
                                   if any(i["item"] == key for i in r["ingredients"])}),
            }

    mechanics = build_mechanics(manifest, kind="factory")
    return {
        "facilities": facilities,
        "recipes": recipes,
        "items": items,
        "mechanics": mechanics,
    }


def write(name: str, payload) -> None:
    """Writes through a temporary file: a crash halfway leaves the previous
    file intact instead of a truncated one."""
    path = DATA / name
    tmp = path.with_name(path.name + ".tmp")
    try:
        with tmp.open("w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=1, sort_keys=True)
        os.replace(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)
    size = path.stat().st_size / 1024
    count = len(payload) if hasattr(payload, "__len__") else "?"
    print(f"  {name:18} {count:>5} records  {size:8.1f} KB")


def load_overrides() -> dict:
    """Manual fixes on top of the wiki: ``data/endfield/overrides.json``.

    The wiki sometimes lies, and rebuilding does not cure it — ``fetch.py``
    brings back the same error. Overrides survive re-downloads and leave a
    trace: a fixed record gets an ``_override`` field with the reason, so a fix
    never looks like a fact from the wiki.

    Format: {"gear.sets": {"Frontiers": {"_why": "…", "text": "…"}}}
    The top-level key is "<file without .json>.<section>" or just "<file>".
    """
    path = DATA / "overrides.json"
    if not path.exists():
        return {}
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


def apply_overrides(payloads: dict, overrides: dict) -> None:
    for target, entries in overrides.items():
        if target.startswith("_"):
            continue
        file_key, _, subsection = target.partition(".")
        payload = payloads.get(f"{file_key}.json")
        if payload is None:
            print(f"    ! override for an unknown file: {target}")
            continue
        if subsection:
            payload = payload.get(subsection)
            if payload is None:
                print(f"    ! override for an unknown section: {target}")
                continue
        for key, patch in entries.items():
            record = payload.get(key)
            if record is None:
                print(f"    ! override for an unknown record: {target}/{key}")
                continue
            why = patch.get("_why", "manual fix")
            record.update({k: v for k, v in patch.items() if not k.startswith("_")})
            record["_override"] = why
            print(f"    fix {target}/{key}: {why}")


_NUMBER_RE = re.compile(r"(\d+(?:\.\d+)?)\s*(%?)")


def classify_text_conflict(page_text: str, item_text: str) -> str:
    """``"numbers differ"`` or ``"wording only"`` for two texts of one set bonus.

    The multisets of numbers (with their percent signs) are compared: «gain» vs
    «gains», «Protected» vs «Protection» or «DMG+50%» vs «DMG +50%» are the
    wiki's wording, while «+16%» vs «+18%» changes what the set does. Only the
    second kind is a problem; the item text is taken either way.
    """
    def numbers(text: str) -> Counter:
        return Counter(
            (float(number), percent) for number, percent in _NUMBER_RE.findall(text)
        )

    return "wording only" if numbers(page_text) == numbers(item_text) else "numbers differ"


def check_consistency(payloads: dict) -> int:
    """Mismatches that used to pass silently.

    The point is to make the gap visible in the build output, rather than have
    it surface a month later in an answer about a build. Returns the number of
    real problems, so that ``main`` can fail on them; a set text that differs
    in wording only is a warning and is not counted.
    """
    print("\nConsistency check:")
    problems = 0
    warnings = 0

    gear = payloads["gear.json"]
    piece_sets = {v["set"] for v in gear["pieces"].values() if v.get("set")}
    for name, record in sorted(gear["sets"].items()):
        if record.get("conflict"):
            kind = classify_text_conflict(record.get("set_page_text") or "", record.get("text") or "")
            real = kind == "numbers differ"
            print(f"  {'!' if real else '~'} set «{name}»: the set page and the item pages "
                  f"disagree — {kind}")
            print(f"      took the item text ({record.get('effect_source')})")
            if real:
                problems += 1
            else:
                warnings += 1
    for name in sorted(piece_sets - set(gear["sets"])):
        print(f"  ! items refer to set «{name}», which is not in the registry")
        problems += 1
    for name, record in sorted(gear["sets"].items()):
        count = sum(1 for v in gear["pieces"].values() if v.get("set") == name)
        if not record.get("effect_known") and count:
            print(f"  ! set «{name}»: {count} items, effect text unknown")
            problems += 1

    duplicates: dict[str, list] = {}
    for name, record in gear["sets"].items():
        text = (record.get("text") or "").strip()
        if text and text.lower() != "no set effects":
            duplicates.setdefault(text, []).append(name)
    for names in duplicates.values():
        if len(names) > 1:
            print(f"  ! identical effect text across sets: {', '.join(sorted(names))}")
            problems += 1

    mechanics = payloads["mechanics.json"]
    # Redirects are skipped on purpose (raw_pages), so they are not "lost".
    on_disk = {path.stem for path, _text in raw_pages(RAW / "mechanics")}
    lost = sorted(on_disk - set(mechanics))
    if lost:
        print(f"  ! downloaded but not parsed ({len(lost)}): {', '.join(lost)}")
        problems += 1

    if not problems and not warnings:
        print("  no mismatches")
    elif not problems:
        print(f"  no real problems ({warnings} warning(s))")
    return problems


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.parse_args()

    manifest = load_manifest()
    print("Endfield: raw → JSON")

    builders = {
        "operators.json": lambda: build_operators(manifest),
        "weapons.json": lambda: build_weapons(manifest),
        "weapon_skills.json": load_weapon_skill_effects,
        "gear.json": build_gear,
        "enemies.json": lambda: build_enemies(manifest),
        "glossary.json": build_glossary,
        "mechanics.json": lambda: build_mechanics(manifest),
        "factory.json": lambda: build_factory(manifest),
    }
    payloads: dict[str, dict] = {}
    failed: list[str] = []
    for name, build in builders.items():
        try:
            payloads[name] = build()
        except ModuleError as exc:
            print(f"  ! {name} not written: {exc}")
            failed.append(name)

    # An override for a file that was not built would only say "unknown file".
    overrides = {
        target: entries
        for target, entries in load_overrides().items()
        if f"{target.partition('.')[0]}.json" not in failed
    }
    if overrides:
        print("  overrides:")
        apply_overrides(payloads, overrides)

    for name, payload in payloads.items():
        write(name, payload)

    gear = payloads["gear.json"]
    print(f"  (gear: {len(gear['pieces'])} items, {len(gear['sets'])} sets)")
    problems = check_consistency(payloads)
    if failed:
        print(f"\n{len(failed)} file(s) not written: {', '.join(failed)}")
    if problems:
        print(f"\n{problems} real problem(s) in the data")
    return 1 if failed or problems else 0


if __name__ == "__main__":
    raise SystemExit(main())
