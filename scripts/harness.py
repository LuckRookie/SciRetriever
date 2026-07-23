"""Unified local and CI quality gates for SciRetriever."""

from __future__ import annotations

import argparse
import ast
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from datetime import date
from pathlib import Path
import re
import shutil
import subprocess
import sys
from urllib.parse import unquote
import zipfile

if sys.version_info >= (3, 11):
    import tomllib
else:  # pragma: no cover - exercised on Python 3.10
    import tomli as tomllib


ROOT = Path(__file__).resolve().parents[1]
SOURCE_ROOT = ROOT / "src" / "sciretriever"
_PACKAGE_ROOTS = ("sciretriever", "SciRetriever")

_MARKDOWN_LINK = re.compile(r"(?<!!)\[[^\]]+\]\(([^)]+)\)")
_MARKDOWN_REFERENCE_TARGET = re.compile(
    r"^[ \t]{0,3}\[(?!\^)[^\]]+\]:[ \t]*(.+?)\s*$",
    re.MULTILINE,
)
_REQUIRED_FILES = (
    "README.md",
    "AGENTS.md",
    "HARNESS.md",
    "config.example.toml",
    "docs/adr/0001-sciretriever-scope-and-boundary.md",
    "docs/architecture/principles.md",
    "docs/governance/code-doc-map.md",
    "docs/planning/README.md",
    "docs/proposals/README.md",
    "docs/specs/requirements.md",
    "docs/specs/system-design.md",
    "docs/specs/technical-architecture.md",
)
_README_HEADINGS = (
    "## 功能特性",
    "## 工作流程",
    "## 快速开始",
    "## 数据来源",
    "## 配置",
    "## 开发与验证",
)
_FORBIDDEN_IMPORTS = {
    "core": (
        "sciretriever.acquisition",
        "sciretriever.catalog",
        "sciretriever.cli",
        "sciretriever.discovery",
        "sciretriever.enrichment",
        "sciretriever.integrations",
        "sciretriever.legacy",
        "sciretriever.network",
        "sciretriever.normalization",
        "sciretriever.packaging",
        "sciretriever.storage",
    ),
    "catalog": (
        "sciretriever.acquisition",
        "sciretriever.cli",
        "sciretriever.discovery",
        "sciretriever.enrichment",
        "sciretriever.integrations",
        "sciretriever.legacy",
        "sciretriever.network",
        "sciretriever.normalization",
        "sciretriever.packaging",
        "sciretriever.storage",
    ),
    "discovery": ("sciretriever.acquisition",),
    "acquisition": ("sciretriever.discovery",),
}
_UPPERCASE_IMPORT_ALLOWLIST = {
    ("catalog/engine.py", "SciRetriever.database.retired_paths"),
    ("catalog/engine.py", "SciRetriever.workspace_paths"),
    ("legacy/sqlite_reader.py", "SciRetriever.database.retired_paths"),
}
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
class CommandCheck:
    name: str
    command: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class GovernedDocument:
    relative_path: str
    text: str
    metadata: Mapping[str, object]


def _imported_modules(path: Path, source_root: Path) -> tuple[str, ...]:
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    relative_parts = path.relative_to(source_root).with_suffix("").parts
    package_parts = ["sciretriever", *relative_parts[:-1]]
    imports: list[str] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imports.extend(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            if node.level:
                retained = len(package_parts) - (node.level - 1)
                base_parts = package_parts[:max(retained, 0)]
            else:
                base_parts = []
            if node.module is not None:
                base_parts.extend(node.module.split("."))
                imports.append(".".join(base_parts))
            if node.module is None or base_parts == ["sciretriever"]:
                imports.extend(
                    ".".join((*base_parts, alias.name))
                    for alias in node.names
                    if alias.name != "*"
                )
    return tuple(imports)


def find_architecture_violations(source_root: Path = SOURCE_ROOT) -> tuple[str, ...]:
    """Return deterministic import-boundary violations for the lowercase v2 package."""
    violations: list[str] = []
    for path in sorted(source_root.rglob("*.py")):
        relative = path.relative_to(source_root).as_posix()
        layer = Path(relative).parts[0]
        try:
            imported_modules = _imported_modules(path, source_root)
        except (OSError, SyntaxError) as error:
            violations.append(f"{relative}: cannot parse: {error}")
            continue
        for imported in imported_modules:
            for forbidden in _FORBIDDEN_IMPORTS.get(layer, ()):
                if imported == forbidden or imported.startswith(forbidden + "."):
                    violations.append(
                        f"{relative}: {layer} must not import {imported}"
                    )
            if imported == "SciRetriever" or imported.startswith("SciRetriever."):
                if (relative, imported) not in _UPPERCASE_IMPORT_ALLOWLIST:
                    violations.append(
                        f"{relative}: lowercase v2 must not import legacy module {imported}"
                    )
    return tuple(sorted(set(violations)))


def clean_build_staging(root: Path = ROOT) -> None:
    """Remove setuptools staging so deleted modules cannot leak into a wheel."""
    shutil.rmtree(root / "build", ignore_errors=True)


def find_wheel_content_violations(
    wheel: Path,
    source_root: Path = ROOT / "src",
) -> tuple[str, ...]:
    """Return Python package files that differ between source and a built wheel."""
    expected = {
        path.relative_to(source_root).as_posix()
        for package in _PACKAGE_ROOTS
        for path in (source_root / package).rglob("*.py")
    }
    with zipfile.ZipFile(wheel) as archive:
        actual = {
            name
            for name in archive.namelist()
            if name.endswith(".py") and name.split("/", 1)[0] in _PACKAGE_ROOTS
        }
    violations = [f"wheel contains stale module: {name}" for name in actual - expected]
    violations.extend(
        f"wheel is missing source module: {name}" for name in expected - actual
    )
    return tuple(sorted(violations))


def _markdown_files(root: Path) -> tuple[Path, ...]:
    root_files = tuple(root / name for name in ("README.md", "AGENTS.md", "HARNESS.md"))
    docs = tuple(sorted((root / "docs").rglob("*.md"))) if (root / "docs").is_dir() else ()
    return root_files + docs


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


def find_documentation_violations(root: Path = ROOT) -> tuple[str, ...]:
    """Validate required governance files, README shape, and local Markdown links."""
    violations: list[str] = []
    for relative in _REQUIRED_FILES:
        if not (root / relative).is_file():
            violations.append(f"missing required file: {relative}")

    readme = root / "README.md"
    if readme.is_file():
        text = readme.read_text(encoding="utf-8")
        if not re.search(r"[\u4e00-\u9fff]", text):
            violations.append("README.md must be written in Chinese")
        for heading in _README_HEADINGS:
            if heading not in text:
                violations.append(f"README.md missing heading: {heading}")

    agents = root / "AGENTS.md"
    if agents.is_file():
        text = agents.read_text(encoding="utf-8")
        if "<PROJECT_NAME>" in text or "<command>" in text:
            violations.append("AGENTS.md still contains template placeholders")
        if len(text.splitlines()) > 200:
            violations.append("AGENTS.md must remain a project index of at most 200 lines")

    violations.extend(find_document_governance_violations(root))

    for document in _markdown_files(root):
        if not document.is_file():
            continue
        text = document.read_text(encoding="utf-8")
        matches = (*_MARKDOWN_LINK.finditer(text), *_MARKDOWN_REFERENCE_TARGET.finditer(text))
        for match in matches:
            raw_target = match.group(1)
            if raw_target.startswith(("#", "http://", "https://", "mailto:")):
                continue
            target = _link_target(raw_target)
            if not target:
                continue
            resolved = (document.parent / target).resolve(strict=False)
            if not resolved.exists():
                relative_document = document.relative_to(root).as_posix()
                violations.append(
                    f"{relative_document}: broken local link {raw_target!r}"
                )
    return tuple(sorted(set(violations)))


def _report_gate(name: str, violations: Iterable[str]) -> bool:
    items = tuple(violations)
    if not items:
        print(f"[harness] {name}: passed")
        return True
    print(f"[harness] {name}: failed", file=sys.stderr)
    for item in items:
        print(f"  - {item}", file=sys.stderr)
    return False


def _run(check: CommandCheck) -> bool:
    if check.name == "wheel":
        clean_build_staging()
    print(f"[harness] {check.name}: {' '.join(check.command)}")
    completed = subprocess.run(check.command, cwd=ROOT, check=False)
    if completed.returncode == 0:
        if check.name == "wheel":
            wheels = tuple((ROOT / "dist").glob("sciretriever-*.whl"))
            if not wheels:
                print("[harness] wheel: build produced no wheel", file=sys.stderr)
                return False
            wheel = max(wheels, key=lambda path: path.stat().st_mtime_ns)
            if not _report_gate(
                "wheel contents", find_wheel_content_violations(wheel)
            ):
                return False
        print(f"[harness] {check.name}: passed")
        return True
    print(
        f"[harness] {check.name}: failed with exit code {completed.returncode}",
        file=sys.stderr,
    )
    return False


def _commands(mode: str) -> tuple[CommandCheck, ...]:
    compile_check = CommandCheck(
        "compile",
        (sys.executable, "-m", "compileall", "-q", "src", "tests", "scripts", "main.py"),
    )
    if mode == "quick":
        return (
            compile_check,
            CommandCheck(
                "harness tests",
                (sys.executable, "-m", "unittest", "discover", "-s", "tests", "-p", "test_harness.py"),
            ),
            CommandCheck(
                "CLI tests",
                (sys.executable, "-m", "unittest", "discover", "-s", "tests", "-p", "test_cli.py"),
            ),
        )
    return (
        compile_check,
        CommandCheck("typecheck", ("pyright", "src/sciretriever", "tests", "scripts")),
        CommandCheck(
            "tests",
            (sys.executable, "-m", "unittest", "discover", "-s", "tests"),
        ),
        CommandCheck(
            "wheel",
            (sys.executable, "-m", "build", "--wheel", "--no-isolation"),
        ),
    )


def run(mode: str) -> int:
    ok = True
    if mode in {"quick", "full", "docs"}:
        ok = _report_gate("documentation", find_documentation_violations()) and ok
    if mode in {"quick", "full", "architecture"}:
        ok = _report_gate("architecture", find_architecture_violations()) and ok
    if mode in {"quick", "full"}:
        for check in _commands(mode):
            ok = _run(check) and ok
    return 0 if ok else 1


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("quick", "full", "docs", "architecture"))
    args = parser.parse_args(argv)
    return run(args.mode)


if __name__ == "__main__":
    raise SystemExit(main())
