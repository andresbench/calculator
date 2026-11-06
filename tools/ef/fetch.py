#!/usr/bin/env python3
"""Phase 1: downloading raw Arknights: Endfield data from endfield.wiki.gg.

Sources, from most to least convenient:

1. The Cargo API — structured tables (operators, weapons, gear, enemies…).
   The schema comes from the ``Template:<Table>/CargoDeclare`` templates: they
   list every field, while ``Special:CargoTables`` shows the list truncated.
2. Raw wikitext of operator pages — stat curves, skills with tables over 12
   levels, talents and potentials, laid out in templates.
3. Lua modules — the mechanics glossary and auxiliary data.
4. Mechanic pages — the damage formula and everything around it.
5. Factory pages — AIC buildings and mechanics (flow, environments).

Usage::

    python3 tools/ef/fetch.py            # incremental
    python3 tools/ef/fetch.py --force    # download everything again
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from tools.common.mwapi import MWClient
from tools.common.store import PageFetcher, RawStore
from tools.common.wikitext import (
    cargo_fields_from_html,
    cargo_tables_from_html,
    parse_cargo_declare,
)

API = "https://endfield.wiki.gg/api.php"
SPECIAL_CARGO_TABLES = "https://endfield.wiki.gg/wiki/Special:CargoTables"
ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "data" / "endfield"

# Mechanic pages. The damage formula is the calculator's specification; the
# rest explains the terms it operates on.
MECHANICS_PAGES = [
    "Damage calculation",
    "Combat Mechanic",
    "Element",
    "Physical Status",
    "Skill Points",
    "Stagger",
    "Ultimate Energy",
    "Attribute",
    "Arts Intensity",
    "Critical Rate",
    "Weapon",
    "Class",
    "Operator",
]

MECHANICS_CATEGORIES = [
    "Combat Mechanics",
    "Physical Status",
    "Arts Reactions",
    "Arts Inflictions",
    "Arts Bursts",
]

# Tables whose pages are worth fetching as wikitext too: Cargo holds the
# numbers, while effect and skill descriptions live in the page text.
PAGE_SOURCE_TABLES = {
    "operators": ("Operators", "Operator"),
    "weapons": ("Weapons", "Weapon"),
    "gear_sets": ("GearSets", "GearSet"),
    # The gear item pages themselves. Each carries a `seteffect` field in the
    # `Gear data` template — a second, independent source of the set bonus
    # text. It is needed not for completeness: set pages are updated less
    # often than item pages and drift from them (Frontiers — 14 items with one
    # text against a set page with someone else's, copied from Hot Work). And
    # a set may have no page of its own at all — that is how Deep Rampart got
    # lost.
    "gear": ("Gears", "Gear"),
    "enemies": ("Enemies", "Enemy"),
    # Factory (AIC) buildings: power, unlock condition, usage notes. These
    # pages have no extraction rates — see below.
    "facilities": ("Facilities", "Facility"),
}

# Factory pages that are not buildings: pipe and belt throughput,
# environments, the tech tree, outposts.
FACTORY_PAGES = [
    "AIC Factory Plan",
    "Outpost",
    # Extraction rates live not on the miner, pump and extractor pages but
    # here: a low-purity deposit/vent is 10/min, high 20/min, a pump 60/min.
    "Item/Natural Resources",
]

FACTORY_CATEGORIES = [
    "AIC Mechanics",
    # Regional Development buildings (Purification Node etc.): they are not in
    # Cargo Facilities, do not count towards the building limit, and level up.
    "Facility (Regional Development)",
]


def discover_cargo_schemas(client: MWClient, store: RawStore) -> dict[str, list[dict]]:
    """Schemas of all Cargo tables: first from CargoDeclare, then from HTML."""
    print("  looking for CargoDeclare templates…")
    declare_titles = [
        title
        for title in client.allpages(namespace=10)
        if title.endswith("/CargoDeclare")
    ]
    print(f"    found {len(declare_titles)}")

    schemas: dict[str, list[dict]] = {}
    for title, page in client.page_content(declare_titles).items():
        table, fields = parse_cargo_declare(page["content"])
        if table and fields:
            schemas[table] = fields

    # The table list comes from Special:CargoTables — some tables are declared
    # by a Lua module rather than a template, and are not in schemas yet.
    import urllib.request

    request = urllib.request.Request(SPECIAL_CARGO_TABLES)
    request.add_header("User-Agent", client.user_agent)
    with urllib.request.urlopen(request, timeout=client.timeout) as response:
        html = response.read().decode("utf-8", errors="replace")

    all_tables = cargo_tables_from_html(html)
    missing = [t for t in all_tables if t not in schemas]
    if missing:
        print(f"    without CargoDeclare ({len(missing)}): {', '.join(missing)}")
        for table in missing:
            request = urllib.request.Request(f"{SPECIAL_CARGO_TABLES}/{table}")
            request.add_header("User-Agent", client.user_agent)
            with urllib.request.urlopen(request, timeout=client.timeout) as response:
                page_html = response.read().decode("utf-8", errors="replace")
            fields = cargo_fields_from_html(page_html)
            if fields:
                schemas[table] = fields

    schemas = {t: schemas[t] for t in sorted(schemas) if t in all_tables}
    store.save_dataset("_schemas", schemas)
    print(f"    schemas fetched: {len(schemas)}")
    return schemas


def _fetch_html(client: MWClient, url: str) -> str:
    import urllib.request

    request = urllib.request.Request(url)
    request.add_header("User-Agent", client.user_agent)
    with urllib.request.urlopen(request, timeout=client.timeout) as response:
        return response.read().decode("utf-8", errors="replace")


def _live_schema(client: MWClient, table: str) -> list[dict]:
    """The live table's schema from Special:CargoTables."""
    return cargo_fields_from_html(
        _fetch_html(client, f"{SPECIAL_CARGO_TABLES}/{table}")
    )


def dump_cargo_tables(
    client: MWClient, store: RawStore, schemas: dict[str, list[dict]]
) -> dict[str, list[dict]]:
    """Dumps whole tables.

    A CargoDeclare template does not always match the real table: the template
    may have been edited without recreating the table (that happened with
    ItemDescriptions, where the template has capitalised fields and the
    database lowercase ones). So on error the schema is re-requested from the
    table itself and the dump retried.
    """
    dumps: dict[str, list[dict]] = {}
    for table, fields in schemas.items():
        names = ["_pageName"] + [f["name"] for f in fields]
        rows = None
        for attempt, field_names in enumerate((names, None)):
            if field_names is None:
                live = _live_schema(client, table)
                if not live:
                    break
                field_names = ["_pageName"] + [f["name"] for f in live]
                if field_names == names:
                    break
                print(f"      the template schema did not fit, taking the live one: {table}")
                schemas[table] = live
            try:
                rows = client.cargo_query(tables=table, fields=",".join(field_names))
                break
            except Exception as exc:  # noqa: BLE001 — one table must not bring down the run
                if attempt == 1:
                    print(f"    ! {table}: {exc}")

        if rows is None:
            continue
        store.save_dataset(table, rows)
        dumps[table] = rows
        note = " (table is empty)" if not rows else ""
        print(f"    {table}: {len(rows)} rows{note}")

    store.save_dataset("_schemas", schemas)
    return dumps


def collect_page_titles(dumps: dict[str, list[dict]]) -> dict[str, list[str]]:
    """Pulls the real page titles out of the Cargo dumps.

    With ``--skip-cargo`` the tables are read from disk: skipping the dump means
    "do not re-download Cargo", not "do not download pages" — this flag used to
    silently disable the whole of step 2.
    """
    titles: dict[str, list[str]] = {}
    for kind, (table, _column) in PAGE_SOURCE_TABLES.items():
        rows = dumps.get(table)
        if rows is None:
            path = DATA / "raw" / "cargo" / f"{table}.json"
            rows = json.loads(path.read_text(encoding="utf-8")) if path.exists() else []
        names = {row.get("_pageName") for row in rows if row.get("_pageName")}
        titles[kind] = sorted(names)

    # Pipe, belt, Electric Nexus and PAC are buildings in meaning, but they are
    # not in the Facilities table: they are registered as items of type Facilities.
    items = dumps.get("Items")
    if items is None:
        path = DATA / "raw" / "cargo" / "Items.json"
        items = json.loads(path.read_text(encoding="utf-8")) if path.exists() else []
    extra = {row["_pageName"] for row in items
             if row.get("Type") == "Facilities" and row.get("_pageName")}
    titles["facilities"] = sorted(set(titles.get("facilities", [])) | extra)
    return titles


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--force", action="store_true", help="download everything again")
    parser.add_argument("--delay", type=float, default=1.0, help="pause between requests")
    parser.add_argument("--skip-cargo", action="store_true")
    args = parser.parse_args()

    client = MWClient(API, delay=args.delay)
    store = RawStore(DATA)
    fetcher = PageFetcher(client, store)

    print("Endfield → endfield.wiki.gg")

    dumps: dict[str, list[dict]] = {}
    if not args.skip_cargo:
        print("\n[1/5] Cargo")
        schemas = discover_cargo_schemas(client, store)
        dumps = dump_cargo_tables(client, store, schemas)

    print("\n[2/5] Operator, item and building pages")
    for kind, page_titles in collect_page_titles(dumps).items():
        if page_titles:
            fetcher.fetch(page_titles, kind, force=args.force)

    print("\n[3/5] Lua modules")
    modules = [
        title
        for title in client.allpages(namespace=828)
        if not title.endswith(("/doc", "/betatest"))
        and "/betatest/" not in title
        and "Sandbox" not in title
    ]
    fetcher.fetch(modules, "modules", force=args.force)

    print("\n[4/5] Mechanic pages")
    mechanics = set(MECHANICS_PAGES)
    for category in MECHANICS_CATEGORIES:
        for title in client.category_members(category):
            if not title.startswith("Category:"):
                mechanics.add(title)
    fetcher.fetch(mechanics, "mechanics", force=args.force)

    print("\n[5/5] Factory pages")
    factory = set(FACTORY_PAGES)
    for category in FACTORY_CATEGORIES:
        for title in client.category_members(category):
            if not title.startswith("Category:"):
                factory.add(title)
    fetcher.fetch(factory, "factory", force=args.force)

    store.flush()
    print(f"\nDone. API requests: {client.request_count}")
    print(store.report())
    print(f"Data: {DATA}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
