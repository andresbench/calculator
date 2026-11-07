"""Combo triggers: what `export.py` hands the engine as `comboTriggers`.

Each case is a real trigger sentence (`data/endfield/operators.json`) read
with the real vocabulary, so a wiki rewording or a vocabulary change that
breaks a reading shows here before it shows on the track.
"""

import unittest
from functools import lru_cache

from tools.ef.rotation import (
    absent_terms,
    combo_trigger,
    consumed_too,
    consumed_trigger,
    own_resource,
    requirement_groups,
    stance_condition,
    strike_trigger,
)
from tools.ef.synergy import (
    build_index,
    charges,
    detonates,
    echoes,
    forced_levels,
    load_aliases,
    marks,
    stack_effects,
    stances,
    own_stacks,
    repeats,
    split_moves,
    stocks,
    strike_after,
    transforms,
    trigger_thresholds,
    vulnerable_stacks,
)
from tools.tests.support import operators, skill


@lru_cache(maxsize=None)
def vocabulary() -> frozenset[str]:
    index = build_index(operators())
    return frozenset(term for entry in index.values() for term in entry["capabilities"])


def text(operator: str) -> str:
    return combo_trigger(skill(operator, "Combo Skill")) or ""


def groups(operator: str) -> list[list[str]]:
    return requirement_groups(text(operator), vocabulary(), load_aliases())


class Groups(unittest.TestCase):
    def test_or_is_one_group_and_is_two(self):
        self.assertEqual(groups("Pogranichnik"), [["Crush", "Breach"], ["Vulnerable"]])
        self.assertEqual(groups("Rossi"), [["Vulnerable"], ["Arts Infliction"]])

    def test_or_across_a_few_words(self):
        self.assertEqual(groups("Lifeng"), [["Physical Susceptibility", "Breach"]])

    def test_a_term_named_twice_is_listed_once(self):
        # "suffers Electrification or after an enemy's Electrification is consumed"
        self.assertEqual(groups("Arclight"), [["Electrification"]])

    def test_operators_own_debuff_is_in_the_vocabulary(self):
        # "When an enemy with active Focus suffers a Physical Status or Arts Infliction."
        self.assertEqual(groups("Antal"), [["Focus"], ["Physical Status", "Arts Infliction"]])


class Negation(unittest.TestCase):
    def test_no_stacks_of_is_absent_not_required(self):
        # Ardelia: "… on an enemy with no stacks of Vulnerability or Arts Infliction."
        self.assertEqual(groups("Ardelia"), [])
        self.assertEqual(absent_terms(text("Ardelia"), vocabulary(), load_aliases()), ["Vulnerable", "Arts Infliction"])

    def test_plain_triggers_forbid_nothing(self):
        self.assertEqual(absent_terms(text("Lifeng"), vocabulary(), load_aliases()), [])


class Thresholds(unittest.TestCase):
    def threshold(self, operator: str) -> dict[str, int]:
        return trigger_thresholds(text(operator), groups(operator))

    def test_or_more(self):
        self.assertEqual(self.threshold("Last Rite"), {"Cryo Infliction": 3})
        self.assertEqual(self.threshold("Mi Fu"), {"Vulnerable": 3})

    def test_shared_by_alternatives(self):
        self.assertEqual(self.threshold("Fluorite"), {"Cryo Infliction": 2, "Nature Infliction": 2})

    def test_reaches(self):
        # "When an enemy reaches 4 stacks of Vulnerability."
        self.assertEqual(self.threshold("Da Pan"), {"Vulnerable": 4})

    def test_no_threshold(self):
        self.assertEqual(self.threshold("Chen Qianyu"), {})


class Events(unittest.TestCase):
    def test_actions(self):
        self.assertEqual(strike_trigger(text("Perlica")), "FS")
        self.assertEqual(strike_trigger(text("Zhuang Fangyi")), "FS|FIN")
        self.assertEqual(strike_trigger(text("Endministrator (female)")), "CS")
        self.assertEqual(strike_trigger(text("Akekuri")), "STG")
        self.assertIsNone(strike_trigger(text("Chen Qianyu")))

    def test_consumption(self):
        self.assertTrue(consumed_trigger(text("Camille")))
        self.assertFalse(consumed_too(text("Camille")))
        # Mixed wording: presence opens it, and so does the consumption.
        for operator in ("Arclight", "Liino"):
            self.assertFalse(consumed_trigger(text(operator)), operator)
            self.assertTrue(consumed_too(text(operator)), operator)


class OwnState(unittest.TestCase):
    def test_own_counter(self):
        self.assertEqual(own_resource(text("Typhoeus"), "Typhoeus"), "Sign")
        self.assertIsNone(own_resource(text("Mi Fu"), "Mi Fu"))

    def test_stance_condition(self):
        self.assertEqual(stance_condition(text("Liino")), "Vocalist Stance")
        self.assertIsNone(stance_condition(text("Lifeng")))

    def test_skills_entering_stances(self):
        self.assertEqual(
            stances(operators()["Liino"]),
            {
                "Dazzling Focus": {"enters": "Vocalist Stance"},
                "Dawnstar Concerto": {"enters": "Cosmovoice Stance", "replaces": "Vocalist Stance"},
            },
        )
        self.assertEqual(stances(operators()["Chen Qianyu"]), {})

    def test_points_a_cast_generates_and_what_spends_them(self):
        self.assertEqual(
            charges(operators()["Pogranichnik"]),
            {
                "Shieldguard Banner, Forward": {
                    "name": "Steel Oath",
                    "points": 5,
                    "on": ["Physical Status"],
                    "combo": True,
                    "each": "Harass",
                    "last": "Decisive Assault",
                }
            },
        )
        self.assertEqual([key for key, op in operators().items() if charges(op)], ["Pogranichnik"])

    def test_an_ultimate_that_transforms_the_battle_skill(self):
        self.assertEqual(
            transforms(operators()["Camille"]),
            {
                "Sanguine Downpour": {
                    "skill": "Battle Skill",
                    "into": "Hunter Pursuit",
                    "as": "Combo Skill",
                    "free": True,
                }
            },
        )
        self.assertEqual([key for key, op in operators().items() if transforms(op)], ["Argent Flow", "Camille"])

    def test_a_combo_that_transforms_the_battle_skill(self):
        # «After Argent Flow casts his combo skill, his battle skill is
        # temporarily changed to Bolt Rush»; the window is the combo's row.
        self.assertEqual(
            transforms(operators()["Argent Flow"]),
            {
                "Stars Shifted": {
                    "skill": "Battle Skill",
                    "into": "Bolt Rush",
                    "as": "Battle Skill",
                    "free": False,
                    "window": "Battle Skill Change Duration (s)",
                }
            },
        )

    def test_a_mark_a_reaction_leaves_and_crush_detonates(self):
        entry = marks(operators()["Argent Flow"])
        self.assertEqual(
            {key: entry[key] for key in ("name", "reaction", "max", "seconds", "allTypes", "status", "element")},
            {"name": "Sunderization", "reaction": "Electrification", "max": 12, "seconds": 60.0,
             "allTypes": True, "status": "Crush", "element": "Electric"},
        )
        self.assertEqual([row["perStack"] for row in entry["byElite"]], [2.2, 3.3])
        self.assertEqual([row["perPoint"] for row in entry["aiByElite"]], [0.004, 0.006])
        self.assertEqual([key for key, op in operators().items() if marks(op)], ["Argent Flow"])
        self.assertEqual(
            vulnerable_stacks(operators()["Argent Flow"]),
            {"Bolt Rush": {"count": 1, "after": "Electric Infliction"}},
        )

    def test_a_term_applied_twice_by_one_cast(self):
        # Lifeng: «applies Knock Down … applies another Knock Down».
        self.assertEqual(repeats(operators()["Lifeng"]), {"Heart of the Unmoving": {"Knock Down": 2}})
        # Arcane's «applies another instance of Nature Susceptibility» is a
        # battle skill hit on an Imprisoned target, in its own paragraph.
        self.assertEqual(repeats(operators()["Arcane"]), {})
        self.assertEqual([key for key, op in operators().items() if repeats(op)], ["Lifeng"])

    def test_the_move_paragraph_is_read_under_the_move_name(self):
        # The plain battle skill only applies Lift; Electrification, the
        # consumed Electric Infliction and Vulnerable belong to Bolt Rush.
        effects = stack_effects(operators()["Argent Flow"], load_aliases())
        self.assertEqual(effects["forced"], {"Electrification": ["Bolt Rush"]})
        self.assertEqual(effects["consumes"], {"Electric Infliction": ["Bolt Rush"]})
        own, moves = split_moves(operators()["Argent Flow"], operators()["Argent Flow"]["skills"][1])
        self.assertIn("applies Lift", own)
        self.assertNotIn("Electrification", own.split("After Argent Flow casts")[0])
        self.assertEqual([name for name, _ in moves], ["Bolt Rush"])
        self.assertEqual(
            forced_levels(operators()["Argent Flow"]),
            {"Bolt Rush": {"reaction": "Electrification", "per": "Electric Infliction"}},
        )

    def test_what_one_skill_leaves_and_another_spends(self):
        self.assertEqual(
            stocks(operators()["Tangtang"]),
            {
                "name": "Whirlpool",
                "max": 2,
                "gainedBy": "RIVER, TO ME!",
                "spentBy": "IMA WAVERIDAAH!",
                "makes": "Waterspout",
                "base": 1,
                "onMany": ["Arts Susceptibility"],
            },
        )
        self.assertEqual([key for key, op in operators().items() if stocks(op)], ["Tangtang"])

    def test_an_ultimate_that_sets_off_the_battle_skills_charge(self):
        # «Kicks an Improvised Explosive that sticks to the target … exploding after a short duration»;
        # «If an Improvised Explosive has been stuck to the target, the skill detonates it immediately»
        self.assertEqual(
            detonates(operators()["Fluorite"]),
            {"Apex Prankster": {"skill": "Tiny Surprise", "name": "Improvised Explosive", "boost": "Battle Skill DMG Boost"}},
        )
        self.assertEqual([key for key, op in operators().items() if detonates(op)], ["Fluorite"])

    def test_skills_that_repeat_the_element_already_there(self):
        # «applies another Arts Infliction of the element already on the enemy»;
        # «at least 2 stacks of Cryo Infliction or Nature Infliction, then apply the same Arts Infliction again»
        self.assertEqual(
            echoes(operators()["Fluorite"]),
            {
                "Free Giveaway": {"elements": ["Cryo", "Nature"], "min": 1},
                "Apex Prankster": {"elements": ["Cryo", "Nature"], "min": 2},
            },
        )
        self.assertEqual([key for key, op in operators().items() if echoes(op)], ["Fluorite"])

    def test_the_next_basic_attack_becomes_a_final_strike(self):
        # «After applying Solidification, the next basic attack performed becomes a Final Strike»
        self.assertEqual(
            strike_after(operators()["Yvonne"]),
            {"skill": "Brr-Brr-Bomb β", "term": "Solidification", "elite": 1, "talent": "Barrage of Technology"},
        )
        self.assertEqual([key for key, op in operators().items() if strike_after(op)], ["Yvonne"])


if __name__ == "__main__":
    unittest.main()


class NearestVerb(unittest.TestCase):
    """«consume X … and forcibly apply Y»: the verb nearest a term is its verb."""

    def effects(self, operator: str) -> dict:
        return stack_effects(operators()[operator], load_aliases())

    def test_laevatain_triggers_combustion_and_consumes_her_stacks(self):
        # «consume all the stacks and perform 1 additional attack … and forcibly trigger temporary Combustion»
        self.assertNotIn("Combustion", self.effects("Laevatain")["consumes"])
        self.assertIn("Smouldering Fire", self.effects("Laevatain")["forced"]["Combustion"])

    def test_a_forced_reaction_consumes_the_infliction_not_itself(self):
        # Yvonne: «consume all Arts Infliction stacks, forcibly apply Solidification»;
        # Arclight: «consume the Electric Infliction and forcibly apply Electrification».
        self.assertNotIn("Brr-Brr-Bomb β", self.effects("Yvonne")["consumes"].get("Solidification", []))
        self.assertIn("Arts Infliction", self.effects("Yvonne")["consumes"])
        self.assertNotIn("Exploding Blitz", self.effects("Arclight")["consumes"].get("Electrification", []))
        self.assertIn("Exploding Blitz", self.effects("Arclight")["consumes"]["Electric Infliction"])

    def test_every_mention_counts(self):
        # «If the enemy has active Electrification, consume the Electrification to unleash…»
        self.assertIn("Tempestuous Arc", self.effects("Arclight")["consumes"]["Electrification"])


class OwnStacks(unittest.TestCase):
    """Laevatain's Melting Flame, from her battle skill, combo and talent texts."""

    def test_melting_flame(self):
        entry = own_stacks(operators()["Laevatain"])
        self.assertEqual(entry["name"], "Melting Flame")
        self.assertEqual(entry["max"], 4)
        # «Hitting the enemy grants 1 stack»; «Laevatain gains 1 stack of Melting Flame»
        self.assertEqual(entry["gains"], [{"skill": "Smouldering Fire", "count": 1}, {"skill": "Seethe", "count": 1}])
        # «has 4 stack(s) … then consume all the stacks … forcibly trigger temporary Combustion»
        self.assertEqual(entry["spentBy"]["at"], 4)
        self.assertEqual(entry["spentBy"]["applies"], ["Combustion"])
        self.assertEqual(entry["absorbs"]["term"], "Heat Infliction")

    def test_nobody_else(self):
        self.assertEqual([key for key, record in operators().items() if own_stacks(record)], ["Laevatain"])
