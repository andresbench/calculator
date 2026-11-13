#!/usr/bin/env python3
"""The effects layer: hand-written YAML → flat records for the bundle.

Why it exists is in `data/endfield/effects/README.md`. In short: the wiki gives
a talent's text but does not say which formula group it lands in. This is the
only place where that decision is written down.

Only parsing and checking happen here. This module invents no numbers: values
come from the YAML, text from `operators.json`, and a mismatch between them
becomes a ``stale`` flag rather than silent trust in an old parse.

Run on its own to look at mismatches without building the bundle::

    python3 tools/ef/effects.py
"""

from __future__ import annotations

import importlib.util
import argparse
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
EFFECTS_DIR = ROOT / "data" / "endfield" / "effects"

sys.path.insert(0, str(ROOT))

from tools.common.yamlio import load_yaml

# The unit of every stat. The decision about units is made exactly here and in
# export.py, nowhere else: in wiki text "+8" is both a percentage and a flat
# number, and only knowing the stat tells them apart.
STAT_UNITS: dict[str, str] = {
    "attr": "flat",
    "atk_flat": "flat",
    "hp_flat": "flat",
    "arts_intensity": "flat",
    "skill_multiplier": "mult",
    "sp_return_mult": "mult",
    "cooldown_flat": "sec",
    "reaction_duration": "sec",
    "reaction_duration_mult": "mult",
    "reaction_dot_mult": "mult",
    "stagger_flat": "stagger",
    "sp_return": "sp",
    "sp_cost": "sp",
    # The rest are fractions: percentages are divided by 100 on export.
    "atk_pct": "frac",
    "atk_attr_factor": "frac",
    "hp_pct": "frac",
    "attr_pct": "frac",
    "dmg_reduction": "frac",
    "treatment": "frac",
    "crit_rate": "frac",
    "crit_dmg": "frac",
    "dmg_bonus": "frac",
    "amp": "frac",
    "susceptibility": "frac",
    "dmg_taken": "frac",
    "weaken": "frac",
    "protect": "frac",
    "def_shred": "frac",
    "res_ignore": "frac",
    "base_multiplier": "frac",
    "stagger_eff": "frac",
    "ult_gain_eff": "frac",
    "cooldown_pct": "frac",
    # «performs 1 hit that deals 250 % ATK»: an instance, not a standing buff.
    "extra_hit": "frac",
    "reaction_max": "frac",
    "ult_cost_pct": "frac",
}

ATTRIBUTES = {"HP", "ATK", "STR", "AGL", "INT", "WIL"}
# "Main attribute +10" on a weapon and "Secondary attribute +32 %": which
# attribute it is depends on the operator, not the item. The engine resolves it.
RELATIVE_ATTRIBUTES = {"MAIN", "SUB"}
CONFIDENCE = {"confirmed", "inferred", "unknown"}
# `others` — the team minus the wearer: "other teammates gain…" on Eternal Xiranite.
TARGETS = {"self", "team", "others", "enemy", "spender"}

SKILL_TYPES = {"Basic Attack", "Battle Skill", "Combo Skill", "Ultimate"}
GRANT_KEYS = {"term", "skillType", "variant", "add", "multiplier", "durationDelta", "atMost"}

ELITE_RE = re.compile(r"Elite\s*(\d+)", re.I)
# "{1}" instead of a number: the value comes from the weapon table by column.
PLACEHOLDER_RE = re.compile(r"\{(\d+)\}")

# Layer files that describe items rather than an operator.
ITEM_FILES = {"weapons.yaml", "gear-sets.yaml"}


def normalize(text: str | None) -> str:
    """Text with whitespace differences ignored: the wiki wraps lines at random."""
    return re.sub(r"\s+", " ", (text or "").replace(" ", " ")).strip()


def elite_of(condition: str | None) -> int:
    match = ELITE_RE.search(condition or "")
    return int(match.group(1)) if match else 0


def slug(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", (name or "").lower()).strip("-")


def json_copy(value):
    """A deep copy of a record: a clone for the operator's second key."""
    import copy

    return copy.deepcopy(value)


def _apply_entry(
    raw: dict, *, where: str, problems: list[str], table: list[list[float]] | None = None
) -> dict | None:
    """One ``apply`` row → a bundle record with an explicit unit.

    ``table`` holds a weapon component's values by column. For weapons the
    YAML holds ``"{1}"`` rather than a number: which of the nine values applies
    depends on the specific item's essence, and the engine picks it.
    """
    stat = raw.get("stat")
    if stat not in STAT_UNITS:
        problems.append(f"{where}: unknown stat «{stat}»")
        return None
    unit = raw.get("unit") or STAT_UNITS[stat]
    value = raw.get("value")
    column_values = None
    if isinstance(value, str):
        match = PLACEHOLDER_RE.fullmatch(value.strip())
        if not match or table is None or int(match.group(1)) >= len(table):
            problems.append(f"{where}: value «{value}» does not point to a weapon table column")
            return None
        column_values = table[int(match.group(1))]
        value = None
    elif not isinstance(value, (int, float)):
        problems.append(f"{where}: «{stat}» has no numeric value")
        return None
    if stat in {"attr", "attr_pct"}:
        attribute = raw.get("attribute")
        if attribute not in ATTRIBUTES | RELATIVE_ATTRIBUTES:
            problems.append(f"{where}: attr without an attribute ({attribute})")
            return None

    per = raw.get("perAttribute") or []
    for key in per:
        if key not in ATTRIBUTES:
            problems.append(f"{where}: perAttribute contains «{key}»")

    def scale(number: float) -> float:
        # Percentages → fractions. Everything else as in the game text.
        return round(number / 100.0, 8) if unit == "frac" else number

    out: dict = {
        "stat": stat,
        "unit": unit,
        "value": scale(value) if value is not None else None,
        "rawValue": value,
        "target": raw.get("target") or ("enemy" if stat in {"susceptibility", "dmg_taken", "weaken", "def_shred", "res_ignore"} else "self"),
        "trigger": raw.get("trigger"),
    }
    if column_values is not None:
        out["values"] = [scale(number) for number in column_values]
        out["rawValues"] = list(column_values)
    if out["target"] not in TARGETS:
        problems.append(f"{where}: target «{out['target']}» is outside the vocabulary")
    if stat in {"attr", "attr_pct"}:
        out["attribute"] = raw["attribute"]
    if per:
        out["perAttribute"] = list(per)
    for key in ("element", "skillType", "skill", "name", "reaction"):
        if raw.get(key) is not None:
            out[key] = raw[key]
    if raw.get("staggered") is not None:
        out["staggered"] = bool(raw["staggered"])
    if raw.get("targetHas"):
        out["targetHas"] = list(raw["targetHas"])
    if raw.get("stacks"):
        stacks = raw["stacks"]
        out["stacks"] = {"max": int(stacks.get("max", 1)), "perTrigger": int(stacks.get("perTrigger", 1))}
        # "+6 % × consumed stacks": as many stacks as the step consumed.
        if stacks.get("from") is not None:
            if stacks["from"] != "consumed":
                problems.append(f"{where}: stacks.from «{stacks['from']}» is outside the vocabulary")
            out["stacks"]["from"] = stacks["from"]
            # «Duration of each stack is counted separately»: casts add up.
            if stacks.get("accumulate"):
                out["stacks"]["accumulate"] = True
    # "Next battle skill DMG +30 %": the buff is spent by a cast from this list.
    if raw.get("spentBy") is not None:
        out["spentBy"] = raw["spentBy"]
    # "If the wielder is also the controlled operator": fires only then.
    if raw.get("controlled"):
        out["controlled"] = True
    if raw.get("duration") is not None:
        out["duration"] = raw["duration"]
    if raw.get("durationDelta") is not None:
        out["durationDelta"] = raw["durationDelta"]
    if raw.get("teamShare") is not None:
        out["teamShare"] = raw["teamShare"]
    # «Effect trigger cooldown: 15s» — seconds before the row may fire again.
    if raw.get("cooldown") is not None:
        out["cooldown"] = raw["cooldown"]
    # «… and [10 Stagger]»: the extra hit's own Stagger, a plain number.
    if raw.get("stagger") is not None:
        out["stagger"] = raw["stagger"]
    if stat == "extra_hit" and not raw.get("trigger"):
        problems.append(f"{where}: extra_hit without a trigger")
    return out


# A potential's edit of another effect (`Effect.modifies` in the engine): a key
# outside this set would be silently ignored by the engine.
MODIFIES_KEYS = {"effect", "stacksMax", "trigger", "valueDelta", "teamShare"}


def _grant_entries(raw: dict, *, where: str, problems: list[str]) -> list[dict]:
    """``grants``: a potential's edit of a skill's own Susceptibility or Amp.

    The skill row holds the value (`export.py`, `skill_grants`); the layer
    says what a potential changes in it: ``add`` (percent, as in the game
    text), ``multiplier``, ``durationDelta`` (seconds), ``atMost`` — the
    «has no Vulnerability stacks» condition loosened to that many (Lifeng's
    P1). ``variant`` narrows it to one of Arcane's arrays.
    """
    out = []
    for line in raw.get("grants") or []:
        unknown = set(line) - GRANT_KEYS
        if unknown or not line.get("term") or line.get("skillType") not in SKILL_TYPES:
            problems.append(f"{where}: grants row {line} — needs term and skillType, knows {sorted(GRANT_KEYS)}")
            continue
        entry = {key: line[key] for key in ("term", "skillType", "variant", "multiplier", "durationDelta", "atMost") if key in line}
        if "add" in line:
            entry["add"] = line["add"] / 100
        out.append(entry)
    return out


def _entry(
    *,
    operator_key: str,
    kind: str,
    name: str,
    condition: str | None,
    group: str,
    group_mode: str,
    tier: int,
    requires: dict,
    wiki_text: str | None,
    seen: str | None,
    raw: dict,
    inherited: dict,
    problems: list[str],
    table: list[list[float]] | None = None,
) -> dict:
    where = f"{operator_key} / {name}" + (f" / {condition}" if condition else "")
    applies = []
    for line in raw.get("apply") or []:
        parsed = _apply_entry(line, where=where, problems=problems, table=table)
        if parsed:
            applies.append(parsed)

    # Checking against the wiki. A mismatch is not a build error but a flag: the
    # parse may belong to the previous patch, and the app must show that.
    grants = _grant_entries(raw, where=where, problems=problems)
    modifies = raw.get("modifies")
    if modifies is not None:
        unknown = set(modifies) - MODIFIES_KEYS
        if unknown or "effect" not in modifies:
            problems.append(f"{where}: modifies keys {sorted(modifies)} — the vocabulary is {sorted(MODIFIES_KEYS)}")
    stale = False
    if applies or grants or raw.get("modifies"):
        if seen is None:
            problems.append(f"{where}: has apply but no seen — nothing to catch drift with")
        elif wiki_text is None:
            problems.append(f"{where}: no such text in the wiki data")
        elif normalize(seen) != normalize(wiki_text):
            stale = True

    confidence = raw.get("confidence") or inherited.get("confidence") or "unknown"
    if confidence not in CONFIDENCE:
        problems.append(f"{where}: confidence «{confidence}» is outside the vocabulary")
    suffix = {"talent": f".e{tier}", "potential": f".p{tier}"}.get(kind, "")
    return {
        "id": f"{slug(operator_key)}.{kind}.{slug(name)}{suffix}",
        "operator": operator_key,
        "source": {"kind": kind, "name": name, "condition": condition},
        "group": group,
        "groupMode": group_mode,
        "tier": tier,
        "requires": requires,
        "text": wiki_text,
        "seen": seen,
        "stale": stale,
        "apply": applies,
        "modifies": raw.get("modifies"),
        **({"grants": grants} if grants else {}),
        "unmodeled": raw.get("unmodeled"),
        "confidence": confidence,
        "evidence": raw.get("evidence") or inherited.get("evidence"),
        "note": raw.get("note"),
    }


def load_effects(operators: dict, weapons: dict | None = None, gear: dict | None = None) -> dict:
    """Reads `data/endfield/effects/*.yaml` and checks it against the wiki data.

    ``weapons`` and ``gear`` are `weapons.json` and `gear.json`; without them
    they are read from disk.
    """
    if not EFFECTS_DIR.exists():
        return {"entries": [], "problems": ["no data/endfield/effects directory"], "covered": []}
    if importlib.util.find_spec("yaml") is None:
        return {"entries": [], "problems": ["PyYAML is not installed"], "covered": []}

    entries: list[dict] = []
    problems: list[str] = []
    covered: list[str] = []

    for path in sorted(EFFECTS_DIR.glob("*.yaml")):
        if path.name in ITEM_FILES:
            continue
        document = load_yaml(path) or {}
        operator_key = document.get("operator")
        if not operator_key:
            problems.append(f"{path.name}: no operator field")
            continue
        record = operators.get(operator_key)
        if record is None:
            problems.append(f"{path.name}: operator «{operator_key}» is not in operators.json")
            continue
        # `also` — the same parse for another key. Needed exactly for
        # Endministrator: the wiki data has two operators, male and female,
        # differing only in gender and internal id.
        twins = [key for key in document.get("also") or [] if key in operators]
        for key in document.get("also") or []:
            if key not in operators:
                problems.append(f"{path.name}: also points to «{key}», which is not in operators.json")
        covered.append(operator_key)
        covered.extend(twins)
        revid = (record.get("source") or {}).get("revid")

        wiki_talents = {talent.get("name"): talent for talent in record.get("talents") or []}
        for talent in document.get("talents") or []:
            name = talent.get("name")
            wiki = wiki_talents.get(name)
            if wiki is None:
                problems.append(f"{operator_key}: talent «{name}» is not on the wiki")
            mode = talent.get("stacking") or "replaces"
            if mode not in {"replaces", "cumulative"}:
                problems.append(f"{operator_key} / {name}: stacking «{mode}» is outside the vocabulary")
                mode = "replaces"
            group = f"{slug(operator_key)}.talent.{slug(name)}"
            by_condition = {
                normalize(level.get("condition")): level for level in (wiki or {}).get("levels") or []
            }
            for level in talent.get("levels") or []:
                condition = level.get("condition")
                wiki_level = by_condition.get(normalize(condition))
                entry = _entry(
                    operator_key=operator_key,
                    kind="talent",
                    name=name,
                    condition=condition,
                    group=group,
                    group_mode="sum" if mode == "cumulative" else "highest",
                    tier=elite_of(condition),
                    requires={"elite": elite_of(condition)},
                    wiki_text=(wiki_level or {}).get("text"),
                    seen=level.get("seen"),
                    raw=level,
                    inherited=talent,
                    problems=problems,
                )
                entry["revid"] = revid
                entries.append(entry)

        wiki_potentials = {p.get("rank"): p for p in record.get("potentials") or []}
        for potential in document.get("potentials") or []:
            rank = potential.get("rank")
            wiki_potential = wiki_potentials.get(rank)
            if wiki_potential is None:
                problems.append(f"{operator_key}: potential {rank} is not on the wiki")
            title = (wiki_potential or {}).get("title") or f"Potential {rank}"
            entry = _entry(
                operator_key=operator_key,
                kind="potential",
                name=title,
                condition=f"Potential {rank}",
                group=f"{slug(operator_key)}.potential.{rank}",
                group_mode="highest",
                tier=int(rank or 0),
                requires={"potential": int(rank or 0)},
                wiki_text=(wiki_potential or {}).get("text"),
                seen=potential.get("seen"),
                raw=potential,
                inherited={},
                problems=problems,
            )
            entry["revid"] = revid
            entries.append(entry)

        if twins:
            mine = [entry for entry in entries if entry["operator"] == operator_key]
            for twin in twins:
                for entry in mine:
                    clone = json_copy(entry)
                    clone["operator"] = twin
                    clone["id"] = f"{slug(twin)}.{clone['id'].split('.', 1)[1]}"
                    clone["group"] = f"{slug(twin)}.{clone['group'].split('.', 1)[1]}"
                    entries.append(clone)

    if weapons is None:
        weapons = json.loads((ROOT / "data" / "endfield" / "weapons.json").read_text(encoding="utf-8"))
    if gear is None:
        gear = json.loads((ROOT / "data" / "endfield" / "gear.json").read_text(encoding="utf-8"))
    entries.extend(_weapon_entries(weapons, problems))
    entries.extend(_gear_set_entries(gear, problems))

    stale = [entry["id"] for entry in entries if entry["stale"]]
    modeled = sum(1 for entry in entries if entry["apply"] or entry.get("grants"))
    return {
        "entries": entries,
        "problems": problems,
        "covered": sorted(covered),
        "counts": {
            "entries": len(entries),
            "modeled": modeled,
            "unmodeled": sum(1 for entry in entries if entry["unmodeled"]),
            "stale": len(stale),
            "weapons": len({entry["item"] for entry in entries if entry["source"]["kind"] == "weapon"}),
            "gearSets": len({entry["item"] for entry in entries if entry["source"]["kind"] == "gear-set"}),
        },
    }


# Weapon stat components: the placement is mechanical, the template
# unambiguous, and writing it by hand for each of ~70 weapons would mean
# copying one line. The key is the whole text template: if the wiki changes it,
# the component stops being recognised and lands in problems rather than being
# placed from old memory.
STATIC_COMPONENTS: dict[str, dict] = {
    "ATK +{0}%": {"stat": "atk_pct"},
    "Agility +{0}": {"stat": "attr", "attribute": "AGL"},
    "Strength +{0}": {"stat": "attr", "attribute": "STR"},
    "Will +{0}": {"stat": "attr", "attribute": "WIL"},
    "Intellect +{0}": {"stat": "attr", "attribute": "INT"},
    "Main attribute +{0}": {"stat": "attr", "attribute": "MAIN"},
    "Arts Intensity +{0}": {"stat": "arts_intensity"},
    "Critical Rate +{0}%": {"stat": "crit_rate"},
    "Max HP +{0}%": {"stat": "hp_pct"},
    "Treatment Efficiency +{0}%.": {"stat": "treatment"},
    "Ultimate Gain Efficiency +{0}%": {"stat": "ult_gain_eff"},
    "Arts DMG Dealt +{0}%": {"stat": "dmg_bonus", "element": "Arts"},
    "Physical DMG Dealt +{0}%": {"stat": "dmg_bonus", "element": "Physical"},
    "Heat DMG Dealt +{0}%": {"stat": "dmg_bonus", "element": "Heat"},
    "Cryo DMG Dealt +{0}%": {"stat": "dmg_bonus", "element": "Cryo"},
    "Electric DMG Dealt +{0}%": {"stat": "dmg_bonus", "element": "Electric"},
    "Nature DMG Dealt +{0}%": {"stat": "dmg_bonus", "element": "Nature"},
}

STATIC_KEY = re.compile(r"^.+ \[[LMS]\]$")


def _item_entry(*, kind: str, item: str, name: str, group: str, **rest) -> dict:
    """An item record: the same shape as a talent's, plus ``item``."""
    entry = _entry(operator_key=item, kind=kind, name=name, group=group, group_mode="highest", **rest)
    entry["operator"] = None
    entry["item"] = item
    entry["id"] = f"{kind}.{slug(item)}.{slug(name)}"
    return entry


def _weapon_entries(weapons: dict, problems: list[str]) -> list[dict]:
    """Stat components of every weapon + named effects from `weapons.yaml`."""
    entries: list[dict] = []
    for weapon_name, record in sorted(weapons.items()):
        revid = (record.get("source") or {}).get("revid")
        for comp in record.get("skill_components") or []:
            key = comp.get("key") or ""
            if not STATIC_KEY.match(key) or not comp.get("values_by_rank"):
                continue
            mapping = STATIC_COMPONENTS.get(comp.get("text_template") or "")
            if mapping is None:
                problems.append(f"{weapon_name} / {key}: template «{comp.get('text_template')}» not recognised")
                continue
            template = comp.get("text_template")
            entry = _item_entry(
                kind="weapon",
                item=weapon_name,
                name=key,
                group=f"weapon.{slug(weapon_name)}.{slug(key)}",
                condition=None,
                tier=0,
                requires={},
                wiki_text=template,
                seen=template,
                raw={"apply": [{**mapping, "value": "{0}"}], "confidence": "confirmed"},
                inherited={},
                problems=problems,
                table=comp["values_by_rank"],
            )
            entry["component"] = key
            entry["revid"] = revid
            entries.append(entry)

    path = EFFECTS_DIR / "weapons.yaml"
    if not path.exists():
        return entries
    document = load_yaml(path) or {}
    for item in document.get("weapons") or []:
        weapon_name = item.get("name")
        record = weapons.get(weapon_name)
        if record is None:
            problems.append(f"weapons.yaml: weapon «{weapon_name}» is not in weapons.json")
            continue
        components = {c.get("key"): c for c in record.get("skill_components") or []}
        named = [key for key in components if not STATIC_KEY.match(key or "")]
        key = item.get("component") or (named[0] if len(named) == 1 else None)
        comp = components.get(key)
        if comp is None:
            problems.append(f"weapons.yaml / {weapon_name}: component «{key}» not found")
            continue
        entry = _item_entry(
            kind="weapon",
            item=weapon_name,
            name=key,
            group=f"weapon.{slug(weapon_name)}.{slug(key)}",
            condition=None,
            tier=0,
            requires={},
            wiki_text=comp.get("text_template"),
            seen=item.get("seen"),
            raw=item,
            inherited={},
            problems=problems,
            table=comp.get("values_by_rank") or [],
        )
        entry["component"] = key
        entry["revid"] = (record.get("source") or {}).get("revid")
        entries.append(entry)
    return entries


def _gear_set_entries(gear: dict, problems: list[str]) -> list[dict]:
    """Set bonuses from `gear-sets.yaml`; the text is checked against the item pages."""
    path = EFFECTS_DIR / "gear-sets.yaml"
    if not path.exists():
        return []
    document = load_yaml(path) or {}
    sets = gear.get("sets") or {}
    entries: list[dict] = []
    for item in document.get("sets") or []:
        name = item.get("name")
        record = sets.get(name)
        if record is None:
            problems.append(f"gear-sets.yaml: set «{name}» is not in gear.json")
            continue
        pieces = int(item.get("pieces") or 3)
        entry = _item_entry(
            kind="gear-set",
            item=name,
            name=name,
            group=f"gear-set.{slug(name)}",
            condition=f"{pieces}-piece",
            tier=pieces,
            requires={"pieces": pieces},
            wiki_text=record.get("text"),
            seen=item.get("seen"),
            raw=item,
            inherited={},
            problems=problems,
        )
        entries.append(entry)
    return entries


# Checking against the client datamine. Stat → which attribute it touches in
# the client and at which formula stage it must sit. The stage is given only
# where it changes the result (ATK and HP with their multiplicative groups) and
# where it has been checked — README, "ATK stages in the game code". Where the
# stage is ``None``, only presence and value are checked.
DATAMINE_ATTRS: dict[str, tuple[int, set[int] | None]] = {
    "atk_pct": (2, {6}),  # BaseMultiplier
    "atk_flat": (2, {7}),  # BaseFinalAddition
    "hp_pct": (1, {6}),
    "crit_rate": (9, None),
    "crit_dmg": (10, None),
    "arts_intensity": (87, None),
}
DATAMINE_ATTRIBUTES = {"STR": 39, "AGL": 40, "INT": 41, "WIL": 42}
# AtkIncreaseFactorFrom{Str,Agi,Wisd,Will}: point coefficients in AttributeBonus.
DATAMINE_FACTORS = {"STR": 76, "AGL": 77, "INT": 78, "WIL": 79}
DATAMINE_ELEMENTS = {"Physical": 50, "Heat": 51, "Electric": 52, "Cryo": 53, "Nature": 54}

VERDICTS = {
    "ok": "matches",
    "stage": "a different formula stage",
    "value": "a different value",
    "stacks": "a different stack count",
    "absent": "the client record has no such attribute",
    "unreached": "the client returns no attributes for this record (someone else applies the buff)",
    "no_record": "no record in the client",
    "skipped": "the stat is not checked",
}
# These verdicts are mismatches with the client; the rest are gaps in the check.
DATAMINE_MISMATCH = {"stage", "value", "stacks", "absent"}


def _expected(line: dict) -> list[tuple[str, int, set[int] | None, float]] | None:
    """What an ``apply`` row claims about the client: [(kind, key, stages, value)].

    A list, because one row may touch several attributes (``atk_attr_factor``
    over INT and WIL). The row matches if all of them match.
    """
    stat = line["stat"]
    if stat == "attr":
        return [("attr", DATAMINE_ATTRIBUTES[line["attribute"]], {5}, line["value"])]
    if stat == "atk_attr_factor":
        return [("attr", DATAMINE_FACTORS[key], None, line["value"]) for key in line.get("perAttribute") or []]
    if line.get("perAttribute"):
        return None
    if stat in DATAMINE_ATTRS:
        key, stages = DATAMINE_ATTRS[stat]
        return [("attr", key, stages, line["value"])]
    filtered = any(line.get(key) is not None for key in ("skillType", "skill", "staggered", "targetHas"))
    if stat == "dmg_bonus" and line.get("element") in DATAMINE_ELEMENTS and not filtered:
        return [("attr", DATAMINE_ELEMENTS[line["element"]], None, line["value"])]
    if stat == "ult_cost_pct":
        return [("param", 1, {2}, 1 + line["rawValue"] / 100.0)]  # cost × (1 − 15 %)
    if stat == "cooldown_flat" and line.get("skillType") == "Combo Skill":
        return [("param", 2, {1}, line["rawValue"])]
    return None


def _verdict(facts: list, kind: str, key: int, stages: set[int] | None, value: float, line: dict) -> str:
    same = [f for f in facts if f.kind == kind and f.key == key]
    staged = [f for f in same if stages is None or f.stage in stages]
    valued = [f for f in staged if f.value is None or _close(f.value, value)]
    if not same:
        return "absent"
    if not staged:
        return "stage"
    if not valued:
        return "value"
    want = (line.get("stacks") or {}).get("max", 1)
    return "ok" if any((f.stacks or 1) == want for f in valued) else "stacks"


def _close(a: float, b: float) -> bool:
    # The client stores float32: 0.08 there is 0.07999999821.
    return abs(a - b) <= 1e-4 * max(1.0, abs(a), abs(b))


def verify_datamine(result: dict, operators: dict) -> dict | None:
    """Each ``apply`` row against what the client gives; None — no clone."""
    try:
        from tools.ef import datamine
    except ImportError:
        sys.path.insert(0, str(ROOT))
        from tools.ef import datamine
    if not datamine.available():
        return None

    rows = []
    for entry in result["entries"]:
        if entry["operator"] is None:
            continue  # the client keeps items in other tables — no check yet
        record = operators.get(entry["operator"]) or {}
        char = datamine.character(record.get("id") or "")
        source = entry["source"]
        facts = None
        if char is not None:
            if source["kind"] == "potential":
                facts = char.potential(entry["tier"])
            else:
                names = [t.get("name") for t in record.get("talents") or []]
                if names and source["name"] == names[0]:
                    facts = char.attribute.get(entry["tier"])
                elif source["name"] in names:
                    facts = char.passive(names.index(source["name"]) - 1, entry["tier"])

        for line in entry["apply"]:
            row = {"id": entry["id"], "line": line, "facts": facts or []}
            expected = _expected(line)
            if expected is None:
                row["verdict"] = "skipped"
            elif facts is None:
                row["verdict"] = "no_record"
            elif not facts:
                row["verdict"] = "unreached"
            else:
                verdicts = [_verdict(facts, *claim, line) for claim in expected]
                row["verdict"] = next((v for v in verdicts if v != "ok"), "ok")
            rows.append(row)

    pins = ROOT / "data" / "endfield" / "upstream.json"
    pin = (json.loads(pins.read_text(encoding="utf-8")).get("endfield-data") or {}) if pins.exists() else {}
    return {"pin": pin.get("sha", "")[:7], "rows": rows}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.parse_args(argv)

    with (ROOT / "data" / "endfield" / "operators.json").open(encoding="utf-8") as handle:
        operators = json.load(handle)
    result = load_effects(operators)
    counts = result.get("counts", {})
    print(f"operators parsed: {len(result['covered'])} — {', '.join(result['covered'])}")
    print(f"weapons: {counts.get('weapons', 0)}, sets: {counts.get('gearSets', 0)}")
    print(
        f"records {counts.get('entries', 0)}, with a placement {counts.get('modeled', 0)}, "
        f"not expressible in the vocabulary {counts.get('unmodeled', 0)}"
    )
    for entry in result["entries"]:
        if entry["stale"]:
            print(f"\n! MISMATCH {entry['id']}")
            print(f"    was:  {normalize(entry['seen'])}")
            print(f"    now:  {normalize(entry['text'])}")
    for problem in result["problems"]:
        print(f"  ! {problem}")

    check = verify_datamine(result, operators)
    mismatches = 0
    if check is None:
        print("\ndatamine check skipped: no clone (python3 tools/ef/sync.py)")
    else:
        from collections import Counter

        counts = Counter(row["verdict"] for row in check["rows"])
        print(f"\nclient datamine check, pin {check['pin']}:")
        for verdict, label in VERDICTS.items():
            if counts[verdict]:
                print(f"  {counts[verdict]:3d}  {label}")
        for row in check["rows"]:
            if row["verdict"] not in DATAMINE_MISMATCH:
                continue
            mismatches += 1
            line = row["line"]
            print(f"\n! {VERDICTS[row['verdict']].upper()} {row['id']}")
            print(f"    layer:   {line['stat']} {line['rawValue']} ({line['unit']})")
            for fact in row["facts"]:
                print(f"    client:  {fact.describe()}")
    return 1 if result["problems"] or mismatches else 0


if __name__ == "__main__":
    sys.exit(main())
