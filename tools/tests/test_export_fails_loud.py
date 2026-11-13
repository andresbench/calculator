"""A broken layer must stop the export, not thin the bundle out (audit В32).

Until 2026-11-12 `export.py` wrapped first-party imports (effects, synergies,
roster) and `import yaml` in try/except and finished with exit code 0 and an
empty layer. Replacing a module with `None` in `sys.modules` makes its import
raise ImportError, which is how a broken layer looks from here.
"""

import sys
import unittest
from unittest import mock

from tools.ef import export


class FailLoud(unittest.TestCase):
    def test_broken_effects_layer_raises(self):
        with mock.patch.dict(sys.modules, {"tools.ef.effects": None}):
            with self.assertRaises(ImportError):
                export.export_effects({}, {}, {})

    def test_broken_synergy_layer_raises(self):
        with mock.patch.dict(sys.modules, {"tools.ef.synergy": None}):
            with self.assertRaises(ImportError):
                export.export_synergy({})

    def test_broken_roster_layer_raises(self):
        with mock.patch.dict(sys.modules, {"tools.ef.roster": None}):
            with self.assertRaises(ImportError):
                export.export_roster({}, {})

    def test_missing_pyyaml_raises_with_a_clear_message(self):
        with mock.patch.dict(sys.modules, {"yaml": None}):
            with self.assertRaisesRegex(RuntimeError, "PyYAML is required"):
                export.export_aliases()
