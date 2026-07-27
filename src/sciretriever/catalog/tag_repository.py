from __future__ import annotations

from collections.abc import Sequence

from sqlalchemy import insert, select

from sciretriever.catalog.engine import CatalogEngine
from sciretriever.catalog.models import generated_work_version_tags, tag_aliases, tags
from sciretriever.catalog.records import TagRecord
from sciretriever.catalog.repository import _required_text
from sciretriever.catalog.text import normalize_title
from sciretriever.core.ids import new_uuid4, validate_uuid
from sciretriever.core.timestamps import utc_now_rfc3339
from sciretriever.errors import CatalogError


class TagRepository:
    def __init__(self, catalog: CatalogEngine) -> None:
        self._catalog = catalog

    def add(
        self,
        canonical_name: str,
        *,
        definition: str | None = None,
        aliases: Sequence[str] = (),
    ) -> TagRecord:
        name = _required_text(canonical_name, "canonical_name")
        normalized_name = normalize_title(name)
        with self._catalog.critical_transaction() as connection:
            row = connection.execute(
                select(tags).where(tags.c.normalized_name == normalized_name)
            ).mappings().one_or_none()
            alias_owner = connection.execute(
                select(tag_aliases.c.tag_id).where(
                    tag_aliases.c.normalized_alias == normalized_name
                )
            ).scalar_one_or_none()
            if row is None and alias_owner is not None:
                raise CatalogError("canonical tag name conflicts with an existing alias")
            if row is None:
                row = {
                    "id": new_uuid4(),
                    "canonical_name": name,
                    "normalized_name": normalized_name,
                    "definition": definition,
                    "created_at": utc_now_rfc3339(),
                }
                connection.execute(insert(tags).values(**row))
            for alias in aliases:
                alias_value = _required_text(alias, "alias")
                normalized_alias = normalize_title(alias_value)
                canonical_owner = connection.execute(
                    select(tags.c.id).where(tags.c.normalized_name == normalized_alias)
                ).scalar_one_or_none()
                if canonical_owner is not None:
                    if canonical_owner == row["id"]:
                        continue
                    raise CatalogError(
                        "tag alias conflicts with an existing canonical name"
                    )
                existing_owner = connection.execute(
                    select(tag_aliases.c.tag_id).where(
                        tag_aliases.c.normalized_alias == normalized_alias
                    )
                ).scalar_one_or_none()
                if existing_owner is None:
                    connection.execute(insert(tag_aliases).values(
                        id=new_uuid4(),
                        tag_id=row["id"],
                        alias=alias_value,
                        normalized_alias=normalized_alias,
                        language=None,
                        created_at=utc_now_rfc3339(),
                    ))
                elif existing_owner != row["id"]:
                    raise CatalogError("tag alias is already assigned to another tag")
            return TagRecord(
                id=row["id"],
                canonical_name=row["canonical_name"],
                definition=row["definition"],
                created_at=row["created_at"],
            )

    def resolve(self, value: str) -> TagRecord | None:
        normalized_value = normalize_title(_required_text(value, "value"))
        with self._catalog.connect() as connection:
            row = connection.execute(
                select(tags).where(tags.c.normalized_name == normalized_value)
            ).mappings().one_or_none()
            if row is None:
                row = connection.execute(
                    select(tags)
                    .join(tag_aliases, tag_aliases.c.tag_id == tags.c.id)
                    .where(tag_aliases.c.normalized_alias == normalized_value)
                ).mappings().one_or_none()
        if row is None:
            return None
        return TagRecord(
            id=row["id"],
            canonical_name=row["canonical_name"],
            definition=row["definition"],
            created_at=row["created_at"],
        )

    def add_generated(
        self,
        work_version_id: str,
        tag_id: str,
        source_artifact_id: str,
    ) -> None:
        values = {
            "work_version_id": validate_uuid(work_version_id, "work_version_id"),
            "tag_id": validate_uuid(tag_id, "tag_id"),
            "source_artifact_id": validate_uuid(
                source_artifact_id, "source_artifact_id"
            ),
            "linked_at": utc_now_rfc3339(),
        }
        with self._catalog.critical_transaction() as connection:
            connection.execute(
                insert(generated_work_version_tags)
                .prefix_with("OR IGNORE")
                .values(**values)
            )


__all__ = ("TagRepository",)
