#!/usr/bin/env python3
"""Reading the client datamine: what a talent or potential actually grants.

The source is the ``tools/ef/sync.py`` clone (``data/endfield/upstream/``). It
is not versioned and may be absent: then ``available()`` is false and the
caller silently skips the check. Only conclusions reach the repository from
here, never the data itself (the dump has no licence).

How the client is laid out:

* ``CharGrowthTable[charId].talentNodeMap`` — upgrade nodes. ``nodeType 3`` is
  an attribute talent: the modifier sits right in the node, ``breakStage`` is
  the elite level. ``nodeType 4`` is a passive talent: ``index`` is its
  ordinal (0, 1), ``breakStage`` the elite level, ``talentEffectId`` a record
  in ``PotentialTalentEffectTable``.
* ``PotentialTalentEffectTable`` — what a talent tier or a potential does (the
  link to a potential is in ``CharacterPotentialTable``). ``modifyType``: 4 —
  an attribute modifier right in the record, 5 — a buff with a blackboard,
  1 — a skill with a blackboard, 2 — a skill parameter (cost, cooldown),
  3 — a skill blackboard key.
* A buff's attribute modifier almost always refers to a blackboard key
  (``atk``, ``atk_up``), and the number comes from the talent record. A buff
  may apply child buffs — the tree is walked by ``buffId``.

The wiki's talent order is the same everywhere: the attribute talent, two
passives, Outfitting. So passive ``index i`` is ``talents[1 + i]``; checked
across all operators at the 2026-10-27 pin.

Usage — see what the client knows about an operator::

    python3 tools/ef/datamine.py "Chen Qianyu"

Stagger Nodes of every enemy, into a versioned file the export reads::

    python3 tools/ef/datamine.py --export-nodes   # → data/endfield/stagger_nodes.json
"""

from __future__ import annotations

import json
import sys
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "data" / "endfield"
UPSTREAM = DATA / "upstream" / "endfield-data"
TABLES = UPSTREAM / "TableCfg"
BUFFS = UPSTREAM / "Json" / "BuffData"
SKILLS = UPSTREAM / "Json" / "SkillData"
UPSTREAM_PIN = DATA / "upstream.json"
STAGGER_NODES = DATA / "stagger_nodes.json"

# Beyond.GEnums.ModifierType — the attribute formula contract from
# Variante/endfield_research_kit (measurements, #8).
STAGES = {
    0: "Addition",
    1: "Multiplier",
    3: "FinalAddition",
    4: "FinalMultiplier",
    5: "BaseAddition",
    6: "BaseMultiplier",
    7: "BaseFinalAddition",
    8: "BaseFinalMultiplier",
}

# Attribute numbers. The dump has no enum names; labels are taken from
# ``iconName`` in ``AttributeMetaTable`` — only those the check needs.
ATTRS = {
    1: "MaxHp",
    2: "Atk",
    3: "Def",
    9: "CritRate",
    10: "CritDmg",
    39: "Str",
    40: "Agi",
    41: "Wisd",
    42: "Will",
    50: "PhysicalDmg",
    51: "FireDmg",
    52: "PulseDmg",
    53: "CrystDmg",
    54: "NaturalDmg",
    87: "OriginiumArts",
}

# PotentialTalentEffectTable: skillParamModifier.paramType.
PARAM_COST = 1
PARAM_COOLDOWN = 2


@dataclass(frozen=True)
class Fact:
    """One claim of the client: attribute, stage, value."""

    kind: str  # "attr" | "param"
    key: int  # attribute number or paramType
    stage: int  # formulaItem, or the parameter's modifyType (1 — add, 2 — multiply)
    value: float | None  # None — the blackboard key was not found
    source: str  # id of the buff, node or record
    stacks: int | None = None
    skill: str | None = None

    def describe(self) -> str:
        if self.kind == "attr":
            name = ATTRS.get(self.key, f"attr#{self.key}")
            stage = STAGES.get(self.stage, f"stage#{self.stage}")
        else:
            name = {PARAM_COST: "cost", PARAM_COOLDOWN: "cooldown"}.get(self.key, f"param#{self.key}")
            stage = {1: "add", 2: "mul"}.get(self.stage, f"op#{self.stage}")
            if self.skill:
                name = f"{self.skill}.{name}"
        value = "?" if self.value is None else f"{self.value:g}"
        stacks = f" ×{self.stacks} st." if self.stacks and self.stacks > 1 else ""
        return f"{name} {stage} {value}{stacks}  ← {self.source}"


def available() -> bool:
    return (TABLES / "PotentialTalentEffectTable.json").exists()


@lru_cache(maxsize=None)
def _table(name: str) -> dict:
    return json.loads((TABLES / f"{name}.json").read_text(encoding="utf-8"))


@lru_cache(maxsize=None)
def _json(folder: Path, name: str) -> dict | None:
    path = folder / f"{name}.json"
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def _refs(node, key: str, acc: list[str]) -> None:
    if isinstance(node, dict):
        for name, value in node.items():
            if name == key and isinstance(value, str) and value:
                acc.append(value)
            _refs(value, key, acc)
    elif isinstance(node, list):
        for value in node:
            _refs(value, key, acc)


def _blackboard(entries) -> dict[str, float]:
    return {item["key"]: item.get("value", item.get("valueDouble")) for item in entries or []}


def _buff_facts(buff_id: str, board: dict[str, float], seen: set[str]) -> list[Fact]:
    """Attribute modifiers of a buff and of every buff it applies."""
    if buff_id in seen:
        return []
    seen.add(buff_id)
    buff = _json(BUFFS, buff_id)
    if buff is None:
        return []
    own = {item["key"]: item.get("valueDouble") for item in buff.get("blackboard") or []}
    stacking = buff.get("stackingSettings") or {}
    # The stack cap is a blackboard key: first from the talent record, then its own.
    stacks = stacking.get("maxStackCnt")
    if stacking.get("useMaxStackCntKey"):
        key = stacking.get("maxStackCntKey")
        if board.get(key) is not None:
            stacks = int(board[key])
        elif own.get(key):
            stacks = int(own[key])

    facts = []
    for modifier in (buff.get("attributeModifier") or {}).get("attributeModifiers") or []:
        param = modifier.get("param") or {}
        if param.get("useBlackboardKey"):
            key = param.get("blackboardKey")
            value = board.get(key)
            if value is None and own.get(key):
                value = own[key]
        else:
            value = param.get("value")
        facts.append(
            Fact("attr", modifier["attributeType"], modifier["formulaItem"], value, buff_id, stacks)
        )
    children: list[str] = []
    _refs({k: v for k, v in buff.items() if k != "id"}, "buffId", children)
    for child in dict.fromkeys(children):
        facts.extend(_buff_facts(child, board, seen))
    return facts


def _skill_facts(skill_id: str, board: dict[str, float]) -> list[Fact]:
    skill = _json(SKILLS, skill_id)
    if skill is None:
        return []
    buffs: list[str] = []
    _refs(skill, "buffId", buffs)
    seen: set[str] = set()
    facts = []
    for buff in dict.fromkeys(buffs):
        facts.extend(_buff_facts(buff, board, seen))
    return facts


def effect_facts(effect_id: str) -> list[Fact] | None:
    """Facts of a ``PotentialTalentEffectTable`` record; None — no record."""
    record = _table("PotentialTalentEffectTable").get(effect_id)
    if record is None:
        return None
    facts: list[Fact] = []
    for item in record.get("dataList") or []:
        kind = item.get("modifyType")
        if kind == 4:
            mod = item["attrModifier"]
            facts.append(Fact("attr", mod["attrType"], mod["modifierType"], mod["attrValue"], effect_id))
        elif kind == 5:
            attach = item["attachBuff"]
            facts.extend(_buff_facts(attach["buffId"], _blackboard(attach.get("blackboard")), set()))
        elif kind == 1:
            attach = item["attachSkill"]
            facts.extend(_skill_facts(attach["skillId"], _blackboard(attach.get("blackboard"))))
        elif kind == 2:
            mod = item["skillParamModifier"]
            skill = mod.get("skillId") or ""
            facts.append(
                Fact(
                    "param",
                    mod["paramType"],
                    mod["modifyType"],
                    mod["paramValue"],
                    effect_id,
                    skill=skill.split("_", 2)[-1] if skill else None,
                )
            )
    return facts


# Resistance fields in EnemyAttributeTemplateTable → bundle element. Aether has
# no field: attribute 99 is 0 for every enemy in the data (pin 46b3376).
RESIST_FIELDS = {
    "physicalResistance": "Physical",
    "fireResistance": "Heat",
    "pulseResistance": "Electric",
    "crystResistance": "Cryo",
    "naturalResistance": "Nature",
}


def enemy_resistances(enemy_id: str) -> dict[str, float] | None:
    """An enemy's resistance multipliers, as in the bundle: resistance 20 → 0.8.

    In the client resistance is a number of percent, and attributes 80–85
    (DamageTakenScalar) next to it equal ``1 − res/100`` in 889 pairs out of
    894; the exception is ``eny_0125_fdcentur`` (resistance 20, multiplier
    1.0), and which of the two the game applies to it is unknown. The template
    is found via ``EnemyTable``: enemy variants (``_hdg…``, ``_hard``) have
    templates of their own.
    """
    enemy = _table("EnemyTable").get(enemy_id)
    if enemy is None:
        return None
    template = _table("EnemyAttributeTemplateTable").get(enemy.get("attrTemplateId"))
    if template is None:
        return None
    return {element: round(1 - template[field] / 100.0, 6) for field, element in RESIST_FIELDS.items()}


def stagger_nodes(enemy_id: str) -> list[float] | None:
    """Stagger Nodes as shares of the meter: ``[0.5]`` — one node halfway.

    ``poiseKnotPctList`` of the attribute template; the wiki only says that
    "powerful" enemies have nodes, never where. Each knot applies
    ``buff_common_mini_poise_break`` — the stumble.
    """
    enemy = _table("EnemyTable").get(enemy_id)
    if enemy is None:
        return None
    template = _table("EnemyAttributeTemplateTable").get(enemy.get("attrTemplateId"))
    if template is None:
        return None
    return [round(share, 4) for share in template.get("poiseKnotPctList") or []]


def export_nodes() -> int:
    enemies = json.loads((DATA / "enemies.json").read_text(encoding="utf-8"))
    out: dict = {}
    for key, record in sorted(enemies.items()):
        nodes = stagger_nodes(record.get("id") or "")
        if nodes:
            out[key] = {"id": record["id"], "nodes": nodes}
    pin = json.loads(UPSTREAM_PIN.read_text(encoding="utf-8")).get("endfield-data", {})
    document = {
        "meta": {
            "source": "client datamine: TableCfg/EnemyAttributeTemplateTable (poiseKnotPctList)",
            "upstream": {"url": pin.get("url"), "sha": pin.get("sha")},
            "generator": "tools/ef/datamine.py --export-nodes",
        },
        "enemies": out,
    }
    STAGGER_NODES.write_text(json.dumps(document, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"{STAGGER_NODES.relative_to(ROOT)}: {len(out)} of {len(enemies)} enemies have Stagger Nodes")
    return 0


@dataclass
class Character:
    char_id: str
    # elite → attribute talent facts
    attribute: dict[int, list[Fact]]
    # (passive number, elite) → PotentialTalentEffectTable record id
    passives: dict[tuple[int, int], str]

    def potential(self, rank: int) -> list[Fact] | None:
        # The link comes from CharacterPotentialTable: both Endministrator
        # genders share the potentials of chr_9000_endmin, and they cannot be
        # joined by name.
        bundle = (_table("CharacterPotentialTable").get(self.char_id) or {}).get("potentialUnlockBundle") or []
        effect = next((b["potentialEffectId"] for b in bundle if b.get("level") == rank), None)
        return effect_facts(effect) if effect else None

    def passive(self, index: int, elite: int) -> list[Fact] | None:
        effect = self.passives.get((index, elite))
        return effect_facts(effect) if effect else None


def character(char_id: str) -> Character | None:
    growth = _table("CharGrowthTable").get(char_id)
    if growth is None:
        return None
    attribute: dict[int, list[Fact]] = {}
    passives: dict[tuple[int, int], str] = {}
    for node_id, node in (growth.get("talentNodeMap") or {}).items():
        if node.get("nodeType") == 3:
            info = node["attributeNodeInfo"]
            attribute[info["breakStage"]] = [
                Fact("attr", mod["attrType"], mod["modifierType"], mod["attrValue"], node_id)
                for mod in info.get("attributeModifiers") or []
            ]
        elif node.get("nodeType") == 4:
            info = node["passiveSkillNodeInfo"]
            if info.get("talentEffectId"):
                passives[(info["index"], info["breakStage"])] = info["talentEffectId"]
    return Character(char_id, attribute, passives)


def main(argv: list[str]) -> int:
    if not available():
        print("no datamine clone — python3 tools/ef/sync.py", file=sys.stderr)
        return 1
    if argv == ["--export-nodes"]:
        return export_nodes()
    operators = json.loads((DATA / "operators.json").read_text(encoding="utf-8"))
    name = " ".join(argv)
    key = next((k for k in operators if k.lower() == name.lower()), None)
    if key is None or not operators[key].get("id"):
        print(f"no operator {name!r}", file=sys.stderr)
        return 1
    char = character(operators[key]["id"])
    if char is None:
        print(f"{operators[key]['id']}: not in CharGrowthTable", file=sys.stderr)
        return 1
    talents = [t["name"] for t in operators[key].get("talents") or []]
    print(f"{key} — {char.char_id}\n")
    print(f"{talents[0] if talents else 'attribute talent'}:")
    for elite in sorted(char.attribute):
        for fact in char.attribute[elite]:
            print(f"  Elite {elite}: {fact.describe()}")
    for (index, elite) in sorted(char.passives):
        title = talents[1 + index] if 1 + index < len(talents) else f"passive {index}"
        print(f"{title}, Elite {elite}:")
        for fact in char.passive(index, elite) or []:
            print(f"  {fact.describe()}")
    for rank in range(1, 6):
        facts = char.potential(rank)
        if facts is None:
            continue
        print(f"Potential {rank}:")
        for fact in facts:
            print(f"  {fact.describe()}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
