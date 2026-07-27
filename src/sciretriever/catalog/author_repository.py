from __future__ import annotations

from sqlalchemy import insert, select

from sciretriever.catalog.engine import CatalogEngine
from sciretriever.catalog.models import authors, authorships
from sciretriever.catalog.records import AuthorRecord, AuthorshipRecord
from sciretriever.catalog.repository import _required_text
from sciretriever.core.ids import new_uuid4, validate_uuid
from sciretriever.core.timestamps import utc_now_rfc3339


class AuthorRepository:
    def __init__(self, catalog: CatalogEngine) -> None:
        self._catalog = catalog

    def add_authorship(
        self,
        work_version_id: str,
        name: str,
        position: int,
        *,
        orcid: str | None = None,
        role: str | None = None,
        is_corresponding: bool = False,
        affiliation: str | None = None,
    ) -> tuple[AuthorRecord, AuthorshipRecord]:
        work_version_id = validate_uuid(work_version_id, "work_version_id")
        display_name = _required_text(name, "name")
        normalized_name = display_name.casefold()
        with self._catalog.critical_transaction() as connection:
            row = None if orcid is None else connection.execute(
                select(authors).where(authors.c.orcid == orcid)
            ).mappings().one_or_none()
            if row is None:
                row = {
                    "id": new_uuid4(),
                    "display_name": display_name,
                    "normalized_name": normalized_name,
                    "orcid": orcid,
                    "status": "active",
                    "merged_into_author_id": None,
                    "created_at": utc_now_rfc3339(),
                }
                connection.execute(insert(authors).values(**row))
            link = {
                "id": new_uuid4(),
                "work_version_id": work_version_id,
                "author_id": row["id"],
                "position": position,
                "role": role,
                "is_corresponding": int(is_corresponding),
                "affiliation": affiliation,
                "created_at": utc_now_rfc3339(),
            }
            connection.execute(insert(authorships).values(**link))
            return AuthorRecord(**row), AuthorshipRecord(
                **{**link, "is_corresponding": bool(link["is_corresponding"])}
            )


__all__ = ("AuthorRepository",)
