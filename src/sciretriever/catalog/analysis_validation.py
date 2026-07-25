from __future__ import annotations

import re

from sqlalchemy import select
from sqlalchemy.engine import Connection

from sciretriever.catalog.canonical_projection import CANONICAL_FIELDS
from sciretriever.catalog.models import publishers, tags, venues
from sciretriever.core.ids import validate_uuid
from sciretriever.errors import CatalogError


def validate_projection(
    connection: Connection, projection: object | None,
) -> dict[str, object]:
    allowed = {
        "title", "abstract", "language", "work_type", "publication_date",
        "publication_year", "publisher_id", "venue_id", "volume", "issue",
        "pages", "article_number", "open_access_status",
    }
    if projection is None:
        return {}
    if not isinstance(projection, dict) or not set(projection).issubset(allowed):
        raise ValueError("analysis projection contains unsupported fields")
    return {
        name: validate_canonical_value(connection, name, value)
        for name, value in projection.items()
    }


def validate_tag_ids(
    connection: Connection, values: tuple[str, ...],
) -> tuple[str, ...]:
    tag_ids = tuple(validate_uuid(value, "generated_tag_id") for value in values)
    if len(tag_ids) != len(set(tag_ids)):
        raise ValueError("generated_tag_ids contains duplicates")
    if tag_ids:
        existing = set(connection.execute(
            select(tags.c.id).where(tags.c.id.in_(tag_ids))
        ).scalars())
        if existing != set(tag_ids):
            raise CatalogError("generated analysis tag IDs must already exist")
    return tag_ids


def validate_canonical_value(
    connection: Connection, field_name: str, value: object,
) -> object:
    if field_name not in CANONICAL_FIELDS:
        raise ValueError("unsupported canonical metadata field")
    if field_name == "publication_year":
        if type(value) is not int or value < 0:
            raise ValueError("publication_year must be a nonnegative integer")
        return value
    if not isinstance(value, str) or not value.strip():
        raise ValueError("canonical metadata strings must be non-blank")
    normalized = value.strip()
    if field_name == "publication_date" and re.fullmatch(
        r"\d{4}(?:-\d{2}-\d{2})?", normalized
    ) is None:
        raise ValueError("publication_date must be YYYY or YYYY-MM-DD")
    if field_name in {"publisher_id", "venue_id"}:
        normalized = validate_uuid(normalized, field_name)
        table = publishers if field_name == "publisher_id" else venues
        exists = connection.execute(
            select(table.c.id).where(table.c.id == normalized)
        ).scalar_one_or_none()
        if exists is None:
            raise CatalogError(f"{field_name} must already exist in its registry")
    return normalized
