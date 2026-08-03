from __future__ import annotations

import json

from target_light_document_support import ASSET_ID, manifest_blocks, parsed_document

from sciretriever.adapters.analysis import (
    AnalysisAdapterSettings,
    AnthropicAnalysisAdapter,
    OpenAIAnalysisAdapter,
)
from sciretriever.core.documents import document_bytes, validate_light_document
from sciretriever.model.canonical_json import CanonicalJsonInput
from sciretriever.model.documents import LightDocumentBounds, LightDocumentV1
from sciretriever.model.llm import LLMRequest
from sciretriever.model.primitives import sha256_digest


def proposal_value() -> dict[str, CanonicalJsonInput]:
    locator = {
        "asset_id": str(ASSET_ID),
        "page_start": 1,
        "page_end": 1,
        "block_id": "b1",
        "char_start": 0,
        "char_end": 5,
    }
    evidence = {"text": "alpha", "evidence": [locator]}
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


def complete_document():
    return validate_light_document(
        parsed_document(),
        ASSET_ID,
        2,
        manifest_blocks(),
        LightDocumentBounds(),
    )


def adapter_settings() -> AnalysisAdapterSettings:
    return AnalysisAdapterSettings(
        base_url="https://llm.example/v1",
        model="exact-model",
        timeout_seconds=17.0,
        max_output_tokens=321,
        max_input_characters=200_000,
    )


def analysis_request(document: LightDocumentV1) -> LLMRequest:
    serialized = document_bytes(document)
    return LLMRequest(
        source=serialized.decode("ascii"),
        input_sha256=sha256_digest(serialized),
        model="exact-model",
        max_output_tokens=321,
    )


class OpenAIClient:
    def __init__(self, response) -> None:
        self.response = response
        self.kwargs = None

    @property
    def chat(self):
        return self

    @property
    def completions(self):
        return self

    def create(self, **kwargs):
        self.kwargs = kwargs
        return self.response


class AnthropicClient:
    def __init__(self, response) -> None:
        self.response = response
        self.kwargs = None

    @property
    def messages(self):
        return self

    def create(self, **kwargs):
        self.kwargs = kwargs
        return self.response


def openai_adapter(value: dict[str, CanonicalJsonInput]) -> OpenAIAnalysisAdapter:
    message = type("Message", (), {"content": json.dumps(value), "refusal": None})()
    choice = type("Choice", (), {"finish_reason": "stop", "message": message})()
    client = OpenAIClient(type("Response", (), {"model": "exact-model", "choices": [choice]})())

    def factory(*, api_key: str, base_url: str, timeout: float, max_retries: int) -> OpenAIClient:
        return client

    return OpenAIAnalysisAdapter(adapter_settings(), "runtime-secret", factory)


def anthropic_adapter(value: dict[str, CanonicalJsonInput]) -> AnthropicAnalysisAdapter:
    text = type("Text", (), {"type": "text", "text": json.dumps(value)})()
    response = type(
        "Response",
        (),
        {"model": "exact-model", "stop_reason": "end_turn", "content": [text]},
    )()
    client = AnthropicClient(response)

    def factory(
        *, api_key: str, base_url: str, timeout: float, max_retries: int
    ) -> AnthropicClient:
        return client

    return AnthropicAnalysisAdapter(adapter_settings(), "runtime-secret", factory)
