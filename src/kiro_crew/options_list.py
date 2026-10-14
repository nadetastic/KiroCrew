"""Bounded, end-only list-form options, mirrored by the frontend protocol parser."""

import re

_HEADER = re.compile(r"\[OPTIONS\]:?", re.IGNORECASE)
_ITEM = re.compile(r"(?:[-*]|[0-9]+\.)[ \t]+(\S.*)")


def split_bulleted_options_trailer(text: str) -> tuple[str, list[str]] | None:
    """Accept only a header followed by one to six nonempty single-line items."""
    lines = text.rstrip().split("\n")
    choices: list[str] = []
    for i in range(len(lines) - 1, max(-1, len(lines) - 8), -1):
        line = lines[i].rstrip()
        if _HEADER.fullmatch(line):
            if not choices:
                return None
            return "\n".join(lines[:i]).rstrip(), list(reversed(choices))
        item = _ITEM.fullmatch(line)
        if not item:
            return None
        choices.append(item[1])
    return None
