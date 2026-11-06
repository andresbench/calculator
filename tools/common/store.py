"""Raw data store: files + a revid manifest.

The manifest underpins incremental updates and the future diff report (F7).
For every saved page it remembers the revid and edit time, so a repeat run
can ask the wiki for metadata only (cheap) and download content only for the
pages whose revid changed.
"""

from __future__ import annotations

import datetime as _dt
import json
import re
from pathlib import Path

MANIFEST_NAME = "_manifest.json"
CHANGES_NAME = "_changes.json"


def _now() -> str:
    return _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def safe_filename(title: str) -> str:
    """Wiki title → a file name usable in Obsidian and on ext4.

    Colons and slashes in titles like ``Module:Character/data`` are replaced so
    that the mapping stays unambiguous when read by eye.
    """
    name = title.replace(":", "__").replace("/", "~")
    name = re.sub(r'[<>"\\|?*\x00-\x1f]', "_", name)
    return name.strip() or "_unnamed"


class RawStore:
    """The ``data/<game>/raw`` directory plus the manifest."""

    def __init__(self, root: Path) -> None:
        self.root = Path(root)
        self.raw = self.root / "raw"
        self.raw.mkdir(parents=True, exist_ok=True)
        self.manifest_path = self.root / MANIFEST_NAME
        self.manifest: dict[str, dict] = self._load(self.manifest_path, {})
        # This run's changes: title → (old revid, new revid).
        self.changes: dict[str, dict] = {}
        self.stats = {"fetched": 0, "unchanged": 0, "new": 0, "updated": 0}

    @staticmethod
    def _load(path: Path, default):
        if not path.exists():
            return default
        with path.open(encoding="utf-8") as handle:
            return json.load(handle)

    # ---------------------------------------------------------------- writing

    def is_current(self, title: str, revid: int) -> bool:
        entry = self.manifest.get(title)
        return bool(entry) and entry.get("revid") == revid

    def save_page(
        self,
        title: str,
        content: str,
        *,
        revid: int,
        timestamp: str,
        kind: str,
        suffix: str = ".wiki",
        key: str | None = None,
    ) -> Path:
        subdir = self.raw / kind
        subdir.mkdir(parents=True, exist_ok=True)
        path = subdir / (safe_filename(title) + suffix)
        path.write_text(content, encoding="utf-8")

        key = key or title
        previous = self.manifest.get(key)
        if previous is None:
            self.stats["new"] += 1
        elif previous.get("revid") != revid:
            self.stats["updated"] += 1
            self.changes[key] = {
                "from_revid": previous.get("revid"),
                "to_revid": revid,
                "from_timestamp": previous.get("timestamp"),
                "to_timestamp": timestamp,
            }
        self.stats["fetched"] += 1

        self.manifest[key] = {
            "revid": revid,
            "timestamp": timestamp,
            "kind": kind,
            "path": str(path.relative_to(self.root)),
            "fetched_at": _now(),
        }
        return path

    def save_dataset(self, name: str, payload, *, kind: str = "cargo") -> Path:
        """A structured dump (a Cargo table, schemas) — plain JSON.

        It has no revid, so the manifest marks it separately and it is
        re-downloaded every run: it is one request, no loss.
        """
        subdir = self.raw / kind
        subdir.mkdir(parents=True, exist_ok=True)
        path = subdir / f"{safe_filename(name)}.json"
        with path.open("w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=1)

        key = f"{kind}:{name}"
        self.manifest[key] = {
            "kind": kind,
            "path": str(path.relative_to(self.root)),
            "rows": len(payload) if hasattr(payload, "__len__") else None,
            "fetched_at": _now(),
        }
        return path

    def is_current_asset(self, key: str, sha1: str | None) -> bool:
        entry = self.manifest.get(key)
        return bool(entry) and bool(sha1) and entry.get("sha1") == sha1

    def save_asset(
        self,
        title: str,
        data: bytes,
        *,
        kind: str,
        sha1: str | None = None,
        meta: dict | None = None,
    ) -> Path:
        """An image or another binary.

        It lives not in ``raw/`` but in ``img/``: it is not a wikitext cache but
        an asset for the app. Yet the manifest accounts for it with everything
        else, or part of what was downloaded would go unaccounted. Freshness is
        the content's ``sha1``: files have no revid of their own.
        """
        subdir = self.root / "img" / kind
        subdir.mkdir(parents=True, exist_ok=True)
        name = safe_filename(title.split(":", 1)[-1])
        path = subdir / name
        path.write_bytes(data)

        key = f"img:{title}"
        if key in self.manifest:
            self.stats["updated"] += 1
        else:
            self.stats["new"] += 1
        self.stats["fetched"] += 1

        self.manifest[key] = {
            "kind": f"img/{kind}",
            "path": str(path.relative_to(self.root)),
            "sha1": sha1,
            "bytes": len(data),
            "fetched_at": _now(),
            **(meta or {}),
        }
        return path

    def flush(self) -> None:
        with self.manifest_path.open("w", encoding="utf-8") as handle:
            json.dump(self.manifest, handle, ensure_ascii=False, indent=1, sort_keys=True)

        if self.changes:
            path = self.root / CHANGES_NAME
            history = self._load(path, [])
            history.append({"synced_at": _now(), "pages": self.changes})
            with path.open("w", encoding="utf-8") as handle:
                json.dump(history, handle, ensure_ascii=False, indent=1)

    # ---------------------------------------------------------------- report

    def report(self) -> str:
        lines = [
            f"  new pages:          {self.stats['new']}",
            f"  updated:            {self.stats['updated']}",
            f"  unchanged:          {self.stats['unchanged']}",
        ]
        if self.changes:
            lines.append("  changed pages:")
            for title, change in sorted(self.changes.items())[:20]:
                lines.append(
                    f"    {title}: r{change['from_revid']} → r{change['to_revid']}"
                )
            if len(self.changes) > 20:
                lines.append(f"    … and {len(self.changes) - 20} more")
        return "\n".join(lines)


class PageFetcher:
    """Downloads a list of pages into the store, skipping unchanged ones."""

    def __init__(self, client, store: RawStore, *, verbose: bool = True) -> None:
        self.client = client
        self.store = store
        self.verbose = verbose

    def fetch(self, titles, kind: str, *, force: bool = False) -> list[str]:
        titles = sorted(set(titles))
        if not titles:
            return []

        if force:
            stale = titles
        else:
            meta = self.client.revision_meta(titles)
            stale = [t for t, m in meta.items() if not self.store.is_current(t, m["revid"])]
            self.store.stats["unchanged"] += len(meta) - len(stale)
            missing = set(titles) - set(meta)
            if missing and self.verbose:
                print(f"    ! not on the wiki ({len(missing)}): {', '.join(sorted(missing)[:5])}")

        if not stale:
            if self.verbose:
                print(f"    {kind}: all up to date ({len(titles)})")
            return []

        pages = self.client.page_content(stale)
        for title, page in pages.items():
            self.store.save_page(
                title,
                page["content"],
                revid=page["revid"],
                timestamp=page["timestamp"],
                kind=kind,
            )
        if self.verbose:
            print(f"    {kind}: downloaded {len(pages)} of {len(titles)}")
        return sorted(pages)

    def fetch_rendered(self, titles, kind: str) -> list[str]:
        """Rendered HTML — for pages whose wikitext is not self-contained."""
        done = []
        for title in sorted(set(titles)):
            try:
                parsed = self.client.parse_html(title)
            except Exception as exc:  # noqa: BLE001 — one page must not bring down the run
                if self.verbose:
                    print(f"    ! {title}: {exc}")
                continue
            self.store.save_page(
                title,
                parsed["html"],
                revid=parsed["revid"] or 0,
                timestamp="",
                kind=kind,
                suffix=".html",
                key=f"rendered:{title}",
            )
            done.append(title)
        if self.verbose:
            print(f"    {kind}: rendered {len(done)}")
        return done
