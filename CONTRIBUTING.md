# Contributing

## A measurement

The most useful contribution. Open questions are in
[`docs/measurements.md`](docs/measurements.md), each with a protocol and a
prediction. Use the **Measurement** issue template: what you did, the
build, the numbers. Screenshots or a 60 fps recording help — numbers that
pop up together can be read off frame by frame.

Rhodagn the Bonekrushing Fist works as a training dummy: no resistances, no
mechanics of its own. Its stagger gauge does not drain while you pause.

## Code

* **The JSON in `data/endfield/` is the source of truth.** The app and the
  engine read only the bundle `tools/ef/export.py` writes; units and the
  meaning of every row are decided there, once.
* **One damage formula, in TypeScript** (`engine/`). Do not add a second
  implementation anywhere — two drift apart on the first patch.
* **Text parsing stays in Python** (`tools/ef/synergy.py`,
  `rotation.py`, `export.py`); the engine gets its output through the
  bundle.
* **A closed measurement is a golden test** in `engine/test/golden/`, with
  the tolerance the measurement itself records. A test stricter than its
  measurement is a bug in the test.
* **What the vocabulary cannot express goes to `unmodeled`** in the effect
  layer and shows as "not counted" — not into a plausible guess.
* **The wiki sometimes lies.** For gear sets the item pages are the truth;
  mechanic pages retell set texts and can lag a patch behind.
* The engine builds no sentences: a problem or a verdict is a `Message`
  (code + parameters, `engine/src/messages.ts`) with a line in each
  catalogue (`EN_MESSAGES`, `app/src/i18n/messages.ru.ts`).
* Interface strings go into both catalogues (`app/src/i18n/en.ts`,
  `ru.ts`); code and comments are in English.
* Changing the bundle's shape — bump `SCHEMA` in both `tools/ef/export.py`
  and `engine/src/bundle.ts`.

Before a pull request:

```bash
python3 -m unittest discover -s tools/tests -t .
cd engine && npm test && npx tsc --noEmit
cd ../app && npm run build
```

The effect layer's format is in
[`data/endfield/effects/README.md`](data/endfield/effects/README.md).
