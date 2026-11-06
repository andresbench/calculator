#!/usr/bin/env python3
"""Arknights: Endfield datamine — a pinned clone of someone else's repository.

The wiki stays the main source (fetch → parse → render), and the datamine is
an independent cross-check. The wiki's Cargo table is filled from the same
page's infobox and is not an independent source; a client dump is. But it is
not the truth either: fields carry names from the game's code, and a field's
name does not prove what it does. A field's meaning is settled by a
measurement or by checking against something already measured (see
``tools/ef/frames.py``).

What this is not: an unpacker. The client is unpacked by someone else's
script (rmxlinux/EndfieldData, updated by hand every week or two); we only
keep a pin. If the source stalls, a Linux unpacker is
https://github.com/EIHRTeam/EndfieldStudio (``endfield-dump``, .NET 9).

The dump is proprietary game data, and the repository has no licence. So the
clone is not versioned (``data/*/upstream/`` is in ``.gitignore``); only our
conclusions go into the repository, with a reference to the pin.

Usage::

    python3 tools/ef/sync.py            # bring to the pin (first time — clone)
    python3 tools/ef/sync.py --status   # what is pinned, what is upstream
    python3 tools/ef/sync.py --update   # move the pin to the head and show the diff
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from tools.common.upstream import Source, run

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "data" / "endfield"
CLONES = DATA / "upstream"
PINS = DATA / "upstream.json"


SOURCES: dict[str, Source] = {
    "endfield-data": Source(
        url="https://github.com/rmxlinux/EndfieldData.git",
        sparse=[
            # Every table: BattleConst, CharacterTable, CharGrowthTable,
            # SkillPatchTable, AttributeMetaTable, enemies, gear, weapons.
            "TableCfg",
            # Skills with a timeline in frames (30 per second): when damage
            # lands, when buffs apply, from which frame the next action is allowed.
            "Json/SkillData",
            # Buffs: attribute modifiers with their stage type, stacks, durations.
            "Json/BuffData",
            # Clip lengths — a cross-check of the timeline frame rate.
            "Json/AnimationConfig",
        ],
        note="client dump (rmxlinux); no licence, not versioned",
        watch=["TableCfg", "Json/SkillData", "Json/BuffData"],
    ),
}


def main() -> int:
    return run("Arknights: Endfield → datamine", __doc__, SOURCES, CLONES, PINS, ROOT)


if __name__ == "__main__":
    raise SystemExit(main())
