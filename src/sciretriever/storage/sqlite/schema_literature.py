"""Relationship DDL owned by the Literature storage adapter.

The tables in this module deliberately contain scalar columns, ordered child
tables, and explicit foreign keys.  They are exported as a DDL manifest for
``schema.py``; callers must never execute this module independently because the
shared schema marker and fingerprint are owned by the Catalog bootstrap.
"""

from __future__ import annotations

from typing import Final

_META_LITERATURES_DDL: Final[str] = (
    "CREATE TABLE meta_literatures("
    "meta_literature_id TEXT NOT NULL PRIMARY KEY CHECK(length(trim(meta_literature_id))>0),"
    "representative_literature_id TEXT NOT NULL,"
    "FOREIGN KEY(meta_literature_id,representative_literature_id) "
    "REFERENCES literatures(meta_literature_id,literature_id) "
    "ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED"
    ") STRICT"
)

_LITERATURES_DDL: Final[str] = (
    "CREATE TABLE literatures("
    "literature_id TEXT NOT NULL PRIMARY KEY CHECK(length(trim(literature_id))>0),"
    "meta_literature_id TEXT NOT NULL,"
    "version_role TEXT NOT NULL CHECK(version_role IN "
    "('published','accepted-manuscript','preprint','other')),"
    "UNIQUE(meta_literature_id,literature_id),"
    "FOREIGN KEY(meta_literature_id) REFERENCES meta_literatures(meta_literature_id) "
    "ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED"
    ") STRICT"
)

_LITERATURE_METADATA_DDL: Final[str] = (
    "CREATE TABLE literature_metadata("
    "literature_id TEXT NOT NULL PRIMARY KEY,"
    "metadata_revision INTEGER NOT NULL CHECK(typeof(metadata_revision)='integer' AND "
    "metadata_revision>=1),"
    "metadata_sha256 TEXT NOT NULL CHECK(length(metadata_sha256)=64 AND "
    "metadata_sha256=lower(metadata_sha256) AND metadata_sha256 NOT GLOB '*[^0-9a-f]*'),"
    "title TEXT,abstract TEXT,publication_date TEXT,publication_year INTEGER,"
    "document_type TEXT,language TEXT,venue TEXT,publisher TEXT,volume TEXT,issue TEXT,pages TEXT,"
    "UNIQUE(literature_id,metadata_revision,metadata_sha256),"
    "FOREIGN KEY(literature_id) REFERENCES literatures(literature_id) ON DELETE CASCADE,"
    "CHECK(publication_year IS NULL OR "
    "(typeof(publication_year)='integer' AND publication_year BETWEEN 1 AND 9999))"
    ") STRICT"
)

_LITERATURE_METADATA_AUTHORS_DDL: Final[str] = (
    "CREATE TABLE literature_metadata_authors("
    "literature_id TEXT NOT NULL,ordinal INTEGER NOT NULL "
    "CHECK(typeof(ordinal)='integer' AND ordinal>=0),"
    "kind TEXT NOT NULL CHECK(kind IN ('person','organization','unknown')),"
    "display_name TEXT NOT NULL CHECK(length(trim(display_name))>0),"
    "given_name TEXT,family_name TEXT,orcid TEXT,"
    "PRIMARY KEY(literature_id,ordinal),"
    "FOREIGN KEY(literature_id) REFERENCES literature_metadata(literature_id) ON DELETE CASCADE"
    ") STRICT"
)

_LITERATURE_METADATA_AUTHOR_AFFILIATIONS_DDL: Final[str] = (
    "CREATE TABLE literature_metadata_author_affiliations("
    "literature_id TEXT NOT NULL,author_ordinal INTEGER NOT NULL CHECK(author_ordinal>=0),"
    "affiliation_ordinal INTEGER NOT NULL CHECK(affiliation_ordinal>=0),"
    "name TEXT NOT NULL CHECK(length(trim(name))>0),ror TEXT,"
    "PRIMARY KEY(literature_id,author_ordinal,affiliation_ordinal),"
    "FOREIGN KEY(literature_id,author_ordinal) REFERENCES "
    "literature_metadata_authors(literature_id,ordinal) ON DELETE CASCADE"
    ") STRICT"
)

_LITERATURE_METADATA_IDENTIFIERS_DDL: Final[str] = (
    "CREATE TABLE literature_metadata_identifiers("
    "literature_id TEXT NOT NULL,ordinal INTEGER NOT NULL CHECK(ordinal>=0),"
    "namespace TEXT NOT NULL CHECK(length(trim(namespace))>0),"
    "value TEXT NOT NULL CHECK(length(trim(value))>0),"
    "PRIMARY KEY(literature_id,namespace,value),UNIQUE(literature_id,ordinal),"
    "FOREIGN KEY(literature_id) REFERENCES literature_metadata(literature_id) ON DELETE CASCADE"
    ") STRICT"
)

_LITERATURE_METADATA_KEYWORDS_DDL: Final[str] = (
    "CREATE TABLE literature_metadata_keywords("
    "literature_id TEXT NOT NULL,ordinal INTEGER NOT NULL CHECK(ordinal>=0),"
    "keyword TEXT NOT NULL CHECK(length(trim(keyword))>0),"
    "PRIMARY KEY(literature_id,keyword),UNIQUE(literature_id,ordinal),"
    "FOREIGN KEY(literature_id) REFERENCES literature_metadata(literature_id) ON DELETE CASCADE"
    ") STRICT"
)

_LITERATURE_FALLBACK_IDENTITY_INDEXES_DDL: Final[str] = (
    "CREATE TABLE literature_fallback_identity_indexes("
    "literature_id TEXT NOT NULL PRIMARY KEY,"
    "fallback_identity_sha256 TEXT NOT NULL "
    "CHECK(length(fallback_identity_sha256)=64 AND "
    "fallback_identity_sha256=lower(fallback_identity_sha256) AND "
    "fallback_identity_sha256 NOT GLOB '*[^0-9a-f]*'),"
    "FOREIGN KEY(literature_id) REFERENCES literatures(literature_id) ON DELETE CASCADE"
    ") STRICT"
)

_METADATA_OBSERVATIONS_DDL: Final[str] = (
    "CREATE TABLE metadata_observations("
    "observation_id TEXT NOT NULL PRIMARY KEY CHECK(length(trim(observation_id))>0),"
    "provenance_id TEXT NOT NULL,version_role TEXT,reference_count INTEGER,cited_by_count INTEGER,"
    "title TEXT,abstract TEXT,publication_date TEXT,publication_year INTEGER,document_type TEXT,"
    "language TEXT,venue TEXT,publisher TEXT,volume TEXT,issue TEXT,pages TEXT,"
    "CHECK(version_role IS NULL OR version_role IN "
    "('published','accepted-manuscript','preprint','other')),"
    "CHECK(reference_count IS NULL OR "
    "(typeof(reference_count)='integer' AND reference_count>=0)),"
    "CHECK(cited_by_count IS NULL OR "
    "(typeof(cited_by_count)='integer' AND cited_by_count>=0)),"
    "CHECK(publication_year IS NULL OR "
    "(typeof(publication_year)='integer' AND publication_year BETWEEN 1 AND 9999)),"
    "FOREIGN KEY(provenance_id) REFERENCES provenances(provenance_id) ON DELETE RESTRICT"
    ") STRICT"
)

_METADATA_OBSERVATION_AUTHORS_DDL: Final[str] = (
    "CREATE TABLE metadata_observation_authors("
    "observation_id TEXT NOT NULL,ordinal INTEGER NOT NULL CHECK(ordinal>=0),"
    "kind TEXT NOT NULL CHECK(kind IN ('person','organization','unknown')),"
    "display_name TEXT NOT NULL CHECK(length(trim(display_name))>0),"
    "given_name TEXT,family_name TEXT,orcid TEXT,"
    "PRIMARY KEY(observation_id,ordinal),"
    "FOREIGN KEY(observation_id) REFERENCES metadata_observations(observation_id) ON DELETE CASCADE"
    ") STRICT"
)

_METADATA_OBSERVATION_AUTHOR_AFFILIATIONS_DDL: Final[str] = (
    "CREATE TABLE metadata_observation_author_affiliations("
    "observation_id TEXT NOT NULL,author_ordinal INTEGER NOT NULL CHECK(author_ordinal>=0),"
    "affiliation_ordinal INTEGER NOT NULL CHECK(affiliation_ordinal>=0),"
    "name TEXT NOT NULL CHECK(length(trim(name))>0),ror TEXT,"
    "PRIMARY KEY(observation_id,author_ordinal,affiliation_ordinal),"
    "FOREIGN KEY(observation_id,author_ordinal) REFERENCES "
    "metadata_observation_authors(observation_id,ordinal) ON DELETE CASCADE"
    ") STRICT"
)

_METADATA_OBSERVATION_IDENTIFIERS_DDL: Final[str] = (
    "CREATE TABLE metadata_observation_identifiers("
    "observation_id TEXT NOT NULL,ordinal INTEGER NOT NULL CHECK(ordinal>=0),"
    "namespace TEXT NOT NULL CHECK(length(trim(namespace))>0),"
    "value TEXT NOT NULL CHECK(length(trim(value))>0),"
    "PRIMARY KEY(observation_id,namespace,value),UNIQUE(observation_id,ordinal),"
    "FOREIGN KEY(observation_id) REFERENCES metadata_observations(observation_id) ON DELETE CASCADE"
    ") STRICT"
)

_METADATA_OBSERVATION_KEYWORDS_DDL: Final[str] = (
    "CREATE TABLE metadata_observation_keywords("
    "observation_id TEXT NOT NULL,ordinal INTEGER NOT NULL CHECK(ordinal>=0),"
    "keyword TEXT NOT NULL CHECK(length(trim(keyword))>0),"
    "PRIMARY KEY(observation_id,keyword),UNIQUE(observation_id,ordinal),"
    "FOREIGN KEY(observation_id) REFERENCES metadata_observations(observation_id) ON DELETE CASCADE"
    ") STRICT"
)

_METADATA_OBSERVATION_DECLARED_KEYWORDS_DDL: Final[str] = (
    "CREATE TABLE metadata_observation_declared_keywords("
    "observation_id TEXT NOT NULL,ordinal INTEGER NOT NULL CHECK(ordinal>=0),"
    "keyword TEXT NOT NULL CHECK(length(trim(keyword))>0),"
    "PRIMARY KEY(observation_id,ordinal),"
    "FOREIGN KEY(observation_id) REFERENCES metadata_observations(observation_id) ON DELETE CASCADE"
    ") STRICT"
)

_METADATA_OBSERVATION_REFERENCE_TEXTS_DDL: Final[str] = (
    "CREATE TABLE metadata_observation_reference_texts("
    "observation_id TEXT NOT NULL,reference_index INTEGER NOT NULL CHECK(reference_index>=0),"
    "reference_text TEXT NOT NULL CHECK(length(trim(reference_text))>0),"
    "PRIMARY KEY(observation_id,reference_index),"
    "FOREIGN KEY(observation_id) REFERENCES metadata_observations(observation_id) ON DELETE CASCADE"
    ") STRICT"
)

_METADATA_OBSERVATION_ASSET_HINTS_DDL: Final[str] = (
    "CREATE TABLE metadata_observation_asset_hints("
    "observation_id TEXT NOT NULL,hint_ordinal INTEGER NOT NULL CHECK(hint_ordinal>=0),"
    "url TEXT NOT NULL CHECK(length(trim(url))>0),"
    "kind TEXT NOT NULL CHECK(kind IN ('direct-file','landing-page')),media_type TEXT,"
    "asset_role TEXT CHECK(asset_role IS NULL OR asset_role IN "
    "('primary-pdf','supplementary-pdf','xml','html','supplementary')),"
    "version_role TEXT CHECK(version_role IS NULL OR version_role IN "
    "('published','accepted-manuscript','preprint','other')),access_status TEXT,license TEXT,"
    "PRIMARY KEY(observation_id,hint_ordinal),"
    "FOREIGN KEY(observation_id) REFERENCES metadata_observations(observation_id) ON DELETE CASCADE"
    ") STRICT"
)

_METADATA_OBSERVATION_VERSION_LINKS_DDL: Final[str] = (
    "CREATE TABLE metadata_observation_version_links("
    "observation_id TEXT NOT NULL,link_ordinal INTEGER NOT NULL CHECK(link_ordinal>=0),"
    "record_id TEXT,"
    "PRIMARY KEY(observation_id,link_ordinal),"
    "CHECK(record_id IS NULL OR length(trim(record_id))>0),"
    "FOREIGN KEY(observation_id) REFERENCES metadata_observations(observation_id) ON DELETE CASCADE"
    ") STRICT"
)

_METADATA_OBSERVATION_VERSION_LINK_IDENTIFIERS_DDL: Final[str] = (
    "CREATE TABLE metadata_observation_version_link_identifiers("
    "observation_id TEXT NOT NULL,link_ordinal INTEGER NOT NULL,ordinal INTEGER NOT NULL "
    "CHECK(ordinal>=0),"
    "namespace TEXT NOT NULL CHECK(length(trim(namespace))>0),"
    "value TEXT NOT NULL CHECK(length(trim(value))>0),"
    "PRIMARY KEY(observation_id,link_ordinal,namespace,value),"
    "UNIQUE(observation_id,link_ordinal,ordinal),"
    "FOREIGN KEY(observation_id,link_ordinal) REFERENCES "
    "metadata_observation_version_links(observation_id,link_ordinal) ON DELETE CASCADE"
    ") STRICT"
)

_LITERATURE_METADATA_OBSERVATIONS_DDL: Final[str] = (
    "CREATE TABLE literature_metadata_observations("
    "literature_id TEXT NOT NULL,observation_id TEXT NOT NULL UNIQUE,"
    "PRIMARY KEY(literature_id,observation_id),"
    "FOREIGN KEY(literature_id) REFERENCES literatures(literature_id) ON DELETE CASCADE,"
    "FOREIGN KEY(observation_id) REFERENCES metadata_observations(observation_id) "
    "ON DELETE RESTRICT"
    ") STRICT"
)

_USER_OBSERVATION_SEMANTIC_INDEXES_DDL: Final[str] = (
    "CREATE TABLE user_observation_semantic_indexes("
    "observation_id TEXT NOT NULL PRIMARY KEY,"
    "semantic_sha256 TEXT NOT NULL CHECK(length(semantic_sha256)=64 AND "
    "semantic_sha256=lower(semantic_sha256) AND "
    "semantic_sha256 NOT GLOB '*[^0-9a-f]*'),"
    "FOREIGN KEY(observation_id) REFERENCES metadata_observations(observation_id) "
    "ON DELETE CASCADE"
    ") STRICT"
)

_PROVIDER_RELATION_OBSERVATIONS_DDL: Final[str] = (
    "CREATE TABLE provider_relation_observations("
    "observation_id TEXT NOT NULL PRIMARY KEY CHECK(length(trim(observation_id))>0),"
    "provenance_id TEXT NOT NULL,"
    "FOREIGN KEY(provenance_id) REFERENCES provenances(provenance_id) ON DELETE RESTRICT"
    ") STRICT"
)

_PROVIDER_RELATION_ENDPOINTS_DDL: Final[str] = (
    "CREATE TABLE provider_relation_endpoints("
    "observation_id TEXT NOT NULL,endpoint_kind TEXT NOT NULL "
    "CHECK(endpoint_kind IN ('citing','cited')),"
    "record_id TEXT,CHECK(record_id IS NULL OR length(trim(record_id))>0),"
    "PRIMARY KEY(observation_id,endpoint_kind),"
    "FOREIGN KEY(observation_id) REFERENCES provider_relation_observations(observation_id) "
    "ON DELETE CASCADE"
    ") STRICT"
)

_PROVIDER_RELATION_ENDPOINT_IDENTIFIERS_DDL: Final[str] = (
    "CREATE TABLE provider_relation_endpoint_identifiers("
    "observation_id TEXT NOT NULL,endpoint_kind TEXT NOT NULL,ordinal INTEGER NOT NULL "
    "CHECK(ordinal>=0),"
    "namespace TEXT NOT NULL CHECK(length(trim(namespace))>0),"
    "value TEXT NOT NULL CHECK(length(trim(value))>0),"
    "PRIMARY KEY(observation_id,endpoint_kind,namespace,value),"
    "UNIQUE(observation_id,endpoint_kind,ordinal),"
    "FOREIGN KEY(observation_id,endpoint_kind) REFERENCES "
    "provider_relation_endpoints(observation_id,endpoint_kind) ON DELETE CASCADE"
    ") STRICT"
)

_LITERATURE_REFERENCES_DDL: Final[str] = (
    "CREATE TABLE literature_references("
    "reference_id TEXT NOT NULL PRIMARY KEY CHECK(length(trim(reference_id))>0),"
    "source_literature_id TEXT NOT NULL,target_literature_id TEXT NOT NULL,"
    "CHECK(source_literature_id<>target_literature_id),"
    "UNIQUE(source_literature_id,target_literature_id),"
    "FOREIGN KEY(source_literature_id) REFERENCES literatures(literature_id) ON DELETE RESTRICT,"
    "FOREIGN KEY(target_literature_id) REFERENCES literatures(literature_id) ON DELETE RESTRICT"
    ") STRICT"
)

_PROVIDER_RELATION_REFERENCE_SUPPORTS_DDL: Final[str] = (
    "CREATE TABLE provider_relation_reference_supports("
    "reference_id TEXT NOT NULL,observation_id TEXT NOT NULL,"
    "PRIMARY KEY(reference_id,observation_id),"
    "FOREIGN KEY(reference_id) REFERENCES literature_references(reference_id) ON DELETE RESTRICT,"
    "FOREIGN KEY(observation_id) REFERENCES provider_relation_observations(observation_id) "
    "ON DELETE RESTRICT"
    ") STRICT"
)

_METADATA_REFERENCE_TEXT_SUPPORTS_DDL: Final[str] = (
    "CREATE TABLE metadata_reference_text_supports("
    "reference_id TEXT NOT NULL,metadata_observation_id TEXT NOT NULL,"
    "reference_index INTEGER NOT NULL CHECK(reference_index>=0),"
    "PRIMARY KEY(reference_id,metadata_observation_id,reference_index),"
    "FOREIGN KEY(reference_id) REFERENCES literature_references(reference_id) ON DELETE RESTRICT,"
    "FOREIGN KEY(metadata_observation_id,reference_index) REFERENCES "
    "metadata_observation_reference_texts(observation_id,reference_index) ON DELETE RESTRICT"
    ") STRICT"
)

_ASSETS_DDL: Final[str] = (
    "CREATE TABLE assets("
    "asset_id TEXT NOT NULL PRIMARY KEY CHECK(length(trim(asset_id))>0),"
    "sha256 TEXT NOT NULL CHECK(length(sha256)=64 AND sha256=lower(sha256) "
    "AND sha256 NOT GLOB '*[^0-9a-f]*'),"
    "size_bytes INTEGER NOT NULL CHECK(typeof(size_bytes)='integer' AND size_bytes>0),"
    "media_type TEXT NOT NULL CHECK(length(trim(media_type))>0),"
    "relative_path TEXT NOT NULL UNIQUE,"
    "UNIQUE(asset_id,sha256),"
    "UNIQUE(sha256,size_bytes),"
    "FOREIGN KEY(relative_path,sha256,size_bytes,media_type) REFERENCES "
    "artifact_objects(relative_path,sha256,byte_size,media_type) ON DELETE RESTRICT"
    ") STRICT"
)

_LITERATURE_ASSETS_DDL: Final[str] = (
    "CREATE TABLE literature_assets("
    "literature_asset_id TEXT NOT NULL PRIMARY KEY CHECK(length(trim(literature_asset_id))>0),"
    "literature_id TEXT NOT NULL,asset_id TEXT NOT NULL,"
    "role TEXT NOT NULL CHECK(role IN "
    "('primary-pdf','supplementary-pdf','xml','html','supplementary')),"
    "provenance_id TEXT NOT NULL,source_url TEXT,"
    "UNIQUE(literature_id,asset_id,role),"
    "FOREIGN KEY(literature_id) REFERENCES literatures(literature_id) ON DELETE CASCADE,"
    "FOREIGN KEY(asset_id) REFERENCES assets(asset_id) ON DELETE RESTRICT,"
    "FOREIGN KEY(provenance_id) REFERENCES provenances(provenance_id) ON DELETE RESTRICT"
    ") STRICT"
)

_PARSER_RESULTS_DDL: Final[str] = (
    "CREATE TABLE parser_results("
    "source_asset_id TEXT NOT NULL PRIMARY KEY,"
    "source_sha256 TEXT NOT NULL,"
    "result_sha256 TEXT NOT NULL UNIQUE,"
    "page_count INTEGER NOT NULL CHECK(typeof(page_count)='integer' AND page_count>=1),"
    "markdown_artifact_path TEXT NOT NULL,"
    "markdown_sha256 TEXT NOT NULL,"
    "markdown_byte_size INTEGER NOT NULL "
    "CHECK(typeof(markdown_byte_size)='integer' AND markdown_byte_size>0),"
    "markdown_media_type TEXT NOT NULL CHECK(length(trim(markdown_media_type))>0),"
    "provenance_id TEXT NOT NULL,parser_version TEXT NOT NULL,"
    "mode TEXT,model_identity TEXT,"
    "UNIQUE(source_asset_id,result_sha256),"
    "FOREIGN KEY(source_asset_id,source_sha256) REFERENCES assets(asset_id,sha256) "
    "ON DELETE RESTRICT,"
    "FOREIGN KEY(markdown_artifact_path,markdown_sha256,markdown_byte_size,"
    "markdown_media_type) REFERENCES "
    "artifact_objects(relative_path,sha256,byte_size,media_type) ON DELETE RESTRICT,"
    "FOREIGN KEY(provenance_id) REFERENCES provenances(provenance_id) ON DELETE RESTRICT"
    ") STRICT"
)

_PARSER_RESULT_RESOURCES_DDL: Final[str] = (
    "CREATE TABLE parser_result_resources("
    "source_asset_id TEXT NOT NULL,"
    "ordinal INTEGER NOT NULL CHECK(ordinal>=0),"
    "reference TEXT NOT NULL CHECK(length(trim(reference))>0),"
    "artifact_path TEXT NOT NULL,artifact_sha256 TEXT NOT NULL,"
    "artifact_byte_size INTEGER NOT NULL "
    "CHECK(typeof(artifact_byte_size)='integer' AND artifact_byte_size>=0),"
    "artifact_media_type TEXT NOT NULL CHECK(length(trim(artifact_media_type))>0),"
    "PRIMARY KEY(source_asset_id,ordinal),UNIQUE(source_asset_id,reference),"
    "FOREIGN KEY(source_asset_id) REFERENCES parser_results(source_asset_id) ON DELETE CASCADE,"
    "FOREIGN KEY(artifact_path,artifact_sha256,artifact_byte_size,artifact_media_type) "
    "REFERENCES artifact_objects(relative_path,sha256,byte_size,media_type) ON DELETE RESTRICT"
    ") STRICT"
)

_LITERATURE_CONTENTS_DDL: Final[str] = (
    "CREATE TABLE literature_contents("
    "literature_id TEXT NOT NULL PRIMARY KEY,"
    "literature_content_sha256 TEXT NOT NULL CHECK(length(literature_content_sha256)=64 AND "
    "literature_content_sha256=lower(literature_content_sha256) AND "
    "literature_content_sha256 NOT GLOB '*[^0-9a-f]*'),"
    "metadata_revision INTEGER NOT NULL "
    "CHECK(typeof(metadata_revision)='integer' AND metadata_revision>=1),"
    "metadata_sha256 TEXT NOT NULL CHECK(length(metadata_sha256)=64 AND "
    "metadata_sha256=lower(metadata_sha256) AND "
    "metadata_sha256 NOT GLOB '*[^0-9a-f]*'),"
    "primary_asset_id TEXT NOT NULL,primary_asset_sha256 TEXT NOT NULL,"
    "parser_result_sha256 TEXT NOT NULL,"
    "structured_artifact_path TEXT NOT NULL,structured_artifact_sha256 TEXT NOT NULL,"
    "structured_artifact_byte_size INTEGER NOT NULL "
    "CHECK(typeof(structured_artifact_byte_size)='integer' AND "
    "structured_artifact_byte_size>0),"
    "structured_artifact_media_type TEXT NOT NULL "
    "CHECK(length(trim(structured_artifact_media_type))>0),"
    "markdown_artifact_path TEXT NOT NULL,markdown_artifact_sha256 TEXT NOT NULL,"
    "markdown_artifact_byte_size INTEGER NOT NULL "
    "CHECK(typeof(markdown_artifact_byte_size)='integer' AND markdown_artifact_byte_size>0),"
    "markdown_artifact_media_type TEXT NOT NULL "
    "CHECK(length(trim(markdown_artifact_media_type))>0),"
    "analysis_provenance_id TEXT NOT NULL,"
    "FOREIGN KEY(literature_id) REFERENCES literatures(literature_id) ON DELETE CASCADE,"
    "FOREIGN KEY(literature_id,metadata_revision,metadata_sha256) REFERENCES "
    "literature_metadata(literature_id,metadata_revision,metadata_sha256) "
    "ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,"
    "FOREIGN KEY(primary_asset_id,primary_asset_sha256) "
    "REFERENCES assets(asset_id,sha256) ON DELETE RESTRICT,"
    "FOREIGN KEY(structured_artifact_path,structured_artifact_sha256,"
    "structured_artifact_byte_size,structured_artifact_media_type) REFERENCES "
    "artifact_objects(relative_path,sha256,byte_size,media_type) ON DELETE RESTRICT,"
    "FOREIGN KEY(markdown_artifact_path,markdown_artifact_sha256,"
    "markdown_artifact_byte_size,markdown_artifact_media_type) REFERENCES "
    "artifact_objects(relative_path,sha256,byte_size,media_type) ON DELETE RESTRICT,"
    "FOREIGN KEY(analysis_provenance_id) REFERENCES provenances(provenance_id) ON DELETE RESTRICT"
    ") STRICT"
)

_LITERATURE_CONTENT_REFERENCE_TEXTS_DDL: Final[str] = (
    "CREATE TABLE literature_content_reference_texts("
    "literature_content_sha256 TEXT NOT NULL,"
    "reference_index INTEGER NOT NULL CHECK(reference_index>=0),"
    "reference_text TEXT NOT NULL CHECK(length(trim(reference_text))>0),"
    "PRIMARY KEY(literature_content_sha256,reference_index)"
    ") STRICT"
)

_CONTENT_REFERENCE_TEXT_SUPPORTS_DDL: Final[str] = (
    "CREATE TABLE content_reference_text_supports("
    "reference_id TEXT NOT NULL,literature_content_sha256 TEXT NOT NULL,"
    "reference_index INTEGER NOT NULL CHECK(reference_index>=0),"
    "PRIMARY KEY(reference_id,literature_content_sha256,reference_index),"
    "FOREIGN KEY(reference_id) REFERENCES literature_references(reference_id) ON DELETE RESTRICT,"
    "FOREIGN KEY(literature_content_sha256,reference_index) REFERENCES "
    "literature_content_reference_texts(literature_content_sha256,reference_index) "
    "ON DELETE RESTRICT"
    ") STRICT"
)

_AUTOMATIC_PDF_ACQUISITION_EXHAUSTIONS_DDL: Final[str] = (
    "CREATE TABLE automatic_pdf_acquisition_exhaustions("
    "literature_id TEXT NOT NULL PRIMARY KEY,"
    "FOREIGN KEY(literature_id) REFERENCES literatures(literature_id) ON DELETE CASCADE"
    ") STRICT"
)

_LITERATURE_SEARCH_FTS_DDL: Final[str] = (
    "CREATE VIRTUAL TABLE literature_search_fts USING fts5("
    "literature_id UNINDEXED,title,abstract,authors,affiliations,identifiers,keywords,"
    "venue,publisher,volume,issue,pages,content_body,tokenize='unicode61')"
)

_LITERATURE_METADATA_IDENTIFIER_LOOKUP_DDL: Final[str] = (
    "CREATE INDEX literature_metadata_identifier_lookup "
    "ON literature_metadata_identifiers(namespace,value,literature_id)"
)

_LITERATURE_FALLBACK_IDENTITY_LOOKUP_DDL: Final[str] = (
    "CREATE INDEX literature_fallback_identity_lookup "
    "ON literature_fallback_identity_indexes(fallback_identity_sha256,literature_id)"
)

_METADATA_OBSERVATION_IDENTIFIER_LOOKUP_DDL: Final[str] = (
    "CREATE INDEX metadata_observation_identifier_lookup "
    "ON metadata_observation_identifiers(namespace,value,observation_id)"
)

_METADATA_OBSERVATION_PROVENANCE_LOOKUP_DDL: Final[str] = (
    "CREATE INDEX metadata_observation_provenance_lookup "
    "ON metadata_observations(provenance_id,observation_id)"
)

_PROVENANCE_PROVIDER_RECORD_LOOKUP_DDL: Final[str] = (
    "CREATE INDEX provenance_provider_record_lookup "
    "ON provenances(source_kind,source_name,source_record_id,provenance_id) "
    "WHERE source_kind='metadata-provider' AND source_record_id IS NOT NULL"
)

_USER_OBSERVATION_SEMANTIC_LOOKUP_DDL: Final[str] = (
    "CREATE INDEX user_observation_semantic_lookup "
    "ON user_observation_semantic_indexes(semantic_sha256,observation_id)"
)

_ONE_PRIMARY_PDF_PER_LITERATURE_DDL: Final[str] = (
    "CREATE UNIQUE INDEX one_primary_pdf_per_literature "
    "ON literature_assets(literature_id) WHERE role='primary-pdf'"
)

_LITERATURE_CONTENT_HASH_LOOKUP_DDL: Final[str] = (
    "CREATE INDEX literature_content_hash_lookup "
    "ON literature_contents(literature_content_sha256,literature_id)"
)

_LITERATURE_REFERENCE_SOURCE_LOOKUP_DDL: Final[str] = (
    "CREATE INDEX literature_reference_source_lookup "
    "ON literature_references(source_literature_id,target_literature_id,reference_id)"
)

_LITERATURE_REFERENCE_TARGET_LOOKUP_DDL: Final[str] = (
    "CREATE INDEX literature_reference_target_lookup "
    "ON literature_references(target_literature_id,source_literature_id,reference_id)"
)


LITERATURE_SCHEMA_MANIFEST: Final[tuple[str, ...]] = (
    _META_LITERATURES_DDL,
    _LITERATURES_DDL,
    _LITERATURE_METADATA_DDL,
    _LITERATURE_METADATA_AUTHORS_DDL,
    _LITERATURE_METADATA_AUTHOR_AFFILIATIONS_DDL,
    _LITERATURE_METADATA_IDENTIFIERS_DDL,
    _LITERATURE_METADATA_KEYWORDS_DDL,
    _LITERATURE_FALLBACK_IDENTITY_INDEXES_DDL,
    _METADATA_OBSERVATIONS_DDL,
    _METADATA_OBSERVATION_AUTHORS_DDL,
    _METADATA_OBSERVATION_AUTHOR_AFFILIATIONS_DDL,
    _METADATA_OBSERVATION_IDENTIFIERS_DDL,
    _METADATA_OBSERVATION_KEYWORDS_DDL,
    _METADATA_OBSERVATION_DECLARED_KEYWORDS_DDL,
    _METADATA_OBSERVATION_REFERENCE_TEXTS_DDL,
    _METADATA_OBSERVATION_ASSET_HINTS_DDL,
    _METADATA_OBSERVATION_VERSION_LINKS_DDL,
    _METADATA_OBSERVATION_VERSION_LINK_IDENTIFIERS_DDL,
    _LITERATURE_METADATA_OBSERVATIONS_DDL,
    _USER_OBSERVATION_SEMANTIC_INDEXES_DDL,
    _PROVIDER_RELATION_OBSERVATIONS_DDL,
    _PROVIDER_RELATION_ENDPOINTS_DDL,
    _PROVIDER_RELATION_ENDPOINT_IDENTIFIERS_DDL,
    _LITERATURE_REFERENCES_DDL,
    _PROVIDER_RELATION_REFERENCE_SUPPORTS_DDL,
    _METADATA_REFERENCE_TEXT_SUPPORTS_DDL,
    _ASSETS_DDL,
    _LITERATURE_ASSETS_DDL,
    _PARSER_RESULTS_DDL,
    _PARSER_RESULT_RESOURCES_DDL,
    _LITERATURE_CONTENTS_DDL,
    _LITERATURE_CONTENT_REFERENCE_TEXTS_DDL,
    _CONTENT_REFERENCE_TEXT_SUPPORTS_DDL,
    _AUTOMATIC_PDF_ACQUISITION_EXHAUSTIONS_DDL,
    _LITERATURE_SEARCH_FTS_DDL,
    _LITERATURE_METADATA_IDENTIFIER_LOOKUP_DDL,
    _LITERATURE_FALLBACK_IDENTITY_LOOKUP_DDL,
    _METADATA_OBSERVATION_IDENTIFIER_LOOKUP_DDL,
    _METADATA_OBSERVATION_PROVENANCE_LOOKUP_DDL,
    _PROVENANCE_PROVIDER_RECORD_LOOKUP_DDL,
    _USER_OBSERVATION_SEMANTIC_LOOKUP_DDL,
    _ONE_PRIMARY_PDF_PER_LITERATURE_DDL,
    _LITERATURE_CONTENT_HASH_LOOKUP_DDL,
    _LITERATURE_REFERENCE_SOURCE_LOOKUP_DDL,
    _LITERATURE_REFERENCE_TARGET_LOOKUP_DDL,
)

LITERATURE_SCHEMA_TABLES: Final[tuple[str, ...]] = (
    "meta_literatures",
    "literatures",
    "literature_metadata",
    "literature_metadata_authors",
    "literature_metadata_author_affiliations",
    "literature_metadata_identifiers",
    "literature_metadata_keywords",
    "literature_fallback_identity_indexes",
    "metadata_observations",
    "metadata_observation_authors",
    "metadata_observation_author_affiliations",
    "metadata_observation_identifiers",
    "metadata_observation_keywords",
    "metadata_observation_declared_keywords",
    "metadata_observation_reference_texts",
    "metadata_observation_asset_hints",
    "metadata_observation_version_links",
    "metadata_observation_version_link_identifiers",
    "literature_metadata_observations",
    "user_observation_semantic_indexes",
    "provider_relation_observations",
    "provider_relation_endpoints",
    "provider_relation_endpoint_identifiers",
    "literature_references",
    "provider_relation_reference_supports",
    "metadata_reference_text_supports",
    "assets",
    "literature_assets",
    "parser_results",
    "parser_result_resources",
    "literature_contents",
    "literature_content_reference_texts",
    "content_reference_text_supports",
    "automatic_pdf_acquisition_exhaustions",
    "literature_search_fts",
)

LITERATURE_SCHEMA_INDEXES: Final[tuple[str, ...]] = (
    "literature_metadata_identifier_lookup",
    "literature_fallback_identity_lookup",
    "metadata_observation_identifier_lookup",
    "metadata_observation_provenance_lookup",
    "provenance_provider_record_lookup",
    "user_observation_semantic_lookup",
    "one_primary_pdf_per_literature",
    "literature_content_hash_lookup",
    "literature_reference_source_lookup",
    "literature_reference_target_lookup",
)


__all__ = (
    "LITERATURE_SCHEMA_MANIFEST",
    "LITERATURE_SCHEMA_INDEXES",
    "LITERATURE_SCHEMA_TABLES",
)
