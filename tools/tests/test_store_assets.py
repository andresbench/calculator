"""An asset is current only if its file is on disk, not just in the manifest.

The manifest is versioned, the images are not: the public repository leaves
game assets out. On a fresh checkout every manifest entry was there and no
file was, `icons.py` downloaded nothing, and the site went out without icons.
"""

import tempfile
import unittest
from pathlib import Path

from tools.common.store import RawStore


class AssetFreshness(unittest.TestCase):
    def test_a_manifest_entry_without_its_file_is_not_current(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            store = RawStore(Path(tmp))
            store.save_asset("File:Lifeng icon.png", b"png", kind="operators", sha1="abc")
            key = "img:File:Lifeng icon.png"
            self.assertTrue(store.is_current_asset(key, "abc"))
            self.assertFalse(store.is_current_asset(key, "other"))

            (Path(tmp) / store.manifest[key]["path"]).unlink()
            self.assertFalse(store.is_current_asset(key, "abc"))


if __name__ == "__main__":
    unittest.main()
