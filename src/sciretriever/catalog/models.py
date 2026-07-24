"""Internal SQLAlchemy Core schema for the SciRetriever catalog."""

from __future__ import annotations

from sqlalchemy import (
    CheckConstraint,
    Column,
    ForeignKey,
    ForeignKeyConstraint,
    Index,
    Integer,
    MetaData,
    String,
    Table,
    Text,
    UniqueConstraint,
    text,
)

from sciretriever.core.enums import (
    AssetIntentState,
    AssetRole,
    DomainRunStatus,
    PackageQuality,
    ProcessingStage,
)


metadata = MetaData(
    naming_convention={
        "ix": "ix_%(table_name)s_%(column_0_name)s",
        "uq": "uq_%(table_name)s_%(column_0_name)s",
        "ck": "ck_%(table_name)s_%(constraint_name)s",
        "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
        "pk": "pk_%(table_name)s",
    }
)

_RFC3339_DEFAULT = text("(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))")


def _values(values: tuple[str, ...]) -> str:
    return ", ".join(f"'{value}'" for value in values)


_ASSET_ROLES = tuple(value.value for value in AssetRole)
_ASSET_INTENT_STATES = tuple(value.value for value in AssetIntentState)
_DOMAIN_RUN_STATUSES = tuple(value.value for value in DomainRunStatus)
_PACKAGE_QUALITIES = tuple(value.value for value in PackageQuality)
_PROCESSING_STAGES = tuple(value.value for value in ProcessingStage)


def _uuid_check(column: str) -> str:
    return (
        f"length({column}) = 36 AND substr({column}, 9, 1) = '-' "
        f"AND substr({column}, 14, 1) = '-' AND substr({column}, 19, 1) = '-' "
        f"AND substr({column}, 24, 1) = '-' "
        f"AND substr({column}, 1, 8) NOT GLOB '*[^0-9a-f]*' "
        f"AND substr({column}, 10, 4) NOT GLOB '*[^0-9a-f]*' "
        f"AND substr({column}, 15, 4) NOT GLOB '*[^0-9a-f]*' "
        f"AND substr({column}, 20, 4) NOT GLOB '*[^0-9a-f]*' "
        f"AND substr({column}, 25, 12) NOT GLOB '*[^0-9a-f]*'"
    )


def _sha256_check(column: str, *, nullable: bool = False) -> str:
    check = (
        f"length({column}) = 64 AND {column} = lower({column}) "
        f"AND {column} NOT GLOB '*[^0-9a-f]*'"
    )
    return f"{column} IS NULL OR ({check})" if nullable else check


def _timestamp_check(column: str, *, nullable: bool = False) -> str:
    check = (
        f"length({column}) = 24 AND {column} GLOB "
        "'[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T"
        "[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'"
    )
    return f"{column} IS NULL OR ({check})" if nullable else check


def _json_check(column: str, *, nullable: bool = False) -> str:
    check = f"json_valid({column}) AND json({column}) = {column}"
    return f"{column} IS NULL OR ({check})" if nullable else check


def _id_column() -> Column[str]:
    return Column("id", String(36), primary_key=True)


def _created_at_column(name: str = "created_at") -> Column[str]:
    return Column(name, Text, nullable=False, server_default=_RFC3339_DEFAULT)


works = Table(
    "works",
    metadata,
    _id_column(),
    Column("status", Text, nullable=False, server_default="active"),
    Column("preferred_work_version_id", String(36)),
    Column("preferred_version_is_manual", Integer, nullable=False, server_default="0"),
    Column("needs_review", Integer, nullable=False, server_default="0"),
    Column("review_reason", Text),
    Column("merged_into_work_id", String(36), ForeignKey("works.id", ondelete="RESTRICT")),
    _created_at_column(),
    _created_at_column("updated_at"),
    CheckConstraint(_uuid_check("id"), name="id_uuid"),
    CheckConstraint("status IN ('active', 'review', 'merged')", name="status"),
    CheckConstraint("needs_review IN (0, 1)", name="needs_review_boolean"),
    CheckConstraint("preferred_version_is_manual IN (0, 1)", name="preferred_version_is_manual_boolean"),
    CheckConstraint("needs_review = 1 OR review_reason IS NULL", name="review_reason_state"),
    CheckConstraint(
        "(status = 'review' AND needs_review = 1) OR status <> 'review'",
        name="review_status",
    ),
    CheckConstraint(
        "(status = 'merged' AND merged_into_work_id IS NOT NULL) "
        "OR (status <> 'merged' AND merged_into_work_id IS NULL)",
        name="merged_target_state",
    ),
    CheckConstraint("merged_into_work_id IS NULL OR merged_into_work_id <> id", name="not_self_merged"),
    CheckConstraint(_timestamp_check("created_at"), name="created_at_rfc3339"),
    CheckConstraint(_timestamp_check("updated_at"), name="updated_at_rfc3339"),
)

publishers = Table(
    "publishers", metadata, _id_column(), Column("canonical_name", Text, nullable=False),
    Column("normalized_name", Text, nullable=False, unique=True),
    _created_at_column(), CheckConstraint(_uuid_check("id"), name="id_uuid"),
    CheckConstraint("length(trim(canonical_name)) > 0", name="canonical_name_not_blank"),
)
publisher_aliases = Table(
    "publisher_aliases", metadata, _id_column(),
    Column("publisher_id", String(36), ForeignKey("publishers.id", ondelete="CASCADE"), nullable=False),
    Column("alias", Text, nullable=False), Column("normalized_alias", Text, nullable=False, unique=True),
    _created_at_column(),
    CheckConstraint(_uuid_check("id"), name="id_uuid"),
    CheckConstraint("length(trim(alias)) > 0", name="alias_not_blank"),
)
venues = Table(
    "venues", metadata, _id_column(), Column("canonical_name", Text, nullable=False),
    Column("normalized_name", Text, nullable=False, unique=True),
    _created_at_column(), CheckConstraint(_uuid_check("id"), name="id_uuid"),
    CheckConstraint("length(trim(canonical_name)) > 0", name="canonical_name_not_blank"),
)
venue_aliases = Table(
    "venue_aliases", metadata, _id_column(),
    Column("venue_id", String(36), ForeignKey("venues.id", ondelete="CASCADE"), nullable=False),
    Column("alias", Text, nullable=False), Column("normalized_alias", Text, nullable=False, unique=True),
    _created_at_column(),
    CheckConstraint(_uuid_check("id"), name="id_uuid"),
    CheckConstraint("length(trim(alias)) > 0", name="alias_not_blank"),
)

work_versions = Table(
    "work_versions", metadata, _id_column(),
    Column("work_id", String(36), ForeignKey("works.id", ondelete="CASCADE"), nullable=False),
    Column("version_class", Text, nullable=False, server_default="unknown"),
    Column("normalized_title", Text, nullable=False), Column("title", Text, nullable=False),
    Column("abstract", Text), Column("language", Text), Column("work_type", Text),
    Column("publication_date", Text), Column("publication_year", Integer),
    Column("publisher_id", String(36), ForeignKey("publishers.id", ondelete="SET NULL")),
    Column("venue_id", String(36), ForeignKey("venues.id", ondelete="SET NULL")),
    Column("volume", Text), Column("issue", Text), Column("pages", Text),
    Column("article_number", Text), Column("open_access_status", Text),
    Column("provider_precedence", Integer), Column("stable_version_key", Text, nullable=False),
    Column("is_provisional", Integer, nullable=False, server_default="0"),
    _created_at_column(), _created_at_column("updated_at"),
    UniqueConstraint("work_id", "stable_version_key", name="work_stable_version"),
    CheckConstraint(_uuid_check("id"), name="id_uuid"), CheckConstraint(_uuid_check("work_id"), name="work_id_uuid"),
    CheckConstraint("version_class IN ('formal_publication', 'accepted_manuscript', 'preprint', 'unknown', 'other')", name="version_class"),
    CheckConstraint("publication_year IS NULL OR publication_year >= 0", name="publication_year"),
    CheckConstraint("length(trim(normalized_title)) > 0", name="normalized_title_not_blank"),
    CheckConstraint("length(trim(title)) > 0", name="title_not_blank"),
    CheckConstraint("length(trim(stable_version_key)) > 0", name="stable_version_key_not_blank"),
    CheckConstraint("is_provisional IN (0, 1)", name="is_provisional_boolean"),
)

# The circular preferred pointer is declared after both tables exist.
works.append_constraint(ForeignKeyConstraint([works.c.preferred_work_version_id], [work_versions.c.id], ondelete="SET NULL", name="fk_works_preferred_work_version_id_work_versions"))

work_version_identifiers = Table(
    "work_version_identifiers", metadata, _id_column(),
    Column("work_version_id", String(36), ForeignKey("work_versions.id", ondelete="CASCADE"), nullable=False),
    Column("namespace", Text, nullable=False), Column("value", Text, nullable=False), _created_at_column(),
    UniqueConstraint("namespace", "value", name="work_version_identifier_namespace_value"),
    CheckConstraint(_uuid_check("id"), name="id_uuid"),
    CheckConstraint("length(trim(namespace)) > 0", name="namespace_not_blank"),
    CheckConstraint("length(trim(value)) > 0", name="value_not_blank"),
)

metadata_observations = Table(
    "metadata_observations", metadata, _id_column(),
    Column("work_version_id", String(36), ForeignKey("work_versions.id", ondelete="CASCADE"), nullable=False),
    Column("provider", Text, nullable=False), Column("provider_record_id", Text, nullable=False),
    Column("field_name", Text, nullable=False), Column("value_json", Text, nullable=False),
    Column("provenance_json", Text, nullable=False), _created_at_column("observed_at"),
    UniqueConstraint("provider", "provider_record_id", "field_name", "value_json", name="provider_field_observation"),
    CheckConstraint(_uuid_check("id"), name="id_uuid"),
    CheckConstraint(_json_check("value_json"), name="value_json"),
    CheckConstraint(_json_check("provenance_json"), name="provenance_json"),
)

authors = Table(
    "authors", metadata, _id_column(), Column("display_name", Text, nullable=False),
    Column("normalized_name", Text, nullable=False), Column("orcid", Text, unique=True), _created_at_column(),
    CheckConstraint(_uuid_check("id"), name="id_uuid"),
    CheckConstraint("length(trim(display_name)) > 0", name="display_name_not_blank"),
    CheckConstraint("length(trim(normalized_name)) > 0", name="normalized_name_not_blank"),
)
authorships = Table(
    "authorships", metadata, _id_column(),
    Column("work_version_id", String(36), ForeignKey("work_versions.id", ondelete="CASCADE"), nullable=False),
    Column("author_id", String(36), ForeignKey("authors.id", ondelete="RESTRICT"), nullable=False),
    Column("position", Integer, nullable=False), Column("role", Text),
    Column("is_corresponding", Integer, nullable=False, server_default="0"), Column("affiliation", Text),
    _created_at_column(), UniqueConstraint("work_version_id", "position", name="version_author_position"),
    CheckConstraint(_uuid_check("id"), name="id_uuid"), CheckConstraint("position >= 0", name="position"),
    CheckConstraint("is_corresponding IN (0, 1)", name="is_corresponding_boolean"),
)

tags = Table(
    "tags", metadata, _id_column(), Column("canonical_name", Text, nullable=False),
    Column("normalized_name", Text, nullable=False, unique=True),
    Column("definition", Text), _created_at_column(), CheckConstraint(_uuid_check("id"), name="id_uuid"),
    CheckConstraint("length(trim(canonical_name)) > 0", name="canonical_name_not_blank"),
)
tag_aliases = Table(
    "tag_aliases", metadata, _id_column(),
    Column("tag_id", String(36), ForeignKey("tags.id", ondelete="CASCADE"), nullable=False),
    Column("alias", Text, nullable=False), Column("normalized_alias", Text, nullable=False, unique=True),
    Column("language", Text), _created_at_column(),
    CheckConstraint(_uuid_check("id"), name="id_uuid"), CheckConstraint("length(trim(alias)) > 0", name="alias_not_blank"),
)
manual_work_tags = Table(
    "manual_work_tags", metadata,
    Column("work_id", String(36), ForeignKey("works.id", ondelete="CASCADE"), primary_key=True),
    Column("tag_id", String(36), ForeignKey("tags.id", ondelete="CASCADE"), primary_key=True),
    _created_at_column("linked_at"),
)
generated_work_version_tags = Table(
    "generated_work_version_tags", metadata,
    Column("work_version_id", String(36), ForeignKey("work_versions.id", ondelete="CASCADE"), primary_key=True),
    Column("tag_id", String(36), ForeignKey("tags.id", ondelete="CASCADE"), primary_key=True),
    Column("source_artifact_id", String(36), ForeignKey("normalized_artifacts.id", ondelete="CASCADE"), primary_key=True),
    _created_at_column("linked_at"),
)

version_relations = Table(
    "version_relations", metadata, _id_column(),
    Column("source_work_version_id", String(36), ForeignKey("work_versions.id", ondelete="CASCADE"), nullable=False),
    Column("target_work_version_id", String(36), ForeignKey("work_versions.id", ondelete="CASCADE"), nullable=False),
    Column("relation_type", Text, nullable=False), Column("evidence_json", Text, nullable=False), _created_at_column(),
    UniqueConstraint("source_work_version_id", "target_work_version_id", "relation_type", name="version_relation"),
    CheckConstraint(_uuid_check("id"), name="id_uuid"),
    CheckConstraint("source_work_version_id <> target_work_version_id", name="different_versions"),
    CheckConstraint("length(trim(relation_type)) > 0", name="relation_type_not_blank"),
    CheckConstraint(_json_check("evidence_json"), name="evidence_json"),
    CheckConstraint(_timestamp_check("created_at"), name="created_at_rfc3339"),
)

identifiers = Table(
    "identifiers",
    metadata,
    _id_column(),
    Column("work_id", String(36), ForeignKey("works.id", ondelete="CASCADE"), nullable=False),
    Column("namespace", Text, nullable=False),
    Column("value", Text, nullable=False),
    _created_at_column(),
    UniqueConstraint("namespace", "value", name="identifier_namespace_value"),
    CheckConstraint(_uuid_check("id"), name="id_uuid"),
    CheckConstraint(_uuid_check("work_id"), name="work_id_uuid"),
    CheckConstraint("length(trim(namespace)) > 0", name="namespace_not_blank"),
    CheckConstraint("length(trim(value)) > 0", name="value_not_blank"),
    CheckConstraint(_timestamp_check("created_at"), name="created_at_rfc3339"),
)

identity_reviews = Table(
    "identity_reviews",
    metadata,
    _id_column(),
    Column("state", Text, nullable=False, server_default="pending"),
    Column("identifiers_json", Text, nullable=False),
    Column("candidate_work_ids_json", Text, nullable=False),
    Column("reason", Text, nullable=False),
    Column("decision", Text),
    _created_at_column(),
    _created_at_column("updated_at"),
    Column("resolved_at", Text),
    CheckConstraint(_uuid_check("id"), name="id_uuid"),
    CheckConstraint("state IN ('pending', 'resolved')", name="state"),
    CheckConstraint(_json_check("identifiers_json"), name="identifiers_json"),
    CheckConstraint(_json_check("candidate_work_ids_json"), name="candidate_work_ids_json"),
    CheckConstraint("length(trim(reason)) > 0", name="reason_not_blank"),
    CheckConstraint(
        "(state = 'pending' AND decision IS NULL AND resolved_at IS NULL) "
        "OR (state = 'resolved' AND length(trim(decision)) > 0 AND resolved_at IS NOT NULL)",
        name="decision_state",
    ),
    CheckConstraint(_timestamp_check("created_at"), name="created_at_rfc3339"),
    CheckConstraint(_timestamp_check("updated_at"), name="updated_at_rfc3339"),
    CheckConstraint(_timestamp_check("resolved_at", nullable=True), name="resolved_at_rfc3339"),
)

metadata_labels = Table(
    "metadata_labels",
    metadata,
    _id_column(),
    Column("work_version_id", String(36), ForeignKey("work_versions.id", ondelete="CASCADE"), nullable=False),
    Column("taxonomy", Text, nullable=False),
    Column("taxonomy_version", Text, nullable=False),
    Column("input_sha256", String(64), nullable=False),
    Column("label", Text, nullable=False),
    Column("needs_review", Integer, nullable=False, server_default="0"),
    _created_at_column(),
    UniqueConstraint(
        "work_version_id",
        "taxonomy",
        "taxonomy_version",
        "input_sha256",
        "label",
        name="reusable_metadata_label",
    ),
    CheckConstraint(_uuid_check("id"), name="id_uuid"),
    CheckConstraint(_uuid_check("work_version_id"), name="work_version_id_uuid"),
    CheckConstraint(_sha256_check("input_sha256"), name="input_sha256"),
    CheckConstraint("length(trim(taxonomy)) > 0", name="taxonomy_not_blank"),
    CheckConstraint("length(trim(taxonomy_version)) > 0", name="taxonomy_version_not_blank"),
    CheckConstraint("length(trim(label)) > 0", name="label_not_blank"),
    CheckConstraint("needs_review IN (0, 1)", name="needs_review_boolean"),
    CheckConstraint(_timestamp_check("created_at"), name="created_at_rfc3339"),
)

Index(
    "ix_metadata_labels_reusable_key",
    metadata_labels.c.work_version_id,
    metadata_labels.c.taxonomy,
    metadata_labels.c.taxonomy_version,
    metadata_labels.c.input_sha256,
)

raw_assets = Table(
    "raw_assets",
    metadata,
    _id_column(),
    Column("sha256", String(64), nullable=False, unique=True),
    Column("storage_path", Text, nullable=False, unique=True),
    Column("media_type", Text, nullable=False),
    Column("format", Text, nullable=False),
    Column("byte_size", Integer, nullable=False),
    Column("provenance_json", Text, nullable=False),
    _created_at_column(),
    CheckConstraint(_uuid_check("id"), name="id_uuid"),
    CheckConstraint(_sha256_check("sha256"), name="sha256"),
    CheckConstraint("storage_path = 'raw/' || substr(sha256, 1, 2) || '/' || sha256", name="storage_path"),
    CheckConstraint(
        "media_type = lower(media_type) "
        "AND substr(media_type, 1, 1) GLOB '[a-z0-9]' "
        "AND substr(media_type, instr(media_type, '/') + 1, 1) GLOB '[a-z0-9]' "
        "AND media_type NOT GLOB '*[^a-z0-9!#$&^_.+/-]*' "
        "AND length(media_type) - length(replace(media_type, '/', '')) = 1",
        name="media_type_lowercase_mime",
    ),
    CheckConstraint(
        "substr(format, 1, 1) GLOB '[a-z]' AND format NOT GLOB '*[^a-z0-9_]*'",
        name="format_token",
    ),
    CheckConstraint("byte_size > 0", name="byte_size"),
    CheckConstraint(_json_check("provenance_json"), name="provenance_json"),
    CheckConstraint(_timestamp_check("created_at"), name="created_at_rfc3339"),
)

work_version_assets = Table(
    "work_version_assets",
    metadata,
    Column("work_version_id", String(36), ForeignKey("work_versions.id", ondelete="CASCADE"), primary_key=True),
    Column(
        "raw_asset_id",
        String(36),
        ForeignKey("raw_assets.id", ondelete="RESTRICT"),
        primary_key=True,
    ),
    Column("asset_role", Text, primary_key=True),
    _created_at_column("linked_at"),
    CheckConstraint(_uuid_check("work_version_id"), name="work_version_id_uuid"),
    CheckConstraint(_uuid_check("raw_asset_id"), name="raw_asset_id_uuid"),
    CheckConstraint(f"asset_role IN ({_values(_ASSET_ROLES)})", name="asset_role"),
    CheckConstraint(_timestamp_check("linked_at"), name="linked_at_rfc3339"),
)

asset_intents = Table(
    "asset_intents",
    metadata,
    _id_column(),
    Column("work_version_id", String(36), ForeignKey("work_versions.id", ondelete="CASCADE"), nullable=False),
    Column("raw_asset_id", String(36), ForeignKey("raw_assets.id", ondelete="SET NULL")),
    Column("asset_role", Text, nullable=False),
    Column("state", Text, nullable=False, server_default="pending"),
    Column("temporary_path", Text, nullable=False),
    Column("storage_path", Text, nullable=False),
    Column("expected_sha256", String(64), nullable=False),
    Column("media_type", Text, nullable=False),
    Column("format", Text, nullable=False),
    Column("expected_byte_size", Integer, nullable=False),
    Column("provenance_json", Text, nullable=False),
    _created_at_column(),
    _created_at_column("updated_at"),
    UniqueConstraint("work_version_id", "asset_role", "expected_sha256", name="version_role_asset_intent"),
    CheckConstraint(_uuid_check("id"), name="id_uuid"),
    CheckConstraint(_uuid_check("work_version_id"), name="work_version_id_uuid"),
    CheckConstraint(f"asset_role IN ({_values(_ASSET_ROLES)})", name="asset_role"),
    CheckConstraint(f"state IN ({_values(_ASSET_INTENT_STATES)})", name="state"),
    CheckConstraint("temporary_path = 'staging/' || id || '.part'", name="temporary_path"),
    CheckConstraint(
        "storage_path = 'raw/' || substr(expected_sha256, 1, 2) || '/' || expected_sha256",
        name="storage_path",
    ),
    CheckConstraint(_sha256_check("expected_sha256"), name="expected_sha256"),
    CheckConstraint(
        "media_type = lower(media_type) "
        "AND substr(media_type, 1, 1) GLOB '[a-z0-9]' "
        "AND substr(media_type, instr(media_type, '/') + 1, 1) GLOB '[a-z0-9]' "
        "AND media_type NOT GLOB '*[^a-z0-9!#$&^_.+/-]*' "
        "AND length(media_type) - length(replace(media_type, '/', '')) = 1",
        name="media_type_lowercase_mime",
    ),
    CheckConstraint(
        "substr(format, 1, 1) GLOB '[a-z]' AND format NOT GLOB '*[^a-z0-9_]*'",
        name="format_token",
    ),
    CheckConstraint("expected_byte_size > 0", name="expected_byte_size"),
    CheckConstraint(_json_check("provenance_json"), name="provenance_json"),
    CheckConstraint(
        "(state IN ('pending', 'abandoned') AND raw_asset_id IS NULL) OR "
        "(state IN ('published', 'finalized') AND raw_asset_id IS NOT NULL)",
        name="raw_asset_state",
    ),
    CheckConstraint(_timestamp_check("created_at"), name="created_at_rfc3339"),
    CheckConstraint(_timestamp_check("updated_at"), name="updated_at_rfc3339"),
)

normalized_artifacts = Table(
    "normalized_artifacts",
    metadata,
    _id_column(),
    Column("work_version_id", String(36), ForeignKey("work_versions.id", ondelete="CASCADE"), nullable=False),
    Column("raw_asset_id", String(36), ForeignKey("raw_assets.id", ondelete="RESTRICT"), nullable=False),
    Column("kind", Text, nullable=False),
    Column("schema_version", Text, nullable=False),
    Column("storage_path", Text, nullable=False, unique=True),
    Column("sha256", String(64), nullable=False),
    Column("media_type", Text, nullable=False),
    Column("byte_size", Integer, nullable=False),
    Column("provenance_json", Text, nullable=False),
    _created_at_column(),
    UniqueConstraint(
        "raw_asset_id", "kind", "schema_version", "sha256", name="normalized_derivation"
    ),
    CheckConstraint(_uuid_check("id"), name="id_uuid"),
    CheckConstraint(_uuid_check("work_version_id"), name="work_version_id_uuid"),
    CheckConstraint(_uuid_check("raw_asset_id"), name="raw_asset_id_uuid"),
    CheckConstraint("length(trim(kind)) > 0", name="kind_not_blank"),
    CheckConstraint("length(trim(schema_version)) > 0", name="schema_version_not_blank"),
    CheckConstraint("length(trim(storage_path)) > 0", name="storage_path_not_blank"),
    CheckConstraint(_sha256_check("sha256"), name="sha256"),
    CheckConstraint(
        "length(trim(media_type)) > 0 AND media_type = lower(media_type)",
        name="media_type_lowercase",
    ),
    CheckConstraint("byte_size > 0", name="byte_size"),
    CheckConstraint(_json_check("provenance_json"), name="provenance_json"),
    CheckConstraint(_timestamp_check("created_at"), name="created_at_rfc3339"),
)

light_structures = Table(
    "light_structures",
    metadata,
    _id_column(),
    Column("work_version_id", String(36), ForeignKey("work_versions.id", ondelete="CASCADE"), nullable=False),
    Column(
        "normalized_artifact_id",
        String(36),
        ForeignKey("normalized_artifacts.id", ondelete="CASCADE"),
        nullable=False,
    ),
    Column("kind", Text, nullable=False),
    Column("schema_version", Text, nullable=False),
    Column("input_sha256", String(64), nullable=False),
    Column("content_json", Text, nullable=False),
    _created_at_column(),
    UniqueConstraint(
        "work_version_id", "kind", "schema_version", "input_sha256", name="light_structure_input"
    ),
    CheckConstraint(_uuid_check("id"), name="id_uuid"),
    CheckConstraint(_uuid_check("work_version_id"), name="work_version_id_uuid"),
    CheckConstraint(_uuid_check("normalized_artifact_id"), name="normalized_artifact_id_uuid"),
    CheckConstraint("kind IN ('summary', 'tags')", name="kind"),
    CheckConstraint("length(trim(schema_version)) > 0", name="schema_version_not_blank"),
    CheckConstraint(_sha256_check("input_sha256"), name="input_sha256"),
    CheckConstraint(_json_check("content_json"), name="content_json"),
    CheckConstraint(_timestamp_check("created_at"), name="created_at_rfc3339"),
)

version_references = Table(
    "version_references",
    metadata,
    _id_column(),
    Column("citing_work_version_id", String(36), ForeignKey("work_versions.id", ondelete="CASCADE"), nullable=False),
    Column("cited_work_id", String(36), ForeignKey("works.id", ondelete="SET NULL")),
    Column("reference_order", Integer, nullable=False),
    Column("raw_reference", Text, nullable=False),
    Column("cited_namespace", Text), Column("cited_value", Text),
    Column(
        "source_artifact_id",
        String(36),
        ForeignKey("normalized_artifacts.id", ondelete="CASCADE"),
        nullable=True,
    ),
    Column("locator_json", Text),
    _created_at_column(),
    CheckConstraint(_uuid_check("id"), name="id_uuid"),
    CheckConstraint(_uuid_check("citing_work_version_id"), name="citing_work_version_id_uuid"),
    CheckConstraint(_uuid_check("source_artifact_id"), name="source_artifact_id_uuid"),
    CheckConstraint(
        "cited_work_id IS NOT NULL OR length(trim(raw_reference)) > 0",
        name="cited_reference",
    ),
    CheckConstraint(
        "(cited_namespace IS NULL AND cited_value IS NULL) "
        "OR (length(trim(cited_namespace)) > 0 AND length(trim(cited_value)) > 0)",
        name="cited_identifier",
    ),
    CheckConstraint(_json_check("locator_json", nullable=True), name="locator_json"),
    CheckConstraint(_timestamp_check("created_at"), name="created_at_rfc3339"),
)

Index(
    "uq_version_references_resolved",
    version_references.c.citing_work_version_id,
    version_references.c.cited_work_id,
    version_references.c.reference_order,
    unique=True,
    sqlite_where=version_references.c.cited_work_id.is_not(None),
)

Index(
    "uq_version_references_unresolved",
    version_references.c.citing_work_version_id,
    version_references.c.reference_order,
    version_references.c.source_artifact_id,
    unique=True,
    sqlite_where=version_references.c.cited_work_id.is_(None),
)

processing_runs = Table(
    "processing_runs",
    metadata,
    _id_column(),
    Column("work_version_id", String(36), ForeignKey("work_versions.id", ondelete="CASCADE"), nullable=False),
    Column("stage", Text, nullable=False),
    Column("state", Text, nullable=False, server_default="pending"),
    Column("input_raw_asset_id", String(36), ForeignKey("raw_assets.id", ondelete="RESTRICT")),
    Column(
        "input_artifact_id",
        String(36),
        ForeignKey("normalized_artifacts.id", ondelete="RESTRICT"),
    ),
    Column(
        "output_artifact_id",
        String(36),
        ForeignKey("normalized_artifacts.id", ondelete="SET NULL"),
    ),
    Column("details_json", Text),
    _created_at_column("started_at"),
    Column("finished_at", Text),
    CheckConstraint(_uuid_check("id"), name="id_uuid"),
    CheckConstraint(_uuid_check("work_version_id"), name="work_version_id_uuid"),
    CheckConstraint(f"stage IN ({_values(_PROCESSING_STAGES)})", name="stage"),
    CheckConstraint("state IN ('pending', 'active', 'succeeded', 'failed', 'cancelled')", name="state"),
    CheckConstraint(_json_check("details_json", nullable=True), name="details_json"),
    CheckConstraint(_timestamp_check("started_at"), name="started_at_rfc3339"),
    CheckConstraint(_timestamp_check("finished_at", nullable=True), name="finished_at_rfc3339"),
    CheckConstraint("finished_at IS NULL OR state IN ('succeeded', 'failed', 'cancelled')", name="finished_state"),
)

events = Table(
    "events",
    metadata,
    _id_column(),
    Column("subject_type", Text, nullable=False),
    Column("subject_id", String(36), nullable=False),
    Column("event_type", Text, nullable=False),
    Column("details_json", Text),
    _created_at_column("occurred_at"),
    CheckConstraint(_uuid_check("id"), name="id_uuid"),
    CheckConstraint(_uuid_check("subject_id"), name="subject_id_uuid"),
    CheckConstraint("length(trim(subject_type)) > 0", name="subject_type_not_blank"),
    CheckConstraint("length(trim(event_type)) > 0", name="event_type_not_blank"),
    CheckConstraint(_json_check("details_json", nullable=True), name="details_json"),
    CheckConstraint(_timestamp_check("occurred_at"), name="occurred_at_rfc3339"),
)

acquisition_diagnostics = Table(
    "acquisition_diagnostics",
    metadata,
    _id_column(),
    Column("work_version_id", String(36), ForeignKey("work_versions.id", ondelete="CASCADE"), nullable=False),
    Column("asset_role", Text, nullable=False),
    Column("outcome", Text, nullable=False),
    Column("details_json", Text, nullable=False),
    _created_at_column("occurred_at"),
    CheckConstraint(_uuid_check("id"), name="id_uuid"),
    CheckConstraint(f"asset_role IN ({_values(_ASSET_ROLES)})", name="asset_role"),
    CheckConstraint("outcome IN ('succeeded', 'failed')", name="outcome"),
    CheckConstraint(_json_check("details_json"), name="details_json"),
    CheckConstraint(_timestamp_check("occurred_at"), name="occurred_at_rfc3339"),
)

failures = Table(
    "failures",
    metadata,
    _id_column(),
    Column("work_version_id", String(36), ForeignKey("work_versions.id", ondelete="CASCADE")),
    Column("processing_run_id", String(36), ForeignKey("processing_runs.id", ondelete="CASCADE")),
    Column("category", Text, nullable=False),
    Column("message", Text, nullable=False),
    Column("retryable", Integer, nullable=False, server_default="0"),
    Column("details_json", Text),
    _created_at_column("occurred_at"),
    CheckConstraint(_uuid_check("id"), name="id_uuid"),
    CheckConstraint(
        "work_version_id IS NOT NULL OR processing_run_id IS NOT NULL",
        name="context",
    ),
    CheckConstraint("length(trim(category)) > 0", name="category_not_blank"),
    CheckConstraint("length(trim(message)) > 0", name="message_not_blank"),
    CheckConstraint("retryable IN (0, 1)", name="retryable_boolean"),
    CheckConstraint(_json_check("details_json", nullable=True), name="details_json"),
    CheckConstraint(_timestamp_check("occurred_at"), name="occurred_at_rfc3339"),
)

package_versions = Table(
    "package_versions",
    metadata,
    _id_column(),
    Column("work_version_id", String(36), ForeignKey("work_versions.id", ondelete="CASCADE"), nullable=False),
    Column("processing_run_id", String(36), ForeignKey("processing_runs.id", ondelete="RESTRICT")),
    Column("version", Integer, nullable=False),
    Column("schema_version", Text, nullable=False),
    Column("quality", Text, nullable=False),
    Column("storage_path", Text, nullable=False, unique=True),
    Column("sha256", String(64), nullable=False),
    _created_at_column("published_at"),
    UniqueConstraint("work_version_id", "version", name="work_version_package_version"),
    CheckConstraint(_uuid_check("id"), name="id_uuid"),
    CheckConstraint(_uuid_check("work_version_id"), name="work_version_id_uuid"),
    CheckConstraint("version > 0", name="version_positive"),
    CheckConstraint("length(trim(schema_version)) > 0", name="schema_version_not_blank"),
    CheckConstraint(f"quality IN ({_values(_PACKAGE_QUALITIES)})", name="quality"),
    CheckConstraint("length(trim(storage_path)) > 0", name="storage_path_not_blank"),
    CheckConstraint(_sha256_check("sha256"), name="sha256"),
    CheckConstraint(_timestamp_check("published_at"), name="published_at_rfc3339"),
)

domain_runs = Table(
    "domain_runs",
    metadata,
    _id_column(),
    Column(
        "package_version_id",
        String(36),
        ForeignKey("package_versions.id", ondelete="CASCADE"),
        nullable=False,
    ),
    Column("status", Text, nullable=False, server_default=DomainRunStatus.PENDING.value),
    Column("output_pointer", Text),
    Column("output_sha256", String(64)),
    _created_at_column(),
    _created_at_column("updated_at"),
    CheckConstraint(_uuid_check("id"), name="id_uuid"),
    CheckConstraint(_uuid_check("package_version_id"), name="package_version_id_uuid"),
    CheckConstraint(f"status IN ({_values(_DOMAIN_RUN_STATUSES)})", name="status"),
    CheckConstraint(_sha256_check("output_sha256", nullable=True), name="output_sha256"),
    CheckConstraint(
        "(status = 'succeeded' AND output_pointer IS NOT NULL "
        "AND length(trim(output_pointer)) > 0 AND output_sha256 IS NOT NULL) "
        "OR (status <> 'succeeded' AND output_pointer IS NULL AND output_sha256 IS NULL)",
        name="output_state",
    ),
    CheckConstraint(_timestamp_check("created_at"), name="created_at_rfc3339"),
    CheckConstraint(_timestamp_check("updated_at"), name="updated_at_rfc3339"),
)
