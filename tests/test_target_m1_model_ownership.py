from __future__ import annotations

import ast
import importlib
import sys
from pathlib import Path
from types import ModuleType
from unittest import TestCase

from pydantic import BaseModel

ROOT = Path(__file__).parents[1]
SRC = ROOT / "src" / "sciretriever"
LEGACY_PACKAGES = (
    "bibliography",
    "collection",
    "content",
    "interoperability",
    "batching",
    "adapters",
    "literature_store",
    "runtime",
    "kernel",
)
MIGRATED_NAMES = {
    "AnalysisJsonSchema",
    "ContentTarget",
    "ImportIdentityResolution",
    "ImportPreparationOutcome",
    "ImportPreparationRequest",
    "LightPublicationTarget",
    "TopicConditions",
    "UnifiedMetadataSnapshot",
}
TARGET_OWNERS = {
    "ContentTarget": "sciretriever.model.assets",
    "ImportIdentityResolution": "sciretriever.model.record",
    "ImportPreparationOutcome": "sciretriever.model.record",
    "ImportPreparationRequest": "sciretriever.model.record",
    "LightPublicationTarget": "sciretriever.model.documents",
    "TopicConditions": "sciretriever.model.collection",
    "UnifiedMetadataSnapshot": "sciretriever.model.literature",
}
TARGET_ALIAS_OWNERS = {"AnalysisJsonSchema": "sciretriever.model.analysis"}
DEFERRED_TECHNICAL_DATA = {
    "AnalysisAdapterSettings",
    "AnalysisBounds",
    "ArtifactIdentity",
    "BoundCatalogAdmission",
    "CitationExecutionDependencies",
    "CitationSource",
    "CollectionServiceDependencies",
    "CoreStorage",
    "FormalArtifactCandidate",
    "HeldAdmission",
    "LightDocumentBounds",
    "ManifestBlock",
    "MetadataSource",
    "MinerUServiceBounds",
    "ParserIdentity",
    "ProviderDependencies",
    "ProviderRuntimeConfig",
    "ReconciliationConfig",
    "ReconciliationResult",
    "ResolverCandidate",
    "ResolverTier",
    "SourceProgress",
}


def _module(path: str) -> ModuleType:
    return importlib.import_module(path)


def _classify(node: ast.ClassDef) -> str:
    bases = {ast.unparse(base) for base in node.bases}
    if any("Protocol" in base for base in bases):
        return "port"
    if any("Exception" in base or base in {"OSError", "ValueError"} for base in bases):
        return "typed-exception"
    if node.name in MIGRATED_NAMES:
        return "pure-business-data"
    if node.name in DEFERRED_TECHNICAL_DATA:
        return "technical-data"
    if any(isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)) for item in node.body):
        return "service-orchestration"
    return "technical-state"


def _inventory() -> tuple[tuple[str, str, str], ...]:
    entries: list[tuple[str, str, str]] = []
    for package in LEGACY_PACKAGES:
        for path in sorted((SRC / package).rglob("*.py")):
            tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
            for node in tree.body:
                if isinstance(node, ast.ClassDef):
                    entries.append((path.as_posix(), node.name, _classify(node)))
                elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
                    if isinstance(node.annotation, ast.Name) and node.annotation.id == "TypeAlias":
                        entries.append((path.as_posix(), node.target.id, "type-alias"))
    return tuple(entries)


class TargetM1ModelOwnershipTests(TestCase):
    def test_ast_inventory_classifies_every_legacy_class_and_alias(self) -> None:
        inventory = _inventory()

        self.assertTrue(inventory)
        self.assertTrue(all(category for _path, _name, category in inventory))
        self.assertEqual(
            {name for _path, name, category in inventory if category == "pure-business-data"},
            set(),
        )

    def test_migrated_contracts_have_one_strict_frozen_model_owner(self) -> None:
        for name, module_name in TARGET_OWNERS.items():
            module = _module(module_name)
            contract = getattr(module, name, None)
            self.assertIsNotNone(contract, f"{module_name}.{name}")
            assert contract is not None
            self.assertTrue(issubclass(contract, BaseModel), name)
            self.assertEqual(contract.__module__, module_name, name)
            self.assertTrue(contract.model_config["frozen"], name)
            self.assertTrue(contract.model_config["strict"], name)
            self.assertEqual(contract.model_config["extra"], "forbid", name)
        for name, module_name in TARGET_ALIAS_OWNERS.items():
            self.assertIsNotNone(getattr(_module(module_name), name, None), name)

    def test_legacy_modules_do_not_define_or_reexport_migrated_contracts(self) -> None:
        for path, name, _category in _inventory():
            if name in MIGRATED_NAMES:
                self.fail(f"legacy definition remains: {path}:{name}")

        for path in sorted(SRC.glob("**/*.py")):
            if not path.parts or path.parts[-1] == "__init__.py":
                continue
            relative = path.relative_to(SRC)
            if relative.parts[0] not in LEGACY_PACKAGES:
                continue
            module_name = "sciretriever." + ".".join(relative.with_suffix("").parts)
            module = _module(module_name)
            self.assertEqual(set(module.__dict__) & MIGRATED_NAMES, set(), module_name)

    def test_target_model_imports_are_closed_to_stdlib_pydantic_and_model(self) -> None:
        stdlib = set(sys.stdlib_module_names)
        for path in sorted((SRC / "model").glob("*.py")):
            tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
            imported_roots: set[str] = set()
            for node in ast.walk(tree):
                if isinstance(node, ast.Import):
                    imported_roots.update(alias.name.split(".", 1)[0] for alias in node.names)
                elif isinstance(node, ast.ImportFrom) and node.module is not None:
                    imported_roots.add(node.module.split(".", 1)[0])
            external = imported_roots - stdlib - {"pydantic", "sciretriever"}
            self.assertEqual(external, set(), str(path))
            sciretriever_imports = {
                node.module or ""
                for node in ast.walk(tree)
                if isinstance(node, ast.ImportFrom)
                and (node.module or "").startswith("sciretriever.")
            }
            sciretriever_imports.update(
                alias.name
                for node in ast.walk(tree)
                if isinstance(node, ast.Import)
                for alias in node.names
                if alias.name.startswith("sciretriever.")
            )
            self.assertTrue(
                all(
                    name == "sciretriever.model" or name.startswith("sciretriever.model.")
                    for name in sciretriever_imports
                ),
                str(path),
            )

    def test_target_models_only_define_controlled_validators(self) -> None:
        utility_methods = {
            ("canonical_json.py", "CanonicalJsonObject"),
            ("primitives.py", "_StringRoot"),
        }
        for path in sorted((SRC / "model").glob("*.py")):
            tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
            for class_node in (node for node in tree.body if isinstance(node, ast.ClassDef)):
                if (path.name, class_node.name) in utility_methods:
                    continue
                for method in (
                    node
                    for node in class_node.body
                    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
                ):
                    decorators = {ast.unparse(decorator) for decorator in method.decorator_list}
                    self.assertTrue(
                        any("validator" in decorator for decorator in decorators),
                        f"ordinary Model method: {path}:{class_node.name}.{method.name}",
                    )


if __name__ == "__main__":
    import unittest

    unittest.main()
