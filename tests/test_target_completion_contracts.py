from __future__ import annotations

import ast
import importlib
from pathlib import Path
from types import ModuleType
from unittest import TestCase

from pydantic import BaseModel

ROOT = Path(__file__).parents[1]
SRC = ROOT / "src" / "sciretriever"

LITERATURE_NAMES = {
    "ReferenceMemberFact",
    "TagMemberFact",
    "ReferenceSetFact",
    "TagSetFact",
    "FinalMetadataFact",
    "CompletionAnalysisFact",
    "CompletionProvenance",
    "CompletionSubmission",
}
ANALYSIS_NAMES = {
    "SourceLocator",
    "EvidenceText",
    "Identifier",
    "Author",
    "UnifiedMetadataValues",
    "ReferenceView",
    "Classification",
    "ContentOverview",
    "ConclusionsAndLimitations",
    "KeywordsAndTags",
    "AnalysisProposalV1",
}


def _class_names(path: Path) -> set[str]:
    if not path.exists():
        return set()
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    return {node.name for node in ast.walk(tree) if isinstance(node, ast.ClassDef)}


def _module(path: str) -> ModuleType:
    return importlib.import_module(path)


def _optional_module(path: str) -> ModuleType | None:
    try:
        return importlib.import_module(path)
    except ModuleNotFoundError as error:
        if error.name is None or not (path == error.name or path.startswith(f"{error.name}.")):
            raise
        return None


class TargetCompletionContractTests(TestCase):
    def test_completion_facts_have_one_strict_frozen_model_owner(self) -> None:
        target_path = SRC / "model" / "literature.py"
        self.assertTrue(target_path.exists(), "target literature model is missing")
        target = _module("sciretriever.model.literature")
        for name in LITERATURE_NAMES:
            contract = getattr(target, name, None)
            self.assertIsNotNone(contract, name)
            assert contract is not None
            self.assertTrue(issubclass(contract, BaseModel), name)
            self.assertIs(contract.__module__, target.__name__)
            self.assertTrue(contract.model_config["frozen"], name)
            self.assertTrue(contract.model_config["strict"], name)
            self.assertEqual(contract.model_config["extra"], "forbid", name)

    def test_analysis_proposal_has_one_strict_frozen_model_owner(self) -> None:
        target_path = SRC / "model" / "analysis.py"
        self.assertTrue(target_path.exists(), "target analysis model is missing")
        target = _module("sciretriever.model.analysis")
        allowed_owners = {
            target.__name__,
            "sciretriever.model.documents",
            "sciretriever.model.literature",
        }
        for name in ANALYSIS_NAMES:
            contract = getattr(target, name, None)
            self.assertIsNotNone(contract, name)
            assert contract is not None
            self.assertTrue(issubclass(contract, BaseModel), name)
            self.assertIn(contract.__module__, allowed_owners, name)
            self.assertTrue(contract.model_config["frozen"], name)
            self.assertTrue(contract.model_config["strict"], name)
            self.assertEqual(contract.model_config["extra"], "forbid", name)

    def test_legacy_modules_do_not_define_migrated_data_contracts(self) -> None:
        legacy_paths = (SRC / "bibliography" / "publisher_contracts.py",)
        for path in legacy_paths:
            self.assertEqual(
                _class_names(path) & (LITERATURE_NAMES | ANALYSIS_NAMES),
                set(),
                str(path),
            )

        for module_name, names in (("sciretriever.bibliography.api", LITERATURE_NAMES),):
            module = _optional_module(module_name)
            if module is None:
                continue
            self.assertEqual(set(module.__dict__) & names, set(), module_name)

    def test_legacy_content_analysis_modules_are_removed(self) -> None:
        for filename in ("analysis.py", "api.py", "model.py", "ports.py"):
            self.assertFalse((SRC / "content" / filename).exists(), filename)

    def test_analysis_rules_and_service_ports_have_target_owners(self) -> None:
        core = _module("sciretriever.core.analysis")
        service = _module("sciretriever.services.analysis")
        ports = _module("sciretriever.services.analysis.ports")

        self.assertEqual(core.analysis_bytes.__module__, "sciretriever.core.analysis.serialization")
        self.assertEqual(
            core.validate_analysis_text.__module__, "sciretriever.core.analysis.validation"
        )
        self.assertEqual(service.AnalysisService.__module__, "sciretriever.services.analysis.api")
        self.assertEqual(ports.LLMPort.__module__, "sciretriever.services.analysis.ports")

    def test_core_owns_completion_rules_and_legacy_paths_do_not(self) -> None:
        core_paths = (
            SRC / "core" / "literature" / "completion.py",
            SRC / "core" / "literature" / "state.py",
            SRC / "core" / "literature" / "acceptance.py",
        )
        for path in core_paths:
            self.assertTrue(path.exists(), str(path))

        legacy_definitions = {
            "metadata_snapshot_bytes",
            "metadata_snapshot_sha256",
            "completion_submission_canonical",
            "derive_work_version_state",
            "derive_missing_step",
            "accept_completion",
        }
        for path in (
            SRC / "bibliography" / "publisher_contracts.py",
            SRC / "bibliography" / "completion.py",
            SRC / "bibliography" / "state.py",
        ):
            if path.exists():
                tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
                definitions = {
                    node.name
                    for node in ast.walk(tree)
                    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
                }
                self.assertEqual(definitions & legacy_definitions, set(), str(path))

    def test_target_models_are_independent_of_kernel_and_legacy_packages(self) -> None:
        for path in (
            SRC / "model" / "literature.py",
            SRC / "model" / "analysis.py",
        ):
            self.assertTrue(path.exists(), str(path))
            tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
            imports = {
                node.module or "" for node in ast.walk(tree) if isinstance(node, ast.ImportFrom)
            }
            imports.update(
                alias.name
                for node in ast.walk(tree)
                if isinstance(node, ast.Import)
                for alias in node.names
            )
            self.assertFalse(any(name.startswith("sciretriever.kernel") for name in imports))
            self.assertFalse(any(name.startswith("sciretriever.legacy") for name in imports))

    def test_literature_service_ports_are_owned_by_services(self) -> None:
        path = SRC / "services" / "literature" / "ports.py"
        self.assertTrue(path.exists(), "literature service ports are missing")
        module = _module("sciretriever.services.literature.ports")
        self.assertTrue(hasattr(module, "LiteratureRepository"))
        self.assertTrue(hasattr(module, "CompletionFactsRepository"))
        self.assertTrue(hasattr(module, "CompletionPublisher"))
