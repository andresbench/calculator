"""Resistance confidence: the wiki letters against the client's numbers.

The client's numbers live in the versioned ``resistances_client.json``, so the
check gives the same answer in CI, where the datamine clone is absent (audit
В21: every enemy on the site was `inferred` for that reason).
"""

import contextlib
import io
import json
import unittest

from tools.ef.export import RESISTANCES_CLIENT, _resists_vs_client, read_client_resistances
from tools.tests.support import DATA

CLIENT = {"eny_x": {"Physical": 0.8, "Heat": 1.0}}


class ResistsVsClient(unittest.TestCase):
    def test_match_is_confirmed(self):
        record = {"id": "eny_x", "resistances": {"Physical": 0.8, "Heat": 1.0, "Cryo": 1.2}}
        self.assertEqual(_resists_vs_client(record, CLIENT), "confirmed")

    def test_mismatch_or_missing_element_is_inferred_and_printed(self):
        for wiki in ({"Physical": 0.7, "Heat": 1.0}, {"Physical": 0.8}):
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                confidence = _resists_vs_client({"id": "eny_x", "resistances": wiki}, CLIENT)
            self.assertEqual(confidence, "inferred")
            self.assertIn("wiki ≠ client", out.getvalue())

    def test_unknown_enemy_or_no_file_is_inferred(self):
        record = {"id": "eny_y", "resistances": {"Physical": 0.8, "Heat": 1.0}}
        self.assertEqual(_resists_vs_client(record, CLIENT), "inferred")
        self.assertEqual(_resists_vs_client({"id": "eny_x", "resistances": CLIENT["eny_x"]}, None), "inferred")


class VersionedClientFile(unittest.TestCase):
    def test_every_wiki_enemy_is_confirmed_without_the_clone(self):
        enemies = json.loads((DATA / "enemies.json").read_text(encoding="utf-8"))
        client = read_client_resistances()
        self.assertIsNotNone(client, f"{RESISTANCES_CLIENT.name} is not versioned")
        unconfirmed = [
            key for key, record in enemies.items() if _resists_vs_client(record, client) != "confirmed"
        ]
        self.assertEqual(unconfirmed, [])
