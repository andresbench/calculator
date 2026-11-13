"""Parsing Lua table literals into Python structures.

Wiki data often lives right in Lua modules: Endfield's mechanics glossary is
built that way, and so is ZZZ's ``Module:CentralData/*``. Running Lua for this
is neither needed nor safe: parsing the table literal itself is enough.

Supported is what actually occurs in such modules: single- and double-quoted
strings plus long brackets ``[[...]]``, numbers, ``true``/``false``/``nil``,
nested tables, keys of the form ``["k"]=`` and ``k=``, positional values,
trailing commas and ``--`` comments.
"""

from __future__ import annotations

import re


class LuaParseError(ValueError):
    pass


class _Parser:
    def __init__(self, text: str) -> None:
        self.text = text
        self.pos = 0

    # ------------------------------------------------------------- lexing

    def skip(self) -> None:
        while self.pos < len(self.text):
            char = self.text[self.pos]
            if char in " \t\r\n":
                self.pos += 1
                continue
            if self.text.startswith("--", self.pos):
                # A block comment --[[ ... ]] or a line comment to the end of the line.
                if self.text.startswith("--[[", self.pos):
                    end = self.text.find("]]", self.pos)
                    self.pos = len(self.text) if end == -1 else end + 2
                else:
                    end = self.text.find("\n", self.pos)
                    self.pos = len(self.text) if end == -1 else end + 1
                continue
            break

    def expect(self, char: str) -> None:
        self.skip()
        if self.pos >= len(self.text) or self.text[self.pos] != char:
            got = self.text[self.pos : self.pos + 20] if self.pos < len(self.text) else "EOF"
            raise LuaParseError(f"expected {char!r} at position {self.pos}, got {got!r}")
        self.pos += 1

    # -------------------------------------------------------------- strings

    def parse_string(self) -> str:
        quote = self.text[self.pos]

        if quote == "[":
            # A long bracket [[...]] or [=[...]=].
            start = self.pos
            level = 0
            cursor = self.pos + 1
            while cursor < len(self.text) and self.text[cursor] == "=":
                level += 1
                cursor += 1
            if cursor < len(self.text) and self.text[cursor] == "[":
                closing = "]" + "=" * level + "]"
                end = self.text.find(closing, cursor + 1)
                if end == -1:
                    raise LuaParseError(f"unterminated long string at {start}")
                value = self.text[cursor + 1 : end]
                self.pos = end + len(closing)
                return value.lstrip("\n")
            raise LuaParseError(f"unexpected '[' at {start}")

        self.pos += 1
        chunks: list[str] = []
        escapes = {
            "n": "\n", "t": "\t", "r": "\r", "\\": "\\",
            '"': '"', "'": "'", "a": "\a", "b": "\b", "f": "\f", "v": "\v",
        }
        while self.pos < len(self.text):
            char = self.text[self.pos]
            if char == "\\":
                nxt = self.text[self.pos + 1]
                chunks.append(escapes.get(nxt, nxt))
                self.pos += 2
                continue
            if char == quote:
                self.pos += 1
                return "".join(chunks)
            chunks.append(char)
            self.pos += 1
        raise LuaParseError("unterminated string")

    # -------------------------------------------------------------- values

    def parse_value(self):
        self.skip()
        if self.pos >= len(self.text):
            raise LuaParseError("unexpected end of data")

        char = self.text[self.pos]
        if char in "\"'":
            return self.parse_string()
        if char == "[" and self.text[self.pos : self.pos + 2] in ("[[", "[="):
            return self.parse_string()
        if char == "{":
            return self.parse_table()

        for literal, value in (("true", True), ("false", False), ("nil", None)):
            if self.text.startswith(literal, self.pos):
                after = self.text[self.pos + len(literal) : self.pos + len(literal) + 1]
                if not after.isalnum() and after != "_":
                    self.pos += len(literal)
                    return value

        start = self.pos
        while self.pos < len(self.text):
            if self.text[self.pos] in ",};\n" or self.text.startswith("--", self.pos):
                break
            self.pos += 1
        raw = self.text[start : self.pos].strip()
        try:
            return int(raw, 0) if raw.lower().startswith("0x") else int(raw)
        except ValueError:
            pass
        try:
            return float(raw)
        except ValueError:
            # Expressions and variable references are not needed — kept as is.
            return raw

    def parse_table(self):
        self.expect("{")
        result: dict = {}
        array: list = []

        while True:
            self.skip()
            if self.pos >= len(self.text):
                raise LuaParseError("unterminated table")
            if self.text[self.pos] == "}":
                self.pos += 1
                break

            key = None
            if self.text[self.pos] == "[":
                # A bracketed key — though it may also be a long string value.
                if self.text[self.pos : self.pos + 2] not in ("[[", "[="):
                    self.pos += 1
                    key = self.parse_value()
                    self.expect("]")
                    self.expect("=")
            else:
                save = self.pos
                start = self.pos
                while self.pos < len(self.text) and (
                    self.text[self.pos].isalnum() or self.text[self.pos] == "_"
                ):
                    self.pos += 1
                name = self.text[start : self.pos]
                self.skip()
                if name and self.pos < len(self.text) and self.text[self.pos] == "=" \
                        and self.text[self.pos + 1 : self.pos + 2] != "=":
                    self.pos += 1
                    key = name
                else:
                    self.pos = save

            value = self.parse_value()
            if key is None:
                array.append(value)
            else:
                result[key] = value

            self.skip()
            if self.pos < len(self.text) and self.text[self.pos] in ",;":
                self.pos += 1

        if array and not result:
            return array
        if array:
            for index, item in enumerate(array, start=1):
                result[index] = item
        return result


def parse_lua_table(text: str) -> dict | list:
    """Finds the first table literal in a module's text and parses it."""
    start = text.find("{")
    if start == -1:
        raise LuaParseError("no table in the text")
    parser = _Parser(text)
    parser.pos = start
    return parser.parse_table()


# Lua comments: block ``--[==[ ... ]==]`` (any number of ``=``), then line ``-- ...``.
_COMMENT_RE = re.compile(r"--\[(=*)\[.*?\]\1\]|--[^\r\n]*", re.S)


def parse_assignment(text: str, variable: str) -> dict | list:
    """Parses a specific assignment of the form ``local data = { ... }``.

    The variable is matched as a whole identifier (``data``, not
    ``metadata``), and an assignment inside a comment does not count. Comments
    are blanked with offsets kept, so the brace found in the masked text is the
    brace in the original.
    """
    masked = _COMMENT_RE.sub(lambda m: re.sub(r"[^\r\n]", " ", m.group(0)), text)
    pattern = rf"(?<![A-Za-z0-9_]){re.escape(variable)}(?![A-Za-z0-9_])\s*=\s*\{{"
    match = re.search(pattern, masked)
    if match:
        parser = _Parser(text)
        parser.pos = match.end() - 1
        return parser.parse_table()
    raise LuaParseError(f"assignment {variable!r} not found")
