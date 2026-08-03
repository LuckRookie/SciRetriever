from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

from target_light_document_support import ASSET_ID, manifest_blocks, parsed_document

from sciretriever.core.documents import document_bytes, validate_light_document
from sciretriever.infrastructure.llm import (
    AnalysisAdapterSettings,
    AnthropicAnalysisAdapter,
    OpenAIAnalysisAdapter,
)
from sciretriever.infrastructure.storage.sqlite import open_read_only_snapshot
from sciretriever.model.canonical_json import CanonicalJsonInput
from sciretriever.model.documents import LightDocumentBounds, LightDocumentV1
from sciretriever.model.llm import LLMRequest
from sciretriever.model.primitives import sha256_digest

SqlValue = str | int | float | bytes | None


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


@dataclass(frozen=True, slots=True)
class AuthoritySnapshot:
    artifacts: tuple[tuple[SqlValue, ...], ...]
    analyses: tuple[tuple[SqlValue, ...], ...]
    metadata: tuple[tuple[SqlValue, ...], ...]
    metadata_pointer: tuple[tuple[SqlValue, ...], ...]
    references: tuple[tuple[SqlValue, ...], ...]
    reference_members: tuple[tuple[SqlValue, ...], ...]
    unresolved_references: tuple[tuple[SqlValue, ...], ...]
    tags: tuple[tuple[SqlValue, ...], ...]
    tag_members: tuple[tuple[SqlValue, ...], ...]
    bundles: tuple[tuple[SqlValue, ...], ...]
    fts: tuple[tuple[SqlValue, ...], ...]
    failures: tuple[tuple[SqlValue, ...], ...]
    target: tuple[tuple[SqlValue, ...], ...]
    state: tuple[tuple[SqlValue, ...], ...]


def authority_snapshot(
    path: Path,
    work_version_id: str,
    batch_run_id: str,
) -> AuthoritySnapshot:
    with open_read_only_snapshot(path) as reader:

        def rows(
            sql: str,
            values: tuple[SqlValue, ...] = (),
        ) -> tuple[tuple[SqlValue, ...], ...]:
            return tuple(reader.execute(sql, values).fetchall())

        return AuthoritySnapshot(
            rows(
                "SELECT id,kind,sha256,storage_path,byte_size FROM artifacts "
                "WHERE kind='analysis' ORDER BY id"
            ),
            rows(
                "SELECT id,artifact_id,sha256,input_sha256,proposal_json,provenance_json "
                "FROM analysis_artifacts ORDER BY id"
            ),
            rows(
                "SELECT id,revision,sha256,values_json,provenance_json FROM metadata_snapshots "
                "WHERE work_version_id=? ORDER BY revision",
                (work_version_id,),
            ),
            rows(
                "SELECT metadata_snapshot_id FROM work_version_current_metadata "
                "WHERE work_version_id=?",
                (work_version_id,),
            ),
            rows(
                "SELECT id,revision,complete FROM reference_sets "
                "WHERE work_version_id=? ORDER BY id",
                (work_version_id,),
            ),
            rows(
                "SELECT id,reference_set_id,ordinal,target_work_id,target_work_version_id,"
                "reference_json FROM reference_members ORDER BY id"
            ),
            rows(
                "SELECT id,reference_set_id,ordinal,raw_text,reference_json "
                "FROM unresolved_references ORDER BY id"
            ),
            rows(
                "SELECT id,revision,complete FROM tag_sets WHERE work_version_id=? ORDER BY id",
                (work_version_id,),
            ),
            rows("SELECT id,tag_set_id,name,evidence_json FROM tag_members ORDER BY id"),
            rows(
                "SELECT light_document_id,analysis_artifact_id,metadata_snapshot_id,"
                "reference_set_id,tag_set_id,identity_sha256 FROM completion_bundles "
                "WHERE work_version_id=?",
                (work_version_id,),
            ),
            rows(
                "SELECT 'metadata',content FROM metadata_fts WHERE work_version_id=? "
                "UNION ALL SELECT 'light',content FROM light_text_fts WHERE work_version_id=? "
                "UNION ALL SELECT 'analysis',content FROM analysis_fts "
                "WHERE work_version_id=? ORDER BY 1",
                (work_version_id, work_version_id, work_version_id),
            ),
            rows(
                "SELECT stage,code,reason,action,retryable FROM current_failures "
                "WHERE subject_id=? ORDER BY stage",
                (work_version_id,),
            ),
            rows(
                "SELECT started,result_json FROM batch_targets "
                "WHERE batch_run_id=? AND target_id=?",
                (batch_run_id, work_version_id),
            ),
            rows(
                "SELECT state FROM work_version_state_view WHERE work_version_id=?",
                (work_version_id,),
            ),
        )
