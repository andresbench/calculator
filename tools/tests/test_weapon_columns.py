"""The weapon value column from the essence (measurements, #6).

Every point is a game screen from the table in `docs/measurements.md`, #6:
a stat component sits at ``cost + 3``, a named effect at ``cost + rank``.
The rule the tool printed before (column from rank and breakthrough) cost a
build note half of Pogranichnik's weapon.
"""

import unittest

from tools.ef.weapon import column_from_essence

COLUMNS = 9


class EssenceColumn(unittest.TestCase):
    def test_stat_components(self):
        self.assertEqual(column_from_essence(6, COLUMNS, static=True, rank=1), 9)  # Grand Vision, Agility [L]
        self.assertEqual(column_from_essence(5, COLUMNS, static=True, rank=4), 8)  # Sundering Steel, Physical DMG [M]
        self.assertEqual(column_from_essence(3, COLUMNS, static=True, rank=4), 6)  # Sundering Steel r4, Agility
        self.assertEqual(column_from_essence(1, COLUMNS, static=True, rank=4), 4)  # Sundering Steel r4, Physical DMG

    def test_named_effects_add_the_rank(self):
        self.assertEqual(column_from_essence(3, COLUMNS, static=False, rank=1), 4)  # Infliction: Long Time Wish
        self.assertEqual(column_from_essence(1, COLUMNS, static=False, rank=4), 5)  # Combative: Anthem of Cinder

    def test_clamped_to_the_table(self):
        self.assertEqual(column_from_essence(9, COLUMNS, static=True), COLUMNS)
        self.assertEqual(column_from_essence(0, COLUMNS, static=False, rank=0), 1)


if __name__ == "__main__":
    unittest.main()
