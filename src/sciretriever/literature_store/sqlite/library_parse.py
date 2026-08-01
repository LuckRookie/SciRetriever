from __future__ import annotations

import json
import sqlite3

from sciretriever.interoperability.api import (
    AnalysisView, AuthorView, LightDocumentView, MetadataView, ReferenceView,
    UnifiedMetadataValues,
)
from sciretriever.kernel import (
    AssetId, CanonicalJsonObject, CanonicalJsonValue, Identifier, SourceLocator,
    parse_canonical_json,
)


def json_value(payload: str) -> CanonicalJsonValue:
    return parse_canonical_json(payload)


def _metadata(payload: str) -> UnifiedMetadataValues:
    value = json.loads(payload)
    author_values = value.get("authors", ())
    authors: list[AuthorView] = []
    for author in author_values:
        if isinstance(author, str):
            authors.append(AuthorView(author, None, None, None, ()))
        else:
            authors.append(AuthorView(
                author["display_name"], author.get("family_name"), author.get("given_name"),
                author.get("orcid"), tuple(author.get("affiliations", ())),
            ))
    identifiers = tuple(Identifier(item["namespace"], item["value"]) for item in value.get("identifiers", ()))
    return UnifiedMetadataValues(
        value["title"], tuple(authors), value.get("abstract"), value.get("publication_date"),
        value.get("publication_year", value.get("year")), value.get("document_type", value.get("item_type")),
        value.get("language"), value.get("venue"), value.get("publisher"), value.get("volume"),
        value.get("issue"), value.get("pages"), value.get("article_number"),
        value.get("open_access_status"), identifiers,
    )


def metadata_view(row: tuple[int, str, str, str]) -> MetadataView:
    revision, digest, values_json, _provenance_json = row
    return MetadataView(revision, digest, _metadata(values_json), ())


def light_view(row: tuple[str, str, str, str] | None) -> LightDocumentView | None:
    if row is None:
        return None
    artifact_id, digest, document_json, _provenance_json = row
    return LightDocumentView(artifact_id, digest, json_value(document_json), ())


def analysis_view(row: tuple[str, str, str, str, str] | None) -> AnalysisView | None:
    if row is None:
        return None
    artifact_id, digest, input_digest, proposal_json, _provenance_json = row
    return AnalysisView(artifact_id, digest, "unknown", "unknown", input_digest, json_value(proposal_json), ())


def _mapping(value: CanonicalJsonValue, field: str) -> dict[str, CanonicalJsonValue]:
    if not isinstance(value, CanonicalJsonObject):
        raise sqlite3.DatabaseError(f"{field} must be an object")
    return dict(value.entries)


def _text(value: CanonicalJsonValue, field: str) -> str:
    if not isinstance(value, str):
        raise sqlite3.DatabaseError(f"{field} must be text")
    return value


def _optional_text(value: CanonicalJsonValue, field: str) -> str | None:
    return None if value is None else _text(value, field)


def _integer(value: CanonicalJsonValue, field: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool):
        raise sqlite3.DatabaseError(f"{field} must be an integer")
    return value


def _locator(value: CanonicalJsonValue) -> SourceLocator:
    fields = _mapping(value, "reference evidence")
    return SourceLocator(
        AssetId(_text(fields["asset_id"], "asset_id")),
        _integer(fields["page_start"], "page_start"),
        _integer(fields["page_end"], "page_end"),
        _text(fields["block_id"], "block_id"),
        _integer(fields["char_start"], "char_start"),
        _integer(fields["char_end"], "char_end"),
    )


def reference(payload: str) -> ReferenceView:
    fields = _mapping(json_value(payload), "ReferenceView")
    raw_authors = fields["authors"]
    raw_identifiers = fields["identifiers"]
    raw_evidence = fields["evidence"]
    if not isinstance(raw_authors, tuple) or not isinstance(raw_identifiers, tuple) or not isinstance(raw_evidence, tuple):
        raise sqlite3.DatabaseError("ReferenceView arrays are invalid")
    authors = tuple(AuthorView(
        _text(item_fields["display_name"], "display_name"),
        _optional_text(item_fields["family_name"], "family_name"),
        _optional_text(item_fields["given_name"], "given_name"),
        _optional_text(item_fields["orcid"], "orcid"),
        tuple(_text(value, "affiliation") for value in item_fields["affiliations"])
        if isinstance(item_fields["affiliations"], tuple) else (),
    ) for item_fields in (_mapping(item, "author") for item in raw_authors))
    identifiers = tuple(Identifier(
        _text(item_fields["namespace"], "namespace"), _text(item_fields["value"], "value"),
    ) for item_fields in (_mapping(item, "identifier") for item in raw_identifiers))
    year = fields["publication_year"]
    if year is not None and (not isinstance(year, int) or isinstance(year, bool)):
        raise sqlite3.DatabaseError("publication_year must be an integer or null")
    return ReferenceView(
        _text(fields["reference_id"], "reference_id"), _text(fields["raw_text"], "raw_text"),
        _optional_text(fields["title"], "title"), authors, year,
        _optional_text(fields["source"], "source"), identifiers,
        _optional_text(fields["resolved_work_id"], "resolved_work_id"),
        _optional_text(fields["resolved_work_version_id"], "resolved_work_version_id"),
        tuple(_locator(item) for item in raw_evidence),
    )


def extension_fields(payload: str) -> tuple[str, str | None, str | None, CanonicalJsonValue]:
    value = json_value(payload)
    if not isinstance(value, CanonicalJsonObject):
        return "1", None, None, value
    fields = dict(value.entries)
    schema, artifact, digest = fields.get("schema_version", "1"), fields.get("artifact_id"), fields.get("sha256")
    return (
        schema if isinstance(schema, str) else "1",
        artifact if isinstance(artifact, str) else None,
        digest if isinstance(digest, str) else None,
        fields.get("value", value),
    )


__all__ = ("analysis_view", "extension_fields", "json_value", "light_view", "metadata_view", "reference")
