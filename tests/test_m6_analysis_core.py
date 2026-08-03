from __future__ import annotations

import ast
import json
import unittest
from pathlib import Path

from pydantic import BaseModel, ValidationError
from target_light_document_support import ASSET_ID, parsed_document

from sciretriever.core.analysis import (
    AnalysisValidationError,
    analysis_bytes,
    analysis_json_schema,
    validate_analysis_input,
    validate_analysis_text,
    validate_llm_request,
    validate_llm_response,
)
from sciretriever.core.documents import document_bytes
from sciretriever.model.analysis import (
    ANALYSIS_CATEGORIES,
    AnalysisBounds,
    AnalysisProposalV1,
)
from sciretriever.model.canonical_json import CanonicalJsonInput
from sciretriever.model.documents import LightDocumentV1
from sciretriever.model.llm import LLMProvenance, LLMRequest, LLMStructuredResponse
from sciretriever.model.primitives import sha256_digest


def _locator() -> dict[str, CanonicalJsonInput]:
    return {
        "asset_id": str(ASSET_ID),
        "page_start": 1,
        "page_end": 1,
        "block_id": "b1",
        "char_start": 0,
        "char_end": 5,
    }


def _proposal_value() -> dict[str, CanonicalJsonInput]:
    evidence = {"text": "alpha", "evidence": [_locator()]}
    return {
        "schema_version": "1",
        "final_bibliography": {
            "title": "Title",
            "authors": [],
            "abstract": None,
            "publication_date": None,
            "publication_year": None,
            "document_type": None,
            "language": None,
            "venue": None,
            "publisher": None,
            "volume": None,
            "issue": None,
            "pages": None,
            "article_number": None,
            "open_access_status": None,
            "identifiers": [],
        },
        "classification": {"document_type": None, "language": None, "subjects": []},
        "content_overview": {"summary": evidence, "conclusions": []},
        "research_objectives": [],
        "methods": [],
        "key_results": [],
        "conclusions_and_limitations": {"conclusions": [], "limitations": []},
        "keywords_and_tags": {"keywords": [], "tags": []},
        "references": [],
    }


def _document() -> LightDocumentV1:
    return parsed_document()


def _bounds() -> AnalysisBounds:
    return AnalysisBounds(
        max_input_characters=200_000,
        max_source_units=100,
        max_output_characters=10_000,
    )


def _proposal() -> AnalysisProposalV1:
    return AnalysisProposalV1.model_validate_json(json.dumps(_proposal_value()))


class M6AnalysisCoreTests(unittest.TestCase):
    def test_analysis_models_are_strict_frozen_and_bounds_are_positive(self) -> None:
        for model in (AnalysisBounds, AnalysisProposalV1):
            self.assertTrue(issubclass(model, BaseModel))
            self.assertTrue(model.model_config.get("frozen"))
            self.assertTrue(model.model_config.get("strict"))
            self.assertEqual(model.model_config.get("extra"), "forbid")

        bounds = _bounds()
        with self.assertRaises(ValidationError):
            bounds.max_input_characters = 1
        with self.assertRaises(ValidationError):
            AnalysisBounds(max_input_characters=True, max_source_units=1)
        with self.assertRaises(ValidationError):
            AnalysisBounds(max_input_characters=0, max_source_units=1)

    def test_schema_is_closed_and_contains_exactly_nine_categories(self) -> None:
        schema = analysis_json_schema()
        required = schema["required"]
        properties = schema["properties"]
        if not isinstance(required, list) or not isinstance(properties, dict):
            self.fail("analysis schema must expose list required and mapping properties")
        expected = set(ANALYSIS_CATEGORIES) | {"schema_version"}
        required_names = {item for item in required if isinstance(item, str)}
        property_names = {item for item in properties if isinstance(item, str)}
        self.assertEqual(len(required_names), len(required))
        self.assertEqual(len(property_names), len(properties))
        self.assertEqual(required_names, expected)
        self.assertEqual(property_names, expected)
        self.assertFalse(schema["additionalProperties"])

    def test_analysis_bytes_and_input_hash_are_deterministic(self) -> None:
        proposal = _proposal()
        restored = AnalysisProposalV1.model_validate_json(analysis_bytes(proposal))
        self.assertEqual(analysis_bytes(restored), analysis_bytes(proposal))

        document = _document()
        source = document_bytes(document).decode("ascii")
        self.assertEqual(
            validate_analysis_input(source, document, _bounds()),
            source,
        )
        self.assertEqual(sha256_digest(document_bytes(document)), sha256_digest(source.encode()))

    def test_input_is_whole_document_and_respects_bounds(self) -> None:
        document = _document()
        source = document_bytes(document).decode("ascii")
        self.assertEqual(validate_analysis_input(source, document, _bounds()), source)
        with self.assertRaises(AnalysisValidationError) as raised:
            validate_analysis_input(
                source,
                document,
                AnalysisBounds(max_input_characters=1, max_source_units=100),
            )
        self.assertEqual(raised.exception.code, "analysis_input_too_large")
        with self.assertRaises(AnalysisValidationError) as raised:
            validate_analysis_input(
                source,
                document,
                AnalysisBounds(max_input_characters=200_000, max_source_units=1),
            )
        self.assertEqual(raised.exception.code, "analysis_input_too_large")

    def test_complete_proposal_validation_rejects_unknown_or_missing_categories(self) -> None:
        document = _document()
        valid = validate_analysis_text(json.dumps(_proposal_value()), document, _bounds())
        self.assertEqual(valid, _proposal())

        unknown = _proposal_value()
        unknown["unexpected"] = "not-a-category"
        with self.assertRaises(AnalysisValidationError) as raised:
            validate_analysis_text(json.dumps(unknown), document, _bounds())
        self.assertEqual(raised.exception.code, "analysis_invalid_output")

        missing = _proposal_value()
        del missing["methods"]
        with self.assertRaises(AnalysisValidationError) as raised:
            validate_analysis_text(json.dumps(missing), document, _bounds())
        self.assertEqual(raised.exception.code, "analysis_invalid_output")

    def test_evidence_must_resolve_inside_the_whole_document(self) -> None:
        invalid = _proposal_value()
        summary = invalid["content_overview"]
        assert isinstance(summary, dict)
        evidence = summary["summary"]
        assert isinstance(evidence, dict)
        locator = evidence["evidence"]
        assert isinstance(locator, list)
        first = locator[0]
        assert isinstance(first, dict)
        first["char_end"] = 6

        with self.assertRaises(AnalysisValidationError) as raised:
            validate_analysis_text(json.dumps(invalid), _document(), _bounds())
        self.assertEqual(raised.exception.code, "analysis_invalid_evidence")

    def test_llm_response_must_match_one_complete_document_input(self) -> None:
        document = _document()
        bounds = _bounds()
        source = document_bytes(document).decode("ascii")
        input_sha256 = sha256_digest(document_bytes(document))
        request = LLMRequest(
            source=source,
            input_sha256=input_sha256,
            model="model",
            max_output_tokens=32,
        )
        self.assertNotIn("document", type(request).model_fields)
        self.assertEqual((request.source, request.input_sha256), (source, input_sha256))
        self.assertNotIn(source, repr(request))
        response = LLMStructuredResponse(
            proposal=_proposal(),
            provenance=LLMProvenance(
                provider="provider",
                model="model",
                input_sha256=input_sha256,
                parameters_sha256=sha256_digest(b"parameters"),
            ),
        )
        self.assertIs(validate_llm_request(request, document, bounds), request)
        self.assertIs(validate_llm_response(request, response, document, bounds), response)

        invalid = response.model_copy(
            update={
                "provenance": response.provenance.model_copy(
                    update={"input_sha256": sha256_digest(b"other")}
                )
            }
        )
        with self.assertRaises(AnalysisValidationError) as raised:
            validate_llm_response(request, invalid, document, bounds)
        self.assertEqual(raised.exception.code, "analysis_input_mismatch")

        invalid_request = request.model_copy(update={"input_sha256": sha256_digest(b"other")})
        with self.assertRaises(AnalysisValidationError) as raised:
            validate_llm_request(invalid_request, document, bounds)
        self.assertEqual(raised.exception.code, "analysis_input_mismatch")

    def test_model_and_core_do_not_import_legacy_content_or_adapter_layers(self) -> None:
        root = Path(__file__).parents[1] / "src" / "sciretriever"
        paths = (root / "model" / "analysis.py", root / "model" / "llm.py") + tuple(
            sorted((root / "core" / "analysis").glob("*.py"))
        )
        for path in paths:
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
            self.assertFalse(any(name.startswith("sciretriever.content") for name in imported))
            self.assertFalse(any(name.startswith("sciretriever.adapters") for name in imported))
            self.assertFalse(
                any(name.startswith("sciretriever.core.documents") for name in imported)
            )

        tree = ast.parse(
            (root / "core" / "analysis" / "serialization.py").read_text(encoding="utf-8")
        )
        definitions = {
            node.name
            for node in ast.walk(tree)
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
        }
        self.assertNotIn("document_value", definitions)
        self.assertNotIn("document_bytes", definitions)


if __name__ == "__main__":
    unittest.main()
