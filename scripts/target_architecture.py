from __future__ import annotations

import ast
from pathlib import Path
from typing import Final

from scripts.target_ast_rules import (
    declares_package_schema,
    dynamic_import_modules,
    reads_environment,
    violates_opaque_boundary,
    writes_artifact,
)
from scripts.target_contract_annotations import analyze_public_contract_annotations


TARGET_PACKAGES: Final = frozenset(
    {
        "kernel",
        "collection",
        "bibliography",
        "content",
        "literature_store",
        "interoperability",
        "batching",
        "adapters",
        "extensions",
        "runtime",
    }
)
_BUSINESS_PACKAGES: Final = frozenset(
    {"collection", "bibliography", "content", "interoperability", "batching"}
)
_ALLOWED_DEPENDENCIES: Final = {
    "kernel": frozenset(),
    "bibliography": frozenset({"kernel"}),
    "collection": frozenset({"kernel", "bibliography"}),
    "content": frozenset({"kernel"}),
    "interoperability": frozenset({"kernel", "bibliography"}),
    "batching": frozenset(
        {"kernel", "collection", "bibliography", "content", "interoperability"}
    ),
    "literature_store": frozenset({"kernel"}) | _BUSINESS_PACKAGES,
    "adapters": frozenset({"kernel"}) | _BUSINESS_PACKAGES,
    "extensions": frozenset({"kernel"}) | _BUSINESS_PACKAGES,
    "runtime": TARGET_PACKAGES - {"runtime"},
}
_PUBLIC_CROSS_MODULES: Final = frozenset({"api", "ports"})
_TOML_MODULES: Final = frozenset({"toml", "tomli", "tomllib"})
_VENDOR_SDKS: Final = frozenset({"anthropic", "openai", "playwright"})
def _target_import(module: str) -> tuple[str, str | None] | None:
    parts = module.split(".")
    if len(parts) < 2 or parts[0] != "sciretriever" or parts[1] not in TARGET_PACKAGES:
        return None
    submodule = parts[2] if len(parts) > 2 else None
    return parts[1], submodule


def find_target_architecture_violations(
    path: Path,
    source_root: Path,
    imports: tuple[str, ...],
    tree: ast.AST,
) -> tuple[str, ...]:
    relative = path.relative_to(source_root).as_posix()
    layer = path.relative_to(source_root).parts[0]
    if layer not in TARGET_PACKAGES:
        return ()

    violations: list[str] = []
    for module in (*imports, *dynamic_import_modules(tree)):
        root = module.split(".", maxsplit=1)[0]
        if root == "sqlalchemy" and layer != "literature_store":
            violations.append(f"{relative}: SQLAlchemy is restricted to literature_store")
        if root in _VENDOR_SDKS and layer != "adapters":
            violations.append(f"{relative}: vendor SDK {root} is restricted to adapters")
        if root in _TOML_MODULES and layer != "runtime":
            violations.append(f"{relative}: TOML reads are restricted to runtime")

        target = _target_import(module)
        if target is None:
            continue
        dependency, submodule = target
        package_import = (
            layer == "literature_store"
            and dependency == "extensions"
            and submodule == "packaging"
        )
        if package_import:
            violations.append(
                f"{relative}: literature_store must not import Package implementation {module}"
            )
            continue
        if dependency != layer and dependency not in _ALLOWED_DEPENDENCIES[layer]:
            violations.append(
                f"{relative}: target dependency {layer} -> {dependency} is forbidden"
            )
            continue
        if (
            dependency != layer
            and dependency != "kernel"
            and layer != "runtime"
            and submodule not in _PUBLIC_CROSS_MODULES
        ):
            violations.append(
                f"{relative}: cross-module import {dependency}.{submodule} is private"
            )

    if layer != "runtime" and reads_environment(tree):
        violations.append(f"{relative}: environment reads are restricted to runtime")
    if layer in _BUSINESS_PACKAGES and writes_artifact(tree):
        violations.append(f"{relative}: business modules must not write artifact files")
    if layer == "literature_store" and declares_package_schema(tree):
        violations.append(
            f"{relative}: literature_store must remain opaque to Package schemas"
        )
    if layer == "literature_store" and violates_opaque_boundary(tree):
        violations.append(
            f"{relative}: literature_store must not deserialize or interpret "
            "opaque extension payloads"
        )
    if layer == "literature_store":
        business_suffixes = ("Acceptance", "Command", "Fact", "Projection")
        for node in ast.walk(tree):
            if isinstance(node, ast.ClassDef) and node.name.endswith(business_suffixes):
                violations.append(
                    f"{relative}: literature_store must not declare business publisher payload {node.name}"
                )
    if path.name in {"ports.py", "model.py"}:
        annotation_analysis = analyze_public_contract_annotations(tree)
        for annotation in annotation_analysis.leaks:
            violations.append(
                f"{relative}: public contract annotation {annotation} is forbidden"
            )
        if annotation_analysis.malformed_forward_reference:
            violations.append(
                f"{relative}: malformed public contract forward reference"
            )
    return tuple(violations)


__all__ = (
    "TARGET_PACKAGES",
    "find_target_architecture_violations",
)
