"""Create the fresh Work-centered catalog schema."""

from __future__ import annotations

from importlib import import_module

from sqlalchemy.engine import Connection

from sciretriever.catalog.models import metadata


import_module("sciretriever.catalog.wp6_models")


_TRIGGERS = (
    """
    CREATE TRIGGER IF NOT EXISTS trg_works_preferred_version_insert
    BEFORE INSERT ON works
    WHEN NEW.preferred_work_version_id IS NOT NULL
      AND NOT EXISTS (
          SELECT 1 FROM work_versions AS version
          WHERE version.id = NEW.preferred_work_version_id
            AND version.work_id = NEW.id
      )
    BEGIN
        SELECT RAISE(ABORT, 'preferred WorkVersion must belong to its Work');
    END
    """,
    """
    CREATE TRIGGER IF NOT EXISTS trg_works_preferred_version_update
    BEFORE UPDATE OF preferred_work_version_id ON works
    WHEN NEW.preferred_work_version_id IS NOT NULL
      AND NOT EXISTS (
          SELECT 1 FROM work_versions AS version
          WHERE version.id = NEW.preferred_work_version_id
            AND version.work_id = NEW.id
      )
    BEGIN
        SELECT RAISE(ABORT, 'preferred WorkVersion must belong to its Work');
    END
    """,
    """
    CREATE TRIGGER IF NOT EXISTS trg_raw_assets_insert_coherence
    BEFORE INSERT ON raw_assets
    WHEN NEW.storage_path <> 'raw/' || substr(NEW.sha256, 1, 2) || '/' || NEW.sha256
      OR NEW.byte_size <= 0
      OR json_valid(NEW.provenance_json) <> 1
      OR json(NEW.provenance_json) <> NEW.provenance_json
    BEGIN
        SELECT RAISE(ABORT, 'raw asset metadata is incoherent');
    END
    """,
    """
    CREATE TRIGGER IF NOT EXISTS trg_raw_assets_immutable_update
    BEFORE UPDATE ON raw_assets
    BEGIN
        SELECT RAISE(ABORT, 'raw assets are immutable');
    END
    """,
    """
    CREATE TRIGGER IF NOT EXISTS trg_raw_assets_immutable_delete
    BEFORE DELETE ON raw_assets
    BEGIN
        SELECT RAISE(ABORT, 'raw assets are immutable');
    END
    """,
    """
    CREATE TRIGGER IF NOT EXISTS trg_asset_intents_initial_coherence
    BEFORE INSERT ON asset_intents
    BEGIN
        SELECT CASE
            WHEN NEW.state <> 'pending' OR NEW.raw_asset_id IS NOT NULL
            THEN RAISE(ABORT, 'asset intent must start pending without a raw asset')
        END;
    END
    """,
    """
    CREATE TRIGGER IF NOT EXISTS trg_asset_intents_immutable_replay
    BEFORE UPDATE ON asset_intents
    WHEN NEW.id IS NOT OLD.id
      OR NEW.work_version_id IS NOT OLD.work_version_id
      OR NEW.asset_role IS NOT OLD.asset_role
      OR NEW.temporary_path IS NOT OLD.temporary_path
      OR NEW.storage_path IS NOT OLD.storage_path
      OR NEW.expected_sha256 IS NOT OLD.expected_sha256
      OR NEW.media_type IS NOT OLD.media_type
      OR NEW.format IS NOT OLD.format
      OR NEW.expected_byte_size IS NOT OLD.expected_byte_size
      OR NEW.provenance_json IS NOT OLD.provenance_json
      OR NEW.created_at IS NOT OLD.created_at
    BEGIN
        SELECT RAISE(ABORT, 'asset intent replay metadata is immutable');
    END
    """,
    """
    CREATE TRIGGER IF NOT EXISTS trg_asset_intents_state_transition
    BEFORE UPDATE ON asset_intents
    WHEN NOT (
        (OLD.state = 'pending' AND NEW.state = 'published'
            AND OLD.raw_asset_id IS NULL AND NEW.raw_asset_id IS NOT NULL
            AND EXISTS (
                SELECT 1 FROM raw_assets AS raw
                WHERE raw.id = NEW.raw_asset_id
                  AND raw.sha256 = OLD.expected_sha256
                  AND raw.storage_path = OLD.storage_path
                  AND raw.media_type = OLD.media_type
                  AND raw.format = OLD.format
                  AND raw.byte_size = OLD.expected_byte_size
            ))
        OR (OLD.state = 'pending' AND NEW.state = 'abandoned'
            AND OLD.raw_asset_id IS NULL AND NEW.raw_asset_id IS NULL)
        OR (OLD.state = 'published' AND NEW.state = 'finalized'
            AND NEW.raw_asset_id IS OLD.raw_asset_id AND NEW.raw_asset_id IS NOT NULL)
    )
    BEGIN
        SELECT RAISE(ABORT, 'illegal asset intent transition');
    END
    """,
    """
    CREATE TRIGGER IF NOT EXISTS trg_asset_intents_immutable_delete
    BEFORE DELETE ON asset_intents
    BEGIN
        SELECT RAISE(ABORT, 'asset intents are immutable replay records');
    END
    """,
)

_WP6_APPEND_ONLY_TABLES = (
    "diagnostic_records",
    "curation_operations",
    "work_merge_lineage",
    "author_merge_lineage",
)

_WP6_TRIGGERS = (
    """
    CREATE TRIGGER trg_curation_operations_subject_exists
    BEFORE INSERT ON curation_operations
    WHEN NOT (
        (NEW.subject_kind = 'work' AND EXISTS (
            SELECT 1 FROM works WHERE id = NEW.subject_id
        )) OR
        (NEW.subject_kind = 'work_version' AND EXISTS (
            SELECT 1 FROM work_versions WHERE id = NEW.subject_id
        )) OR
        (NEW.subject_kind = 'author' AND EXISTS (
            SELECT 1 FROM authors WHERE id = NEW.subject_id
        )) OR
        (NEW.subject_kind = 'review' AND EXISTS (
            SELECT 1 FROM identity_reviews WHERE id = NEW.subject_id
        )) OR
        (NEW.subject_kind = 'operation' AND EXISTS (
            SELECT 1 FROM curation_operations WHERE id = NEW.subject_id
        ))
    )
    BEGIN
        SELECT RAISE(ABORT, 'curation subject must exist');
    END
    """,
    """
    CREATE TRIGGER trg_work_merge_lineage_no_cycle
    BEFORE INSERT ON work_merge_lineage
    WHEN EXISTS (
        WITH RECURSIVE targets(work_id) AS (
            SELECT NEW.target_work_id
            UNION ALL
            SELECT lineage.target_work_id
            FROM work_merge_lineage AS lineage
            JOIN targets ON lineage.source_work_id = targets.work_id
        )
        SELECT 1 FROM targets WHERE work_id = NEW.source_work_id
    )
    BEGIN
        SELECT RAISE(ABORT, 'Work merge would create a cycle');
    END
    """,
    """
    CREATE TRIGGER trg_author_merge_lineage_no_cycle
    BEFORE INSERT ON author_merge_lineage
    WHEN EXISTS (
        WITH RECURSIVE targets(author_id) AS (
            SELECT NEW.target_author_id
            UNION ALL
            SELECT lineage.target_author_id
            FROM author_merge_lineage AS lineage
            JOIN targets ON lineage.source_author_id = targets.author_id
        )
        SELECT 1 FROM targets WHERE author_id = NEW.source_author_id
    )
    BEGIN
        SELECT RAISE(ABORT, 'Author merge would create a cycle');
    END
    """,
)


def initialize_schema(connection: Connection) -> None:
    metadata.create_all(connection, checkfirst=False)
    for statement in _TRIGGERS:
        connection.exec_driver_sql(statement)
    for table_name in _WP6_APPEND_ONLY_TABLES:
        connection.exec_driver_sql(
            f"CREATE TRIGGER trg_{table_name}_immutable_update "
            f"BEFORE UPDATE ON {table_name} BEGIN "
            "SELECT RAISE(ABORT, 'append-only record cannot be updated'); END"
        )
        connection.exec_driver_sql(
            f"CREATE TRIGGER trg_{table_name}_immutable_delete "
            f"BEFORE DELETE ON {table_name} BEGIN "
            "SELECT RAISE(ABORT, 'append-only record cannot be deleted'); END"
        )
    for statement in _WP6_TRIGGERS:
        connection.exec_driver_sql(statement)
