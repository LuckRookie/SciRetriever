"""Proposal and execution-plan governance checks."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from datetime import date
from pathlib import Path
import re
import sys
from urllib.parse import unquote

if sys.version_info >= (3, 11):
    import tomllib
else:  # pragma: no cover - exercised on Python 3.10
    import tomli as tomllib


ROOT = Path(__file__).resolve().parents[1]
_PROPOSAL_STATUSES = frozenset(
    {"draft", "under-review", "direction-confirmed", "rejected", "superseded"}
)
_EXECUTION_PLAN_STATUSES = frozenset({"approved"})
_PROPOSAL_METADATA_FIELDS = frozenset(
    {"document_type", "status", "created", "updated", "replaced_by"}
)
_EXECUTION_PLAN_METADATA_FIELDS = frozenset(
    {
        "document_type",
        "status",
        "owner",
        "approved_by",
        "approved_on",
        "approval_ref",
        "source_proposal",
        "requirements",
    }
)
_EXECUTION_PLAN_HEADINGS = (
    "## 目标与非目标",
    "## 工作包",
    "## 验收与验证",
    "## 发布与回退",
    "## 进度引用",
)
_LEGACY_STATUS = re.compile(r"^- 状态：", re.MULTILINE)


@dataclass(frozen=True, slots=True)
class GovernedDocument:
    relative_path: str
    text: str
    metadata: Mapping[str, object]


def _governed_markdown_files(root: Path, directory: str) -> tuple[Path, ...]:
    path = root / "docs" / directory
    if not path.is_dir():
        return ()
    return tuple(
        item
        for item in sorted(path.rglob("*.md"))
        if item.name != "README.md"
    )


def _parse_governed_document(path: Path, root: Path) -> tuple[GovernedDocument | None, str | None]:
    relative = path.relative_to(root).as_posix()
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as error:
        return None, f"{relative}: cannot read document metadata: {error}"
    lines = text.splitlines()
    if not lines or lines[0] != "+++":
        return None, f"{relative}: missing TOML front matter"
    try:
        closing = lines.index("+++", 1, 51)
    except ValueError:
        return None, f"{relative}: TOML front matter is missing closing +++"
    try:
        metadata = tomllib.loads("\n".join(lines[1:closing]))
    except tomllib.TOMLDecodeError as error:
        return None, f"{relative}: invalid TOML front matter: {error}"
    return GovernedDocument(relative, text, metadata), None


def _nonblank_metadata(
    document: GovernedDocument,
    field_name: str,
    violations: list[str],
) -> str | None:
    value = document.metadata.get(field_name)
    if not isinstance(value, str) or not value.strip():
        violations.append(
            f"{document.relative_path}: metadata field {field_name!r} must be a nonblank string"
        )
        return None
    return value.strip()


def _date_metadata(
    document: GovernedDocument,
    field_name: str,
    violations: list[str],
) -> str | None:
    value = _nonblank_metadata(document, field_name, violations)
    if value is None:
        return None
    try:
        date.fromisoformat(value)
    except ValueError:
        violations.append(
            f"{document.relative_path}: metadata field {field_name!r} must be an ISO date"
        )
        return None
    return value


def _unknown_metadata_fields(
    document: GovernedDocument,
    allowed: frozenset[str],
) -> tuple[str, ...]:
    return tuple(sorted(set(document.metadata) - allowed))


def _validate_proposal(document: GovernedDocument, root: Path) -> tuple[str, ...]:
    violations: list[str] = []
    unknown = _unknown_metadata_fields(document, _PROPOSAL_METADATA_FIELDS)
    if unknown:
        violations.append(
            f"{document.relative_path}: unknown proposal metadata field {unknown[0]!r}"
        )
    document_type = _nonblank_metadata(document, "document_type", violations)
    if document_type is not None and document_type != "proposal":
        violations.append(
            f"{document.relative_path}: docs/proposals requires document_type = 'proposal'"
        )
    status = _nonblank_metadata(document, "status", violations)
    if status is not None and status not in _PROPOSAL_STATUSES:
        violations.append(
            f"{document.relative_path}: unsupported proposal status {status!r}"
        )
    _date_metadata(document, "created", violations)
    if "updated" in document.metadata:
        _date_metadata(document, "updated", violations)
    replaced_by = document.metadata.get("replaced_by")
    if status == "superseded":
        target = _nonblank_metadata(document, "replaced_by", violations)
        if target is not None:
            resolved = (root / document.relative_path).parent.joinpath(_link_target(target))
            if not resolved.resolve(strict=False).is_file():
                violations.append(
                    f"{document.relative_path}: replacement document does not exist: {target!r}"
                )
    elif replaced_by is not None:
        violations.append(
            f"{document.relative_path}: replaced_by is only valid for superseded proposals"
        )
    if _LEGACY_STATUS.search(document.text):
        violations.append(
            f"{document.relative_path}: legacy '- 状态：' metadata must be removed"
        )
    return tuple(violations)


def _validate_execution_plan(document: GovernedDocument, root: Path) -> tuple[str, ...]:
    violations: list[str] = []
    unknown = _unknown_metadata_fields(document, _EXECUTION_PLAN_METADATA_FIELDS)
    if unknown:
        violations.append(
            f"{document.relative_path}: unknown execution-plan metadata field {unknown[0]!r}"
        )
    document_type = _nonblank_metadata(document, "document_type", violations)
    if document_type is not None and document_type != "execution-plan":
        violations.append(
            f"{document.relative_path}: docs/planning requires document_type = 'execution-plan'"
        )
    status = _nonblank_metadata(document, "status", violations)
    if status is not None and status not in _EXECUTION_PLAN_STATUSES:
        violations.append(
            f"{document.relative_path}: unsupported execution-plan status {status!r}"
        )
    for field_name in ("owner", "approved_by", "approval_ref"):
        _nonblank_metadata(document, field_name, violations)
    _date_metadata(document, "approved_on", violations)

    source = _nonblank_metadata(document, "source_proposal", violations)
    if source is not None:
        resolved = (root / document.relative_path).parent.joinpath(_link_target(source)).resolve(
            strict=False
        )
        proposal_root = (root / "docs" / "proposals").resolve(strict=False)
        if not resolved.is_file() or not resolved.is_relative_to(proposal_root):
            violations.append(
                f"{document.relative_path}: source_proposal must reference an existing docs/proposals file"
            )

    requirements = document.metadata.get("requirements")
    if (
        not isinstance(requirements, list)
        or not requirements
        or any(not isinstance(item, str) or not item.strip() for item in requirements)
    ):
        violations.append(
            f"{document.relative_path}: metadata field 'requirements' must be a nonempty string list"
        )
    else:
        specs_root = (root / "docs" / "specs").resolve(strict=False)
        for target in requirements:
            resolved = (root / document.relative_path).parent.joinpath(
                _link_target(target)
            ).resolve(strict=False)
            if not resolved.is_file() or not resolved.is_relative_to(specs_root):
                violations.append(
                    f"{document.relative_path}: requirement must reference an existing docs/specs file: {target!r}"
                )
    for heading in _EXECUTION_PLAN_HEADINGS:
        if heading not in document.text:
            violations.append(
                f"{document.relative_path}: execution plan missing heading: {heading}"
            )
    if _LEGACY_STATUS.search(document.text):
        violations.append(
            f"{document.relative_path}: legacy '- 状态：' metadata must be removed"
        )
    return tuple(violations)


def find_document_governance_violations(root: Path = ROOT) -> tuple[str, ...]:
    """Return proposal/execution-plan directory and lifecycle violations."""
    violations: list[str] = []
    for directory, validator in (
        ("proposals", _validate_proposal),
        ("planning", _validate_execution_plan),
    ):
        for path in _governed_markdown_files(root, directory):
            document, error = _parse_governed_document(path, root)
            if error is not None:
                violations.append(error)
                continue
            if document is not None:
                violations.extend(validator(document, root))
    return tuple(sorted(set(violations)))


def _link_target(raw_target: str) -> str:
    target = raw_target.strip()
    if target.startswith("<") and ">" in target:
        target = target[1:target.index(">")]
    elif " " in target and not target.startswith(("http://", "https://")):
        target = target.split(" ", 1)[0]
    return unquote(target.split("#", 1)[0].split("?", 1)[0])
