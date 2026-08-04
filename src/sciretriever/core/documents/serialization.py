from __future__ import annotations

import json

from typing_extensions import assert_never

from sciretriever.model import documents
from sciretriever.model.canonical_json import JsonOutput
from sciretriever.model.sources import Provenance


def _locator(value: documents.SourceLocator) -> JsonOutput:
    return {
        "asset_id": str(value.asset_id),
        "block_id": value.block_id,
        "char_end": value.char_end,
        "char_start": value.char_start,
        "page_end": value.page_end,
        "page_start": value.page_start,
    }


def _evidence(value: documents.EvidenceText) -> JsonOutput:
    return {"text": value.text, "evidence": [_locator(item) for item in value.evidence]}


def _json(value: JsonOutput) -> JsonOutput:
    return json.loads(json.dumps(value))


def _block(value: documents.Block) -> JsonOutput:
    match value:
        case documents.ParagraphBlock(kind=kind, block_id=block_id, text=text, evidence=evidence):
            return _json(
                {
                    "kind": kind,
                    "block_id": block_id,
                    "text": text,
                    "evidence": [_locator(item) for item in evidence],
                }
            )
        case documents.ListBlock(kind=kind, block_id=block_id, ordered=ordered, items=items):
            return _json(
                {
                    "kind": kind,
                    "block_id": block_id,
                    "ordered": ordered,
                    "items": [_evidence(item) for item in items],
                }
            )
        case documents.TableBlock(
            kind=kind,
            block_id=block_id,
            caption=caption,
            columns=columns,
            rows=rows,
            evidence=evidence,
        ):
            return _json(
                {
                    "kind": kind,
                    "block_id": block_id,
                    "caption": None if caption is None else _evidence(caption),
                    "columns": list(columns),
                    "rows": [list(row) for row in rows],
                    "evidence": [_locator(item) for item in evidence],
                }
            )
        case documents.FormulaBlock(
            kind=kind, block_id=block_id, text=text, label=label, evidence=evidence
        ):
            return _json(
                {
                    "kind": kind,
                    "block_id": block_id,
                    "text": text,
                    "label": label,
                    "evidence": [_locator(item) for item in evidence],
                }
            )
        case documents.FigureCaptionBlock(
            kind=kind, block_id=block_id, text=text, evidence=evidence
        ):
            return _json(
                {
                    "kind": kind,
                    "block_id": block_id,
                    "text": text,
                    "evidence": [_locator(item) for item in evidence],
                }
            )
        case unreachable:
            assert_never(unreachable)


def _section(value: documents.Section) -> JsonOutput:
    return _json(
        {
            "section_id": value.section_id,
            "level": value.level,
            "title": None if value.title is None else _evidence(value.title),
            "blocks": [_block(item) for item in value.blocks],
            "children": [_section(item) for item in value.children],
        }
    )


def _provenance(value: Provenance) -> JsonOutput:
    return json.loads(value.model_dump_json())


def reference_to_json(value: documents.ReferenceView) -> str:
    payload = {
        "reference_id": value.reference_id,
        "raw_text": value.raw_text,
        "title": value.title,
        "authors": [
            {
                "display_name": item.display_name,
                "family_name": item.family_name,
                "given_name": item.given_name,
                "orcid": item.orcid,
                "affiliations": sorted(item.affiliations, key=lambda text: (text.casefold(), text)),
            }
            for item in value.authors
        ],
        "publication_year": value.publication_year,
        "source": value.source,
        "identifiers": [
            {"namespace": item.namespace, "value": item.value}
            for item in sorted(value.identifiers, key=lambda item: (item.namespace, item.value))
        ],
        "resolved_work_id": None if value.resolved_work_id is None else str(value.resolved_work_id),
        "resolved_work_version_id": (
            None if value.resolved_work_version_id is None else str(value.resolved_work_version_id)
        ),
        "evidence": [_locator(item) for item in value.evidence],
    }
    return json.dumps(
        payload, ensure_ascii=True, allow_nan=False, sort_keys=True, separators=(",", ":")
    )


def document_value(value: documents.LightDocumentV1) -> JsonOutput:
    return _json(
        {
            "schema_version": value.schema_version,
            "title": None if value.title is None else _evidence(value.title),
            "abstract": [_evidence(item) for item in value.abstract],
            "sections": [_section(item) for item in value.sections],
            "references": [json.loads(reference_to_json(item)) for item in value.references],
            "provenance": [
                _provenance(item)
                for item in sorted(value.provenance, key=lambda item: str(item.provenance_id))
            ],
        }
    )


def document_bytes(value: documents.LightDocumentV1) -> bytes:
    return json.dumps(
        document_value(value),
        ensure_ascii=True,
        allow_nan=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("ascii")


__all__ = ("document_bytes", "document_value", "reference_to_json")
