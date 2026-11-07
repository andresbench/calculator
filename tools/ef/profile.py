#!/usr/bin/env python3
"""Importing an Enka.Network profile showcase into the roster.

The showcase returns only those on display (usually 4–6), so the store is
accumulating: you rotate the showcase and the data piles up. A character
taken off the showcase stays, honestly marked with ``last_seen``.

Matching against the wiki data:

* **operator** — by ``variantId`` (only Endministrator has one, having two
  variants), otherwise by the ``skillId`` prefix like ``chr_0005_chen``. Both
  match the ``Id`` field from Cargo;
* **weapons and gear** — by the icon file name from the Enka dictionaries
  (``/ui/ef/wpn_sword_0021.png`` → ``wpn_sword_0021``), which matches the
  ``Id`` of the corresponding Cargo tables.

The result is written to ``roster/endfield.profile.yaml`` — a separate file,
so as not to overwrite the hand-written ``endfield.yaml`` with its comments.
When the roster is read, profile data takes priority and is marked as fact.

Usage::

    python3 tools/ef/profile.py fetch <UID>
    python3 tools/ef/profile.py fetch https://enka.network/ef/<UID>/
    python3 tools/ef/profile.py fetch <UID> --json   # a report for the app
    python3 tools/ef/profile.py show

``--json`` is for the app: the calculator's "update from Enka" button runs
exactly this command through the local dev server (`app/enka.ts`), so
showcase parsing stays in one place — here.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

import yaml

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from tools.common.profile import ProfileStore

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "data" / "endfield"
ROSTER_PROFILE = ROOT / "roster" / "endfield.profile.yaml"

API = "https://enka.network/api/ef/uid/{uid}"
STORE = "https://raw.githubusercontent.com/EnkaNetwork/API-docs/master/store/ef/{name}"
CACHE = DATA / "raw" / "enka"

USER_AGENT = "AndresBench/0.1 (Endfield damage calculator; +https://github.com/andresbench/calculator)"

# Internal skill names → the types the rotation notation works with.
SKILL_KINDS = {
    "NormalAttack": "basic",
    "NormalSkill": "battle",
    "ComboSkill": "combo",
    "UltimateSkill": "ultimate",
}


# The Endfield showcase on the site: https://enka.network/ef/<UID>/ (checked
# 2026-10-29). An Enka account link (`/u/<user>/<hash>/`) is something else:
# it lists linked game profiles, not an Endfield showcase.
SHOWCASE_RE = re.compile(r"enka\.network/ef/(\d+)")
UID_RE = re.compile(r"\d{6,12}")

# Enka API response codes — from the API documentation page.
API_ERRORS = {
    400: "invalid UID format",
    404: "no player with this UID",
    424: "game maintenance, or Enka is updating after a patch — try later",
    429: "Enka rate-limited the requests — wait a minute",
    500: "an error on Enka's side",
    503: "Enka is temporarily unavailable",
}


class ImportFailure(Exception):
    """The import failed. ``code`` is for the app, the text for a human."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def parse_source(value: str) -> str:
    """A UID from a showcase link or from a bare number."""
    text = (value or "").strip()
    if UID_RE.fullmatch(text):
        return text
    match = SHOWCASE_RE.search(text)
    if match:
        return match.group(1)
    if "enka.network/u/" in text:
        raise ImportFailure(
            "account_link",
            "this is an Enka account link, but an Endfield showcase is needed: "
            "https://enka.network/ef/<UID>/",
        )
    raise ImportFailure("bad_source", "need a UID or a link like https://enka.network/ef/<UID>/")


def get(url: str) -> bytes:
    request = urllib.request.Request(url)
    request.add_header("User-Agent", USER_AGENT)
    with urllib.request.urlopen(request, timeout=40) as response:
        return response.read()


def load_store(name: str, refresh: bool = False):
    """Enka dictionaries with an on-disk cache."""
    CACHE.mkdir(parents=True, exist_ok=True)
    path = CACHE / name
    if refresh or not path.exists():
        path.write_bytes(get(STORE.format(name=name)))
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


def icon_key(value: str) -> str | None:
    match = re.search(r"/([A-Za-z0-9_]+)\.png", value or "")
    return match.group(1) if match else None


def load_db() -> dict:
    def read(name):
        with (DATA / name).open(encoding="utf-8") as handle:
            return json.load(handle)

    operators = read("operators.json")
    weapons = read("weapons.json")
    gear = read("gear.json")["pieces"]
    return {
        "operators": operators,
        "operator_by_id": {o["id"]: key for key, o in operators.items() if o.get("id")},
        "weapon_by_id": {w["id"]: w["name"] for w in weapons.values() if w.get("id")},
        "gear_by_id": {},  # filled from Cargo below
        "gear": gear,
    }


def gear_index() -> dict[str, str]:
    path = DATA / "raw" / "cargo" / "Gears.json"
    if not path.exists():
        return {}
    with path.open(encoding="utf-8") as handle:
        rows = json.load(handle)
    return {row["Id"]: (row.get("Gear") or row["_pageName"]) for row in rows if row.get("Id")}


def identify_operator(char: dict, operator_by_id: dict) -> str | None:
    variant = char.get("variantId")
    if variant and variant in operator_by_id:
        return operator_by_id[variant]
    # Most operators have no variantId — identified by the skillId prefix.
    for entry in (char.get("skillInfo") or {}).get("levelInfo", []):
        match = re.match(r"(chr_\d+_[a-z0-9]+)", entry.get("skillId", ""))
        if match and match.group(1) in operator_by_id:
            return operator_by_id[match.group(1)]
    return None


def extract(char: dict, db: dict, weapons_store: dict, equips_store: dict,
            gear_names: dict) -> dict | None:
    key = identify_operator(char, db["operator_by_id"])
    if key is None:
        return None

    record: dict = {
        "key": key,
        "level": char.get("level"),
        "potential": char.get("potentialLevel"),
    }

    skills: dict[str, int] = {}
    for entry in (char.get("skillInfo") or {}).get("levelInfo", []):
        for suffix, kind in SKILL_KINDS.items():
            if entry.get("skillId", "").endswith(suffix):
                skills[kind] = entry.get("skillLevel")
    if skills:
        record["skills"] = skills

    # Talent nodes are unlocked one by one, apart from elite: Argent Flow at
    # Elite 4 had no attribute node open (`attrNodes: []`), and his stat
    # screen showed Will 60 lower than the elite would give (measurements,
    # #59). `attrNodes` — the attribute talent's tiers, one node each;
    # `latestPassiveSkillNodes` — `…passive_skill_<talent>_<tier>`.
    talent = char.get("talent") or {}
    if talent:
        passive: dict[str, int] = {}
        for node in talent.get("latestPassiveSkillNodes") or []:
            found = re.search(r"passive_skill_(\d+)_(\d+)$", node)
            if found:
                passive[found[1]] = max(passive.get(found[1], 0), int(found[2]))
        record["talentNodes"] = {
            "attribute": len(talent.get("attrNodes") or []),
            "passive": [passive.get(str(index), 0) for index in range(max((int(k) + 1 for k in passive), default=0))],
        }

    weapon = char.get("weapon") or {}
    if weapon.get("templateId") is not None:
        meta = weapons_store.get(str(weapon["templateId"])) or {}
        name = db["weapon_by_id"].get(icon_key(meta.get("Icon", "")))
        record["weapon"] = {
            "name": name,
            "level": weapon.get("weaponLv"),
            # refineLv is the refinement rank; the game counts from 1, the API from 0.
            "rank": (weapon.get("refineLv") or 0) + 1,
            "breakthrough": weapon.get("breakthroughLv"),
            "template_id": weapon["templateId"],
        }
        # The essence (attachedGem in the API). Found 2026-09-12: it is what
        # sets the weapon skills' LEVEL, i.e. that column out of nine the
        # project kept trying to derive from rank and ascension. The rule
        # "column = rank + ascension" was refuted by measurement.
        #
        # From the Weapon page: «Each Essence carries several potential Weapon
        # Skill upgrades. Infusing a Weapon with an Essence will increase the
        # level of the Weapon Skills that MATCH the ones from the Essence».
        # So a term applies only if it matches a weapon skill, and terms do
        # not line up by position — checking snapshots gave 10 conflicts over
        # 25 operators. So the raw data is stored, and matching a term to a
        # skill is not invented.
        gem = weapon.get("attachedGem") or {}
        if gem:
            record["weapon"]["essence"] = {
                "template_id": gem.get("templateId"),
                "domain_id": gem.get("domainId"),
                "total_cost": gem.get("totalCost"),
                "terms": [
                    {"term": term.get("termNumId"), "cost": term.get("cost")}
                    for term in gem.get("terms") or []
                ],
            }
        if name is None:
            record["weapon"]["unresolved"] = True

    items = equips_store.get("Items", {})
    pieces = []
    for slot in char.get("equip") or []:
        value = slot.get("value") or {}
        template = value.get("templateid")
        if template is None:
            continue
        meta = items.get(str(template)) or {}
        gear_id = icon_key(meta.get("Icon", ""))
        pieces.append(
            {
                "slot": slot.get("key"),
                "name": gear_names.get(gear_id),
                "set": meta.get("SuitId"),
                "template_id": template,
                **({"unresolved": True} if gear_id not in gear_names else {}),
            }
        )
    if pieces:
        record["gear"] = pieces

    return record


SHOWCASE_TABLES = DATA / "showcase_tables.json"
PARITY_CASES = ROOT / "engine" / "test" / "fixtures" / "showcase-parity.json"


def showcase_tables(refresh_store: bool = False) -> dict:
    """What the browser needs to read a showcase on its own (PUBLISH_PLAN, П6).

    The site gets the showcase through the Enka proxy and reads it in the
    page; every decision that takes data stays here and goes out as a table:
    Enka's weapon and gear ``templateId`` → our names (through the icon file
    name, as ``extract`` does), the essence term families and the column
    rule's offset (``weapon.py``), the skill suffixes. Operators need no
    table: the bundle carries each one's Cargo ``id``.

    The engine's ``showcase.ts`` reads a showcase with these tables, and
    ``showcase-parity.json`` (``parity``) holds it to ``extract`` here.
    """
    from tools.ef.weapon import STAT_COLUMN_OFFSET, TERM_FAMILIES

    db = load_db()
    gear_names = gear_index()
    weapons_store = load_store("weapons.json", refresh_store)
    equips_store = load_store("equips.json", refresh_store)
    weapons = {}
    for template, meta in weapons_store.items():
        name = db["weapon_by_id"].get(icon_key(meta.get("Icon", "")))
        if name:
            weapons[str(template)] = name
    gear = {}
    for template, meta in (equips_store.get("Items") or {}).items():
        gear_id = icon_key(meta.get("Icon", ""))
        if gear_id in gear_names:
            gear[str(template)] = {"name": gear_names[gear_id], "set": meta.get("SuitId")}
    return {
        "source": "Enka.Network store (EnkaNetwork/API-docs, store/ef) matched to the wiki's Cargo ids",
        "weapons": dict(sorted(weapons.items(), key=lambda item: int(item[0]))),
        "gear": dict(sorted(gear.items(), key=lambda item: int(item[0]))),
        "skillKinds": SKILL_KINDS,
        "termFamilies": {str(term): {"family": family, "confidence": confidence}
                         for term, (family, confidence) in TERM_FAMILIES.items()},
        "statColumnOffset": STAT_COLUMN_OFFSET,
    }


def cmd_tables(args) -> int:
    tables = showcase_tables(args.refresh_store)
    SHOWCASE_TABLES.write_text(json.dumps(tables, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"{SHOWCASE_TABLES.relative_to(ROOT)}: {len(tables['weapons'])} weapons, {len(tables['gear'])} gear pieces")
    return 0


def parity_cases(seed: int = 7) -> list[dict]:
    """Synthetic showcase characters and what ``extract`` makes of them.

    The browser reads a showcase in TypeScript (``engine/src/showcase.ts``);
    this is the other implementation's answer key, as the `.rot` parsers keep
    each other honest. Synthetic, so no account is in the repository: every
    operator, with a weapon of their type, an essence (known terms, one taken
    by position, none), gear including an unknown piece, talent nodes. The
    weapon columns are what ``export.py`` puts in the roster.
    """
    import random

    from tools.ef.export import weapon_columns

    rng = random.Random(seed)
    db = load_db()
    gear_names = gear_index()
    weapons_store = load_store("weapons.json")
    equips_store = load_store("equips.json")
    weapons_raw = json.loads((DATA / "weapons.json").read_text(encoding="utf-8"))
    tables = showcase_tables()
    from tools.ef.weapon import TERM_FAMILIES

    by_type: dict[str, list[str]] = {}
    for template, name in tables["weapons"].items():
        by_type.setdefault(weapons_raw.get(name, {}).get("type", ""), []).append(template)
    gear_by_type: dict[str, list[str]] = {}
    for template, item in tables["gear"].items():
        kind = (db["gear"].get(item["name"]) or {}).get("type")
        gear_by_type.setdefault(kind or "", []).append(template)
    terms = sorted(TERM_FAMILIES)

    cases = []
    for key, operator in sorted(db["operators"].items()):
        cargo = operator.get("id")
        if not cargo or operator.get("upcoming"):
            continue
        variant = cargo if key.startswith("Endministrator") else None
        prefix = "chr_9000_endmin" if variant else cargo
        char: dict = {
            "templateId": rng.randint(1, 99),
            "level": rng.choice([60, 70, 80, 90]),
            "potentialLevel": rng.randint(0, 5),
            "skillInfo": {"levelInfo": [
                {"skillId": f"{prefix}_{suffix}", "skillLevel": rng.randint(1, 12)} for suffix in SKILL_KINDS
            ] + [{"skillId": f"{prefix}_talent_0", "skillLevel": 1}]},
            "talent": {
                "attrNodes": [f"{prefix}_{n}" for n in range(rng.randint(0, 4))],
                "latestPassiveSkillNodes": [f"{prefix}_passive_skill_{t}_{rng.randint(1, 3)}" for t in range(rng.randint(0, 2))],
            },
        }
        if variant:
            char["variantId"] = variant
        pool = by_type.get(operator.get("weapon_type") or operator.get("weaponType") or "", [])
        if pool:
            gem_kind = rng.choice(["known", "known", "unknown-term", "none"])
            weapon = {"templateId": int(rng.choice(pool)), "weaponLv": rng.choice([60, 80, 90]),
                      "refineLv": rng.randint(0, 4), "breakthroughLv": 4}
            if gem_kind != "none":
                # Mostly terms of the weapon's own families, so the matching is exercised.
                record = weapons_raw.get(tables["weapons"][str(weapon["templateId"])], {})
                families = {c.get("tag") for c in record.get("skill_components", [])}
                own = [t for t in terms if TERM_FAMILIES[t][0] in families]
                chosen = (own + rng.sample([t for t in terms if t not in own], 3))[:3]
                rng.shuffle(chosen)
                if gem_kind == "unknown-term":
                    chosen[rng.randint(0, 2)] = 999
                weapon["attachedGem"] = {"templateId": 1070, "domainId": 1, "totalCost": 0,
                                         "terms": [{"termNumId": t, "cost": rng.randint(1, 6)} for t in chosen]}
            char["weapon"] = weapon
        # Enka's slots are 0–3: gloves, armor, kit, kit (``build.ts: SLOT_NAMES``).
        equip = []
        for slot, kind in enumerate(["Gloves", "Armor", "Kit", "Kit"]):
            choices = gear_by_type.get(kind, [])
            if choices:
                equip.append({"key": slot, "value": {"templateid": int(rng.choice(choices))}})
        if equip and rng.random() < 0.3:
            equip[-1]["value"]["templateid"] = 999999  # a piece newer than the data
        char["equip"] = equip

        record = extract(char, db, weapons_store, equips_store, gear_names)
        if record is not None and record.get("weapon"):
            record["weapon"]["columns"] = weapon_columns(weapons_raw, record["weapon"])
        cases.append({"operator": key, "char": char, "expected": record})
    unknown = {"templateId": 1, "level": 90, "potentialLevel": 0, "skillInfo": {"levelInfo": [{"skillId": "chr_9999_nobody_NormalSkill", "skillLevel": 3}]}}
    cases.append({"operator": None, "char": unknown, "expected": extract(unknown, db, weapons_store, equips_store, gear_names)})
    return cases


def cmd_parity(args) -> int:
    cases = parity_cases()
    PARITY_CASES.write_text(json.dumps({"cases": cases}, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"{PARITY_CASES.relative_to(ROOT)}: {len(cases)} cases")
    return 0


def fetch(uid: str, refresh_store: bool = False, say=print) -> dict:
    """Fetch the showcase, merge it into the accumulating store, rewrite the roster.

    Returns a report: who is on the showcase, what is new, what is not
    recognised. Network and API errors are ``ImportFailure`` with a code and
    human-readable text.
    """
    db = load_db()
    gear_names = gear_index()
    weapons_store = load_store("weapons.json", refresh_store)
    equips_store = load_store("equips.json", refresh_store)

    say(f"Requesting the showcase of UID {uid}…")
    try:
        payload = json.loads(get(API.format(uid=uid)))
    except urllib.error.HTTPError as error:
        reason = API_ERRORS.get(error.code, error.reason)
        raise ImportFailure(f"http_{error.code}", f"Enka answered {error.code}: {reason}") from error
    except urllib.error.URLError as error:
        raise ImportFailure("network", f"could not reach Enka: {error.reason}") from error

    store = ProfileStore(DATA, uid)
    snapshot = store.save_snapshot(payload)
    say(f"  snapshot saved: {snapshot.name} (snapshots in total: {store.snapshot_count()})")

    characters = payload.get("playerInfo", {}).get("charData", [])
    say(f"  on the showcase: {len(characters)}")

    extracted: dict[str, dict] = {}
    unknown = []
    for char in characters:
        record = extract(char, db, weapons_store, equips_store, gear_names)
        if record is None:
            unknown.append(char.get("templateId"))
            continue
        extracted[record["key"]] = record
    if unknown:
        say(f"  ! unrecognised templateId: {unknown}")

    report = store.merge(extracted)
    say(store.report_text(report))

    write_roster_profile(store.load(), db)
    say(f"\nWritten: {ROSTER_PROFILE.relative_to(ROOT)}")

    # Weapons and gear missing from the wiki data: the showcase is newer than the wiki snapshot.
    unresolved = sorted(
        {
            f"{record['key']}: weapon templateId {record['weapon']['template_id']}"
            for record in extracted.values()
            if (record.get("weapon") or {}).get("unresolved")
        }
        | {
            f"{record['key']}: gear templateId {piece['template_id']}"
            for record in extracted.values()
            for piece in record.get("gear") or []
            if piece.get("unresolved")
        }
    )
    card = (payload.get("playerInfo") or {}).get("businessCard") or {}
    return {
        "uid": uid,
        "nickname": card.get("name"),
        # How many seconds Enka caches the response: a showcase changed in
        # game cannot be seen earlier.
        "ttl": payload.get("ttl"),
        "snapshot": snapshot.name,
        "showcase": sorted(extracted),
        "new": report["new"],
        "changed": report["changed"],
        "unchanged": report["unchanged"],
        "kept": report["kept"],
        "unknown": unknown,
        "unresolved": unresolved,
    }


def cmd_fetch(args) -> int:
    # In --json mode all human text goes to stderr, and stdout gets exactly
    # one JSON: the app's dev server reads it.
    say = (lambda text: print(text, file=sys.stderr)) if args.json else print
    try:
        uid = parse_source(args.source)
        report = fetch(uid, args.refresh_store, say)
    except ImportFailure as error:
        if args.json:
            print(json.dumps({"ok": False, "code": error.code, "error": str(error)}, ensure_ascii=False))
        else:
            print(f"! {error}")
        return 1
    if args.json:
        print(json.dumps({"ok": True, **report}, ensure_ascii=False))
    return 0


def write_roster_profile(accumulated: dict, db: dict) -> None:
    """Accumulated → the YAML that is merged into the roster."""
    operators: dict[str, dict] = {}
    for key, record in sorted(accumulated.items()):
        entry = {k: v for k, v in record.items()
                 if k not in ("key", "first_seen", "last_seen")}
        entry["_seen"] = record.get("last_seen")
        operators[db["operators"][key]["name"]] = entry

    payload = {
        "meta": {
            "source": "enka.network",
            "note": "This file is generated by tools/ef/profile.py. Edit not here "
                    "but roster/endfield.yaml — the hand-written roster has its own fields.",
        },
        "operators": operators,
    }
    ROSTER_PROFILE.parent.mkdir(parents=True, exist_ok=True)
    with ROSTER_PROFILE.open("w", encoding="utf-8") as handle:
        yaml.safe_dump(payload, handle, allow_unicode=True, sort_keys=False, width=100)


def talent_nodes_from_snapshots(uid: str) -> dict[str, dict]:
    """Each character's talent nodes from the latest snapshot that shows them.

    Older imports did not keep them; the snapshots did. Only the talent part
    is read, so a gear or weapon change since then is not touched.
    """
    db = load_db()
    gear_names = gear_index()
    weapons_store = load_store("weapons.json")
    equips_store = load_store("equips.json")
    store = ProfileStore(DATA, uid)
    latest: dict[str, dict] = {}
    for path in sorted(store.snapshots.glob("*.json")):
        payload = json.loads(path.read_text(encoding="utf-8"))
        for char in payload.get("playerInfo", {}).get("charData", []):
            record = extract(char, db, weapons_store, equips_store, gear_names)
            if record and record.get("talentNodes"):
                latest[record["key"]] = record["talentNodes"]
    return latest


def cmd_backfill_talents(args) -> int:
    store = ProfileStore(DATA, args.uid)
    stored = store.load()
    found = talent_nodes_from_snapshots(args.uid)
    filled = []
    for key, nodes in found.items():
        if key in stored and "talentNodes" not in stored[key]:
            stored[key]["talentNodes"] = nodes
            filled.append(key)
    with store.characters_path.open("w", encoding="utf-8") as handle:
        json.dump(stored, handle, ensure_ascii=False, indent=1, sort_keys=True)
    write_roster_profile(stored, load_db())
    print(f"talent nodes filled from snapshots: {len(filled)} — {', '.join(sorted(filled)) or 'none'}")
    partial = sorted(key for key, rec in stored.items() if (rec.get("talentNodes") or {}).get("attribute", 4) < 4)
    print(f"attribute talent not fully open: {', '.join(partial) or 'nobody'}")
    return 0


def cmd_check(args) -> int:
    """Hints at where set and weapon conditions disagree with the kit.

    Set bonuses and weapon skills are almost always conditional: "on applying
    Crush", "after recovering SP", "when applying a Physical Status". If the
    operator does not do that, the bonus is dead weight, and it is hard to
    notice by reading descriptions.

    ⚠️ This is a HINT, not a verdict. Parsing the conditions rests on regexes
    over the English text and is knowingly imprecise:

    * a TEAMMATE may meet the condition, while the check looks only at the
      operator (Camille applies Heat Infliction, but Combustion happens only
      if someone else applies another element);
    * some of the terms mentioned are description, not a condition
      ("stacks consumed");
    * bonus conditions "×1.5 if …" cannot be told from mandatory ones.

    Every flag must be checked by eye against the effect text.
    """
    from collections import Counter

    from tools.ef.rotation import load_implications, requirement_groups
    from tools.ef.synergy import build_index
    from tools.ef.synergy import load_aliases as load_term_aliases

    if not ROSTER_PROFILE.exists():
        print("No profile imported.")
        return 1
    with ROSTER_PROFILE.open(encoding="utf-8") as handle:
        profile = (yaml.safe_load(handle) or {}).get("operators") or {}

    db = load_db()
    index = build_index(db["operators"])
    by_name = {o["name"]: key for key, o in db["operators"].items()}

    with (DATA / "gear.json").open(encoding="utf-8") as handle:
        gear = json.load(handle)
    with (DATA / "weapons.json").open(encoding="utf-8") as handle:
        weapons = json.load(handle)

    set_of = {name: piece.get("set") for name, piece in gear["pieces"].items()}

    implications = load_implications()
    term_aliases = load_term_aliases()
    vocabulary = {t for e in index.values() for t in e["capabilities"]}

    def capabilities(key):
        """What the operator does — together with the consequences.

        Applying Lift also applies Vulnerable and a Physical Status. Without
        expanding consequences the check complains about perfectly correct
        builds.
        """
        caps = index.get(key, {}).get("capabilities", {})
        direct = {term for term, rel in caps.items()
                  if "applies" in rel or "consumes" in rel}
        expanded = set(direct)
        queue = list(direct)
        while queue:
            term = queue.pop()
            for implied in implications.get(term, ()):
                if implied not in expanded:
                    expanded.add(implied)
                    queue.append(implied)
        return expanded

    def unmet(text, mine):
        """Requirement groups none of which the operator meets.

        Grouping by "or" is the same as in the rotation validator: the condition
        "on applying Crush OR Breach" is met by either of the two.
        """
        groups = requirement_groups(text or "", vocabulary, term_aliases)
        # The same term is often named several times in an effect; the check
        # cares about the set of conditions, not the number of mentions.
        unique, seen = [], set()
        for group in groups:
            marker = frozenset(group)
            if marker not in seen:
                seen.add(marker)
                unique.append(group)
        return [g for g in unique if not (set(g) & mine)], unique

    for name, entry in sorted(profile.items()):
        key = by_name.get(name)
        if key is None:
            continue
        mine = capabilities(key)
        print(f"=== {name}")

        counts = Counter(set_of.get(g.get("name")) for g in entry.get("gear") or [])
        active = [s for s, n in counts.items() if s and n >= 3]
        if not active:
            print(f"    gear: 3-piece NOT ASSEMBLED — {dict(counts)}")
        for set_name in active:
            record = gear["sets"].get(set_name) or {}
            effect = record.get("text", "")
            if not record.get("effect_known", True):
                print(f"    set {set_name} (3-piece) ✗ effect unknown — no page on the wiki")
                continue
            if record.get("disputed"):
                print(f"    set {set_name} (3-piece) ✗ effect text is questionable")
                print(f"        {record.get('_override', 'see data/endfield/overrides.json')}")
                continue
            missing, groups = unmet(effect, mine)
            mark = "⚠ check" if missing else "✓"
            print(f"    set {set_name} (3-piece) {mark}")
            if groups:
                shown = " + ".join(" or ".join(g) for g in groups)
                print(f"        conditions: {shown}")
            for group in missing:
                print(f"        the operator does not do: {' or '.join(group)}")

        weapon = entry.get("weapon") or {}
        record = weapons.get(weapon.get("name") or "")
        if record:
            for comp in record.get("skill_components", []):
                text = comp.get("text_template", "")
                missing, groups = unmet(text, mine)
                if not groups:
                    continue
                mark = "⚠" if missing else "✓"
                print(f"    weapon {weapon['name']} rank {weapon.get('rank')} {mark} "
                      f"{comp['key']}")
                shown = " + ".join(" or ".join(g) for g in groups)
                print(f"        conditions: {shown}")
                for group in missing:
                    print(f"        the operator does not do: {' or '.join(group)}")
        print()
    return 0


def cmd_show(args) -> int:
    if not ROSTER_PROFILE.exists():
        print("No profile imported yet. Run: tools/ef/profile.py fetch <UID>")
        return 1
    with ROSTER_PROFILE.open(encoding="utf-8") as handle:
        data = yaml.safe_load(handle)

    operators = data.get("operators") or {}
    print(f"Operators imported: {len(operators)}\n")
    for name, entry in operators.items():
        weapon = entry.get("weapon") or {}
        skills = entry.get("skills") or {}
        print(f"  {name:16} lv.{entry.get('level')} pot.{entry.get('potential')}")
        if weapon:
            print(f"      weapon: {weapon.get('name') or '?'} "
                  f"lv.{weapon.get('level')} rank {weapon.get('rank')}")
        if skills:
            print("      skills: " + ", ".join(f"{k} {v}" for k, v in skills.items()))
        gear = entry.get("gear") or []
        if gear:
            names = [g.get("name") or "?" for g in gear]
            print(f"      gear ({len(gear)}): {', '.join(names)}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)

    p_fetch = sub.add_parser("fetch", help="fetch the showcase and merge it into the roster")
    p_fetch.add_argument("source", help="a UID or a link https://enka.network/ef/<UID>/")
    p_fetch.add_argument("--refresh-store", action="store_true",
                         help="re-download the Enka dictionaries")
    p_fetch.add_argument("--json", action="store_true",
                         help="the report as one JSON on stdout, text on stderr")
    p_fetch.set_defaults(func=cmd_fetch)

    p_backfill = sub.add_parser("backfill-talents", help="fill talent nodes from saved snapshots")
    p_backfill.add_argument("uid")
    p_backfill.set_defaults(func=cmd_backfill_talents)

    p_check = sub.add_parser("check", help="whether set and weapon conditions match the kit")
    p_check.set_defaults(func=cmd_check)

    p_show = sub.add_parser("show", help="show what was imported")
    p_show.set_defaults(func=cmd_show)

    p_tables = sub.add_parser("tables", help="tables for reading a showcase in the browser → data/endfield/showcase_tables.json")
    p_tables.add_argument("--refresh-store", action="store_true", help="re-download the Enka dictionaries")
    p_tables.set_defaults(func=cmd_tables)

    p_parity = sub.add_parser("parity", help="synthetic showcases and extract's answers → engine/test/fixtures/showcase-parity.json")
    p_parity.set_defaults(func=cmd_parity)

    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
