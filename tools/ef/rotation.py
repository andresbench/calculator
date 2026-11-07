#!/usr/bin/env python3
"""Rotation notation: parsing and checking.

An Endfield rotation cannot be written as a plain list of actions, because
combo skills are not cast at will — each has its own trigger, and someone
earlier in the chain must provide it. So the notation here is not decorative:
the parser checks every step against the wiki data and says what enables it.

FORMAT
------

    # comment
    team: Chen Qianyu, Camille, Rossi, Mi Fu
    Chen Qianyu: BS > CS
    Camille: BS
    Rossi: CS1 > CS2
    Camille: CS
    Mi Fu: CS > BS1 > BS2

Actions:

    BA      basic attack             BA5   fifth sequence
    FS      Final Strike             FIN   finisher on a Staggered enemy
    BS      battle skill             BS2   second stage of a multi-stage one
    CS      combo skill              CS2   second combo sequence
    ULT     ultimate                 DIVE  plunging attack

Modifiers:

    ~       optional step
    ?       questionable step, check by hand
    [text]  a note on the step

Names are resolved through ``roster/aliases.yaml``, so short and localised
names work too.

Commands::

    python3 tools/ef/rotation.py check rotations/archive/physical-core.rot
    python3 tools/ef/rotation.py parse "Chen Qianyu: BS > CS > Camille: BS"
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

import yaml

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from tools.ef.roster import owned
from tools.ef.synergy import (
    INFLICTIONS,
    PHYSICAL,
    REACTIONS,
    build_index,
    load_aliases as load_term_aliases,
    load_operators,
    term_pattern,
)

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "data" / "endfield"
ALIASES = ROOT / "roster" / "aliases.yaml"

ACTIONS = {
    "BA": "Basic Attack",
    "FS": "Basic Attack",     # Final Strike — the basic attack's last sequence
    "FIN": "Basic Attack",    # finisher on a Staggered enemy
    "DIVE": "Basic Attack",
    "BS": "Battle Skill",
    "CS": "Combo Skill",
    "ULT": "Ultimate",
    # Fillers: no skill, they only take time (a perfect dodge, a pause).
    "DODGE": None,
    "WAIT": None,
}

ACTION_RE = re.compile(r"^(BA|FS|FIN|DIVE|BS|CS|ULT|DODGE)(\d+)?([~?]*)$", re.I)
# "WAIT 2.5s": glued into one token before the chunk is split on spaces.
WAIT_RE = re.compile(r"^WAIT(\d+(?:\.\d+)?)s?([~?]*)$", re.I)


def normalise(name: str) -> str:
    return re.sub(r"[\s_'-]+", "", name).lower()


def load_aliases() -> dict[str, str]:
    """{normalised alias: canonical name}."""
    mapping: dict[str, str] = {}
    operators = load_operators()
    for key, record in operators.items():
        mapping[normalise(key)] = key
        mapping[normalise(record["name"])] = key

    if ALIASES.exists():
        with ALIASES.open(encoding="utf-8") as handle:
            declared = yaml.safe_load(handle) or {}
        for canonical, names in declared.items():
            target = canonical if canonical in operators else None
            if target is None:
                # A name from the alias file may differ from the data key
                # (e.g. Endministrator is stored with the gender).
                for key in operators:
                    if normalise(operators[key]["name"]) == normalise(canonical):
                        target = key
                        break
            if target is None:
                continue
            for alias in names or []:
                mapping[normalise(alias)] = target
    return mapping


# ------------------------------------------------------------------ parsing


def parse_line(line: str, aliases: dict[str, str], step_no: int) -> list[dict]:
    """"Chen Qianyu: BS > CS" → a list of steps."""
    steps: list[dict] = []
    actor = None

    # The actor may change within a line: "Rossi: CS1 > Camille: CS".
    for chunk in line.split(">"):
        chunk = chunk.strip()
        if not chunk:
            continue

        note = None
        note_match = re.search(r"\[(.+?)\]", chunk)
        if note_match:
            note = note_match.group(1).strip()
            chunk = chunk[: note_match.start()] + chunk[note_match.end() :]
            chunk = chunk.strip()

        if ":" in chunk:
            name, _, rest = chunk.partition(":")
            resolved = aliases.get(normalise(name))
            if resolved is None:
                steps.append({"error": f"unknown operator: {name.strip()!r}"})
                continue
            actor = resolved
            chunk = rest.strip()
            if not chunk:
                continue

        chunk = re.sub(r"\bWAIT\s+(\d)", r"WAIT\1", chunk, flags=re.I)
        for token in re.split(r"[,\s]+", chunk):
            if not token:
                continue
            pause = WAIT_RE.match(token)
            if pause and actor is not None:
                step_no += 1
                steps.append(
                    {
                        "n": step_no,
                        "actor": actor,
                        "action": "WAIT",
                        "skill_type": None,
                        "sequence": None,
                        "seconds": float(pause[1]),
                        "optional": "~" in pause[2],
                        "uncertain": "?" in pause[2],
                        "note": note,
                    }
                )
                continue
            match = ACTION_RE.match(token)
            if not match:
                steps.append({"error": f"unclear action: {token!r}"})
                continue
            if actor is None:
                steps.append({"error": f"action {token!r} without an operator"})
                continue
            verb, index, flags = match.groups()
            step_no += 1
            steps.append(
                {
                    "n": step_no,
                    "actor": actor,
                    "action": verb.upper(),
                    "skill_type": ACTIONS[verb.upper()],
                    "sequence": int(index) if index else None,
                    "optional": "~" in (flags or ""),
                    "uncertain": "?" in (flags or ""),
                    "note": note,
                }
            )
    return steps


def parse(text: str) -> dict:
    aliases = load_aliases()
    rotation = {"team": [], "steps": [], "errors": [], "title": None}
    step_no = 0
    # A variant is an alternative way to play the same team; a cycle is a
    # repeat of the rotation in which the target state carries over from the
    # previous pass.
    variant = None
    cycle = 1

    for raw in text.splitlines():
        line = raw.split("#")[0].strip()
        if not line:
            continue
        if line.lower().startswith("team:"):
            for name in line.split(":", 1)[1].split(","):
                name = name.strip()
                if not name:
                    continue
                if name == "-":
                    # An empty slot: the ones after it keep their numbers.
                    rotation["team"].append(None)
                    continue
                resolved = aliases.get(normalise(name))
                if resolved:
                    rotation["team"].append(resolved)
                else:
                    rotation["errors"].append(f"unknown operator in the team: {name!r}")
            continue
        if line.lower().startswith("priority:"):
            # Combo priority from the game settings; the engine checks it.
            for name in line.split(":", 1)[1].split(","):
                name = name.strip()
                if not name:
                    continue
                resolved = aliases.get(normalise(name))
                if resolved:
                    rotation.setdefault("priority", []).append(resolved)
                else:
                    rotation["errors"].append(f"unknown operator in the priority: {name!r}")
            continue
        if line.lower().startswith("controlled:"):
            # Who is controlled before the first step; the engine uses it.
            name = line.split(":", 1)[1].strip()
            resolved = aliases.get(normalise(name))
            if resolved:
                rotation["controlled"] = resolved
            else:
                rotation["errors"].append(f"unknown operator in controlled: {name!r}")
            continue
        if line.lower().startswith("ultimates:"):
            rotation["ultimates_charged"] = line.split(":", 1)[1].strip().lower() == "charged"
            continue
        if line.lower().startswith("sp:"):
            # `sp: unlimited` — a rotation sketched in a vacuum; the engine reads it.
            rotation["unlimited_sp"] = line.split(":", 1)[1].strip().lower() == "unlimited"
            continue
        if line.lower().startswith("title:"):
            rotation["title"] = line.split(":", 1)[1].strip()
            continue
        if line.lower().startswith("variant:"):
            variant = line.split(":", 1)[1].strip() or None
            cycle = 1
            continue
        match_cycle = re.match(r"(?:cycle|цикл)\s*(\d+)?\s*:$", line, re.I)
        if match_cycle:
            cycle = int(match_cycle.group(1) or (cycle + 1))
            continue

        for step in parse_line(line, aliases, step_no):
            if "error" in step:
                rotation["errors"].append(step["error"])
            else:
                step["variant"] = variant
                step["cycle"] = cycle
                rotation["steps"].append(step)
                step_no = step["n"]

    return rotation


# ----------------------------------------------------------------- checking

TRIGGER_RE = re.compile(r"COMBO TRIGGER:\s*(.+?)(?:SKILL DESCRIPTION:|$)", re.S | re.I)

# "Applies Vulnerable on an enemy" in Lift's description means that applying
# Lift also applies Vulnerable. Such consequences are derived from the glossary
# rather than written by hand: the wiki's list of statuses changes.
IMPLIES_RE = re.compile(r"\bappl(?:y|ies)\b\s+(?:1 stack of\s+)?([A-Z][\w ]{2,28}?)\b", re.I)


def load_implications() -> dict[str, set[str]]:
    """{term: what it applies next}.

    Gives two kinds of links:
    * a consequence — Lift/Knock Down/Crush/Breach apply Vulnerable;
    * a generic one — Heat Infliction is a special case of Arts Infliction,
      so a trigger "requires Arts Infliction" is met by any element; likewise
      Solidification meets "Arts Reaction" (Alesh's combo trigger).
    """
    path = DATA / "glossary.json"
    implications: dict[str, set[str]] = {}
    if not path.exists():
        return implications

    with path.open(encoding="utf-8") as handle:
        glossary = json.load(handle)

    known = set(glossary)
    for term, entry in glossary.items():
        for match in IMPLIES_RE.finditer(entry.get("description", "")):
            candidate = match.group(1).strip()
            for name in known:
                if name.lower() == candidate.lower() and name != term:
                    implications.setdefault(term, set()).add(name)

    # Generic terms: a specific element meets an umbrella requirement.
    for term in INFLICTIONS:
        if term != "Arts Infliction" and "Arts Infliction" in known:
            implications.setdefault(term, set()).add("Arts Infliction")
    for term in PHYSICAL:
        if term != "Physical Status" and "Physical Status" in known:
            implications.setdefault(term, set()).add("Physical Status")
    for term in REACTIONS:
        if term != "Arts Reaction" and "Arts Reaction" in known:
            implications.setdefault(term, set()).add("Arts Reaction")

    return implications


# An "X consumed" trigger is an event, not a state: the combo is opened by the
# moment the stacks were eaten, not by their being up. Mixed wordings
# ("consumed or is applied", "suffers … or after … consumed") do not count as
# events: mere presence opens them too.
CONSUMED_RE = re.compile(r"\b(?:consum|absorb)\w*", re.I)
PRESENCE_RE = re.compile(r"\b(?:appl\w*|suffers|has|have)\b", re.I)


def consumed_trigger(text: str) -> bool:
    return bool(CONSUMED_RE.search(text)) and not PRESENCE_RE.search(text)


def consumed_too(text: str) -> bool:
    """«suffers Electrification or after an enemy's Electrification is
    consumed»: presence opens it, and so does the consumption, later."""
    return bool(CONSUMED_RE.search(text)) and bool(PRESENCE_RE.search(text))


# "When the controlled operator performs a Final Strike on an enemy with …":
# the terms are only the condition; the event is the Final Strike. Without
# this the combo opens the moment the terms are up, Final Strike or not.
STRIKE_RE = re.compile(r"\bFinal Strike\b(?:\s+or\s+(Finisher)\b)?", re.I)
# "When another operator in the team deals DMG with combo skills" — the
# Endministrator's combo answers someone else's.
OTHER_COMBO_RE = re.compile(r"\banother operator\b[^.]*\bcombo skills?\b", re.I)
# "When an enemy becomes Staggered or hits a Stagger Node" (Akekuri).
STAGGER_RE = re.compile(r"\bbecomes Staggered\b|\bStagger Node\b", re.I)


def stance_condition(text: str) -> str | None:
    """«While Vocalist Stance is active, …» → "Vocalist Stance": the caster's
    own state, a condition on top of whatever the rest of the trigger asks."""
    match = re.match(r"While ([A-Z]\w+ Stance) is active\b", text)
    return match[1] if match else None


def own_resource(text: str, name: str) -> str | None:
    """"When Typhoeus reaches max Signs": the operator's own counter, not a
    stack on the target. The engine does not keep it, so the trigger must not
    be checked against the target, where it is never found."""
    match = re.search(rf"\bWhen {re.escape(name)} reaches max (\w[\w ]*?)s?\b\.?$", text, re.I)
    return match[1] if match else None


def strike_trigger(text: str) -> str | None:
    """The action that opens a combo: `FS`, `FS|FIN` for "Final Strike or
    Finisher", `CS` for another operator's combo skill, `STG` for the target
    getting Staggered or reaching a Stagger Node; None if none."""
    match = STRIKE_RE.search(text)
    if match:
        return "FS|FIN" if match[1] else "FS"
    if OTHER_COMBO_RE.search(text):
        return "CS"
    if STAGGER_RE.search(text):
        return "STG"
    return None


def combo_trigger(skill: dict) -> str | None:
    match = TRIGGER_RE.search(skill.get("text", ""))
    return " ".join(match.group(1).split()) if match else None


def sequence_count(skill: dict) -> int | None:
    """How many stages a skill has: "MOVE 3 - …" or "COMBO SEQUENCE 2"."""
    text = skill.get("text", "")
    numbers = [int(n) for n in re.findall(r"\bMOVE\s+(\d+)", text, re.I)]
    numbers += [int(n) for n in re.findall(r"\bCOMBO SEQUENCE\s+(\d+)", text, re.I)]
    numbers += [int(n) for n in re.findall(r"has (\d+) consecutive sequences", text, re.I)]
    return max(numbers) if numbers else None


def find_skill(operator: dict, skill_type: str, variant: str | None = None):
    for skill in operator.get("skills", []):
        if skill.get("type") != skill_type:
            continue
        if variant and skill.get("variant") != variant:
            continue
        return skill
    return None


# "On an enemy with no stacks of Vulnerability or Arts Infliction": the terms
# after the negation must be ABSENT. Read as requirements, they ask for the
# very thing that closes the combo (Ardelia).
NEGATION_RE = re.compile(r"\b(?:with\s+no|without|no\s+stacks?\s+of)\b[^.;]*", re.I)


def negated(trigger: str, position: int) -> bool:
    return any(m.start() <= position < m.end() for m in NEGATION_RE.finditer(trigger))


def term_hits(trigger: str, vocabulary, aliases: dict) -> list[tuple[int, int, str]]:
    """Vocabulary terms in the trigger, in order, without nested matches."""
    hits: list[tuple[int, int, str]] = []
    for term in vocabulary:
        for match in term_pattern(term, aliases).finditer(trigger):
            hits.append((match.start(), match.end(), term))
    hits.sort()
    # Drop nested matches: "Arts Infliction" inside a longer term.
    filtered: list[tuple[int, int, str]] = []
    for start, end, term in hits:
        if filtered and start < filtered[-1][1]:
            if end - start > filtered[-1][1] - filtered[-1][0]:
                filtered[-1] = (start, end, term)
            continue
        filtered.append((start, end, term))
    return filtered


def absent_terms(trigger: str, vocabulary, aliases: dict) -> list[str]:
    """Terms the trigger requires NOT to be on the target."""
    return [term for start, _, term in term_hits(trigger, vocabulary, aliases) if negated(trigger, start)]


def requirement_groups(
    trigger: str, vocabulary, aliases: dict
) -> list[list[str]]:
    """Trigger terms grouped by "or".

    "When Crush or Breach consumes…" is an ALTERNATIVE, one is enough, while
    "has both Vulnerability and Arts Infliction" is a conjunction, both are
    needed. Without this distinction the validator complains about perfectly
    working rotations.
    """
    filtered = [hit for hit in term_hits(trigger, vocabulary, aliases) if not negated(trigger, hit[0])]
    if not filtered:
        return []

    groups: list[list[str]] = [[filtered[0][2]]]
    for previous, current in zip(filtered, filtered[1:]):
        between = trigger[previous[1] : current[0]]
        # Alternatives are not always adjacent: "Physical Susceptibility,
        # is Staggered, or has attached Originium Crystals" is an "or" too.
        # So a few words between terms are allowed if there is an "or" there.
        joined_by_or = bool(re.search(r"\bor\b|\bили\b", between, re.I)) and len(between) < 45
        if re.fullmatch(r"[\s,]*(?:or|или)[\s,]*", between, re.I) or joined_by_or:
            # "Electrification or after … Electrification is consumed" names it twice.
            if current[2] not in groups[-1]:
                groups[-1].append(current[2])
        else:
            groups.append([current[2]])
    return groups


def check(rotation: dict) -> list[dict]:
    """For each step: does the skill exist, and what provides its trigger."""
    operators = load_operators()
    index = build_index(operators)
    mine = set(owned(strict=False))
    findings: list[dict] = []

    implications = load_implications()
    term_aliases = load_term_aliases()

    # What has been applied to the target so far — accumulated as we go.
    # Reset on a variant change (a different way to play) but NOT on a cycle
    # change: the point of a second cycle is that the first one's debuffs are
    # still on the target.
    provided: dict[str, int] = {}
    current_variant = ...

    def record(term: str, step_no: int, seen: set | None = None) -> None:
        """Mark the term and everything that follows from it."""
        seen = seen or set()
        if term in seen:
            return
        seen.add(term)
        provided.setdefault(term, step_no)
        for implied in implications.get(term, ()):
            record(implied, step_no, seen)

    for step in rotation["steps"]:
        if step.get("variant") != current_variant:
            current_variant = step.get("variant")
            provided = {}
        operator = operators[step["actor"]]
        if step["skill_type"] is None:
            # A dodge or a pause: nothing to check, it only takes time.
            findings.append({"step": step, "skill": None, "issues": [], "satisfied_by": []})
            continue
        skill = find_skill(operator, step["skill_type"])
        result = {"step": step, "skill": skill, "issues": [], "satisfied_by": []}

        if step["actor"] not in mine:
            result["issues"].append("operator not in the roster")
        if skill is None:
            result["issues"].append(
                f"{operator['name']} has no skill of type «{step['skill_type']}»"
            )
            findings.append(result)
            continue

        total = sequence_count(skill)
        if step["sequence"] and total and step["sequence"] > total:
            result["issues"].append(
                f"stage {step['sequence']}, but the skill has {total}"
            )
        if step["sequence"] and not total and step["sequence"] > 1:
            result["issues"].append(
                f"stage {step['sequence']} given, but the skill has a single stage"
            )

        if step["skill_type"] == "Combo Skill":
            trigger = combo_trigger(skill)
            result["trigger"] = trigger
            if trigger:
                # Search the whole vocabulary, synonyms included: triggers
                # say "Vulnerability" though the term is "Vulnerable".
                vocabulary = {t for e in index.values() for t in e["capabilities"]}
                groups = requirement_groups(trigger, vocabulary, term_aliases)
                result["requires"] = groups
                for group in groups:
                    satisfied = [(t, provided[t]) for t in group if t in provided]
                    if satisfied:
                        result["satisfied_by"].extend(satisfied)
                    else:
                        names = " or ".join(f"«{t}»" for t in group)
                        result["issues"].append(
                            f"the trigger needs {names}, but nobody applied it earlier"
                        )

        # Everything this step applies becomes available afterwards —
        # together with its consequences (Lift drags Vulnerable along).
        for term, relations in index[step["actor"]]["capabilities"].items():
            if "applies" in relations and skill["name"] in relations["applies"]:
                record(term, step["n"])

        findings.append(result)

    return findings


def cmd_check(args) -> int:
    text = Path(args.file).read_text(encoding="utf-8")
    rotation = parse(text)
    operators = load_operators()

    if rotation["title"]:
        print(f"=== {rotation['title']}")
    if rotation["team"]:
        print("Team: " + ", ".join(operators[k]["name"] if k else "-" for k in rotation["team"]))
    print()

    for error in rotation["errors"]:
        print(f"  PARSE ERROR: {error}")
    if rotation["errors"]:
        print()

    findings = check(rotation)
    problems = 0
    shown_variant, shown_cycle = ..., ...
    for result in findings:
        step = result["step"]
        if step.get("variant") != shown_variant:
            shown_variant = step.get("variant")
            shown_cycle = ...
            if shown_variant:
                print(f"\n── variant: {shown_variant}")
        if step.get("cycle") != shown_cycle:
            shown_cycle = step.get("cycle")
            if shown_cycle and shown_cycle > 1:
                print(f"   ┌ cycle {shown_cycle} (debuffs from the previous cycle are still up)")
        skill = result["skill"]
        name = operators[step["actor"]]["name"]
        label = step["action"] + (str(step["sequence"]) if step["sequence"] else "")
        title = skill["name"] if skill else "?"
        flags = " ~optional" if step["optional"] else ""
        print(f"  {step['n']:2}. {name:14} {label:5} {title}{flags}")
        if result.get("trigger"):
            print(f"      trigger: {result['trigger'][:110]}")
        for term, source in result["satisfied_by"]:
            print(f"      ✓ «{term}» provided by step {source}")
        for issue in result["issues"]:
            problems += 1
            print(f"      ⚠ {issue}")
        if step.get("note"):
            print(f"      · {step['note']}")

    print(f"\nsteps: {len(findings)}, issues: {problems}")
    return 0


def cmd_parse(args) -> int:
    rotation = parse(args.text)
    print(json.dumps(rotation, ensure_ascii=False, indent=1))
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)

    p_check = sub.add_parser("check", help="parse and check a rotation file")
    p_check.add_argument("file")
    p_check.set_defaults(func=cmd_check)

    p_parse = sub.add_parser("parse", help="parse a line, print JSON")
    p_parse.add_argument("text")
    p_parse.set_defaults(func=cmd_parse)

    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
