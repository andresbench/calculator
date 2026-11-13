"""The element a damage row deals (`row_elements`): resistance and every
element-filtered bonus follow it, not the operator's element (audit В11).

Real texts from ``data/endfield/operators.json``; synthetic rows pin the
edges of the rule.
"""

import unittest

from tools.ef.export import row_elements, skill_stats, transformed_rows
from tools.tests.support import operators, row


def exported(operator: str) -> dict[str, dict]:
    """The operator's skills as the export has them when it decides elements: rows with ``hit`` and ``move``."""
    record = operators()[operator]
    skills = [{**source, "stats": skill_stats(source)[0]} for source in record["skills"]]
    transformed_rows(record, skills)
    return {skill["name"]: skill for skill in skills}


def elements(skill: dict) -> dict[str, str | None]:
    row_elements(skill)
    return {r["label"]: r.get("element") for r in skill["stats"] if r.get("hit")}


class OneElementNamed(unittest.TestCase):
    def test_estella_deals_physical_except_onomatopoeia(self):
        skills = exported("Estella")
        for name in ("Audio Noise", "Distortion", "Tremolo"):
            with self.subTest(name):
                found = elements(skills[name])
                self.assertTrue(found)
                self.assertEqual(set(found.values()), {"Physical"})
        self.assertEqual(elements(skills["Onomatopoeia"]), {"DMG Multiplier": "Cryo"})

    def test_rossi_ultimate_is_heat(self):
        found = elements(exported("Rossi")['"Razorclaw" Ambuscade'])
        self.assertEqual(
            found,
            {
                "Stab Attack Total DMG Multiplier": "Heat",
                "SEQ 1 Slash DMG Multiplier": "Heat",
                "SEQ 2 Slash DMG Multiplier": "Heat",
            },
        )

    def test_physical_basic_attack_of_an_arts_operator(self):
        found = elements(exported("Avywenna")["Thunderlance: Blitz"])
        self.assertEqual(found["BATK SEQ 1 Multiplier"], "Physical")
        self.assertEqual(found["Finisher ATK Multiplier"], "Physical")
        self.assertEqual(found["Dive ATK Multiplier"], "Physical")

    def test_no_element_named_no_field(self):
        # «Ice Shard», «Slash Base»: the text says DMG, never which.
        found = elements(exported("Last Rite")["Winter's Devourer"])
        self.assertTrue(found)
        self.assertEqual(set(found.values()), {None})

    def test_buff_wording_is_not_a_hit(self):
        skill = {
            "type": "Battle Skill",
            "text": "SKILL DESCRIPTION: Deals DMG. The target suffers Heat DMG Taken +10% and Physical DMG Dealt.",
            "stats": [{"label": "DMG Multiplier", "unit": "frac", "values": [1.0], "hit": {"role": "hit"}}],
        }
        self.assertEqual(elements(skill), {"DMG Multiplier": None})

    def test_the_combo_trigger_is_not_a_hit(self):
        skill = {
            "type": "Combo Skill",
            "text": "COMBO TRIGGER: When an ally deals Heat DMG.\nSKILL DESCRIPTION: Deals Cryo DMG.",
            "stats": [{"label": "DMG Multiplier", "unit": "frac", "values": [1.0], "hit": {"role": "hit"}}],
        }
        self.assertEqual(elements(skill), {"DMG Multiplier": "Cryo"})


class SeveralElementsNamed(unittest.TestCase):
    def test_rossi_wolven_ambrage_is_the_heat_sequence(self):
        # The client agrees: `SEQ 2` is `atk_scale_3`, dealt by the Wolven Ambrage's projectiles, damageType 2.
        found = elements(exported("Rossi")["Crimson Shadow"])
        self.assertEqual(found, {"SEQ 1 DMG Multiplier": "Physical", "SEQ 2 DMG Multiplier": "Heat"})

    def test_arclight_additional_attack_is_electric(self):
        found = elements(exported("Arclight")["Tempestuous Arc"])
        self.assertEqual(
            found,
            {
                "SEQ 1 DMG Multiplier": "Physical",
                "SEQ 2 DMG Multiplier": "Physical",
                "Additional ATK DMG Multiplier": "Electric",
            },
        )

    def test_argent_flow_bolt_rush_is_its_own_paragraph(self):
        skill = exported("Argent Flow")["Darkness Cowed"]
        self.assertEqual(row(skill["stats"], "Bolt Rush DMG Multiplier").get("move"), "Bolt Rush")
        found = elements(skill)
        self.assertEqual(found, {"Base DMG Multiplier": "Physical", "Bolt Rush DMG Multiplier": "Electric"})

    def test_a_later_element_with_no_row_is_reported(self):
        skill = {
            "type": "Battle Skill",
            "text": "SKILL DESCRIPTION: Deals Physical DMG. Then the ground burns for Heat DMG.",
            "stats": [{"label": "DMG Multiplier", "unit": "frac", "values": [1.0], "hit": {"role": "hit"}}],
        }
        self.assertEqual(row_elements(skill), ["Heat"])
        self.assertEqual(skill["stats"][0]["element"], "Physical")


if __name__ == "__main__":
    unittest.main()
