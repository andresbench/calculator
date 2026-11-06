#!/usr/bin/env python3
"""Wiki icons for the web app.

The file list is not written by hand but **derived from the already parsed
data**: an operator contributes its name, skills and talents their ``icon``
field, weapons and gear the item name. So a new operator picks up its icons
after ``parse.py`` by itself, with no edit to this file.

The naming convention on endfield.wiki.gg (checked 2026-09-12):

===========================  =========================================
``File:Chen Qianyu icon.png``  operator, weapon, gear item, mechanic
``File:Skill-Chen.png``        battle skill    (from the ``icon`` field)
``File:Combo-Chen.png``        combo skill     (from the ``icon`` field)
``File:Ult-Chen.png``          ultimate        (from the ``icon`` field)
``File:Attack-Sword.png``      basic attack, shared per weapon type
``File:Chen Talent 1 icon.png`` talent         (from the ``icon`` field)
``File:Physical.png``          element
``File:Vanguard.png``          class
===========================  =========================================

Freshness is the content's ``sha1``: files have no revid of their own. A
repeat run downloads only what changed.

Licence: the icons are game assets © GRYPHLINE / Hypergryph, downloaded from
the wiki; they are not the wiki's CC BY-SA content and are not committed (see
NOTICE). The source link of every icon stays in
``_manifest.json``.

Usage::

    python3 tools/ef/icons.py            # incremental
    python3 tools/ef/icons.py --force    # download everything again
    python3 tools/ef/icons.py --dry-run  # only show what is needed
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from tools.common.mwapi import MWClient
from tools.common.store import RawStore

API = "https://endfield.wiki.gg/api.php"
ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "data" / "endfield"


def _load(name: str) -> dict:
    path = DATA / name
    if not path.exists():
        raise SystemExit(f"missing {path} — run tools/ef/parse.py first")
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


def wanted() -> dict[str, str]:
    """{wiki file title: subdirectory in img/}.

    The subdirectory is the icon's "kind"; the app addresses an icon by the
    pair (kind, entity key), so the layout must be stable.
    """
    operators = _load("operators.json")
    weapons = _load("weapons.json")
    gear = _load("gear.json")
    mechanics = _load("mechanics.json")

    files: dict[str, str] = {}

    for record in operators.values():
        files[f"File:{record['name']} icon.png"] = "operators"
        for skill in record.get("skills", []):
            if skill.get("icon"):
                files[f"File:{skill['icon']}.png"] = "skills"
        for talent in record.get("talents", []):
            if talent.get("icon"):
                files[f"File:{talent['icon']}.png"] = "talents"
        if record.get("element"):
            files[f"File:{record['element']}.png"] = "elements"
        if record.get("class"):
            files[f"File:{record['class']}.png"] = "classes"

    for record in weapons.values():
        files[f"File:{record['name']} icon.png"] = "weapons"

    for record in gear.get("pieces", {}).values():
        files[f"File:{record['name']} icon.png"] = "gear"

    for name in mechanics:
        files[f"File:{name} icon.png"] = "mechanics"

    return files


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--force", action="store_true", help="download everything again")
    parser.add_argument("--dry-run", action="store_true", help="only show the list")
    parser.add_argument("--delay", type=float, default=0.4)
    args = parser.parse_args()

    files = wanted()
    by_kind: dict[str, int] = {}
    for kind in files.values():
        by_kind[kind] = by_kind.get(kind, 0) + 1
    print("Endfield icons → endfield.wiki.gg")
    print(f"  files needed: {len(files)}")
    for kind, count in sorted(by_kind.items()):
        print(f"    {kind:12s} {count}")

    if args.dry_run:
        for title in sorted(files)[:20]:
            print(f"    {title}")
        return 0

    client = MWClient(API, delay=args.delay)
    store = RawStore(DATA)

    print("\n  asking for metadata…")
    info = client.image_info(sorted(files))
    missing = sorted(set(files) - set(info))
    print(f"    known to the wiki: {len(info)}, missing from the wiki: {len(missing)}")
    if missing:
        # Not an error: some entities simply have no icon on the wiki (stub
        # pages, mechanics without a file of their own). The app must survive a
        # missing icon rather than crash.
        for title in missing[:10]:
            print(f"      ! {title}")
        if len(missing) > 10:
            print(f"      … and {len(missing) - 10} more")

    stale = [
        title
        for title, item in info.items()
        if args.force or not store.is_current_asset(f"img:{title}", item.get("sha1"))
    ]
    print(f"    to download: {len(stale)} (the rest is unchanged)")

    total = 0
    for index, title in enumerate(sorted(stale), 1):
        item = info[title]
        try:
            body = client.download(item["url"])
        except Exception as exc:  # noqa: BLE001 — one file must not bring down the run
            print(f"    ! {title}: {exc}")
            continue
        store.save_asset(
            title,
            body,
            kind=files[title],
            sha1=item.get("sha1"),
            meta={
                "source_url": item["url"],
                "width": item.get("width"),
                "height": item.get("height"),
                "mime": item.get("mime"),
            },
        )
        total += len(body)
        if index % 50 == 0 or index == len(stale):
            print(f"      {index}/{len(stale)}  ({total / 1024:.0f} KB)")

    store.flush()
    missing_path = DATA / "img" / "_missing.json"
    missing_path.parent.mkdir(parents=True, exist_ok=True)
    with missing_path.open("w", encoding="utf-8") as handle:
        json.dump(missing, handle, ensure_ascii=False, indent=1)

    print(f"\nDone. Requests: {client.request_count}, downloaded {total / 1024:.0f} KB")
    print(f"Icons: {DATA / 'img'}")
    print(f"Missing from the wiki: {missing_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
