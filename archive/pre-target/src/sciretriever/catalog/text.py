from __future__ import annotations

import unicodedata

from sciretriever.catalog.repository import _required_text


def normalize_title(value: str) -> str:
    normalized = unicodedata.normalize("NFKC", _required_text(value, "title")).casefold()
    without_punctuation = "".join(
        " " if unicodedata.category(character)[0] in {"P", "S"} else character
        for character in normalized
    )
    return " ".join(without_punctuation.split())


__all__ = ("normalize_title",)
