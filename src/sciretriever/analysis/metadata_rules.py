"""Deterministic protection rules for the first Analysis metadata stage.

The language model may decide whether parsed content is usable and may propose
one complete :class:`LiteratureMetadata`, but it is not authoritative over
already accepted bibliographic facts.  This module therefore owns the local,
provider-independent checks that keep reliable input values and require
source-explicit evidence for every PDF-derived addition.
"""

from __future__ import annotations

import json
import re
import unicodedata
from typing import Final, Literal, TypeAlias

from sciretriever.model.literature import Affiliation, Author, Identifier
from sciretriever.model.metadata import LiteratureMetadata, MetadataObservation
from sciretriever.model.primitives import Sha256, SourceKind, sha256_digest

MetadataRuleKind: TypeAlias = Literal["input", "proposal", "alignment"]

_PROTECTED_SCALARS: Final[tuple[str, ...]] = (
    "title",
    "abstract",
    "publication_date",
    "publication_year",
    "document_type",
    "language",
    "venue",
    "volume",
    "issue",
    "pages",
)
_SINGLETON_IDENTIFIER_NAMESPACES: Final[frozenset[str]] = frozenset(
    {"doi", "arxiv", "pmid", "pmcid"}
)
_LEGAL_SUFFIXES: Final[tuple[tuple[tuple[str, ...], str], ...]] = (
    (("limited", "liability", "company"), "llc"),
    (("public", "limited", "company"), "plc"),
    (("incorporated",), "inc"),
    (("corporation",), "corp"),
    (("company",), "company"),
    (("limited",), "limited"),
    (("gmbh",), "gmbh"),
    (("sarl",), "sarl"),
    (("corp",), "corp"),
    (("inc",), "inc"),
    (("ltd",), "limited"),
    (("llc",), "llc"),
    (("plc",), "plc"),
    (("pte",), "pte"),
    (("pty",), "pty"),
    (("sas",), "sas"),
    (("ag",), "ag"),
    (("bv",), "bv"),
    (("nv",), "nv"),
    (("sa",), "sa"),
    (("co",), "company"),
    (("l", "l", "c"), "llc"),
    (("p", "l", "c"), "plc"),
    (("b", "v"), "bv"),
    (("n", "v"), "nv"),
    (("s", "a"), "sa"),
)
_MARKER = re.compile(
    r"\[([0-9A-Za-z]+)\]|\^([0-9]+)|"
    r"<\s*sup\s*>\s*([0-9A-Za-z]+)\s*<\s*/\s*sup\s*>"
)
_NON_WORD = re.compile(r"[^\w]+", re.UNICODE)


class MetadataRuleViolation(ValueError):
    """One fixed, redacted rejection from deterministic metadata rules."""

    _MESSAGE = "metadata analysis rule rejected the candidate"

    def __init__(self, kind: MetadataRuleKind) -> None:
        if kind not in {"input", "proposal", "alignment"}:
            raise ValueError("unsupported metadata rule violation kind")
        super().__init__(self._MESSAGE)
        self.kind = kind

    def __repr__(self) -> str:
        return "<MetadataRuleViolation>"


def metadata_input_sha256(metadata: LiteratureMetadata) -> Sha256:
    """Hash complete metadata with the Literature canonical JSON algorithm.

    Analysis deliberately keeps this small implementation private to its
    boundary instead of importing a Literature implementation module.  The
    shared golden test prevents the two implementations from drifting.
    """

    if not isinstance(metadata, LiteratureMetadata):
        raise TypeError("metadata must be LiteratureMetadata")
    payload = metadata.model_dump(mode="json")
    encoded = json.dumps(
        payload,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    return sha256_digest(encoded)


def validate_user_observations(
    initial: LiteratureMetadata,
    observations: tuple[MetadataObservation, ...],
) -> None:
    """Validate only the local user-observation source contract.

    Literature owns observation ordering, conflict handling, and projection.
    Analysis protects the resulting unified ``initial`` value and must not
    reverse-engineer that projection by requiring every source observation to
    equal it independently.
    """

    if not isinstance(initial, LiteratureMetadata) or type(observations) is not tuple:
        raise MetadataRuleViolation("input")
    for observation in observations:
        if not isinstance(observation, MetadataObservation):
            raise MetadataRuleViolation("input")
        provenance = observation.provenance
        if (
            provenance.source_kind is not SourceKind.USER
            or provenance.source_name != "bibliographic-import"
            or provenance.source_record_id is not None
            or provenance.input_sha256 is not None
            or provenance.parameters_sha256 is not None
        ):
            raise MetadataRuleViolation("input")


def validate_metadata_proposal(
    initial: LiteratureMetadata,
    proposal: LiteratureMetadata,
    parser_markdown: str,
) -> None:
    """Protect reliable metadata and require explicit parsed-PDF evidence."""

    if (
        not isinstance(initial, LiteratureMetadata)
        or not isinstance(proposal, LiteratureMetadata)
        or type(parser_markdown) is not str
    ):
        raise MetadataRuleViolation("proposal")

    markdown_key = _evidence_key(parser_markdown)
    markdown_lines = tuple(
        line for raw_line in parser_markdown.splitlines() if (line := _evidence_key(raw_line))
    )

    for field_name in _PROTECTED_SCALARS:
        before = getattr(initial, field_name)
        after = getattr(proposal, field_name)
        if before is not None:
            if after != before:
                raise MetadataRuleViolation("proposal")
        elif after is not None and not _contains_evidence(markdown_key, after):
            raise MetadataRuleViolation("alignment")

    _validate_publisher(initial.publisher, proposal.publisher, markdown_key)
    _validate_authors(initial.authors, proposal.authors, markdown_key, markdown_lines)
    _validate_identifiers(initial.identifiers, proposal.identifiers, markdown_key)
    _validate_keywords(proposal.keywords, markdown_key)

    if proposal.title is None and not any(
        identifier.namespace == "doi" for identifier in proposal.identifiers
    ):
        raise MetadataRuleViolation("proposal")


def _validate_publisher(
    before: str | None,
    after: str | None,
    markdown_key: str,
) -> None:
    if before is None:
        if after is not None and not _contains_evidence(markdown_key, after):
            raise MetadataRuleViolation("alignment")
        return
    if after is None:
        raise MetadataRuleViolation("proposal")
    if after != before and not _same_publisher_entity(before, after):
        raise MetadataRuleViolation("proposal")


def _same_publisher_entity(left: str, right: str) -> bool:
    left_stem, left_suffix = _publisher_identity(left)
    right_stem, right_suffix = _publisher_identity(right)
    return (
        bool(left_stem)
        and left_stem == right_stem
        and (left_suffix is None or right_suffix is None or left_suffix == right_suffix)
    )


def _publisher_identity(value: str) -> tuple[tuple[str, ...], str | None]:
    normalized = unicodedata.normalize("NFKC", value).casefold()
    tokens = tuple(token for token in _NON_WORD.split(normalized) if token)
    remaining = tokens
    suffix_category: str | None = None
    changed = True
    while changed and remaining:
        changed = False
        for suffix, category in _LEGAL_SUFFIXES:
            if len(remaining) >= len(suffix) and remaining[-len(suffix) :] == suffix:
                remaining = remaining[: -len(suffix)]
                if suffix_category is None:
                    suffix_category = category
                changed = True
                break
    return remaining, suffix_category


def _validate_authors(
    before: tuple[Author, ...],
    after: tuple[Author, ...],
    markdown_key: str,
    markdown_lines: tuple[str, ...],
) -> None:
    if before:
        if len(after) != len(before):
            raise MetadataRuleViolation("proposal")
        for existing, proposed in zip(before, after, strict=True):
            _validate_existing_author(
                existing,
                proposed,
                markdown_key,
                markdown_lines,
                total_authors=len(after),
            )
        return

    for author in after:
        _validate_new_author(
            author,
            markdown_key,
            markdown_lines,
            total_authors=len(after),
        )


def _validate_existing_author(
    before: Author,
    after: Author,
    markdown_key: str,
    markdown_lines: tuple[str, ...],
    *,
    total_authors: int,
) -> None:
    if before.kind is not after.kind or before.display_name != after.display_name:
        raise MetadataRuleViolation("proposal")

    explicit_name_parts = _has_explicit_family_given(after)
    _validate_optional_author_value(
        before.given_name,
        after.given_name,
        markdown_key,
        label="given name",
        explicitly_present=explicit_name_parts,
    )
    _validate_optional_author_value(
        before.family_name,
        after.family_name,
        markdown_key,
        label="family name",
        explicitly_present=explicit_name_parts,
    )
    _validate_optional_author_value(
        before.orcid,
        after.orcid,
        markdown_key,
        label=None,
        explicitly_present=False,
    )

    if len(after.affiliations) < len(before.affiliations):
        raise MetadataRuleViolation("proposal")
    for existing, proposed in zip(
        before.affiliations,
        after.affiliations[: len(before.affiliations)],
        strict=True,
    ):
        if existing.name != proposed.name:
            raise MetadataRuleViolation("proposal")
        if existing.ror is not None and existing.ror != proposed.ror:
            raise MetadataRuleViolation("proposal")
        if existing.ror is None and proposed.ror is not None:
            _require_affiliation_ror(proposed, markdown_key)

    for affiliation in after.affiliations[len(before.affiliations) :]:
        _require_new_affiliation(
            after,
            affiliation,
            markdown_key,
            markdown_lines,
            total_authors=total_authors,
        )


def _validate_new_author(
    author: Author,
    markdown_key: str,
    markdown_lines: tuple[str, ...],
    *,
    total_authors: int,
) -> None:
    if not _contains_evidence(markdown_key, author.display_name):
        raise MetadataRuleViolation("alignment")
    explicit_name_parts = _has_explicit_family_given(author)
    if author.given_name is not None and not (
        explicit_name_parts
        or _contains_labeled_evidence(markdown_key, "given name", author.given_name)
    ):
        raise MetadataRuleViolation("alignment")
    if author.family_name is not None and not (
        explicit_name_parts
        or _contains_labeled_evidence(markdown_key, "family name", author.family_name)
    ):
        raise MetadataRuleViolation("alignment")
    if author.orcid is not None and not _contains_evidence(markdown_key, author.orcid):
        raise MetadataRuleViolation("alignment")
    for affiliation in author.affiliations:
        _require_new_affiliation(
            author,
            affiliation,
            markdown_key,
            markdown_lines,
            total_authors=total_authors,
        )


def _validate_optional_author_value(
    before: str | None,
    after: str | None,
    markdown_key: str,
    *,
    label: str | None,
    explicitly_present: bool,
) -> None:
    if before is not None:
        if after != before:
            raise MetadataRuleViolation("proposal")
        return
    if after is None:
        return
    aligned = explicitly_present or (
        _contains_evidence(markdown_key, after)
        if label is None
        else _contains_labeled_evidence(markdown_key, label, after)
    )
    if not aligned:
        raise MetadataRuleViolation("alignment")


def _has_explicit_family_given(author: Author) -> bool:
    if author.given_name is None or author.family_name is None:
        return False
    display_name = _evidence_key(author.display_name)
    given_name = _evidence_key(author.given_name)
    family_name = _evidence_key(author.family_name)
    return display_name == f"{family_name}, {given_name}"


def _require_affiliation_ror(affiliation: Affiliation, markdown_key: str) -> None:
    if affiliation.ror is not None and not _contains_evidence(markdown_key, affiliation.ror):
        raise MetadataRuleViolation("alignment")


def _require_new_affiliation(
    author: Author,
    affiliation: Affiliation,
    markdown_key: str,
    markdown_lines: tuple[str, ...],
    *,
    total_authors: int,
) -> None:
    if not _contains_evidence(markdown_key, affiliation.name):
        raise MetadataRuleViolation("alignment")
    _require_affiliation_ror(affiliation, markdown_key)
    if not _affiliation_is_mapped(
        author,
        affiliation,
        markdown_lines,
        total_authors=total_authors,
    ):
        raise MetadataRuleViolation("alignment")


def _affiliation_is_mapped(
    author: Author,
    affiliation: Affiliation,
    markdown_lines: tuple[str, ...],
    *,
    total_authors: int,
) -> bool:
    author_key = _evidence_key(author.display_name)
    affiliation_key = _evidence_key(affiliation.name)
    author_lines = tuple(line for line in markdown_lines if author_key in line)
    affiliation_lines = tuple(line for line in markdown_lines if affiliation_key in line)
    if not author_lines or not affiliation_lines:
        return False
    if any(author_key in line and affiliation_key in line for line in markdown_lines):
        return True
    author_markers = {marker for line in author_lines for marker in _line_markers(line)}
    affiliation_markers = {marker for line in affiliation_lines for marker in _line_markers(line)}
    if author_markers & affiliation_markers:
        return True
    # With exactly one author, an explicitly named affiliation cannot be
    # ambiguously assigned to somebody else.  Multiple authors require a
    # same-line or marker mapping and therefore cannot become all-to-all.
    return total_authors == 1


def _line_markers(value: str) -> frozenset[str]:
    markers: set[str] = set()
    for match in _MARKER.finditer(value):
        marker = next((group for group in match.groups() if group is not None), None)
        if marker is not None:
            markers.add(marker.casefold())
    return frozenset(markers)


def _validate_identifiers(
    before: tuple[Identifier, ...],
    after: tuple[Identifier, ...],
    markdown_key: str,
) -> None:
    if len(after) < len(before) or after[: len(before)] != before:
        raise MetadataRuleViolation("proposal")

    seen = {(identifier.namespace, identifier.value) for identifier in before}
    namespace_values: dict[str, set[str]] = {}
    for identifier in before:
        namespace_values.setdefault(identifier.namespace, set()).add(identifier.value)

    for identifier in after[len(before) :]:
        key = (identifier.namespace, identifier.value)
        if key in seen:
            raise MetadataRuleViolation("proposal")
        existing_values = namespace_values.setdefault(identifier.namespace, set())
        if (
            identifier.namespace in _SINGLETON_IDENTIFIER_NAMESPACES
            and existing_values
            and identifier.value not in existing_values
        ):
            raise MetadataRuleViolation("proposal")
        if not _contains_evidence(markdown_key, identifier.value):
            raise MetadataRuleViolation("alignment")
        seen.add(key)
        existing_values.add(identifier.value)


def _validate_keywords(keywords: tuple[str, ...], markdown_key: str) -> None:
    seen: set[str] = set()
    for keyword in keywords:
        key = _evidence_key(keyword)
        if key in seen or not _contains_evidence(markdown_key, keyword):
            raise MetadataRuleViolation("alignment")
        seen.add(key)


def _contains_labeled_evidence(markdown_key: str, label: str, value: str) -> bool:
    label_key = re.escape(_evidence_key(label))
    value_key = re.escape(_evidence_key(value))
    pattern = rf"(?<!\w){label_key}\s*:\s*{value_key}(?!\w)"
    return re.search(pattern, markdown_key) is not None


def _contains_evidence(markdown_key: str, value: object) -> bool:
    candidate = _evidence_key(str(value))
    if not candidate:
        return False
    return re.search(rf"(?<!\w){re.escape(candidate)}(?!\w)", markdown_key) is not None


def _evidence_key(value: str) -> str:
    normalized = unicodedata.normalize("NFKC", value).casefold()
    return " ".join(normalized.split())


__all__ = ("metadata_input_sha256",)
