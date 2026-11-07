# Andre's Bench

A damage calculator for **Arknights: Endfield** — builds, rotations and
team damage on a timeline. Live at **[andresbench.moe](https://andresbench.moe)**,
in English and Russian.

Unofficial fan project, not affiliated with GRYPHLINE or Hypergryph.

## What it does

* **Build editor** — an operator's stat sheet with weapon, gear, potentials
  and talents, and the damage of every hit, with the formula broken down
  factor by factor.
* **Rotation track** — write a rotation as text (`.rot`), and the engine
  plays it: SP, ultimate energy, cooldowns, combo triggers, debuffs on the
  target, stagger, buffs from talents, weapons and sets, and the damage of
  every step.

## How to use it

The [guide](docs/guide.md) ([по-русски](docs/guide.ru.md)) goes through
both tools: a quick start, the build editor, the rotation track, the `.rot`
notation and how to read the numbers.

## What to trust

Every number is one of three kinds, and the app shows which:

* **fact** — from the game data or a measurement in the game;
* **assumption** — a reading of a text the data does not settle, named as
  such next to the number;
* **not counted** — what the model cannot express yet, listed next to the
  total instead of being guessed.

The engine is tested against numbers read off the game:
[`docs/measurements.md`](docs/measurements.md) has each measurement, its
protocol and its tolerance, and `engine/test/golden/` reproduces them.
Endministrator teams match the game to a fraction of a percent.

### Known limitations

* A rotation is a list of presses: each comes as soon as it is allowed, and
  other operators' skills run alongside the controlled operator's attack
  chain. Whether the chain runs on through another operator's combo or
  ultimate, how long a combo stays available and when a second combo
  opened by the same event goes are assumptions (measurements #64–#67).
* Hit times come from the client's frames. A hit that lands after a later
  press counts with what stands then; a hit inside its own step counts
  with what stood at its press, and a cast's statuses land at its press —
  except a background battle skill's, which land with its hit (#63), and
  Lifeng's ultimate, whose two slams were timed on video (#73).
  Where the wiki's damage rows and the client's hits differ in number,
  every row lands on the skill's last hit, and the track says so.
* Pressing a combo before its window opens is buffered in the game; the
  track does not show it.
* MI Security's +5 % Critical Rate at five stacks is not counted.
* Rossi's combo applies Lift and Vulnerable on both sequences in the model;
  by the text, only the second does.
* An operator's own next action after a battle skill uses the general window
  (the Endministrator's attack comes later in the game, measurements #42).
* Talent nodes close talent tiers in the build editor's numbers, but
  durations and cooldowns from talents on the track assume them open.
* Which hit of a cast carries its Stagger is known only for "First Strike"
  rows; otherwise the hits of the step that breaks the meter get no
  Staggered bonus.

Open questions are in [`docs/measurements.md`](docs/measurements.md) — a
measurement from you closes one (see [CONTRIBUTING](CONTRIBUTING.md)).

## Running it locally

Python 3.12+ and Node 22.

```bash
pip install -r requirements.txt
python3 tools/ef/icons.py            # game icons from the wiki (not committed)
python3 tools/ef/export.py           # data → app/public/data/bundle.json

cd engine && npm ci && npm test      # engine and its golden tests
cd ../app && npm ci && npm run dev   # http://localhost:5173
```

The command line plays a rotation without the app:

```bash
cd engine
npm run sim -- ../rotations/endmin-core.rot --dummy Boss --caveats
npm run calc -- "Chen Qianyu" --skill battle
```

## How the data flows

```
endfield.wiki.gg ──fetch.py──▶ data/endfield/raw/   (wikitext, by revid)
                  ──parse.py──▶ data/endfield/*.json (the source of truth)
client datamine ──frames.py──▶ data/endfield/basic_attacks.json
hand-written layers:            data/endfield/effects/*.yaml, timings.yaml, sp.yaml
                 ──export.py──▶ app/public/data/bundle.json (units decided here)
                                engine/ (TypeScript) ← app/ (React)
```

`export.py` is the one place where units and meanings are decided: the app
never reads the raw JSON. Text parsing stays in Python; the engine gets its
results.

## Licences

* Code — [MIT](LICENSE).
* Data, rotations and measurements — [CC BY-SA 4.0](data/LICENSE), derived
  from the [Endfield Talos Wiki](https://endfield.wiki.gg) (CC BY-SA 4.0),
  modified. Details in [NOTICE](NOTICE).
* Game assets (icons) are © their owners and are not part of this
  repository.

Thanks to the Endfield Talos Wiki editors, the EndfieldData datamine and
Enka.Network.
