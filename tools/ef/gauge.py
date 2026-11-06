"""Read a boss's Stagger gauge and HP bar off a 1920×1080 recording, per frame.

Measurements, #62: the gauge is the thin line under the boss's HP bar, x
722–1200 at 1080p, rows 80–82, filled pink from the left. It updates in one
step per frame, so every jump is one event; 1 px of 478 is 0.59 on
Rhodagn's 280.

    python3 tools/ef/gauge.py VIDEO [FPS]           # time, gauge share, HP share
    python3 tools/ef/gauge.py VIDEO 60 --jumps 280  # only the jumps, in Stagger units

The HP share is read off the red bar above it, on the same span; a frame
with no bar (cutscenes) prints no HP.
"""

from __future__ import annotations

import argparse
import subprocess

import numpy as np

X0, WIDTH, Y0, HEIGHT = 712, 500, 60, 26  # the crop: x 712..1211, y 60..85
LEFT, RIGHT = 722 - X0, 1200 - X0
GAUGE_ROWS = slice(80 - Y0, 83 - Y0)
HP_ROW = 68 - Y0


def read(path: str, fps: int) -> list[tuple[float, float, float | None]]:
    """(seconds, gauge share, HP share or None) for every sampled frame."""
    cmd = [
        "ffmpeg", "-v", "error", "-i", path,
        "-vf", f"fps={fps},crop={WIDTH}:{HEIGHT}:{X0}:{Y0}",
        "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
    ]
    size = WIDTH * HEIGHT * 3
    out: list[tuple[float, float, float | None]] = []
    with subprocess.Popen(cmd, stdout=subprocess.PIPE) as proc:
        assert proc.stdout is not None
        index = 0
        while len(buf := proc.stdout.read(size)) == size:
            frame = np.frombuffer(buf, np.uint8).reshape(HEIGHT, WIDTH, 3).astype(int)
            row = frame[GAUGE_ROWS].mean(axis=0)
            filled = (row[:, 0] > 185) & (row[:, 1] > 90)
            run = 0
            for x in range(LEFT, RIGHT + 1):
                if not filled[x]:
                    break
                run += 1
            hp = frame[HP_ROW]
            red = np.nonzero(((hp[:, 0] > 170) & (hp[:, 1] < 130))[LEFT : RIGHT + 1])[0]
            share = (red[-1] + 1) / (RIGHT - LEFT + 1) if len(red) else None
            out.append((index / fps, run / (RIGHT - LEFT + 1), share))
            index += 1
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("video")
    parser.add_argument("fps", nargs="?", type=int, default=60)
    parser.add_argument("--jumps", type=float, metavar="METER", help="print only gauge jumps, scaled to the meter")
    args = parser.parse_args()
    rows = read(args.video, args.fps)
    if args.jumps is None:
        for seconds, gauge, hp in rows:
            print(f"{seconds:7.3f} {gauge:.3f} {'' if hp is None else f'{hp:.3f}'}")
        return 0
    previous = 0.0
    for seconds, gauge, hp in rows:
        value = gauge * args.jumps
        if abs(value - previous) > 0.3:
            print(f"{seconds:7.3f}  {previous:6.1f} -> {value:6.1f}  ({value - previous:+.1f})  hp={'' if hp is None else f'{hp:.3f}'}")
        previous = value
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
