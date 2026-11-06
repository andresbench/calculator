# Effects layer — a hand-written placement of text into multiplier groups

The wiki gives the **text** of a talent, potential, weapon effect or set
bonus. Where that text lands in the damage formula is written nowhere on the
wiki. This layer records it by hand.

Without the layer the engine computes bare skill multipliers only, and every
damage table is silently understated.

## One file per operator

`chen-qianyu.yaml`, `lifeng.yaml` — by the key from `operators.json`, in
kebab-case. Plus `gear-sets.yaml` and `weapons.yaml` for what does not belong
to an operator.

## Shape

```yaml
operator: Chen Qianyu

talents:
  - name: Slashing Edge        # exactly as in operators.json
    stacking: replaces         # replaces | cumulative — see below
    confidence: confirmed
    evidence: "measurements #8: ATK % adds up, +30 % → ×1.204"
    levels:
      - condition: Elite 2     # exactly as in operators.json
        seen: "After hitting an enemy with skills, Chen gains ATK +8% for 10s. This effect can reach 5 stacks."
        apply:
          - stat: atk_pct
            value: 8           # as in the text; export.py assigns the unit
            stacks: {max: 5}
            duration: 10
            trigger: skill_hit
            target: self

potentials:
  - rank: 2
    seen: "Agility +15, Physical DMG Dealt +8%."
    apply:
      - {stat: attr, attribute: AGL, value: 15}
      - {stat: dmg_bonus, element: Physical, value: 8}
```

**Numbers are written as in the game text.** "+8 %" is `8`, "Agility +15" is
`15`. `export.py` assigns the unit from the stat vocabulary — in exactly the
place where every other unit in the bundle is assigned, and nowhere else.

**`seen` is a drift detector, not documentation.** It is the wiki text at the
time of parsing. `export.py` compares it with the current text in
`operators.json` (whitespace and line breaks normalised) and, if they differ,
marks the record `stale: true` and prints both versions. A patch changed a
number — the parse must be re-read, not trusted further. Required wherever
`apply` is non-empty.

**What the vocabulary cannot express goes into `unmodeled`, not into a
fitted guess.**

```yaml
  - name: Momentum Breaker
    levels:
      - condition: Elite 2
        unmodeled: "stagger for interrupting a cast; the dummy never casts"
```

Such a record reaches the app and is shown in the "not modelled" list. That
is more honest than a silent zero.

`unmodeled` **may sit next to a non-empty `apply`**: Rossi's fifth potential
has its ultimate multiplier parsed but not "+30 % crit damage", and the
record is on both lists. Otherwise "not modelled" would read as "not parsed
at all".

## Weapons and sets — `weapons.yaml`, `gear-sets.yaml`

An item record has the same shape, only keyed by the item instead of an
operator:

```yaml
weapons:
  - name: Thermite Cutter          # key from weapons.json
    confidence: confirmed
    seen: "ATK +{0}%. After the wielder's skill recovers SP …"   # template, with placeholders
    apply:
      - {stat: atk_pct, value: "{0}"}
      - {stat: atk_pct, value: "{1}", stacks: {max: 2}, duration: 20, trigger: "sp_recovered|applies:Link", target: team}

sets:
  - name: Grizzled Edge            # key from gear.json
    pieces: 3                      # 3 by default
    seen: "3-piece set effect: Wearer's ATK +8%. …"
    apply:
      - {stat: atk_pct, value: 8}
```

**A weapon has a placeholder index instead of a number**, `"{1}"`. There are
nine values, and which one applies is decided by the specific item's essence:
`tools/ef/weapon.py` computes the column (`essence_columns`, measurements
#6), `export.py` puts it into the roster (`roster.weapon.columns`), and the
engine picks the value. No column — the row is not applied and goes into "not
modelled".

**Weapon stat components** (`Agility [L]`, `ATK [L]`, `Physical DMG [M]`…)
are not written in YAML: the template is unambiguous, and the placement is
the `STATIC_COMPONENTS` table in `effects.py`. A new template is not
recognised there and is printed as a problem rather than placed from memory.

A set's `seen` is checked against the text from `gear.json`, i.e. the item
pages — the truth for a set: the set and mechanic pages retell set texts and
can lag a patch behind (measurements #24).

One parse for two operator keys — the `also` field. It is needed exactly for
Endministrator: the wiki has two of them, male and female, differing only in
gender and internal id.

```yaml
operator: Endministrator (female)
also: [Endministrator (male)]
```

## `stacking`: do a talent's tiers add up or replace each other

A talent gives a row per elite level, and the wiki **does not say** whether
they add up or each replaces the previous. The game does — see measurements
#22: both behaviours exist, and they differ by talent type.

* `replaces` — tiers replace each other. Visible from the text: for
  `Slashing Edge` it is `+4 %` → `+8 %`, a repeat of the same effect.
* `cumulative` — they add up. Visible on attribute talents: `+10 / +15 / +15
  / +20`, where under replacement the Elite 3 tier would be empty — it gives
  exactly as much as Elite 2.

Both are confirmed in game (measurements #22, `confirmed`): an attribute
talent shows the sum of tiers on the stat screen, while for a tiered one the
game draws a **selector** and ticks the strongest available tier itself. The
engine takes the group maximum for `replaces` and the sum for `cumulative`.

## The `stat` vocabulary

These are exactly the damage formula's groups. What does not land in the
formula is not a stat.

| `stat` | where | unit |
|---|---|---|
| `attr` (+`attribute`) | the operator's attribute, before `AttributeBonus`; `MAIN` / `SUB` — main / secondary | flat |
| `attr_pct` (+`attribute`) | percent of the full attribute (`Secondary attribute +32 %`) | frac |
| `atk_pct` | the `PercentBonuses` group inside Attack | frac |
| `atk_attr_factor` (+`perAttribute`) | an attribute point's coefficient in `AttributeBonus` | frac |
| `atk_flat` | `FixedBonus` | flat |
| `hp_pct`, `hp_flat` | HP; does not affect damage | frac, flat |
| `dmg_reduction` | the wearer's DMG Reduction; does not affect damage | frac |
| `treatment` | Treatment Efficiency | frac |
| `crit_rate`, `crit_dmg` | crit; `crit_dmg` with `skill` or `skillType` — only that skill's hits (Rossi's P5) | frac |
| `dmg_bonus` | the additive DMG Bonus / DMG Dealt group | frac |
| `arts_intensity` | Arts Intensity | flat |
| `amp` | Amp, by `element` | frac |
| `susceptibility` | Susceptibility on the target | frac |
| `dmg_taken` | DMG Taken on the target | frac |
| `weaken`, `protect` | Weaken / Protection | frac |
| `def_shred`, `res_ignore` | the target's DEF and resistance | frac |
| `base_multiplier` | Base DMG Multiplier | frac |
| `skill_multiplier` (+`skill`) | a specific skill's multiplier | mult |
| `stagger_flat` | Stagger Dealt | stagger |
| `stagger_eff`, `ult_gain_eff` | efficiency | frac |
| `sp_return`, `sp_cost` | SP | sp |
| `cooldown_flat` | cooldown in seconds | sec |
| `cooldown_pct`, `ult_cost_pct` | fraction of the original | frac |
| `extra_hit` (+`element`, `trigger`, `cooldown`, `stagger`) | not a buff: an instance of `value` × ATK when the trigger fires, at most once per `cooldown` seconds (Swordmancer's 250 % hit); damage like a status hit — no skill-type bonus; `stagger` — its own Stagger, before the wearer's Stagger Efficiency | frac |
| `reaction_duration_mult`, `reaction_dot_mult` (+`reaction`, `skillType`) | a reaction the wearer's skill of that type applies: its duration, its damage per tick (Laevatain's P3) | mult |

**ATK stages in the game code** (datamine, the modifier's `formulaItem`; the
enum and formula are the contract `attribute_formula_native.json` from
Variante/endfield_research_kit; measurements #8):

```
armed = (base × max(1 + ΣBaseMultiplier, 0) + ΣBaseFinalAddition) × ΠBaseFinalMultiplier
final = ((armed + ΣAddition) × max(1 + ΣMultiplier, 0) + ΣFinalAddition) × ΠFinalMultiplier
        × (1 + Σ floor(attribute) × atkRateOfMain/Sub)       ← AttributeBonus
base  = operator ATK + weapon ATK (BaseAddition)
```

`atk_pct` ↔ `BaseMultiplier` (6): every ATK % of operators, weapons, sets and
gear lives there, checked across all buffs on 2026-10-28. `atk_flat` ↔
`BaseFinalAddition` (7): flat ATK from weapons and gear. The `Multiplier`
stage (1) is a **separate** multiplicative group, but nothing grants it in
ordinary combat: only operator trials (`*_chrdg_*`) and events. If an
operator with `Multiplier` appears, it will need a new `stat`, not `atk_pct`.

`element: Arts` — every element except Physical ("Arts DMG Dealt"): for
`dmg_bonus` that is the sheet's `arts` bucket, for `dmg_taken` and
`susceptibility` a bonus to each arts element.

Filters on `dmg_bonus` and `skill_multiplier`: `element`, `skillType`,
`skill`, `staggered`, `targetHas` (a list of terms, any of them).

`perAttribute: [INT, WIL]` — a value **per point** of the listed attributes.
For `atk_attr_factor` the meaning differs: it is a bonus to the point
coefficient inside `AttributeBonus` (client attributes 76–79,
`AtkIncreaseFactorFrom{Str,Agi,Wisd,Will}`), not an ATK percentage. Lifeng's
`Illumination` is recorded that way — until 2026-10-28 it was `atk_pct` per
point, and the datamine check caught it (measurements #36).

## Checking against the datamine

After checking `seen`, `python3 tools/ef/effects.py` checks every `apply` row
against the client (the `tools/ef/sync.py` clone; without a clone the check
is skipped). The record is found like this: a potential via
`CharacterPotentialTable`, a talent tier by passive number and elite level in
`CharGrowthTable`, an attribute talent as a node of the same table. Compared
are the attribute, the formula stage (for ATK and HP) and the value, and for
stacking effects the stack cap.

A mismatch means a non-zero exit code and both versions printed. "The client
returns no attributes" means someone else applies the buff (Endministrator's
ATK comes from the shared crystal buff, not the talent tree) — a gap in the
check, not an error in the layer. What the client knows about an operator is
shown by `python3 tools/ef/datamine.py "<operator>"`.

## Triggers

The same vocabulary as for combos in `rotation.py`: `skill_hit`,
`cast:<type>` (`cast:Combo Skill@2` — that sequence of the cast), `applies:<term>`
(`applies:Solidification@Battle Skill` — applied by the wearer's own skill of that type), `consumes:<term>`, `target_has:<term>`,
`sp_recovered:<N>` (without `:<N>` — any refund), `hp_restored`,
`damage_taken`, `stacks_reached:<term>@<N>` (the wearer's own stacks —
`Synergy.ownStacks`, Laevatain's Melting Flame — crossed N at this step). Items add `crit` (the wearer's crit), `hp_above:<N>` (HP
above N %), `final_strike` (the wearer's own Final Strike) and
`charge_spent:<name>` (a point of the wearer's charge — Pogranichnik's Steel
Oath, `Synergy.charges` — spent at this step, by anyone). `|` — any of: `applies:Amp|applies:Weakness`. No trigger — the
effect is permanent and goes into the stat sheet.

The track follows triggers through simulation events (`engine/src/buffs.ts`):
a trigger takes effect from the next step, and a buff
with one id is one instance. In the build editor a trigger is a "buff is up"
toggle.

`controlled: true` — the row fires only while the wearer is the controlled
operator ("If the wielder is also the controlled operator, double the ATK
increase", Sundered Prince). On the track that is `Frame.controlled` at the
triggering step; the build editor assumes the wearer is controlled.

Two adjustments to stacks and duration:

* `stacks: {max: 4, from: consumed}` — "+6 % × consumed stacks": as many
  stacks as the step consumed, not one per trigger (Grizzled Edge, OBJ
  Velocitous);
* `spentBy: "cast:Battle Skill|cast:Ultimate"` — a "next cast" buff: this
  cast of the wearer spends it (Bonekrusha, Type 50 Yinglung, Grand Vision,
  Jade Vessel's combo).

## `grants`: a potential edits a skill's own Susceptibility or Amp

Lifeng's battle skill applies Physical Susceptibility 12 %, and the value is
a row of the skill (`export.py`, `skill_grants`; the engine reads it at the
skill level). A potential that changes it does not add a second buff — it
edits that one, so the duration and the condition stay the skill's:

```yaml
  - rank: 1
    seen: "Battle skill Turbid Avatar improved: Physical Susceptibility +5%; also triggers this additional effect to enemies with no more than 2 Vulnerability stacks."
    grants:
      - {term: Physical Susceptibility, skillType: Battle Skill, add: 5, atMost: 2}
```

`add` — percent, as in the text; `multiplier` — «increased to 1.1 times»;
`durationDelta` — seconds; `atMost` — «has no Vulnerability stacks» becomes
«no more than N»; `variant` — only one of Arcane's arrays. `seen` is
required, as with `apply`.

## `target`

`self` — the wearer, `team` — the whole squad including the wearer, `others`
— the squad **without** the wearer ("other teammates gain…", `Eternal
Xiranite`), `enemy` — the target, `spender` — whoever's step set the
trigger off, each with stacks of their own (Pogranichnik's Tactical
Instruction: the operator whose step spent a Steel Oath point). The engine returns `team` and `others` as a
separate list (`teamEffects`): these are buffs for squadmates, and the wearer
does not get `others`.

## `confidence`

`confirmed` — there is a measurement or a direct wiki statement.
`inferred` — derived from the shape of the data or by analogy.
`unknown` — recorded, but which group it lands in is unknown.
The app shows the confidence on every number.
