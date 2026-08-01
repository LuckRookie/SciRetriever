from __future__ import annotations

import os
from collections.abc import Callable

from sciretriever.collection.api import CollectionAcceptance, ExistingCollectionAcceptance
from sciretriever.kernel import canonical_json_bytes
from sciretriever.literature_store.sqlite.publisher_support import (
    StalePublicationError,
    StatementFailpoint,
    execute,
    immediate,
    publish_bibliography,
)


class CollectionAcceptancePublisher:
    def __init__(
        self,
        catalog_path: str | os.PathLike[str],
        *,
        failpoint: Callable[[str], None] | None = None,
    ) -> None:
        self._catalog_path = catalog_path
        self._failpoint = failpoint

    def publish(self, command: CollectionAcceptance) -> None:
        if command.membership.work_id != command.bibliography.work_id:
            raise StalePublicationError("collection acceptance identities differ")
        if any(
            item.membership_id != command.membership.membership_id
            or item.run_id != command.membership.first_run_id
            for item in command.causes + command.paths
        ):
            raise StalePublicationError("collection evidence identities differ")
        point = StatementFailpoint(self._failpoint)
        with immediate(self._catalog_path) as connection:
            publish_bibliography(connection, point, command.bibliography)
            membership = command.membership
            execute(
                connection,
                point,
                "INSERT OR IGNORE INTO collection_memberships(id,collection_id,work_id,"
                "first_collection_run_id) VALUES(?,?,?,?)",
                (
                    str(membership.membership_id),
                    str(membership.collection_id),
                    str(membership.work_id),
                    str(membership.first_run_id),
                ),
            )
            for cause in command.causes:
                evidence = canonical_json_bytes(cause.evidence).decode("ascii")
                execute(
                    connection,
                    point,
                    "INSERT INTO collection_causes(id,membership_id,collection_run_id,kind,"
                    "source,condition,seed_work_id) VALUES(?,?,?,?,?,?,?)",
                    (
                        str(cause.cause_id),
                        str(cause.membership_id),
                        str(cause.run_id),
                        cause.kind.value,
                        evidence,
                        None,
                        None if cause.seed_work_id is None else str(cause.seed_work_id),
                    ),
                )
            for path in command.paths:
                work_ids = canonical_json_bytes(
                    tuple(str(value) for value in path.work_ids)
                ).decode("ascii")
                execute(
                    connection,
                    point,
                    "INSERT INTO collection_paths(id,membership_id,collection_run_id,direction,"
                    "depth,work_ids_json) VALUES(?,?,?,?,?,?)",
                    (
                        str(path.path_id),
                        str(path.membership_id),
                        str(path.run_id),
                        None if path.direction is None else path.direction.value,
                        path.depth,
                        work_ids,
                    ),
                )
            point.before_commit()
            connection.commit()

    def publish_existing(self, command: ExistingCollectionAcceptance) -> None:
        point = StatementFailpoint(self._failpoint)
        membership = command.membership
        with immediate(self._catalog_path) as connection:
            execute(
                connection,
                point,
                "INSERT OR IGNORE INTO collection_memberships(id,collection_id,work_id,"
                "first_collection_run_id) VALUES(?,?,?,?)",
                (
                    str(membership.membership_id),
                    str(membership.collection_id),
                    str(membership.work_id),
                    str(membership.first_run_id),
                ),
            )
            for cause in command.causes:
                evidence = canonical_json_bytes(cause.evidence).decode("ascii")
                execute(
                    connection,
                    point,
                    "INSERT OR IGNORE INTO collection_causes(id,membership_id,collection_run_id,"
                    "kind,source,condition,seed_work_id) VALUES(?,?,?,?,?,?,?)",
                    (
                        str(cause.cause_id),
                        str(cause.membership_id),
                        str(cause.run_id),
                        cause.kind.value,
                        evidence,
                        None,
                        None if cause.seed_work_id is None else str(cause.seed_work_id),
                    ),
                )
            for path in command.paths:
                work_ids = canonical_json_bytes(
                    tuple(str(value) for value in path.work_ids)
                ).decode("ascii")
                execute(
                    connection,
                    point,
                    "INSERT OR IGNORE INTO collection_paths(id,membership_id,collection_run_id,"
                    "direction,depth,work_ids_json) VALUES(?,?,?,?,?,?)",
                    (
                        str(path.path_id),
                        str(path.membership_id),
                        str(path.run_id),
                        None if path.direction is None else path.direction.value,
                        path.depth,
                        work_ids,
                    ),
                )
            point.before_commit()
            connection.commit()


__all__ = ("CollectionAcceptancePublisher",)
