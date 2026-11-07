#!/usr/bin/env python3
"""Skill frames from the datamine: when a hit lands, when a buff applies, when the next action may start.

The source is ``Json/SkillData`` from the ``tools/ef/sync.py`` clone. Every
skill has a timeline of actions with start and end frames. The rate is 30
frames per second: ``durationFrame`` divided by the length of the
``PlayAnimation*`` clip gives exactly 30 for every skill that has a clip.

What is read and how it is interpreted:

* ``AllowNextSkillAction`` — from this frame on, moving to the skills in
  ``allowedSkillIdList`` is allowed. For basic attacks that is the chain's
  next hit, and for the last one the first again: the chain is closed.
* ``DamageAction`` / ``LaunchProjectile`` — the frame of a hit or a shot. A
  projectile keeps flying, so it lands later than the shot frame.
* ``CreateBuffAction`` — the frame a buff is applied on.
* ``HitStopAction`` — the freeze on impact. ``affectType`` 2 freezes the
  attacker too, and everything after the hit in its timeline comes that much
  later: Lifeng's Knock Down, frame 54, landed 2.05 s after the cast —
  54/30 + 2 × 0.1 s (measurements, #63); the Endministrator's basic chain on
  an enemy is 0.06 s longer per hit stop of 0.06 (#68b). ``affectType`` 1
  freezes only the target: Lifeng's combo, 1.333 s, does not move his second
  hit (#68a). 0 is not measured and is left out. The stop sits under the
  hit's ``IfElse`` branches, sometimes in both, so one moment of the timeline
  takes the longest stop found in it, not the sum.
* ``TimeDilationAction`` with the ``ComboSkill`` curve, frame 0 of every
  combo — the world slows for everyone but the caster: another operator's
  chain and natural SP regen stand still for its ``duration`` (#64), and a
  later combo stops an earlier one (#66).
* ``ObtainCostAction`` — the hit that restores SP. On the chain's last
  segment it is the Final Strike hit that opens combos (#68c): Lifeng's
  second, not his first.

The reading of ``AllowNextSkillAction`` is not taken from the field's name but
checked against the measured basic attack table: the chain's cycle length is

    Σ over hits (AllowNextSkillAction frame + 1) / 30 s

within 0.3 frames for 18 of 25 operators with a closed chain. The extra frame
per transition is an observation, not a known mechanism. Mismatches for the
rest are printed by ``--verify``; their chains are built differently (special
branches, two transition windows, hit variants), and that is an open
question — measurements, #35 — not a reason to fit the model.

Usage::

    python3 tools/ef/frames.py "Chen Qianyu"   # an operator's BA/BS/CS/ULT frames
    python3 tools/ef/frames.py --verify        # BA cycle against the measured table
    python3 tools/ef/frames.py --export        # → data/endfield/basic_attacks.json
    python3 tools/ef/frames.py --hits          # wiki damage rows against client hits
"""

from __future__ import annotations

import argparse
import csv
import json
import sys
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "data" / "endfield"
SKILLS = DATA / "upstream" / "endfield-data" / "Json" / "SkillData"
BASIC_CSV = ROOT / "Endfield" / "Endfield Basic Attack Data - Damage and Stagger.csv"
SKILL_PATCH = DATA / "upstream" / "endfield-data" / "TableCfg" / "SkillPatchTable.json"
UPSTREAM_PIN = DATA / "upstream.json"
BASIC_ATTACKS = DATA / "basic_attacks.json"

FPS = 30

# Cycle check: the measurement is recorded in seconds to three decimals, so its
# step is finer than a frame. A mismatch above a frame is no longer rounding.
TOLERANCE_FRAMES = 1.5

# Table rows whose name does not match the operators.json key.
CSV_ALIASES = {"Endministrator": "Endministrator (male)"}

# Skill file suffixes → .rot notation.
KINDS = {"normal_skill": "BS", "combo_skill": "CS", "ultimate_skill": "ULT"}

HIT_ACTIONS = ("DamageAction", "LaunchProjectile")

# ``HitStopAction.affectType`` that freezes the attacker as well as the target
# (measurements, #68).
STOPS_ATTACKER = 2

# A dive: from leaving the ground to the hit on landing, pressing the
# attack at once. The client's ``plunging_attack_start`` is a loop that ends
# on landing, so its length is not in the frames. Measured on Chen, three
# jumps: 0.50, 0.53, 0.53 s (measurements, #21); the jump is the same height
# for everyone, so it is taken for all.
DIVE_FALL = 0.52

# The world slowdown every combo starts with (measurements, #64).
DILATION_CURVE = "ComboSkill"


def _short(type_name: str) -> str:
    """``Beyond.Gameplay.Core.AllowNextSkillAction+Data, Gameplay.Beyond`` → ``AllowNextSkillAction``."""
    return type_name.split(",")[0].split(".")[-1].split("+")[0]


def _stop(seq: object) -> float:
    """Seconds one timeline entry freezes its own attacker: the longest
    ``affectType`` 2 hit stop in it, 0 if none (see the module notes)."""
    return max(
        (
            action.get("duration") or 0.0
            for action in _actions(seq)
            if _short(action.get("$type", "")) == "HitStopAction" and action.get("affectType") == STOPS_ATTACKER
        ),
        default=0.0,
    )


def _actions(seq: object) -> list[dict]:
    """Every action of a sequence, including nested IfElse branches and the like."""
    out: list[dict] = []
    if not isinstance(seq, dict):
        return out
    for action in seq.get("actionData") or []:
        out.append(action)
        for value in action.values():
            if isinstance(value, dict) and "actionData" in value:
                out.extend(_actions(value))
    return out


@dataclass
class Skill:
    id: str
    duration: int
    exclusive: int
    # (frame, where the transition is allowed to)
    allow_next: list[tuple[int, list[str]]] = field(default_factory=list)
    hits: list[int] = field(default_factory=list)
    buffs: list[tuple[int, list[str]]] = field(default_factory=list)
    hit_stop: list[tuple[int, int]] = field(default_factory=list)
    # (frame, seconds) the attacker stands frozen from this frame (``_stop``).
    stops: list[tuple[int, float]] = field(default_factory=list)
    # Frames of hits that restore SP (``ObtainCostAction``).
    sp_hits: list[int] = field(default_factory=list)
    # A combo's world slowdown, seconds (``TimeDilationAction``, ``ComboSkill``).
    dilation: float | None = None
    clip_seconds: float | None = None
    # ``skillSpecification``: what kind of skill the client counts the move
    # as (``SPECIFICATIONS``) — and so which DMG bonus it takes.
    specification: int = 0
    # The ultimate's cutscene: last frame of ``UltimateTimeAction`` and of
    # ``HideUIAction`` (measurements, #35 — another operator may act after it).
    ultimate_time: int | None = None
    hide_ui: int | None = None

    def stopped_before(self, frame: int) -> float:
        """Seconds of the attacker's own hit stop at frames up to ``frame``."""
        return sum(seconds for start, seconds in self.stops if start <= frame)

    def at(self, frame: int) -> float:
        """Seconds from the skill's start to ``frame``, its own hit stops included."""
        return frame / FPS + self.stopped_before(frame - 1)

    def next_into(self, prefix: str) -> tuple[int, str] | None:
        """The first transition into a skill with this prefix: ``(frame, id)``."""
        for frame, targets in self.allow_next:
            for target in targets:
                if target.startswith(prefix):
                    return frame, target
        return None

    def next_in_chain(self) -> tuple[int, str] | None:
        """The basic attack chain's transition: to the nearest next ``attackN``, else to ``attack1``.

        The first transition found will not do: Yvonne's ``attack1`` allows
        ``attack5`` from frame zero — a special branch, not a chain step. And
        "strictly K+1" will not do either: Lifeng's ``attack3`` is followed by
        ``attack5``.
        """
        base, _, number = self.id.rpartition("_attack")
        if not number.isdigit():
            return None
        ahead: list[tuple[int, int, str]] = []
        for frame, targets in self.allow_next:
            for target in targets:
                tail = target.removeprefix(f"{base}_attack")
                if tail != target and tail.isdigit() and int(tail) > int(number):
                    ahead.append((int(tail), frame, target))
        if ahead:
            _, frame, target = min(ahead)
            return frame, target
        return self.next_into(f"{base}_attack1")


def load_skill(skill_id: str) -> Skill | None:
    path = SKILLS / f"{skill_id}.json"
    if not path.exists():
        return None
    data = json.loads(path.read_text(encoding="utf-8"))
    skill = Skill(skill_id, data["durationFrame"], data["exclusiveFrame"], specification=data.get("skillSpecification") or 0)
    for entry in data["actionGroupData"]["timelineActions"]:
        start, end = entry["_startFrame"], entry["_endFrame"]
        if (stop := _stop(entry.get("_sequenceActionData"))) > 0:
            skill.stops.append((start, stop))
        kinds = {_short(a.get("$type", "")) for a in _actions(entry.get("_sequenceActionData"))}
        if "ObtainCostAction" in kinds and kinds & set(HIT_ACTIONS):
            skill.sp_hits.append(start)
        for action in _actions(entry.get("_sequenceActionData")):
            kind = _short(action.get("$type", ""))
            if kind == "AllowNextSkillAction":
                skill.allow_next.append((start, list(action.get("allowedSkillIdList") or [])))
            elif kind in HIT_ACTIONS:
                skill.hits.append(start)
            elif kind == "CreateBuffAction":
                ids = [b.get("buffId") for b in action.get("buffs") or [] if b.get("buffId")]
                skill.buffs.append((start, ids))
            elif kind == "HitStopAction":
                skill.hit_stop.append((start, end))
            elif kind == "UltimateTimeAction":
                skill.ultimate_time = max(skill.ultimate_time or 0, end)
            elif kind == "HideUIAction":
                skill.hide_ui = max(skill.hide_ui or 0, end)
            elif kind.startswith("PlayAnimation") and skill.clip_seconds is None:
                skill.clip_seconds = action.get("duration")
            elif kind == "TimeDilationAction" and start == 0 and action.get("curveKey") == DILATION_CURVE:
                value = (action.get("duration") or {}).get("value")
                if value:
                    skill.dilation = max(skill.dilation or 0.0, round(float(value), 4))
    skill.allow_next.sort()
    skill.stops.sort()
    skill.sp_hits.sort()
    skill.hits = sorted(set(skill.hits))
    return skill


def basic_chain(char_id: str, first: str = "attack1") -> list[Skill]:
    """The basic attack chain: from ``attack1`` along transitions until it closes.

    ``first="ult_attack1"`` walks an ultimate's enhanced chain the same way
    (Laevatain's): ``next_in_chain`` keeps to the moves of its own prefix.
    """
    chain: list[Skill] = []
    seen: set[str] = set()
    current: str | None = f"{char_id}_{first}"
    while current and current not in seen:
        seen.add(current)
        skill = load_skill(current)
        if skill is None:
            break
        chain.append(skill)
        step = skill.next_in_chain()
        current = step[1] if step else None
    return chain


def chain_cycle(chain: list[Skill]) -> int | None:
    """Frames per full cycle; ``None`` if the chain does not return to the start."""
    total = 0
    for skill in chain:
        step = skill.next_in_chain()
        if step is None:
            return None
        total += step[0] + 1
    return total


def open_chain_guess(chain: list[Skill]) -> int:
    """An open chain: transitions plus the last hit's ``exclusiveFrame + 1``.

    A guess, not a model: it matches for Ember and Wulfgard, not for Camille.
    """
    return sum(s.next_in_chain()[0] + 1 for s in chain[:-1]) + chain[-1].exclusive + 1


def segment_seconds(skill: Skill) -> float:
    """One segment of the chain on an enemy: up to its transition (``AllowNext`` + 1,
    or ``exclusiveFrame`` + 1 when it does not close), with its own hit stops."""
    step = skill.next_in_chain()
    frame = step[0] if step else skill.exclusive
    return (frame + 1) / FPS + skill.stopped_before(frame)


def final_strike_frames(chain: list[Skill]) -> int:
    """Frames of the chain's last hit, the Final Strike: its transition back
    to the start, or ``exclusiveFrame + 1`` when the chain does not close."""
    last = chain[-1]
    step = last.next_in_chain()
    return step[0] + 1 if step else last.exclusive + 1


BUFFS = SKILLS.parent / "BuffData"


def _stack_cap(buff_id: str) -> int:
    path = BUFFS / f"{buff_id}.json"
    if not path.exists():
        return 1
    data = json.loads(path.read_text(encoding="utf-8"))
    return int((data.get("stackingSettings") or {}).get("maxStackCnt") or 1)


# ``skillSpecification`` → the skill type whose DMG bonus a move takes. Read
# off moves whose kind is known: every ``attackN`` is 1, ``normal_skill`` 3,
# ``combo_skill`` 4, ``ultimate_skill`` 5. Camille's Hunter Pursuit
# (``combo_skill_2``), «treated as a combo skill», is 4 — the field carries
# the "treated as", not the button.
SPECIFICATIONS = {1: "Basic Attack", 3: "Battle Skill", 4: "Combo Skill", 5: "Ultimate"}


def enhanced_chain(char_id: str, patches: dict) -> dict | None:
    """An ultimate's enhanced basic attack chain, closed like the ordinary one: Laevatain's.

    ``ult_attack1`` → … → ``ult_attackN`` → back to ``ult_attack1``. The same
    numbers as the ordinary chain gets in ``basic_attacks.json``, for the
    enhanced one: its period, the Final Strike's share, the Final Strike's SP
    (``atb``) and Stagger (``poise``) — the wiki gives neither for the
    enhanced strike — and ``dealtAs``, the skill type its hits count as.
    """
    chain = basic_chain(char_id, "ult_attack1")
    cycle = chain_cycle(chain) if chain else None
    if not chain or cycle is None:
        return None
    last = chain[-1]
    bundle = (patches.get(last.id) or {}).get("SkillPatchDataBundle") or []
    board = {entry.get("key"): entry.get("value") for entry in (bundle[0].get("blackboard") or [])} if bundle else {}
    kinds = {SPECIFICATIONS.get(skill.specification) for skill in chain}
    return {
        "sequences": len(chain),
        "sequenceSeconds": round(cycle / FPS, 4),
        "finalStrikeSeconds": round(final_strike_frames(chain) / FPS, 4),
        **({"finalStrikeSp": float(board["atb"])} if board.get("atb") else {}),
        **({"finalStrikeStagger": float(board["poise"])} if board.get("poise") else {}),
        **({"dealtAs": kinds.pop()} if len(kinds) == 1 and None not in kinds else {}),
    }


def ultimate_barrage(char_id: str) -> dict | None:
    """An ultimate whose enhanced basic attack fires until the ultimate runs out: Yvonne.

    The moves are ``<char>_ult_attack<N>_1``…: from ``ult_attack1_1`` along
    the transitions to the next ``ult_attack``, the last one looping on
    itself (``ult_attack3_2`` allows ``ult_attack3_2``). A chain that closes
    back to its start instead is an enhanced basic attack of the ordinary
    kind (Laevatain's four sequences) and is not a barrage.

    * ``opens`` — the frame of the ultimate's cast that creates its own buff
      ``buff_<char>_ultimate_skill``: the window starts there;
    * ``moves`` — each move's length to the next one (transition + 1, as in
      the chain model), its shot frames and, per shot, whether the shot's
      frame also creates a stacking buff (``maxStackCnt`` > 1) — Yvonne's
      crit stack;
    * ``loop`` — the index of the move that repeats;
    * ``end`` — ``ult_attack_end``, the closing strike: its hit frame and
      its ``exclusiveFrame + 1``.
    """
    current: str | None = f"{char_id}_ult_attack1_1"
    moves: list[dict] = []
    order: list[str] = []
    cap = 1
    while current and current not in order:
        skill = load_skill(current)
        if skill is None:
            return None
        order.append(current)
        nxt = next(
            ((frame, target) for frame, targets in skill.allow_next for target in targets
             if "_ult_attack" in target and not target.endswith("_end")),
            None,
        )
        stacking: list[bool] = []
        for hit in skill.hits:
            stacks = [b for frame, ids in skill.buffs if frame == hit for b in ids if _stack_cap(b) > 1]
            cap = max([cap, *(_stack_cap(b) for b in stacks)])
            stacking.append(bool(stacks))
        moves.append({"frames": (nxt[0] + 1) if nxt else skill.exclusive + 1, "hits": skill.hits,
                      "stacking": stacking})
        current = nxt[1] if nxt else None
    if current is None or current != order[-1]:
        return None  # no self-loop: not a barrage
    cast = load_skill(f"{char_id}_ultimate_skill")
    end = load_skill(f"{char_id}_ult_attack_end")
    own = f"buff_{char_id}_ultimate_skill"
    opens = next((frame for frame, ids in (cast.buffs if cast else []) if own in ids), None)
    if opens is None or end is None or not end.hits:
        return None
    kinds = {SPECIFICATIONS.get(load_skill(move).specification) for move in order} | {SPECIFICATIONS.get(end.specification)}
    return {
        "opens": opens,
        "moves": moves,
        "loop": len(moves) - 1,
        "stackCap": cap,
        "end": {"hit": end.hits[0], "frames": end.exclusive + 1},
        **({"dealtAs": kinds.pop()} if len(kinds) == 1 and None not in kinds else {}),
    }


def final_strike_stacks(char_id: str, chain: list[Skill]) -> dict | None:
    """A stack the chain's Final Strike creates that the battle skill's hit creates too.

    Laevatain's ``attack5`` creates ``buff_<char>_energy`` on its second hit,
    once per strike — the same buff her battle skill's Magma Fragment
    creates on hitting, which the text calls Melting Flame. The wiki's basic
    attack text does not mention it. Only the operator's own stacking buffs
    count (``maxStackCnt`` above 1, or set from the blackboard).
    """
    if not chain:
        return None
    family = [load_skill(path.stem) for path in sorted(SKILLS.glob(f"{char_id}_normal_skill*.json"))]
    battle = {buff for skill in family if skill for _, ids in skill.buffs for buff in ids}
    own = f"buff_{char_id}_"
    for _, ids in chain[-1].buffs:
        for buff in ids:
            if not buff.startswith(own) or buff not in battle:
                continue
            data = json.loads((BUFFS / f"{buff}.json").read_text(encoding="utf-8"))
            stacking = data.get("stackingSettings") or {}
            if (stacking.get("maxStackCnt") or 1) > 1 or stacking.get("useMaxStackCntKey"):
                return {"buff": buff, "count": 1}
    return None


def battle_skill_during_ultimate(char_id: str) -> dict | None:
    """The battle skill an ultimate swaps in for its window: Laevatain's ``normal_skill_during_ult``.

    ``hits`` — its damage moves in order; ``inflicting`` — the 1-based
    numbers of those whose tick also casts ``SpellInfliction`` (no element
    given: the operator's own, as on her ``ult_attack3``, whose text says
    «applies Heat Infliction»).
    """
    path = SKILLS / f"{char_id}_normal_skill_during_ult.json"
    if not path.exists():
        return None
    data = json.loads(path.read_text(encoding="utf-8"))
    moves: list[tuple[int, bool]] = []
    for entry in data["actionGroupData"]["timelineActions"]:
        kinds = {_short(action.get("$type", "")) for action in _actions(entry.get("_sequenceActionData"))}
        if "DamageAction" in kinds:
            moves.append((entry["_startFrame"], "SpellInfliction" in kinds))
    moves.sort()
    if not moves:
        return None
    return {"hits": len(moves), "inflicting": [index + 1 for index, (_, inflicts) in enumerate(moves) if inflicts]}


def battle_skill_entity_hits(char_id: str) -> dict | None:
    """Hits of what the battle skill summons: Laevatain's Magma Fragment.

    The skill spawns ``<char>_normal_skill_abilityentity``, and that skill
    hits on its own timeline: 11 times, the first with a Stagger unit (the
    `Base Explosion`), the other 10 without (the `DMG Over Time … per SEQ`
    ticks). ``hits`` — all of them; ``staggering`` — those with a Stagger
    (``poiseCalculation``) unit.
    """
    cast = SKILLS / f"{char_id}_normal_skill.json"
    if not cast.exists():
        return None
    data = json.loads(cast.read_text(encoding="utf-8"))
    entity_id = None
    for entry in data["actionGroupData"]["timelineActions"]:
        for action in _actions(entry.get("_sequenceActionData")):
            if _short(action.get("$type", "")) == "SpawnAbilityEntity" and action.get("abilityEntitySkillId"):
                entity_id = action["abilityEntitySkillId"]
    path = SKILLS / f"{entity_id}.json" if entity_id else None
    if not path or not path.exists():
        return None
    entity = json.loads(path.read_text(encoding="utf-8"))
    hits = staggering = 0
    for entry in entity["actionGroupData"]["timelineActions"]:
        for action in _actions(entry.get("_sequenceActionData")):
            if _short(action.get("$type", "")) != "DamageAction":
                continue
            hits += 1
            staggering += any(unit.get("poiseCalculation") for unit in action.get("damageUnits") or [])
    return {"hits": hits, "staggering": staggering} if hits else None


def battle_skill_fuse(char_id: str) -> float | None:
    """Seconds from a battle skill's start to the hit of the entity it leaves: Fluorite's explosive.

    The skill's projectile hit (``<char>_normal_skill_projhit``) spawns an
    ability entity; the entity's skill hits on its own timeline. The fuse is
    the battle skill's hit frame plus the entity's first hit frame. The
    projectile's flight is not in the frames and is left out.
    """
    cast = load_skill(f"{char_id}_normal_skill")
    path = SKILLS / f"{char_id}_normal_skill_projhit.json"
    if cast is None or not cast.hits or not path.exists():
        return None
    data = json.loads(path.read_text(encoding="utf-8"))
    for entry in data["actionGroupData"]["timelineActions"]:
        for action in _actions(entry.get("_sequenceActionData")):
            if _short(action.get("$type", "")) != "SpawnAbilityEntity":
                continue
            entity = load_skill(action.get("abilityEntitySkillId") or "")
            if entity and entity.hits:
                return round((cast.hits[0] + entity.hits[0]) / FPS, 4)
    return None


# Operators whose windows were measured on video (measurements, #35):
# combo — another operator's battle skill ~25 client frames after the start
# (model 24), ultimate — 46 after (model 45, the cutscene's end).
MEASURED_WINDOWS = {
    "Endministrator (female)": {"CS", "ULT"},
    "Endministrator (male)": {"CS", "ULT"},
    "Chen Qianyu": {"BS"},
}
# A battle skill does not hold another operator: Pogranichnik's battle skill
# came 8 and 13 client frames after Chen's started — as fast as the button
# was mashed — and her hit still landed (measurements, #35, 2026-11-05).
BS_OTHER_FRAMES = 8


# Actions that put a status on the target: the hit that carries one is when
# a battle skill's effects land (measurements, #63).
STATUS_ACTIONS = frozenset({
    "KnockDownAction", "AirborneAction", "CrushAction", "FractureAction", "SpellInfliction",
})
# Battle skills whose landing was checked on video (measurements, #63).
MEASURED_LANDS = {"Lifeng"}

# Hits the client's frames do not hold, read off video. Lifeng's ultimate is
# struck by his aspect, not by him: the ultimate's timeline has no hit at all.
# «Howling beasts.mp4», 60 fps: cutscene from recording frame 2150 (the
# interface back at 2264, +114 = the client's 57 frames), first Knock Down's
# numbers at 2278 (+128 = 64 client frames), second at 2436 (+286) with Chen's
# combo in between — its 0.633 s slowdown at ×0.05 taken out, 4.167 s = 125
# client frames on the caster's own clock (measurements, #73).
MEASURED_SKILL_HITS = {
    "Lifeng": {"ULT": [{"at": round(64 / FPS, 4), "status": True}, {"at": round(125 / FPS, 4), "status": True}]},
}


def battle_skill_lands(char_id: str) -> float | None:
    """Seconds from a battle skill's start to its last hit that puts a status on the target.

    Lifeng's Knock Down and Physical Susceptibility ride the third hit, frame
    54. The hit stops of the hits before it delay it (``_stop``): they are
    not under a main-character check, so they run for a background operator
    too. ``None`` when no hit carries a status action
    (projectiles, summons, buffs only): when those land is not read.
    """
    path = SKILLS / f"{char_id}_normal_skill.json"
    if not path.exists():
        return None
    data = json.loads(path.read_text(encoding="utf-8"))
    hits: list[tuple[int, bool, float]] = []
    for entry in data["actionGroupData"]["timelineActions"]:
        seq = entry.get("_sequenceActionData")
        kinds = {_short(action.get("$type", "")) for action in _actions(seq)}
        if "DamageAction" not in kinds:
            continue
        stop = _stop(seq)
        hits.append((entry["_startFrame"], bool(kinds & STATUS_ACTIONS), stop))
    hits.sort()
    landing = [frame for frame, carries, _ in hits if carries]
    if not landing:
        return None
    frame = landing[-1]
    stopped = sum(stop for start, _, stop in hits if start < frame)
    return round(frame / FPS + stopped, 4)


def skill_hits(char_id: str, suffix: str) -> list[dict] | None:
    """Every hit of a skill, in seconds from the press, and whether it carries a status.

    The same reading as ``battle_skill_lands``: a hit is a timeline entry
    with a ``DamageAction``; it comes after the hit stops of the hits before
    it (measurements, #63); ``status`` — the hit carries an action that puts
    a status on the target; ``late`` — the hit comes after the skill's first
    ``AllowNextSkillAction``, where some skills keep other variants of the
    move (Pogranichnik's combo: one timeline per stack count, one after
    another). Projectiles are left out: when one lands is not in the frame
    data. ``None`` — the skill has no such hit.
    """
    skill = load_skill(f"{char_id}_{suffix}")
    window = skill.allow_next[0][0] if skill and skill.allow_next else None
    path = SKILLS / f"{char_id}_{suffix}.json"
    if not path.exists():
        return None
    data = json.loads(path.read_text(encoding="utf-8"))
    hits: list[tuple[int, bool, float]] = []
    for entry in data["actionGroupData"]["timelineActions"]:
        seq = entry.get("_sequenceActionData")
        kinds = {_short(action.get("$type", "")) for action in _actions(seq)}
        if "DamageAction" not in kinds:
            continue
        stop = _stop(seq)
        hits.append((entry["_startFrame"], bool(kinds & STATUS_ACTIONS), stop))
    hits.sort()
    out: list[dict] = []
    for frame, carries, _ in hits:
        stopped = sum(stop for start, _, stop in hits if start < frame)
        hit: dict = {"at": round(frame / FPS + stopped, 4)}
        if carries:
            hit["status"] = True
        if window is not None and frame > window:
            hit["late"] = True
        out.append(hit)
    return out or None


def chain_hits(chain: list[Skill]) -> list[list[float]]:
    """Hits of the basic chain on an enemy, in seconds from the start of the chain.

    One list per segment, in chain order: the last is the Final Strike. A
    segment starts where the one before it allows the next
    (``segment_seconds``); a hit comes after the attacker's hit stops before
    it (measurements, #68b).
    """
    out: list[list[float]] = []
    start = 0.0
    for skill in chain:
        out.append([round(start + skill.at(frame), 4) for frame in skill.hits])
        start += segment_seconds(skill)
    return out


def final_strike_hit(chain: list[Skill]) -> float | None:
    """Seconds from the chain's start to the hit that is the Final Strike.

    The last segment's hit that restores SP (``ObtainCostAction``): Lifeng's
    strike has two hits, and combos open on the second (measurements, #68c).
    Without such a hit, its first hit; ``None`` without hits.
    """
    last = chain[-1]
    frames = last.sp_hits or last.hits[:1]
    if not frames:
        return None
    start = sum(segment_seconds(skill) for skill in chain[:-1])
    return round(start + last.at(frames[0]), 4)


def skill_windows(name: str, char_id: str) -> dict:
    """When another action may start after a combo or an ultimate, from the client.

    Combo: the first ``AllowNextSkillAction`` + 1 frame — the same reading as
    the basic chain, confirmed by video on the Endministrator: the window
    lets another operator's battle skill in, though the list names only her
    own. Without the action — ``exclusiveFrame`` + 1, a guess. Ultimate: the
    end of the cutscene (``UltimateTimeAction``, else ``HideUIAction``) + 1;
    measured on the Endministrator, where it came before ``exclusiveFrame``.
    It is the next action of ANY operator; the ultimate's own operator may
    have to wait longer. Battle skill: its own window, ``other`` — how long
    it holds another operator — and ``lands`` (``battle_skill_lands``).
    Own windows include the caster's hit stops before them; a combo also
    carries ``dilation``, its world slowdown (measurements, #64).
    """
    out: dict = {}
    battle = load_skill(f"{char_id}_normal_skill")
    if battle is not None:
        own = battle.allow_next[0][0] if battle.allow_next else battle.exclusive
        out["BS"] = {
            "seconds": round((own + 1) / FPS + battle.stopped_before(own), 4),
            "from": "allowNext" if battle.allow_next else "exclusive",
            "other": round(BS_OTHER_FRAMES / FPS, 4),
        }
        if (lands := battle_skill_lands(char_id)) is not None:
            out["BS"]["lands"] = lands
            if name in MEASURED_LANDS:
                out["BS"]["landsMeasured"] = True
    combo = load_skill(f"{char_id}_combo_skill")
    if combo is not None:
        if combo.allow_next:
            frame, source = combo.allow_next[0][0], "allowNext"
        else:
            frame, source = combo.exclusive, "exclusive"
        out["CS"] = {"seconds": round((frame + 1) / FPS + combo.stopped_before(frame), 4), "from": source}
        if combo.dilation:
            out["CS"]["dilation"] = combo.dilation
    ultimate = load_skill(f"{char_id}_ultimate_skill")
    if ultimate is not None:
        if ultimate.ultimate_time is not None:
            frames, source = ultimate.ultimate_time + 1, "ultimateTime"
        elif ultimate.hide_ui is not None:
            frames, source = ultimate.hide_ui + 1, "hideUi"
        else:
            frames, source = ultimate.exclusive + 1, "exclusive"
        out["ULT"] = {"seconds": round(frames / FPS, 4), "from": source, "cutscene": round(frames / FPS, 4)}
    for kind in MEASURED_WINDOWS.get(name, ()):
        if kind in out:
            out[kind]["measured"] = True
    return out


def dive(char_id: str) -> dict | None:
    """A dive from the ground: the measured fall, then ``plunging_attack_end``.

    ``hit`` — the measured jump to the landing's hit, ``DIVE_FALL``; the
    landing starts that much before its own first hit frame. ``seconds`` —
    until the next action: from there, the landing's ``AllowNext`` + 1, else
    ``exclusiveFrame`` + 1 (Chen: 0.52 − 0.03 + 0.70 = 1.19); on video the
    next jump came at least 1.13 s after the hit, a hand's reaction on top.
    ``None`` without the landing.
    """
    end = load_skill(f"{char_id}_plunging_attack_end")
    if end is None:
        return None
    frame = end.allow_next[0][0] if end.allow_next else end.exclusive
    lands = DIVE_FALL - (end.at(end.hits[0]) if end.hits else 0.0)
    return {
        "seconds": round(lands + (frame + 1) / FPS + end.stopped_before(frame), 4),
        "hit": DIVE_FALL,
    }


def finisher(char_id: str) -> dict | None:
    """A finisher (``power_attack``): until the next attack, and its hits.

    Chen's on video (measurements, #21): 1.00 s between her two hits, 1.30 s
    from the second to the next basic attack's first hit — 2.20 s press to
    press. Her stops come in pairs a frame or two apart (5 and 6, 29 and 31),
    and the sum of all four (2.85 s) does not fit; the later stop of each
    pair alone does: (50 + 1)/30 + 0.2 + 0.3 = 2.20. So stops within three
    frames of each other count once, the later one. Fitted on one operator,
    hence ``fitted``; the basic chain keeps the plain sum, which fits there
    (#68b).
    """
    skill = load_skill(f"{char_id}_power_attack")
    if skill is None:
        return None
    stops: list[tuple[int, float]] = []
    for start, seconds in skill.stops:
        if stops and start - stops[-1][0] <= 3:
            stops[-1] = (start, seconds)
        else:
            stops.append((start, seconds))
    stopped = lambda frame: sum(seconds for start, seconds in stops if start <= frame)
    end = skill.exclusive
    return {
        "seconds": round((end + 1) / FPS + stopped(end), 4),
        "hits": [round(frame / FPS + stopped(frame - 1), 4) for frame in skill.hits],
        "fitted": True,
    }


def _operators() -> dict[str, str]:
    data = json.loads((DATA / "operators.json").read_text(encoding="utf-8"))
    return {name: op["id"] for name, op in data.items() if op.get("id")}


def _sec(frames: int | float) -> str:
    return f"{frames / FPS:.3f} s"


def cmd_show(name: str) -> int:
    ids = _operators()
    key = next((k for k in ids if k.lower() == name.lower()), None)
    if key is None:
        print(f"no operator {name!r}; available: {', '.join(sorted(ids))}", file=sys.stderr)
        return 1
    char_id = ids[key]
    print(f"{key} — {char_id}, {FPS} frames/s\n")

    chain = basic_chain(char_id)
    cycle = chain_cycle(chain)
    print(f"BA: {len(chain)} hits, cycle {cycle} frames = {_sec(cycle)}" if cycle
          else f"BA: {len(chain)} hits, the chain does not close")
    for skill in chain:
        step = skill.next_in_chain()
        nxt = f"next from {step[0]:3}" if step else "next —"
        print(f"  {skill.id.rsplit('_', 1)[-1]:8} {nxt}   hits {skill.hits}   length {skill.duration}")

    for suffix, label in KINDS.items():
        skill = load_skill(f"{char_id}_{suffix}")
        if skill is None:
            continue
        print(f"\n{label} ({skill.id}): length {skill.duration} = {_sec(skill.duration)}, "
              f"exclusive {skill.exclusive}")
        for frame, targets in skill.allow_next:
            print(f"  from frame {frame:3} ({_sec(frame)}) allowed: {', '.join(targets) or '—'}")
        if not skill.allow_next:
            print("  no AllowNextSkillAction — until the animation ends or until exclusive")
        if skill.hits:
            print(f"  hits/shots: {skill.hits}")
        for frame, buffs in skill.buffs:
            print(f"  buff on frame {frame}: {', '.join(buffs)}")
        if skill.hit_stop:
            print(f"  hit stop: {skill.hit_stop}")
    return 0


def cmd_verify() -> int:
    ids = _operators()
    rows = list(csv.DictReader(BASIC_CSV.open(encoding="utf-8")))
    good = bad = skipped = 0
    print(f"BA cycle = Σ (AllowNext + 1) / {FPS}  against  «Basic Sequence» from the table\n")
    print(f"{'operator':24} {'measured':>8} {'model':>7} {'Δ frame':>7}")
    for row in rows:
        name = CSV_ALIASES.get(row["Character"], row["Character"])
        if not row.get("Basic Sequence"):
            continue
        measured = float(row["Basic Sequence"])
        char_id = ids.get(name)
        if char_id is None:
            print(f"{row['Character']:24} {measured:8.3f}       — no id (a branch under the ultimate?)")
            skipped += 1
            continue
        chain = basic_chain(char_id)
        cycle = chain_cycle(chain)
        if cycle is None:
            guess = open_chain_guess(chain)
            print(f"{row['Character']:24} {measured:8.3f}       — does not close; "
                  f"with exclusive+1 it would be {guess / FPS:.3f} ({guess - measured * FPS:+.1f})")
            skipped += 1
            continue
        delta = cycle - measured * FPS
        ok = abs(delta) <= TOLERANCE_FRAMES
        good += ok
        bad += not ok
        print(f"{row['Character']:24} {measured:8.3f} {cycle / FPS:7.3f} {delta:+7.1f}  {'' if ok else '←'}")
    print(f"\nwithin {TOLERANCE_FRAMES} frames: {good}, off: {bad}, skipped: {skipped}")
    return 0


def cmd_hits() -> int:
    """Wiki damage rows against client hits, per skill (``export.hit_times``)."""
    sys.path.insert(0, str(ROOT))
    from tools.ef.export import hit_times, read_frame_data, skill_stats

    operators = json.loads((DATA / "operators.json").read_text(encoding="utf-8"))
    frames = read_frame_data()
    good = bad = 0
    print(f"{'operator':24} {'skill':4} {'wiki':>4} {'client':>6}  rows → hits (s)")
    for key, record in sorted(operators.items()):
        seen: set[str] = set()
        for raw in record.get("skills", []):
            stats, _ = skill_stats(raw)
            skill = {**raw, "stats": stats}
            verdict = hit_times(skill, frames.get(key))
            if not verdict or verdict["kind"] in seen:
                continue
            seen.add(verdict["kind"])
            good += verdict["matched"]
            bad += not verdict["matched"]
            rows = "; ".join(
                f"{row['label']} {row['hit']['at']}" for row in stats if row.get("hit", {}).get("at") is not None
            )
            wiki = "?" if verdict["wiki"] is None else verdict["wiki"]
            mark = "" if verdict["matched"] else "← last hit"
            print(f"{key:24} {verdict['kind']:4} {wiki:>4} {verdict['client']:>6}  {mark} {rows}")
    print(f"\nmatched: {good}, last hit taken: {bad}")
    return 0


def final_strike_sp(chain: list[Skill], patches: dict) -> float | None:
    """SP the Final Strike restores: ``atb`` in the blackboard of the chain's last hit.

    Read from ``SkillPatchTable`` at skill level 1; the value does not change
    with level. Exactly one skill of a chain carries a non-zero ``atb``.
    """
    for skill in reversed(chain):
        bundle = (patches.get(skill.id) or {}).get("SkillPatchDataBundle") or []
        if not bundle:
            continue
        board = {entry.get("key"): entry.get("value") for entry in bundle[0].get("blackboard") or []}
        if board.get("atb"):
            return float(board["atb"])
    return None


def _measured_cycles() -> dict[str, float]:
    """«Basic Sequence» from the community table, if the vault has it.

    Only used to flag where the frame model disagrees with a measurement;
    the exported numbers never come from the table.
    """
    if not BASIC_CSV.exists():
        return {}
    out = {}
    for row in csv.DictReader(BASIC_CSV.open(encoding="utf-8")):
        name = CSV_ALIASES.get(row["Character"], row["Character"])
        try:
            out[name] = float(row["Basic Sequence"])
        except (KeyError, TypeError, ValueError):
            continue
    return out


def cmd_export() -> int:
    """Final Strike SP and basic-chain length per operator, from the datamine.

    ``sequenceSeconds`` comes from the frame model: a closed chain gives
    Σ (AllowNext + 1) / 30, an open one the ``exclusiveFrame`` guess, plus
    the attacker's hit stops on an enemy (measurements, #68b). The check
    against the community table is made without them: the table matches
    the frames alone.
    ``finalStrikeSeconds`` is the last hit's share of it: the track draws
    ``BA > FS`` as the chain up to the Final Strike, then the strike. It is
    ``uncertain`` when the chain does not close, or when it disagrees with the
    community measurement by more than the tolerance (measurements, #35): the
    engine then treats it as an unmeasured duration.

    Records outside the basic chain ride along, because they are frame data
    too: ``ultimateBarrage`` (``ultimate_barrage``, Yvonne),
    ``enhancedChain`` (``enhanced_chain``, Laevatain's ultimate),
    ``finalStrikeStacks`` (``final_strike_stacks``, her Melting Flame),
    ``battleSkillDuringUltimate`` (``battle_skill_during_ultimate``),
    ``battleSkillEntity`` (``battle_skill_entity_hits``) and
    ``battleSkillFuse`` (``battle_skill_fuse``, Fluorite's explosive).
    ``export.py`` decides which skill they belong to.

    ``chainHits`` (``chain_hits``) and ``skillHits`` (``skill_hits``) are
    when each hit lands: the engine schedules events by them
    (ENGINE_CORE_PLAN.md, Я1). ``finalStrikeHit`` (``final_strike_hit``) is
    the hit that opens Final Strike combos.
    """
    patches = json.loads(SKILL_PATCH.read_text(encoding="utf-8"))
    measured = _measured_cycles()
    operators: dict[str, dict] = {}
    for name, char_id in sorted(_operators().items()):
        chain = basic_chain(char_id)
        if not chain:
            continue
        record: dict = {"id": char_id}
        sp = final_strike_sp(chain, patches)
        if sp is not None:
            record["finalStrikeSp"] = sp
        cycle = chain_cycle(chain)
        closed = cycle is not None
        frames = cycle if closed else open_chain_guess(chain)
        stopped = sum(skill.stopped_before(skill.next_in_chain()[0] if skill.next_in_chain() else skill.exclusive) for skill in chain)
        record["sequenceSeconds"] = round(frames / FPS + stopped, 4)
        record["finalStrikeSeconds"] = round(segment_seconds(chain[-1]) if closed else final_strike_frames(chain) / FPS + chain[-1].stopped_before(chain[-1].exclusive), 4)
        record["chain"] = "closed" if closed else "open"
        reasons = [] if closed else ["the chain does not close; exclusiveFrame guess"]
        if name in measured and abs(frames - measured[name] * FPS) > TOLERANCE_FRAMES:
            reasons.append(f"{frames - measured[name] * FPS:+.1f} frames off a community measurement")
        if reasons:
            record["uncertain"] = "; ".join(reasons)
        if barrage := ultimate_barrage(char_id):
            record["ultimateBarrage"] = barrage
        if enhanced := enhanced_chain(char_id, patches):
            record["enhancedChain"] = enhanced
        if stacks := final_strike_stacks(char_id, chain):
            record["finalStrikeStacks"] = stacks
        if swapped := battle_skill_during_ultimate(char_id):
            record["battleSkillDuringUltimate"] = swapped
        if summoned := battle_skill_entity_hits(char_id):
            record["battleSkillEntity"] = summoned
        if (fuse := battle_skill_fuse(char_id)) is not None:
            record["battleSkillFuse"] = fuse
        if windows := skill_windows(name, char_id):
            record["skillWindows"] = windows
        if plunge := dive(char_id):
            record["dive"] = plunge
        if strike := finisher(char_id):
            record["finisher"] = strike
        record["chainHits"] = chain_hits(chain)
        if (strike := final_strike_hit(chain)) is not None:
            record["finalStrikeHit"] = strike
        skill_hit_times = {
            label: hits for suffix, label in KINDS.items() if (hits := skill_hits(char_id, suffix))
        }
        for label, hits in MEASURED_SKILL_HITS.get(name, {}).items():
            skill_hit_times.setdefault(label, hits)
        if skill_hit_times:
            record["skillHits"] = skill_hit_times
        operators[name] = record

    pin = json.loads(UPSTREAM_PIN.read_text(encoding="utf-8")).get("endfield-data", {})
    out = {
        "meta": {
            "source": "client datamine: Json/SkillData (frames), TableCfg/SkillPatchTable (atb)",
            "upstream": {"url": pin.get("url"), "sha": pin.get("sha")},
            "fps": FPS,
            "generator": "tools/ef/frames.py --export",
        },
        "operators": operators,
    }
    BASIC_ATTACKS.write_text(json.dumps(out, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    uncertain = sorted(name for name, record in operators.items() if "uncertain" in record)
    print(f"{BASIC_ATTACKS.relative_to(ROOT)}: {len(operators)} operators, "
          f"Final Strike SP for {sum('finalStrikeSp' in r for r in operators.values())}, "
          f"uncertain chain length: {', '.join(uncertain) or 'none'}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("operator", nargs="?", help="operator name, as in operators.json")
    parser.add_argument("--verify", action="store_true", help="check the BA cycle against the table")
    parser.add_argument("--export", action="store_true", help="write data/endfield/basic_attacks.json")
    parser.add_argument("--hits", action="store_true", help="wiki damage rows against client hits")
    args = parser.parse_args()

    if not SKILLS.is_dir():
        raise SystemExit("no datamine clone — run tools/ef/sync.py")
    if args.verify:
        return cmd_verify()
    if args.export:
        return cmd_export()
    if args.hits:
        return cmd_hits()
    if args.operator:
        return cmd_show(args.operator)
    parser.print_help()
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
