"""Required-file, README, and Markdown-link checks."""

from __future__ import annotations

import argparse
from pathlib import Path
import re
from urllib.parse import unquote

from scripts.governance_checks import find_document_governance_violations
from sciretriever.cli.main import _build_parser
from sciretriever.config import load_config
from sciretriever.errors import ConfigError


ROOT = Path(__file__).resolve().parents[1]
MARKDOWN_LINK = re.compile(r"(?<!!)\[[^\]]+\]\(([^)]+)\)")
MARKDOWN_REFERENCE_TARGET = re.compile(
    r"^[ \t]{0,3}\[(?!\^)[^\]]+\]:[ \t]*(.+?)\s*$", re.MULTILINE,
)
REQUIRED_FILES = (
    "README.md", "AGENTS.md", "HARNESS.md", "docs/README.md",
    "docs/guides/README.md", "docs/guides/configuration.md",
    "docs/guides/config.toml", "docs/guides/config.minimal.toml",
    "docs/development/README.md", "docs/development/documentation-map.md",
    "docs/architecture/README.md", "docs/architecture/principles.md",
    "docs/architecture/requirements.md", "docs/architecture/system-design.md",
    "docs/architecture/technical-architecture.md",
    "docs/architecture/decisions/0001-sciretriever-scope-and-boundary.md",
    "docs/notes/README.md", "docs/proposals/README.md",
)
README_HEADINGS = (
    "## 功能特性", "## 工作流程", "## 快速开始",
    "## 数据来源", "## 配置", "## 开发与验证",
)
FINAL_RELEASE_MARKER = "<!-- WP6_FINAL_RELEASE_RECEIPT: TODO31_940 -->"
FINAL_RELEASE_FACTS = (
    "Todo 31 最终 `full` harness 940 项通过",
    "`.omo/evidence/wp6/task-31.txt`",
)
MINIMAL_CONFIG_SECTIONS = (
    "schema_version =", "[paths]", "[credentials]", "[discovery]", "[search]",
    "[acquisition]",
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


def _wp6_surface_violations(root: Path) -> tuple[str, ...]:
    violations: list[str] = []
    readme = root / "README.md"
    if readme.is_file():
        text = readme.read_text(encoding="utf-8")
        parser = _build_parser()
        subparsers = next(
            action for action in parser._actions
            if isinstance(action, argparse._SubParsersAction)
        )
        choices = subparsers.choices or {}
        required = ("expand", "failures", "config")
        if any(
            command not in choices
            or f"`sciretriever {command}{' check' if command == 'config' else ''}`" not in text
            for command in required
        ):
            violations.append("README.md: stale or incomplete WP6 command surface")
    full_config = root / "docs" / "guides" / "config.toml"
    if full_config.is_file():
        try:
            load_config(full_config)
        except (ConfigError, OSError):
            violations.append("docs/guides/config.toml: strict parser rejected the complete template")
    minimal = root / "docs" / "guides" / "config.minimal.toml"
    if minimal.is_file():
        try:
            config = load_config(minimal)
        except (ConfigError, OSError):
            violations.append("docs/guides/config.minimal.toml: strict parser rejected the template")
        else:
            text = minimal.read_text(encoding="utf-8")
            declarations_are_unique = all(
                text.count(declaration) == 1 for declaration in MINIMAL_CONFIG_SECTIONS
            )
            defaults_are_exact = (
                config.document_start_interval_seconds == 30.0
                and config.expansion.direction == "references"
                and config.expansion.depth == 0
                and config.expansion.providers == ("openalex", "semantic-scholar")
                and config.expansion.max_provider_calls == 10
                and config.expansion.page_size == 100
            )
            if not declarations_are_unique or not defaults_are_exact:
                violations.append(
                    "docs/guides/config.minimal.toml: required sections and omitted defaults must be exact"
                )
    progress = (
        root / "docs" / "archive" / "2026-07-literature-library"
        / "implementation-progress.md"
    )
    if progress.is_file():
        text = progress.read_text(encoding="utf-8")
        if text.count(FINAL_RELEASE_MARKER) != 1:
            violations.append(
                "docs/archive/2026-07-literature-library/implementation-progress.md: "
                "Todo 31 final release marker must appear exactly once"
            )
        if any(text.count(fact) != 1 for fact in FINAL_RELEASE_FACTS):
            violations.append(
                "docs/archive/2026-07-literature-library/implementation-progress.md: "
                "Todo 31 final count and receipt must appear exactly once"
            )
        if (
            "Reference expansion | 未实现" in text
            or "WP6 引用扩展与产品收口 | approved | not started" in text
        ):
            violations.append(
                "docs/archive/2026-07-literature-library/implementation-progress.md: "
                "stale WP6 capability status"
            )
    return tuple(violations)


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
    violations.extend(_wp6_surface_violations(root))
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
