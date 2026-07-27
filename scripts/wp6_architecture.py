"""WP6 ownership and retired-shape architecture checks."""

from __future__ import annotations

import ast
from pathlib import Path
import re
from typing import Final


_WORKFLOW_LAYERS: Final = frozenset({"expansion", "references"})
_CONCRETE_PROVIDER_PREFIXES: Final = (
    "sciretriever.discovery.providers",
    "sciretriever.integrations",
)
_NEUTRAL_GRAPH_IMPORTS: Final = frozenset(
    {
        "sciretriever.integrations.graph",
        "sciretriever.integrations.models",
    }
)
_RETIRED_PARTS: Final = frozenset(
    {
        "compat",
        "compatibility",
        "legacy",
        "migration",
        "migrations",
        "scheduler",
        "schedulers",
        "status",
        "statuses",
    }
)
_PACKAGE_TYPES: Final = frozenset({"DocumentPackage", "DocumentPackageVersion"})
_FORBIDDEN_SCHEMA_TOKENS: Final = frozenset(
    {
        "compat",
        "compatibility",
        "job",
        "jobs",
        "legacy",
        "migration",
        "migrations",
        "scheduler",
        "schedulers",
        "status",
        "statuses",
        "task",
        "tasks",
    }
)
def _is_concrete_provider(module: str) -> bool:
    if module in _NEUTRAL_GRAPH_IMPORTS:
        return False
    return any(
        module == prefix or module.startswith(prefix + ".")
        for prefix in _CONCRETE_PROVIDER_PREFIXES
    )


def _call_name(call: ast.Call) -> str | None:
    match call.func:
        case ast.Name(id=name):
            return name
        case ast.Attribute(attr=name):
            return name
        case _:
            return None


def _forbidden_table_name(name: str) -> bool:
    tokens = frozenset(re.findall(r"[a-z0-9]+", name.casefold()))
    return bool(tokens & _FORBIDDEN_SCHEMA_TOKENS)


def _sqlalchemy_table_bindings(tree: ast.AST) -> tuple[frozenset[str], frozenset[str]]:
    names: set[str] = {"Table"}
    modules: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and (
            node.module == "sqlalchemy"
            or (node.module is not None and node.module.startswith("sqlalchemy."))
        ):
            names.update(
                alias.asname or alias.name
                for alias in node.names
                if alias.name == "Table"
            )
        elif isinstance(node, ast.Import):
            modules.update(
                alias.asname or "sqlalchemy"
                for alias in node.names
                if alias.name == "sqlalchemy"
            )
    return frozenset(names), frozenset(modules)


def _is_sqlalchemy_table_call(
    call: ast.Call,
    names: frozenset[str],
    modules: frozenset[str],
) -> bool:
    match call.func:
        case ast.Name(id=name):
            return name in names
        case ast.Attribute(value=ast.Name(id=module), attr="Table"):
            return module in modules
        case _:
            return False


def _declared_table_names(tree: ast.AST) -> tuple[str, ...]:
    table_names, sqlalchemy_modules = _sqlalchemy_table_bindings(tree)
    declared: list[str] = []
    for node in ast.walk(tree):
        if (
            isinstance(node, ast.Call)
            and _is_sqlalchemy_table_call(node, table_names, sqlalchemy_modules)
            and node.args
            and isinstance(node.args[0], ast.Constant)
            and isinstance(node.args[0].value, str)
        ):
            declared.append(node.args[0].value)
        if isinstance(node, ast.ClassDef):
            for statement in node.body:
                match statement:
                    case ast.Assign(
                        targets=[ast.Name(id="__tablename__")],
                        value=ast.Constant(value=str(name)),
                    ):
                        declared.append(name)
                    case ast.AnnAssign(
                        target=ast.Name(id="__tablename__"),
                        value=ast.Constant(value=str(name)),
                    ):
                        declared.append(name)
    return tuple(declared)


def find_wp6_architecture_violations(
    path: Path,
    source_root: Path,
    imports: tuple[str, ...],
    tree: ast.AST,
) -> tuple[str, ...]:
    """Return WP6 ownership violations for one parsed product module."""
    relative = path.relative_to(source_root).as_posix()
    parts = path.relative_to(source_root).with_suffix("").parts
    layer = parts[0]
    violations: list[str] = []

    for table_name in _declared_table_names(tree):
        if _forbidden_table_name(table_name):
            violations.append(
                f"{relative}: forbidden WP6 schema table {table_name!r}"
            )

    lowered_parts = tuple(part.casefold() for part in parts)
    retired = {
        marker
        for marker in _RETIRED_PARTS
        if any(marker in part.split("_") for part in lowered_parts)
    }
    if retired:
        violations.append(
            f"{relative}: WP6 forbids retired architecture module {sorted(retired)[0]}"
        )

    for module in imports:
        if layer in _WORKFLOW_LAYERS and _is_concrete_provider(module):
            violations.append(
                f"{relative}: {layer} must not import concrete provider {module}"
            )
        if layer in {"catalog", "core"} and (
            module == "sciretriever.expansion"
            or module.startswith("sciretriever.expansion.")
            or module == "sciretriever.references"
            or module.startswith("sciretriever.references.")
            or _is_concrete_provider(module)
        ):
            violations.append(f"{relative}: {layer} must not import WP6 workflow {module}")
        if module in {"tomli", "tomllib"} and relative != "config_loader.py":
            violations.append(
                f"{relative}: config parser is owned by config_loader.py"
            )
        if module == "sciretriever.config" and relative.startswith("cli/"):
            imported_names = {
                alias.name
                for node in ast.walk(tree)
                if isinstance(node, ast.ImportFrom) and node.module == module
                for alias in node.names
            }
            if "load_config" in imported_names and relative != "cli/main.py":
                violations.append(
                    f"{relative}: config loading is owned by cli/main.py"
                )

    if layer != "packaging" and relative != "core/package.py":
        for node in ast.walk(tree):
            if isinstance(node, ast.Call) and _call_name(node) in _PACKAGE_TYPES:
                violations.append(
                    f"{relative}: package construction is owned by packaging"
                )
                break

    if relative == "cli/expand.py" and not any(
        module.startswith("sciretriever.cli.expansion_runtime") for module in imports
    ):
        violations.append(
            f"{relative}: expansion command must use cli.expansion_runtime"
        )
    return tuple(violations)


__all__ = ("find_wp6_architecture_violations",)
