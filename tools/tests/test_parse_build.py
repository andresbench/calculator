"""`parse.py` fails loudly and writes safely (audit В33, В34).

The raw directory is pointed at a temporary one: nothing reads or writes the
committed data.
"""

import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from tools.ef import parse


class ConflictClassifier(unittest.TestCase):
    def test_wording_only(self) -> None:
        self.assertEqual(
            parse.classify_text_conflict(
                "Wearer gain DMG Dealt +20%.", "Wearer gains DMG Dealt +20%."
            ),
            "wording only",
        )
        # Spacing around the number and the percent sign.
        self.assertEqual(
            parse.classify_text_conflict("Heat DMG+50%", "Heat DMG +50 %"),
            "wording only",
        )
        self.assertEqual(
            parse.classify_text_conflict("Protected for 5s", "Protection lasts 5s"),
            "wording only",
        )

    def test_numbers_differ(self) -> None:
        self.assertEqual(
            parse.classify_text_conflict("ATK +16%", "ATK +18%"), "numbers differ"
        )
        # A lost percent sign changes the meaning too.
        self.assertEqual(
            parse.classify_text_conflict("ATK +16%", "ATK +16"), "numbers differ"
        )
        # A condition dropped from the text takes its number with it.
        self.assertEqual(
            parse.classify_text_conflict("ATK +8%, Crit Rate +5%", "Crit Rate +5%"),
            "numbers differ",
        )


def payloads_with_conflict(page_text: str, item_text: str) -> dict:
    return {
        "gear.json": {
            "pieces": {},
            "sets": {
                "S": {
                    "name": "S",
                    "text": item_text,
                    "set_page_text": page_text,
                    "conflict": True,
                    "effect_known": True,
                    "effect_source": "item pages (3)",
                }
            },
        },
        "mechanics.json": {},
    }


class ConsistencyCheck(unittest.TestCase):
    def check(self, payloads: dict) -> int:
        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(parse, "RAW", Path(tmp)), \
                mock.patch("builtins.print"):
            return parse.check_consistency(payloads)

    def test_a_wording_conflict_is_a_warning(self) -> None:
        self.assertEqual(self.check(payloads_with_conflict("DMG +20%", "DMG +20 %")), 0)

    def test_a_numbers_conflict_is_a_problem(self) -> None:
        self.assertEqual(self.check(payloads_with_conflict("DMG +16%", "DMG +18%")), 1)

    def test_an_unknown_set_is_a_problem(self) -> None:
        payloads = payloads_with_conflict("a", "a")
        payloads["gear.json"]["sets"]["S"]["conflict"] = False
        payloads["gear.json"]["pieces"] = {"p": {"set": "Missing"}}
        self.assertEqual(self.check(payloads), 1)


class RawPages(unittest.TestCase):
    def setUp(self) -> None:
        parse._REPORTED_REDIRECTS.clear()

    def test_mechanics_skip_a_redirect_page_and_report_it_once(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            raw = Path(tmp) / "raw"
            (raw / "mechanics").mkdir(parents=True)
            (raw / "mechanics" / "Arts Burst.wiki").write_text("A burst deals damage.", encoding="utf-8")
            (raw / "mechanics" / "Cryo Burst.wiki").write_text("#REDIRECT [[Arts Burst]]", encoding="utf-8")
            with mock.patch.object(parse, "DATA", Path(tmp)), mock.patch.object(parse, "RAW", raw):
                with mock.patch("builtins.print") as printed:
                    first = parse.build_mechanics({})
                    second = parse.build_mechanics({})

            self.assertEqual(list(first), ["Arts Burst"])
            self.assertNotIn("#REDIRECT", json.dumps(first))
            self.assertEqual(list(second), ["Arts Burst"])
            lines = [call.args[0] for call in printed.call_args_list]
            self.assertEqual(sum("Cryo Burst" in line for line in lines), 1)

    def test_read_page_hides_a_redirect(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            raw = Path(tmp) / "raw"
            (raw / "weapons").mkdir(parents=True)
            (raw / "weapons" / "A.wiki").write_text("#REDIRECT [[B]]", encoding="utf-8")
            (raw / "weapons" / "B.wiki").write_text("text", encoding="utf-8")
            with mock.patch.object(parse, "RAW", raw):
                self.assertIsNone(parse.read_page("weapons", "A"))
                self.assertEqual(parse.read_page("weapons", "B"), "text")


class ModuleFailures(unittest.TestCase):
    def test_a_broken_module_raises_instead_of_yielding_an_empty_table(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            raw = Path(tmp) / "raw"
            (raw / "modules").mkdir(parents=True)
            (raw / "modules" / "Module__Weapon skill~data.wiki").write_text(
                "local data = { broken = ", encoding="utf-8"
            )
            with mock.patch.object(parse, "RAW", raw):
                with self.assertRaisesRegex(parse.ModuleError, "Module:Weapon skill/data"):
                    parse.load_weapon_skill_effects()

    def test_a_broken_recipe_module_stops_the_factory_file(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            raw = Path(tmp) / "raw"
            (raw / "modules").mkdir(parents=True)
            (raw / "modules" / "Module__Recipe~Smelt.wiki").write_text("return {}", encoding="utf-8")
            with mock.patch.object(parse, "RAW", raw):
                with self.assertRaisesRegex(parse.ModuleError, "Module:Recipe/Smelt"):
                    parse.load_recipes()

    def test_main_exits_non_zero_and_leaves_the_failed_file_alone(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            data = Path(tmp)
            raw = data / "raw"
            (raw / "modules").mkdir(parents=True)
            (raw / "modules" / "Module__Weapon skill~data.wiki").write_text(
                "local data = { broken = ", encoding="utf-8"
            )
            previous = data / "weapon_skills.json"
            previous.write_text('{"kept": true}', encoding="utf-8")
            with mock.patch.object(parse, "DATA", data), mock.patch.object(parse, "RAW", raw), \
                    mock.patch("builtins.print"), \
                    mock.patch("sys.argv", ["parse.py"]):
                code = parse.main()

            self.assertEqual(code, 1)
            self.assertEqual(json.loads(previous.read_text(encoding="utf-8")), {"kept": True})
            self.assertTrue((data / "operators.json").exists())


class AtomicWrite(unittest.TestCase):
    def test_a_failed_serialisation_leaves_the_old_file_and_no_temp(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            data = Path(tmp)
            target = data / "x.json"
            target.write_text('{"old": 1}', encoding="utf-8")
            with mock.patch.object(parse, "DATA", data), mock.patch("builtins.print"):
                with self.assertRaises(TypeError):
                    parse.write("x.json", {"bad": object()})
            self.assertEqual(json.loads(target.read_text(encoding="utf-8")), {"old": 1})
            self.assertEqual(sorted(p.name for p in data.iterdir()), ["x.json"])

    def test_a_good_write_replaces_the_file(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            data = Path(tmp)
            with mock.patch.object(parse, "DATA", data), mock.patch("builtins.print"):
                parse.write("x.json", {"new": 2})
            self.assertEqual(json.loads((data / "x.json").read_text(encoding="utf-8")), {"new": 2})
            self.assertEqual(sorted(p.name for p in data.iterdir()), ["x.json"])


if __name__ == "__main__":
    unittest.main()
