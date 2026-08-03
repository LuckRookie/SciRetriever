from __future__ import annotations

import json
import sqlite3

from sciretriever.model.analysis import AnalysisProposalV1, UnifiedMetadataValues
from sciretriever.model.canonical_json import (
    CanonicalJsonObject,
    CanonicalJsonValue,
    canonical_json_bytes,
    parse_canonical_json,
)
from sciretriever.model.documents import LightDocumentV1, ReferenceView, SourceLocator
from sciretriever.model.library_views import (
    AnalysisView,
    LightDocumentView,
    MetadataView,
)
from sciretriever.model.literature import Author, Identifier
from sciretriever.model.primitives import AssetId, Sha256, WorkId, WorkVersionId


def json_value(payload: str) -> CanonicalJsonValue:
    return parse_canonical_json(payload)


def json_output(payload: str) -> CanonicalJsonObject:
    return json.loads(canonical_json_bytes(json_value(payload)))


def _metadata(payload: str) -> tuple[UnifiedMetadataValues, tuple[str, ...]]:
    value = json.loads(payload)
    author_values = value.get("authors", ())
    authors: list[Author] = []
    for author in author_values:
        if isinstance(author, str):
            authors.append(
                Author(
                    display_name=author,
                    family_name=None,
                    given_name=None,
                    orcid=None,
                    affiliations=(),
                )
            )
        else:
            authors.append(
                Author(
                    display_name=author["display_name"],
                    family_name=author.get("family_name"),
                    given_name=author.get("given_name"),
                    orcid=author.get("orcid"),
                    affiliations=tuple(author.get("affiliations", ())),
                )
            )
    identifiers = tuple(
        Identifier(namespace=item["namespace"], value=item["value"])
        for item in value.get("identifiers", ())
    )
    keyword_values = value.get("keywords", ())
    if not isinstance(keyword_values, (list, tuple)) or any(
        not isinstance(item, str) for item in keyword_values
    ):
        raise sqlite3.DatabaseError("metadata keywords must be an array of text")
    return (
        UnifiedMetadataValues(
            title=value["title"],
            authors=tuple(authors),
            abstract=value.get("abstract"),
            publication_date=value.get("publication_date"),
            publication_year=value.get("publication_year", value.get("year")),
            document_type=value.get("document_type", value.get("item_type")),
            language=value.get("language"),
            venue=value.get("venue"),
            publisher=value.get("publisher"),
            volume=value.get("volume"),
            issue=value.get("issue"),
            pages=value.get("pages"),
            article_number=value.get("article_number"),
            open_access_status=value.get("open_access_status"),
            identifiers=identifiers,
        ),
        tuple(keyword_values),
    )


def metadata_view(row: tuple[int, str, str, str]) -> MetadataView:
    revision, digest, values_json, _provenance_json = row
    values, keywords = _metadata(values_json)
    return MetadataView(
        revision=revision,
        sha256=Sha256(digest),
        values=values,
        keywords=keywords,
        provenance=(),
    )


def light_view(row: tuple[str, str, str, str] | None) -> LightDocumentView | None:
    if row is None:
        return None
    artifact_id, digest, document_json, _provenance_json = row
    return LightDocumentView(
        artifact_id=AssetId(artifact_id),
        sha256=Sha256(digest),
        document=LightDocumentV1.model_validate_json(document_json),
        provenance=(),
    )


def analysis_view(row: tuple[str, str, str, str, str] | None) -> AnalysisView | None:
    if row is None:
        return None
    artifact_id, digest, input_digest, proposal_json, _provenance_json = row
    return AnalysisView(
        artifact_id=AssetId(artifact_id),
        sha256=Sha256(digest),
        provider="unknown",
        model="unknown",
        input_sha256=Sha256(input_digest),
        proposal=AnalysisProposalV1.model_validate_json(proposal_json),
        provenance=(),
    )


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
        asset_id=AssetId(_text(fields["asset_id"], "asset_id")),
        page_start=_integer(fields["page_start"], "page_start"),
        page_end=_integer(fields["page_end"], "page_end"),
        block_id=_text(fields["block_id"], "block_id"),
        char_start=_integer(fields["char_start"], "char_start"),
        char_end=_integer(fields["char_end"], "char_end"),
    )


def reference(payload: str) -> ReferenceView:
    fields = _mapping(json_value(payload), "ReferenceView")
    raw_authors = fields["authors"]
    raw_identifiers = fields["identifiers"]
    raw_evidence = fields["evidence"]
    if (
        not isinstance(raw_authors, tuple)
        or not isinstance(raw_identifiers, tuple)
        or not isinstance(raw_evidence, tuple)
    ):
        raise sqlite3.DatabaseError("ReferenceView arrays are invalid")
    authors = tuple(
        Author(
            display_name=_text(item_fields["display_name"], "display_name"),
            family_name=_optional_text(item_fields["family_name"], "family_name"),
            given_name=_optional_text(item_fields["given_name"], "given_name"),
            orcid=_optional_text(item_fields["orcid"], "orcid"),
            affiliations=(
                tuple(_text(value, "affiliation") for value in item_fields["affiliations"])
                if isinstance(item_fields["affiliations"], tuple)
                else ()
            ),
        )
        for item_fields in (_mapping(item, "author") for item in raw_authors)
    )
    identifiers = tuple(
        Identifier(
            namespace=_text(item_fields["namespace"], "namespace"),
            value=_text(item_fields["value"], "value"),
        )
        for item_fields in (_mapping(item, "identifier") for item in raw_identifiers)
    )
    year = fields["publication_year"]
    if year is not None and (not isinstance(year, int) or isinstance(year, bool)):
        raise sqlite3.DatabaseError("publication_year must be an integer or null")
    resolved_work_id = _optional_text(fields["resolved_work_id"], "resolved_work_id")
    resolved_work_version_id = _optional_text(
        fields["resolved_work_version_id"], "resolved_work_version_id"
    )
    return ReferenceView(
        reference_id=_text(fields["reference_id"], "reference_id"),
        raw_text=_text(fields["raw_text"], "raw_text"),
        title=_optional_text(fields["title"], "title"),
        authors=authors,
        publication_year=year,
        source=_optional_text(fields["source"], "source"),
        identifiers=identifiers,
        resolved_work_id=None if resolved_work_id is None else WorkId(resolved_work_id),
        resolved_work_version_id=None
        if resolved_work_version_id is None
        else WorkVersionId(resolved_work_version_id),
        evidence=tuple(_locator(item) for item in raw_evidence),
    )


__all__ = (
    "analysis_view",
    "json_value",
    "json_output",
    "light_view",
    "metadata_view",
    "reference",
)
