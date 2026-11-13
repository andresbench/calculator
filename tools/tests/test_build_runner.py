import unittest
from argparse import Namespace

from tools.ef.build import plan


class BuildRunnerPlanTests(unittest.TestCase):
    def test_from_export_runs_export_and_later_steps(self):
        cmds = plan(Namespace(from_step="export", only=None, public=False))
        scripts = [cmd[1:] for cmd in cmds]
        self.assertEqual(
            scripts,
            [
                ["tools/ef/export.py"],
                ["tools/ef/effects.py"],
                ["tools/ef/render.py"],
            ],
        )

    def test_only_render(self):
        cmds = plan(Namespace(from_step=None, only="render", public=False))
        scripts = [cmd[1:] for cmd in cmds]
        self.assertEqual(scripts, [["tools/ef/render.py"]])

    def test_public_only_on_export(self):
        cmds = plan(Namespace(from_step=None, only=None, public=True))
        export_cmds = [cmd for cmd in cmds if cmd[1] == "tools/ef/export.py"]
        self.assertEqual(len(export_cmds), 1)
        self.assertEqual(export_cmds[0][-1], "--public")

        for cmd in cmds:
            if cmd[1] != "tools/ef/export.py":
                self.assertNotIn("--public", cmd)

    def test_unknown_step_raises(self):
        with self.assertRaises(SystemExit):
            plan(Namespace(from_step=None, only="nope", public=False))


if __name__ == "__main__":
    unittest.main()
