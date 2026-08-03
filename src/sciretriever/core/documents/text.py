from __future__ import annotations

from typing import assert_never

from sciretriever.model import documents


def block_text(block: documents.Block) -> str:
    match block:
        case (
            documents.ParagraphBlock(text=text)
            | documents.FormulaBlock(text=text)
            | documents.FigureCaptionBlock(text=text)
        ):
            return text
        case documents.ListBlock(items=items):
            return "".join(item.text for item in items)
        case documents.TableBlock(caption=caption, columns=columns, rows=rows):
            return "".join(
                (
                    *columns,
                    *(cell for row in rows for cell in row),
                    "" if caption is None else caption.text,
                )
            )
        case unreachable:
            assert_never(unreachable)


__all__ = ("block_text",)
