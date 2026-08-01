from __future__ import annotations

import os
from collections.abc import Callable

from sciretriever.batching.api import ImportAcceptanceCommand
from sciretriever.bibliography.api import ReferenceSetFact, TagSetFact
from sciretriever.kernel import BoundaryError, canonical_json_bytes
from sciretriever.literature_store.sqlite.publisher_support import (
    StalePublicationError,
    StatementFailpoint,
    execute,
    immediate,
    publish_bibliography,
)


def _references(connection, point: StatementFailpoint, fact: ReferenceSetFact) -> None:
    execute(
        connection,
        point,
        "INSERT INTO reference_sets(id,work_version_id,revision,complete) VALUES(?,?,?,1)",
        (str(fact.set_id), str(fact.work_version_id), fact.revision),
    )
    for ordinal, member in enumerate(fact.members):
        payload = canonical_json_bytes(member.reference).decode("ascii")
        execute(
            connection,
            point,
            "INSERT INTO unresolved_references(id,reference_set_id,ordinal,raw_text,"
            "reference_json) VALUES(?,?,?,?,?)",
            (str(member.member_id), str(fact.set_id), ordinal, member.raw_text, payload),
        )


def _tags(connection, point: StatementFailpoint, fact: TagSetFact) -> None:
    execute(
        connection,
        point,
        "INSERT INTO tag_sets(id,work_version_id,revision,complete) VALUES(?,?,?,1)",
        (str(fact.set_id), str(fact.work_version_id), fact.revision),
    )
    for member in fact.members:
        evidence = canonical_json_bytes(member.evidence).decode("ascii")
        execute(
            connection,
            point,
            "INSERT INTO tag_members(id,tag_set_id,name,evidence_json) VALUES(?,?,?,?)",
            (str(member.member_id), str(fact.set_id), member.name, evidence),
        )


class ImportAcceptancePublisher:
    def __init__(
        self,
        catalog_path: str | os.PathLike[str],
        *,
        failpoint: Callable[[str], None] | None = None,
    ) -> None:
        self._catalog_path = catalog_path
        self._failpoint = failpoint

    def publish(self, command: ImportAcceptanceCommand) -> None:
        expected = command.bibliography.work_version_id
        if any(
            value != expected
            for value in (
                command.references.work_version_id,
                command.tags.work_version_id,
                command.record.work_version_id,
            )
        ):
            raise StalePublicationError("import acceptance identities differ")
        try:
            result_json = canonical_json_bytes(command.record.result_envelope().canonical()).decode(
                "ascii"
            )
        except BoundaryError as error:
            raise StalePublicationError("import result envelope is invalid") from error
        point = StatementFailpoint(self._failpoint)
        with immediate(self._catalog_path) as connection:
            publish_bibliography(connection, point, command.bibliography)
            _references(connection, point, command.references)
            _tags(connection, point, command.tags)
            record = command.record
            cursor = execute(
                connection,
                point,
                "UPDATE batch_targets SET result_json=? WHERE batch_run_id=? AND target_id=? "
                "AND input_ordinal=? AND target_kind='import-record' AND result_json IS NULL",
                (
                    result_json,
                    str(record.batch_run_id),
                    str(record.work_version_id),
                    record.input_ordinal,
                ),
            )
            if cursor.rowcount != 1:
                raise StalePublicationError("import target changed")
            point.before_commit()
            connection.commit()


__all__ = ("ImportAcceptancePublisher",)
