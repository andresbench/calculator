"""Build pipeline runner for the Endfield tools.

The pipeline chain is:

    parse -> names_ru -> export -> effects -> render

Each step is a script at tools/ef/<name>.py. The runner executes the steps in
order, stopping at the first failure.

Use --check in a pre-commit hook or CI to verify that generated files under
data/ and Endfield/ match the committed state.
"""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
STEPS = ["parse", "names_ru", "export", "effects", "render"]


def plan(args: Any) -> list[list[str]]:
    """Build the ordered list of commands to run.

    This function is pure: it performs no I/O and starts no subprocesses.

    Args:
        args: An argparse.Namespace-like object with from_step, only and public
            attributes.

    Returns:
        A list of command argument lists. Each command is
        [sys.executable, "tools/ef/<name>.py", ...].
    """
    from_step = getattr(args, "from_step", None)
    only = getattr(args, "only", None)
    public = bool(getattr(args, "public", False))

    def validate(flag: str, name: str) -> None:
        if name not in STEPS:
            choices = ", ".join(repr(step) for step in STEPS)
            raise SystemExit(
                f"argument {flag}: invalid choice: {name!r} (choose from {choices})"
            )

    if from_step is not None:
        validate("--from", from_step)
    if only is not None:
        validate("--only", only)

    if only is not None:
        selected = [only]
    elif from_step is not None:
        selected = STEPS[STEPS.index(from_step):]
    else:
        selected = list(STEPS)

    commands: list[list[str]] = []
    for name in selected:
        cmd = [sys.executable, f"tools/ef/{name}.py"]
        if name == "export" and public:
            cmd.append("--public")
        commands.append(cmd)
    return commands


def git_drift() -> list[str]:
    """Return report lines for generated files that differ from the commit."""
    diff = subprocess.run(
        ["git", "diff", "--exit-code", "--stat", "--", "data/", "Endfield/"],
        cwd=ROOT,
        capture_output=True,
        text=True,
    )
    status = subprocess.run(
        ["git", "status", "--porcelain", "--", "data/", "Endfield/"],
        cwd=ROOT,
        capture_output=True,
        text=True,
    )

    lines: list[str] = []
    if diff.returncode != 0:
        lines.extend(line for line in diff.stdout.splitlines() if line.strip())
    lines.extend(line for line in status.stdout.splitlines() if line.strip())
    return lines


def run(cmds: list[list[str]]) -> int:
    """Run each command, returning immediately on the first non-zero status."""
    for cmd in cmds:
        print(f"== {Path(cmd[1]).name}")
        result = subprocess.run(cmd, cwd=ROOT)
        if result.returncode != 0:
            return result.returncode
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Run the Endfield build pipeline.")
    parser.add_argument(
        "--from",
        dest="from_step",
        choices=STEPS,
        default=None,
        metavar="STEP",
        help="run steps from STEP to the end",
    )
    parser.add_argument(
        "--only",
        choices=STEPS,
        default=None,
        metavar="STEP",
        help="run only STEP",
    )
    parser.add_argument(
        "--public",
        action="store_true",
        help="pass --public to the export step",
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="verify generated files match the committed state",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="print commands without running them",
    )
    args = parser.parse_args()

    cmds = plan(args)
    if args.check and not cmds:
        parser.error("--check with no steps to run")

    if args.dry_run:
        for cmd in cmds:
            print(" ".join(cmd))
        return 0

    code = run(cmds)
    if code != 0:
        return code

    if args.check:
        drift = git_drift()
        if drift:
            for line in drift:
                print(line)
            print(
                "generated files drifted from the commit: regenerate and commit, "
                "or the data changed and the notes were not"
            )
            return 2

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
