"""Documentation layout governance checks."""

from __future__ import annotations

from pathlib import Path
import re
from typing import Final


ROOT = Path(__file__).resolve().parents[1]
_ALLOWED_DIRECTORIES = frozenset(
    {"guides", "development", "architecture", "notes", "proposals", "archive"}
)
_ALLOWED_ROOT_FILES = frozenset({"README.md"})
_ACTIVE_PROPOSAL_STATUSES = frozenset({"draft", "under-review"})
_DOCUMENT_TYPE: Final = re.compile(
    r'^document_type\s*=\s*"(?P<value>[^"]+)"\s*$', re.MULTILINE
)
_STATUS: Final = re.compile(r'^status\s*=\s*"(?P<value>[^"]+)"\s*$', re.MULTILINE)


def find_document_governance_violations(root: Path = ROOT) -> tuple[str, ...]:
    """Return violations of the intentionally small docs taxonomy."""
    docs = root / "docs"
    if not docs.is_dir():
        return ()

    violations: list[str] = []
    for entry in sorted(docs.iterdir()):
        relative = entry.relative_to(root).as_posix()
        if entry.is_dir():
            if entry.name not in _ALLOWED_DIRECTORIES:
                violations.append(
                    f"{relative}: unexpected documentation category; "
                    "use guides, development, architecture, notes, proposals, or archive"
                )
            continue
        if entry.name not in _ALLOWED_ROOT_FILES:
            violations.append(
                f"{relative}: docs root may contain only README.md; "
                "move the document into its owning category"
            )

    for document in sorted(docs.rglob("*.md")):
        text = document.read_text(encoding="utf-8")
        relative = document.relative_to(root).as_posix()
        document_type = _DOCUMENT_TYPE.search(text)
        if document_type is not None and document_type.group("value") == "execution-plan":
            violations.append(
                f"{relative}: execution plans belong in .omo/plans, not docs"
            )

    proposals = docs / "proposals"
    if proposals.is_dir():
        for document in sorted(proposals.rglob("*.md")):
            if document.name == "README.md":
                continue
            text = document.read_text(encoding="utf-8")
            relative = document.relative_to(root).as_posix()
            document_type = _DOCUMENT_TYPE.search(text)
            if document_type is None or document_type.group("value") != "proposal":
                violations.append(
                    f"{relative}: active proposal requires document_type = 'proposal'"
                )
            status = _STATUS.search(text)
            if status is None:
                violations.append(f"{relative}: active proposal requires a status")
                continue
            value = status.group("value")
            if value not in _ACTIVE_PROPOSAL_STATUSES:
                violations.append(
                    f"{relative}: proposal status {value!r} is not active; "
                    "move the document to docs/archive"
                )
    return tuple(violations)


__all__ = ("find_document_governance_violations",)
