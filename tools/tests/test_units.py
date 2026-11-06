"""Units are decided in one place, `export.py`: these are those decisions."""

import unittest

from tools.ef.export import gear_stat_unit, stat_unit, template_units, to_fraction


class StatUnit(unittest.TestCase):
    def test_percent_rows_are_fractions(self):
        self.assertEqual(stat_unit("DMG Multiplier", True), "frac")
        # The % flag wins over the label: a percent stagger row is still a fraction.
        self.assertEqual(stat_unit("Stagger", True), "frac")

    def test_quantities_of_different_nature(self):
        self.assertEqual(stat_unit("Susceptibility Duration (s)", False), "sec")
        self.assertEqual(stat_unit("Cooldown", False), "sec")
        self.assertEqual(stat_unit("Beat Interval (s)", False), "sec")
        self.assertEqual(stat_unit("SP Cost", False), "sp")
        self.assertEqual(stat_unit("SEQ 1 SP Recovery", False), "sp")
        self.assertEqual(stat_unit("SP Return", False), "sp")
        self.assertEqual(stat_unit("Ultimate Energy Gain", False), "energy")
        self.assertEqual(stat_unit("Final Strike Stagger", False), "stagger")
        self.assertEqual(stat_unit("Base Treatment", False), "flat")


class WeaponTemplates(unittest.TestCase):
    def test_percent_follows_the_placeholder(self):
        self.assertEqual(template_units("ATK +{0}% and Agility +{1}", 2), ["frac", "flat"])
        self.assertEqual(template_units("Arts DMG +{0} %", 1), ["frac"])

    def test_out_of_range_placeholders_are_ignored(self):
        self.assertEqual(template_units("ATK +{3}%", 1), ["flat"])

    def test_to_fraction_touches_only_fractions(self):
        self.assertEqual(to_fraction(12, "frac"), 0.12)
        self.assertEqual(to_fraction(20, "flat"), 20)
        self.assertEqual(to_fraction(None, "frac"), None)


class GearStats(unittest.TestCase):
    def test_explicit_flag_wins(self):
        self.assertEqual(gear_stat_unit({"stat": "Agility", "is_percent": True}), "frac")
        self.assertEqual(gear_stat_unit({"stat": "ATK", "is_percent": False}), "flat")

    def test_without_flag_attributes_are_flat(self):
        self.assertEqual(gear_stat_unit({"stat": "Agility"}), "flat")
        self.assertEqual(gear_stat_unit({"stat": "Arts Intensity"}), "flat")
        self.assertEqual(gear_stat_unit({"stat": "Physical DMG Bonus"}), "frac")


if __name__ == "__main__":
    unittest.main()
