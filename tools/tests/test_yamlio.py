import tempfile
import unittest
from pathlib import Path

from tools.common.yamlio import load_yaml, loads_yaml


class YamlioTest(unittest.TestCase):
    def test_loads_mapping(self) -> None:
        self.assertEqual(loads_yaml("a: 1\nb: [1, 2]"), {"a": 1, "b": [1, 2]})

    def test_round_trip_through_file(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "data.yaml"
            path.write_text(
                "name: Лифэн\nitems:\n  - 1\n  - two\n",
                encoding="utf-8",
            )
            self.assertEqual(
                load_yaml(path),
                {"name": "Лифэн", "items": [1, "two"]},
            )

    def test_empty_text_is_none(self) -> None:
        self.assertIsNone(loads_yaml(""))

    def test_missing_file_raises(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(FileNotFoundError):
                load_yaml(Path(tmp) / "nope.yaml")


if __name__ == "__main__":
    unittest.main()
