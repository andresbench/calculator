"""Hit and SP roles, hit counts, phases: what the engine reads off each row.

Synthetic rows pin the edge cases; the real skills pin the decisions the
engine and the golden tests rely on (hit counts, two-phase ultimates;
measurements #23 for Pogranichnik).
"""

import unittest

from tools.ef.export import energy_roles, hit_counts, hit_roles, skill_stats, sp_roles, ultimate_phases
from tools.tests.support import row, skill


def rows(*labels: str, unit: str = "frac") -> list[dict]:
    return [{"label": label, "unit": unit, "values": [1.0]} for label in labels]


class HitRoles(unittest.TestCase):
    def test_basic_attack_parts(self):
        stats = rows("BATK SEQ 3 Multiplier", "Dive ATK Multiplier", "Finisher ATK Multiplier")
        hit_roles("Basic Attack", stats)
        self.assertEqual([r["hit"]["part"] for r in stats], ["chain", "dive", "finisher"])
        self.assertEqual(stats[0]["hit"]["sequence"], 3)

    def test_roles_by_label(self):
        stats = rows(
            "SEQ 2 DMG Multiplier",
            "Bonus DMG Multiplier per Infliction Stack",
            "Enhanced SEQ 3 DMG Multiplier",
            "DMG Against Solidified Enemies",
            "DMG Against Non-Solidified Enemies",
        )
        hit_roles("Battle Skill", stats)
        self.assertEqual(
            [(r["hit"]["role"], r["hit"]["sequence"]) for r in stats],
            [("hit", 2), ("perStack", None), ("conditional", 3), ("conditional", None), ("hit", None)],
        )

    def test_buffs_and_non_fractions_are_not_hits(self):
        stats = rows("Heat Susceptibility", "Critical DMG Boost", "Nature Burst DMG Boost")
        stats += rows("Stagger", unit="stagger")
        hit_roles("Combo Skill", stats)
        self.assertFalse(any("hit" in r for r in stats))

    def test_named_moves_are_numbered_by_the_sp_cost_sequences(self):
        stats, _ = skill_stats(skill("Mi Fu", "Battle Skill"))
        self.assertEqual(row(stats, "Cloudtrapper DMG Multiplier")["hit"]["sequence"], 1)
        self.assertEqual(row(stats, "Trail and Mangle DMG Multiplier")["hit"]["sequence"], 2)
        self.assertEqual(row(stats, "World Splitter DMG Multiplier")["hit"]["sequence"], 3)


class HitCounts(unittest.TestCase):
    def test_final_slash_is_its_own_row(self):
        # "A 7-sequence slash attack … The final slash sequence deals even more DMG".
        stats, _ = skill_stats(skill("Chen Qianyu", "Ultimate"))
        self.assertEqual(row(stats, "Slash Multiplier")["hit"]["count"], 6)
        self.assertNotIn("count", row(stats, "Final Strike DMG Multiplier")["hit"])

    def test_flurry_before_the_final_bash(self):
        stats, _ = skill_stats(skill("Da Pan", "Ultimate"))
        self.assertEqual(row(stats, "Aerial Flurry DMG Multiplier")["hit"]["count"], 6)

    def test_per_seq_takes_the_number_from_the_text(self):
        stats, _ = skill_stats(skill("Akekuri", "Combo Skill"))
        self.assertEqual(row(stats, "DMG Multiplier per SEQ")["hit"]["count"], 2)
        stats, _ = skill_stats(skill("Wulfgard", "Ultimate"))
        self.assertEqual(row(stats, "DMG Multiplier per SEQ")["hit"]["count"], 5)

    def test_no_number_in_the_text_is_unknown_not_one(self):
        stats, _ = skill_stats(skill("Liino", "Ultimate"))
        self.assertIsNone(row(stats, "DMG Multiplier per Beat")["hit"]["count"])
        stats, _ = skill_stats(skill("Laevatain", "Battle Skill"))
        self.assertIsNone(row(stats, "DMG Over Time Multiplier per SEQ")["hit"]["count"])

    def test_rows_already_split_by_seq_hit_once(self):
        stats = rows("SEQ 1 Slash DMG Multiplier", "SEQ 2 Slash DMG Multiplier")
        hit_roles("Battle Skill", stats)
        hit_counts({"text": "A 2-sequence slash attack."}, stats)
        self.assertFalse(any("count" in r["hit"] for r in stats))


class RepeatedHits(unittest.TestCase):
    """Rows that hit again and again: a missing count is one hit, so it must be said (В31).

    Real texts from ``operators.json``. The tick convention (first tick at the
    press or one interval later) is in no text; ``floor(duration / interval)``
    holds for both, and these tests pin that, not an exact tick schedule.
    """

    def test_damage_over_time_is_duration_over_interval(self):
        # 0.5 s interval, 5.0 s duration.
        stats, _ = skill_stats(skill("Snowshine", "Ultimate"))
        self.assertEqual(row(stats, "DMG Over Time Multiplier")["hit"]["count"], 10)
        self.assertNotIn("count", row(stats, "Explosion DMG Multiplier")["hit"])

    def test_one_hit_every_interval_from_the_text(self):
        # "Each enemy can only take 1 damaging hit every 0.3s", duration 3.0 s.
        stats, _ = skill_stats(skill("Ardelia", "Ultimate"))
        self.assertEqual(row(stats, "DMG Multiplier")["hit"]["count"], 10)

    def test_the_fifth_hail_is_the_empowered_one(self):
        stats, _ = skill_stats(skill("Typhoeus", "Ultimate"))
        self.assertEqual(row(stats, "Normal Hail of Arrows DMG")["hit"]["count"], 4)
        self.assertNotIn("count", row(stats, "Empowered Hail of Arrows DMG")["hit"])
        self.assertNotIn("count", row(stats, "Imbued Arrow Explosion DMG")["hit"])

    def test_the_fifth_abatk_is_the_final_strike_row(self):
        stats, _ = skill_stats(skill("Typhoeus", "Battle Skill"))
        self.assertEqual(row(stats, "ABATK DMG")["hit"]["count"], 4)
        self.assertNotIn("count", row(stats, "Aerial Final Strike DMG")["hit"])
        self.assertNotIn("count", row(stats, "Initial Aerial Shot DMG Multiplier")["hit"])

    def test_over_time_without_a_tick_rate_is_unknown(self):
        stats, _ = skill_stats(skill("Typhoeus", "Combo Skill"))
        self.assertIsNone(row(stats, "Area DMG Over Time")["hit"]["count"])
        self.assertNotIn("count", row(stats, "\"Huntress's Gaze\" Hit DMG")["hit"])

    def test_strikes_that_follow_the_stacks_are_unknown(self):
        stats, _ = skill_stats(skill("Zhuang Fangyi", "Battle Skill"))
        self.assertIsNone(row(stats, "Thunder Strike DMG Multiplier")["hit"]["count"])

    def test_a_total_over_the_duration_is_one_hit(self):
        # Tangtang: "DMG Over Time Total Multiplier" is the sum, not a per-tick number.
        stats, _ = skill_stats(skill("Tangtang", "Ultimate"))
        self.assertNotIn("count", row(stats, "DMG Over Time Total Multiplier")["hit"])

    def test_laevatain_ticks_stay_with_the_client_summon(self):
        # `hit_counts` leaves her row unknown; the client's summon fills it in later.
        stats, _ = skill_stats(skill("Laevatain", "Battle Skill"))
        self.assertIsNone(row(stats, "DMG Over Time Multiplier per SEQ")["hit"]["count"])

    def test_tick_count_edges(self):
        def count(*extra):
            stats = rows("DMG Over Time Multiplier") + [
                {"label": label, "unit": "sec", "values": values} for label, values in extra
            ]
            hit_roles("Ultimate", stats)
            hit_counts({"text": ""}, stats)
            return stats[0]["hit"]["count"]

        self.assertEqual(count(("DMG Over Time Interval (s)", [0.5, 0.5]), ("Duration (s)", [5.0, 5.0])), 10)
        # An interval that does not divide the duration: floor, no tick is made up.
        self.assertEqual(count(("DMG Over Time Interval (s)", [0.4]), ("Duration (s)", [5.0])), 12)
        # Either row missing, or one that changes with the level: unknown.
        self.assertIsNone(count(("Duration (s)", [5.0])))
        self.assertIsNone(count(("DMG Over Time Interval (s)", [0.5])))
        self.assertIsNone(count(("DMG Over Time Interval (s)", [0.5, 0.4]), ("Duration (s)", [5.0, 5.0])))
        # Another row's interval ("Beat Interval (s)") is not this row's.
        self.assertIsNone(count(("Beat Interval (s)", [0.5]), ("Duration (s)", [5.0])))


class UltimatePhases(unittest.TestCase):
    def test_arcane_array_then_arcana(self):
        stats, extras = skill_stats(skill("Arcane", "Ultimate"))
        self.assertEqual(extras["switch"]["to"], "Gloompurge Arcana")
        self.assertEqual(row(stats, "Gloompurger Array Creation DMG Multiplier")["hit"]["sequence"], 1)
        self.assertEqual(row(stats, "Gloompurge Arcana DMG Multiplier")["hit"]["sequence"], 2)
        # Cluster Strike comes from others' finishers, not from the cast.
        self.assertEqual(row(stats, "Cluster Strike Total DMG Multiplier")["hit"]["role"], "conditional")

    def test_window_skips_reaction_durations(self):
        stats = rows("Forced Corrosion Duration (s)", "Array Duration (s)", unit="sec")
        stats[0]["values"], stats[1]["values"] = [10.0], [20.0]
        phases = ultimate_phases({"text": "After that, the ultimate is switched to Arcana."}, stats)
        self.assertEqual(phases, {"to": "Arcana", "window": 20.0})

    def test_single_phase_ultimates(self):
        self.assertIsNone(ultimate_phases(skill("Chen Qianyu", "Ultimate"), []))


class SpRoles(unittest.TestCase):
    def test_when_each_row_applies(self):
        stats = rows(
            "SP Recovery",
            "Base SP Recovery",
            "SP Return",
            "SP Recovery by Consuming 3 Vulnerability Stacks",
            "SEQ 2 SP Recovery",
            "SP Recovery per Target Defeated",
            unit="sp",
        )
        sp_roles(stats)
        self.assertEqual(
            [r["sp"] for r in stats],
            [
                {"kind": "recovery", "when": "always"},
                {"kind": "recovery", "when": "always"},
                {"kind": "return", "when": "always"},
                {"kind": "recovery", "when": "consumed", "stacks": 3},
                {"kind": "recovery", "when": "sequence", "sequence": 2},
                {"kind": "recovery", "when": "conditional"},
            ],
        )

    def test_sp_cost_is_not_a_recovery(self):
        stats = rows("SP Cost", unit="sp")
        sp_roles(stats)
        self.assertNotIn("sp", stats[0])


class EnergyRoles(unittest.TestCase):
    """A combo's energy is the sum of its rows, not the first one (audit В2)."""

    @staticmethod
    def roles(operator: str) -> dict[str, dict]:
        stats, _ = skill_stats(skill(operator, "Combo Skill"))
        return {r["label"]: r["energy"] for r in stats if "energy" in r}

    def test_a_plain_combo_has_one_base_row(self):
        self.assertEqual(self.roles("Chen Qianyu"), {"Ultimate Energy Gain": {"role": "base"}})

    def test_last_rite_base_and_a_gain_per_infliction_stack(self):
        # "determines the amount of Cryo DMG dealt … and Ultimate Energy gained by Last Rite".
        self.assertEqual(
            self.roles("Last Rite"),
            {
                "Base Ultimate Energy Gain": {"role": "base"},
                "Additional Ultimate Energy Gain per Infliction Stack": {"role": "perStack", "stack": "infliction"},
            },
        )

    def test_rossi_gains_by_sequence(self):
        self.assertEqual(
            self.roles("Rossi"),
            {
                "SEQ 1 Ultimate Energy Gain": {"role": "perSequence", "sequence": 1},
                "SEQ 2 Ultimate Energy Gain": {"role": "perSequence", "sequence": 2},
            },
        )

    def test_yvonne_additional_gain_is_tied_to_the_hit_by_the_text(self):
        # "After the combo skill successfully hits the enemy, Yvonne gains additional Ultimate Energy."
        roles = self.roles("Yvonne")
        self.assertEqual(roles["Ultimate Energy Gain"], {"role": "base"})
        self.assertEqual(roles["Additional Ultimate Energy Gain"], {"role": "onHit"})
        self.assertNotIn("Number of Energy Releases", roles)

    def test_an_additional_row_the_text_does_not_tie_to_a_hit_is_not_counted(self):
        stats = [{"label": "Additional Ultimate Energy Gain", "unit": "energy", "values": [10.0]}]
        energy_roles({"type": "Combo Skill", "text": "Gains additional Ultimate Energy."}, stats)
        self.assertEqual(stats[0]["energy"], {"role": "conditional"})

    def test_zhuang_fangyi_gain_per_infliction_stack(self):
        # "give Ultimate Energy based on the number of stacks consumed".
        roles = self.roles("Zhuang Fangyi")
        self.assertEqual(roles["Ultimate Energy Gain"], {"role": "base"})
        self.assertEqual(
            roles["Additional Ultimate Energy per Infliction Stack"], {"role": "perStack", "stack": "infliction"}
        )

    def test_laevatain_rows_by_the_number_of_enemies_hit(self):
        self.assertEqual(
            self.roles("Laevatain"),
            {
                "Ultimate Energy Gain when Hitting 1 Enemy": {"role": "onHit", "targets": 1},
                "Ultimate Energy Gain when Hitting 2 Enemies": {"role": "onHit", "targets": 2},
                "Ultimate Energy Gain when Hitting 3 Enemies": {"role": "onHit", "targets": 3},
            },
        )

    def test_a_stack_kind_the_label_leaves_out_comes_from_the_text(self):
        label = "Ultimate Energy per Stack"
        stats = [{"label": label, "unit": "energy", "values": [5.0]}]
        energy_roles({"type": "Combo Skill", "text": "Consumes all Vulnerable stacks."}, stats)
        self.assertEqual(stats[0]["energy"], {"role": "perStack", "stack": "vulnerable"})
        stats = [{"label": label, "unit": "energy", "values": [5.0]}]
        energy_roles({"type": "Combo Skill", "text": "Deals DMG."}, stats)
        self.assertEqual(stats[0]["energy"], {"role": "conditional"})

    def test_only_combo_gains_are_tagged(self):
        # The ultimate's cost and battle-skill energy (own stacks) are other things.
        for operator, kind in [("Chen Qianyu", "Ultimate"), ("Laevatain", "Battle Skill"), ("Zhuang Fangyi", "Battle Skill")]:
            stats, _ = skill_stats(skill(operator, kind))
            self.assertFalse(any("energy" in r for r in stats), f"{operator} {kind}")

    def test_every_combo_energy_row_has_a_role(self):
        from tools.tests.support import operators

        for name, operator in operators().items():
            for item in operator["skills"]:
                if item["type"] != "Combo Skill":
                    continue
                stats, _ = skill_stats(item)
                for r in stats:
                    if r["unit"] == "energy":
                        self.assertIn("energy", r, f"{name}: {r['label']}")


class Conditions(unittest.TestCase):
    def test_pogranichnik_combo_moves_by_stacks(self):
        stats, extras = skill_stats(skill("Pogranichnik", "Combo Skill"))
        self.assertEqual(extras["moves"], {"by": "stacks", "max": 3, "enhanced": {"stacks": 4, "sequence": 3}})
        enhanced = row(stats, "Enhanced SEQ 3 DMG Multiplier")["hit"]
        self.assertEqual((enhanced["role"], enhanced["when"]), ("conditional", "stacks:4"))
        self.assertEqual(row(stats, "Enhanced SEQ 3 SP Recovery")["sp"]["stacks"], 4)

    def test_final_strike_stagger_from_the_basic_attack_text(self):
        # "As the controlled operator, Final Strike also deals 18 Stagger."
        _, extras = skill_stats(skill("Ardelia", "Basic Attack"))
        self.assertEqual(extras["finalStrikeStagger"], 18)

    def test_pogranichnik_steel_oath_rows_land_on_spent_points(self):
        # «Summons 1 Shieldguard to harass … When the last Steel Oath point is
        # consumed, all 4 Shieldguards will initiate a Decisive Assault»: not hits
        # of the ultimate itself.
        stats, _ = skill_stats(skill("Pogranichnik", "Ultimate"))
        self.assertEqual(row(stats, "Advance DMG Multiplier")["hit"]["role"], "hit")
        harass = row(stats, "Harass DMG Multiplier")["hit"]
        self.assertEqual((harass["role"], harass["when"]), ("delayed", "charge:Steel Oath"))
        self.assertEqual(row(stats, "Decisive Assault DMG Multiplier")["hit"]["when"], "chargeLast:Steel Oath")
        self.assertEqual(row(stats, "Harass SP Recovery")["sp"], {"kind": "recovery", "when": "charge"})
        self.assertEqual(row(stats, "Decisive Assault SP Recovery")["sp"], {"kind": "recovery", "when": "chargeLast"})


class SpFromText(unittest.TestCase):
    """SP the stat table leaves out and the skill text states."""

    def test_stage_costs_and_returns(self):
        # «MOVE 1 - Cloudtrapper: Costs 100 SP and returns50 SP after casting»
        stats, _ = skill_stats(skill("Mi Fu", "Battle Skill"))
        self.assertEqual([stage[-1] for stage in row(stats, "SP Cost")["sequences"]], [100, 50, 50])
        back = row(stats, "SP Return")
        self.assertEqual([stage[-1] for stage in back["sequences"]], [50, 0, 0])
        self.assertEqual(back["sp"], {"kind": "return", "when": "always"})
        self.assertTrue(back["fromText"])

    def test_a_free_stage_the_cost_row_leaves_out(self):
        # Si: skill 100, «Initial Stroke: Costs 15 SP», «Final Stroke: Costs no SP».
        stats, _ = skill_stats(skill("Si", "Battle Skill"))
        self.assertEqual([stage[-1] for stage in row(stats, "SP Cost")["sequences"]], [100, 15, 0])
        self.assertFalse(any(r["label"] == "SP Return" for r in stats))

    def test_sp_per_sequence_counts_the_sequences(self):
        # «2 thrust sequences, with each sequence dealing Physical DMG and recovering some SP»
        stats, _ = skill_stats(skill("Akekuri", "Combo Skill"))
        self.assertEqual(row(stats, "SP Recovery per SEQ")["sp"], {"kind": "recovery", "when": "always", "count": 2})

    def test_a_return_that_waits_on_something_stays_conditional(self):
        stats, _ = skill_stats(skill("Tangtang", "Battle Skill"))
        self.assertEqual(row(stats, "SP Return per Whirlpool")["sp"]["when"], "conditional")


class TransformedRows(unittest.TestCase):
    def test_hunter_pursuit_rows_belong_to_the_move(self):
        from tools.ef.export import transformed_rows
        from tools.tests.support import operators

        record = operators()["Camille"]
        skills = [{"type": s["type"], "stats": skill_stats(s)[0]} for s in record["skills"]]
        transformed_rows(record, skills)
        combo = next(s for s in skills if s["type"] == "Combo Skill")["stats"]
        self.assertNotIn("move", row(combo, "DMG Multiplier"))
        self.assertNotIn("move", row(combo, "Stagger"))
        for label in ("Hunter Pursuit DMG Multiplier", "Hunter Pursuit Stagger", "Hunter Pursuit SP Recovery"):
            self.assertEqual(row(combo, label)["move"], "Hunter Pursuit")
        self.assertEqual(row(combo, "Hunter Pursuit SP Recovery")["sp"], {"kind": "recovery", "when": "transformed"})

    def test_estella_combo_rows_by_the_target_state(self):
        # «If the skill hits a target with Solidification, the skill deals
        # additional DMG»: the two rows are either/or, by what the target has.
        from tools.ef.export import skill_conditions
        from tools.tests.support import operators

        combo = next(s for s in operators()["Estella"]["skills"] if s["type"] == "Combo Skill")
        stats = skill_stats(combo)[0]
        skill_conditions(combo, stats)
        self.assertEqual(row(stats, "DMG Multiplier Against Solidified Enemies")["hit"]["when"], "target_has:Solidification")
        self.assertEqual(row(stats, "DMG Multiplier Against Non-Solidified Enemies")["hit"]["when"], "target_lacks:Solidification")


class StockRows(unittest.TestCase):
    def test_tangtang_battle_skill_rows_scale_with_what_it_made(self):
        from tools.ef.export import stock_rows
        from tools.tests.support import operators

        record = operators()["Tangtang"]
        skills = [{"name": s["name"], "type": s["type"], "stats": skill_stats(s)[0]} for s in record["skills"]]
        stock_rows(record, skills)
        battle = next(s for s in skills if s["type"] == "Battle Skill")["stats"]
        self.assertEqual(row(battle, "DMG Multiplier (1 Waterspout)")["hit"]["per"], "Waterspout")
        self.assertNotIn("per", row(battle, "Shooting DMG Multiplier")["hit"])
        self.assertEqual(row(battle, "SP Return per Whirlpool")["sp"], {"kind": "return", "when": "perStock"})
        self.assertEqual(row(battle, "Arts Susceptibility (2 Waterspouts)")["made"], 2)
        self.assertEqual(row(battle, "Arts Susceptibility (3 Waterspouts)")["made"], 3)


class SkillGrants(unittest.TestCase):
    """Susceptibility and Amp a skill puts up itself: term, value rows, duration, condition."""

    def grants(self, operator: str, skill_type: str, variant: str | None = None) -> dict:
        from tools.ef.export import skill_grants, stock_rows
        from tools.tests.support import operators

        record = operators()[operator]
        skills = [{**s, "stats": skill_stats(s)[0]} for s in record["skills"]]
        stock_rows(record, skills)
        found = next(s for s in skills if s["type"] == skill_type and (variant is None or s.get("variant") == variant))
        return {grant["term"]: grant for grant in skill_grants(found)}

    def test_a_row_named_after_the_term(self):
        lifeng = self.grants("Lifeng", "Battle Skill")["Physical Susceptibility"]
        self.assertEqual(lifeng["rows"], [{"row": "Physical Susceptibility"}])
        self.assertEqual(lifeng["duration"], "Physical Susceptibility Duration (s)")
        self.assertEqual(lifeng["target"], "enemy")

    def test_conditions_from_the_text(self):
        # «If the enemy struck by the last hit of this skill has no Vulnerability stacks»
        self.assertEqual(self.grants("Lifeng", "Battle Skill")["Physical Susceptibility"]["requires"], {"lacks": "Vulnerable"})
        # «If the target has Corrosion, then consume the Corrosion and apply …»
        ardelia = self.grants("Ardelia", "Battle Skill")
        self.assertEqual(set(ardelia), {"Physical Susceptibility", "Arts Susceptibility"})
        self.assertEqual(ardelia["Arts Susceptibility"]["requires"], {"has": "Corrosion"})
        self.assertEqual(ardelia["Arts Susceptibility"]["rows"], [{"row": "Susceptibility"}])
        # «If the skill hits a target with Solidification»
        self.assertEqual(self.grants("Estella", "Combo Skill")["Physical Susceptibility"]["requires"], {"has": "Solidification"})
        self.assertNotIn("requires", self.grants("Mi Fu", "Combo Skill")["Physical Susceptibility"])

    def test_a_mention_is_not_an_application(self):
        # «To enemies with Physical Susceptibility, the skill forcibly applies Lift»
        self.assertEqual(self.grants("Estella", "Ultimate"), {})
        self.assertEqual(self.grants("Lifeng", "Combo Skill"), {})

    def test_amp_to_the_team_and_what_it_scales_with(self):
        si = self.grants("Si", "Ultimate")
        self.assertEqual(set(si), {"Cryo Amp", "Heat Amp"})
        self.assertEqual(si["Heat Amp"]["rows"], [{"row": "Amp"}])
        self.assertEqual(si["Heat Amp"]["target"], "team")
        self.assertEqual(si["Heat Amp"]["duration"], "Amp Duration (s)")
        xaihi = self.grants("Xaihi", "Ultimate")["Cryo Amp"]["rows"]
        self.assertEqual(
            xaihi, [{"row": "Base Cryo Amp"}, {"row": "Amp Increase per Intellect", "per": "INT", "max": "MAX Amp from INT"}]
        )
        self.assertEqual(self.grants("Liino", "Ultimate")["Nature Amp"]["duration"], "Cosmovoice Stance Duration (s)")
        gilberta = self.grants("Gilberta", "Ultimate")["Arts Susceptibility"]["rows"]
        self.assertEqual(gilberta[1], {"row": "Arts Susceptibility Boost per Vulnerability", "per": "Vulnerable"})
        arcane = self.grants("Arcane", "Combo Skill", "Array Arcana: WILL")["Cryo Susceptibility"]["rows"]
        self.assertEqual(
            arcane[1], {"row": "Max Bonus Susceptibility from Will", "per": "WIL", "at": "Will for MAX Bonus Susceptibility"}
        )

    def test_the_value_by_what_the_cast_made(self):
        rows = self.grants("Tangtang", "Battle Skill")["Arts Susceptibility"]["rows"]
        self.assertEqual([r.get("made") for r in rows], [2, 3])

    def test_left_out_and_why(self):
        # «There is a chance that the Prezzie reveals Ambassador's Special that applies Arts Susceptibility»
        self.assertEqual(self.grants("Purrchena", "Ultimate")["Arts Susceptibility"]["uncounted"], "chance")
        self.assertNotIn("uncounted", self.grants("Xaihi", "Ultimate")["Cryo Amp"])

    def test_an_amp_on_the_controlled_operators_final_strike(self):
        # «After the controlled operator performs a Final Strike … This effect can trigger 2 times … grant the said operator a temporary Arts Amp»
        crystal = self.grants("Xaihi", "Battle Skill")["Arts Amp"]
        self.assertEqual(crystal["target"], "controlled")
        self.assertEqual(crystal["on"], {"strike": "Final Strike", "times": 2, "window": "Auxiliary Crystal Duration (s)"})
        self.assertEqual(crystal["duration"], "Arts Amp Duration (s)")
        self.assertNotIn("uncounted", crystal)


class SkillBoosts(unittest.TestCase):
    """Crit and ATK a skill's own rows grant: who gets it, from when, for how long."""

    def boosts(self, operator: str, skill_type: str) -> list[dict]:
        from tools.ef.export import skill_boosts
        from tools.tests.support import operators

        found = next(s for s in operators()[operator]["skills"] if s["type"] == skill_type)
        return skill_boosts({**found, "stats": skill_stats(found)[0]})

    def test_rossi_combo_sequence_2_buffs_herself(self):
        # «COMBO SEQUENCE 2 … buffs Rossi's Critical Rate and Critical DMG Dealt at the same time»
        self.assertEqual(
            self.boosts("Rossi", "Combo Skill"),
            [
                {"stat": "crit_rate", "row": "Critical Rate", "when": "cast", "target": "self", "duration": "Buff Duration (s)", "sequence": 2},
                {"stat": "crit_dmg", "row": "Critical DMG Boost", "when": "cast", "target": "self", "duration": "Buff Duration (s)", "sequence": 2},
            ],
        )

    def test_rossi_ultimate_crit_damage_is_its_own(self):
        # «When this skill successfully scores a critical hit, it deals higher Critical DMG»
        self.assertEqual(self.boosts("Rossi", "Ultimate"), [{"stat": "crit_dmg", "row": "Critical DMG Boost", "when": "own"}])

    def test_liino_stances_share_a_slot(self):
        battle = self.boosts("Liino", "Battle Skill")
        ultimate = self.boosts("Liino", "Ultimate")
        self.assertEqual(battle[0]["target"], "team")
        self.assertEqual(battle[0]["duration"], "Vocalist Stance Duration (s)")
        self.assertEqual(ultimate[0]["duration"], "Cosmovoice Stance Duration (s)")
        self.assertEqual({battle[0]["slot"], ultimate[0]["slot"]}, {"stance"})

    def test_a_per_stack_row_is_not_a_boost(self):
        # «Critical Rate Boost per Stack» ramps shot by shot: the barrage carries it, not a boost.
        self.assertEqual(self.boosts("Yvonne", "Ultimate"), [])


class UltimateBarrage(unittest.TestCase):
    """Yvonne's ultimate as one long cast: shots from the client's frames, the rest from the rows."""

    def barrage(self, operator: str):
        from tools.ef.export import read_frame_data, ultimate_barrage
        from tools.tests.support import operators

        found = next(s for s in operators()[operator]["skills"] if s["type"] == "Ultimate")
        stats = skill_stats(found)[0]
        return ultimate_barrage({**found, "stats": stats}, read_frame_data().get(operator)), stats

    def test_yvonne_shots_and_stacks(self):
        barrage, stats = self.barrage("Yvonne")
        self.assertEqual(barrage["shots"], sum(count for _, count in barrage["ramp"]))
        self.assertEqual(row(stats, "BATK DMG Multiplier")["hit"]["count"], barrage["shots"])
        # Every shot fires with the stacks the earlier shots left, up to the cap.
        self.assertEqual(barrage["ramp"][0], [0, 1])
        self.assertEqual(barrage["finalStacks"], row(stats, "Max Stacks")["values"][-1])
        self.assertGreater(barrage["seconds"], row(stats, "Duration (s)")["values"][-1])
        self.assertLess(barrage["strikeAt"], barrage["seconds"])
        self.assertEqual(barrage["stack"]["rate"], "Critical Rate Boost per Stack")

    def test_the_closing_strike_lands_the_extra_attack_needs_solidification(self):
        _, stats = self.barrage("Yvonne")
        self.assertEqual(row(stats, "Enhanced Final Strike DMG Multiplier")["hit"]["role"], "hit")
        # «If the enemy is Solidified, Yvonne performs an additional attack … and then consumes the enemy's Solidification»
        self.assertEqual(
            row(stats, "Additional ATK DMG Multiplier")["hit"], {"role": "conditional", "sequence": None, "part": None, "when": "consumes:Solidification"}
        )

    def test_an_enhanced_chain_that_closes_is_not_a_barrage(self):
        # Laevatain's ultimate enhances four sequences that loop back to the first.
        self.assertIsNone(self.barrage("Laevatain")[0])

    def test_energy_releases_count_from_their_own_row(self):
        # «Number of Energy Releases» next to «Energy DMG Multiplier» (Yvonne's combo).
        stats = skill_stats(skill("Yvonne", "Combo Skill"))[0]
        self.assertEqual(row(stats, "Energy DMG Multiplier")["hit"]["count"], row(stats, "Number of Energy Releases")["values"][0])


if __name__ == "__main__":
    unittest.main()
