"""Repair historical catalogs and install complete P3 asset invariants."""

from __future__ import annotations

from sqlalchemy.engine import Connection

from sciretriever.catalog.models import asset_intents
from sciretriever.errors import CatalogError


REVISION = "0002"
DESCRIPTION = "P3 immutable asset intent invariants"

_REPLAY_COLUMNS = frozenset(
    {"media_type", "format", "expected_byte_size", "provenance_json"}
)

_TRIGGERS = (
    """
    CREATE TRIGGER trg_raw_assets_insert_coherence
    BEFORE INSERT ON raw_assets
    WHEN (
        length(NEW.id) = 36
        AND substr(NEW.id, 9, 1) = '-'
        AND substr(NEW.id, 14, 1) = '-'
        AND substr(NEW.id, 19, 1) = '-'
        AND substr(NEW.id, 24, 1) = '-'
        AND substr(NEW.id, 1, 8) NOT GLOB '*[^0-9a-f]*'
        AND substr(NEW.id, 10, 4) NOT GLOB '*[^0-9a-f]*'
        AND substr(NEW.id, 15, 4) NOT GLOB '*[^0-9a-f]*'
        AND substr(NEW.id, 20, 4) NOT GLOB '*[^0-9a-f]*'
        AND substr(NEW.id, 25, 12) NOT GLOB '*[^0-9a-f]*'
        AND length(NEW.sha256) = 64
        AND NEW.sha256 = lower(NEW.sha256)
        AND NEW.sha256 NOT GLOB '*[^0-9a-f]*'
        AND NEW.storage_path = 'raw/' || substr(NEW.sha256, 1, 2) || '/' || NEW.sha256
        AND NEW.media_type = lower(NEW.media_type)
        AND substr(NEW.media_type, 1, 1) GLOB '[a-z0-9]'
        AND substr(NEW.media_type, instr(NEW.media_type, '/') + 1, 1) GLOB '[a-z0-9]'
        AND NEW.media_type NOT GLOB '*[^a-z0-9!#$&^_.+/-]*'
        AND length(NEW.media_type) - length(replace(NEW.media_type, '/', '')) = 1
        AND substr(NEW.format, 1, 1) GLOB '[a-z]'
        AND NEW.format NOT GLOB '*[^a-z0-9_]*'
        AND NEW.byte_size > 0
        AND CASE WHEN json_valid(NEW.provenance_json)
            THEN json(NEW.provenance_json) = NEW.provenance_json ELSE 0 END
        AND length(NEW.created_at) = 24
        AND NEW.created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
    ) IS NOT 1
    BEGIN
        SELECT RAISE(ABORT, 'raw asset metadata is incoherent');
    END
    """,
    """
    CREATE TRIGGER trg_raw_assets_immutable_update
    BEFORE UPDATE ON raw_assets
    BEGIN
        SELECT RAISE(ABORT, 'raw assets are immutable');
    END
    """,
    """
    CREATE TRIGGER trg_raw_assets_immutable_delete
    BEFORE DELETE ON raw_assets
    BEGIN
        SELECT RAISE(ABORT, 'raw assets are immutable');
    END
    """,
    """
    CREATE TRIGGER trg_asset_intents_initial_coherence
    BEFORE INSERT ON asset_intents
    BEGIN
        SELECT CASE
            WHEN NEW.state <> 'pending' OR NEW.raw_asset_id IS NOT NULL
            THEN RAISE(ABORT, 'asset intent must start pending without a raw asset')
        END;
        SELECT CASE
            WHEN NOT EXISTS (
                SELECT 1 FROM acquisition_jobs AS job
                WHERE job.id = NEW.job_id
                  AND job.work_id = NEW.work_id
                  AND job.asset_role = NEW.asset_role
            )
            THEN RAISE(ABORT, 'asset intent job must match work and asset role')
        END;
        SELECT CASE
            WHEN NEW.attempt_id IS NOT NULL AND NOT EXISTS (
                SELECT 1 FROM acquisition_attempts AS attempt
                WHERE attempt.id = NEW.attempt_id AND attempt.job_id = NEW.job_id
            )
            THEN RAISE(ABORT, 'asset intent attempt must belong to its job')
        END;
    END
    """,
    """
    CREATE TRIGGER trg_asset_intents_immutable_replay
    BEFORE UPDATE ON asset_intents
    WHEN NEW.id IS NOT OLD.id
      OR NEW.work_id IS NOT OLD.work_id
      OR NEW.job_id IS NOT OLD.job_id
      OR NEW.attempt_id IS NOT OLD.attempt_id
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
    CREATE TRIGGER trg_asset_intents_state_transition
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
    CREATE TRIGGER trg_asset_intents_immutable_delete
    BEFORE DELETE ON asset_intents
    BEGIN
        SELECT RAISE(ABORT, 'asset intents are immutable replay records');
    END
    """,
)


def _columns(connection: Connection, table: str) -> frozenset[str]:
    return frozenset(
        row[1] for row in connection.exec_driver_sql(f'PRAGMA table_info("{table}")')
    )


def _audit_raw_assets(connection: Connection) -> None:
    invalid = connection.exec_driver_sql(
        """
        SELECT count(*) FROM raw_assets
        WHERE (
            length(id) = 36
            AND substr(id, 9, 1) = '-'
            AND substr(id, 14, 1) = '-'
            AND substr(id, 19, 1) = '-'
            AND substr(id, 24, 1) = '-'
            AND substr(id, 1, 8) NOT GLOB '*[^0-9a-f]*'
            AND substr(id, 10, 4) NOT GLOB '*[^0-9a-f]*'
            AND substr(id, 15, 4) NOT GLOB '*[^0-9a-f]*'
            AND substr(id, 20, 4) NOT GLOB '*[^0-9a-f]*'
            AND substr(id, 25, 12) NOT GLOB '*[^0-9a-f]*'
            AND length(sha256) = 64
            AND sha256 = lower(sha256)
            AND sha256 NOT GLOB '*[^0-9a-f]*'
            AND storage_path = 'raw/' || substr(sha256, 1, 2) || '/' || sha256
            AND media_type = lower(media_type)
            AND substr(media_type, 1, 1) GLOB '[a-z0-9]'
            AND substr(media_type, instr(media_type, '/') + 1, 1) GLOB '[a-z0-9]'
            AND media_type NOT GLOB '*[^a-z0-9!#$&^_.+/-]*'
            AND length(media_type) - length(replace(media_type, '/', '')) = 1
            AND substr(format, 1, 1) GLOB '[a-z]'
            AND format NOT GLOB '*[^a-z0-9_]*'
            AND byte_size > 0
            AND CASE WHEN json_valid(provenance_json)
                THEN json(provenance_json) = provenance_json ELSE 0 END
            AND length(created_at) = 24
            AND created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
        ) IS NOT 1
        """
    ).scalar_one()
    if invalid:
        raise CatalogError(
            f"P3 migration refused {invalid} incoherent immutable raw asset row(s)"
        )


def _audit_asset_intents(connection: Connection) -> None:
    invalid = connection.exec_driver_sql(
        """
        SELECT count(*) FROM asset_intents AS intent
        WHERE intent.state IS NULL
        OR intent.state NOT IN ('pending', 'published', 'finalized', 'abandoned')
        OR NOT EXISTS (
            SELECT 1 FROM acquisition_jobs AS job
            WHERE job.id = intent.job_id
              AND job.work_id = intent.work_id
              AND job.asset_role = intent.asset_role
        )
        OR (intent.attempt_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM acquisition_attempts AS attempt
            WHERE attempt.id = intent.attempt_id AND attempt.job_id = intent.job_id
        ))
        OR (intent.state IN ('pending', 'abandoned') AND intent.raw_asset_id IS NOT NULL)
        OR (intent.state IN ('published', 'finalized') AND (
            intent.raw_asset_id IS NULL OR NOT EXISTS (
                SELECT 1 FROM raw_assets AS raw
                WHERE raw.id = intent.raw_asset_id
                  AND raw.sha256 = intent.expected_sha256
                  AND raw.storage_path = intent.storage_path
                  AND raw.media_type = intent.media_type
                  AND raw.format = intent.format
                  AND raw.byte_size = intent.expected_byte_size
            )
        ))
        """
    ).scalar_one()
    if invalid:
        raise CatalogError(f"P3 migration refused {invalid} incoherent asset intent row(s)")


def _replace_triggers(connection: Connection) -> None:
    names = (
        "trg_raw_assets_insert_coherence",
        "trg_raw_assets_immutable_update",
        "trg_raw_assets_immutable_delete",
        "trg_asset_intents_initial_coherence",
        "trg_asset_intents_immutable_replay",
        "trg_asset_intents_state_transition",
        "trg_asset_intents_immutable_delete",
    )
    for name in names:
        connection.exec_driver_sql(f'DROP TRIGGER IF EXISTS "{name}"')
    for statement in _TRIGGERS:
        connection.exec_driver_sql(statement)


def upgrade(connection: Connection) -> None:
    columns = _columns(connection, "asset_intents")
    if not _REPLAY_COLUMNS.issubset(columns):
        count = connection.exec_driver_sql("SELECT count(*) FROM asset_intents").scalar_one()
        if count:
            raise CatalogError(
                "P3 migration cannot fabricate replay metadata for "
                f"{count} historical asset intent row(s)"
            )
        asset_intents.drop(connection, checkfirst=False)
        asset_intents.create(connection, checkfirst=False)

    _audit_raw_assets(connection)
    _audit_asset_intents(connection)
    _replace_triggers(connection)
