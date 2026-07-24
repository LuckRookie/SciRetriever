"""Create the fresh Work-centered catalog schema."""

from __future__ import annotations

from sqlalchemy.engine import Connection

from sciretriever.catalog.models import metadata


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


def initialize_schema(connection: Connection) -> None:
    metadata.create_all(connection, checkfirst=False)
    for statement in _TRIGGERS:
        connection.exec_driver_sql(statement)
