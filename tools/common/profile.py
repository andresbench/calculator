"""An accumulating store of a profile showcase.

A showcase API (Enka and the like) returns only the characters on display
right now — usually six. Sites such as zfae "remember" those seen earlier by
accumulating snapshots on their side. This does the same, locally.

Each game's response schema differs, so extracting characters lives in an
adapter: this module receives a ready ``{key: record}``, and the store deals
only with accumulation, history and diffs.

What it gives beyond a plain cache:

* the showcase can be rotated and the whole roster collected over several runs;
* raw snapshots are never overwritten, so it is visible what changed and when;
* a character gone from the showcase does not vanish from the data but is
  honestly marked with the date last seen — a fact of known age, not fresh
  truth.
"""

from __future__ import annotations

import datetime as _dt
import json
from pathlib import Path


def _now() -> str:
    return _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class ProfileStore:
    def __init__(self, root: Path, uid: str) -> None:
        self.uid = str(uid)
        self.root = Path(root) / "profile"
        self.snapshots = self.root / "snapshots" / self.uid
        self.snapshots.mkdir(parents=True, exist_ok=True)
        self.characters_path = self.root / f"characters_{self.uid}.json"

    # ------------------------------------------------------------- snapshots

    def save_snapshot(self, payload) -> Path:
        """The raw API response as is. Never overwritten."""
        stamp = _dt.datetime.now(_dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        path = self.snapshots / f"{stamp}.json"
        # Named to the second: otherwise two snapshots in a row overwrite each
        # other, and the raw response must not be lost — it is the only source
        # of truth.
        counter = 2
        while path.exists():
            path = self.snapshots / f"{stamp}-{counter}.json"
            counter += 1
        with path.open("w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=1)
        return path

    def snapshot_count(self) -> int:
        return len(list(self.snapshots.glob("*.json")))

    # ------------------------------------------------------------ merging

    def load(self) -> dict:
        if not self.characters_path.exists():
            return {}
        with self.characters_path.open(encoding="utf-8") as handle:
            return json.load(handle)

    def merge(self, characters: dict[str, dict]) -> dict:
        """Merges new characters into the accumulated set and returns a report.

        Those missing from this run are not removed: the showcase was merely
        rearranged, and their data stays valid as of its date.
        """
        stored = self.load()
        now = _now()
        report = {"new": [], "changed": [], "unchanged": [], "kept": []}

        for key, record in characters.items():
            previous = stored.get(key)
            entry = dict(record)
            entry["last_seen"] = now

            if previous is None:
                entry["first_seen"] = now
                report["new"].append(key)
            else:
                entry["first_seen"] = previous.get("first_seen", now)
                before = {k: v for k, v in previous.items()
                          if k not in ("first_seen", "last_seen")}
                after = {k: v for k, v in entry.items()
                         if k not in ("first_seen", "last_seen")}
                if before == after:
                    entry["last_seen"] = previous.get("last_seen", now)
                    report["unchanged"].append(key)
                else:
                    report["changed"].append(key)
            stored[key] = entry

        report["kept"] = sorted(set(stored) - set(characters))

        with self.characters_path.open("w", encoding="utf-8") as handle:
            json.dump(stored, handle, ensure_ascii=False, indent=1, sort_keys=True)

        return report

    # -------------------------------------------------------------- report

    def report_text(self, report: dict) -> str:
        lines = [
            f"  new:           {len(report['new'])}"
            + (f"  ({', '.join(report['new'])})" if report["new"] else ""),
            f"  changed:       {len(report['changed'])}"
            + (f"  ({', '.join(report['changed'])})" if report["changed"] else ""),
            f"  unchanged:     {len(report['unchanged'])}",
        ]
        if report["kept"]:
            lines.append(
                f"  kept from earlier runs (not on the showcase now): "
                f"{len(report['kept'])}"
            )
        return "\n".join(lines)
