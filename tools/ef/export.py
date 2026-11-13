#!/usr/bin/env python3
"""Data JSON → the web app bundle.

Why a separate step rather than the app reading ``data/endfield/*.json``
directly:

1. **Units diverge, on purpose.** Operator skill multipliers are converted to
   fractions (380 % → ``3.8``), while weapon effect values are kept as in the
   game (``5.0`` means 5 %), because some effects are flat ("Agility +20")
   and dividing them by 100 would be a lie. Sorting that out in the browser
   would create a second place where units are decided. Here every number
   gets an explicit ``unit`` field, and the engine never guesses again.
2. **The app's schema is versioned separately from the data schema.** The
   parser can change freely as long as ``SCHEMA`` holds the contract.
3. **Provenance.** Every entity keeps its wiki page revid, and the bundle its
   build date. A number in the UI can always be traced back to its source.

Usage::

    python3 tools/ef/export.py
    python3 tools/ef/export.py --out app/public/data/bundle.json
"""

from __future__ import annotations

import argparse
import datetime as _dt
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from tools.common.yamlio import load_yaml
ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "data" / "endfield"
DEFAULT_OUT = ROOT / "app" / "public" / "data" / "bundle.json"

# The bundle contract version. The app refuses to work with another version
# instead of silently reading fields wrong.
SCHEMA = 43

WIKI = "https://endfield.wiki.gg"
LICENSE = "CC BY-SA 4.0"

# The six stat curve points: that is how the {{Operator data}} template gives them.
BREAKPOINTS = [
    {"key": "base", "elite": 0, "level": 1},
    {"key": "elite1_lv20", "elite": 1, "level": 20},
    {"key": "elite2_lv40", "elite": 2, "level": 40},
    {"key": "elite3_lv60", "elite": 3, "level": 60},
    {"key": "elite4_lv80", "elite": 4, "level": 80},
    {"key": "elite4_lv90", "elite": 4, "level": 90},
]


def now() -> str:
    return _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def load(name: str):
    path = DATA / name
    if not path.exists():
        raise SystemExit(f"missing {path} — run tools/ef/parse.py first")
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


# ------------------------------------------------------------------ units

DURATION_RE = re.compile(r"\(s\)|duration", re.I)


def stat_unit(label: str, is_percent: bool) -> str:
    """The unit of a skill stat row.

    ``is_percent`` is set by the parser from the ``%`` in the wiki's source
    row, and the parser has already divided such values by 100. The rest is
    told apart by label: seconds, SP and ultimate energy are quantities of
    different nature, and the engine must not add them up even by mistake.
    """
    if is_percent:
        return "frac"
    low = label.lower()
    if DURATION_RE.search(low) or "cooldown" in low or "interval" in low:
        return "sec"
    if low.startswith("sp ") or "sp cost" in low or "sp recovery" in low or "sp return" in low:
        return "sp"
    if "ultimate energy" in low:
        return "energy"
    if "stagger" in low:
        return "stagger"
    return "flat"


PLACEHOLDER_RE = re.compile(r"\{(\d+)\}")


def template_units(text_template: str, count: int) -> list[str]:
    """Units of the ``{0}``, ``{1}`` placeholders in a weapon effect text.

    Values in ``weapon_skills.json`` are as in the game, so the unit is set by
    **the template itself**: if a ``%`` follows the placeholder right away, it
    is a percentage and the number must be divided by 100. Otherwise it is
    flat — "Agility +20" is no percentage at all.
    """
    units = ["flat"] * count
    for match in PLACEHOLDER_RE.finditer(text_template or ""):
        index = int(match.group(1))
        if index >= count:
            continue
        tail = (text_template[match.end() : match.end() + 2] or "").lstrip()
        units[index] = "frac" if tail.startswith("%") else "flat"
    return units


def to_fraction(value, unit: str):
    """Percentages → fractions. Everything else is left alone."""
    if unit == "frac" and isinstance(value, (int, float)):
        return round(value / 100.0, 6)
    return value


# --------------------------------------------------------------- entities


DAMAGE_LABEL = re.compile(r"multiplier|\bdmg\b", re.I)
NOT_DAMAGE = re.compile(
    r"stagger|susceptib|\bamp\b|protection|slow|treatment|heal|shield|record ratio|"
    r"critical dmg boost|dmg taken|dmg dealt|dmg bonus|duration|chance|cost|ultimate energy|"
    r"reduction|weaken|\bdef\b|\bboost\b|interval",
    re.I,
)
PER_STACK = re.compile(r"\bper\b.*\bstacks?\b|\bper (?:infliction|stack|status level)\b", re.I)
# "Against Solidified Enemies" is an alternative to the "Against
# Non-Solidified" row: counting both as hits double-counts. "During Ultimate:"
# applies only during the ultimate.
CONDITIONAL = re.compile(
    r"^(?:enhanced|early)\b|^bonus dmg multiplier$|^during ultimate|\bagainst (?!non-)", re.I
)
SEQ_LABEL = re.compile(r"\bSEQ (\d+)\b", re.I)


TARGET_WITH_EXTRA = re.compile(r"If the skill hits a target with (?P<term>[A-Z]\w+), the skill deals additional DMG")


def hit_roles(skill_type: str, stats: list[dict]) -> None:
    """Tags damage rows: what kind of hit it is and which stage deals it.

    The decision is made here rather than in the engine, for the same reason
    as units: a row label is wiki data, and it is interpreted in one place.
    Roles:

    * ``hit`` — a hit; ``sequence`` is the stage number (`CS1`, `BS2`) if the
      label has one ("SEQ 2") or the moves are named in order, as for Mi Fu;
    * ``perStack`` — a bonus per consumed stack ("Bonus DMG Multiplier per
      Infliction Stack"): multiplied by Status Level;
    * ``conditional`` — a hit only under a condition ("Enhanced SEQ 3",
      "Early Rogue Wave", a bare "Bonus DMG Multiplier"): not counted in the
      total.

    Rows without ``hit`` are not damage: buff fractions, "DMG Record Ratio",
    "Critical DMG Boost".
    """
    if skill_type == "Basic Attack":
        for row in stats:
            match = re.match(r"BATK SEQ (\d+)", row["label"], re.I)
            if match:
                row["hit"] = {"role": "hit", "sequence": int(match[1]), "part": "chain"}
            elif re.match(r"dive", row["label"], re.I):
                row["hit"] = {"role": "hit", "sequence": None, "part": "dive"}
            elif re.match(r"finisher", row["label"], re.I):
                row["hit"] = {"role": "hit", "sequence": None, "part": "finisher"}
        return

    plain: list[dict] = []
    for row in stats:
        label = row["label"]
        if row["unit"] != "frac" or not DAMAGE_LABEL.search(label) or NOT_DAMAGE.search(label):
            continue
        if PER_STACK.search(label):
            role = "perStack"
        elif CONDITIONAL.search(label):
            role = "conditional"
        else:
            role = "hit"
        seq = SEQ_LABEL.search(label)
        row["hit"] = {"role": role, "sequence": int(seq[1]) if seq else None, "part": None}
        if role == "hit" and not seq:
            plain.append(row)

    # Moves named by name: Mi Fu's "Cloudtrapper", "Trail and Mangle",
    # "World Splitter" are BS1, BS2, BS3. The anchor is the number of moves in
    # "SP Cost".
    moves = next((len(row["sequences"]) for row in stats if row.get("sequences")), 0)
    if moves > 1 and len(plain) == moves and not any(
        SEQ_LABEL.search(row["label"]) for row in stats if row.get("hit")
    ):
        for index, row in enumerate(plain):
            row["hit"]["sequence"] = index + 1


NUMBER = {"two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8, "nine": 9, "ten": 10}
N = r"(\d+|two|three|four|five|six|seven|eight|nine|ten)"
SEQUENCE_ATTACK = re.compile(rf"\b{N}-sequence (\w+)", re.I)
SEQUENCE_COUNT = re.compile(rf"\b{N} (?:\w+ )?(?:sequences|hits)\b", re.I)
FINAL_IN_SEQUENCE = re.compile(r"\bfinal (?:\w+ )?sequence\b", re.I)
# Labels whose hit count depends on time or stacks while the text gives no
# number: "per Beat" (Liino), "Over Time … per SEQ" (Laevatain).
VARIABLE_HITS = re.compile(r"\bper (?:SEQ|Beat|Tick)\b", re.I)
# Damage over time: the row says "Over Time", the ticks are `Interval (s)` and
# `Duration (s)` rows of the same skill; "Total" is the sum over the whole
# duration (Tangtang's `DMG Over Time Total Multiplier`), one hit.
OVER_TIME = re.compile(r"\bOver Time\b", re.I)
TOTAL_LABEL = re.compile(r"\bTotal\b", re.I)
INTERVAL_ROW = re.compile(r"^(?P<stem>.*?)\s*Interval \(s\)$", re.I)
DURATION_ROW = re.compile(r"^(?P<stem>.*?)\s*Duration \(s\)$", re.I)
# "Each enemy can only take 1 damaging hit every 0.3s" (Ardelia's ultimate).
ONE_HIT_EVERY = re.compile(r"\b1 damaging hit every (\d+(?:\.\d+)?) ?s\b", re.I)
# "Her 5th Hail of Arrows is an empowered Hail of Arrows" (Typhoeus's ultimate),
# said of "her next 5 ABATKs".
EMPOWERED_LAST = re.compile(r"\b(?P<n>\d+)(?:st|nd|rd|th) (?P<noun>[A-Z][\w ]*?) is an empowered (?P=noun)\b")
# "unleash 5 Aerial Basic Attacks (ABATK) … her 5th ABATK is regarded as a Final
# Strike" (Typhoeus's battle skill).
UNLEASH_ATTACKS = re.compile(rf"\bunleash {N} [\w ]+? \((?P<abbr>[A-Z]{{2,}})\)")
LAST_IS_FINAL_STRIKE = re.compile(r"\b(?P<n>\d+)(?:st|nd|rd|th) (?P<abbr>[A-Z]{2,}) is regarded as a Final Strike\b")
# "create [Status Level of Electrification consumed +1] Sunderblades … successively
# unleash Thunder Strikes" (Zhuang Fangyi): the number of strikes follows the stacks.
STRIKES_BY_STACKS = re.compile(
    r"\[Status Level of [\w ]+ consumed[^\]]*\].*?\bsuccessively unleash (?P<noun>[A-Z]\w*(?: [A-Z]\w*)*?)s\b",
    re.S,
)


RELEASES = re.compile(r"Number of (?P<what>\w+) Releases$")


def _number(word: str) -> int:
    return int(word) if word.isdigit() else NUMBER[word.lower()]


def hit_counts(skill: dict, stats: list[dict]) -> None:
    """How many times a damage row hits: ``hit.count``.

    The source is **the skill text**, where the number is stated outright. The
    client's timelines will not do for this: Pogranichnik's battle skill has
    two events keyed SEQ 1 there, while in game SEQ 1 is one hit
    (measurements, #23), and so is Endministrator's ultimate (#13).

    * "A 7-sequence slash attack … The final slash sequence deals even more
      DMG" (Chen): the row named by the attack word ("Slash Multiplier") is
      7 − 1 hits, the final one its own row;
    * "6-sequence flurry of slashes … The final step is to bash" (Da Pan):
      the final separately, the "Aerial Flurry" row is 6;
    * "per SEQ" with "2 thrust sequences" / "5 hits" (Akekuri, Wulfgard) — N;
    * "per SEQ / per Beat" with no number in the text — ``count: None``: the
      hit count depends on time or stacks, and the track shows it under "not
      modelled" rather than silently counting one hit;
    * rows that repeat by time or by a stated count (damage over time, "1 hit
      every 0.3s", "next 5 ABATKs") — see ``repeated_hits``.
    """
    text = re.sub(r"\s+", " ", skill.get("text") or "")
    rows = [row for row in stats if row.get("hit") and row["hit"]["role"] != "conditional"]

    attack = SEQUENCE_ATTACK.search(text)
    if attack:
        total, noun = _number(attack[1]), attack[2].lower().rstrip("s")
        final_inside = bool(FINAL_IN_SEQUENCE.search(text))
        for row in rows:
            label = row["label"].lower()
            # Rossi's "SEQ 1 Slash", "SEQ 2 Slash" — the moves are already
            # split into rows, each hits once.
            if noun in label and "final" not in label and not SEQ_LABEL.search(row["label"]):
                row["hit"]["count"] = total - 1 if final_inside else total

    # "Number of Energy Releases" next to "Energy DMG Multiplier" (Yvonne's
    # combo): the count is a row of its own — the wiki's number, not the text's.
    for found in (RELEASES.match(row["label"]) for row in stats):
        if not found:
            continue
        released = next((row for row in stats if row["label"] == found[0]), None)
        target = next((row for row in rows if row["label"] == f"{found['what']} DMG Multiplier"), None)
        if released and target and len(set(released["values"])) == 1:
            target["hit"]["count"] = int(released["values"][0])

    counted = SEQUENCE_COUNT.search(text)
    for row in rows:
        if not VARIABLE_HITS.search(row["label"]) or "count" in row["hit"]:
            continue
        if counted and not re.search(r"over time", row["label"], re.I):
            row["hit"]["count"] = _number(counted[1])
        else:
            row["hit"]["count"] = None

    repeated_hits(text, stats, [row for row in rows if row["hit"]["role"] == "hit"])


def _ticks(stats: list[dict], label: str, interval: float | None) -> int | None:
    """Ticks of a damage-over-time row: ``floor(duration / interval)``, or None.

    The interval is the argument (from the text) or the skill's `Interval (s)`
    row whose stem leads the damage row's label ("DMG Over Time Interval (s)"
    for "DMG Over Time Multiplier"); the duration is the skill's `Duration (s)`
    row (bare, or with such a stem). Whether the first tick lands at the press
    or one interval later is not in any text, so the count is the floor, which
    holds for both: 5 s at 0.5 s is 10 either way (the other reading, 11, needs
    the tick at both ends). A row that differs between levels, or a missing
    one, gives None: the count is not known, and None is the honest answer.
    """

    def single(pattern: re.Pattern) -> float | None:
        found = {
            row["values"][0]
            for row in stats
            if row["unit"] == "sec"
            and (m := pattern.match(row["label"]))
            and (not m["stem"] or label.lower().startswith(m["stem"].lower()))
            and len(set(row["values"])) == 1
        }
        return found.pop() if len(found) == 1 else None

    interval = interval if interval is not None else single(INTERVAL_ROW)
    duration = single(DURATION_ROW)
    if not interval or not duration:
        return None
    return int(duration / interval + 1e-9)


def repeated_hits(text: str, stats: list[dict], rows: list[dict]) -> None:
    """Rows that hit again and again, and the skill text says how often (audit B31).

    A row without a count is one hit; these are not:

    * "… Over Time" with `Interval (s)` and `Duration (s)` rows (Snowshine's
      ultimate: 0.5 s over 5 s) — ``floor(duration / interval)``, see ``_ticks``;
      without them (Typhoeus's `Area DMG Over Time`) — ``None``;
    * "Each enemy can only take 1 damaging hit every 0.3s" and a `Duration
      (s)` (Ardelia's ultimate, 3 s) — the same count for a lone damage row,
      ``None`` where there are several and the text does not say which;
    * "For her next 5 ABATKs … Her 5th Hail of Arrows is an empowered Hail of
      Arrows" (Typhoeus's ultimate): the normal row is 5 − 1, the empowered
      one hit, as with Chen's final slash;
    * "unleash 5 Aerial Basic Attacks (ABATK) … her 5th ABATK is regarded as a
      Final Strike" (Typhoeus's battle skill): `ABATK DMG` is 5 − 1 and the
      `Aerial Final Strike DMG` row is the fifth. Taken from the text's own
      reading of the 5th as the Final Strike; for a non-controlled Typhoeus it
      would be five plain ABATKs, and that case the row does not tell apart;
    * strikes whose number follows the consumed stacks (Zhuang Fangyi's
      Thunder Strikes) — ``None``. The final strike's "6 times the DMG" is not
      modelled either way.

    Only rows with no count yet are touched.
    """
    free = [row for row in rows if "count" not in row["hit"]]

    for row in free:
        if OVER_TIME.search(row["label"]) and not TOTAL_LABEL.search(row["label"]):
            row["hit"]["count"] = _ticks(stats, row["label"], None)

    free = [row for row in free if "count" not in row["hit"]]
    if (capped := ONE_HIT_EVERY.search(text)) and free:
        for row in free:
            row["hit"]["count"] = _ticks(stats, row["label"], float(capped[1])) if len(free) == 1 else None

    free = [row for row in free if "count" not in row["hit"]]
    if (last := EMPOWERED_LAST.search(text)) and re.search(rf"\bnext {last['n']}\b", text):
        total = int(last["n"])
        for row in free:
            if last["noun"].lower() in row["label"].lower() and not re.match(r"empowered\b", row["label"], re.I):
                row["hit"]["count"] = total - 1

    free = [row for row in free if "count" not in row["hit"]]
    if (attacks := UNLEASH_ATTACKS.search(text)) and (final := LAST_IS_FINAL_STRIKE.search(text)):
        if final["abbr"] == attacks["abbr"] and int(final["n"]) == _number(attacks[1]):
            for row in free:
                if re.match(rf"{attacks['abbr']} DMG\b", row["label"]):
                    row["hit"]["count"] = int(final["n"]) - 1

    free = [row for row in free if "count" not in row["hit"]]
    if strikes := STRIKES_BY_STACKS.search(text):
        for row in free:
            if row["label"].lower().startswith(strikes["noun"].lower()):
                row["hit"]["count"] = None


SWITCH_TEXT = re.compile(r"the ultimate is switched to ([A-Z][\w' ]+?)\.", re.I)
UNLEASH_TEXT = re.compile(r"unleashes an? ([A-Z][\w' ]+?) that", re.I)


def ultimate_phases(skill: dict, stats: list[dict]) -> dict | None:
    """A two-phase ultimate: "After … the ultimate is switched to Gloompurge Arcana".

    The first cast sets something up (Arcane's array), the second is a
    different hit. Second-phase rows are those starting with its name:
    ``sequence 2``; the other hits are ``sequence 1``. That the array
    "unleashes" from others' actions (Cluster Strike from finishers) does not
    belong to the ultimate cast: ``conditional``. The second phase's window is
    the first duration in the stats, other than reaction durations
    ("Gloompurger Array Duration (s)").
    """
    text = skill.get("text") or ""
    match = SWITCH_TEXT.search(text)
    if not match:
        return None
    second = match[1].strip()
    unleashed = {name.strip() for name in UNLEASH_TEXT.findall(text)}
    for row in stats:
        hit = row.get("hit")
        if not hit:
            continue
        if row["label"].startswith(second):
            hit["sequence"] = 2
        elif any(row["label"].startswith(name) for name in unleashed):
            hit["role"] = "conditional"
        else:
            hit["sequence"] = 1
    window = next(
        (
            row["values"][-1]
            for row in stats
            if row["unit"] == "sec" and re.search(r"Duration \(s\)$", row["label"])
            and not re.search(r"Corrosion|Combustion|Electrification|Solidification", row["label"])
        ),
        None,
    )
    return {"to": second, "window": window}


SP_LABEL = re.compile(r"\bSP (Recovery|Return)\b", re.I)
SP_CONSUMING = re.compile(r"by Consuming (\d+) \w+ Stacks?", re.I)

# Conditions the skill text states and the row label only hints at. Each rule
# reads one phrase; a row no rule recognises stays `conditional` and out of
# the total, as before.
LINK_CONSUMED = re.compile(r"\bconsumes? (?:a |the )?Link\b", re.I)
CRYSTALS_ON_TARGET = re.compile(r"already has Originium Crystals.*?\bshatters\b", re.I | re.S)
MOVES_BY_STACKS = re.compile(
    r"a number of \w+ sequences \(up to (\d+)\) based on the (?:max )?number of (\w+) stacks? consumed",
    re.I,
)
ENHANCED_AT = re.compile(r"Consuming (\d+) stacks of \w+ enhances the (\d)(?:st|nd|rd|th) \w+ sequence", re.I)


def skill_conditions(skill: dict, stats: list[dict]) -> dict | None:
    """Rows whose hit or SP depends on what the step consumed, from the text.

    * "If the skill consumes a Link, then it deals an additional hit" — the
      `Additional …` row lands only when the cast spent Link (Lifeng's
      ultimate): ``when: consumes:Link``.
    * "If the enemy already has Originium Crystals on them, this skill
      shatters the Originium Crystals and deals 1 more hit" — the bare
      `Bonus DMG Multiplier` (Endministrator's ultimate).
    * `Crystal Shattering …` on the skill that attaches the crystals is not
      its own hit: it lands when somebody consumes them (measurements, #2:
      from the Endministrator's ATK). Role ``delayed``.
    * "a number of slash sequences (up to 3) based on the max number of
      Vulnerability stacks consumed" — Pogranichnik's combo is one press, and
      the stacks decide how many sequences it performs. Returned as the
      skill's ``moves``; "Consuming 4 stacks … enhances the 3rd" makes the
      `Enhanced SEQ 3` rows replace SEQ 3 at that count.
    * Points a cast generates and other steps spend (`synergy.charges`):
      Pogranichnik's `Harass …` rows land on every spent Steel Oath point,
      `Decisive Assault …` on the last one — not at the ultimate itself. Hit
      role ``delayed``, ``when: charge:<name>`` / ``chargeLast:<name>``; SP
      rows ``when: charge`` / ``chargeLast``.
    """
    from tools.ef.synergy import charges

    text = skill.get("text") or ""
    for charge in charges({"skills": [skill]}).values():
        for row in stats:
            for key, prefix in (("charge", charge["each"]), ("chargeLast", charge.get("last"))):
                if not prefix or not row["label"].startswith(f"{prefix} "):
                    continue
                if row.get("hit"):
                    row["hit"].update(role="delayed", when=f"{key}:{charge['name']}")
                if row.get("sp"):
                    row["sp"]["when"] = key
    for row in stats:
        hit = row.get("hit")
        label = row["label"]
        if hit and LINK_CONSUMED.search(text) and re.match(r"Additional\b", label, re.I):
            hit.update(role="conditional", when="consumes:Link")
        elif hit and CRYSTALS_ON_TARGET.search(text) and re.fullmatch(r"Bonus DMG Multiplier", label, re.I):
            hit.update(role="conditional", when="consumes:Originium Crystal")
        elif hit and re.match(r"Crystal Shattering\b", label, re.I):
            hit.update(role="delayed", when="consumed:Originium Crystal")
        # Estella's combo: «If the skill hits a target with Solidification, the
        # skill deals additional DMG» — the row «… Against Solidified Enemies».
        elif hit and (found := TARGET_WITH_EXTRA.search(text)) and re.search(r"\bAgainst Non-\w+ Enemies\b", label):
            # The pair is either/or: the game's table gives the whole hit each way.
            hit.update(role="conditional", when=f"target_lacks:{found['term']}")
        elif hit and (found := TARGET_WITH_EXTRA.search(text)) and re.search(r"\bAgainst \w+ Enemies\b", label):
            hit.update(role="conditional", when=f"target_has:{found['term']}")

    moves = MOVES_BY_STACKS.search(text)
    if not moves:
        return None
    out: dict = {"by": "stacks", "max": int(moves[1])}
    enhanced = ENHANCED_AT.search(text)
    if enhanced:
        stacks, sequence = int(enhanced[1]), int(enhanced[2])
        out["enhanced"] = {"stacks": stacks, "sequence": sequence}
        for row in stats:
            if not re.match(r"Enhanced SEQ %d\b" % sequence, row["label"], re.I):
                continue
            if row.get("hit"):
                row["hit"].update(when=f"stacks:{stacks}")
            if row.get("sp"):
                row["sp"] = {**row["sp"], "when": "sequence", "sequence": sequence, "stacks": stacks}
    return out


FINAL_STRIKE_STAGGER = re.compile(r"As the controlled operator, Final Strike also deals (\d+) Stagger", re.I)


def final_strike_stagger(skill: dict) -> int | None:
    """"As the controlled operator, Final Strike also deals 16 Stagger."

    The basic attack's only stagger: the chain has no stagger rows, and the
    whole-chain stagger in the user's basic attack table equals this number
    for every operator. Belongs to the `FS` step, which on the track is
    always the controlled operator's.
    """
    if skill.get("type") != "Basic Attack":
        return None
    match = FINAL_STRIKE_STAGGER.search(skill.get("text") or "")
    return int(match[1]) if match else None


def sp_roles(stats: list[dict]) -> None:
    """Tags SP rows: recovery or refund, and when it applies.

    The ``recovery`` / ``return`` distinction is from the `Skill Points` page:
    refunded SP does not trigger "on SP recovery" effects and gives no ultimate
    energy. When a row applies:

    * ``always`` — "SP Recovery", "SP Return", "Base SP Recovery";
    * ``consumed`` — "SP Recovery by Consuming 3 Vulnerability Stacks": only
      if the step consumed exactly that many stacks (the ``stacks`` field);
    * ``sequence`` — "SEQ 2 SP Recovery": on that stage (the ``sequence``
      field);
    * ``conditional`` — everything else: "Enhanced", "Additional", "per Target
      Defeated", "MAX", "per SEQ", moves by name ("Hunter Pursuit"). Not
      counted: the condition is not visible from the label.
    """
    for row in stats:
        label = row["label"]
        kind_match = SP_LABEL.search(label)
        if row["unit"] != "sp" or not kind_match:
            continue
        kind = kind_match[1].lower()
        consuming = SP_CONSUMING.search(label)
        seq = SEQ_LABEL.search(label)
        if consuming:
            row["sp"] = {"kind": kind, "when": "consumed", "stacks": int(consuming[1])}
        elif seq and label.lower().startswith("seq "):
            row["sp"] = {"kind": kind, "when": "sequence", "sequence": int(seq[1])}
        elif re.fullmatch(r"(Base )?SP (Recovery|Return)", label, re.I):
            row["sp"] = {"kind": kind, "when": "always"}
        else:
            row["sp"] = {"kind": kind, "when": "conditional"}


# «per Infliction Stack», «per Vulnerable Stack»: the label names the kind of stack.
ENERGY_STACK_KIND = re.compile(r"\b(infliction|vulnerab\w*)\b", re.I)
ENERGY_TARGETS = re.compile(r"\bwhen hitting (\d+) enem", re.I)
# «After the combo skill successfully hits the enemy, Yvonne gains additional
# Ultimate Energy»: a gain the text ties to the skill landing.
ENERGY_ON_HIT = re.compile(r"\bskill (?:successfully )?hits\b", re.I)


def energy_roles(skill: dict, stats: list[dict]) -> None:
    """Tags the rows of a combo skill that give the caster Ultimate Energy.

    A combo's energy is not one row. The engine used to read the first row
    called `Ultimate Energy Gain`, which for Last Rite was her «Base» 40
    without the «15 per Infliction Stack» (85-100 in all), for Rossi only
    SEQ 1, for Yvonne without her «Additional» and for Zhuang Fangyi without
    the «+10 per Infliction Stack». Roles (``energy``, only for rows of unit
    ``energy`` in a Combo Skill, and never the ultimate's `Cost`):

    * ``base`` — «Ultimate Energy Gain», «Base Ultimate Energy Gain»: once
      per cast;
    * ``perStack`` — «… per Infliction Stack»: multiplied by the stacks the
      cast consumed. ``stack`` is the kind the label names (``infliction`` or
      ``vulnerable``), else the one the skill text names; a row that names
      none stays ``conditional``;
    * ``perSequence`` — «SEQ 2 Ultimate Energy Gain»: ``sequence`` is the
      stage that gives it (Rossi's two sequences give 10 each);
    * ``onHit`` — a gain tied to the skill landing: Yvonne's «Additional
      Ultimate Energy Gain» (the text says «after the combo skill
      successfully hits»), Laevatain's «when Hitting N Enemies» (``targets``).
      The engine's target is a single enemy that is always hit, so it counts
      the row without ``targets`` and the one for 1 enemy;
    * ``conditional`` — the condition is not visible from the label: not
      counted.

    Battle-skill energy (Laevatain's, Typhoeus's, Zhuang Fangyi's «per Thunder
    Strike») is another mechanism — a cast's own stacks, `Synergy.ownStacks`
    — and is not tagged here.
    """
    if skill.get("type") != "Combo Skill":
        return
    text = re.sub(r"\s+", " ", skill.get("text") or "")
    for row in stats:
        label = row["label"]
        if row["unit"] != "energy" or re.search(r"\bcost\b", label, re.I):
            continue
        if seq := re.match(r"SEQ (\d+) ", label, re.I):
            role: dict = {"role": "perSequence", "sequence": int(seq[1])}
        elif targets := ENERGY_TARGETS.search(label):
            role = {"role": "onHit", "targets": int(targets[1])}
        elif PER_STACK.search(label):
            kind = ENERGY_STACK_KIND.search(label) or ENERGY_STACK_KIND.search(text)
            if kind:
                stack = "vulnerable" if kind[1].lower().startswith("vulner") else "infliction"
                role = {"role": "perStack", "stack": stack}
            else:
                role = {"role": "conditional"}
        elif re.fullmatch(r"(Base )?Ultimate Energy Gain", label, re.I):
            role = {"role": "base"}
        elif label.lower().startswith("additional ") and ENERGY_ON_HIT.search(text):
            role = {"role": "onHit"}
        else:
            role = {"role": "conditional"}
        row["energy"] = role


# «MOVE 1 - Cloudtrapper: Costs 100 SP and returns50 SP after casting» (Mi
# Fu) and «Final Stroke: Costs no SP» (Si): what each stage of a multi-stage
# battle skill costs, stated in the text and missing from the cost row.
STAGE_COST = re.compile(
    r"(?:MOVE (?P<move>\d) - )?(?P<name>[A-Z][\w' ]*?): Costs (?P<cost>\d+|no) SP(?: and returns ?(?P<back>\d+) SP)?"
)


def stage_costs(skill: dict, stats: list[dict]) -> None:
    """Completes the `SP Cost` row's stages and adds an `SP Return` row from the text.

    A stage is numbered by its ``MOVE n``, or else by order after the skill
    itself: Si's skill is stage 1, Initial Stroke 2, Final Stroke 3. The cost
    row of a multi-stage skill lists its stages (`sequences`), but the wiki
    leaves out a free one — Si's has 100 and 15 and no third — and the
    engine used to read the missing stage as the full cost. A stage the row
    has is checked against the text instead of overwritten.
    """
    if skill.get("type") != "Battle Skill":
        return
    text = re.sub(r"\s+", " ", skill.get("text") or "")
    stages = []
    for order, found in enumerate(STAGE_COST.finditer(text)):
        number = int(found["move"]) if found["move"] else order + 2
        stages.append((number, 0 if found["cost"] == "no" else int(found["cost"]), int(found["back"] or 0)))
    cost = next((row for row in stats if row["label"] == "SP Cost"), None)
    if not stages or not cost or "sequences" not in cost:
        return
    width = len(cost["values"])
    for number, value, _ in stages:
        if number <= len(cost["sequences"]):
            listed = cost["sequences"][number - 1][-1]
            if listed != value:
                print(f"  ! {skill.get('name')}: stage {number} costs {listed} SP by the row, {value} by the text")
        elif number == len(cost["sequences"]) + 1:
            cost["sequences"].append([float(value)] * width)
    back = {number: value for number, _, value in stages if value}
    if back:
        count = max(len(cost["sequences"]), *back)
        stats.append(
            {
                "label": "SP Return",
                "unit": "sp",
                "values": [float(back.get(1, 0))] * width,
                "sequences": [[float(back.get(n, 0))] * width for n in range(1, count + 1)],
                "sp": {"kind": "return", "when": "always"},
                "fromText": True,
            }
        )


def sp_counts(skill: dict, stats: list[dict]) -> None:
    """«2 thrust sequences, with each sequence … recovering some SP» (Akekuri):
    an «SP Recovery per SEQ» row recovers once per sequence, as its damage
    row hits. Without a number it stays conditional."""
    counted = SEQUENCE_COUNT.search(re.sub(r"\s+", " ", skill.get("text") or ""))
    if not counted:
        return
    for row in stats:
        sp = row.get("sp")
        if sp and sp["kind"] == "recovery" and re.search(r"\bper SEQ\b", row["label"]):
            row["sp"] = {"kind": "recovery", "when": "always", "count": _number(counted[1])}


def transformed_rows(record: dict, skills: list[dict]) -> None:
    """Rows of a move an ultimate turns the battle skill into (`synergy.transforms`).

    Camille's `Hunter Pursuit …` rows sit in his combo skill, and the track
    counted them on every combo. They land only on the transformed battle
    skill: every row of the move gets ``move: <name>`` — its hit, its
    stagger, its SP (``when: transformed``) — and the host's own cast leaves
    them out.
    """
    from tools.ef.synergy import transforms

    for entry in transforms(record).values():
        host = next((skill for skill in skills if skill["type"] == entry["as"]), None)
        if not host:
            continue
        for row in host["stats"]:
            if not row["label"].startswith(f"{entry['into']} "):
                continue
            # Every row of the move — its hit, stagger and SP — belongs to it, not to the host's own cast.
            row["move"] = entry["into"]
            if row.get("sp"):
                row["sp"] = {"kind": row["sp"]["kind"], "when": "transformed"}


BARRAGE_TEXT = re.compile(r"\bTemporarily enhances \w+'s basic attack \(BATK\)")
BARRAGE_EXTRA = re.compile(r"\bperforms an additional attack\b.*?\bthen consumes the enemy's (?P<term>[A-Z]\w+)")
BARRAGE_SHOT = "BATK DMG Multiplier"
BARRAGE_END = "Enhanced Final Strike DMG Multiplier"
BARRAGE_EXTRA_ROW = "Additional ATK DMG Multiplier"
BARRAGE_STACK = {"rate": "Critical Rate Boost per Stack", "atMax": "Critical DMG Boost at Max Stacks", "max": "Max Stacks"}
FPS = 30


def ultimate_barrage(skill: dict, frames: dict | None) -> dict | None:
    """An ultimate that is one long cast of enhanced basic attacks: Yvonne's.

    «Temporarily enhances Yvonne's basic attack (BATK). Each enhanced BATK
    sequence performed grants a stack of Critical Rate buff. After reaching
    max stacks, Yvonne also gains a Critical DMG buff. When the skill is
    about to end, Yvonne's last enhanced BATK becomes an enhanced Final
    Strike … If the enemy is Solidified, Yvonne performs an additional attack
    … and then consumes the enemy's Solidification.»

    The rotation writes it as one `ULT` step that lasts the whole window
    (Teo, 2026-11-01). How many shots fit the window the text does not say;
    unlike every other hit count (`hit_counts`), this one comes from the
    client's frames (`frames.py`, ``ultimateBarrage``), and it is the only
    source there is. The window is the skill's `Duration (s)`:

    * `BATK DMG Multiplier` — ``hit.count``: shots that start inside it;
    * `Enhanced Final Strike DMG Multiplier` — lands every time, at the end;
    * `Additional ATK DMG Multiplier` — when the cast consumes Solidification;
    * ``ramp`` — the crit stacks each shot is fired with, ``[stacks, shots]``:
      the client stacks on every shot, not every sequence as the text says
      (measurements, #52); a stack counts from the next shot;
    * ``seconds`` — the step: the cast up to the window, the window, and the
      closing strike's recovery; ``strikeAt`` — when the closing strike
      lands: what it consumes must still be up then.
    """
    text = re.sub(r"\s+", " ", skill.get("text") or "")
    if skill.get("type") != "Ultimate" or not BARRAGE_TEXT.search(text):
        return None
    record = (frames or {}).get("ultimateBarrage")
    rows = {row["label"]: row for row in skill["stats"]}
    shot, window = rows.get(BARRAGE_SHOT), rows.get("Duration (s)")
    if not record or not shot or not shot.get("hit") or not window:
        print(f"  ! {skill.get('name')}: a barrage ultimate without frame data or rows — counted as one cast")
        return None
    if len(set(window["values"])) > 1:
        print(f"  ! {skill.get('name')}: the window changes with the level; shots counted at level 12")
    limit = round(window["values"][-1] * FPS)
    cap = record["stackCap"]
    stack_rows = {key: label for key, label in BARRAGE_STACK.items() if label in rows}
    if "max" in stack_rows and rows[stack_rows["max"]]["values"][-1] != cap:
        print(f"  ! {skill.get('name')}: Max Stacks {rows[stack_rows['max']]['values'][-1]} vs the client's {cap}")

    ramp: dict[int, int] = {}
    layers = start = index = 0
    moves = record["moves"]
    while start < limit:
        move = moves[index]
        for hit, stacking in zip(move["hits"], move["stacking"]):
            if start + hit >= limit:
                break
            held = min(layers, cap)
            ramp[held] = ramp.get(held, 0) + 1
            layers += 1 if stacking else 0
        start += move["frames"]
        index = index + 1 if index < record["loop"] else record["loop"]

    shots = sum(ramp.values())
    shot["hit"]["count"] = shots
    # The shots, the closing strike and the extra attack are basic attacks
    # to the client (``skillSpecification`` 1): Basic Attack DMG bonuses.
    if record.get("dealtAs"):
        for label in (BARRAGE_SHOT, BARRAGE_END, BARRAGE_EXTRA_ROW):
            if label in rows:
                rows[label]["dealtAs"] = record["dealtAs"]
    if end := rows.get(BARRAGE_END):
        end["hit"] = {**(end.get("hit") or {}), "role": "hit", "sequence": None, "part": None}
        end["hit"].pop("when", None)
    if (extra := rows.get(BARRAGE_EXTRA_ROW)) and extra.get("hit") and (found := BARRAGE_EXTRA.search(text)):
        extra["hit"].update(role="conditional", when=f"consumes:{found['term']}")
    return {
        "row": BARRAGE_SHOT,
        "shots": shots,
        "ramp": sorted([stacks, count] for stacks, count in ramp.items()),
        "finalStacks": min(layers, cap),
        "seconds": round((record["opens"] + limit + record["end"]["frames"]) / FPS, 4),
        "strikeAt": round((record["opens"] + limit + record["end"]["hit"]) / FPS, 4),
        **({"stack": stack_rows} if {"rate", "max"} <= stack_rows.keys() else {}),
    }


ENHANCED_BASIC_TEXT = re.compile(r"\b(?:her|his|their) basic attacks \(BATK\) are enhanced\b")
ENHANCED_BASIC_ROW = re.compile(r"^(?P<move>Enhanced BATK) SEQ (?P<seq>\d+) Multiplier$")
ENHANCED_BASIC_PAUSE = re.compile(r"\bCasting (?P<what>.*?) does not shorten the duration\b")
ENHANCED_BASIC_APPLIES = re.compile(r"\bBATK sequence (?P<seq>\d+) also applies (?P<term>[A-Z]\w+ Infliction)\b")
PAUSE_TYPES = {"battle skill": "Battle Skill", "combo skill": "Combo Skill"}


def enhanced_basic(skill: dict, frames: dict | None) -> dict | None:
    """An ultimate that enhances the basic attack for a while: Laevatain's.

    «For a certain duration, her basic attacks (BATK) are enhanced … BATK
    sequence 3 also applies Heat Infliction. Casting the battle skill … or
    the combo skill … does not shorten the duration of the ultimate.» Unlike
    Yvonne's barrage (``ultimate_barrage``) the rotation keeps writing her
    basic attacks: `BA > FS` inside the window plays this chain instead of
    the ordinary one.

    * `Enhanced BATK SEQ n Multiplier` — a chain hit of the move ``Enhanced
      BATK`` (``move``): the ultimate's own cast does not deal it;
    * the window — the skill's `Duration (s)`, from the cast; the skills the
      text names pause it (``pausedBy``, the client's
      ``buff_<char>_pause_ult``);
    * ``applies`` — what a sequence of the chain puts on the target;
    * from the client's frames (``frames.py``, ``enhancedChain``): the
      chain's period and Final Strike share, the Final Strike's SP and
      Stagger (the wiki gives neither), and ``dealtAs`` — the hits are
      basic attacks to the client (``skillSpecification`` 1), so they take
      Basic Attack DMG bonuses, at the ultimate's level.
    """
    text = re.sub(r"\s+", " ", skill.get("text") or "")
    if skill.get("type") != "Ultimate" or not ENHANCED_BASIC_TEXT.search(text):
        return None
    record = (frames or {}).get("enhancedChain")
    rows = [(row, ENHANCED_BASIC_ROW.match(row["label"])) for row in skill["stats"]]
    rows = [(row, found) for row, found in rows if found]
    window = next((row for row in skill["stats"] if row["label"] == "Duration (s)"), None)
    if not record or not rows or not window:
        print(f"  ! {skill.get('name')}: an enhanced basic attack without frame data or rows — the rows stay conditional")
        return None
    if len(rows) != record["sequences"]:
        print(f"  ! {skill.get('name')}: {len(rows)} enhanced rows, the client's chain has {record['sequences']} moves")
    move = rows[0][1]["move"]
    for row, found in rows:
        row["hit"] = {"role": "hit", "sequence": int(found["seq"]), "part": "chain"}
        row["move"] = move
        if record.get("dealtAs"):
            row["dealtAs"] = record["dealtAs"]
    paused = ENHANCED_BASIC_PAUSE.search(text)
    return {
        "move": move,
        "window": window["label"],
        "pausedBy": [kind for words, kind in PAUSE_TYPES.items() if paused and words in paused["what"]],
        "applies": [{"sequence": int(found["seq"]), "term": found["term"]} for found in ENHANCED_BASIC_APPLIES.finditer(text)],
        "sequences": len(rows),
        **{key: record[key] for key in ("sequenceSeconds", "finalStrikeSeconds", "finalStrikeSp", "finalStrikeStagger") if key in record},
    }


def own_stack_rows(record: dict, skills: list[dict]) -> None:
    """Rows of the attack the spending cast adds (`synergy.own_stacks`).

    Laevatain's battle skill: «consume all the stacks and perform 1
    additional attack»: its `Additional ATK DMG Multiplier` hits, and its
    Stagger, only when the cast spent Melting Flame (``when:
    consumes:Melting Flame``). Before this the track dealt the 770 % hit on
    every cast. The `Additional ATK Ultimate Energy Gain` row is read by the
    engine from ``spentBy.energy``.
    """
    from tools.ef.synergy import own_stacks

    entry = own_stacks(record)
    if not entry:
        return
    spender = next((skill for skill in skills if skill["name"] == entry["spentBy"]["skill"]), None)
    for row in (spender or {}).get("stats", []):
        if row["label"].startswith("Additional ATK ") and row.get("hit"):
            row["hit"].update(role="conditional", when=f"consumes:{entry['name']}")


DURING_ULTIMATE = "During Ultimate:"
DURING_ULTIMATE_SEQ = re.compile(r"^During Ultimate: BATK SEQ (\d+) Multiplier$")


def during_ultimate_rows(record: dict, skills: list[dict], frames: dict | None) -> None:
    """The battle skill an ultimate swaps in: Laevatain's, while Twilight is up.

    «Battle skill effects are enhanced while Laevatain's ultimate is
    active.» The rows say how: `During Ultimate: BATK SEQ 1/2` hits and
    their Stagger, `During Ultimate: Additional ATK` at 4 Melting Flame. In
    the client it is another skill, ``normal_skill_during_ult``
    (``frames.py``, ``battleSkillDuringUltimate``): two strikes instead of
    the Magma Fragment, each casting the operator's infliction, then the
    extra attack. Every such row gets ``move: During Ultimate``, the way
    Camille's Hunter Pursuit rows do, and the skill gets ``duringUltimate``:
    the window it plays in is the ultimate's (``Skill.enhancedBasic``).
    """
    from tools.ef.synergy import own_stacks

    record_frames = (frames or {}).get("battleSkillDuringUltimate")
    battle = next((skill for skill in skills if skill["type"] == "Battle Skill"), None)
    ultimate = next((skill for skill in skills if skill["type"] == "Ultimate"), None)
    rows = [row for row in (battle or {}).get("stats", []) if row["label"].startswith(f"{DURING_ULTIMATE} ")]
    if not rows or not record_frames or not ultimate:
        return
    own = own_stacks(record)
    move = DURING_ULTIMATE.rstrip(":")
    for row in rows:
        row["move"] = move
        if found := DURING_ULTIMATE_SEQ.match(row["label"]):
            row["hit"] = {"role": "hit", "sequence": int(found[1]), "part": None}
        elif row.get("hit") and row["label"].startswith(f"{DURING_ULTIMATE} Additional ATK") and own and own["spentBy"]["skill"] == battle["name"]:
            row["hit"] = {"role": "conditional", "sequence": None, "part": None, "when": f"consumes:{own['name']}"}
    element = record.get("element")
    battle["duringUltimate"] = {
        "move": move,
        "ultimate": ultimate["name"],
        "applies": [{"sequence": n, "term": f"{element} Infliction"} for n in record_frames["inflicting"]] if element else [],
    }


OVER_TIME_PER_SEQ = re.compile(r"\bOver Time\b.*\bper SEQ\b", re.I)


def entity_tick_counts(skills: list[dict], frames: dict | None) -> None:
    """How many ticks a battle skill's summon deals: Laevatain's Magma Fragment.

    «Summons a Magma Fragment to continuously attack enemies»: the text
    gives no count, so `DMG Over Time Multiplier per SEQ` was ``count:
    None`` and the track counted one tick. The client's summon
    (``frames.py``, ``battleSkillEntity``) hits 11 times, one of them with
    Stagger — the `Base Explosion`; the rest are the ticks.
    """
    record = (frames or {}).get("battleSkillEntity")
    battle = next((skill for skill in skills if skill["type"] == "Battle Skill"), None)
    if not record or not battle:
        return
    ticks = record["hits"] - record["staggering"]
    for row in battle["stats"]:
        hit = row.get("hit")
        if hit and "count" in hit and hit["count"] is None and OVER_TIME_PER_SEQ.search(row["label"]) and ticks > 0:
            hit["count"] = ticks


def stock_rows(record: dict, skills: list[dict]) -> None:
    """Rows that scale with what the spending skill made (`synergy.stocks`).

    Tangtang's battle skill: `DMG Multiplier (1 Waterspout)` hits once per
    Waterspout made (``hit.per``), `SP Return per Whirlpool` returns once per
    Whirlpool spent (``sp.when: perStock``), `Arts Susceptibility (3
    Waterspouts)` is the value at that count (``made``).
    """
    from tools.ef.synergy import stocks

    entry = stocks(record)
    if not entry:
        return
    spender = next((skill for skill in skills if skill["name"] == entry["spentBy"]), None)
    if not spender:
        return
    one = re.compile(rf"\(1 {entry['makes']}\)$")
    many = re.compile(rf"\((\d+) {entry['makes']}s\)$")
    for row in spender["stats"]:
        if row.get("hit") and one.search(row["label"]):
            row["hit"]["per"] = entry["makes"]
        if row.get("sp") and re.search(rf"\bper {entry['name']}\b", row["label"]):
            row["sp"] = {"kind": row["sp"]["kind"], "when": "perStock"}
        if found := many.search(row["label"]):
            row["made"] = int(found[1])


GRANT_TERM = re.compile(r"\b(Physical|Heat|Cryo|Electric|Nature|Arts) (Susceptibility|Amp)\b")
# «an enemy with Physical Susceptibility» is a condition, not an application.
GRANT_MENTION = re.compile(r"\b(?:with|has|under) (?:active )?$")
GRANT_ATTRIBUTE = {"Strength": "STR", "Agility": "AGL", "Intellect": "INT", "INT": "INT", "Will": "WIL"}
GRANT_STRIKE = re.compile(r"\bAfter the controlled operator performs a Final Strike\b")
GRANT_TIMES = re.compile(r"\bcan trigger (\d+) times\b")
GRANT_CONDITION = re.compile(r"\bIf (?:the )?(?:target|enemy|skill hits a target)\b(?P<when>[^,.]*),(?P<then>[^.]*)")


def _grant_condition(when: str) -> dict | None:
    """«has Corrosion» → ``{has}``; «has no Vulnerability stacks» → ``{lacks}``."""
    if found := re.search(r"\bhas no ([A-Z]\w*) stacks\b", when):
        return {"lacks": "Vulnerable" if found[1] == "Vulnerability" else found[1]}
    if found := re.search(r"\b(?:has|with) (?:an )?(?:active )?([A-Z]\w*(?: [A-Z]\w*)*)", when):
        return {"has": found[1]}
    return None


def skill_grants(skill: dict) -> list[dict]:
    """Susceptibility and Amp a skill puts up itself, and the rows that hold their value.

    The term comes from the text («apply Nature Susceptibility and Cryo
    Susceptibility»), the value from a row named after it — the term itself,
    ``Base <term>``, ``<term> Multiplier``, or the bare kind (Arcane's
    «Susceptibility» row is both of hers). Parts that scale: ``Amp Increase
    per Will`` (``per`` an attribute, capped by ``MAX Amp from Will``),
    ``… Boost per Vulnerability`` (Gilberta), ``… (3 Waterspouts)``
    (``made``, Tangtang), ``Max Bonus Susceptibility from Will`` reached at
    ``Will for MAX Bonus Susceptibility`` (``at``, Arcane). The duration is the row named after the term or
    the kind, or the skill's only duration.

    Amp goes to the team when the text says «the entire team». Xaihi's
    Auxiliary Crystal grants «the said operator» Arts Amp «After the
    controlled operator performs a Final Strike», and «This effect can
    trigger 2 times»: ``target: controlled`` with ``on`` — how many Final
    Strikes, within the crystal's duration row. One left to chance
    (Purrchena's Ambassador's Special) is exported with ``uncounted``, not
    as a number. «If the target has
    Corrosion, … apply» is ``requires``: the simulation does not apply the
    term without it.
    """
    text = re.sub(r"\s+", " ", skill.get("text") or "")
    terms = list(
        dict.fromkeys(match[0] for match in GRANT_TERM.finditer(text) if not GRANT_MENTION.search(text[: match.start()]))
    )
    if not terms:
        return []
    stats = skill["stats"]
    by_label = {row["label"]: row for row in stats if row["unit"] == "frac"}
    durations = [row for row in stats if row["unit"] == "sec" and "Duration" in row["label"] and not row["label"].startswith("Bonus ")]
    conditions = {}
    for found in GRANT_CONDITION.finditer(text):
        if (condition := _grant_condition(found["when"])) is None:
            continue
        for match in GRANT_TERM.finditer(found["then"]):
            conditions[match[0]] = condition
    out = []
    for term in terms:
        element, kind = term.split(" ")
        rows = []
        for label in (term, f"Base {term}", f"{term} Multiplier", f"Base {kind}"):
            if label in by_label:
                rows.append({"row": label})
                break
        made = [row for row in stats if row.get("made") and row["label"].startswith(f"{term} (")]
        rows += [{"row": row["label"], "made": row["made"]} for row in made]
        for label in by_label:
            if per := re.fullmatch(rf"(?:{kind}|{term}) Increase per (\w+)", label):
                cap = next((other for other in by_label if re.fullmatch(rf"MAX {kind} from \w+", other)), None)
                rows.append({"row": label, "per": GRANT_ATTRIBUTE[per[1]], **({"max": cap} if cap else {})})
            elif bonus := re.fullmatch(rf"Max Bonus {kind} from (\w+)", label):
                # Arcane's WILL array: the bonus reaches its max at «Will for MAX Bonus Susceptibility».
                at = next((other for other in stats if re.fullmatch(rf"{bonus[1]} for MAX Bonus {kind}", other["label"])), None)
                if at:
                    rows.append({"row": label, "per": GRANT_ATTRIBUTE[bonus[1]], "at": at["label"]})
            elif re.fullmatch(rf"{term} Boost per Vulnerability", label):
                rows.append({"row": label, "per": "Vulnerable"})
        if not rows and kind in by_label:
            rows.append({"row": kind})
        if not rows:
            print(f"  ! {skill.get('name')}: {term} without a value row")
            continue
        named = [row for row in durations if row["label"].startswith(term) or kind in row["label"]]
        duration = named[0] if named else durations[0] if len(durations) == 1 else None
        sentence = next((part for part in re.split(r"(?<=\.) ", text) if term in part), "")
        target = "enemy" if kind == "Susceptibility" else "team"
        on = None
        strike, times = GRANT_STRIKE.search(text), GRANT_TIMES.search(text)
        if kind == "Amp" and "entire team" not in text and "the said operator" in sentence and strike and times:
            window = [row for row in durations if row is not duration]
            if len(window) == 1:
                target = "controlled"
                on = {"strike": "Final Strike", "times": int(times[1]), "window": window[0]["label"]}
        uncounted = (
            "chance" if re.search(r"\bchance\b", sentence)
            else "single" if kind == "Amp" and target == "team" and "entire team" not in text
            else None
        )
        out.append(
            {
                "term": term,
                "stat": "susceptibility" if kind == "Susceptibility" else "amp",
                "element": element,
                "target": target,
                "rows": rows,
                **({"on": on} if on else {}),
                **({"duration": duration["label"]} if duration else {}),
                **({"requires": conditions[term]} if term in conditions else {}),
                **({"uncounted": uncounted} if uncounted else {}),
            }
        )
    return out


BOOST_STAT = {"Critical Rate": "crit_rate", "Critical DMG Boost": "crit_dmg", "ATK Boost": "atk_pct"}
BOOST_OWN = re.compile(r"\bWhen this skill (?:successfully )?scores a critical hit, it deals higher Critical DMG\b")


def skill_boosts(skill: dict) -> list[dict]:
    """Buffs a skill's own rows grant: crit and ATK, on the caster or the team.

    * Rossi's combo: «COMBO SEQUENCE 2 … buffs Rossi's Critical Rate and
      Critical DMG Dealt» — ``Critical Rate`` and ``Critical DMG Boost`` on
      herself for ``Buff Duration (s)``, from that sequence (``sequence``).
    * Rossi's ultimate: «When this skill successfully scores a critical hit,
      it deals higher Critical DMG» — ``Critical DMG Boost`` on its own hits
      only (``when: own``), no duration.
    * Liino's stances: «grants the entire team an ATK Boost» — for the
      stance's duration row, on the team. Her two stances replace each
      other, so their boosts share one ``slot``.

    Only these exact labels: «Critical Rate Boost per Stack» (Yvonne) counts
    enhanced basic attack sequences, which the track does not know.
    """
    text = re.sub(r"[ \t]+", " ", skill.get("text") or "")
    sentences = [part.strip() for part in re.split(r"(?<=[.!?])\s+|\n", text) if part.strip()]
    durations = [row for row in skill["stats"] if row["unit"] == "sec" and "Duration" in row["label"]]
    out = []
    for row in skill["stats"]:
        stat = BOOST_STAT.get(row["label"])
        if stat is None or row["unit"] != "frac" or row.get("hit"):
            continue
        if stat == "crit_dmg" and BOOST_OWN.search(text):
            out.append({"stat": stat, "row": row["label"], "when": "own"})
            continue
        words = {"crit_rate": "Critical Rate", "crit_dmg": "Critical DMG", "atk_pct": "ATK Boost"}[stat]
        sentence = next((part for part in sentences if words in part), None)
        if sentence is None:
            print(f"  ! {skill.get('name')}: {row['label']} — no sentence names it")
            continue
        named = [d for d in durations if d["label"].startswith("Buff Duration") or "Stance Duration" in d["label"]]
        duration = named[0] if named else durations[0] if len(durations) == 1 else None
        sequence = re.match(r"COMBO SEQUENCE (\d)\b", sentence)
        out.append(
            {
                "stat": stat,
                "row": row["label"],
                "when": "cast",
                "target": "team" if "entire team" in sentence else "self",
                **({"duration": duration["label"]} if duration else {}),
                **({"sequence": int(sequence[1])} if sequence else {}),
                **({"slot": "stance"} if duration and "Stance Duration" in duration["label"] else {}),
            }
        )
    return out


HIT_STEM = re.compile(r"\s*(?:DMG Multiplier|Multiplier)$")
STAGGER_STEM = re.compile(r"\s*Stagger$")


# «deals Physical DMG», «dealing massive Heat DMG» — a damage element the
# text names. «Physical DMG Taken», «Heat DMG Dealt +6 %» are buffs, not hits.
DEALS_ELEMENT = re.compile(r"\b(Physical|Heat|Cryo|Electric|Nature) DMG\b(?! (?:Taken|Dealt|Bonus)\b)", re.I)
# A paragraph that is a move of its own: «Bolt Rush: Argent Flow mounts …».
MOVE_HEADING = re.compile(r"^(?P<move>[^:\n]{2,40}):")
# A paragraph that is not a hit: the combo's trigger condition.
NOT_A_HIT = re.compile(r"^COMBO TRIGGER:", re.I)
# A clause that adds one more attack to the cast: «also unleashes a Wolven
# Ambrage … Heat DMG», «unleash an additional attack that deals Electric DMG».
EXTRA_ATTACK = re.compile(r"\b(?:also unleashes|additional attack)\b", re.I)


def row_elements(skill: dict) -> list[str]:
    """The element each damage row deals: ``element`` on rows with ``hit``.

    A hit's resistance, DMG Bonus, Amp, DMG Taken and Susceptibility follow
    the element of the damage, and that is not always the operator's:
    Estella (Cryo) deals Physical DMG with everything but Onomatopoeia,
    Rossi (Physical) Heat DMG with her ultimate. The rule, on the skill's
    text («deals … <Element> DMG»; the combo trigger is not a hit):

    * the text names no element — no field: the engine takes the operator's;
    * it names one — every damage row of the skill deals it;
    * it names several — the first is the skill's own, and every damage row
      deals it except the rows a later element's paragraph is tied to:
      a paragraph headed by a move («Bolt Rush: … Electric DMG») — that
      move's rows (``move``, or a label starting with its name); a clause
      that adds an attack («also unleashes», «additional attack») — the
      skill's last plain hit, an «Additional …» row if there is one.
      A later element that ties to no row is printed and left out: its rows
      keep the first element.

    The client agrees where it was checked (``damageType`` in
    ``Json/SkillData``: 0 Physical, 2 Heat, 3 Electric, 4 Cryo, 6 Nature):
    Estella's basic attack, combo and ultimate are 0, her battle skill's
    projectile 4; Rossi's `SEQ 2` (``atk_scale_3``) is the Wolven Ambrage's
    projectiles, 2. The client is not read here: the site's build has no
    clone, and the decision must not depend on it.

    Returns the elements that tied to no row, for the export's report.
    """
    rows = [row for row in skill.get("stats", []) if row.get("hit")]
    for row in rows:
        row.pop("element", None)
    paragraphs = [line.strip() for line in (skill.get("text") or "").splitlines() if line.strip()]
    mentions = [
        (paragraph, found)
        for paragraph in paragraphs
        if not NOT_A_HIT.match(paragraph)
        for found in DEALS_ELEMENT.finditer(paragraph)
    ]
    if not rows or not mentions:
        return []
    main = mentions[0][1][1].capitalize()
    owner: dict[int, str] = {}
    untied: list[str] = []
    for paragraph, found in mentions:
        element = found[1].capitalize()
        if element == main:
            continue
        tied: list[dict] = []
        if heading := MOVE_HEADING.match(paragraph):
            name = heading["move"].strip()
            tied = [row for row in rows if row.get("move") == name or row["label"].startswith(f"{name} ")]
        if not tied:
            # The clause's own sentence: «If …, also unleashes … Heat DMG.»
            start = max(paragraph.rfind(". ", 0, found.start()) + 1, 0)
            if EXTRA_ATTACK.search(paragraph[start:found.end()]):
                plain = [row for row in rows if row["hit"]["role"] == "hit" and not row.get("move")]
                extra = [row for row in plain if row["label"].startswith("Additional ")]
                tied = extra[-1:] or plain[-1:]
        if not tied:
            untied.append(element)
        for row in tied:
            owner[id(row)] = element
    for row in rows:
        row["element"] = owner.get(id(row), main)
    return untied


def stagger_roles(stats: list[dict]) -> None:
    """Ties a Stagger row to the hit it belongs to: same label, `Stagger` for `DMG Multiplier`.

    The engine summed every Stagger row of a skill on every cast: Lifeng's
    `Additional ATK Stagger` without Link, Pogranichnik's `Enhanced SEQ 3
    Stagger` on top of the plain third slash, Laevatain's `During Ultimate:`
    rows outside her ultimate. Now:

    * ``sequence`` — the stage the row's «SEQ n» names: a `CS1` step does
      not deal `SEQ 2 Stagger`, and a combo whose stacks made two slashes
      does not deal the third;
    * ``conditional`` with the hit's ``when`` — only when that held; without
      a ``when`` the condition is not known, and the row is not counted, as
      its hit is not.
    """
    # Within one move: `During Ultimate: Additional ATK Stagger` is that move's extra attack.
    hits = {(row.get("move"), HIT_STEM.sub("", row["label"])): row["hit"] for row in stats if row.get("hit")}
    for row in stats:
        if row["unit"] != "stagger":
            continue
        role: dict = {}
        if seq := SEQ_LABEL.search(row["label"]):
            role["sequence"] = int(seq[1])
        hit = hits.get((row.get("move"), STAGGER_STEM.sub("", row["label"])))
        if hit and hit.get("role") == "conditional":
            role["conditional"] = True
            if hit.get("when"):
                role["when"] = hit["when"]
        if role:
            row["stagger"] = role
        else:
            row.pop("stagger", None)


def skill_stats(skill: dict) -> tuple[list[dict], dict]:
    """A skill's stat rows with units and roles, and what the text adds.

    Every decision about a row — unit, hit role, SP role, hit count, phase —
    is taken here, in this order. Returns the rows and the skill-level
    extras: ``switch``, ``moves``, ``finalStrikeStagger``.
    """
    stats = []
    for row in skill.get("stats", []):
        unit = stat_unit(row["label"], row.get("is_percent", False))
        stats.append(
            {
                "label": row["label"],
                "unit": unit,
                "values": row["values"],
                # Sequences appear only for multi-stage skills:
                # Mi Fu's "SP Cost" is 100 / 50 / 50.
                **({"sequences": row["sequences"]} if "sequences" in row else {}),
            }
        )
    hit_roles(skill.get("type"), stats)
    sp_roles(stats)
    energy_roles(skill, stats)
    moves = skill_conditions(skill, stats)
    phases = ultimate_phases(skill, stats) if skill.get("type") == "Ultimate" else None
    if skill.get("type") != "Basic Attack":
        hit_counts(skill, stats)
        sp_counts(skill, stats)
    stage_costs(skill, stats)
    fs_stagger = final_strike_stagger(skill)
    extras = {
        **({"switch": phases} if phases else {}),
        **({"moves": moves} if moves else {}),
        **({"finalStrikeStagger": fs_stagger} if fs_stagger is not None else {}),
    }
    return stats, extras


HIT_KINDS = {"Battle Skill": "BS", "Combo Skill": "CS", "Ultimate": "ULT"}


def hit_times(skill: dict, frames: dict | None) -> dict | None:
    """When each damage row lands: ``hit.at``, seconds, one per hit of the row.

    Rows are wiki data, hits are the client's (``frames.py``), and nothing
    names which is which. The rule (ENGINE_CORE_PLAN.md, stage Ya1):

    * a basic attack's ``SEQ k`` row is the chain's k-th segment, every hit
      of it; times from the start of the chain;
    * a skill's hit rows, in table order, take the client's hits in order,
      ``count`` of them each — when the counts agree, with every hit or with
      the hits before the skill's first window (``late`` ones dropped: the
      other variants of Pogranichnik's combo). Otherwise every row lands on
      the last hit before the window and the skill is marked ``hitTimes:
      "last"``: the client splits some hits in two (Pogranichnik's battle
      skill, #23), and a guess is better said than fitted;
    * a skill whose stages are separate presses (Mi Fu) is left alone, as is
      one without client hits.

    Returns the skill-level verdict: ``{"kind", "wiki", "client", "matched"}``,
    or ``None`` when there was nothing to match.
    """
    if not frames:
        return None
    stats = skill["stats"]
    if skill.get("type") == "Basic Attack":
        chain = frames.get("chainHits") or []
        for row in stats:
            hit = row.get("hit")
            if hit and hit.get("part") == "chain" and hit.get("sequence") and hit["sequence"] <= len(chain):
                row["hit"]["at"] = chain[hit["sequence"] - 1]
        return None
    kind = HIT_KINDS.get(skill.get("type"))
    client = (frames.get("skillHits") or {}).get(kind or "", [])
    if not kind or not client or any(row.get("sequences") for row in stats):
        return None
    rows = [row for row in stats if row.get("hit") and row["hit"]["role"] == "hit" and not row.get("move")]
    rows.sort(key=lambda row: row["hit"].get("sequence") or 0)
    counts = [row["hit"].get("count", 1) for row in rows]
    hits = [hit["at"] for hit in client]
    early = [hit["at"] for hit in client if not hit.get("late")] or hits
    matched = None not in counts and sum(counts) in (len(hits), len(early))
    if matched and sum(counts) != len(hits):
        hits = early
    elif not matched:
        hits = early
    if matched:
        index = 0
        for row, count in zip(rows, counts):
            row["hit"]["at"] = hits[index:index + count]
            index += count
    else:
        for row in rows:
            row["hit"]["at"] = [hits[-1]]
        skill["hitTimes"] = "last"
    for row in stats:
        if row.get("hit") and row["hit"]["role"] in ("perStack", "conditional") and not row.get("move"):
            row["hit"]["at"] = [hits[-1]]
    wiki = None if None in counts else sum(counts)
    return {"kind": kind, "wiki": wiki, "client": len(hits), "matched": matched}


def export_operators(operators: dict, icons: "IconIndex") -> dict:
    out: dict = {}
    frame_data = read_frame_data()
    unmatched: list[str] = []
    untied: list[str] = []
    for key, record in operators.items():
        skills = []
        for skill in record.get("skills", []):
            stats, extras = skill_stats(skill)
            skills.append(
                {
                    "slot": skill.get("slot"),
                    "type": skill.get("type"),
                    "name": skill.get("name"),
                    "variant": skill.get("variant"),
                    "text": skill.get("text"),
                    "terms": skill.get("terms", []),
                    "icon": icons.path("skills", skill.get("icon")),
                    "stats": stats,
                    **extras,
                }
            )
        transformed_rows(record, skills)
        stock_rows(record, skills)
        own_stack_rows(record, skills)
        during_ultimate_rows(record, skills, frame_data.get(key))
        entity_tick_counts(skills, frame_data.get(key))
        for skill in skills:
            if grants := skill_grants(skill):
                skill["grants"] = grants
            if boosts := skill_boosts(skill):
                skill["boosts"] = boosts
            if barrage := ultimate_barrage(skill, frame_data.get(key)):
                skill["barrage"] = barrage
            if enhanced := enhanced_basic(skill, frame_data.get(key)):
                skill["enhancedBasic"] = enhanced
            # Last: a Stagger row takes the condition its hit ended up with.
            stagger_roles(skill["stats"])
            # After every pass that sets ``hit`` and ``move``.
            if loose := row_elements(skill):
                untied.append(f"{key} {skill.get('name')}: {', '.join(loose)}")
            if (verdict := hit_times(skill, frame_data.get(key))) and not verdict["matched"]:
                unmatched.append(f"{key} {verdict['kind']} {verdict['wiki']}/{verdict['client']}")

        out[key] = {
            "key": key,
            "id": record.get("id"),
            "name": record.get("name"),
            "rarity": record.get("rarity"),
            "class": record.get("class"),
            "element": record.get("element"),
            "weaponType": record.get("weapon_type"),
            "faction": record.get("faction"),
            "gender": record.get("gender"),
            "mainAttribute": record.get("main_attribute"),
            "subAttribute": record.get("sub_attribute"),
            "tags": record.get("tags", []),
            "headhunting": record.get("headhunting"),
            "upcoming": bool(record.get("upcoming")),
            "critRate": record.get("crit_rate"),
            # Until the 2026-10-15 sync the wiki wrote "AS = 1", after it
            # "AS = 100" for every operator at once. The bundle keeps a fraction,
            # as before.
            "attackSpeed": to_fraction(record.get("attack_speed"), "frac"),
            "attackRange": record.get("attack_range"),
            "attributes": record.get("attributes", {}),
            "breakpoints": BREAKPOINTS,
            "skills": skills,
            "talents": [
                {
                    "name": talent.get("name"),
                    "icon": icons.path("talents", talent.get("icon")),
                    "levels": talent.get("levels", []),
                }
                for talent in record.get("talents", [])
            ],
            "potentials": record.get("potentials", []),
            "icon": icons.path("operators", record.get("name")),
            "elementIcon": icons.path("elements", record.get("element")),
            "classIcon": icons.path("classes", record.get("class")),
            "revid": (record.get("source") or {}).get("revid"),
            "page": record.get("page"),
        }
    # A second element the text names but no row could be tied to.
    if untied:
        print(f"    row elements a later element tied to no row: {'; '.join(untied)}")
    # Rows and client hits that disagree in number: the rows land on the last hit.
    if unmatched:
        print(f"    hit times    wiki rows ≠ client hits, last hit taken: {', '.join(unmatched)}")
    return out


def export_weapons(weapons: dict, icons: "IconIndex") -> dict:
    out: dict = {}
    for key, record in weapons.items():
        components = []
        for component in record.get("skill_components", []):
            values = component.get("values_by_rank", [])
            units = template_units(component.get("text_template", ""), len(values))
            components.append(
                {
                    "key": component.get("key"),
                    "tag": component.get("tag"),
                    "textTemplate": component.get("text_template"),
                    "terms": component.get("terms", []),
                    # Converted to fractions where the template says "%".
                    "units": units,
                    "valuesByRank": [
                        [to_fraction(v, units[i]) for v in row]
                        for i, row in enumerate(values)
                    ],
                    "rawValuesByRank": values,
                }
            )
        out[key] = {
            "key": key,
            "id": record.get("id"),
            "name": record.get("name"),
            "rarity": record.get("rarity"),
            "type": record.get("type"),
            "baseAttack": record.get("base_attack", {}),
            "breakpoints": BREAKPOINTS,
            "skillName": (record.get("skill") or {}).get("name"),
            "components": components,
            "potential": record.get("potential"),
            "icon": icons.path("weapons", record.get("name")),
            "revid": (record.get("source") or {}).get("revid"),
            "page": record.get("page"),
        }
    return out


# Gear stats are already normalised by the parser: percentages as fractions,
# attributes as numbers. The unit comes from the `is_percent` marker the parser
# took from the wikitext: the name cannot decide it. "Secondary Attribute" is
# both "+23" and "+13.5%", "Attack" both "+16.2" and "+12%"; a name-based rule
# confused 21 items. The name is only a fallback for a record without the
# marker.
FLAT_GEAR_STATS = {
    "Agility",
    "Strength",
    "Intellect",
    "Will",
    "Main Attribute",
    "Secondary Attribute",
    "Arts Intensity",
}


def gear_stat_unit(stat: dict) -> str:
    percent = stat.get("is_percent")
    if percent is None:
        return "flat" if stat.get("stat") in FLAT_GEAR_STATS else "frac"
    return "frac" if percent else "flat"


def export_gear(gear: dict, icons: "IconIndex") -> dict:
    pieces: dict = {}
    for key, record in gear.get("pieces", {}).items():
        pieces[key] = {
            "key": key,
            "name": record.get("name"),
            "type": record.get("type"),
            "rarity": record.get("rarity"),
            "level": record.get("level"),
            "set": record.get("set"),
            "defense": record.get("defense"),
            "artifice": bool(record.get("artifice")),
            "region": record.get("region"),
            "stats": [
                {
                    "slot": stat.get("slot"),
                    "stat": stat.get("stat"),
                    "unit": gear_stat_unit(stat),
                    "values": stat.get("values", []),
                }
                for stat in record.get("stats", [])
            ],
            "icon": icons.path("gear", record.get("name")),
            "page": record.get("page"),
        }

    sets: dict = {}
    for key, record in gear.get("sets", {}).items():
        sets[key] = {
            "key": key,
            "name": record.get("name"),
            "level": record.get("level"),
            "text": record.get("text"),
            "terms": record.get("terms", []),
            "effectKnown": bool(record.get("effect_known")),
            # The wiki lies: the bonus text is taken from the item pages, and
            # the set page may carry someone else's. The mismatch is shown in
            # the app rather than hidden.
            "effectSource": record.get("effect_source"),
            "setPageText": record.get("set_page_text"),
            "conflict": bool(record.get("conflict")),
        }

    return {"pieces": pieces, "sets": sets}


def _jsonable(value):
    """Recursively converts to what json.dump can write."""
    if isinstance(value, dict):
        return {str(k): _jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_jsonable(v) for v in value]
    if isinstance(value, (_dt.date, _dt.datetime)):
        return value.isoformat()
    return value


def _yaml():
    """PyYAML, or a loud failure: a missing module must not thin out the bundle.

    Timings, aliases and the SP layer are hand-written YAML; without them the
    export used to finish with exit code 0 and a bundle missing those layers.
    """
    try:
        import yaml
    except ImportError as exc:
        raise RuntimeError(
            "PyYAML is required to build the bundle (timings, aliases, SP layer): pip install PyYAML"
        ) from exc
    return yaml


def export_timings() -> dict:
    """The hand-written layer of action durations.

    The values are nominal and marked ``measured: false``: cast time is given
    neither on the wiki nor in the game in readable form. The engine uses them
    not directly but through runs at several multipliers (`sensitivity`), to
    separate conclusions that depend on the guessed second from those that do
    not.
    """
    path = ROOT / "data" / "endfield" / "timings.yaml"
    if not path.exists():
        print("  ! no timings.yaml — the engine will use built-in values")
        return {}
    _yaml()  # fails loudly without PyYAML, see _yaml()
    data = load_yaml(path) or {}
    # YAML parses 2026-09-12 as datetime.date, and json.dump cannot handle it
    # and fails HALFWAY through writing, leaving a truncated bundle. A sneaky
    # trap: the error message is about JSON, while the cause is in YAML.
    data = _jsonable(data)
    measured = (data.get("meta") or {}).get("measured")
    print(f"    timings      {len(data.get('defaults') or {})} actions, measured={measured}")
    return {
        "meta": data.get("meta") or {},
        "defaults": data.get("defaults") or {},
        # snake_case in YAML, camelCase in the bundle — as everywhere.
        "freezesTimers": data.get("freezes_timers") or {},
        "sensitivity": data.get("sensitivity") or [1],
        "overrides": data.get("overrides") or {},
        **({"comboReady": data["combo_ready"]} if data.get("combo_ready") is not None else {}),
        **({"comboTimeScale": data["combo_time_scale"]} if data.get("combo_time_scale") is not None else {}),
    }


BASIC_ATTACKS = DATA / "basic_attacks.json"


def read_frame_data() -> dict:
    """``basic_attacks.json`` as written, keyed by operator key: every record, not only the SP fields."""
    if not BASIC_ATTACKS.exists():
        return {}
    return json.loads(BASIC_ATTACKS.read_text(encoding="utf-8")).get("operators") or {}


def read_basic_attacks() -> dict:
    """Final Strike SP and basic-chain length per operator, keyed by operator key.

    Written by ``tools/ef/frames.py --export`` from the client datamine:
    ``atb`` of the chain's last hit and the chain's frame timeline. The file is
    under version control, so the export (and CI) needs no datamine clone.
    A length flagged ``uncertain`` is passed on as such, and the engine
    treats it as an unmeasured duration.
    """
    if not BASIC_ATTACKS.exists():
        print(f"  ! no {BASIC_ATTACKS.name}: Final Strike SP stays an assumption "
              "(python3 tools/ef/frames.py --export)")
        return {}
    data = json.loads(BASIC_ATTACKS.read_text(encoding="utf-8"))
    out: dict = {}
    for key, record in (data.get("operators") or {}).items():
        row: dict = {}
        if record.get("finalStrikeSp") is not None:
            row["finalStrikeSp"] = record["finalStrikeSp"]
        if record.get("sequenceSeconds") is not None:
            row["sequenceSeconds"] = record["sequenceSeconds"]
        if record.get("finalStrikeSeconds") is not None:
            row["finalStrikeSeconds"] = record["finalStrikeSeconds"]
        if record.get("uncertain"):
            row["uncertain"] = record["uncertain"]
        if record.get("skillWindows"):
            row["skillWindows"] = record["skillWindows"]
        if record.get("chainHits"):
            row["chainHits"] = record["chainHits"]
        if record.get("finalStrikeHit") is not None:
            row["finalStrikeHit"] = record["finalStrikeHit"]
        if record.get("dive"):
            row["dive"] = record["dive"]
        if record.get("finisher"):
            row["finisher"] = record["finisher"]
        if record.get("skillHits"):
            row["skillHits"] = record["skillHits"]
        out[key] = row
    uncertain = sum(1 for row in out.values() if "uncertain" in row)
    print(f"    basic attacks  {len(out)} operators from the datamine, duration questionable for {uncertain}")
    return out


def export_showcase_tables() -> dict | None:
    """Tables for reading an Enka showcase in the browser (`profile.py tables`).

    Versioned in `data/endfield/showcase_tables.json`, so a build needs no
    network for them. Without the file the site has no import, nothing else.
    """
    path = DATA / "showcase_tables.json"
    if not path.exists():
        print("  ! no showcase_tables.json: the site cannot read a showcase (python3 tools/ef/profile.py tables)")
        return None
    tables = json.loads(path.read_text(encoding="utf-8"))
    print(f"    showcase     {len(tables['weapons'])} weapons, {len(tables['gear'])} gear pieces by Enka templateId")
    return tables


def export_rotations() -> dict:
    """The `rotations/*.rot` files — so the app has something to show right away.

    The text is passed as is: the engine parses it, with the same function as
    the CLI. There must not be a second notation parser in the project.
    """
    folder = ROOT / "rotations"
    if not folder.exists():
        return {}
    out = {}
    for path in sorted(folder.glob("*.rot")):
        out[path.stem] = {"name": path.stem, "text": path.read_text(encoding="utf-8")}
    print(f"    rotations   {len(out)}")
    return out


def export_aliases() -> dict:
    """Operator aliases: without them, rotations written with short or localised names do not parse."""
    path = ROOT / "roster" / "aliases.yaml"
    if not path.exists():
        return {}
    _yaml()  # fails loudly without PyYAML, see _yaml()
    data = load_yaml(path) or {}
    return {str(k): list(v or []) for k, v in data.items()}


def export_synergy(operators: dict) -> dict:
    """Who applies what, what follows from what, and what opens each combo skill.

    Text parsing stays in Python: the regexes over skill descriptions are
    already written in `synergy.py` and `rotation.py`, and they must not get a
    second implementation in TypeScript for exactly the reason the damage
    formula lives only in the engine. What is exported here is the **result**
    of parsing, not the method.

    `groups` are the trigger's requirements split by "or": "Crush **or**
    Breach consumes…" is met by either of the two, while "has **both**
    Vulnerability **and** Arts Infliction" needs both. Without this
    distinction the validator complains about perfectly working rotations.
    """
    from tools.ef.rotation import (
        combo_trigger,
        consumed_trigger,
        consumed_too,
        find_skill,
        strike_trigger,
        load_implications,
        requirement_groups,
        absent_terms,
        own_resource,
        stance_condition,
    )
    from tools.ef.synergy import (
        build_index,
        load_aliases as load_term_aliases,
        stack_effects,
        stances as stance_effects,
        charges as charge_effects,
        transforms as transform_effects,
        forced_levels as forced_level_effects,
        marks as mark_effects,
        vulnerable_stacks as vulnerable_effects,
        repeats as repeat_effects,
        stocks as stock_effects,
        own_stacks as own_stack_effects,
        detonates as detonate_effects,
        echoes as echo_effects,
        strike_after as strike_after_effect,
        team_position_rules,
        trigger_thresholds,
    )

    index = build_index(operators)
    implications = load_implications()
    term_aliases = load_term_aliases()
    vocabulary = {term for entry in index.values() for term in entry["capabilities"]}

    triggers: dict = {}
    for key, record in operators.items():
        skill = find_skill(record, "Combo Skill")
        if skill is None:
            continue
        text = combo_trigger(skill)
        if not text:
            continue
        own = own_resource(text, record.get("name") or key)
        groups = [] if own else requirement_groups(text, vocabulary, term_aliases)
        triggers[key] = {
            "skill": skill.get("name"),
            "text": text,
            "groups": groups,
            **({"own": own} if own else {}),
            **({"while": stance} if (stance := stance_condition(text)) else {}),
            **({"absent": absent} if (absent := absent_terms(text, vocabulary, term_aliases)) else {}),
            "consumed": consumed_trigger(text),
            **({"orConsumed": True} if consumed_too(text) else {}),
            "min": trigger_thresholds(text, groups),
            **({"on": on} if (on := strike_trigger(text)) else {}),
        }

    applies: dict = {}
    for key, entry in index.items():
        per_term = {}
        for term, relations in entry["capabilities"].items():
            names = relations.get("applies")
            if names:
                per_term[term] = sorted(names)
        if per_term:
            applies[key] = per_term

    # Stacks: who consumes them with a skill and who forces a reaction.
    consumes: dict = {}
    forced: dict = {}
    forced_level: dict = {}
    marked: dict = {}
    vulnerable_added: dict = {}
    repeated_terms: dict = {}
    deferred: dict = {}
    takes_control: dict = {}
    stances: dict = {}
    charges: dict = {}
    transformed: dict = {}
    stocked: dict = {}
    owned: dict = {}
    detonated: dict = {}
    echoed: dict = {}
    strikes: dict = {}
    frame_data = read_frame_data()
    for key, record in operators.items():
        if repeats := echo_effects(record):
            echoed[key] = repeats
        if strike := strike_after_effect(record):
            strikes[key] = strike
        if sets_off := detonate_effects(record):
            ultimates = {skill["name"]: skill for skill in record.get("skills", [])}
            fuse = (frame_data.get(key) or {}).get("battleSkillFuse")
            entries = {}
            for name, entry in sets_off.items():
                # The increase is a row of the ultimate; without it there is nothing to apply.
                if not any(row["label"] == entry["boost"] for row in ultimates[name].get("stats") or []):
                    print(f"  ! {key}: {name} detonates {entry['name']}, but has no «{entry['boost']}» row")
                    continue
                entries[name] = {**entry, "fuse": fuse}
            if entries:
                detonated[key] = entries
        if entered := stance_effects(record):
            stances[key] = entered
        if points := charge_effects(record):
            charges[key] = points
        if moves := transform_effects(record):
            transformed[key] = moves
        if own := own_stack_effects(record):
            # «Final Strike» stacks come from the client: the strike creates the
            # same buff her battle skill's hit does (`frames.py`).
            given = (frame_data.get(key) or {}).get("finalStrikeStacks")
            if given and any(gain["skill"] == own["spentBy"]["skill"] for gain in own["gains"]):
                own["finalStrike"] = given["count"]
            owned[key] = own
        if stock := stock_effects(record):
            stocked[key] = stock
        effects = stack_effects(record, term_aliases)
        if effects["consumes"]:
            consumes[key] = effects["consumes"]
        if effects["forced"]:
            forced[key] = effects["forced"]
        if levels := forced_level_effects(record):
            forced_level[key] = levels
        if mark := mark_effects(record):
            marked[key] = mark
        if added := vulnerable_effects(record):
            vulnerable_added[key] = added
        if repeated := repeat_effects(record):
            repeated_terms[key] = repeated
        if effects["deferred"]:
            deferred[key] = effects["deferred"]
        if effects["takes_control"]:
            takes_control[key] = effects["takes_control"]

    # The game reads slot 01: Si changes the element and cuts the cooldown of whoever is there.
    team_position: dict = {}
    for key, record in operators.items():
        rules, unparsed = team_position_rules(record)
        if rules:
            team_position[key] = rules
        for line in unparsed:
            print(f"  ! {key}: about squad position, but not parsed — {line}")

    print(
        f"    synergies    {len(applies)} operators apply terms, "
        f"{len(triggers)} combo triggers parsed, "
        f"slot rules {sum(len(v) for v in team_position.values())}, "
        f"consume stacks {len(consumes)}, forced reactions {len(forced)}"
    )
    return {
        "applies": applies,
        "implications": {term: sorted(values) for term, values in implications.items()},
        "comboTriggers": triggers,
        "teamPosition": team_position,
        "consumes": consumes,
        "forced": forced,
        "forcedLevels": forced_level,
        "marks": marked,
        "vulnerableStacks": vulnerable_added,
        "repeats": repeated_terms,
        "deferred": deferred,
        "takesControl": takes_control,
        "stances": stances,
        "charges": charges,
        "transforms": transformed,
        "stocks": stocked,
        "ownStacks": owned,
        "detonates": detonated,
        "echoes": echoed,
        "strikeAfter": strikes,
    }


def export_sp() -> dict | None:
    """SP recovery values the wiki does not provide numerically.

    Final Strike and Finisher are SP *sources*, and rotations lean on them:
    ``Lifeng: FS > CS`` exists to pay for the next Battle Skill. Without these
    numbers the simulation underestimates SP and invents waits that do not
    happen in play.
    """
    path = ROOT / "data" / "endfield" / "sp.yaml"
    if not path.exists():
        return None
    _yaml()  # fails loudly without PyYAML, see _yaml()
    data = _jsonable(load_yaml(path) or {})
    measured = read_basic_attacks()
    final_strike = data.get("final_strike") or {}
    finisher = data.get("finisher") or {}
    known = final_strike.get("known") or {}
    confidence = final_strike.get("confidence") or "unknown"
    if measured:
        # The client's numbers beat two rounded numbers from the wiki.
        known = {key: row["finalStrikeSp"] for key, row in measured.items() if "finalStrikeSp" in row}
        confidence = "datamine"
    print(f"    SP layer     Final Strike known for {len(known)} operators")
    # The shape is exactly the engine's `SpTable`: converting from snake_case
    # happens here, once, rather than everywhere the engine reads the bundle.
    out = {
        "finalStrike": {
            "default": final_strike.get("default", 20),
            "known": known,
            "confidence": confidence,
        },
        "finisher": {
            "default": finisher.get("default", 25),
            "byClass": finisher.get("by_class") or {},
            "confidence": finisher.get("confidence") or "unknown",
        },
        "basicAttack": measured,
    }
    if data.get("passive_regen") is not None:
        out["passiveRegen"] = data["passive_regen"]
    dodge = data.get("perfect_dodge") or {}
    if dodge.get("amount") is not None:
        out["perfectDodge"] = {"sp": dodge["amount"], "regenPause": dodge.get("regen_pause", 0)}
    return out


def export_effects(operators: dict, weapons: dict, gear: dict) -> dict:
    """The hand-written placement of talents, potentials, weapons and sets.

    Parsing lives in `tools/ef/effects.py`, the data in
    `data/endfield/effects/*.yaml`. What arrives here is the result together
    with flags: `stale` if the wiki text drifted from the parsed one, and
    `unmodeled` where the vocabulary cannot express the effect. The app must
    show both: understated damage has to be visible.
    """
    from tools.ef.effects import load_effects

    result = load_effects(operators, weapons, gear)
    counts = result.get("counts", {})
    print(
        f"    effects      {counts.get('modeled', 0)} records with a placement "
        f"for {len(result['covered'])} operators, {counts.get('weapons', 0)} weapons, "
        f"{counts.get('gearSets', 0)} sets; {counts.get('unmodeled', 0)} not expressible in the vocabulary"
    )
    for problem in result["problems"]:
        print(f"      ! {problem}")
    if counts.get("stale"):
        stale = [entry["id"] for entry in result["entries"] if entry["stale"]]
        print(f"      ! text drifted from the wiki for {len(stale)}: {', '.join(stale[:4])}")
    return {
        "entries": result["entries"],
        "covered": result["covered"],
        "counts": counts,
        "problems": result["problems"],
    }


def weapon_columns(weapons: dict, weapon: dict) -> dict | None:
    """Each weapon component's column for this item — from the essence.

    The decision is made here and in `weapon.py`, not in the engine: the rule
    was derived from measurements and rests on the term family table. Keyed by
    component name; ``column: None`` — no matching term, and no number may be
    filled in (measurements, #6).
    """
    from tools.ef.weapon import essence_columns

    record = weapons.get(weapon.get("name"))
    terms = ((weapon.get("essence") or {}).get("terms")) or []
    if record is None or not terms:
        return None
    components = [c for c in record.get("skill_components", []) if c.get("values_by_rank")]
    resolved = essence_columns(record, terms, weapon.get("rank") or 1)
    return {comp["key"]: hit for comp, hit in zip(components, resolved)}


def export_roster(operators: dict, weapons: dict) -> dict:
    """The user's roster with the provenance of every field.

    What matters here is not the data but **where it came from**. Weapons,
    gear, potentials and skill levels are not filled in for everyone: some came
    from the Enka showcase (a fact from the game), some were written by hand,
    and some were filled in from `defaults` and are a pure assumption.

    The app must show these separately, or a defaulted skill level of one will
    look like a measured value.
    """
    from tools.ef.roster import ROSTER, load_roster, owned

    # No roster file is a normal state (a fresh clone): the bundle does not need
    # one. A file that is there but cannot be read is a failure, not a thinner
    # bundle.
    if not ROSTER.exists():
        print(f"  ! no {ROSTER.relative_to(ROOT)}: roster not read")
        return {}

    mine = owned(strict=False)
    defaults = (load_roster() or {}).get("defaults") or {}
    out: dict = {}

    for key, entry in mine.items():
        specified = set(entry.get("specified") or [])
        from_profile = set(entry.get("from_profile") or [])

        def origin(field: str, from_profile: set = from_profile, specified: set = specified) -> str:
            if field in from_profile:
                return "profile"
            if field in specified:
                return "manual"
            return "default"

        weapon = entry.get("weapon")
        gear = entry.get("gear") or []

        out[key] = {
            "key": key,
            "rosterName": entry.get("roster_name"),
            "level": entry.get("level"),
            "elite": entry.get("elite"),
            # A level does not determine elite by itself: the same level is
            # possible at a higher one if the character was promoted and not
            # levelled further. Base stats are unaffected (they depend only on
            # level), but talents are — their tiers unlock by elite.
            "eliteUncertain": bool(entry.get("elite_uncertain")),
            "potential": entry.get("potential"),
            "skills": entry.get("skills"),
            # Unlocked talent tiers from the showcase: attribute nodes and each
            # talent's tier. Missing — every tier the elite allows.
            **({"talentNodes": entry["talentNodes"]} if entry.get("talentNodes") else {}),
            "weapon": (
                {
                    "name": weapon.get("name"),
                    "level": weapon.get("level"),
                    "rank": weapon.get("rank"),
                    "breakthrough": weapon.get("breakthrough"),
                    "essence": weapon.get("essence"),
                    # The table column from the essence: cost + 3 for stats,
                    # cost + rank for the named effect (measurements, #6).
                    "columns": weapon_columns(weapons, weapon),
                }
                if isinstance(weapon, dict)
                else None
            ),
            "gear": [
                {"slot": item.get("slot"), "name": item.get("name"), "set": item.get("set")}
                for item in gear
                if isinstance(item, dict)
            ],
            "provenance": {
                field: origin(field)
                for field in ("level", "elite", "potential", "skills", "weapon", "gear")
            },
        }

    assumed = sum(
        1 for record in out.values() if record["provenance"]["weapon"] == "default"
    )
    print(f"    roster       {len(out)} (weapon not set for {assumed})")
    return {"operators": out, "defaults": defaults}


RESISTANCES_CLIENT = DATA / "resistances_client.json"


def read_client_resistances() -> dict[str, dict[str, float]] | None:
    """The client's resistance multipliers per enemy id, or None without the file.

    Written by ``tools/ef/datamine.py --export-resistances``; versioned like
    ``stagger_nodes.json``, so the check below runs in CI too, where the
    datamine clone (not in git) is absent.
    """
    if not RESISTANCES_CLIENT.exists():
        print(f"  ! no {RESISTANCES_CLIENT.name}: every resistance stays `inferred` "
              "(python3 tools/ef/datamine.py --export-resistances)")
        return None
    data = json.loads(RESISTANCES_CLIENT.read_text(encoding="utf-8"))
    return data.get("enemies") or {}


def _resists_vs_client(record: dict, client_all: dict[str, dict[str, float]] | None) -> str:
    """Resistance confidence: `confirmed` if the wiki letters matched the client.

    The client's numbers come from ``resistances_client.json`` (a snapshot of
    the datamine clone, see ``read_client_resistances``); without the file, or
    for an enemy missing from it, the answer stays `inferred`. A mismatch is
    printed and leaves `inferred`: the client is to be trusted, but deciding
    whose number to take is up to a human.
    """
    client = (client_all or {}).get(record.get("id") or "")
    if client is None:
        return "inferred"
    wiki = record.get("resistances", {})
    diff = {
        element: (wiki.get(element), value)
        for element, value in client.items()
        if wiki.get(element) is None or abs(wiki[element] - value) > 1e-6
    }
    if diff:
        print(f"      ! resistances {record.get('name')}: wiki ≠ client {diff}")
        return "inferred"
    return "confirmed"


STAGGER_NODES = DATA / "stagger_nodes.json"


def read_stagger_nodes() -> dict[str, list[float]]:
    """Stagger Nodes per enemy key, as shares of the meter.

    Written by ``tools/ef/datamine.py --export-nodes``; versioned like
    ``basic_attacks.json``. The wiki says only that strong enemies have them.
    """
    if not STAGGER_NODES.exists():
        print(f"  ! no {STAGGER_NODES.name}: Stagger Nodes unknown (python3 tools/ef/datamine.py --export-nodes)")
        return {}
    data = json.loads(STAGGER_NODES.read_text(encoding="utf-8"))
    return {key: record["nodes"] for key, record in (data.get("enemies") or {}).items()}


def export_enemies(enemies: dict) -> dict:
    nodes = read_stagger_nodes()
    client_resistances = read_client_resistances()
    out: dict = {}
    for key, record in enemies.items():
        out[key] = {
            "key": key,
            "id": record.get("id"),
            "name": record.get("name"),
            "class": record.get("class"),
            "type": record.get("type"),
            "hp": record.get("hp", []),
            "atk": record.get("atk", []),
            "def": record.get("def", []),
            # Already multipliers (0.8 = 20 % resistance), recovered from the
            # letters in the UI. Since 2026-10-28 checked against the client —
            # all 92 matched exactly.
            "resistances": record.get("resistances", {}),
            "resistanceConfidence": _resists_vs_client(record, client_resistances),
            # Enemy fields are labelled in Template:Enemy data (revid 60912):
            # SD → «Finisher ATK Mult», SPG → «Finisher SP Gain»,
            # SHP → «Stagger HP», SR → «Stagger Recovery».
            "finisherMultiplier": record.get("finisher_multiplier"),
            # SPG from the wiki: "Finisher SP Gain" in Template:Enemy data.
            "finisherSp": record.get("finisher_sp"),
            "stagger": {
                "hp": record.get("stagger_hp"),
                "recovery": record.get("stagger_recovery"),
                "nodes": nodes.get(key, []),
            },
            "weight": record.get("weight"),
            "attackRange": record.get("attack_range"),
            "revid": (record.get("source") or {}).get("revid"),
            "page": record.get("page"),
        }
    confirmed = sum(1 for record in out.values() if record["resistanceConfidence"] == "confirmed")
    print(f"    enemies      {len(out)}, resistances checked against the client for {confirmed}, "
          f"Stagger Nodes for {sum(1 for record in out.values() if record['stagger']['nodes'])}")
    return out


def export_mechanics(mechanics: dict, icons: "IconIndex") -> dict:
    out: dict = {}
    for key, record in mechanics.items():
        # Name, icon and revid only: the page texts (about 320 KB of raw
        # wikitext) were in the bundle and read by nothing; the app explains
        # a mechanic in its own words and links the page by revid (audit B38).
        out[key] = {
            "key": key,
            "name": record.get("name", key),
            "icon": icons.path("mechanics", key),
            "revid": (record.get("source") or {}).get("revid"),
        }
    return out


# -------------------------------------------------------------------- icons


# Gear and weapon icons come from the wiki at 256×256 — four times more than the
# UI list needs, and 18 MB in total. The originals stay in data/ as the source;
# the app gets a scaled-down copy.
ICON_MAX_PX = 96


def copy_icons(src_root: Path, dst_root: Path, *, max_px: int = ICON_MAX_PX) -> dict:
    """Scaled-down icon copies in the app's public/.

    The target directory is generated: it can be wiped and rebuilt, so it is
    not versioned. The original stays in ``data/endfield/img``.
    """
    stats = {"copied": 0, "resized": 0, "bytes": 0, "skipped": 0}
    if not src_root.exists():
        return stats

    try:
        from PIL import Image
    except ImportError:
        Image = None  # noqa: N806 — without Pillow, copy as is

    for src in sorted(src_root.rglob("*.png")):
        rel = src.relative_to(src_root)
        dst = dst_root / rel
        if dst.exists() and dst.stat().st_mtime >= src.stat().st_mtime:
            stats["skipped"] += 1
            stats["bytes"] += dst.stat().st_size
            continue
        dst.parent.mkdir(parents=True, exist_ok=True)

        if Image is None:
            dst.write_bytes(src.read_bytes())
            stats["copied"] += 1
        else:
            with Image.open(src) as image:
                image.load()
                if max(image.size) > max_px:
                    image.thumbnail((max_px, max_px), Image.LANCZOS)
                    stats["resized"] += 1
                else:
                    stats["copied"] += 1
                image.save(dst, "PNG", optimize=True)
        stats["bytes"] += dst.stat().st_size
    return stats


class IconIndex:
    """What has actually been downloaded into ``data/endfield/img``.

    An icon may be missing — stub pages and some mechanics have none on the
    wiki. Then the bundle holds ``null``, and the app must survive it.
    """

    def __init__(self, root: Path) -> None:
        self.root = root
        self.available: dict[str, set[str]] = {}
        if not root.exists():
            return
        for kind_dir in sorted(root.iterdir()):
            if kind_dir.is_dir():
                self.available[kind_dir.name] = {p.name for p in kind_dir.iterdir()}
        self.missing: list[str] = []

    def path(self, kind: str, name: str | None) -> str | None:
        if not name:
            return None
        suffix = " icon.png" if kind in {"operators", "weapons", "gear", "mechanics"} else ".png"
        filename = f"{name}{suffix}".replace(":", "__").replace("/", "~")
        if filename in self.available.get(kind, ()):  # noqa: PLR6201
            return f"img/{kind}/{filename}"
        self.missing.append(f"{kind}/{filename}")
        return None


# ---------------------------------------------------------------------- main


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--indent", type=int, default=None, help="indent (compact by default)")
    parser.add_argument("--no-icons", action="store_true", help="do not copy icons")
    parser.add_argument(
        "--public",
        action="store_true",
        help="public build: no roster.json next to the bundle (an existing one is removed)",
    )
    args = parser.parse_args()

    print("Bundle for the app")

    icons = IconIndex(DATA / "img")
    icons.missing = []
    have = sum(len(v) for v in icons.available.values())
    print(f"  icons on disk: {have}")

    operators = load("operators.json")
    weapons = load("weapons.json")
    gear = load("gear.json")
    enemies = load("enemies.json")
    glossary = load("glossary.json")
    mechanics = load("mechanics.json")
    manifest = load("_manifest.json")

    bundle = {
        "schema": SCHEMA,
        "game": "endfield",
        "generatedAt": now(),
        "source": {
            "wiki": WIKI,
            "license": LICENSE,
            "note": (
                "Game data from Endfield Talos Wiki (endfield.wiki.gg), CC BY-SA 4.0, "
                "modified: parsed, converted to explicit units and annotated."
            ),
        },
        "breakpoints": BREAKPOINTS,
        "operators": export_operators(operators, icons),
        "weapons": export_weapons(weapons, icons),
        "gear": export_gear(gear, icons),
        "enemies": export_enemies(enemies),
        "glossary": glossary,
        "mechanics": export_mechanics(mechanics, icons),
        "effects": export_effects(operators, weapons, gear),
        "timings": export_timings(),
        "sp": export_sp(),
        "synergy": export_synergy(operators),
        "rotations": export_rotations(),
        "showcase": export_showcase_tables(),
        "aliases": export_aliases(),
    }

    revids = sorted(
        entry["revid"]
        for entry in manifest.values()
        if isinstance(entry, dict) and isinstance(entry.get("revid"), int)
    )
    bundle["counts"] = {
        "operators": len(bundle["operators"]),
        "weapons": len(bundle["weapons"]),
        "gearPieces": len(bundle["gear"]["pieces"]),
        "gearSets": len(bundle["gear"]["sets"]),
        "enemies": len(bundle["enemies"]),
        "glossary": len(bundle["glossary"]),
        "mechanics": len(bundle["mechanics"]),
        "effects": len((bundle["effects"] or {}).get("entries") or []),
        "icons": have,
    }
    bundle["source"]["maxRevid"] = revids[-1] if revids else None
    bundle["source"]["pages"] = len(revids)

    args.out.parent.mkdir(parents=True, exist_ok=True)
    # Write through a temporary file: a serialisation failure halfway would
    # leave a truncated bundle, and the app would crash with "Unexpected end of
    # JSON", leading away from the real cause. This way a broken file never
    # appears.
    temporary = args.out.with_suffix(".json.tmp")
    with temporary.open("w", encoding="utf-8") as handle:
        json.dump(bundle, handle, ensure_ascii=False, indent=args.indent)
    temporary.replace(args.out)

    # Official Russian names, for display only (tools/ef/names_ru.py). The
    # bundle stays English: synergy and the effects layer match by English
    # names, and nothing that reads data ever sees the Russian ones.
    locale_src = DATA / "locale_ru.json"
    locale_path = args.out.with_name("bundle.ru.json")
    if locale_src.exists():
        names = {k: v for k, v in json.loads(locale_src.read_text(encoding="utf-8")).items() if k != "meta"}
        locale_tmp = locale_path.with_suffix(".json.tmp")
        with locale_tmp.open("w", encoding="utf-8") as handle:
            json.dump({"schema": SCHEMA, "lang": "ru", **names}, handle, ensure_ascii=False)
        locale_tmp.replace(locale_path)
        print(f"  Russian names: {locale_path.relative_to(ROOT)} — {sum(len(v) for v in names.values())}")
    else:
        print("  ! no locale_ru.json: there will be no Russian names (python3 tools/ef/names_ru.py)")

    # The roster is one account's snapshot: it lives next to the bundle, not
    # in it, and a public build has none. Removing a stale file matters as
    # much as not writing one — a public deploy must not pick it up.
    roster_path = args.out.with_name("roster.json")
    if args.public:
        roster_path.unlink(missing_ok=True)
        print("  roster: public build, roster.json is not written")
    else:
        roster = export_roster(operators, weapons)
        roster_tmp = roster_path.with_suffix(".json.tmp")
        with roster_tmp.open("w", encoding="utf-8") as handle:
            json.dump({"schema": SCHEMA, "roster": roster}, handle, ensure_ascii=False, indent=args.indent)
        roster_tmp.replace(roster_path)
        print(f"  roster: {roster_path.relative_to(ROOT)} — {len((roster or {}).get('operators') or {})} operators")

    if not args.no_icons:
        icon_stats = copy_icons(DATA / "img", args.out.parent.parent / "img")
        print(
            f"  icons in public: scaled {icon_stats['resized']}, "
            f"copied {icon_stats['copied']}, unchanged {icon_stats['skipped']} "
            f"({icon_stats['bytes'] / 1024:.0f} KB)"
        )

    size = args.out.stat().st_size
    for name, count in bundle["counts"].items():
        print(f"    {name:12s} {count}")
    if icons.missing:
        unique = sorted(set(icons.missing))
        print(f"  without an icon: {len(unique)}")
        for item in unique[:8]:
            print(f"    ! {item}")
        if len(unique) > 8:
            print(f"    … and {len(unique) - 8} more")
    print(f"\n  {args.out.relative_to(ROOT)} — {size / 1024:.0f} KB")
    print(f"  schema {SCHEMA}, wiki pages {bundle['source']['pages']}, "
          f"max revid {bundle['source']['maxRevid']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
