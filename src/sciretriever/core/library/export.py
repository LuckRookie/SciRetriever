from __future__ import annotations

from typing import Final

from sciretriever.model.library import ExportCandidate, ExportPreparedRecord
from sciretriever.model.primitives import VersionRole, WorkId
from sciretriever.model.record import ExportOmission, ImportedBibliographicRecord

_VERSION_PRIORITY: Final[dict[VersionRole, int]] = {
    VersionRole.FORMAL: 0,
    VersionRole.ACCEPTED_MANUSCRIPT: 1,
    VersionRole.PREPRINT: 2,
    VersionRole.OTHER: 3,
}


def export_eligible(candidate: ExportCandidate) -> bool:
    """Return whether the candidate has the required current unified title."""
    return bool(candidate.detail.metadata.values.title.strip())


def select_export_candidates(
    candidates: tuple[ExportCandidate, ...], all_versions: bool
) -> tuple[ExportCandidate, ...]:
    """Select one preferred version per work unless all versions were requested."""
    ordered = tuple(
        sorted(
            candidates,
            key=lambda item: (
                str(item.work_id),
                _VERSION_PRIORITY[item.version_role],
                str(item.work_version_id),
            ),
        )
    )
    if all_versions:
        return ordered
    selected: dict[WorkId, ExportCandidate] = {}
    for candidate in ordered:
        selected.setdefault(candidate.work_id, candidate)
    return tuple(selected.values())


def prepare_export_record(candidate: ExportCandidate) -> ExportPreparedRecord:
    """Map one current Library detail to a neutral bibliography record."""
    values = candidate.detail.metadata.values
    keywords = (
        candidate.detail.analysis.proposal.keywords_and_tags.keywords
        if candidate.detail.analysis is not None
        else candidate.detail.metadata.keywords
    )
    tags = (
        tuple(item.name for item in candidate.detail.tags.items)
        if candidate.detail.tags.complete
        else ()
    )
    references = (
        tuple(item.raw_text for item in candidate.detail.references.items)
        if candidate.detail.references.complete
        else ()
    )
    institutions = tuple(
        dict.fromkeys(
            affiliation for author in values.authors for affiliation in author.affiliations
        )
    )
    omissions: list[ExportOmission] = []
    if values.abstract is None:
        omissions.append(ExportOmission(field="abstract", reason="not-available"))
    if not keywords:
        omissions.append(ExportOmission(field="keywords", reason="not-available"))
    if not candidate.detail.tags.complete:
        omissions.append(ExportOmission(field="tags", reason="not-complete"))
    if not candidate.detail.references.complete:
        omissions.append(ExportOmission(field="references", reason="not-complete"))
    if not institutions:
        omissions.append(ExportOmission(field="institutions", reason="not-available"))
    return ExportPreparedRecord(
        work_id=candidate.work_id,
        work_version_id=candidate.work_version_id,
        record=ImportedBibliographicRecord(
            title=values.title,
            authors=tuple(author.display_name for author in values.authors),
            identifiers=values.identifiers,
            abstract=values.abstract,
            keywords=keywords,
            tags=tags,
            references=references,
            institutions=institutions,
            year=values.publication_year,
            venue=values.venue,
            volume=values.volume,
            issue=values.issue,
            pages=values.pages,
            item_type=values.document_type,
            language=values.language,
        ),
        omissions=tuple(omissions),
    )


__all__ = (
    "export_eligible",
    "prepare_export_record",
    "select_export_candidates",
)
