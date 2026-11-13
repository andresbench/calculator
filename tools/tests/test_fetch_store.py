"""Fetch, store and manifest behaviour on a fake client (audit В33, В34).

No network: the client is a stub that hands out canned metadata and content,
or a real ``MWClient`` whose ``request`` returns canned API JSON.
"""

import tempfile
import unittest
from pathlib import Path

from tools.common.mwapi import MWClient
from tools.common.store import (
    PageFetcher,
    RawStore,
    manifest_entry,
    manifest_titles,
    redirect_target,
)
from tools.ef.fetch import stale_raw_files


class FakeClient:
    """``revision_meta`` / ``page_content`` over a dict of pages.

    ``pages`` maps a title to ``(revid, content)`` or, for an alias,
    ``(revid, content, redirect_to)``. ``resolves`` says whether the client
    follows redirects (the real one does; an old one returned the alias's own
    ``#REDIRECT`` text as content).
    """

    def __init__(self, pages: dict[str, tuple], *, resolves: bool = True) -> None:
        self.pages = pages
        self.resolves = resolves
        self.meta_calls: list[list[str]] = []
        self.content_calls: list[list[str]] = []

    def _info(self, title: str) -> dict:
        revid, content, *target = self.pages[title]
        info = {"revid": revid, "timestamp": f"t{revid}", "content": content}
        if target and self.resolves:
            info["redirect_to"] = target[0]
        return info

    def revision_meta(self, titles):
        self.meta_calls.append(list(titles))
        return {
            t: {k: v for k, v in self._info(t).items() if k != "content"}
            for t in titles
            if t in self.pages
        }

    def page_content(self, titles):
        self.content_calls.append(list(titles))
        return {t: self._info(t) for t in titles if t in self.pages}


def fetcher_for(root: Path, pages: dict[str, tuple], **kwargs):
    client = FakeClient(pages, **kwargs)
    store = RawStore(root)
    return client, store, PageFetcher(client, store, verbose=False)


class Freshness(unittest.TestCase):
    def test_unchanged_revid_is_not_fetched_again(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            client, store, fetcher = fetcher_for(Path(tmp), {"A": (1, "text a")})
            self.assertEqual(fetcher.fetch(["A"], "weapons"), ["A"])
            self.assertEqual(len(client.content_calls), 1)

            self.assertEqual(fetcher.fetch(["A"], "weapons"), [])
            self.assertEqual(len(client.content_calls), 1)
            self.assertEqual(store.stats["unchanged"], 1)

    def test_changed_revid_is_fetched_and_recorded(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            client, store, fetcher = fetcher_for(Path(tmp), {"A": (1, "old")})
            fetcher.fetch(["A"], "weapons")
            client.pages["A"] = (2, "new")

            self.assertEqual(fetcher.fetch(["A"], "weapons"), ["A"])
            self.assertEqual(
                (Path(tmp) / store.entry("weapons", "A")["path"]).read_text(encoding="utf-8"),
                "new",
            )
            self.assertEqual(store.changes["weapons:A"]["from_revid"], 1)
            self.assertEqual(store.changes["weapons:A"]["to_revid"], 2)

    def test_a_manifest_entry_without_its_file_is_fetched_again(self) -> None:
        # The manifest is versioned and raw pages need not be: on a fresh
        # checkout every entry is there and no file is.
        with tempfile.TemporaryDirectory() as tmp:
            client, store, fetcher = fetcher_for(Path(tmp), {"A": (1, "text a")})
            fetcher.fetch(["A"], "weapons")
            (Path(tmp) / store.entry("weapons", "A")["path"]).unlink()
            self.assertFalse(store.is_current("A", 1, kind="weapons"))

            self.assertEqual(fetcher.fetch(["A"], "weapons"), ["A"])
            self.assertEqual(len(client.content_calls), 2)
            self.assertTrue(store.is_current("A", 1, kind="weapons"))


class ManifestKeys(unittest.TestCase):
    def test_a_title_in_two_kinds_does_not_collide(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            store = RawStore(Path(tmp))
            store.save_page("Same", "as gear", revid=1, timestamp="t1", kind="gear")
            store.save_page("Same", "as weapon", revid=2, timestamp="t2", kind="weapons")

            self.assertEqual(store.entry("gear", "Same")["revid"], 1)
            self.assertEqual(store.entry("weapons", "Same")["revid"], 2)
            self.assertIn("gear:Same", store.manifest)
            self.assertIn("weapons:Same", store.manifest)
            self.assertTrue(store.is_current("Same", 1, kind="gear"))
            self.assertFalse(store.is_current("Same", 1, kind="weapons"))

    def test_a_legacy_bare_key_answers_only_for_its_own_kind(self) -> None:
        manifest = {"Same": {"kind": "gear", "revid": 1, "path": "raw/gear/Same.wiki"}}
        self.assertEqual(manifest_entry(manifest, "gear", "Same")["revid"], 1)
        self.assertIsNone(manifest_entry(manifest, "weapons", "Same"))

    def test_a_legacy_entry_is_current_and_moves_to_the_new_key_when_rewritten(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "raw" / "gear").mkdir(parents=True)
            (root / "raw" / "gear" / "A.wiki").write_text("old", encoding="utf-8")
            store = RawStore(root)
            store.manifest["A"] = {
                "kind": "gear", "revid": 1, "timestamp": "t1",
                "path": "raw/gear/A.wiki", "fetched_at": "x",
            }
            self.assertTrue(store.is_current("A", 1, kind="gear"))
            self.assertFalse(store.is_current("A", 2, kind="gear"))

            store.save_page("A", "new", revid=2, timestamp="t2", kind="gear")
            self.assertNotIn("A", store.manifest)
            self.assertEqual(store.manifest["gear:A"]["revid"], 2)
            # An update, not a "new" page: the legacy entry was found.
            self.assertEqual(store.stats["updated"], 1)
            self.assertEqual(store.stats["new"], 0)

    def test_titles_of_a_kind_come_from_both_key_forms(self) -> None:
        manifest = {
            "Item/Natural Resources": {"kind": "factory", "path": "raw/factory/Item~Natural Resources.wiki"},
            "factory:Flow Rate": {"kind": "factory", "path": "raw/factory/Flow Rate.wiki"},
            "factory:Alias": {"kind": "factory", "redirect_to": "Flow Rate"},
            "gear:Other": {"kind": "gear", "path": "raw/gear/Other.wiki"},
        }
        self.assertEqual(
            manifest_titles(manifest, "factory"),
            {"Item~Natural Resources": "Item/Natural Resources", "Flow Rate": "Flow Rate"},
        )


class Redirects(unittest.TestCase):
    def test_redirect_target_parsing(self) -> None:
        self.assertEqual(redirect_target("#REDIRECT [[Arts Burst]]"), "Arts Burst")
        self.assertEqual(redirect_target("#redirect: [[Arts Burst#Cryo|x]]\n"), "Arts Burst")
        self.assertIsNone(redirect_target("Cryo Burst is #REDIRECT [[x]] in the middle"))
        self.assertIsNone(redirect_target("== Overview ==\ntext"))

    def test_an_alias_is_recorded_with_its_target_and_not_stored_as_content(self) -> None:
        pages = {
            "Arts Burst": (10, "== Overview ==\nreal"),
            "Cryo Burst": (10, "== Overview ==\nreal", "Arts Burst"),
        }
        with tempfile.TemporaryDirectory() as tmp:
            client, store, fetcher = fetcher_for(Path(tmp), pages)
            self.assertEqual(fetcher.fetch(["Arts Burst", "Cryo Burst"], "mechanics"), ["Arts Burst"])

            self.assertFalse((Path(tmp) / "raw" / "mechanics" / "Cryo Burst.wiki").exists())
            alias = store.entry("mechanics", "Cryo Burst")
            self.assertEqual(alias["redirect_to"], "Arts Burst")
            self.assertNotIn("path", alias)
            # Content was requested for the target only.
            self.assertEqual(client.content_calls, [["Arts Burst"]])

            # The next run asks nothing more for either page, and the alias
            # entry is not rewritten (the manifest does not churn).
            before = dict(store.manifest["mechanics:Cryo Burst"])
            self.assertEqual(fetcher.fetch(["Arts Burst", "Cryo Burst"], "mechanics"), [])
            self.assertEqual(len(client.content_calls), 1)
            self.assertEqual(store.manifest["mechanics:Cryo Burst"], before)

    def test_a_redirect_text_from_a_client_that_does_not_resolve_is_not_stored(self) -> None:
        pages = {"Cryo Burst": (10, "#REDIRECT [[Arts Burst]]", "Arts Burst")}
        with tempfile.TemporaryDirectory() as tmp:
            _client, store, fetcher = fetcher_for(Path(tmp), pages, resolves=False)
            self.assertEqual(fetcher.fetch(["Cryo Burst"], "mechanics", force=True), [])

            self.assertFalse((Path(tmp) / "raw" / "mechanics" / "Cryo Burst.wiki").exists())
            self.assertEqual(store.entry("mechanics", "Cryo Burst")["redirect_to"], "Arts Burst")

    def test_a_stored_redirect_page_is_replaced_by_the_alias_entry(self) -> None:
        # The committed manifest has the four old ones as ordinary pages.
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "raw" / "mechanics").mkdir(parents=True)
            old = root / "raw" / "mechanics" / "Cryo Burst.wiki"
            old.write_text("#REDIRECT [[Arts Burst]]", encoding="utf-8")
            client, store, fetcher = fetcher_for(
                root, {"Cryo Burst": (10, "real", "Arts Burst")}
            )
            store.manifest["Cryo Burst"] = {
                "kind": "mechanics", "revid": 5, "timestamp": "t5",
                "path": "raw/mechanics/Cryo Burst.wiki", "fetched_at": "x",
            }
            fetcher.fetch(["Cryo Burst"], "mechanics")

            self.assertNotIn("Cryo Burst", store.manifest)
            self.assertEqual(store.manifest["mechanics:Cryo Burst"]["redirect_to"], "Arts Burst")
            # The file stays (nothing is deleted); --prune will list it.
            self.assertEqual(store.unreferenced_files(), [old])


class ClientRedirects(unittest.TestCase):
    """The real ``MWClient`` with ``request`` returning canned API answers."""

    class Canned(MWClient):
        def __init__(self, answer: dict) -> None:
            super().__init__("http://invalid.example/api.php")
            self.answer = answer
            self.params: list[dict] = []

        def request(self, **params) -> dict:
            self.params.append(params)
            return self.answer

    ANSWER = {
        "query": {
            "normalized": [{"from": "cryo_Burst", "to": "Cryo Burst"}],
            "redirects": [
                {"from": "Cryo Burst", "to": "Arts Burst"},
                {"from": "Heat Burst", "to": "Arts Burst"},
            ],
            "pages": [
                {
                    "title": "Arts Burst",
                    "revisions": [{
                        "revid": 7,
                        "timestamp": "2026-09-03T18:13:28Z",
                        "slots": {"main": {"content": "real text"}},
                    }],
                },
                {"title": "Gone", "missing": True},
            ],
        }
    }

    def test_redirects_are_requested_and_reported_under_the_requested_title(self) -> None:
        client = self.Canned(self.ANSWER)
        titles = ["Arts Burst", "Cryo Burst", "Heat Burst", "Gone"]
        meta = client.revision_meta(titles)

        self.assertEqual(client.params[0]["redirects"], 1)
        self.assertEqual(set(meta), {"Arts Burst", "Cryo Burst", "Heat Burst"})
        self.assertNotIn("redirect_to", meta["Arts Burst"])
        self.assertEqual(meta["Cryo Burst"]["redirect_to"], "Arts Burst")
        self.assertEqual(meta["Cryo Burst"]["revid"], 7)

        pages = client.page_content(titles)
        self.assertEqual(client.params[1]["redirects"], 1)
        self.assertEqual(pages["Heat Burst"]["redirect_to"], "Arts Burst")
        self.assertEqual(pages["Arts Burst"]["content"], "real text")

    def test_a_normalised_title_is_not_a_redirect(self) -> None:
        client = self.Canned(self.ANSWER)
        meta = client.revision_meta(["cryo_Burst"])
        # normalised to "Cryo Burst", then redirected: a redirect all the same.
        self.assertEqual(meta["cryo_Burst"]["redirect_to"], "Arts Burst")

        client = self.Canned({"query": {
            "normalized": [{"from": "arts_Burst", "to": "Arts Burst"}],
            "pages": self.ANSWER["query"]["pages"],
        }})
        self.assertNotIn("redirect_to", client.revision_meta(["arts_Burst"])["arts_Burst"])


class Prune(unittest.TestCase):
    def test_stale_raw_files_are_listed_with_a_reason_and_nothing_is_deleted(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "raw" / "cargo").mkdir(parents=True)
            (root / "raw" / "cargo" / "Gears.json").write_text(
                '[{"_pageName": "Kept"}, {"_pageName": "Listed but not fetched"}]', encoding="utf-8"
            )
            (root / "raw" / "enka").mkdir()
            (root / "raw" / "enka" / "equips.json").write_text("{}", encoding="utf-8")

            store = RawStore(root)
            for title in ("Kept", "Vanished"):
                store.save_page(title, "x", revid=1, timestamp="t", kind="gear")
            orphan = root / "raw" / "gear" / "Orphan.wiki"
            orphan.write_text("x", encoding="utf-8")

            found = {path.name: reason for path, reason in stale_raw_files(store)}
            self.assertEqual(
                found,
                {
                    "Vanished.wiki": "not in the current Cargo listing",
                    "Orphan.wiki": "not in the manifest",
                },
            )
            self.assertTrue(orphan.exists())
            self.assertTrue((root / "raw" / "gear" / "Vanished.wiki").exists())


if __name__ == "__main__":
    unittest.main()
