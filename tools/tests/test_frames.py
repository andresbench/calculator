"""Hit timeline from the client (`frames.py --export`, ENGINE_CORE_PLAN.md Я1).

Reads the versioned ``basic_attacks.json``, not the datamine clone: the
export is what the engine gets.
"""

import json
import unittest

from tools.ef.export import hit_times, read_frame_data, skill_stats
from tools.tests.support import DATA, skill


def frame_data() -> dict:
    return json.loads((DATA / "basic_attacks.json").read_text(encoding="utf-8"))["operators"]


class HitTimeline(unittest.TestCase):
    def test_battle_skill_lands_on_its_last_status_hit(self):
        # `lands` is checked on video for Lifeng (#63): the timeline must agree with it.
        checked = 0
        for name, record in frame_data().items():
            lands = (record.get("skillWindows") or {}).get("BS", {}).get("lands")
            if lands is None:
                continue
            status = [hit["at"] for hit in record["skillHits"]["BS"] if hit.get("status")]
            self.assertAlmostEqual(status[-1], lands, places=4, msg=name)
            checked += 1
        self.assertGreater(checked, 10)

    def test_lifeng_battle_skill(self):
        # Frames 7, 20, 54; the third comes after two 0.1 s hit stops: 2.00 s (#63).
        hits = frame_data()["Lifeng"]["skillHits"]["BS"]
        self.assertEqual([hit["at"] for hit in hits], [0.2333, 0.7667, 2.0])
        self.assertEqual([bool(hit.get("status")) for hit in hits], [False, False, True])

    def test_endministrator_final_strike(self):
        # The plan's «+0.6 to the hit»: frame 18 of the last segment, which
        # starts where the chain up to the Final Strike ends.
        record = frame_data()["Endministrator (female)"]
        chain = record["chainHits"]
        self.assertEqual(len(chain), 5)
        before = record["sequenceSeconds"] - record["finalStrikeSeconds"]
        self.assertAlmostEqual(chain[-1][0] - before, 0.6, places=3)

    def test_only_the_attackers_hit_stop_delays(self):
        # Lifeng's combo: the 1.333 s stop on the first hit is affectType 1,
        # the target's alone; the second hit is frame 48 (measurements, #68a).
        hits = frame_data()["Lifeng"]["skillHits"]["CS"]
        self.assertEqual([hit["at"] for hit in hits], [0.6333, 1.6])

    def test_chain_on_an_enemy(self):
        # First hit → Final Strike: 2.867 s of frames plus 0.49 s of the
        # attacker's own stops; 3.383 s on video (#68b).
        record = frame_data()["Endministrator (female)"]
        self.assertAlmostEqual(record["finalStrikeHit"] - record["chainHits"][0][0], 3.357, places=3)

    def test_final_strike_hit_is_the_sp_hit(self):
        # Lifeng's strike hits twice; the combo lights on the second (#68c).
        record = frame_data()["Lifeng"]
        self.assertEqual(record["finalStrikeHit"], record["chainHits"][-1][1])

    def test_combo_slowdown(self):
        # TimeDilationAction, curve ComboSkill, frame 0 (#64).
        operators = frame_data()
        slowdown = {name: operators[name]["skillWindows"]["CS"]["dilation"] for name in ("Chen Qianyu", "Lifeng", "Endministrator (female)")}
        self.assertEqual(slowdown, {"Chen Qianyu": 0.633, "Lifeng": 0.933, "Endministrator (female)": 0.867})

    def test_dive(self):
        # Jump → landing hit 0.50–0.53 s on video; the landing's own window
        # from the client (Chen: exclusiveFrame 20) (#21).
        record = frame_data()["Chen Qianyu"]["dive"]
        self.assertEqual(record["hit"], 0.52)
        self.assertAlmostEqual(record["seconds"], 0.52 - 1 / 30 + 21 / 30, places=3)

    def test_finisher(self):
        # Chen's on video: hits 1.00 s apart, 2.20 s press to the next attack (#21).
        record = frame_data()["Chen Qianyu"]["finisher"]
        self.assertAlmostEqual(record["hits"][1] - record["hits"][0], 1.0, places=2)
        self.assertAlmostEqual(record["seconds"], 2.2, places=2)

    def test_hits_are_in_order(self):
        for name, record in frame_data().items():
            for kind, hits in (record.get("skillHits") or {}).items():
                times = [hit["at"] for hit in hits]
                self.assertEqual(times, sorted(times), msg=f"{name} {kind}")
            for segment in record.get("chainHits") or []:
                self.assertEqual(segment, sorted(segment), msg=name)



def mapped(operator: str, skill_type: str) -> dict:
    raw = skill(operator, skill_type)
    stats, _ = skill_stats(raw)
    out = {**raw, "stats": stats}
    hit_times(out, read_frame_data()[operator])
    return out


def times(mapped_skill: dict, label: str) -> list[float]:
    return next(row for row in mapped_skill["stats"] if row["label"] == label)["hit"]["at"]


class RowsToHits(unittest.TestCase):
    def test_chen_ultimate_six_slashes_then_the_final(self):
        ultimate = mapped("Chen Qianyu", "Ultimate")
        self.assertEqual(len(times(ultimate, "Slash Multiplier")), 6)
        self.assertEqual(times(ultimate, "Final Strike DMG Multiplier"), [3.4333])
        self.assertNotIn("hitTimes", ultimate)

    def test_pogranichnik_combo_takes_its_first_variant(self):
        # One timeline per stack count in the client; the first holds the three slashes.
        combo = mapped("Pogranichnik", "Combo Skill")
        firsts = [times(combo, f"SEQ {n} DMG Multiplier")[0] for n in (1, 2, 3)]
        self.assertEqual(firsts, sorted(firsts))
        self.assertLess(firsts[-1], 3)
        self.assertNotIn("hitTimes", combo)

    def test_basic_attack_rows_are_segments(self):
        basic = mapped("Lifeng", "Basic Attack")
        self.assertEqual(len(times(basic, "BATK SEQ 1 Multiplier")), 2)

    def test_disagreement_is_said(self):
        # One wiki row, two client hits: the row lands on the last hit, and the skill says so.
        battle = mapped("Ember", "Battle Skill")
        self.assertEqual(battle.get("hitTimes"), "last")


if __name__ == "__main__":
    unittest.main()
