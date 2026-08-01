"""Single canonical metadata precedence implementation for catalog writers."""

from __future__ import annotations

import json
import unicodedata

from sqlalchemy import select, update

from sciretriever.catalog.models import generated_work_version_metadata, manual_metadata_overrides, provider_canonical_projections, work_versions
from sciretriever.core.timestamps import utc_now_rfc3339
from sciretriever.errors import CatalogError


CANONICAL_FIELDS = frozenset({"title", "abstract", "language", "work_type", "publication_date", "publication_year",
                              "publisher_id", "venue_id", "volume", "issue", "pages", "article_number", "open_access_status"})
NULLABLE_CANONICAL_FIELDS = CANONICAL_FIELDS - {"title"}


def _normalize_title(value: str) -> str:
    normalized = unicodedata.normalize("NFKC", value).casefold()
    return " ".join("".join(" " if unicodedata.category(character)[0] in {"P", "S"} else character
                            for character in normalized).split())


def _values(connection, table, work_version_id: str) -> dict[str, object]:
    return {row.field_name: json.loads(row.value_json) for row in connection.execute(
        select(table.c.field_name, table.c.value_json).where(table.c.work_version_id == work_version_id))}


def recompute_canonical_projection(connection, work_version_id: str, field_names: frozenset[str] = CANONICAL_FIELDS) -> None:
    if not field_names or not field_names.issubset(CANONICAL_FIELDS):
        raise ValueError("canonical projection fields are invalid")
    provider = _values(connection, provider_canonical_projections, work_version_id)
    generated = _values(connection, generated_work_version_metadata, work_version_id)
    manual = _values(connection, manual_metadata_overrides, work_version_id)
    combined = {**provider, **generated, **manual}
    current = connection.execute(select(work_versions).where(work_versions.c.id == work_version_id)).mappings().one_or_none()
    if current is None:
        raise CatalogError("canonical projection WorkVersion does not exist")
    changes: dict[str, object] = {}
    for field_name in field_names:
        if field_name == "title":
            title = combined.get("title")
            if isinstance(title, str) and title.strip():
                changes["title"] = title.strip()
                changes["normalized_title"] = _normalize_title(title)
            else:
                raise CatalogError("canonical title has no provider, generated, or manual value")
        else:
            changes[field_name] = combined.get(field_name)
    changes["updated_at"] = utc_now_rfc3339()
    connection.execute(update(work_versions).where(work_versions.c.id == work_version_id).values(**changes))


__all__ = ("CANONICAL_FIELDS", "NULLABLE_CANONICAL_FIELDS", "recompute_canonical_projection")
