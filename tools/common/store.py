"""Raw data store: files + a revid manifest.

The manifest underpins incremental updates and the future diff report (F7).
For every saved page it remembers the revid and edit time, so a repeat run
can ask the wiki for metadata only (cheap) and download content only for the
pages whose revid changed.

Manifest keys are ``kind:title``. Until 2026-11 a page was keyed by its bare
title, and the committed manifests still are; lookups accept both forms
(``manifest_entry``) and a save moves the entry to the new key, so nothing has
to be rewritten wholesale.
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


_REDIRECT_RE = re.compile(r"^\s*#REDIRECT\s*:?\s*\[\[([^\]|#]+)", re.I)


def redirect_target(content: str) -> str | None:
    """The target of a ``#REDIRECT [[Target]]`` page, ``None`` for any other text.

    Such a page is an alias, not content: a mechanics page saved this way ended
    up in the build as an overview reading ``#REDIRECT Arts Burst`` (audit B33).
    """
    match = _REDIRECT_RE.match(content)
    return match.group(1).strip() if match else None


def manifest_key(kind: str, title: str) -> str:
    return f"{kind}:{title}"


def manifest_entry(manifest: dict, kind: str, title: str) -> dict | None:
    """A page's manifest entry, under the ``kind:title`` key or the legacy bare
    title. A bare key counts only if it is of the same kind: a title present in
    two kinds must not answer for both."""
    entry = manifest.get(manifest_key(kind, title))
    if entry is not None:
        return entry
    legacy = manifest.get(title)
    if legacy is not None and legacy.get("kind") == kind:
        return legacy
    return None


def manifest_titles(manifest: dict, kind: str) -> dict[str, str]:
    """{file stem: title} for the saved pages of one kind.

    A file name is not the title (``Item/Natural Resources`` is stored as
    ``Item~Natural Resources``), and the key is the title only in the legacy
    form, so the title is taken from the key by dropping the ``kind:`` prefix.
    Aliases (no ``path``) are left out.
    """
    prefix = f"{kind}:"
    return {
        Path(meta["path"]).stem: key[len(prefix):] if key.startswith(prefix) else key
        for key, meta in manifest.items()
        if isinstance(meta, dict) and meta.get("kind") == kind and meta.get("path")
    }


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
        self.stats = {"fetched": 0, "unchanged": 0, "new": 0, "updated": 0, "redirects": 0}

    @staticmethod
    def _load(path: Path, default):
        if not path.exists():
            return default
        with path.open(encoding="utf-8") as handle:
            return json.load(handle)

    # ---------------------------------------------------------------- writing

    def entry(self, kind: str, title: str) -> dict | None:
        return manifest_entry(self.manifest, kind, title)

    def is_current(self, title: str, revid: int, *, kind: str) -> bool:
        """Same revid in the manifest AND the file on disk.

        The same rule as ``is_current_asset``: the manifest is versioned, the
        raw pages need not be present, and a manifest entry alone would call a
        missing file "up to date" forever.
        """
        entry = self.entry(kind, title)
        if not (entry and entry.get("revid") == revid):
            return False
        path = entry.get("path")
        return bool(path) and (self.root / path).is_file()

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

        key = key or manifest_key(kind, title)
        previous = self.manifest.get(key) or manifest_entry(self.manifest, kind, title)
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

        self._drop_legacy(kind, title, key)
        self.manifest[key] = {
            "revid": revid,
            "timestamp": timestamp,
            "kind": kind,
            "path": str(path.relative_to(self.root)),
            "fetched_at": _now(),
        }
        return path

    def _drop_legacy(self, kind: str, title: str, key: str) -> None:
        """Moves an entry from the bare-title key to ``key`` (it is about to be
        rewritten under the new one)."""
        legacy = self.manifest.get(title)
        if key != title and legacy is not None and legacy.get("kind") == kind:
            del self.manifest[title]

    def save_redirect(self, title: str, target: str, *, kind: str) -> bool:
        """Records that ``title`` is an alias of ``target``; no file is written.

        Returns whether the manifest changed. An alias has no content of its
        own: the target is stored under its own title, if the caller asked
        for it. The entry has no ``path`` and no ``revid`` — a redirect page's
        revid is not the target's, and nothing is re-fetched because of it.
        """
        previous = self.entry(kind, title)
        if previous and previous.get("redirect_to") == target and "path" not in previous:
            return False
        key = manifest_key(kind, title)
        self._drop_legacy(kind, title, key)
        self.manifest[key] = {"kind": kind, "redirect_to": target, "fetched_at": _now()}
        self.stats["redirects"] += 1
        return True

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

    def unreferenced_files(self) -> list[Path]:
        """Files that no manifest entry points at, in the ``raw/`` directories
        the manifest manages.

        Pages that vanished from the wiki (or from a Cargo listing) stay on
        disk after a fetch, and ``parse.py`` reads the directories by glob.
        A directory with no entry at all (``raw/enka/``, written by another
        tool) is not this store's and is left out.
        """
        referenced: set[str] = set()
        managed: set[str] = set()
        for entry in self.manifest.values():
            if not isinstance(entry, dict):
                continue
            kind = entry.get("kind")
            # Images live in img/, not in raw/ (their kind reads "img/...").
            if isinstance(kind, str) and "/" not in kind:
                managed.add(kind)
            if entry.get("path"):
                referenced.add(Path(entry["path"]).as_posix())
        return sorted(
            path
            for kind in managed
            if (self.raw / kind).is_dir()
            for path in (self.raw / kind).rglob("*")
            if path.is_file() and path.relative_to(self.root).as_posix() not in referenced
        )

    def is_current_asset(self, key: str, sha1: str | None) -> bool:
        """Same sha1 in the manifest AND the file on disk.

        The manifest is versioned and the images are not (the public
        repository leaves game assets out), so a fresh checkout has every
        entry and no file: the manifest alone said "all current" and the
        site's build shipped without a single icon.
        """
        entry = self.manifest.get(key)
        if not (entry and sha1 and entry.get("sha1") == sha1):
            return False
        path = entry.get("path")
        return bool(path) and (self.root / path).is_file()

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
        if self.stats["redirects"]:
            lines.append(f"  redirects recorded: {self.stats['redirects']}")
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
        """Downloads the pages whose revid changed (or all, with ``force``).

        A redirect is never stored as content: the alias goes into the
        manifest with its target (``save_redirect``) and is reported. The
        target is stored under its own title if it is among ``titles``.
        Returns the titles that were stored.
        """
        titles = sorted(set(titles))
        if not titles:
            return []

        aliases: dict[str, str] = {}
        if force:
            stale = titles
        else:
            meta = self.client.revision_meta(titles)
            aliases = {t: m["redirect_to"] for t, m in meta.items() if m.get("redirect_to")}
            stale = [
                t for t, m in meta.items()
                if t not in aliases and not self.store.is_current(t, m["revid"], kind=kind)
            ]
            self.store.stats["unchanged"] += len(meta) - len(stale) - len(aliases)
            missing = set(titles) - set(meta)
            if missing and self.verbose:
                print(f"    ! not on the wiki ({len(missing)}): {', '.join(sorted(missing)[:5])}")

        stored: list[str] = []
        if stale:
            pages = self.client.page_content(stale)
            for title, page in pages.items():
                # The client resolves redirects; the text check covers a page
                # that still comes back as "#REDIRECT [[…]]" (an older client,
                # a redirect the API does not follow).
                target = page.get("redirect_to") or redirect_target(page["content"])
                if target:
                    aliases[title] = target
                    continue
                self.store.save_page(
                    title,
                    page["content"],
                    revid=page["revid"],
                    timestamp=page["timestamp"],
                    kind=kind,
                )
                stored.append(title)

        for title, target in sorted(aliases.items()):
            self.store.save_redirect(title, target, kind=kind)
        if aliases and self.verbose:
            shown = ", ".join(f"{t} → {a}" for t, a in sorted(aliases.items())[:5])
            more = f" … +{len(aliases) - 5}" if len(aliases) > 5 else ""
            print(f"    ! {kind}: {len(aliases)} redirect(s) not stored: {shown}{more}")
            unrequested = sorted({a for a in aliases.values() if a not in titles})
            if unrequested:
                print(f"      targets not in this list: {', '.join(unrequested[:5])}")

        if self.verbose:
            if stored:
                print(f"    {kind}: downloaded {len(stored)} of {len(titles)}")
            elif not aliases:
                print(f"    {kind}: all up to date ({len(titles)})")
        return stored

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
