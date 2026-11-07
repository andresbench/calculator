#!/usr/bin/env python3
"""Weapon effects with the numbers filled in.

Why a separate module. Every weapon effect in the data carries **nine**
values, and until 2026-09-06 the column was picked by eye from the Enka
showcase ``rank`` field — that is, almost always the first. The numbers came
out badly understated.

**The column is set by the essence, and for a named effect also by the
refinement rank** (measurements, #6 and #30). The essence arrives from the
showcase in ``weapon.essence.terms`` as a list of terms with costs; in the
game that is the "+N" on an essence line, and the column is the weapon line's
level "6/9"::

    stat component  (``ATK [L]``, ``Physical DMG [M]``, …):  cost + 3
    named effect    (``Infliction: …``, ``Combative: …``):   cost + rank

``rank`` is as in the showcase, ``refineLv + 1``. Points: Endministrator
``Agility`` cost 6 → 9, Chen ``Physical DMG`` cost 5 → 8, Endministrator
``Infliction`` cost 3, rank 1 → 4; weapon screen 2026-10-17, ``Sundering
Steel`` rank 4: ``Agility`` +3 → 6/9, ``Physical DMG`` +1 → 4/9,
``Combative`` +1 → 5/7. The in-game cap agrees with the rule: 6 + 3 = 9 for
stats, 3 + rank for the effect (7 at rank 4).

Terms are matched to components **by family, not by position**
(measurements, #6: matching by position over 25 operators gave 10
conflicts). ``termNumId`` is the term's kind: 42 sits on both ``Agility [L]``
and ``[M]``, and term 74 from ``Combative: Anthem of Cinder`` raised
``Combative: Virtuous Gain``. A term of another family does not apply at all.
The id → family table is ``TERM_FAMILIES``, each id with its own evidence; an
id missing from the table is matched by position and marked ``inferred``.

Without an essence (the weapon set by hand, or the showcase did not report
it) the old ``rank + breakthrough`` estimate remains. It is **refuted** and
marked as an estimate in the output.

Usage::

    python3 tools/ef/weapon.py                  # every weapon from the showcase
    python3 tools/ef/weapon.py "Grand Vision" --rank 1 --breakthrough 4
    python3 tools/ef/weapon.py "Grand Vision" --costs 6,6,3
"""

from __future__ import annotations

import argparse
import json
import re

try:
    from roster import DATA, load_profile
except ImportError:  # imported as a package from export.py
    from tools.ef.roster import DATA, load_profile

PLACEHOLDER = re.compile(r"\{(\d+)\}")


def load_weapons() -> dict:
    with (DATA / "weapons.json").open(encoding="utf-8") as handle:
        return json.load(handle)


STATIC = re.compile(r"^.+ \[[LMS]\]$")


def is_static(key: str) -> bool:
    """A stat component (``ATK [L]``) versus a named effect."""
    return bool(STATIC.match(key or ""))


# Stat components sit at ``cost + STAT_COLUMN_OFFSET``; named effects at ``cost + rank``.
STAT_COLUMN_OFFSET = 3


def column_from_essence(cost: int, columns: int, static: bool, rank: int = 1) -> int:
    """The value table's column from the essence term cost, 1-based.

    The column is **the weapon skill's level**; the game writes it to the
    right of the line ("6/9"). It is set by the essence (``weapon.attachedGem``
    in the Enka API), and for a named effect also by the refinement rank: that
    is the weapon's potential, "Skill … improved".

    =================  ===============================  ====  ====  =======
    weapon             component                        cost  rank  column
    =================  ===============================  ====  ====  =======
    Grand Vision       ``Agility [L]``                  6     1     9
    Sundering Steel    ``Physical DMG [M]`` (Chen's)    5     4     8
    Grand Vision       ``Infliction: Long Time Wish``   3     1     4
    Sundering Steel    ``Agility [M]``                  3     4     6
    Sundering Steel    ``Physical DMG [M]``             1     4     4
    Sundering Steel    ``Combative: Anthem of Cinder``  1     4     5
    =================  ===============================  ====  ====  =======

    Stat components: ``cost + 3`` — rank does not affect them (Agility at
    rank 1 and rank 4 fits one rule). Named effects: ``cost + rank``. For the
    effect that is two points, but they are backed by the cap the game draws:
    "5/7" at rank 4 is 3 (the essence cap per effect) + 4.

    ⚠️ ``breakthroughLv`` is four at every point, so the "+3" for stats may be
    ``breakthrough − 1``. A weapon at another ascension would tell.
    """
    offset = STAT_COLUMN_OFFSET if static else (rank or 1)
    return max(1, min(columns, (cost or 0) + offset))


# Enka showcase termNumId → family, as the component's ``tag`` field in
# weapons.json names it. Only ids with evidence: a weapon screen or a stat
# screen that matched the column rule (``confirmed``), or a repeat on weapons
# with the same component without a screen (``inferred``).
TERM_FAMILIES: dict[int, tuple[str, str]] = {
    42: ("Agility", "confirmed"),  # Grand Vision, Valiant — screens, #6
    44: ("Strength", "inferred"),  # Khravengger
    49: ("ATK", "confirmed"),  # Grand Vision, Thermite Cutter — #24, #23
    50: ("Critical Rate", "inferred"),
    51: ("Will", "confirmed"),  # Thermite Cutter — Pogranichnik's screen, #23
    53: ("Physical DMG", "confirmed"),  # Valiant with Chen's essence — #6
    65: ("Flow", "confirmed"),  # Thermite Cutter: ATK +16 % (4/4) — #23
    68: ("Intellect", "confirmed"),  # Junction Point — Arcane's screen, #28
    69: ("Infliction", "confirmed"),  # Grand Vision — #6
    70: ("Twilight", "inferred"),  # Stanza of Memorials
    72: ("Detonate", "inferred"),  # Khravengger, Brigand's Calling
    74: ("Combative", "confirmed"),  # Sundering Steel → Valiant — #6
    79: ("ULT Efficiency", "inferred"),  # Junction Point, Beacon of Duty
    85: ("Efficacy", "inferred"),  # Junction Point, Beacon of Duty
}


def _family(component: dict) -> str:
    """A component's family: ``tag``, or without it the key minus the size."""
    return component.get("tag") or re.sub(r" \[[LMS]\]$", "", component.get("key") or "")


def essence_columns(record: dict, terms: list[dict], rank: int) -> list[dict]:
    """Each weapon component's column from the essence.

    Returns one record per component: ``column`` (1-based or ``None``),
    ``confidence`` and ``via`` — how the term was matched. ``None`` means there
    is no matching term: the "no essence" state is not described by the rule
    (measurements, #6: on Valiant without an essence the stats sit in column 3
    and the named effect in 6), and no number may be filled in.
    """
    components = [c for c in record.get("skill_components", []) if c.get("values_by_rank")]
    used: set[int] = set()
    out: list[dict] = []
    for index, comp in enumerate(components):
        family = _family(comp)
        static = is_static(comp.get("key", ""))
        columns = len(comp["values_by_rank"][0])
        match = None
        for t_index, term in enumerate(terms):
            known = TERM_FAMILIES.get(term.get("term"))
            if t_index not in used and known and known[0] == family:
                match = (t_index, known[1], f"term {term['term']} — {family}")
                break
        if match is None and index < len(terms) and index not in used:
            term = terms[index]
            if term.get("term") not in TERM_FAMILIES:
                match = (index, "inferred", f"term {term.get('term')} not recognised, taken by position")
        if match is None:
            out.append({"column": None, "confidence": "unknown", "via": f"no term of family {family}"})
            continue
        t_index, confidence, via = match
        used.add(t_index)
        cost = terms[t_index].get("cost") or 0
        out.append(
            {
                "column": column_from_essence(cost, columns, static, rank),
                # The column rule by itself is `inferred` for stats (#6:
                # breakthrough is 4 at every point), but it held on five weapons.
                "confidence": confidence,
                "via": via,
                "cost": cost,
            }
        )
    return out


def column(rank: int, breakthrough: int, columns: int, static: bool) -> int:
    """The fallback when the essence is unknown.

    ⚠️ THIS RULE WAS REFUTED BY MEASUREMENT ON 2026-09-12 and is kept only so
    that the tool prints something for a weapon without an imported essence.
    It is **an estimate**, not a calculation: for Endministrator it gives the
    fifth column where the game shows the ninth.
    """
    base = (rank or 1) + (breakthrough or 0)
    return max(1, min(columns, base if static else base - 1))


def ambiguous(rank: int, breakthrough: int) -> bool:
    """Whether this instance has unverified freedom in picking the column."""
    return True


def fill(template: str, values: list[list[float]], col: int) -> str:
    def repl(match: re.Match) -> str:
        index = int(match.group(1))
        if index >= len(values):
            return match.group(0)
        value = values[index][min(col, len(values[index])) - 1]
        return f"{value:g}"

    return PLACEHOLDER.sub(repl, template)


def describe(
    record: dict, rank: int, breakthrough: int, terms: list[dict] | None = None
) -> list[str]:
    """Rows with weapon effects, numbers already filled in.

    ``terms`` are the essence terms from the showcase (``{term, cost}``);
    without a term id matching goes by position. Without an essence the
    column is taken by the old refuted estimate and marked in the row.
    """
    components = [
        comp for comp in record.get("skill_components", []) if comp.get("values_by_rank")
    ]
    resolved = essence_columns(record, terms, rank) if terms else None

    lines = []
    for index, comp in enumerate(components):
        values = comp["values_by_rank"]
        key = comp.get("key", "")
        static = is_static(key)
        hit = resolved[index] if resolved else None
        if hit and hit["column"] is not None:
            col = hit["column"]
            source = f"cost {hit['cost']}, {hit['via']}, {hit['confidence']}"
        else:
            col = column(rank, breakthrough, len(values[0]), static)
            source = "estimate by rank" + (f"; {hit['via']}" if hit else "")
        kind = "stat" if static else "effect"
        lines.append(
            f"[{kind}, column {col}, {source}] "
            + fill(comp.get("text_template", ""), values, col)
        )
    return lines


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("weapon", nargs="?", help="weapon name; without it — the whole roster")
    parser.add_argument("--rank", type=int, default=1)
    parser.add_argument("--breakthrough", type=int, default=0)
    parser.add_argument(
        "--costs",
        help="essence term costs, comma-separated, in component order: 6,6,3",
    )
    args = parser.parse_args()

    manual_terms = (
        [{"term": None, "cost": int(part)} for part in args.costs.split(",")]
        if args.costs
        else None
    )

    weapons = load_weapons()

    if args.weapon:
        record = weapons.get(args.weapon)
        if not record:
            print(f"No such weapon in the data: {args.weapon}")
            return 1
        entries = [(args.weapon, args.weapon, args.rank, args.breakthrough, manual_terms)]
    else:
        entries = []
        for name, entry in sorted(load_profile().items()):
            weapon = entry.get("weapon") or {}
            if weapon.get("name") in weapons:
                terms = ((weapon.get("essence") or {}).get("terms")) or None
                entries.append(
                    (name, weapon["name"], weapon.get("rank") or 1,
                     weapon.get("breakthrough") or 0, terms)
                )

    estimated = False
    for owner, weapon_name, rank, breakthrough, terms in entries:
        record = weapons[weapon_name]
        print(f"{owner} — {weapon_name} (rank {rank}, breakthrough {breakthrough})")
        lines = describe(record, rank, breakthrough, terms)
        estimated = estimated or any("estimate by rank" in line for line in lines)
        for line in lines:
            print(f"    {line}")
        print()

    print("Column = the weapon line's level in game (\"6/9\"). Stat component:")
    print("cost + 3; named effect: cost + rank (rank = refinement + 1).")
    print("Points — measurements, #6 and #30.")
    print()
    print("⚠ An essence can be moved to another weapon, and the showcase is a snapshot:")
    print("  if a number does not match the game, check the essence first.")
    print("⚠ breakthrough = 4 at every point; the stats' \"+3\" may depend on it.")
    if estimated:
        print()
        print("⚠ Where it says \"estimate by rank\" there was no essence, and the column")
        print("  was taken by the REFUTED rank + breakthrough rule. For Endministrator it")
        print("  gave the fifth column where the game shows the ninth.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
