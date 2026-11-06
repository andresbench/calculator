# In-game measurements

What the Endfield damage model has checked in the game itself rather than
taken from the wiki — and what is still to check. The wiki describes skills
but is silent on whose ATK the crystal shards use, which group a set bonus
lands in, or whose Arts Intensity a status takes.

The file has two parts. **First, what to measure**: open questions in order
of how much of the calculator depends on them, each with what the engine
does now, a protocol and a prediction. **Then, what is closed**: answers and
reference numbers, without the run-by-run account (that lives in the lab
journal). Closed items are the basis of the golden tests
(`engine/test/golden/`); a test takes its tolerance from the item, and an
assert stricter than that is a bug in the test, not in the engine.

Item numbers are permanent: tests and code refer to them ("measurements,
#23"). Skipped are items that are not damage measurements: the button
order (14, arithmetic on #13) and the factory (31–34). The withdrawn #7
stays as a short note.

Русская версия — [measurements.ru.md](measurements.ru.md).

**Statuses**

* `confirmed` — measured against a prediction written down before the
  number was known;
* `inferred` — derived from text, datamine or analogy, not measured;
* `open` — not closed; a protocol and a prediction are in place.

## How to measure

1. **Identify the instance first.** A frame shows several unlabelled
   numbers. Until you know which is which, ratios between runs are
   arithmetic on random pairs. Identify them by their ratio to the skills'
   listed multipliers (#8, #11).
2. **Measure the ratio of two numbers from the same frame.** ATK, team
   buffs, DEF and target state cancel out; only what affects one of the two
   remains.
3. **Change one thing between runs.** The best swap is two items with the
   same attributes and a different third stat.
4. **Non-crit numbers**, first trigger of the fight — before talent buffs
   pile up.
5. **Predict before measuring.** A term fitted to the answer is numerology
   even when it lands within 0.1 %: it happened twice (#1).
6. **The stat screen is not ground truth for combat.** It hides some buffs
   (#36) and truncates fractions.
7. **The dummy is the Rhodagn boss.** There is no training dummy; its
   stagger gauge cannot be filled before the second phase, so stagger
   questions are measured on a regular enemy (#45).

---

# Part 1. What to measure

## Queue

Ordered by how many of the calculator's numbers depend on the answer.

| # | question | what it affects | how to close |
|---|---|---|---|
| **Rotation time — every rotation** | | | |
| **Damage — shared mechanics** | | | |
| 46 | A status debuff's AI: at application or live | Breach, Electrification, Corrosion under an AI buff | AI buff expires while the debuff is up |
| **Operators** | | | |
| 43 | Liino's combo in Cosmovoice Stance | Liino | a reaction during Cosmovoice |
| 44 | Akekuri's combo on a Stagger Node | Akekuri | Rhodagn, half the gauge |
| 48 | Camille's Hunter Pursuit | Camille | two battle skills after the ultimate |
| 49 | Tangtang's Whirlpools and Waterspouts | Tangtang | combo, combo, battle skill |
| 50 | A skill's Susceptibility and Amp | Lifeng, Ardelia, Gilberta, Arcane, Estella, Xaihi | a reference hit before and after |
| 51 | Crit from skill rows: Rossi and Liino | Rossi, Liino | crit / non-crit of one hit |
| 52 | Yvonne's ultimate: shots, crit stack, battle skill buff | Yvonne | a recording of the ultimate |
| 53 | Fluorite's explosive: fuse, detonation, infliction | Fluorite | time to the blast, blast from the ultimate |
| 54 | Laevatain's ultimate: the enhanced basic attack | Laevatain | a Basic Attack DMG bonus |
| 55 | Laevatain's Melting Flame | Laevatain | the stack counter |
| 56 | Laevatain's battle skill inside her ultimate | Laevatain | inflictions after the cast |
| 58 | Typhoeus's Signs: how many a Power Shot gives | Typhoeus | the Sign counter |

Leftovers of closed items — at the end of this part.

## 35. BS / CS / ULT frames from the datamine — `open`

Every skill in the client (`SkillData`) has a timeline in frames, 30
frames/s. For basic attacks the reading is confirmed (below, "closed"); for
battle skills, combos and ultimates it is not, and this is the main open
question about time: if it holds, every skill's duration comes from the
client at once, and #21 closes.

**Prediction.** The next action (own or another operator's) is available
from frame `AllowNextSkillAction` + 1, or, where there is none,
`exclusiveFrame` + 1. Endministrator: CS — 25 frames (0.833 s against a
4.067 s animation), ULT — 56 frames (1.867 s against 7.167 s).

**How to close.** 60 fps video: Endministrator's combo, then straight away
another operator's battle skill — ≈ 50 recorded frames to the second
animation (≈ 112 for the ultimate). If it comes out as the full animation
(~244 / ~430), the reading is wrong.

**Combo — `confirmed` 2026-11-04.** Three runs: another operator's battle
skill starts ≈ 50 ± 2 recorded frames after the Endministrator's combo
begins (25 ± 1 client frames, ≈ 0.83 s), not after the whole animation
(5.5 s). On the current pin the window is frame 23, so the next action
comes from frame 24. The window also opens another operator's battle
skill, though `allowedSkillIdList` does not name it. A press before the
window is buffered, and the SP is spent at the moment of the press.

**Ultimate — prediction wrong, a different rule found (2026-11-04).**
Another operator's battle skill came out 46 client frames after the
Endministrator's ultimate began (three runs: 46, 46, 49.5), before
`exclusiveFrame` 55. What matches is the end of the cutscene: the
ultimate's timeline runs `HideUIAction` and `UltimateTimeAction` over
frames 0–44, and the HUD is hidden for exactly 88 recorded frames. Presses
during the cutscene are not buffered. The rule "another operator may act
from the end of `UltimateTimeAction`" is measured on the Endministrator
and `inferred` for the other ultimates (38–85 frames long). During the
cutscene the stage clock, combo cooldowns and buff timers keep running:
the Endministrator's seal lived its 5 s by the clock though a 110-frame
cutscene ran inside it (#16 stands). The countdown frame on an effect's
icon **stops** while the HUD is hidden — it is an animation, not the
timer, so time across a cutscene must not be read from it. **SP regen stops
during the cutscene** — `confirmed` 2026-11-05 by action: after an
ultimate at SP < 100, a spammed battle skill fired only once the gauge was
full (two runs, 14–15 recorded frames after it); had SP accrued during the
cutscene, it would have fired ~90 frames earlier. Each ultimate costs the
team `cutscene / 30 × 8` SP: 11.7 for the Endministrator, 22.7 for Last
Rite.

**Basic attacks — `confirmed` 2026-10-28.** Chain cycle = Σ over hits
(frame `AllowNextSkillAction` + 1) / 30. Checked by `tools/ef/frames.py
--verify` against a community-measured table: 18 of 25 operators with a
closed chain within 0.3 frames. The table's "Basic Sequence" is the cycle
period, not the time to the Final Strike. Laevatain's enhanced chain in her
ultimate (#54) is 97 frames = 3.233 s; the table has 3.230 s.

Open on basic attacks:

* where the extra frame per transition comes from: without `+1` the model
  is shorter than the measurement by the number of hits;
* seven do not match: Ardelia −13.9 frames, Mi Fu −16.0, Yvonne −15.8,
  Perlica +12.2, Zhuang Fangyi +4.9, Tangtang +4.4, Rossi −2.8 (conditional
  transitions, two windows, hit variants) — the engine scales them in the
  sensitivity runs, as unmeasured;
* three do not close: Camille, Ember, Wulfgard;
* the table has Zhuang Fangyi's chain in her ultimate (3.630 s) — the model
  has none.

**Battle skill — 2026-11-05 (Chen → Pogranichnik):** another operator's
battle skill starts 8–13 client frames in — as fast as the button is
mashed, and Chen's hit is not cut. A battle skill holds only its own
operator; the engine gives the step 8 frames when the next step is
someone else's.

## 21. Battle skill, combo and ultimate durations — `open`

Cast time is given neither on the wiki nor in the game. BS, CS and ULT use
a nominal second; the track runs three times, with multipliers 0.5, 1 and 2
on duration, and verdicts that flip between runs are marked fragile. Much
of a rotation's time comes from the data (cooldowns, SP regen) and does not
depend on durations.

The path is #35. If the frame reading does not hold, measure one action at
a time, starting with those that have the most fragile verdicts; write them
to `data/endfield/timings.yaml`, section `overrides`, keyed
"Operator: Skill type". Item 17 ("action durations") is merged here.

## 42. Does a skill reset the basic attack chain — `open`

On the track `BA > FS` is one chain: BA — the hits before the last, FS —
the last (its length from the client's frames, `finalStrikeSeconds`). A
dodge, a pause and another operator's attack break it: in the client a
dodge goes to `attack1`, i.e. starts over. A battle skill, combo or
ultimate between BA and FS does **not** break it — an assumption: the data
does not show whether the controlled operator resumes the interrupted hit
after a skill or starts from the first.

**How to close.** With the controlled operator: 3–4 basic attacks, own
battle skill, attack again. If the next hit is a Final Strike (flash and
SP), the chain survived; if it is the first hit, the skill reset it. Same
with another team member's battle skill.

**Own battle skill — `confirmed` 2026-11-05.** Endministrator, two runs:
a battle skill on the fifth hit's wind-up cancels it, and the next attack
is the **Final Strike** again (SEQ 5 numbers and +20 SP), not the first
hit. The chain remembers where it was cut. A long pause (~3.5 s of
running) resets it. Open: a short move (by the player's experience, it
does not reset), the time limit, another operator's battle skill. The
attack after her own battle skill started 37 client frames in — later
than its `exclusiveFrame` (28).

**Dash — 2026-11-05, `inferred`.** A dash on the Final Strike's wind-up
keeps it (4 of 4), and so does a dodge between SEQ 2 and SEQ 3. In the
client the Endministrator's dodge window allows `attack1`…`attack5`, that
is, the next hit. Running or standing between hits (from 1.6 s) resets
the chain; so does a dash attack followed by running (by the client, the
hit right after it is `attack5`). It looks like movement input, not time,
breaks the chain. Another operator's battle skill with no running in
between was not caught. For the track: `DODGE` between `BA` and `FS` does
not break the chain.

## 40. Dodge: duration and perfect-dodge SP — `open`

On the track `DODGE` is a perfect dodge: +7 SP, regen paused for 0.5 s,
lasts 1 s (`timings.yaml`; the sensitivity runs scale it).

* **SP.** The client gives 7: the shared buff
  `buff_common_dash_behit_listener`, `atb` = 7.0, no per-operator values.
  The `Skill Points` page says "approximately 7.5".
* **Regen pause.** None in the client. There is a world slow-down for
  0.6 s (scale down to 0.05): the world loses ≈ 0.47 s, cooldowns are not
  slowed. If regen runs on world time, that is the wiki's "half a second" —
  an inference, not a fact.
* **Duration.** 19 of 36 operators have a dodge skill: `exclusiveFrame`
  6–16 frames, 12 for most. A perfect one also casts a 15-frame skill and
  slows the operator for 0.35 s. About 1 s from press to attack, estimated.

**How to close.** 60 fps video with the SP gauge not full: the SP jump at
the dodge (expect 7), how many frames the gauge stays flat after it (expect
≈ 28), and from pressing dodge to the first frame an attack is possible
(expect about 1 s).

**Run 2026-11-05** (Chen, two perfect dodges with the gauge not full):
net SP gain **+3.4** (3.46 and 3.33; the jump minus the regen lost to the
pause), against +3.0 on the track. The jump and the pause did not
separate: both 7 SP + ≈ 0.45 s (datamine) and 7.5 SP + 0.5 s (wiki) fit.
From the dodge triggering to the attack starting — 0.88–0.90 s (datamine:
≈ 0.82 s plus the spam step). A second video (three more dodges)
narrowed the jump to **7.56–7.97 SP**: the client's 7 does not fit, the
wiki (7.5 SP, ≈ 0.5 s pause) is closest. Net gain in all four:
+3.37 ± 0.05.

## 46. Status debuff: AI at application or live — `open`

The strength of the Breach, Electrification and Corrosion-shred debuffs is
`× (3·AI + 300) / (AI + 300)` of the applier (#23, #39). The engine takes
the AI at the applying step, with track buffs, and holds it until the
debuff ends.

**How to close.** A temporary AI buff on the applier (Pogranichnik's
Fervent Morale, Arcane's Deep Rampart): apply the debuff under the buff and
hit with one non-crit ally hit before and after the buff expires, while the
debuff is up. The effect is ~0.46 % for Breach SL I at +8 AI (26.9 → 34.9)
— it needs a clean frame.

## 39. How Corrosion's resistance shred grows — `open`

**Known.** Wiki: 15 s; initial shred 3.6 / 4.8 / 6 / 7.2, step 0.84 / 1.12
/ 1.4 / 1.68 per second, cap 12 / 16 / 20 / 24 at SL I–IV; all ×
`(3·AI + 300) / (AI + 300)` of the applier; cuts the resistance of every
element and physical. Client: the shred grows in a step once per 1 s up to
the cap; a new Corrosion inherits the old one's shred; Arcane's talent
`Weapon Honing` multiplies only the cap. The engine does this
(`corrosionShred` in `engine/src/statusHits.ts`).

**Not checked by hits.**

1. Step or smooth growth.
2. Does AI scale the initial shred and the step, or only the cap.
3. Does Corrosion's first hit get its own initial shred (engine: no, as
   with Breach, #23).

**Prediction.** Arcane E4 P0, AI 0, SL IV, Rhodagn (resistance 0). Shred
after t seconds — `7.2 + 1.68·⌊t⌋`, cap 26.4 (with the talent). Multiplier
of one and the same hit relative to that hit before Corrosion:

| t | shred | multiplier | if smooth |
|---|---|---|---|
| 0.5 s | 7.2 | ×1.072 | ×1.080 |
| 1.5 s | 8.88 | ×1.089 | — |
| 5.5 s | 15.6 | ×1.156 | ×1.164 |
| ≥ 12 s | 26.4 | ×1.264 | — |

**Protocol.** A non-crit basic attack SEQ 1 of a non-Arcane before
Corrosion; then 4 Cryo stacks → Arcane's battle skill and the same hit
after ~0.5, ~5.5 and ≥ 12 s by the icon timer. For question 2 — Arcane
with AI 50: ×1.339 after ≥ 12 s, ×1.093 at 0.5 s.

**Measured 2026-11-05.** Arcane E4, AI 30, Corrosion SL IV on Rhodagn;
Chen's single SEQ 1 hits (a run between hits resets the chain). Plateau
×1.312 on two different hits (1327 → 1741, 2370 → 3109) = cap
24 × 1.182 × 1.1; at ~12 s — 1730 = step 11 `(7.2 + 1.68·11) × 1.182`.
**AI scales the start, the step and the cap** — as the engine computes
it (golden `corrosion-shred.test.ts`). Open: step versus smooth growth
(onset known to ±0.5 s), shred on Corrosion's own first hit.

## 15. `World Splitter` and the Link buff — dropped

The third hit of Mi Fu's battle skill, `World Splitter`, "is not treated as
Battle Skill DMG, but as Crush DMG", while Link is spent on the "next
Battle Skill or Ultimate cast". What does Link look at — the cast type or
the damage type? The engine gives Link to every hit of the cast that
spends it and warns about it.

**Protocol.** Link from Lifeng's combo, 1 stack (+30 %). Run A: Mi Fu BS2 →
Lifeng `FS > CS` → Mi Fu BS3. Run B: Lifeng `FS > CS` → Mi Fu BS2 → BS3
(Link is eaten by `Trail and Mangle`). Ratio of the `World Splitter`
numbers A / B: ≈ 1.30 — cast type, ≈ 1.00 — damage type. Separately note
whether Link is consumed in run A: the worst outcome is the buff spent
with no gain. Control: the same number of consumed Vulnerable stacks and
`Physical Susceptibility` in both runs.

**2026-11-05.** Link is eaten by Mi Fu's first and by her second battle
skill sequence, each tested on its own: for Link every sequence is a battle
skill cast of its own. The third sequence was not measured. The engine
assumes `World Splitter` gets the Link bonus.

Dropped 2026-11-06: the first and second sequences eat Link, the third is
taken to as well. The engine has the third spend Link and take the bonus.

## 43. Liino's combo during Cosmovoice Stance — `open`

The combo trigger: "While Vocalist Stance is active, an Arts Reaction is
consumed or is applied". The battle skill enters Vocalist Stance for 60 s,
the ultimate enters Cosmovoice Stance for 15 s, which "replaces Liino's
Vocalist Stance". The engine follows this: after the ultimate the combo
does not open. That is an inference from "replaces"; also unknown is
whether Vocalist Stance comes back when Cosmovoice ends.

**How to close.** Liino's battle skill → ultimate → a reaction during
Cosmovoice: did the combo button light up. Then a reaction after
Cosmovoice ends.

## 44. Akekuri's combo on a Stagger Node — `open`

Trigger: "When an enemy becomes Staggered or hits a Stagger Node". The
wiki does not say where the nodes are; in the client an enemy has
`poiseKnotPctList` — fractions of the gauge, on 26 of 92 enemies (usually
`[0.5]`). The engine opens the combo when stagger crosses fraction × gauge.
That these are the nodes and that they open the combo is an assumption
from the field's name.

**How to close.** On Rhodagn (gauge 280, node at 140) build stagger and
watch whether Akekuri's combo button lights up at the stumble around half
the gauge.

## 48. Camille's Hunter Pursuit — `open`

After the ultimate, Camille's battle skill becomes Hunter Pursuit for 15 s:
"treated as a combo skill and costs no SP", 500 % ATK, stagger 20, 40 SP
(combo rows). The engine: a) one battle skill is converted, the first in
the window; b) combo-type damage, Link is not spent, the battle skill's
statuses are not applied, but for `cast:` triggers the step stays a battle
skill and does not give energy like a combo.

**How to close.** a) Two battle skills in a row after the ultimate: the
second costs 100 SP or is a dash again. b) With Link on the team — does
Hunter Pursuit spend it; does the ultimate gauge grow as from a combo.

## 49. Tangtang's Whirlpools and Waterspouts — `open`

The combo leaves a Whirlpool (up to 2, 30 s), the battle skill takes them
all: Waterspouts — one plus one per Whirlpool, 300 % each, 20 SP returned
per Whirlpool, Arts Susceptibility at two or more. The engine: a) each
Waterspout hits the target in full; b) a third Whirlpool pushes out the
oldest; c) the return is per Whirlpool, not per Waterspout.

**How to close.** Rhodagn: combo, combo, battle skill — three Waterspout
DoT series or one; the SP gauge after the battle skill — minus 60 (100 −
2 × 20) or minus 40. Three combos on cooldown (≈ 0, 12, 24 s) and a battle
skill at ≈ 35 s: three Waterspouts — the third Whirlpool pushed out the
first, two — the third was not created.

## 50. A skill's Susceptibility and Amp: value and condition — `open`

Skills apply them themselves, the value is the skill's row (Lifeng 12 %,
Ardelia 20 %, Si — Amp on the whole team). The engine: a) the value is
fixed at the applying step — Liino's Will, Xaihi's Intellect from the
build, Vulnerable stacks under Gilberta's field; b) the condition ("If the
target has Corrosion", "has no Vulnerability stacks") is checked on the
target before the cast consumes or applies anything; c) Arcane's WILL
array grows linearly; d) Estella's `Physical Susceptibility Multiplier` is
the value; e) Camille — 45 s of wings, Liino — the whole stance; f) a
repeat from the same skill refreshes, different sources add up; g) Xaihi's
crystal gives Arts Amp to whoever made the Final Strike, twice per 20 s
("Max HP" — always, the dummy does not hit back); h) Lifeng's P1 moves the
application itself to a target with 0–2 stacks, 12 + 5 % at once. Not
counted: Purrchena (random; will not be modelled).

**How to close.** Rhodagn, a reference hit before and after: Ardelia
without Corrosion and with it (+20 % or not); Lifeng on a clean target and
with 1 stack; Gilberta — 2 Vulnerable stacks under a field already up;
Arcane WILL with two Wills; Estella with Solidification (×1.15); Lifeng's
battle skill twice — 12 % or 24 %; Xaihi — an Arts hit after a Final
Strike (+15 %), a third adds nothing; Lifeng with P1 on 2 stacks — ×1.17
or ×1.05.

## 51. Crit from skill rows: Rossi and Liino — `open`

SEQ 2 of Rossi's combo gives her Crit Rate +25 % and Crit DMG +50 % for
15 s (screen: 56.4 % / 50 % → 81.4 % / 100 %), the ultimate its own crit
damage +60 %, P5 another +30 %; both of Liino's stances give the team ATK
Boost 10 %. The engine: a) the combo buff applies from the step after SEQ
2, SEQ 2 itself does not get it; b) +60 % and +30 % — only on the
ultimate's crits; c) Cosmovoice replaces Vocalist together with its ATK
Boost (+10 %, not +20 %).

**How to close.** Rhodagn, crit / non-crit of one hit = `1 + crit damage`:
Rossi's SEQ 2 — 1.5 or 2.0; the ultimate — 2.1 at 50 % on screen (2.4 with
P5); an ally's ATK on screen in Vocalist and in Cosmovoice — +10 % or
+20 %.

## 52. Yvonne's ultimate: shots, crit stack, battle skill buff — `open`

The ultimate's window is 7 s. By the client's frames that is 76 shots of
20 %: series of 3, 4, 4 and 8 shots, the last series repeating. Then a
300 % closing hit and, if Solidification is still on the target, a 600 %
extra hit. The crit stack (+3 %, Crit DMG +60 % at the 10th) is applied by
the client on every shot, by the text on every series. The engine follows
the client: the `ULT` step is the whole window, 11.07 s (cast before the
window + 7 s + the closing hit's recovery), 10 stacks from the 11th shot.
The extra hit counts only if Solidification lasts until the closing hit
(9.97 s from the cast). The shots are basic attack damage, not ultimate
(#54).

That raises a new question: `Barrage of Technology` (E2) gives the "next
BA" DMG Dealt +50 % for 15 s after her battle skill applies
Solidification. Since the shots are basic attacks, the engine gives +50 %
to every shot of the ultimate if it is cast before a BA, and the shots do
not spend the buff. Most likely an overestimate.

**How to close.** Rhodagn, a recording of the ultimate.
a) Count the white numbers over the window (or the whole ultimate's damage
over one shot's) — 76?
b) The stack counter on the icon after the first series: 3 (per shot) or 1
(per series); time to 10 stacks — ≈ 1 s or ≈ 4 s.
c) Solidification applied 6+ s before the closing hit — is there a 600 %
hit.
d) Yvonne E2: battle skill with Solidification → ultimate straight away.
Shots against an ultimate without the battle skill: all ×(1 + B + 0.5) /
(1 + B), only the first (it spends the buff) or none (the buff waits for a
real BA — check the next BA after the ultimate).

**Prediction.** a) 76 ± 4; b) per shot; c) no hit; d) none.

## 53. Fluorite's explosive: fuse, detonation, infliction — `open`

By the client the explosive goes off ≈ 3.3 s after the battle skill (frame
10 + 89). If the ultimate hits it, the blast gets `ProdCalcZone` +0.3: a
separate ×1.3 multiplier, not an addition to DMG Bonus. The engine moves
the blast to the ultimate's step at ×1.3 if the ultimate is cast before
the fuse runs out. The blast's Nature Infliction the engine keeps on the
battle skill's step, and the Slow from sticking lasts 3.1 s (for her
talent).

**How to close.** Time from the battle skill to the blast — 3.3 s? With
Nature DMG +X % from gear: is the ratio of the ultimate-detonated blast to
a normal one exactly 1.3 or (1 + X + 0.3) / (1 + X)? When does Nature
Infliction appear on the target — on sticking or on the blast?

## 54. Laevatain's ultimate: the enhanced basic attack and its damage type — `open`

By the client the ultimate's enhanced chain is 4 hits, closed, 97 frames
(the normal one is 5 hits, 99); the community table gives 3.230 s against
3.233 by frames — the chain's length is confirmed. Its Final Strike gives
22 SP and 24 stagger (normal: 20 and 18). Every hit of the chain is marked
`skillSpecification` 1, like a normal BA, while Camille's Hunter Pursuit,
"treated as a combo skill", is 4, like a combo. So the engine counts the
enhanced hits as basic attack damage (at the ultimate's level), and
Yvonne's barrage too. The ultimate's window is 15 s from the cast; a
battle skill or combo inside it pauses it. Heat Infliction comes from the
chain's third hit, not from the cast.

**How to close.** With a Basic Attack DMG bonus: does the enhanced chain
grow like the normal one? The stagger gauge share of the enhanced Final
Strike — 24 against 18? The window's length with one battle skill inside —
15 s plus the cast?

## 55. Laevatain's Melting Flame: where the stacks come from and what spends them — `open`

The engine gives a stack per hit of her battle skill (one per cast), per
combo and — by the client, outside the wiki text — per her normal Final
Strike. After a Final Strike or the controlled operator's finisher, the
talent takes all Heat Infliction off the target, stack for stack, while
she has fewer than 4. By the glossary this is absorption, not consumption,
so "when … is consumed" triggers do not fire on it. A battle skill at 4
stacks spends them all: an extra hit, 100 energy and a forced Combustion;
afterwards she has 0. Without 4 stacks none of this happens. Stacks do not
expire.

**How to close.** Does the counter grow from `BA > FS` chains alone? How
many stacks after a battle skill at 4 — 0 or 1? With 3 Heat Infliction on
the target and 2 stacks on her: how many will she have and how many stay
on the target? Does the ultimate's enhanced Final Strike give a stack?

## 56. Laevatain's battle skill inside her ultimate — `open`

Inside the ultimate's window her battle skill is, by the client, a
different skill: two hits (rows `During Ultimate: BATK SEQ 1/2`), each
applying an infliction by the same action as the third hit of the enhanced
chain (by the text — Heat Infliction); at 4 Melting Flame stacks — a 900 %
extra hit and Combustion, but without the 100 ultimate energy. The engine
plays it this way; the wiki text says nothing about Heat Infliction or
energy.

**How to close.** How many Heat Inflictions on the target after the
battle skill in the ultimate — 2? Does the ultimate gauge grow from its
extra hit at 4 stacks?

## 58. Typhoeus's Signs: how many a Power Shot gives — `open`

A battle skill ABATK on a target with Nature Infliction consumes a stack
and gives a Sign; with an arrow the ABATK becomes a Power Shot, which
"forcibly applies 1 instance of Nature Burst"; the talent `Prey Checklist`
gives a Sign for every Nature Burst. The cap is 8 Signs; the combo opens
at the cap and turns 2 Signs into an arrow. The engine does not model
Signs: Typhoeus's combo is marked "trigger not checked". The client does
not show the order inside a Power Shot outright.

**Questions.** a) A Power Shot on a target with Nature Infliction — +2
Signs (the stack and the Burst) or +1? b) On a clean target — +1? c) A
Nature Burst from an ally — +1 Sign for Typhoeus?

**How to close.** Rhodagn, the Sign counter. Ultimate (2 arrows) → battle
skill: the first Power Shot on a target with 1 Nature stack, the second on
a clean one; the counter after each. Then a Nature Burst from an ally —
the counter before and after.

**Prediction.** a) +2; b) +1; c) +1.

## Leftovers of closed items

The main question has an answer, these remain. Measure when a clean frame
turns up.

* **#4 — the combo window after an application.** How long the chance to
  press a combo opened by the element's application itself lasts; the
  engine does not limit it.
* **#6 — data against the game.**
  * A weapon **without** an essence does not follow the column rule:
    `Valiant` has its stats in column 3 and its named effect in column 6,
    higher than after an essence is attached (4/4). The essence sets the
    level and the cap rather than adding to a base. Every point was taken
    on fully broken-through weapons; dependence on breakthrough is
    unchecked.
  * Solidification duration by level: the wiki has "5.75 – 8.75s (based on
    the Status Level)", the engine uses `5.75 + (SL − 1)`; in the client
    the calling skill passes it.
  * `Weaken` stacking: the wiki says "said to stack non-linearly", no
    formula.
  * Which skills hit "as Crush DMG" (and take Arts Intensity like a real
    Crush): the wiki gives no list.
* **#3 — Lift from the battle skill over Lift from the combo is 1.3099**:
  looks like "+30 % against a Staggered target" from the `Lift` page,
  unchecked.
* **#1 — two numbers of the frame** (34 642 → 32 573 and 30 415 → 28 599)
  fell by ×0.9403 with no AI; not resolved quantitatively.
* **#23 — Breach in the control run**: 9210 against a computed 9144
  (0.7 %).
* **#25 — absolute Lift and Shatter** are ~25 % above the calculation; it
  cancels in the ratio but is not resolved.
* **#24 — stagger as a condition** for `Grizzled Edge`'s ×1.5 is not
  measured on its own (`inferred` from the text): the ×1.5 is decided when
  Crush is applied, so it needs her Crush on a staggered target; the same
  clause with crystals is confirmed (#12).
* **#45 — the Endministrator's finisher** is 0.15 % below the engine
  (102,967 vs 103,118) with no buffs up (checked on screen); not explained.
* **#30 — `Eminent Repute`** ("consumes Vulnerability → ATK +…") on its own
  Crush — by analogy, `inferred`.
* **#47** — Pogranichnik's combo in three sequences (one point or three)
  and the Fervent Morale icon after the fifth point.
* **#62** — Fervent Morale from Pogranichnik's ultimate on allies is not modelled.
* **#37** — the exact number of seconds cut was not taken; the model does
  not depend on it.

---

# Part 2. What is closed

Answers and reference numbers. Tests that rest on them are named in each
item.

| # | question | answer |
|---|---|---|
| 1 | Does Arts Intensity scale crystal shards | no; Crush — yes |
| 2 | Whose ATK do the shards use | the crystals' owner (Endministrator) |
| 3 | Whose Arts Intensity does a Physical Status use | the applier's; `1 + AI/100` |
| 4 | Does the incoming element stay as a stack after a reaction | no; the combo opens on the application itself |
| 5 | Does a reaction consume the whole stack | yes; Status Level = stacks consumed |
| 6 | Data checked against the game | essence sets the weapon column; set texts, resistances and Last Rite's window are right |
| 8 | What Crush is made of | ATK % adds up: +30 % gives ×1.204 |
| 9 | Does an expired seal count as consumed | no |
| 10 | Do basic attacks break crystals | no; `Realspace Stasis` is exactly ×1.20 |
| 11 | Ultimate on crystals: replace or add | add, 1800 % ATK per cast |
| 12 | Endministrator's ultimate ladder | no free parameters, error < 0.01 % |
| 13 | Crush ladder | the seal gives Crush the same ×1.20 as the ultimate |
| 16 | Do timers freeze during animations | no |
| 18 | Enemy fields `SD`, `SPG` | finisher multiplier and finisher SP |
| 19 | Stagger gauge | `SHP` |
| 22 | Talent tiers | attribute talents add up, the rest replace |
| 23 | Does "DMG Dealt for all types" apply to Breach damage | yes |
| 24 | `Grizzled Edge`: which wording is right | the item pages' |
| 25 | Whose damage is Shatter | the shatterer's |
| 26 | Prism shield (Wall of Shields: Brutal) | blocks damage, not statuses |
| 27 | Skill-type bonuses | see the item |
| 28 | "Attribute +X %" on gear — percent of what | of the full attribute |
| 29 | `Eternal Xiranite` on two wearers | does not stack |
| 30 | Does an "after status" buff apply to the Crush that triggered it | yes |
| 36 | Lifeng's Illumination | in `AttributeBonus`; the stat screen does not show it |
| 37 | Si's ultimate and slot 01's combo cooldown | cuts the remaining cooldown |
| 41 | How long Lifeng's Link lasts | 20 s — the `Combo Duration` row |
| 57 | Wolven Blood and MI Security crit triggers | a stack per crit hit, Crush included |
| 59 | Bolt Rush and Sunderization | level = I + consumed; Electrification on every type |
| 60 | Swordmancer's hit | `ATK × 2.5`, Physical, no AI, no battle-skill bonus |
| 61 | The Endministrator's battle skill with Argent Flow | matches the engine within 0.1 % |
| 62 | Stagger on Rhodagn | gear efficiency on all Stagger; Lift `10 × (1 + AI/200)`; Swordmancer hit 10 once per 15 s |
| 45 | Which hits of a cast take Stagger's +30 % | every hit after the one that broke the meter, not that one; a finisher does |
| 47 | Pogranichnik's Steel Oath | four Harass, the fifth point is Decisive alone; Vulnerable instead of Lift spends none |

## 1. Crystal shards and Arts Intensity — `confirmed` 2026-09-04

Shard damage (`Crystal Shattering`, a multiplier on Endministrator's
combo) is not scaled by Arts Intensity; Crush is, by `1 + AI/100`. Armour
swap with the same attributes: AI 74.9 → 101.8, Physical DMG Bonus 0.747 →
0.598.

| number | T1 | Heavy Armor | prediction | error |
|---|---|---|---|---|
| shards | 6045 | 5528 | 5529.4 without AI (with AI it would be 6379.9) | 0.03 % |
| Crush | 92 222 | 98 815 | 98 881 (AI + `Grand Vision`) | 0.07 % |

`Grand Vision` (Physical DMG Dealt +36 % on the "next battle skill or
ultimate") is taken by Crush, not by the shards — exactly as the weapon
text says.

## 2. Whose ATK the shards use — `confirmed` 2026-09-04

The crystals' owner — Endministrator. Chen Qianyu broke the crystals in
four runs with ATK ×1.67 between the extremes — the shards were **24 181**
in all of them. The cast multipliers (DMG Bonus, damage type) the shards
inherit from the cast that broke them: #11, #27.

## 3. Whose Arts Intensity a Physical Status uses — `confirmed` 2026-09-04

The applier's, not whoever built Vulnerable. The multiplier is
`1 + AI/100`, linear. Chen Qianyu applies Lift, Ember builds Vulnerable:

| AI | Lift from combo | Lift from battle skill | prediction combo / battle skill |
|---|---|---|---|
| 0 | 6321 | 8280 | — |
| 26.9 | 8022 | 10 508 | 8021.3 / 10 507.3 |
| 71.8 | 10 858 | 14 221 | 10 859.5 / 14 225.0 |

Maximum error — 4 units out of 14 221 (0.028 %). Control in the same
frame: 10 733, 12 751, 23 505 and 24 181 did not change in any run.

**Not a measurement but the wiki** (the `Arts Intensity` page): stagger
from Lift and Knock Down — `10 × (1 + AI/200)`.

Test: `golden/arts-intensity.test.ts`.

## 4. The incoming element after a reaction — `confirmed` 2026-10-28

It does not stay as a stack: after the reaction there are no stacks on
the enemy. But a combo conditioned on "has Arts Infliction stacks" opens
on **the application itself** — Rossi's combo can be pressed right after
Combustion; its SEQ 2, which consumes stacks, consumes zero.

**Measurement (F3).** Rossi without gear, `Aspirant` lv. 1: ATK 911,
Physical +4.4 %. SEQ 2 = `ATK × (3.0 + 1.8·n) × 0.5 × (1 + bonus)`, n —
stacks consumed.

| run | SEQ 2 | Σ SEQ 1 | computed at n = 0 |
|---|---|---|---|
| Combustion: Perlica battle skill → Camille battle skill → Rossi combo | 1537 | 769 | 1366.5 × (1 + 0.044 + 0.08) = 1536 |
| Electrification: Camille battle skill → Camille combo → Perlica battle skill → Rossi combo | 1755 | — | 1366.5 × (1 + 0.044 + 0.08 + 0.16) = 1754.6 |

The additions are Camille's team buffs in the same additive group as
Physical DMG: `Beacon of Duty` (+8 %) and the `Frontiers` 3-piece (+16 %).

**For rotations.** Rossi's combo after a reaction is a bare 3.0 instead of
3.0 + 1.8·n; it pays to press it on standing stacks.

Tests: `golden/track-buffs.test.ts`, `golden/track-damage.test.ts`,
`golden/stat-screens.test.ts`, `stacks.test.ts`.

## 5. A reaction consumes the whole stack — `confirmed` 2026-10-28

Status Level = the number of stacks consumed. Combustion tick: Perlica ×1
→ Camille — **1586**; Perlica ×4 → Camille — **3964**. Ratio 2.4994 against
60 % / 24 % = 2.5. The Combustion DoT ladder of 24 / 36 / 48 / 60 % ATK per
second is right.

## 6. Data checked against the game — `confirmed` in parts

**The weapon effect's column is set by the attached essence**, not by the
refinement rank:

```
stat component (Agility [L], Physical DMG [M]) → column = cost + 3
named effect (Infliction: …, Combative: …)     → column = cost + rank
```

`cost` is the essence term's weight (Enka showcase,
`weapon.attachedGem.terms`), `rank` is the weapon's rank. The named
effect's cap on screen is `3 + rank`.

| weapon | component | cost | column | how seen |
|---|---|---|---|---|
| `Grand Vision`, rank 1 | Agility [L] | 6 | 9 | Agility 635 with the weapon, 479 without: +156 |
| `Grand Vision`, rank 1 | Infliction: Long Time Wish | 3 | 4 | +57.6 % on the stat screen (#12) |
| `Sundering Steel` | Physical DMG [M] | 5 | 8 | sword swap: 97.1 → 67.8 % |
| `Sundering Steel`, rank 4 | Agility / Physical DMG / Combative | 3 / 1 / 1 | 6 / 4 / 5 | weapon screen, 2026-10-17 |
| `Valiant`, essence from `Sundering Steel` | Agility / Physical DMG / Combative | 6 / 5 / 3 | 9 / 8 / 4 | weapon screen |

A term matches **by family**, not by name: `Combative: Anthem of Cinder`
raised `Combative: Virtuous Gain`. Test:
`tools/tests/test_weapon_columns.py`.

**Set texts are as on the item pages.** For six sets the set page
disagrees with the item pages; the in-game set screen repeats the item
pages word for word (`AIC Fieldwork`, `Eternal Xiranite`, `Pulser Labs`,
`Xiranflow`, `Æthertech`, `Frontiers`). For `Deep Rampart` the item text
matched the client.

**Enemy resistances.** The wiki's resistance letters for all 92 enemies
matched the client's numbers (`EnemyAttributeTemplateTable`, multiplier
`1 − res/100`); `export.py` checks on every build. The higher-difficulty
variants (`_hdg0XX`, `_hard`) carry a flat 8–16 % resistance to every
element — the wiki does not have them.

**Last Rite's battle skill window** — 15 s at every level (wiki and
client).

## 7. (withdrawn)

The suspicion that "Physical DMG Dealt" and "Physical DMG Bonus" are
different groups. Refuted by #1 and by the stat screen in #12: it is one
group.

## 8. Endministrator's Crush broken down — `confirmed` 2026-09-04, 2026-09-06

Status Level, the `Essence Disintegration` buff and the target's state
multiply. "ATK +30 %" gives damage ×1.204, not ×1.30: percentage ATK
bonuses add up with each other.

| condition | Crush |
|---|---|
| SL II, no crystals, no ATK buff | 78 893 |
| SL IV, no crystals, no ATK buff | 131 156 |
| SL IV, no crystals, ATK buff | 157 923 |
| SL IV, crystals, ATK buff | 164 755 |

* SL II → IV: **×1.6625** against 750 % / 450 % = 1.6667 (−0.25 %).
* ATK buff: **×1.2041**; screen: `1.769 / 1.469 = 1.2043`.
* Datamine: every identified ATK % source is at one stage of the
  `BaseMultiplier` formula.

"ATK +X %" and "DMG Bonus +X %" cannot be compared as is: a percentage ATK
buff is worth less than its face value, and the less the more of them are
already stacked.

## 9. An expired seal is not a consumption — `confirmed` 2026-09-06

A `Sealing Sequence` seal left to expire (5 s) gives nothing: no ATK
+30 %, no 50 SP (P1), no 15 energy (P3), no +15 % ATK to the team (P2).

## 10. Basic attacks do not break crystals; `Realspace Stasis` — `confirmed` 2026-09-06

Neither basic attacks nor the chain's final strike remove crystals. The
`Realspace Stasis` bonus (Physical DMG Taken +20 % on a target with
crystals):

| hit | on the seal | after expiry | ratio |
|---|---|---|---|
| final strike | 5441 | 4534 | **1.20004** |
| basic attack | 1149 | 957 | 1.20063 |

## 11. Ultimate on crystals — `confirmed` 2026-09-06

The shards and the ultimate's bonus hit **add up**: 1800 % ATK per cast (in
the measurement — 144 681) against 800 % on a target without crystals.

| number | instance | multiplier | per 100 % ATK |
|---|---|---|---|
| 32 151 | shards (combo) | 400 % | 8037.8 |
| 48 227 | ultimate bonus hit | 600 % | 8037.8 |
| 64 303 | ultimate main hit | 800 % | 8037.9 |

The shards inherit the breaking cast's multipliers (spread 0.001 %).
Vulnerable stacks do not raise damage by themselves: the frame at 2 and at
4 stacks is identical to the unit.

Test: `golden/endmin-ultimate.test.ts`.

## 12. The ultimate ladder — `confirmed` 2026-09-06

The ultimate's main hit (800 %), 2 Vulnerable stacks:

| state | number | to cold | prediction | error |
|---|---|---|---|---|
| cold | 40 302 | 1 | — | — |
| after Crush on 2 stacks | 53 525 | 1.328098 | 1.328078 | 0.002 % |
| after Crush on 4 stacks | 58 523 | 1.452112 | 1.452068 | 0.003 % |
| on the seal | 64 303 | 1.595529 | 1.595423 | 0.007 % |
| seal broken by an ally | 64 522 | 1.600963 | 1.600857 | 0.007 % |

Parameters, none fitted: `G = 1.748` (screen), `Grand Vision` +0.576, ATK
buff 1.204087, `Realspace Stasis` 1.20. The screen after the seal was
broken: Physical DMG Bonus **150.4 % = 74.8 + 57.6 + 18.0**, where 18.0 is
`Grizzled Edge` 6 % × 2 stacks × **1.5** for crystals on the target.
Physical DMG Dealt and Physical DMG Bonus are one additive group.

Test: `golden/endmin-ultimate.test.ts`.

## 13. The Crush ladder — `confirmed` 2026-09-06

Crush on two stacks; the frame shows Crush · shards · the battle skill's
own hit.

| | how obtained | frame |
|---|---|---|
| K1 | no combo | 57 328 · 18 843 |
| K2 | combo → Crush on the seal straight away | 92 222 · 34 642 · 30 415 |
| K3 | combo → seal broken by an ally → Crush | 123 381 · 30 415 |
| K4 | combo → ultimate on the seal → Crush | 69 028 · 22 688 |

* `K4 / K1 = 1.2041` — exactly the ATK buff: Crush after the ultimate loses
  nothing.
* The seal gives Crush the same ~×1.20 as the ultimate.
* K3: the ally's Lift added a stack, Crush went to SL III (×1.3333). The
  remaining 1.2 % in `K3 / K1` is closed in #30.

**Button order.** "Ultimate into the seal → Crush" beats "Crush on the seal
→ ultimate" by +12.1 % on two stacks and +1.9 % on four (P3); under P4 —
+1.5…1.8 % (#30).

Test: `golden/endmin-ultimate.test.ts`.

## 16. Timers do not freeze during animations — `confirmed` 2026-09-12

The fight timer and buff countdowns run during animations, ultimates
included. The track has one clock; `freezes_timers` in `timings.yaml` is
empty.

Confirmed again 2026-11-04 (#35): the seal lived its 5 s by the clock
through an ultimate's cutscene. The countdown frame on the icon stops
while the HUD is hidden, so time across a cutscene must not be read from
it.

## 17. → #21

## 18. Enemy fields — `confirmed` 2026-09-12

Field labels are in `Template:Enemy data`, not on the enemy page:

| field | meaning |
|---|---|
| `SHP` | Stagger HP — the full stagger gauge |
| `SR` | Stagger Recovery |
| `SD` | **Finisher ATK Mult**: 1 / 1.25 / 1.5 / 1.75 by tier, four enemies are exceptions |
| `SPG` | **Finisher SP Gain**: Common 25, Advanced 35, Alpha 50, Boss 100 |

## 19. Stagger gauge — `confirmed` 2026-09-12

`SHP`. `SPG` is not the gauge (#18).

## 20. Passive SP regen: 8 SP/s — `confirmed` 2026-11-04

60 fps video, Chen alone, the gauge from zero to three bars, two cycles:
each 100-SP segment fills in **751 ± 4 recorded frames** = 12.52 s =
7.99 SP/s. The wiki (8 SP/s) predicted 750, the community table
(100 / 13 = 7.69) 780. The engine uses 8 (`data/endfield/sp.yaml`).
Regen stops during an ultimate's cutscene (#35).

## 38. "Skill DMG … for every skill" — skills only — `confirmed` 2026-11-05

Si in three `Tide Surge` pieces against Si with no gear, Rhodagn, no
crit. The stat screen shows the set's "Skill DMG Dealt +20 %" as three
lines: Battle Skill, Combo Skill and Ultimate DMG Bonus at 20 % each;
there is no line for basic attacks. Hits: SEQ 1 — 702 against 398 (ratio
1.7638; 1.7663 expected without the bonus, 1.9212 with it), battle skill
— 3648 against 1900 (1.9200 against 1.9212). In absolute terms,
`ATK × multiplier × 0.5 × (1 + bonuses)` matches to 0.1 %. **Basic
attacks do not get the bonus.** The same is read for `Khravengger` and
`Qingbo` from the wording (`inferred`). The engine still keeps these
bonuses in `unmodeled` and puts the gear stat `All Skill DMG` on basic
attacks too — both to be fixed.

## 57. Crit triggers of Wolven Blood and MI Security — `confirmed` 2026-11-05

Endministrator with `Lupine Scarlet` and three `MI Security` pieces,
Rhodagn. One critting basic hit — +1 to each buff (stat screen: ATK +5 %
of base, Physical and Heat +1.6 %). A battle skill on a target with two
Vulnerable stacks, both numbers critting (her own hit 21,980, Crush
12,689) — +2 to each. **A stack per critting hit, and a status's instant
hit (Crush) counts too.** DoT does not crit (client) and gives no stacks.

## 59. Argent Flow: Bolt Rush and Sunderization — `confirmed` 2026-11-05

Argent Flow E4 with Perlica and the Endministrator, Rhodagn, no crits.
Bolt Rush on a target with 1 Electric stack → Electrification **II** and 2
Sunderization stacks: level = I + consumed. His Electrification raises
**every** DMG type by its usual value `(0.08 + 0.04·SL) × (3·AI + 300)/(AI
+ 300)` at his AI including his own +45 (the Endministrator's Physical hit
2569 → 3482 at ATK 5765 → 6236). Crush on the mark ×1.2, its level with
Bolt Rush's direct Vulnerability stack; the explosion is a plain hit by his
ATK: stacks × 330 % × (1 + Electric) × (1 + DMG Taken) × (1 + 0.6 % × AI)
— 87,313 against 87,292. Open: whether two Bolt Rushes add stacks,
potentials.

## 61. The Endministrator's battle skill after her combo, with Argent Flow — `confirmed` 2026-11-05

Her battle skill on Argent's marked target after the seal had run out: her
own hit 33,415, Crush SL 2 160,586, the explosion 87,292 — the engine
33,408 / 160,584 / 87,264. Physical = the screen + `Grand Vision` +57.6 % +
`Grizzled Edge` 6 % × 2. Rules: an expired effect on the target does not
count; a «next battle skill» buff reaches that cast's status; a buff fired
by an application lands on a one-hit cast's own hit (not on the first move
of a multi-move cast, #23).

## 47. Pogranichnik's Steel Oath — `confirmed` 2026-11-06

Pogranichnik's ultimate 18,131, then Chen: battle skill, combo, battle
skill, battle skill, combo, combo, no crits. The first Lift on a fresh
target became Vulnerable and spends **no** point. From then on every step
with a Lift spends one point: Harass 6,866, 7,203, 7,203, 7,203, and on the
fifth **only** Decisive Assault 33,931, no fifth Harass. The points recover
4 × 10 + 40 = 80 SP. A point's hit already has the buffs that point's SP
switched on (`Thermite Cutter`, `Frontiers`, as Breach in #23). Engine:
18,135 / 6,866 / 7,203 ×3 / 33,931. Test —
`engine/test/golden/steel-oath.test.ts`.

## 60. Swordmancer's hit — `confirmed` 2026-11-05

Chen in Swordmancer, Rhodagn. The first Lift on a fresh boss is
Vulnerable instead of Lift, and no set hit follows (it still counts as
«applies Vulnerability»). Second battle skill: 18,701 (skill), 6,308
(Lift), 8,440 (set hit) — the set hit is `ATK × 2.5 × 0.5 × (1 +
Physical)`: no hidden level multiplier, no AI, no battle-skill bonus. The
cast's statuses use the ATK before the talent stack this same hit adds.

## 41. How long Lifeng's Link lasts — `confirmed` 2026-11-05

Lifeng's combo, then nothing pressed: the team's Link icon goes away on its
own after 20 s. The combo's `Combo Duration (s)` = 20 row is the Link's own
duration.

## 62. Stagger on Rhodagn — `confirmed` 2026-11-06

Rhodagn's gauge (280) read by pixels (1 px ≈ 0.59); it does not drain
during pauses. Chen in Swordmancer ×3, AI 26:

* The set's **Stagger Efficiency** (+20 %) scales all of Chen's Stagger:
  Final Strike 16 → 19 (+18.8, +19.3), battle skill 10 → 12 (+11.8).
* **Lift** deals `10 × (1 + AI/200)` (×1.2): a battle skill with Lift is
  +24.9 / +25.2, on a full Vulnerable too; a Lift that became Vulnerable
  deals none.
* **The Swordmancer hit** — its own 10 (×1.2), once per 15 s: five battle
  skills give +11.8, +37.5, +24.9, +37.5, +25.2.
* Chen's combo has no Stagger of its own: only its Lift (+13.4).
* Pogranichnik: Advance 10 at the cast, Harass 0, Decisive 15 with the
  fifth point.

Engine: five battle skills 12 / 37.6 / 25.6 / 37.6 / 25.7. Test —
`engine/test/golden/stagger.test.ts`. Not modelled: Fervent Morale from
Pogranichnik's ultimate on allies (+8 AI a stack, Lift ~0.5 higher).

## 45. Stagger inside a cast — `confirmed` 2026-11-06

The state is checked **per hit**. Rhodagn brought nearly full, then Chen's
ultimate: its first slash (First Strike Stagger 15 × 1.2) broke the meter.
Slashes 8,859, 12,076, 18,953 (crit), 19,791 (crit), 13,194, 13,194 rise by
559 a `Slashing Edge` stack (up to five). Without the bonus the second would
be 8,859 + 559 / 1.3 = 9,289; it is 12,076 = 9,289 × 1.300. The first, which
broke the meter, has no ×1.3. Earlier (Blitzcrash, 2026-11-05) the final
strike broke it, and no hit of the cast had ×1.3. Test —
`engine/test/golden/stagger-per-hit.test.ts`.

**A finisher** takes ×1.3 on top of the enemy's Finisher ATK Mult: Chen's on
Rhodagn came as two hits, 13,566 + 54,265 = 67,831; engine 67,827 (the
window's buffs taken from SEQ 1, 2, 5 of the same chain). The
Endministrator's, with no buff up: 10,135 + 92,832 = 102,967, engine
103,118. Test — `engine/test/golden/finisher.test.ts`.

## 22. Talent tiers — `confirmed` 2026-09-12

* **Attribute talents add up.** `Skirmisher` at Elite 4 —
  `+10 + 15 + 15 + 20 = +60` Agility, by the stat screen.
* **Tiered ones replace.** The game draws a selector and marks the
  strongest available tier itself.

Test: `effects.test.ts`.

## 23. "DMG Dealt for all types" in Breach damage — `confirmed` 2026-10-28

It counts. The game spreads `AIC Fieldwork` ("DMG Dealt +20 % for all
types") into every elemental line of the screen, Physical DMG included,
and Physical DMG Bonus goes into the status's Multiplier Group. Chen
Qianyu's battle skill (1 stack) → Pogranichnik's battle skill; 4 AIC
pieces (ATK 5988, Physical +30 %) against 2 pieces with the set off (ATK
5432, Physical +10 %):

| | SEQ 1 | Breach | SEQ 2 |
|---|---|---|---|
| AIC ×4, computed | 7473.8 | 5022.9 | 10 911.6 |
| AIC ×4, game | 7474 | 5023 | 10 912 |
| AIC ×2, computed | 5737.2 | 3855.8 | 8376.3 |
| AIC ×2, game | 5737 | 3856 | 8376 |

The wiki's Breach formula is confirmed in full:
`ATK × 1.0 (SL I) × 0.5 (DEF) × (391 + 90) / 392 × (1 + Physical DMG)`.

Along the way, also `confirmed`:

* `Thermite Cutter` (4/4): a skill returned SP → team ATK +8 %; Breach and
  SEQ 2 already hit with it.
* The Breach debuff at SL I is Physical DMG Taken +12 % at AI 0; SEQ 2
  gets it, Breach itself does not. With AI the debuff grows as
  `(3·AI + 300) / (AI + 300)`.

Tests: `golden/track-breach.test.ts`, `golden/track-damage.test.ts`,
`golden/stat-screens.test.ts`.

## 24. `Grizzled Edge`: which wording is right — `confirmed` 2026-10-28

The item pages are right: "ATK +8 %. When the wearer applies Crush or
Breach … Physical DMG Dealt +[6 % × stacks consumed] … If the target
already has Physical Susceptibility, is Staggered, or has attached
Originium Crystals, … 1.5 times". The `Breach` mechanics page retells it
without ATK +8 %, without Crush and with one condition of three.

| | AGL | STR | HP | AI | ATK % | computed ATK | screen ATK |
|---|---|---|---|---|---|---|---|
| 3/3 | 635 | 307 | 7030 | 108 | 39 % weapon + 8 % set | 5765.6 | 5765 |
| 2/3 | 551 | 252 | 6755 | 64 | 39 % weapon | 4848.5 | 4848 |

`ATK = 819 × (1 + ATK%) × (1 + 0.005·AGL + 0.002·STR)`; the set's percent
is in one group with the weapon's ATK %. ×1.5 against a target with
crystals — #12.

**Rule.** Mechanics pages retell set effects and can lag a patch behind;
the truth for a set is the item pages.

Test: `golden/stat-screens.test.ts`.

## 25. Shatter: whose damage — `confirmed` 2026-10-29

The shatterer's: their ATK, Arts Intensity and Physical DMG, not those of
whoever applied Solidification. A glove swap on the shatterer only
(Estella): Shatter ×1.299 / ×1.308 against an expected ×1.301; had it been
Alesh's, the number would not have moved. Precision 1–1.5 %.

## 26. Prism shield, Wall of Shields: Brutal — `confirmed` 2026-10-08

From the player, confirmed by a clear. The shield on the boss blocks
**damage** but not statuses: Vulnerable stacks and the Breach debuff are
applied under the shield and last until the vulnerability window (about
20 s). The shield sits on the boss, not as an aura around Prism. Trap: a
Crush on Prism also eats the boss's stacks — Prism is killed without Crush
and Breach.

## 27. Skill-type bonuses — `confirmed` 2026-10-17

| question | frame | answer |
|---|---|---|
| 27.1 Does Crush take Battle Skill DMG Bonus | gloves +44.9 %, cold Crush on 2 stacks: 43 137 · 20 951 | **no**: Crush / own hit 2.0589 against a predicted 2.0585 (if it did — 2.587) |
| 27.2 A. Do shards broken by the ultimate take Endministrator's P4 ×1.2 | 32 151 · 57 873 · 77 163 | **no**: the shards are unchanged, the ultimate's hits exactly ×1.2000 |
| 27.2 B. Do they take Ultimate DMG Bonus | `MI Security Gloves T1` (+56.1 %): 36 871 · 66 367 · 88 489 | **yes**: net of the ATK change — 1.24126 against a predicted 1.24139 |
| 27.3 Do basic attacks build `Lupine Scarlet` stacks ("skill deals Critical DMG") | Physical DMG Bonus 74.8 → 98.8 after basic attacks alone | **yes**: +24.0 = 15 stacks × 1.6 % |

Shards inherit the damage type from the breaking cast (27.2 B), but not a
multiplier sitting on the ultimate's skill itself (27.2 A).

Test: `golden/endmin-ultimate.test.ts`.

## 28. "Attribute +X %" on gear — of the full attribute — `confirmed` 2026-10-17

The percentage is of the attribute's full sum: the operator's curve, gear,
the weapon stat and talents. Arcane, `LYNX Slab` (Main Attribute +26.9 %):

| hypothesis | Intellect |
|---|---|
| **of the full** | **782.3** |
| of curve and gear | 735 |
| of the curve only | 664 |
| the percent does nothing | 616 |
| screen | **782** |

Control — Will without percentages: 362 on screen, 362.5 computed.

Test: `golden/attribute-percent.test.ts`.

## 29. `Eternal Xiranite` from two wearers — `confirmed` 2026-10-28

It does not stack: the buff from a second wearer only refreshes the 15 s.
One wearer per team.

* +16 % is in the DMG Bonus group: Tangtang 1839 → 2048, ×1.1137 against
  1.1138.
* Elemental Amp triggers the set: Si's ultimate → Chen Qianyu's first hit
  1327 → 1481.
* Two wearers: Perlica's hit 203 → 236 after Lifeng's battle skill → 236
  after Si's ultimate.

The buff's default value in the client (0.25) is not its in-game value
(0.16 from `SkillPatchTable`). Along the way: Si's signet `Jade Vessel` is
DMG Taken +12 % as **a separate multiplier**, not in the DMG Bonus group
(1327 → 1486).

## 30. An "after status" buff applies to its own Crush — `confirmed` 2026-10-17

The `Grizzled Edge` buff applies to the very Crush that raised it and to
its own hit; a weapon buff triggered by a status does too.

| frame | number | state | error |
|---|---|---|---|
| run 1: ultimate, seal broken by an ally | 77 426 | GV + ATK | −0.007 % |
| run 1: Crush next, own hit | 24 146 | **GE 24** + ATK | −0.003 % |
| run 1: Crush | 132 597 | **GE 24** + ATK | +0.021 % |
| run 2: own hit | 31 114 | GV + **GE 24** + ATK | +0.087 % |
| run 2: Crush | 171 025 | GV + **GE 24** + ATK | +0.015 % |
| run 2: ultimate after Crush | 55 004 | GE 24 | −0.003 % |

GV — `Grand Vision` +57.6 %, GE 24 — `Grizzled Edge` 4 stacks × 6 %, ATK —
`Essence Disintegration`. Endministrator P4, cold ultimate 48 362.

`Sundering Steel` on Endministrator ("deals a Physical Status → ATK
+X %"). Screen: ATK 3765, Physical DMG Bonus 89.9 %. Cold ultimate U =
34 318, cold Crush on 2 stacks — own hit S = 14 838. `S / U =
(3.5 / 9.6) × (G + 0.12) / G × X`, G = 1.899, measured 0.43237 → X =
1.1154:

| hypothesis | X | error |
|---|---|---|
| the buff does not apply to its own Crush | 1.0000 | −10.3 % |
| applies, column 4 (ATK +8 %, stack +12 %) | 1.1034 | −1.1 % |
| **applies, column 5** (ATK +9 %, stack +13.5 %) | 1.1154 | −0.005 % |

Test: `golden/endmin-ultimate.test.ts`.

## 36. Lifeng's Illumination — `confirmed` 2026-10-28

The talent ("each point of Intellect and Will gives ATK +0.15 %") sits in
`AttributeBonus`, not in the ATK % group. The stat screen does **not show
it**.

```
ATK = (base × (1 + ATK%) + flat) × (1 + 0.005·AGL + 0.002·STR + 0.0015·(INT + WIL))
```

`Valiant` lv. 90, ATK 3656 on screen, 4374 by the formula. Basic attack
chain, non-crit, `hit = ATK × MV × 0.5 × 1.367`:

| move | multiplier | computed | game | without the talent | as ATK % |
|---|---|---|---|---|---|
| SEQ 1 | 0.36 | 1076.0 | 538 + 538 | 899 | 1494 |
| SEQ 2 | 0.44 | 1315.1 | 1315 | 1099 | 1826 |
| SEQ 3 | 0.53 | 1584.1 | 1584 | 1324 | 2199 |
| SEQ 4 | 1.01 | 3018.8 | 777 + 2242 | 2523 | 4192 |

Attributes are rounded down before conversion to `AttributeBonus`.

Test: `golden/lifeng-illumination.test.ts`.

## 37. Si's ultimate and slot 01's combo cooldown — `confirmed` 2026-10-28, qualitatively

The talent `Proxy's Patronage` ("Team Position 01 operator's combo skill
cooldown length −10s / −20s") cuts the current remaining cooldown, once;
the next cooldown is not shortened. The client agrees: `SetSkillCdAtOnce`
with `functionType 0`.
