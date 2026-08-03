from __future__ import annotations

import ast
import importlib
from pathlib import Path
from types import ModuleType
from unittest import TestCase

from pydantic import BaseModel, ValidationError

from sciretriever.model.primitives import AssetId, Sha256, sha256_digest

ROOT = Path(__file__).parents[1]
SRC = ROOT / "src" / "sciretriever"
PARSING_NAMES = {"ManifestBlock", "ParserRequest", "ParserTask", "ParserProvenance", "ParserResult"}
LLM_NAMES = {"LLMRequest", "LLMProvenance", "LLMStructuredResponse"}


def _class_names(path: Path) -> set[str]:
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    return {node.name for node in ast.walk(tree) if isinstance(node, ast.ClassDef)}


def _module(path: str) -> ModuleType:
    return importlib.import_module(path)


class TargetParsingLlmModelTests(TestCase):
    def test_parsing_and_llm_contracts_have_one_strict_frozen_owner(self) -> None:
        targets = (
            ("sciretriever.model.parsing", PARSING_NAMES),
            ("sciretriever.model.llm", LLM_NAMES),
        )
        for module_name, names in targets:
            module = _module(module_name)
            for name in names:
                contract = getattr(module, name, None)
                self.assertIsNotNone(contract, name)
                assert contract is not None
                self.assertTrue(issubclass(contract, BaseModel), name)
                self.assertEqual(contract.__module__, module_name, name)
                self.assertTrue(contract.model_config["frozen"], name)
                self.assertTrue(contract.model_config["strict"], name)
                self.assertEqual(contract.model_config["extra"], "forbid", name)

    def test_legacy_modules_do_not_define_or_reexport_parser_and_llm_contracts(self) -> None:
        legacy_paths = (
            SRC / "adapters" / "mineru.py",
            SRC / "adapters" / "analysis.py",
        )
        for path in legacy_paths:
            self.assertEqual(
                _class_names(path) & (PARSING_NAMES | LLM_NAMES),
                set(),
                str(path),
            )

        for module_name in (
            "sciretriever.adapters.mineru",
            "sciretriever.adapters.analysis",
        ):
            module = _module(module_name)
            self.assertEqual(set(module.__dict__) & (PARSING_NAMES | LLM_NAMES), set(), module_name)

        parsing = _module("sciretriever.model.parsing")
        llm = _module("sciretriever.model.llm")
        self.assertNotIn("ParserTaskView", parsing.__dict__)
        self.assertNotIn("ParserTaskStatus", parsing.__dict__)
        self.assertNotIn("LLMResponse", llm.__dict__)

    def test_model_modules_do_not_import_vendor_or_application_layers(self) -> None:
        for path in (SRC / "model" / "parsing.py", SRC / "model" / "llm.py"):
            tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
            imported = {
                node.module or "" for node in ast.walk(tree) if isinstance(node, ast.ImportFrom)
            }
            imported.update(
                alias.name
                for node in ast.walk(tree)
                if isinstance(node, ast.Import)
                for alias in node.names
            )
            self.assertFalse(any(name.startswith("sciretriever.adapters") for name in imported))
            self.assertFalse(any(name.startswith("sciretriever.content") for name in imported))
            self.assertFalse(any(name.startswith("sciretriever.kernel") for name in imported))
            self.assertFalse(any(name.startswith("sciretriever.legacy") for name in imported))

    def test_parser_request_and_llm_request_reject_vendor_secrets_and_mutation(self) -> None:
        parsing = _module("sciretriever.model.parsing")
        llm = _module("sciretriever.model.llm")
        request = parsing.ParserRequest(
            pdf=b"%PDF-fixture",
            asset_id=AssetId("00000000-0000-0000-0000-000000000101"),
            asset_sha256=sha256_digest(b"%PDF-fixture"),
            resume_task_id=None,
        )
        self.assertIsInstance(request.asset_sha256, Sha256)
        self.assertNotIn("%PDF-fixture", repr(request))
        with self.assertRaises(ValidationError):
            request.pdf = b"changed"
        with self.assertRaises(ValidationError):
            parsing.ParserRequest(
                pdf=b"%PDF-fixture",
                asset_id=request.asset_id,
                asset_sha256=request.asset_sha256,
                resume_task_id=None,
                api_key="runtime-secret",
            )
        with self.assertRaises(ValidationError):
            llm.LLMRequest(
                document=None,
                model="fixture-model",
                max_output_tokens=32,
                api_key="runtime-secret",
            )


if __name__ == "__main__":
    import unittest

    unittest.main()
