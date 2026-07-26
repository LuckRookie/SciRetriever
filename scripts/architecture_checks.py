"""AST-based dependency and completion command cutover checks."""

from __future__ import annotations

import ast
from collections.abc import Set
from pathlib import Path

from scripts.wp6_architecture import find_wp6_architecture_violations


FORBIDDEN_IMPORTS = {
    "core": ("sciretriever.acquisition", "sciretriever.catalog", "sciretriever.cli",
             "sciretriever.discovery", "sciretriever.integrations", "sciretriever.network",
             "sciretriever.normalization", "sciretriever.packaging", "sciretriever.storage"),
    "catalog": ("sciretriever.acquisition", "sciretriever.cli", "sciretriever.completion",
                "sciretriever.discovery", "sciretriever.integrations", "sciretriever.network",
                "sciretriever.normalization", "sciretriever.packaging", "sciretriever.storage"),
    "discovery": ("sciretriever.acquisition", "sciretriever.completion"),
    "acquisition": ("sciretriever.discovery", "sciretriever.completion"),
    "normalization": ("sciretriever.completion",),
    "analysis": ("sciretriever.completion",),
    "completion": ("sciretriever.cli",),
}
COMPLETION_CUTOVER_COMMANDS = frozenset({"search", "download", "analyze", "catalog"})
COMPLETION_STAGE_MODULES = (
    "sciretriever.acquisition", "sciretriever.analysis",
    "sciretriever.discovery", "sciretriever.normalization",
)
COMMAND_ADAPTER_IMPORTS = frozenset({
    "sciretriever.acquisition.existing_asset",
    "sciretriever.acquisition.policy_files",
    "sciretriever.acquisition.transport",
})
UPPERCASE_IMPORT_ALLOWLIST: set[tuple[str, str]] = set()


def imported_modules(path: Path, source_root: Path) -> tuple[str, ...]:
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    relative_parts = path.relative_to(source_root).with_suffix("").parts
    package_parts = ["sciretriever", *relative_parts[:-1]]
    imports: list[str] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imports.extend(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            retained = len(package_parts) - (node.level - 1) if node.level else 0
            base_parts = package_parts[:max(retained, 0)] if node.level else []
            if node.module is not None:
                base_parts.extend(node.module.split("."))
                imports.append(".".join(base_parts))
            if node.module is None or base_parts == ["sciretriever"]:
                imports.extend(".".join((*base_parts, alias.name)) for alias in node.names
                               if alias.name != "*")
        elif isinstance(node, ast.Call) and node.args:
            function = node.func
            is_runtime_import = (
                isinstance(function, ast.Name) and function.id == "__import__"
            ) or (
                isinstance(function, ast.Attribute)
                and function.attr == "import_module"
                and isinstance(function.value, ast.Name)
                and function.value.id == "importlib"
            )
            module = node.args[0]
            if is_runtime_import and isinstance(module, ast.Constant) and isinstance(module.value, str):
                imports.append(module.value)
    return tuple(imports)


def find_completion_command_violations(
    source_root: Path, cutover_commands: Set[str],
) -> tuple[str, ...]:
    violations: list[str] = []
    if not (source_root / "cli").is_dir():
        return ()
    for command in sorted(cutover_commands):
        path = source_root / "cli" / f"{command}.py"
        relative = path.relative_to(source_root).as_posix()
        if not path.is_file():
            violations.append(f"{relative}: cut-over command module is missing")
            continue
        imported = imported_modules(path, source_root)
        runtime = ("sciretriever.cli.search_completion_runtime" if command == "search"
                   else "sciretriever.cli.completion_runtime")
        uses_runtime = runtime in imported
        uses_stage = any(
            module not in COMMAND_ADAPTER_IMPORTS
            and (module == stage or module.startswith(stage + "."))
            for module in imported for stage in COMPLETION_STAGE_MODULES
        )
        if not uses_runtime or uses_stage:
            violations.append(
                f"{relative}: cut-over command must use {runtime.removeprefix('sciretriever.')}"
            )
    return tuple(violations)


def find_architecture_violations(
    source_root: Path, cutover_commands: Set[str] = COMPLETION_CUTOVER_COMMANDS,
) -> tuple[str, ...]:
    violations: list[str] = []
    for path in sorted(source_root.rglob("*.py")):
        relative = path.relative_to(source_root).as_posix()
        layer = Path(relative).parts[0]
        try:
            source = path.read_text(encoding="utf-8")
            tree = ast.parse(source, filename=str(path))
            imported = imported_modules(path, source_root)
        except (OSError, SyntaxError) as error:
            violations.append(f"{relative}: cannot parse: {error}")
            continue
        for module in imported:
            for forbidden in FORBIDDEN_IMPORTS.get(layer, ()):
                if module == forbidden or module.startswith(forbidden + "."):
                    violations.append(f"{relative}: {layer} must not import {module}")
            if module == "SciRetriever" or module.startswith("SciRetriever."):
                if (relative, module) not in UPPERCASE_IMPORT_ALLOWLIST:
                    violations.append(
                        f"{relative}: lowercase v2 must not import legacy module {module}"
                    )
        violations.extend(
            find_wp6_architecture_violations(path, source_root, imported, tree)
        )
    violations.extend(find_completion_command_violations(source_root, cutover_commands))
    return tuple(sorted(set(violations)))


__all__ = ("find_architecture_violations", "find_completion_command_violations")
