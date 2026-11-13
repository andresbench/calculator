import unittest

from tools.common.wikitext import find_templates, parse_number_list
from tools.common.luadata import parse_assignment, parse_lua_table


class NumberListEdges(unittest.TestCase):
    def test_thousands_separator_is_not_a_list_separator(self):
        self.assertEqual(parse_number_list("1,000, 2,000, 3,500"), [1000.0, 2000.0, 3500.0])

    def test_plain_comma_list_still_splits(self):
        self.assertEqual(parse_number_list("1, 2, 3"), [1.0, 2.0, 3.0])

    def test_three_digit_groups_after_space_split(self):
        self.assertEqual(parse_number_list("10, 200, 3000"), [10.0, 200.0, 3000.0])

    def test_leading_tilde_is_approximate(self):
        result = parse_number_list("10%, ~12%, 14%")
        self.assertEqual(len(result), 3)
        self.assertAlmostEqual(result[0], 0.1)
        self.assertAlmostEqual(result[1], 0.12)
        self.assertAlmostEqual(result[2], 0.14)


class FindTemplatesEdges(unittest.TestCase):
    def test_commented_out_template_is_skipped(self):
        result = find_templates(
            "<!-- {{Combat skill|name=Old}} -->{{Combat skill|name=New}}",
            "Combat skill",
        )
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["params"]["name"], "New")

    def test_multiline_comment_is_skipped(self):
        result = find_templates(
            "<!--\n{{Combat skill|name=Old}}\n-->{{Combat skill|name=New}}",
            "Combat skill",
        )
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["params"]["name"], "New")


class LuaEdges(unittest.TestCase):
    def test_number_before_line_comment(self):
        data = parse_lua_table("{ time = 5 -- seconds\n, name = 'x' }")
        self.assertEqual(data["time"], 5)
        self.assertEqual(data["name"], "x")

    def test_semicolon_field_separator(self):
        self.assertEqual(parse_lua_table("{a = 1; b = 2}"), {"a": 1, "b": 2})

    def test_assignment_matches_whole_identifier(self):
        self.assertEqual(
            parse_assignment("local metadata = {x=1}\nlocal data = {y=2}", "data"),
            {"y": 2},
        )

    def test_commented_assignment_is_ignored(self):
        self.assertEqual(
            parse_assignment("-- data = {z=1}\nlocal data = {y=2}", "data"),
            {"y": 2},
        )


if __name__ == "__main__":
    unittest.main()
