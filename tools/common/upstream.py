"""Other people's git repositories as a data source: clone, pin, diff.

Why a clone and not the API. genshin-db has nine thousand files per language,
and ``api.github.com`` without a token answers 60 requests an hour — fetching
file by file fails on arithmetic alone. But what decides it is history: a
blobless clone takes three seconds and 61 MB, after which we hold 785 commits
labelled with game versions ("7.1 data", "6.7 data"). Then the question "how
did this talent's multiplier change from patch to patch" becomes ``git log -p``
on one file — rather than the separate snapshot machinery that had to be built
for the Endfield wiki.

What is configured and why:

* ``--filter=blob:none`` — commit history is there, file contents are fetched
  on demand. Without it the clone pulls every revision of every file for
  years.
* ``--sparse`` — only the needed folders are laid out on disk. genshin-db has
  15 languages; we need two.
* the clone lives **outside** our repository's version control. Someone
  else's repository is its own history: any pin can be restored by SHA at any
  time. That is what sets it apart from ``data/endfield/raw``, where the
  wikitext snapshot is kept on our side precisely because there is nowhere to
  restore it from.

The unit of reproducibility is the pin file (see ``Pins``): it records which
commit the data was built from. Builds go from the pin, not from "whatever is
upstream today", or the numbers start changing by themselves.
"""

from __future__ import annotations

import argparse
import collections
import datetime as _dt
import json
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path


class UpstreamError(RuntimeError):
    pass


def _now() -> str:
    return _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class Upstream:
    """One external repository, partially checked out."""

    def __init__(
        self,
        path: Path,
        url: str,
        *,
        sparse: list[str] | None = None,
        name: str | None = None,
    ) -> None:
        self.path = Path(path)
        self.url = url
        self.sparse = list(sparse or [])
        self.name = name or self.path.name

    # ------------------------------------------------------------------ git

    def _git(self, *args: str, check: bool = True, cwd: Path | None = None) -> str:
        result = subprocess.run(
            ["git", *args],
            cwd=str(cwd or self.path),
            capture_output=True,
            text=True,
        )
        if check and result.returncode != 0:
            raise UpstreamError(
                f"{self.name}: git {' '.join(args)} → {result.returncode}\n"
                f"{result.stderr.strip()}"
            )
        return result.stdout.strip()

    @property
    def cloned(self) -> bool:
        return (self.path / ".git").is_dir()

    def clone(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._git(
            "clone",
            "--filter=blob:none",
            "--sparse",
            self.url,
            str(self.path),
            cwd=self.path.parent,
        )
        if self.sparse:
            self._git("sparse-checkout", "set", *self.sparse)

    def apply_sparse(self) -> None:
        """The folder list may have changed in code — bring the clone in line."""
        if not self.sparse:
            return
        current = set(self._git("sparse-checkout", "list", check=False).split())
        if current != set(self.sparse):
            self._git("sparse-checkout", "set", *self.sparse)

    def remote_head(self, ref: str = "HEAD") -> str:
        """The head SHA, without downloading. One network request."""
        out = self._git("ls-remote", self.url, ref, cwd=self.path.parent)
        if not out:
            raise UpstreamError(f"{self.name}: {self.url} is not responding")
        return out.split()[0]

    def fetch(self) -> None:
        self._git("fetch", "--tags", "origin")

    def has(self, sha: str) -> bool:
        """Is the commit already local? ``cat-file -e`` is silent and returns a code."""
        return (
            subprocess.run(
                ["git", "cat-file", "-e", f"{sha}^{{commit}}"],
                cwd=str(self.path),
                capture_output=True,
            ).returncode
            == 0
        )

    def checkout(self, sha: str) -> None:
        if not self.has(sha):
            self.fetch()
        self._git("checkout", "--detach", sha)

    def head(self) -> str:
        return self._git("rev-parse", "HEAD")

    def commit_info(self, sha: str) -> dict:
        out = self._git("show", "-s", "--format=%H%n%cI%n%s", sha)
        lines = out.split("\n")
        return {
            "sha": lines[0],
            "committed_at": lines[1] if len(lines) > 1 else None,
            "subject": lines[2] if len(lines) > 2 else "",
        }

    # ---------------------------------------------------------------- diff

    def log_between(self, old: str, new: str, paths: list[str] | None = None) -> list[dict]:
        if old == new:
            return []
        args = ["log", "--format=%H%x09%cI%x09%s", f"{old}..{new}"]
        if paths:
            args += ["--", *paths]
        rows = []
        for line in self._git(*args, check=False).splitlines():
            parts = line.split("\t", 2)
            if len(parts) == 3:
                rows.append({"sha": parts[0], "committed_at": parts[1], "subject": parts[2]})
        return rows

    def changed_files(
        self, old: str, new: str, paths: list[str] | None = None
    ) -> list[tuple[str, str]]:
        """``[(status, path)]``: A — added, M — modified, D — deleted."""
        if old == new:
            return []
        args = ["diff", "--name-status", old, new]
        if paths:
            args += ["--", *paths]
        rows = []
        for line in self._git(*args, check=False).splitlines():
            parts = line.split("\t")
            if len(parts) >= 2:
                rows.append((parts[0][:1], parts[-1]))
        return rows


class Pins:
    """The pin file: which commit of each source counts as current.

    It is versioned together with the code — that is the answer to "what data
    was this built from". The clones next to it are not versioned.
    """

    def __init__(self, path: Path) -> None:
        self.path = Path(path)
        self.data: dict[str, dict] = {}
        if self.path.exists():
            self.data = json.loads(self.path.read_text(encoding="utf-8"))

    def get(self, name: str) -> dict | None:
        return self.data.get(name)

    def sha(self, name: str) -> str | None:
        entry = self.data.get(name)
        return entry.get("sha") if entry else None

    def set(self, name: str, *, url: str, sparse: list[str], info: dict) -> None:
        self.data[name] = {
            "url": url,
            "sha": info["sha"],
            "committed_at": info.get("committed_at"),
            "subject": info.get("subject", ""),
            "sparse": sparse,
            "pinned_at": _now(),
        }

    def flush(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.path.open("w", encoding="utf-8") as handle:
            json.dump(self.data, handle, ensure_ascii=False, indent=1, sort_keys=True)
            handle.write("\n")


# ------------------------------------------------------------ sync CLI

# Shared by every game: each has its own ``tools/<game>/sync.py`` with a list
# of sources, while cloning, pinning and the diff report live here, in one place.


@dataclass
class Source:
    url: str
    # Folders laid out on disk. Nothing else gets into the clone.
    sparse: list[str]
    note: str
    # The subset of sparse that the report's diff is computed over: changes
    # right here mean a rebuild is mandatory.
    watch: list[str] = field(default_factory=list)


def _repo(clones: Path, name: str, source: Source) -> Upstream:
    return Upstream(clones / name, source.url, sparse=source.sparse, name=name)


def _describe(info: dict) -> str:
    when = (info.get("committed_at") or "")[:10]
    return f"{info['sha'][:8]}  {when}  {info.get('subject', '')}"


def _group(paths: list[tuple[str, str]]) -> list[tuple[str, collections.Counter]]:
    """Changed files → by folder, or the report runs to a thousand lines."""
    grouped: dict[str, collections.Counter] = collections.defaultdict(collections.Counter)
    for status, path in paths:
        parts = path.split("/")
        folder = "/".join(parts[:-1]) if len(parts) > 1 else "."
        grouped[folder][status] += 1
    return sorted(grouped.items())


def cmd_status(sources: dict[str, Source], names: list[str], clones: Path, pins_path: Path) -> int:
    pins = Pins(pins_path)
    for name in names:
        source = sources[name]
        repo = _repo(clones, name, source)
        pinned = pins.get(name)
        print(f"\n{name} — {source.note}")
        print(f"  {source.url}")
        if not pinned:
            print("  pin: not set")
        else:
            print(f"  pin:    {_describe(pinned)}")
        if not repo.cloned:
            print("  clone:  none (run without flags)")
            continue
        print(f"  clone:  {repo.head()[:8]}")
        try:
            head = repo.remote_head()
        except UpstreamError as exc:
            print(f"  upstream: cannot check — {exc}")
            continue
        if pinned and head == pinned["sha"]:
            print("  upstream: the same")
        else:
            print(f"  upstream: {head[:8]}  ← there is something to update (--update)")
    return 0


def cmd_sync(
    sources: dict[str, Source],
    names: list[str],
    clones: Path,
    pins_path: Path,
    root: Path,
    *,
    update: bool,
) -> int:
    pins = Pins(pins_path)
    changed_any = False

    for name in names:
        source = sources[name]
        repo = _repo(clones, name, source)
        print(f"\n{name} — {source.note}")

        if not repo.cloned:
            print(f"  cloning {source.url}")
            print("  (blobless + sparse: history without contents, only the needed folders on disk)")
            repo.clone()
        else:
            repo.apply_sparse()

        previous = pins.sha(name)

        if update or previous is None:
            repo.fetch()
            target = repo.remote_head()
            if previous is None:
                print("  no pin yet — pinning the head")
        else:
            target = previous

        repo.checkout(target)
        info = repo.commit_info(target)

        if previous and previous != target:
            changed_any = True
            print(f"  was:  {previous[:8]}")
            print(f"  now:  {_describe(info)}")
            commits = repo.log_between(previous, target, source.watch or None)
            if commits:
                print(f"  commits touching the data: {len(commits)}")
                for commit in commits[:10]:
                    print(f"    {commit['committed_at'][:10]}  {commit['subject']}")
                if len(commits) > 10:
                    print(f"    … and {len(commits) - 10} more")
            changes = repo.changed_files(previous, target, source.watch or None)
            if changes:
                print(f"  changed files: {len(changes)}")
                for folder, counter in _group(changes):
                    bits = ", ".join(
                        f"{label} {counter[code]}"
                        for code, label in (("A", "new"), ("M", "modified"), ("D", "deleted"))
                        if counter[code]
                    )
                    print(f"    {folder}: {bits}")
        else:
            print(f"  at the pin: {_describe(info)}")

        pins.set(name, url=source.url, sparse=source.sparse, info=info)

        files = sum(1 for folder in source.sparse for _ in (repo.path / folder).rglob("*.json"))
        print(f"  on disk: {files} json in {repo.path.relative_to(root)}")

    pins.flush()
    print(f"\nPin written: {pins_path.relative_to(root)}")
    if update and not changed_any:
        print("Nothing new upstream — the data is already fresh.")
    return 0


def run(
    title: str,
    doc: str | None,
    sources: dict[str, Source],
    clones: Path,
    pins_path: Path,
    root: Path,
) -> int:
    parser = argparse.ArgumentParser(description=doc)
    parser.add_argument("--update", action="store_true", help="move the pin to the head")
    parser.add_argument("--status", action="store_true", help="only show the state")
    parser.add_argument(
        "--only", action="append", choices=sorted(sources), help="a single source"
    )
    args = parser.parse_args()

    names = args.only or sorted(sources)
    print(title)

    try:
        if args.status:
            return cmd_status(sources, names, clones, pins_path)
        return cmd_sync(sources, names, clones, pins_path, root, update=args.update)
    except UpstreamError as exc:
        print(f"\nError: {exc}", file=sys.stderr)
        return 1
