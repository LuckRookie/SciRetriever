"""Required-file, README, and Markdown-link checks."""

from __future__ import annotations

from pathlib import Path
import re
from urllib.parse import unquote

from scripts.governance_checks import find_document_governance_violations


ROOT = Path(__file__).resolve().parents[1]
MARKDOWN_LINK = re.compile(r"(?<!!)\[[^\]]+\]\(([^)]+)\)")
MARKDOWN_REFERENCE_TARGET = re.compile(
    r"^[ \t]{0,3}\[(?!\^)[^\]]+\]:[ \t]*(.+?)\s*$", re.MULTILINE,
)
REQUIRED_FILES = (
    "README.md", "AGENTS.md", "HARNESS.md", "config.example.toml",
    "docs/adr/0001-sciretriever-scope-and-boundary.md",
    "docs/architecture/principles.md", "docs/governance/code-doc-map.md",
    "docs/planning/README.md", "docs/proposals/README.md",
    "docs/specs/requirements.md", "docs/specs/system-design.md",
    "docs/specs/technical-architecture.md",
)
README_HEADINGS = (
    "## 功能特性", "## 工作流程", "## 快速开始",
    "## 数据来源", "## 配置", "## 开发与验证",
)


def _markdown_files(root: Path) -> tuple[Path, ...]:
    root_files = tuple(root / name for name in ("README.md", "AGENTS.md", "HARNESS.md"))
    docs = tuple(sorted((root / "docs").rglob("*.md"))) if (root / "docs").is_dir() else ()
    return root_files + docs


def _link_target(raw_target: str) -> str:
    target = raw_target.strip()
    if target.startswith("<") and ">" in target:
        target = target[1:target.index(">")]
    elif " " in target and not target.startswith(("http://", "https://")):
        target = target.split(" ", 1)[0]
    return unquote(target.split("#", 1)[0].split("?", 1)[0])


def find_documentation_violations(root: Path = ROOT) -> tuple[str, ...]:
    violations: list[str] = []
    for relative in REQUIRED_FILES:
        if not (root / relative).is_file():
            violations.append(f"missing required file: {relative}")
    readme = root / "README.md"
    if readme.is_file():
        text = readme.read_text(encoding="utf-8")
        if not re.search(r"[\u4e00-\u9fff]", text):
            violations.append("README.md must be written in Chinese")
        for heading in README_HEADINGS:
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
        matches = (*MARKDOWN_LINK.finditer(text), *MARKDOWN_REFERENCE_TARGET.finditer(text))
        for match in matches:
            raw_target = match.group(1)
            if raw_target.startswith(("#", "http://", "https://", "mailto:")):
                continue
            target = _link_target(raw_target)
            if target and not (document.parent / target).resolve(strict=False).exists():
                relative_document = document.relative_to(root).as_posix()
                violations.append(f"{relative_document}: broken local link {raw_target!r}")
    return tuple(sorted(set(violations)))


__all__ = ("find_documentation_violations",)
