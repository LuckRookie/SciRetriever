"""Pure Literature rules at the bibliographic exchange boundary.

The external codecs and user-file publication flow belong to Entry.  This
module only turns an already codec-normalized :class:`BibliographicRecord`
into the ordinary immutable user observation used by Literature, and selects
already accepted Literature values for export.  It creates no identity, clock,
UUID, run, report, persistent operation record, or output path.
"""

from __future__ import annotations

from collections.abc import Iterable

from sciretriever.model.literature import Literature, MetaLiterature, VersionRole
from sciretriever.model.metadata import MetadataObservation
from sciretriever.model.primitives import ObservationId, SourceKind
from sciretriever.model.provenance import Provenance
from sciretriever.model.record import BibliographicRecord


class LiteratureExchangeError(ValueError):
    """Stable failure for a malformed input to a pure exchange rule."""

    _DEFAULT_MESSAGE = "literature exchange rule failed"

    def __init__(self, _message: object | None = None) -> None:
        super().__init__(self._DEFAULT_MESSAGE)


class BibliographicObservationError(LiteratureExchangeError):
    """A record cannot form the fixed bibliographic-import observation."""

    _DEFAULT_MESSAGE = "bibliographic observation is invalid"


class ExportSelectionError(LiteratureExchangeError):
    """The supplied MetaLiterature member closure is not safe to export."""

    _DEFAULT_MESSAGE = "bibliographic export selection is invalid"


_VERSION_ROLE_ORDER = {
    VersionRole.PUBLISHED: 0,
    VersionRole.ACCEPTED_MANUSCRIPT: 1,
    VersionRole.PREPRINT: 2,
    VersionRole.OTHER: 3,
}


def observation_from_bibliographic_record(
    record: BibliographicRecord,
    *,
    observation_id: ObservationId,
    provenance: Provenance,
) -> MetadataObservation:
    """Build one ordinary user/bibliographic-import MetadataObservation.

    The caller owns generation of ``observation_id`` and every provenance fact,
    including the observation time.  This rule deliberately does not perform
    Literature identity matching, source precedence, deduplication, or
    acceptance; those remain in the existing Literature admission flow.
    """

    if not isinstance(record, BibliographicRecord):
        raise BibliographicObservationError()
    if not isinstance(observation_id, ObservationId):
        raise BibliographicObservationError()
    if not isinstance(provenance, Provenance) or not _is_bibliographic_import(provenance):
        raise BibliographicObservationError()
    try:
        return MetadataObservation(
            observation_id=observation_id,
            provenance=provenance,
            metadata=record.metadata,
        )
    except (TypeError, ValueError):
        raise BibliographicObservationError() from None


def select_export_literatures(
    meta_literature: MetaLiterature,
    members: Iterable[Literature],
    *,
    all_versions: bool = False,
) -> tuple[Literature, ...]:
    """Select already accepted Literature values for bibliographic export.

    Default export uses the deterministic representative: fixed VersionRole
    precedence followed by LiteratureId.  Explicit all-version export uses
    that same order.  Every selected Literature must still meet Literature's
    minimum accepted-metadata rule, but PDF, ParserResult, LiteratureContent,
    and status are not export prerequisites.

    ``members`` must be the complete member closure supplied by the L7 read
    context.  Completeness is a caller precondition because a raw iterable
    cannot prove that an otherwise valid non-representative member was
    omitted.  This rule does reject empty, duplicated, foreign, or internally
    inconsistent closures rather than guessing around them.
    """

    if not isinstance(meta_literature, MetaLiterature) or type(all_versions) is not bool:
        raise ExportSelectionError()
    values = _members(members)
    if not values:
        raise ExportSelectionError()
    member_ids = tuple(item.literature_id for item in values)
    if len(member_ids) != len(set(member_ids)):
        raise ExportSelectionError()
    if any(item.meta_literature_id != meta_literature.meta_literature_id for item in values):
        raise ExportSelectionError()
    ordered = tuple(
        sorted(
            values,
            key=lambda item: (_VERSION_ROLE_ORDER[item.version_role], str(item.literature_id)),
        )
    )
    representative = ordered[0]
    if representative.literature_id != meta_literature.representative_literature_id:
        raise ExportSelectionError()
    selected = ordered if all_versions else (representative,)
    if any(not _has_minimum_accepted_metadata(item) for item in selected):
        raise ExportSelectionError()
    return selected


def _is_bibliographic_import(provenance: Provenance) -> bool:
    return (
        provenance.source_kind is SourceKind.USER
        and provenance.source_name == "bibliographic-import"
        and provenance.source_record_id is None
        and provenance.input_sha256 is None
        and provenance.parameters_sha256 is None
    )


def _members(values: Iterable[Literature]) -> tuple[Literature, ...]:
    if isinstance(values, (str, bytes)):
        raise ExportSelectionError()
    try:
        result = tuple(values)
    except Exception:
        raise ExportSelectionError() from None
    if any(not isinstance(item, Literature) for item in result):
        raise ExportSelectionError()
    return result


def _has_minimum_accepted_metadata(literature: Literature) -> bool:
    metadata = literature.metadata
    return metadata.title is not None or any(
        identifier.namespace == "doi" for identifier in metadata.identifiers
    )


__all__ = (
    "BibliographicObservationError",
    "ExportSelectionError",
    "LiteratureExchangeError",
    "observation_from_bibliographic_record",
    "select_export_literatures",
)
