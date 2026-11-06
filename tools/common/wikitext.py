"""Small wikitext parsing utilities needed already at download time.

A full parser of operator templates is a phase 2 task. Only what is needed to
build the download list itself lives here.
"""

from __future__ import annotations

import re

_DECLARE_RE = re.compile(r"\{\{\s*#cargo_declare:\s*(.*?)\}\}", re.S)
_TABLE_RE = re.compile(r"_table\s*=\s*([^\s|]+)")
# "Gender = String (size=6)" → name and type; the size is not needed.
_FIELD_RE = re.compile(r"^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+?)\s*$")


def parse_cargo_declare(text: str) -> tuple[str | None, list[dict]]:
    """``{{#cargo_declare:...}}`` → (table name, list of fields).

    The schema from the template is more precise than from
    ``Special:CargoTables``: long field lists are truncated in its display.
    """
    match = _DECLARE_RE.search(text)
    if not match:
        return None, []

    body = match.group(1)
    table_match = _TABLE_RE.search(body)
    table = table_match.group(1).strip() if table_match else None

    fields: list[dict] = []
    for chunk in body.split("|")[1:]:
        field_match = _FIELD_RE.match(chunk.strip())
        if not field_match:
            continue
        name, ftype = field_match.groups()
        if name.startswith("_"):
            continue
        fields.append({"name": name, "type": ftype.strip()})

    return table, fields


def cargo_tables_from_html(html: str) -> list[str]:
    """The list of tables from ``Special:CargoTables``."""
    return sorted(set(re.findall(r"Special:CargoTables/([A-Za-z0-9_]+)\"", html)))


def cargo_fields_from_html(html: str) -> list[dict]:
    """A fallback way to get the schema when there is no CargoDeclare template."""
    text = re.sub(r"<script.*?</script>|<style.*?</style>", "", html, flags=re.S)
    lines = [
        line.strip()
        for line in re.sub(r"<[^>]+>", "\n", text).split("\n")
        if line.strip()
    ]
    try:
        start = lines.index("Table structure")
    except ValueError:
        return []

    types = {
        "String", "Integer", "Float", "Text", "Boolean", "Date", "Datetime",
        "Page", "Wikitext", "Wikitext string", "Searchtext", "File", "URL",
        "Email", "Coordinates", "Rating",
    }
    fields: list[dict] = []
    rest = lines[start + 1 :]
    index = 0
    while index < len(rest) - 1:
        name, maybe_type = rest[index], rest[index + 1]
        if maybe_type in types or maybe_type.startswith("List of"):
            if not name.startswith("_"):
                fields.append({"name": name, "type": maybe_type})
            index += 2
        elif maybe_type.startswith(("Yes", "No", "max size", "(none)", "unique", "allowed")):
            index += 1
        else:
            index += 1
    return fields


# --------------------------------------------------------------- templates

def _split_params(body: str) -> list[str]:
    """Splits a template body on top-level ``|``.

    Accounts for nested ``{{ }}``, links ``[[ ]]`` and wiki tables ``{| |}``:
    inside them ``|`` is part of the content, not a parameter separator.
    """
    parts: list[str] = []
    depth_brace = depth_link = depth_table = 0
    current: list[str] = []
    index = 0

    while index < len(body):
        two = body[index : index + 2]
        if two == "{{":
            depth_brace += 1
            current.append(two)
            index += 2
            continue
        if two == "}}":
            depth_brace -= 1
            current.append(two)
            index += 2
            continue
        if two == "[[":
            depth_link += 1
            current.append(two)
            index += 2
            continue
        if two == "]]":
            depth_link -= 1
            current.append(two)
            index += 2
            continue
        if two == "{|":
            depth_table += 1
            current.append(two)
            index += 2
            continue
        if two == "|}":
            depth_table -= 1
            current.append(two)
            index += 2
            continue

        char = body[index]
        if char == "|" and depth_brace == depth_link == depth_table == 0:
            parts.append("".join(current))
            current = []
        else:
            current.append(char)
        index += 1

    parts.append("".join(current))
    return parts


def iter_templates(text: str, name: str | None = None):
    """Iterates over top-level template calls ``{{...}}``.

    Yields dicts of the form ``{"name": ..., "params": {...}}``; positional
    parameters sit under the keys "1", "2", … as MediaWiki itself does.
    """
    index = 0
    while True:
        start = text.find("{{", index)
        if start == -1:
            return

        depth = 0
        position = start
        while position < len(text):
            if text[position : position + 2] == "{{":
                depth += 1
                position += 2
            elif text[position : position + 2] == "}}":
                depth -= 1
                position += 2
                if depth == 0:
                    break
            else:
                position += 1
        else:
            return  # an unterminated template — nothing more to parse

        body = text[start + 2 : position - 2]
        index = position

        parts = _split_params(body)
        template_name = parts[0].strip()
        if name is not None and template_name.lower() != name.lower():
            continue

        params: dict[str, str] = {}
        positional = 0
        for part in parts[1:]:
            key, sep, value = part.partition("=")
            # "=" counts as a separator only if it comes before any markup:
            # otherwise it is a sign inside the value (e.g. in description text).
            if sep and "{{" not in key and "[[" not in key and "\n" not in key:
                params[key.strip()] = value.strip()
            else:
                positional += 1
                params[str(positional)] = part.strip()

        yield {"name": template_name, "params": params}


def find_templates(text: str, name: str) -> list[dict]:
    return list(iter_templates(text, name))


# ------------------------------------------------------------ cleaning text

_GLOSSARY_RE = re.compile(r"\{\{\s*G\s*\|([^{}|]+?)(?:\|([^{}]*?))?\}\}")
# Nesting: {{Color|…{{G|…}}…}} occurs in set descriptions. Braces are forbidden
# inside, and the replacements run in several passes so that the inner template
# resolves first and the outer one after. A lazy ".+?" stopped at the nested
# template's closing braces and ate the tail of the sentence.
_COLOR_RE = re.compile(r"\{\{\s*Color\s*\|([^{}]+?)(?:\|[^{}|]*)?\}\}", re.S)
_ITEM_RE = re.compile(r"\{\{\s*I\s*\|([^{}|]+?)(?:\|([^{}|]*))?\}\}")
_TOOLTIP_RE = re.compile(r"\{\{\s*Tooltip/[^{}|]*\|(?:[^{}|]*\|)*([^{}|]*?)\}\}")
_LINK_RE = re.compile(r"\[\[(?:[^\]|]*\|)?([^\]|]+)\]\]")
_NOTE_RE = re.compile(r"\{\{\s*Note\s*\|.*?\}\}", re.S)
# {{Tip|~0.26%|0.25510204%}} — a label plus the exact value under it.
# The exact value matters more than the label, so both are kept.
_TIP_RE = re.compile(r"\{\{\s*Tip\s*\|([^{}|]*?)(?:\|([^{}|]*?))?\}\}")
# Navigation templates and anything left unparsed are not needed in the text.
_NAV_RE = re.compile(
    r"\{\{\s*(?:Hatnote|Main|Reflist|Navbox|Quote|Clear|Anchor|About|Combat mechanics|Gears|Operators|Weapons)\b[^{}]*?\}\}",
    re.S | re.I,
)
# Inline icons like [[File:Crush icon.png|15px|link=]] are decoration, not
# content. Left in, they leak junk from the markup: the file name repeats the
# term once more, and the technical "link=" reads as the Link mechanic.
_FILE_RE = re.compile(r"\[\[(?:File|Image|Файл):[^\]]*\]\]", re.I)
# Tags with attributes whose values contain ">". Cargo returns Wikitext-typed
# fields already rendered, and glossary tooltips arrive as
# <span data-tooltip="…text with arrows…">. A naive <[^>]+> stops at the first
# such arrow and spills half the attribute into the text.
_TAG_RE = re.compile(
    r"</?[A-Za-z][A-Za-z0-9:-]*"
    r'''(?:\s+[^\s=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]*))?)*'''
    r"\s*/?>"
)


def glossary_terms(text: str) -> list[str]:
    """Glossary terms the text refers to (``{{G|term|label}}``).

    This is the machine link between a skill description and a mechanic: the
    word "Solidification" in the text is not just a word but a glossary link.
    """
    seen: list[str] = []
    for match in _GLOSSARY_RE.finditer(text):
        term = match.group(1).strip()
        if term and term not in seen:
            seen.append(term)
    return seen


def strip_markup(text: str) -> str:
    """Wikitext → readable plain text, without losing meaning."""
    if not text:
        return ""

    result = _FILE_RE.sub("", text)
    result = _NOTE_RE.sub("", result)
    # {{G|Solidification|Solidified}} → show the label if there is one.
    # {{G|Vulnerable|Vulnerability|1d}} — the third argument is decoration and
    # must not get into the text.
    def _glossary(match: re.Match) -> str:
        label = (match.group(2) or match.group(1)).split("|")[0]
        return label.strip()

    for _ in range(4):
        expanded = _GLOSSARY_RE.sub(_glossary, result)
        expanded = _COLOR_RE.sub(lambda m: m.group(1).strip(), expanded)
        if expanded == result:
            break
        result = expanded
    result = _TOOLTIP_RE.sub(lambda m: m.group(1).strip(), result)
    result = _TIP_RE.sub(
        lambda m: f"{m.group(1).strip()} ({m.group(2).strip()})"
        if m.group(2)
        else m.group(1).strip(),
        result,
    )
    # Nested templates resolve in several passes: {{Hatnote|{{Main|…}}}} is not
    # visible from outside until the inner one is gone.
    for _ in range(3):
        cleaned = _NAV_RE.sub("", result)
        if cleaned == result:
            break
        result = cleaned
    result = _ITEM_RE.sub(
        lambda m: f"{m.group(1).strip()} x{m.group(2).strip()}"
        if m.group(2)
        else m.group(1).strip(),
        result,
    )
    result = _LINK_RE.sub(r"\1", result)

    result = re.sub(r"<br\s*/?>", "\n", result, flags=re.I)
    result = _TAG_RE.sub("", result)
    # Anything the strict tag parse did not handle (fragments, comments).
    result = re.sub(r"<!--.*?-->", "", result, flags=re.S)
    result = re.sub(r"'''(.+?)'''", r"\1", result, flags=re.S)
    result = re.sub(r"''(.+?)''", r"\1", result, flags=re.S)
    result = re.sub(r"[ \t]+", " ", result)
    result = re.sub(r"\n{3,}", "\n\n", result)
    return result.strip()


def parse_number_list(value: str) -> list:
    """"500, 1566, 2689" → [500.0, 1566.0, ...]; "24%" → 0.24.

    Percentages become fractions right away: the calculator multiplies anyway,
    and keeping "24%" as a string just postpones the parsing.
    """
    out: list = []
    for chunk in value.split(","):
        chunk = chunk.strip()
        if not chunk:
            continue
        percent = chunk.endswith("%")
        cleaned = chunk.rstrip("%").replace(",", "").strip()
        try:
            number = float(cleaned)
        except ValueError:
            out.append(chunk)
            continue
        out.append(number / 100 if percent else number)
    return out


# ------------------------------------------------------------ sections and tabs

def section(text: str, heading: str) -> str:
    """The content of a ``==Heading==`` section up to the next heading of the same level."""
    pattern = re.compile(
        rf"^==\s*{re.escape(heading)}\s*==\s*$(.*?)(?=^==[^=]|\Z)",
        re.M | re.S,
    )
    match = pattern.search(text)
    return match.group(1) if match else ""


def split_tabber(text: str) -> list[tuple[str | None, str]]:
    """``<tabber>Label=…|-|Label=…</tabber>`` → [(label, content), …].

    Tabs are not decoration: on Arcane they hide two different battle stances
    with different numbers, and without the label they cannot be told apart.
    """
    match = re.search(r"<tabber>(.*?)</tabber>", text, re.S)
    if not match:
        return [(None, text)]

    tabs: list[tuple[str | None, str]] = []
    for chunk in re.split(r"\|-\|", match.group(1)):
        label, sep, body = chunk.partition("=")
        if not sep:
            continue
        tabs.append((label.strip() or None, body))
    return tabs or [(None, text)]


def glossary_aliases(text: str) -> list[tuple[str, str]]:
    """(term, label) pairs from ``{{G|term|label}}``.

    In the text a term is often shown as another word:
    ``{{G|Vulnerable|Vulnerability}}`` or ``{{G|Crush|Crushed}}``. Without this
    map, a search by term name misses half the mentions.
    """
    pairs: list[tuple[str, str]] = []
    for match in _GLOSSARY_RE.finditer(text):
        term = match.group(1).strip()
        label = (match.group(2) or "").strip()
        if term and label and label.lower() != term.lower():
            pairs.append((term, label))
    return pairs


def find_templates_deep(text: str, name: str) -> list[dict]:
    """Like ``find_templates``, but also looks inside parameters.

    On mechanic pages, interaction lists are wrapped:
    ``{{Operator table|content={{Operator table row|…}}{{Operator table row|…}}}}``.
    A top-level search does not see such rows at all.
    """
    found: list[dict] = []
    for template in iter_templates(text):
        if template["name"].lower() == name.lower():
            found.append(template)
        for value in template["params"].values():
            if "{{" in value:
                found.extend(find_templates_deep(value, name))
    return found
