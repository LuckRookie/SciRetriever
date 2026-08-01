from __future__ import annotations

from collections.abc import Sequence
from contextlib import nullcontext

from sqlalchemy import Connection, insert, select

from sciretriever.catalog.engine import CatalogEngine
from sciretriever.catalog.models import (
    publisher_aliases,
    publishers,
    venue_aliases,
    venues,
)
from sciretriever.catalog.records import RegistryRecord
from sciretriever.catalog.repository import _required_text
from sciretriever.catalog.text import normalize_title
from sciretriever.core.ids import new_uuid4
from sciretriever.core.timestamps import utc_now_rfc3339
from sciretriever.errors import CatalogError


class RegistryRepository:
    def __init__(self, catalog: CatalogEngine) -> None:
        self._catalog = catalog

    def add(
        self,
        kind: str,
        canonical_name: str,
        aliases: Sequence[str] = (),
        *,
        _connection: Connection | None = None,
    ) -> RegistryRecord:
        table, alias_table, foreign_key = self._tables(kind)
        name = _required_text(canonical_name, "canonical_name")
        normalized_name = normalize_title(name)
        transaction = (
            self._catalog.critical_transaction()
            if _connection is None
            else nullcontext(_connection)
        )
        with transaction as connection:
            row = connection.execute(
                select(table).where(table.c.normalized_name == normalized_name)
            ).mappings().one_or_none()
            alias_owner = connection.execute(
                select(alias_table.c[foreign_key]).where(
                    alias_table.c.normalized_alias == normalized_name
                )
            ).scalar_one_or_none()
            if row is None and alias_owner is not None:
                raise CatalogError("canonical name conflicts with an existing alias")
            if row is None:
                row = {
                    "id": new_uuid4(),
                    "canonical_name": name,
                    "normalized_name": normalized_name,
                    "created_at": utc_now_rfc3339(),
                }
                connection.execute(insert(table).values(**row))
            for alias in aliases:
                alias_value = _required_text(alias, "alias")
                normalized_alias = normalize_title(alias_value)
                canonical_owner = connection.execute(
                    select(table.c.id).where(table.c.normalized_name == normalized_alias)
                ).scalar_one_or_none()
                if canonical_owner is not None:
                    if canonical_owner == row["id"]:
                        continue
                    raise CatalogError("alias conflicts with an existing canonical name")
                existing_owner = connection.execute(
                    select(alias_table.c[foreign_key]).where(
                        alias_table.c.normalized_alias == normalized_alias
                    )
                ).scalar_one_or_none()
                if existing_owner is None:
                    connection.execute(insert(alias_table).values(
                        id=new_uuid4(),
                        **{foreign_key: row["id"]},
                        alias=alias_value,
                        normalized_alias=normalized_alias,
                        created_at=utc_now_rfc3339(),
                    ))
                elif existing_owner != row["id"]:
                    raise CatalogError(
                        "alias is already assigned to another registry record"
                    )
            return RegistryRecord(
                id=row["id"],
                canonical_name=row["canonical_name"],
                created_at=row["created_at"],
            )

    def resolve(self, kind: str, value: str) -> RegistryRecord | None:
        table, alias_table, foreign_key = self._tables(kind)
        normalized_value = normalize_title(_required_text(value, "value"))
        with self._catalog.connect() as connection:
            row = connection.execute(
                select(table).where(table.c.normalized_name == normalized_value)
            ).mappings().one_or_none()
            if row is None:
                row = connection.execute(
                    select(table)
                    .join(alias_table, alias_table.c[foreign_key] == table.c.id)
                    .where(alias_table.c.normalized_alias == normalized_value)
                ).mappings().one_or_none()
        return None if row is None else RegistryRecord(
            **{
                field: row[field]
                for field in RegistryRecord.__dataclass_fields__
            }
        )

    @staticmethod
    def _tables(kind: str):
        if kind == "publisher":
            return publishers, publisher_aliases, "publisher_id"
        if kind == "venue":
            return venues, venue_aliases, "venue_id"
        raise ValueError("kind must be publisher or venue")


__all__ = ("RegistryRepository",)
