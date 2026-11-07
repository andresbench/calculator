#!/usr/bin/env python3
"""An index of operator abilities: who applies, consumes and buffs what.

Synergy in Endfield rests on a few junctions, and all of them are expressed in
glossary terms that the descriptions mark up for machines (``{{G|...}}``). So
the links need not be guessed from meaning but can be extracted:

* **Arts Reaction** needs two DIFFERENT Arts Inflictions on the target — so
  it matters who applies which element, not just who hits hard.
* **Physical Status** works through Vulnerable stacks: some apply them, others
  consume them (Crush, Breach), and damage depends on how many were consumed.
* **Buffs sit in different multiplier groups** (Amp, Susceptibility, Link,
  DMG Bonus). Buffs from different groups multiply, from the same group add
  up, so building a team from same-type buffers does not pay.

Commands::

    python3 tools/ef/synergy.py index [--all]      # ability table
    python3 tools/ef/synergy.py who <term>         # who works with a term
    python3 tools/ef/synergy.py fit <operator>     # how they fit the roster
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from tools.ef.roster import owned

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "data" / "endfield"

ELEMENTS = ["Heat", "Electric", "Cryo", "Nature"]

# Umbrella terms rank with specific ones: "consume all Arts Infliction stacks"
# is exactly the cross-element synergy, and without them it is invisible.
INFLICTIONS = [f"{e} Infliction" for e in ELEMENTS] + ["Arts Infliction"]
BURSTS = [f"{e} Burst" for e in ELEMENTS] + ["Arts Burst"]
REACTIONS = ["Combustion", "Electrification", "Solidification", "Corrosion",
             "Arts Reaction"]
PHYSICAL = ["Lift", "Knock Down", "Crush", "Breach", "Vulnerable", "Shatter",
            "Physical Status"]
AMPS = ["Amp", "Arts Amp"] + [f"{e} Amp" for e in ELEMENTS]
SUSCEPT = ["Susceptible", "Physical Susceptibility", "Arts Susceptibility"] + [
    f"{e} Susceptibility" for e in ELEMENTS
]
SUPPORT = ["Link", "Protect", "Shield", "Haste", "Slow", "Weaken", "Dispel"]
# Operators' own debuffs the glossary does not list but a trigger names:
# Antal's combo needs "an enemy with active Focus".
OWN = ["Focus"]

# Verbs around a term. "forcibly apply" is common and means applying without
# the usual condition — for synergy it is the same application. "applying" is
# an application too, hence appl\w*. "deal" — because damage and a status are
# often listed together: "deal Physical DMG and Crush".
APPLY = re.compile(r"\b(appl\w*|inflict\w*|trigger\w*|deal\w*|gain\w*)\b", re.I)
CONSUME = re.compile(r"\b(consum\w*|absorb\w*)\b", re.I)
# A condition, not an action: "against enemies with X", "if the target has X".
CONDITION = re.compile(
    r"\b(with|against|has|have|affected by|under|if the (?:target|enemy))\b\s*$", re.I
)


def load_operators() -> dict:
    with (DATA / "operators.json").open(encoding="utf-8") as handle:
        return json.load(handle)


def load_aliases() -> dict[str, list[str]]:
    """Term synonyms the parser collected from the wiki markup."""
    path = DATA / "glossary.json"
    if not path.exists():
        return {}
    with path.open(encoding="utf-8") as handle:
        glossary = json.load(handle)
    return {term: entry.get("aliases", []) for term, entry in glossary.items()}


def term_pattern(term: str, aliases: dict[str, list[str]]) -> re.Pattern:
    """A regex for a term and all its labels from the wiki.

    "Vulnerable" is almost always written as "Vulnerability" in text, and
    "Crush" as "Crushed"; without synonyms the search misses.
    """
    variants = [term] + [a for a in aliases.get(term, []) if len(a) > 2]
    variants.sort(key=len, reverse=True)
    joined = "|".join(re.escape(v) for v in variants)
    return re.compile(rf"\b(?:{joined})\b", re.I)


def split_moves(operator: dict, skill: dict) -> tuple[str, list[tuple[str, str]]]:
    """A skill's own text, and the paragraphs of the moves it turns into.

    Argent Flow's battle skill text ends with «Bolt Rush: … forcibly apply
    Electrification … applies 1 stack of Vulnerability» — that is the move
    his combo turns the battle skill into, not the plain cast (which only
    applies Lift). Camille's ultimate carries «Hunter Pursuit: Treated as a
    combo skill …». Each `<Move>: ` paragraph of a known transform target is
    read under the move's name; the rest stays the skill's own.
    """
    text = skill.get("text", "")
    names = sorted({entry["into"] for entry in transforms(operator).values()}, key=len, reverse=True)
    cuts = []
    for name in names:
        found = re.search(rf"(?:^|\n)\s*{re.escape(name)}: ", text)
        if found:
            cuts.append((found.start(), found.end(), name))
    if not cuts:
        return text, []
    cuts.sort()
    own = text[: cuts[0][0]]
    moves = []
    for index, (_, end, name) in enumerate(cuts):
        stop = cuts[index + 1][0] if index + 1 < len(cuts) else len(text)
        moves.append((name, text[end:stop]))
    return own, moves


def skill_texts(operator: dict):
    """(skill, name, text): every skill's own text, then each move under its own name."""
    for skill in operator.get("skills", []):
        own, moves = split_moves(operator, skill)
        yield skill, skill["name"], own
        for name, text in moves:
            yield skill, name, text


def iter_texts(operator: dict):
    for skill, name, text in skill_texts(operator):
        yield "skill", name, text, skill.get("terms", [])
    for talent in operator.get("talents", []):
        for level in talent["levels"]:
            yield "talent", talent["name"], level.get("text", ""), level.get("terms", [])
    for potential in operator.get("potentials", []):
        yield "potential", potential.get("title", ""), potential.get("text", ""), potential.get("terms", [])


# The game reads squad position ("Team Position 01") literally: slot 01 is the
# first in the team. It occurs in two kinds of phrases, and both are parsed
# into a structure so that the engine does not repeat the regexes.
SWAP_RE = re.compile(
    r"(?P<term>\w+ Infliction) \(or (?P<alt>\w+ Infliction) if an? (?P<element>\w+) "
    r"element operator is in Team Position 0*(?P<slot>\d+)\)",
    re.I,
)
CD_CUT_RE = re.compile(
    r"^(?:Ultimate|Battle|Combo)(?: skill)? (?P<skill>.+?) improved: After casting, "
    r"Team Position 0*(?P<slot>\d+) operator's combo skill cooldown length "
    r"-(?P<seconds>\d+(?:\.\d+)?)s",
    re.I,
)
TEAM_POSITION = re.compile(r"Team Position", re.I)


def team_position_rules(operator: dict) -> tuple[list[dict], list[str]]:
    """Slot-dependent rules, and slot phrases that were not parsed.

    The second part of the list is a guard: if the wiki introduces a new
    wording, it will not be lost silently but will surface when the bundle is
    built.
    """
    rules: list[dict] = []
    unparsed: list[str] = []
    for skill in operator.get("skills", []):
        text = skill.get("text", "")
        for match in SWAP_RE.finditer(text):
            rules.append({
                "kind": "swapTerm",
                "skill": skill["name"],
                "term": match["term"],
                "alt": match["alt"],
                "slot": int(match["slot"]),
                "element": match["element"].capitalize(),
                "text": match[0],
            })
        rest = SWAP_RE.sub("", text)
        if TEAM_POSITION.search(rest):
            unparsed.append(f"{skill['name']}: {rest[:120]}")
    for talent in operator.get("talents", []):
        for level in talent["levels"]:
            text = level.get("text", "")
            match = CD_CUT_RE.search(text)
            elite = re.match(r"Elite (\d+)", level.get("condition", ""))
            if match and elite:
                rules.append({
                    "kind": "comboCooldownCut",
                    "skill": match["skill"].strip(),
                    "slot": int(match["slot"]),
                    "seconds": float(match["seconds"]),
                    "elite": int(elite[1]),
                    "source": talent["name"],
                    "text": text,
                })
            elif TEAM_POSITION.search(text):
                unparsed.append(f"{talent['name']}: {text[:120]}")
    for potential in operator.get("potentials", []):
        if TEAM_POSITION.search(potential.get("text", "")):
            unparsed.append(f"P{potential['rank']}: {potential['text'][:120]}")
    return rules, unparsed


STACK_TERMS = INFLICTIONS + ["Vulnerable"] + REACTIONS
COMBO_TRIGGER_RE = re.compile(r"COMBO TRIGGER:.*?(?=SKILL DESCRIPTION:|$)", re.S | re.I)
THRESHOLD_RE = re.compile(
    r"(?:(?P<n1>\d+|two|three|four) or more (?:stacks of )?|at least (?P<n2>\d+|two|three|four) stacks of "
    r"|reach(?:es)? (?P<n3>\d+|two|three|four) stacks of )"
    r"(?P<what>[A-Za-z -]+?)(?: stacks?)?(?=[ .,;]|$)",
    re.I,
)
WORD_NUMBERS = {"two": 2, "three": 3, "four": 4}
SHATTERS_RE = re.compile(r"\bthis skill shatters the Originium Crystals?\b", re.I)
NEXT_FINAL_STRIKE_RE = re.compile(r"\bnext Final Strike performed by\b", re.I)
# «summons her Sviga Lævi and becomes the controlled operator», «makes Yvonne
# the controlled operator»: the cast moves control to its caster.
TAKES_CONTROL_RE = re.compile(r"\b(?:becomes|makes \w+) the controlled operator\b", re.I)


def stack_effects(operator: dict, aliases: dict[str, list[str]]) -> dict:
    """What skills do with stacks: consume them, and whether they force a reaction.

    Kept apart from ``relation`` because the engine needs precision rather
    than coverage. The combo trigger text is dropped entirely: "when Heat
    Infliction is consumed" is Camille's condition, not his action.
    Consumption counts only with an active verb BEFORE the term ("consume all
    Cryo Infliction stacks"); the passive "stacks consumed or absorbed" in
    Si's damage description is a count, not an action.

    A forced reaction ("forcibly apply Electrification") does not consume
    stacks per the wiki and is level I; an ordinary one consumes the
    infliction.
    """
    consumes: dict[str, list[str]] = {}
    forced: dict[str, list[str]] = {}
    deferred: dict[str, str] = {}
    takes_control: list[str] = []
    for skill, name, raw in skill_texts(operator):
        text = COMBO_TRIGGER_RE.sub("", raw)
        skill = {**skill, "name": name}
        if TAKES_CONTROL_RE.search(text) and skill["name"] not in takes_control:
            takes_control.append(skill["name"])
        # «The next Final Strike performed by the controlled operator … applies
        # Cryo Infliction»: the cast itself applies nothing; the next FS does.
        if NEXT_FINAL_STRIKE_RE.search(text):
            deferred[skill["name"]] = "FS"
        # «this skill shatters the Originium Crystals»: the ultimate consumes
        # them itself. The combo's own «applying … shatters the crystals» has
        # another subject and is a condition for others.
        if SHATTERS_RE.search(text):
            names = consumes.setdefault("Originium Crystal", [])
            if skill["name"] not in names:
                names.append(skill["name"])
        for term in STACK_TERMS:
            pattern = term_pattern(term, aliases)
            for clause in clauses(text):
                # Every mention: «If the enemy has active Electric Infliction,
                # consume the Electric Infliction» consumes it the second time.
                for match in pattern.finditer(clause):
                    if consumes_term(clause[: match.start()]):
                        names = consumes.setdefault(term, [])
                        if skill["name"] not in names:
                            names.append(skill["name"])
                match = pattern.search(clause)
                if not match:
                    continue
                before = clause[: match.start()]
                if term in REACTIONS and re.search(r"\bforcibly\b", before, re.I):
                    names = forced.setdefault(term, [])
                    if skill["name"] not in names:
                        names.append(skill["name"])
    return {"consumes": consumes, "forced": forced, "deferred": deferred, "takes_control": takes_control}


ENTERS_STANCE_RE = re.compile(r"\benters (?:her|his|their) ([A-Z]\w+ Stance)\b")
REPLACES_STANCE_RE = re.compile(r"\bThis stance replaces \w+'s ([A-Z]\w+ Stance)\b")


def stances(operator: dict) -> dict[str, dict]:
    """skill → the stance its cast enters, and the stance it replaces.

    «Liino … enters her Vocalist Stance»; «Cosmovoice Stance: This stance
    replaces Liino's Vocalist Stance». The engine reads the duration from the
    skill's `<Stance> Duration (s)` row.
    """
    out: dict[str, dict] = {}
    for skill in operator.get("skills", []):
        text = COMBO_TRIGGER_RE.sub("", skill.get("text", ""))
        enters = ENTERS_STANCE_RE.search(text)
        if not enters:
            continue
        entry = {"enters": enters[1]}
        if replaces := REPLACES_STANCE_RE.search(text):
            entry["replaces"] = replaces[1]
        out[skill["name"]] = entry
    return out


CHARGE_GAIN_RE = re.compile(r"\bgenerating (\d+) points? of ([A-Z][\w ]*?)[.,]")
CHARGE_SPEND_RE = re.compile(
    r"After an enemy suffers an? ([A-Z][\w ]*?)(?: or takes DMG from \w+'s combo skill)?, "
    r"\w+ consumes 1 point of (?P<name>[A-Z][\w ]*?) and summons 1 \w+ to (?P<each>[a-z]+)\b"
)
CHARGE_COMBO_RE = re.compile(r"\bor takes DMG from \w+'s combo skill\b")
CHARGE_LAST_RE = re.compile(r"\bWhen the last (?P<name>[A-Z][\w ]*?) point is consumed, .*? an? (?P<last>[A-Z][\w ]*?) that\b")


def charges(operator: dict) -> dict[str, dict]:
    """skill → points its cast generates, and what spends them.

    Pogranichnik's ultimate: «generating 5 points of Steel Oath. After an
    enemy suffers a Physical Status or takes DMG from Pogranichnik's combo
    skill, Pogranichnik consumes 1 point of Steel Oath and summons 1
    Shieldguard to harass the said enemy … When the last Steel Oath point is
    consumed, all 4 Shieldguards will initiate a Decisive Assault that …».

    ``each`` and ``last`` are the prefixes of the skill's rows that land on
    every spent point and on the last one («Harass DMG Multiplier»,
    «Decisive Assault SP Recovery»); the engine reads the duration from the
    ``<name> Duration`` row.
    """
    out: dict[str, dict] = {}
    for skill in operator.get("skills", []):
        text = COMBO_TRIGGER_RE.sub("", skill.get("text", ""))
        gain = CHARGE_GAIN_RE.search(text)
        spend = CHARGE_SPEND_RE.search(text)
        if not gain or not spend or spend["name"] != gain[2]:
            continue
        entry = {
            "name": gain[2],
            "points": int(gain[1]),
            "on": [spend[1]],
            "combo": bool(CHARGE_COMBO_RE.search(spend[0])),
            "each": spend["each"].capitalize(),
        }
        last = CHARGE_LAST_RE.search(text)
        if last and last["name"] == gain[2]:
            entry["last"] = last["last"]
        out[skill["name"]] = entry
    return out


TRANSFORMS_RE = re.compile(
    r"After casting the ultimate, \w+'s battle skill is temporarily transformed into (?P<into>[A-Z][\w' ]*?)\."
)
# Argent Flow: «After Argent Flow casts his combo skill, his battle skill is
# temporarily changed to Bolt Rush.» The window is the combo's `Battle Skill
# Change Duration (s)`; the move is still a battle skill and costs its SP.
COMBO_TRANSFORMS_RE = re.compile(
    r"After [\w ]+? casts (?:his|her|their) combo skill, (?:his|her|their) battle skill is "
    r"temporarily changed to (?P<into>[A-Z][\w' ]*?)\."
)
TREATED_AS_RE = r"{into}: Treated as an? (?P<as>basic attack|battle skill|combo skill|ultimate)(?P<free> and costs no SP)?"


def transforms(operator: dict) -> dict[str, dict]:
    """ultimate → the move its cast turns the battle skill into.

    Camille: «After casting the ultimate, Camille's battle skill is
    temporarily transformed into Hunter Pursuit. Hunter Pursuit: Treated as
    a combo skill and costs no SP.» The move's rows are `<into> …` in the
    skill of the type it is treated as; the window is the ultimate's
    `<into> State Duration (s)` row.
    """
    out: dict[str, dict] = {}
    for skill in operator.get("skills", []):
        if skill.get("type") != "Ultimate":
            continue
        text = skill.get("text", "")
        found = TRANSFORMS_RE.search(text)
        if not found:
            continue
        into = found["into"]
        treated = re.search(TREATED_AS_RE.format(into=re.escape(into)), text, re.I)
        if not treated:
            continue
        out[skill["name"]] = {
            "skill": "Battle Skill",
            "into": into,
            "as": treated["as"].title(),
            "free": bool(treated["free"]),
        }
    combo = next((skill for skill in operator.get("skills", []) if skill.get("type") == "Combo Skill"), None)
    for skill in operator.get("skills", []):
        found = COMBO_TRANSFORMS_RE.search(re.sub(r"\s+", " ", skill.get("text", "")))
        if not found or combo is None or combo["name"] in out:
            continue
        into = found["into"]
        labels = [row["label"] for row in combo.get("stats", [])]
        window = next(
            (label for label in labels if label in ("Battle Skill Change Duration (s)", f"{into} State Duration (s)")),
            None,
        )
        out[combo["name"]] = {
            "skill": "Battle Skill",
            "into": into,
            "as": "Battle Skill",
            "free": False,
            **({"window": window} if window else {}),
        }
    return out


# Argent Flow's Bolt Rush: «forcibly apply Electrification … When this
# Electrification is applied on a target with Electric Infliction, it consumes
# all Electric Infliction stacks from the target and grants Electrification
# Status Level +1 per 1 stack consumed».
FORCED_LEVEL_RE = re.compile(
    r"consumes all (?P<term>\w+ Infliction) stacks.*?grants (?P<reaction>[A-Z]\w+) Status Level \+1 per 1 stack consumed",
    re.S,
)


def forced_levels(operator: dict) -> dict[str, dict]:
    """skill or move → a forced reaction whose level counts the stacks it consumed.

    Read literally: level I, +1 per stack consumed, up to IV — one Electric
    stack consumed gave Electrification II in game (measurements, #59).
    """
    out: dict[str, dict] = {}
    for _, name, text in skill_texts(operator):
        found = FORCED_LEVEL_RE.search(re.sub(r"\s+", " ", text))
        if found:
            out[name] = {"reaction": found["reaction"], "per": found["term"]}
    return out


# Argent Flow's «Zenith of Voltmancy»: his Electrification also raises «all
# types of DMG Taken» and leaves a mark (Sunderization) with as many stacks
# as its Status Level; Crush on a marked target is boosted and detonates it.
MARK_ALL_TYPES_RE = re.compile(r"When [\w ]+? applies (?P<reaction>[A-Z]\w+), this (?P=reaction) also increases all types of DMG Taken")
MARK_RE = re.compile(
    r"applies (?P<name>[A-Z]\w+) stack\(s\) on the target, the number of stacks is equal to the "
    r"(?P<reaction>[A-Z]\w+) Status Level and maxes out at (?P<max>\d+)\. (?P=name) lasts for (?P<seconds>\d+)s"
)
MARK_BLAST_RE = r"When dealing (?P<status>[A-Z]\w+) DMG to a target with {name}, this (?P=status) DMG is increased to (?P<boost>[\d.]+) times the original and detonates all {name} stacks\. The explosion deals \[Number of {name} stacks × (?P<pct>[\d.]+)% ATK\] of (?P<element>\w+) DMG"
MARK_AI_RE = r"For every point of Arts Intensity that [\w ]+? has, increase {name} explosion DMG by another (?P<pct>[\d.]+)%"
ELITE_RE = re.compile(r"Elite (\d)")


def marks(operator: dict) -> dict:
    """A mark a reaction leaves and a Physical Status detonates (Argent Flow's Sunderization).

    Per elite: the boost to the status and the explosion's ATK share per
    stack; and the explosion's bonus per point of his Arts Intensity.
    Measured (#59): the DMG Taken is Electrification's own value, for every
    DMG type; the explosion is a plain hit by his ATK.
    """
    entry: dict = {}
    by_elite: list[dict] = []
    ai_by_elite: list[dict] = []
    for talent in operator.get("talents", []):
        for level in talent.get("levels", []):
            text = re.sub(r"\s+", " ", level.get("text", ""))
            elite = ELITE_RE.search(level.get("condition", ""))
            elite_n = int(elite[1]) if elite else 0
            found = MARK_RE.search(text)
            if found:
                entry.update(
                    name=found["name"], reaction=found["reaction"], max=int(found["max"]), seconds=float(found["seconds"]),
                    allTypes=bool(MARK_ALL_TYPES_RE.search(text)),
                )
                blast = re.search(MARK_BLAST_RE.format(name=re.escape(found["name"])), text)
                if blast:
                    entry.update(status=blast["status"], element=blast["element"])
                    by_elite.append({"elite": elite_n, "boost": float(blast["boost"]), "perStack": round(float(blast["pct"]) / 100, 6)})
            if entry.get("name"):
                ai = re.search(MARK_AI_RE.format(name=re.escape(entry["name"])), text)
                if ai:
                    ai_by_elite.append({"elite": elite_n, "perPoint": round(float(ai["pct"]) / 100, 6)})
    if not entry or not by_elite:
        return {}
    entry["byElite"] = sorted(by_elite, key=lambda row: row["elite"])
    if ai_by_elite:
        entry["aiByElite"] = sorted(ai_by_elite, key=lambda row: row["elite"])
    return entry


# «After consuming the target's Electric Infliction, Argent Flow also applies
# 1 stack of Vulnerability» — a stack added directly, not through a Physical
# Status. The engine otherwise reads «Vulnerable» as a category.
VULNERABLE_STACKS_RE = re.compile(
    r"After consuming the target's (?P<after>[A-Z][\w ]+?), [\w ]+? also applies (?P<count>\d+) stacks? of Vulnerability"
)


def vulnerable_stacks(operator: dict) -> dict[str, dict]:
    """skill or move → Vulnerable stacks it adds directly, and on what condition."""
    out: dict[str, dict] = {}
    for _, name, text in skill_texts(operator):
        found = VULNERABLE_STACKS_RE.search(re.sub(r"\s+", " ", text))
        if found:
            out[name] = {"count": int(found["count"]), "after": found["after"]}
    return out


# «The Slam … applies Knock Down … After a while, the Slam unleashes one more
# hit that … applies another Knock Down» — one cast, the same term twice. The
# earlier application has to stand in the same paragraph: Arcane's «applies
# another instance of Nature Susceptibility» is a battle skill hit on an
# Imprisoned target, a separate event under its own condition, not a repeat
# of the combo's.
REPEAT_RE = re.compile(r"\bapplies another (?P<term>[A-Z][\w']*(?: [A-Z][\w']*)*)")


def repeats(operator: dict) -> dict[str, dict[str, int]]:
    """skill → term → how many times one cast applies it, when more than once."""
    out: dict[str, dict[str, int]] = {}
    for _, name, text in skill_texts(operator):
        for paragraph in text.split("\n"):
            paragraph = re.sub(r"\s+", " ", paragraph)
            for found in REPEAT_RE.finditer(paragraph):
                term = found["term"]
                earlier = re.search(rf"\bappl(?:y|ies)\b[^.]*?\b{re.escape(term)}\b", paragraph[: found.start()])
                if earlier:
                    counts = out.setdefault(name, {})
                    counts[term] = counts.get(term, 1) + 1
    return out


STUCK_RE = re.compile(r"\bKicks an? (?P<name>[A-Z][\w ]*?) that sticks to the target\b.*?\bexploding after a short duration")
DETONATES_RE = r"If an? {name} has been stuck to the target, the skill detonates it immediately and increases the DMG"


def detonates(operator: dict) -> dict[str, dict]:
    """ultimate → the battle skill's charge it sets off early.

    Fluorite: her battle skill «Kicks an Improvised Explosive that sticks to
    the target … exploding after a short duration»; her ultimate: «If an
    Improvised Explosive has been stuck to the target, the skill detonates
    it immediately and increases the DMG and size of the explosion». The
    increase is the ultimate's `Battle Skill DMG Boost` row; the fuse comes
    from the client's frames (`frames.py`, ``battleSkillFuse``).
    """
    skills = operator.get("skills", [])
    planted = None
    for skill in skills:
        if skill.get("type") == "Battle Skill" and (found := STUCK_RE.search(re.sub(r"\s+", " ", skill.get("text", "")))):
            planted = (skill["name"], found["name"])
    if not planted:
        return {}
    out: dict[str, dict] = {}
    for skill in skills:
        if skill.get("type") != "Ultimate":
            continue
        if re.search(DETONATES_RE.format(name=re.escape(planted[1])), re.sub(r"\s+", " ", skill.get("text", ""))):
            out[skill["name"]] = {"skill": planted[0], "name": planted[1], "boost": "Battle Skill DMG Boost"}
    return out


STRIKE_AFTER_RE = re.compile(
    r"^Battle skill (?P<skill>.+?) improved: After applying (?P<term>[A-Z]\w+), "
    r"the next basic attack (?:performed |directly )?becomes a Final Strike\b"
)


def strike_after(operator: dict) -> dict | None:
    """The battle skill whose term turns the next basic attack into a Final Strike.

    Yvonne's Barrage of Technology: «Battle skill Brr-Brr-Bomb β improved:
    After applying Solidification, the next basic attack performed becomes a
    Final Strike» — one hit, not the whole chain; from the lowest elite
    stage whose text says so.
    """
    for talent in operator.get("talents", []):
        for level in talent.get("levels", []):
            found = STRIKE_AFTER_RE.search(re.sub(r"\s+", " ", level.get("text", "")))
            elite = re.fullmatch(r"Elite (\d+)", level.get("condition", ""))
            if found and elite:
                return {"skill": found["skill"], "term": found["term"], "elite": int(elite[1]), "talent": talent["name"]}
    return None


ECHO_ANY_RE = re.compile(r"\bapplies another Arts Infliction of the element already on the enemy\b")
ECHO_MIN_RE = re.compile(
    r"\bhits a target with at least (?P<min>\d+) stacks of (?P<elements>(?:\w+ Infliction(?: or )?)+), then apply the same Arts Infliction again\b"
)


def echoes(operator: dict) -> dict[str, dict]:
    """skill → the elements it repeats: one more stack of what is already on the target.

    Fluorite's combo «applies another Arts Infliction of the element already
    on the enemy» — of the elements its trigger names (Cryo or Nature); her
    ultimate «If the final DMG sequence hits a target with at least 2 stacks
    of Cryo Infliction or Nature Infliction, then apply the same Arts
    Infliction again». The applies index lists both elements for both
    skills, and the simulation would apply both and react them with each
    other; this says which one lands.
    """
    out: dict[str, dict] = {}
    for skill in operator.get("skills", []):
        text = re.sub(r"\s+", " ", skill.get("text", ""))
        if found := ECHO_MIN_RE.search(text):
            elements = re.findall(r"(\w+) Infliction", found["elements"])
            out[skill["name"]] = {"elements": elements, "min": int(found["min"])}
        elif ECHO_ANY_RE.search(text):
            elements = sorted({element for element in re.findall(r"(\w+) Infliction", text) if element != "Arts"})
            out[skill["name"]] = {"elements": elements, "min": 1}
    return out


STOCK_GAIN_RE = re.compile(r"\bcreates an? (?P<name>[A-Z]\w+)\.\s*Up to (?P<max>\d+) (?P=name)s can exist\b")
STOCK_SPEND_RE = re.compile(r"\bconsumes all nearby (?P<name>[A-Z]\w+)s to create additional (?P<makes>[A-Z]\w+)s\b")
STOCK_MANY_RE = r"If the battle skill creates multiple {makes}s, they also apply (?P<term>[A-Z][\w ]*?) to\b"


def stocks(operator: dict) -> dict:
    """Things one of the operator's skills leaves on the field and another spends.

    Tangtang: her combo «creates a Whirlpool. Up to 2 Whirlpools can exist»;
    her battle skill «creates a Waterspout» and «consumes all nearby
    Whirlpools to create additional Waterspouts and return some SP»; «If the
    battle skill creates multiple Waterspouts, they also apply Arts
    Susceptibility». The engine reads each one's lifetime from the gaining
    skill's `<name> Duration (s)` row.
    """
    gain = spend = None
    for skill in operator.get("skills", []):
        text = re.sub(r"\s+", " ", COMBO_TRIGGER_RE.sub("", skill.get("text", "")))
        if found := STOCK_GAIN_RE.search(text):
            gain = {"skill": skill["name"], "name": found["name"], "max": int(found["max"])}
        if found := STOCK_SPEND_RE.search(text):
            makes = found["makes"]
            many = re.search(STOCK_MANY_RE.format(makes=makes), text)
            spend = {
                "skill": skill["name"],
                "name": found["name"],
                "makes": makes,
                # «creates a Waterspout» besides the ones the stock adds.
                "base": 1 if re.search(rf"\bcreates an? {makes}\b", text) else 0,
                "onMany": [many["term"]] if many else [],
            }
    if not gain or not spend or gain["name"] != spend["name"]:
        return {}
    return {
        "name": gain["name"],
        "max": gain["max"],
        "gainedBy": gain["skill"],
        "spentBy": spend["skill"],
        "makes": spend["makes"],
        "base": spend["base"],
        "onMany": spend["onMany"],
    }


NAME = r"[A-Z]\w*(?: [A-Z]\w*)*"
OWN_GAIN_RE = re.compile(rf"\b(?:grants|gains) (?P<count>\d+) stacks? of (?P<name>{NAME})")
OWN_SPEND_RE = re.compile(
    rf"\bhas (?P<at>\d+) stack\(s\) of (?P<name>{NAME}) when casting the skill, then consume all the stacks\b(?P<rest>[^.]*)"
)
OWN_FORCED_RE = re.compile(r"\bforcibly (?:trigger|apply) (?:temporary )?(?P<term>[A-Z]\w+)")
OWN_ABSORB_RE = re.compile(
    r"\bAfter the controlled operator's Final Strike or Finisher hits the enemy, \w+ absorbs (?P<term>[A-Z]\w+ Infliction)\b"
    rf".*?\bEvery stack of (?P=term) absorbed gives \w+ (?P<count>\d+) stacks? of (?P<name>{NAME}) \(max stacks: (?P<max>\d+)\)",
    re.S,
)


def own_stacks(operator: dict) -> dict:
    """Stacks an operator holds on herself, gains from her skills and spends at the cap.

    Laevatain's Melting Flame. Battle skill: «Hitting the enemy grants 1
    stack of Melting Flame. If Laevatain already has 4 stack(s) of Melting
    Flame when casting the skill, then consume all the stacks and perform 1
    additional attack … and forcibly trigger temporary Combustion»; combo:
    «Laevatain gains 1 stack of Melting Flame»; talent: «After the controlled
    operator's Final Strike or Finisher hits the enemy, Laevatain absorbs
    Heat Infliction … Every stack of Heat Infliction absorbed gives Laevatain
    1 stack of Melting Flame (max stacks: 4)».

    * ``gains`` — skills that add stacks, and how many;
    * ``spentBy`` — the skill that spends them all at ``at``; ``applies`` —
      what it forces only then; ``energy`` — its row of Ultimate Energy the
      extra attack restores; its `Additional ATK …` rows count only then
      (``own_stack_rows`` in ``export.py``);
    * ``absorbs`` — the talent: the term it absorbs, from whose strikes, and
      from which Elite. Absorbing is not consuming (`Absorb` in the glossary):
      it does not open «when X is consumed» triggers.
    """
    gains: list[dict] = []
    spend = absorb = None
    for skill in operator.get("skills", []):
        text = re.sub(r"\s+", " ", COMBO_TRIGGER_RE.sub("", skill.get("text", "")))
        for found in OWN_GAIN_RE.finditer(text):
            gains.append({"skill": skill["name"], "name": found["name"], "count": int(found["count"])})
        if found := OWN_SPEND_RE.search(text):
            # «When the additional attack hits the enemy, restore additional Ultimate Energy.»
            energy = next(
                (row["label"] for row in skill.get("stats", [])
                 if row["label"].startswith("Additional ATK") and "Ultimate Energy" in row["label"]),
                None,
            )
            spend = {
                "skill": skill["name"],
                "name": found["name"],
                "at": int(found["at"]),
                "applies": [forced["term"] for forced in OWN_FORCED_RE.finditer(found["rest"])],
                **({"energy": energy} if energy else {}),
            }
    for talent in operator.get("talents", []):
        for level in talent.get("levels", []):
            if found := OWN_ABSORB_RE.search(re.sub(r"\s+", " ", level.get("text", ""))):
                elite = re.match(r"Elite (\d)", level.get("condition") or "")
                absorb = {
                    "talent": talent["name"],
                    "elite": int(elite[1]) if elite else 0,
                    "term": found["term"],
                    "count": int(found["count"]),
                    "name": found["name"],
                    "max": int(found["max"]),
                }
                break
        if absorb:
            break
    if not spend:
        return {}
    name = spend["name"]
    gains = [{"skill": gain["skill"], "count": gain["count"]} for gain in gains if gain["name"] == name]
    if not gains:
        return {}
    entry = {
        "name": name,
        "max": absorb["max"] if absorb and absorb["name"] == name else spend["at"],
        "gains": gains,
        "spentBy": {key: value for key, value in spend.items() if key != "name"},
    }
    if absorb and absorb["name"] == name:
        entry["absorbs"] = {key: absorb[key] for key in ("talent", "elite", "term", "count")}
    return entry


def trigger_thresholds(trigger: str, groups: list[list[str]]) -> dict[str, int]:
    """«3 or more Cryo Infliction stacks» → {"Cryo Infliction": 3}.

    The threshold is attached to the trigger-group term whose name appears in
    the captured tail of the phrase: so "2 or more stacks of Cryo Infliction or
    Nature Infliction" gives the threshold to both.
    """
    out: dict[str, int] = {}
    terms = {term for group in groups for term in group}
    for match in THRESHOLD_RE.finditer(trigger):
        raw = (match["n1"] or match["n2"] or match["n3"]).lower()
        count = WORD_NUMBERS.get(raw) or int(raw)
        tail = trigger[match.start("what"):]
        tail = re.split(r"[.;]| are applied| is applied", tail)[0]
        for term in terms:
            words = term.lower().replace("vulnerable", "vulnerab")
            if words in tail.lower():
                out[term] = count
    return out


def clauses(text: str):
    """Split into clauses: parsing within one phrase lies far less than a
    fixed-width window that jumps over a full stop."""
    for piece in re.split(r"[.;:\n]|\bthen\b|\bbut\b", text):
        piece = piece.strip()
        if piece:
            yield piece


def consumes_term(before: str) -> bool:
    """Whether the verb nearest the term, in the clause before it, is a consuming one.

    «consume all the stacks and perform 1 additional attack … and forcibly
    trigger temporary Combustion» (Laevatain) consumes the stacks and
    triggers Combustion: an earlier verb has another object.
    """
    consume = [found.end() for found in CONSUME.finditer(before)]
    apply = [found.end() for found in APPLY.finditer(before)]
    return bool(consume) and (not apply or consume[-1] > apply[-1])


def relation(text: str, term: str, pattern: re.Pattern | None = None) -> set[str]:
    """How an operator relates to a term: applies it, consumes it, or merely
    mentions it as a condition.

    Parsing goes clause by clause, because a phrase like "forcibly applies
    Nature Burst, if the target's Nature Infliction is consumed" holds both an
    applying verb and a consuming verb, but they refer to DIFFERENT terms.
    """
    found: set[str] = set()
    pattern = pattern or re.compile(rf"\b{re.escape(term)}\b", re.I)

    for clause in clauses(text):
        match = pattern.search(clause)
        if not match:
            continue
        before = clause[: match.start()]
        after = clause[match.end() :]

        # Passive only: "X is consumed" is about consuming X, while the active
        # "X consumes Y" means exactly the opposite — X is the agent there.
        passive = re.match(r"\s*(?:is|are|was|were|being)\s+consum|\s*consumed\b", after, re.I)
        if consumes_term(before) or passive:
            found.add("consumes")
            continue
        # "against enemies with X" is a requirement, not an application.
        # So is a gerund subject: "Applying Physical Status or Vulnerability
        # to the sealed enemy shatters the crystals" — the clause is about
        # what happens WHEN someone applies it, and the skill applies nothing.
        gerund = re.match(r"\s*(?:applying|inflicting)\b", before, re.I)
        if CONDITION.search(before.rstrip()) or (gerund and not APPLY.search(before[gerund.end():])):
            found.add("requires")
            continue
        if APPLY.search(before) or re.match(r"\s*(is|are)?\s*(appl|trigger)", after, re.I):
            found.add("applies")

    if not found:
        found.add("mentions")
    return found


def load_mechanics() -> dict:
    path = DATA / "mechanics.json"
    if not path.exists():
        return {}
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


def merge_mechanic_interactions(index: dict, operators: dict) -> None:
    """Adds curated links from mechanic pages to the index.

    The wiki itself lists who applies a mechanic (the Sources section) and who
    works with it (Interactions). That is more reliable than regexes over skill
    descriptions and catches what they cannot see: e.g. Antal is among Breach's
    sources through doubling a Physical Status, though the word "Breach" does
    not appear in his own description.
    """
    by_name = {record["name"]: key for key, record in operators.items()}
    # A mechanic page may be named by a synonym of the term: in 2026-10 the wiki
    # gained "Vulnerability", while the glossary term is "Vulnerable". Without
    # reducing to the canonical one the vocabulary has two terms, and a combo
    # trigger requires the one nobody applies.
    canonical = {
        alias.lower(): term for term, aliases in load_aliases().items() for alias in aliases
    }

    for page, mechanic in load_mechanics().items():
        term = canonical.get(page.lower(), page)
        rows = (mechanic.get("interactions") or {}).get("operators") or []
        for row in rows:
            key = by_name.get(row.get("operator"))
            if key is None or key not in index:
                continue
            relation_kind = "applies" if row.get("origin") == "source" else "interacts"
            slot = index[key]["capabilities"].setdefault(term, {})
            entries = slot.setdefault(relation_kind, [])
            label = row.get("skill") or "—"
            label = move_for(operators[key], label, term) or label
            if label not in entries:
                entries.append(label)
            slot.setdefault("from_wiki", []).append(label)


def move_for(operator: dict, label: str, term: str) -> str | None:
    """The move a wiki row really means: the term is in its paragraph, not the host's own text."""
    skill = next((item for item in operator.get("skills", []) if item["name"] == label), None)
    if skill is None:
        return None
    own, moves = split_moves(operator, skill)
    pattern = re.compile(rf"\b{re.escape(term)}\b", re.I)
    if pattern.search(own):
        return None
    return next((name for name, text in moves if pattern.search(text)), None)


# Glossary terms that describe an ACTION or a property of the calculation
# rather than a state that can be applied to the target. In condition checks
# they produce nonsense: "who applied Debuff Consumption earlier" has no
# answer, because it is not a debuff but the very fact of consuming one.
NOT_APPLICABLE = {
    "Debuff Consumption", "Absorb", "DMG Type", "DMG Over Time", "Status Level",
    "SP Return", "Final Strike", "Stagger Node", "Physical Resistance",
    "Arts Resistance",
}


def vocabulary_terms() -> list[str]:
    """The mechanic vocabulary = the whole glossary plus explicit groups.

    Hard-coded lists were not enough: lacking "Originium Crystal" and
    "SP Return", the checks considered conditions unmeetable that the operator
    actually meets. The glossary is complete and updates with the wiki.
    """
    explicit = INFLICTIONS + BURSTS + REACTIONS + PHYSICAL + AMPS + SUSCEPT + SUPPORT + OWN
    path = DATA / "glossary.json"
    if path.exists():
        with path.open(encoding="utf-8") as handle:
            explicit = explicit + list(json.load(handle))
    seen, out = set(), []
    for term in explicit:
        if term in NOT_APPLICABLE:
            continue
        if term.lower() not in seen:
            seen.add(term.lower())
            out.append(term)
    return out


def build_index(operators: dict) -> dict:
    index: dict[str, dict] = {}
    vocabulary = vocabulary_terms()
    aliases = load_aliases()
    patterns = {term: term_pattern(term, aliases) for term in vocabulary}

    for key, operator in operators.items():
        if operator.get("upcoming"):
            continue
        capabilities: dict[str, dict[str, list]] = {}
        for kind, name, text, terms in iter_texts(operator):
            if not text:
                continue
            for term in vocabulary:
                # A term counts if it is either marked up as a glossary link
                # or named explicitly in the text.
                if term not in terms and not patterns[term].search(text):
                    continue
                for kind_of in relation(text, term, patterns[term]):
                    slot = capabilities.setdefault(term, {})
                    slot.setdefault(kind_of, [])
                    if name not in slot[kind_of]:
                        slot[kind_of].append(name)
        index[key] = {
            "name": operator["name"],
            "element": operator.get("element"),
            "class": operator.get("class"),
            "rarity": operator.get("rarity"),
            "capabilities": capabilities,
        }

    merge_mechanic_interactions(index, operators)
    return index


def summarise(entry: dict) -> dict:
    """A short summary: what it applies, what it consumes, how it buffs."""
    applies, consumes, buffs = [], [], []
    for term, relations in entry["capabilities"].items():
        if "applies" in relations:
            if term in INFLICTIONS + REACTIONS + BURSTS + PHYSICAL:
                applies.append(term)
            elif term in AMPS + SUSCEPT + SUPPORT:
                buffs.append(term)
        if "consumes" in relations:
            consumes.append(term)
    return {
        "applies": sorted(applies),
        "consumes": sorted(consumes),
        "buffs": sorted(buffs),
    }


def cmd_index(args) -> int:
    operators = load_operators()
    index = build_index(operators)
    mine = set(owned(strict=False))

    keys = sorted(index) if args.all else sorted(k for k in index if k in mine)
    print(f"{'operator':17}{'element':9}{'class':11}applies / buffs")
    print("-" * 100)
    for key in keys:
        entry = index[key]
        summary = summarise(entry)
        mark = "" if key in mine else "*"
        line = ", ".join(summary["applies"]) or "—"
        buffs = ", ".join(summary["buffs"])
        print(f"{entry['name']+mark:17}{str(entry['element']):9}{str(entry['class']):11}{line}")
        if buffs:
            print(f"{'':37}buffs: {buffs}")
    if args.all:
        print("\n* — not in the roster")
    return 0


def cmd_who(args) -> int:
    operators = load_operators()
    index = build_index(operators)
    mine = set(owned(strict=False))
    needle = args.term.lower()

    print(f"Who works with «{args.term}»:\n")
    for relation_kind in ("applies", "consumes"):
        rows = []
        for key, entry in sorted(index.items()):
            for term, relations in entry["capabilities"].items():
                if needle not in term.lower():
                    continue
                if relation_kind in relations:
                    mark = "" if key in mine else "  (not in the roster)"
                    rows.append(
                        f"  {entry['name']:16} {str(entry['element']):9} "
                        f"{term:24} via: {', '.join(relations[relation_kind])}{mark}"
                    )
        if rows:
            title = "APPLIES" if relation_kind == "applies" else "CONSUMES"
            print(f"{title}:")
            print("\n".join(rows))
            print()
    return 0


def cmd_fit(args) -> int:
    operators = load_operators()
    index = build_index(operators)
    mine = owned(strict=False)

    key = args.operator
    if key not in index:
        matches = [k for k in index if args.operator.lower() in k.lower()]
        if len(matches) != 1:
            print(f"Could not tell who that is: {args.operator}. Similar: {matches or 'none'}")
            return 1
        key = matches[0]

    entry = index[key]
    summary = summarise(entry)
    print(f"=== {entry['name']}: {entry['rarity']}★ {entry['class']} / {entry['element']}\n")
    print(f"applies:     {', '.join(summary['applies']) or '—'}")
    print(f"consumes:    {', '.join(summary['consumes']) or '—'}")
    print(f"buffs:       {', '.join(summary['buffs']) or '—'}\n")

    # What the operator feeds on — what it consumes, someone must apply.
    needs = sorted(
        {t for t in summary["consumes"] if t in INFLICTIONS + PHYSICAL}
        | {
            t
            for t, rel in entry["capabilities"].items()
            if "requires" in rel and t in INFLICTIONS + PHYSICAL
        }
    )
    if needs:
        print("FEEDS ON (needs an external source):")
        for term in needs:
            suppliers = [
                index[k]["name"]
                for k in mine
                if k in index and k != key
                and "applies" in index[k]["capabilities"].get(term, {})
            ]
            status = ", ".join(suppliers) if suppliers else "NOBODY IN THE ROSTER"
            print(f"  {term:24} ← {status}")
        print()

    # The other side: who benefits from what it applies itself.
    gives = summary["applies"]
    if gives:
        print("WHO BENEFITS FROM WHAT IT APPLIES:")
        for term in gives:
            consumers = [
                index[k]["name"]
                for k in mine
                if k in index and k != key
                and "consumes" in index[k]["capabilities"].get(term, {})
            ]
            if consumers:
                print(f"  {term:24} → {', '.join(consumers)}")
        print()
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    p_index = sub.add_parser("index", help="ability table")
    p_index.add_argument("--all", action="store_true", help="including those not in the roster")
    p_index.set_defaults(func=cmd_index)

    p_who = sub.add_parser("who", help="who works with a term")
    p_who.add_argument("term")
    p_who.set_defaults(func=cmd_who)

    p_fit = sub.add_parser("fit", help="how an operator fits the roster")
    p_fit.add_argument("operator")
    p_fit.set_defaults(func=cmd_fit)

    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
