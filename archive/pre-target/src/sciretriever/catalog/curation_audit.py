from __future__ import annotations

from dataclasses import dataclass
import json

from sqlalchemy import select

from sciretriever.catalog.curation_records import CurationAuditRecord, load_audit
from sciretriever.catalog.engine import CatalogEngine
from sciretriever.catalog.wp6_models import curation_operations
from sciretriever.core.ids import validate_uuid


@dataclass(frozen=True, slots=True)
class CurationAuditRepository:
    catalog: CatalogEngine

    def get(self, operation_id: str) -> CurationAuditRecord | None:
        operation = validate_uuid(operation_id, "operation_id")
        with self.catalog.connect() as connection:
            return load_audit(connection, operation)

    def recent(self, limit: int) -> tuple[CurationAuditRecord, ...]:
        if not 1 <= limit <= 1000:
            raise ValueError("invalid audit limit")
        with self.catalog.connect() as connection:
            identifiers = connection.execute(
                select(curation_operations.c.id)
                .order_by(curation_operations.c.occurred_at.desc(), curation_operations.c.id)
                .limit(limit)
            ).scalars()
            records = tuple(load_audit(connection, str(identifier)) for identifier in identifiers)
        return tuple(record for record in records if record is not None)


def audit_json(record: CurationAuditRecord) -> str:
    operation = record.operation
    value = {
        "action": operation.action.value,
        "after": operation.after.to_dict(),
        "after_sha256": record.after_sha256,
        "before": operation.before.to_dict(),
        "before_sha256": record.before_sha256,
        "occurred_at": record.occurred_at,
        "operation_id": record.id,
        "operation_sha256": operation.operation_sha256,
        "result": operation.result.value,
        "subject_id": operation.subject_id,
        "subject_kind": operation.subject_kind.value,
        "undo_of": operation.undo_of,
    }
    return json.dumps(value, ensure_ascii=True, allow_nan=False, separators=(",", ":"), sort_keys=True)


__all__ = ("CurationAuditRepository", "audit_json")
