from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
import hashlib
from uuid import uuid4
from sciretriever.catalog import CurationOperationOwner, open_catalog_engine
from sciretriever.catalog.curation import (
    CurationAlreadyUndoneError,
    CurationAuditCorruptError,
    CurationBusyError,
    CurationBoundaryError,
    CurationNoChangeError,
    CurationRequest,
    CurationStaleError,
)
from sciretriever.core.curation import CurationOperation, ReviewDecision
from sciretriever.core.snapshots import SafeSnapshot

from curation_wp6_fixture import CurationCatalogCase, NoChangeProbeHandler


class CurationOperationTests(CurationCatalogCase):
    def request(self) -> CurationRequest:
        return CurationRequest(
            handler=self.handler,
            review_decision=ReviewDecision.NOT_REQUIRED,
            evidence=SafeSnapshot.from_pairs((("decision", "representative"),)),
        )

    def test_apply_and_undo_are_atomic_and_reconstructable(self) -> None:
        owner = CurationOperationOwner(self.catalog)

        applied = owner.apply(self.request())
        undone = owner.undo(applied.id, self.handler)

        self.assertEqual(applied.operation.before.to_dict(), {"value": 3})
        self.assertEqual(applied.operation.after.to_dict(), {"value": 33})
        self.assertEqual(undone.operation.undo_of, applied.id)
        with self.catalog.connect() as connection:
            rows = connection.exec_driver_sql(
                "SELECT id, action, result, undo_of_operation_id, operation_sha256 "
                "FROM curation_operations ORDER BY occurred_at, id"
            ).all()
            values = connection.exec_driver_sql(
                "SELECT value FROM curation_probe ORDER BY family"
            ).scalars().all()
        self.assertEqual(values, [1, 2])
        self.assertEqual(rows[0], (applied.id, "set_preferred", "applied", None, applied.operation.operation_sha256))
        self.assertEqual(rows[1], (undone.id, "undo", "undone", applied.id, undone.operation.operation_sha256))

    def test_stale_undo_has_zero_mutation(self) -> None:
        owner = CurationOperationOwner(self.catalog)
        applied = owner.apply(self.request())
        with self.catalog.transaction() as connection:
            connection.exec_driver_sql(
                "UPDATE curation_probe SET value=CASE family WHEN 'alpha' THEN 12 ELSE 21 END"
            )
        before = self.state()

        with self.catalog.connect() as connection:
            self.assertEqual(self.handler.capture(connection).snapshot.to_dict(), {"value": 33})

        with self.assertRaises(CurationStaleError):
            owner.undo(applied.id, self.handler)

        self.assertEqual(self.state(), before)

    def test_corrupt_audit_has_zero_mutation(self) -> None:
        owner = CurationOperationOwner(self.catalog)
        operation_id = str(uuid4())
        with self.catalog.transaction() as connection:
            connection.exec_driver_sql(
                "INSERT INTO curation_operations "
                "(id, action, subject_kind, subject_id, before_snapshot_json, before_sha256, "
                "after_snapshot_json, after_sha256, stale_guard_sha256, evidence_json, "
                "review_decision, result, operation_sha256, occurred_at) VALUES "
                "(?, 'set_preferred', 'work', ?, '{\"value\":3}', ?, "
                "'{\"value\":33}', ?, ?, '{\"decision\":\"representative\"}', "
                "'not_required', 'applied', ?, '2026-07-25T00:00:00.000Z')",
                (operation_id, self.handler.subject_id, "a" * 64, "b" * 64, "a" * 64, "f" * 64),
            )
        before = self.state()

        with self.assertRaises(CurationAuditCorruptError):
            owner.undo(operation_id, self.handler)

        self.assertEqual(self.state(), before)

    def test_duplicate_key_and_noncanonical_audit_json_have_zero_mutation(self) -> None:
        owner = CurationOperationOwner(self.catalog)
        before_snapshot = SafeSnapshot.from_pairs((("value", 3),))
        after_snapshot = SafeSnapshot.from_pairs((("value", 33),))
        operation = CurationOperation.create(
            action=self.handler.action,
            subject_kind=self.handler.subject_kind,
            subject_id=self.handler.subject_id,
            before=before_snapshot,
            after=after_snapshot,
            review_decision=ReviewDecision.NOT_REQUIRED,
        )
        before_hash = hashlib.sha256(b'[["alpha",1],["beta",2]]').hexdigest()
        after_hash = hashlib.sha256(b'[["alpha",11],["beta",22]]').hexdigest()
        cases = (
            ("before_snapshot_json", '{"value":999,"value":3}'),
            ("before_snapshot_json", '{ "value":3}'),
            ("after_snapshot_json", '{"value":999,"value":33}'),
            ("after_snapshot_json", '{ "value":33}'),
            ("evidence_json", '{"decision":"wrong","decision":"representative"}'),
            ("evidence_json", '{ "decision":"representative"}'),
        )
        for field_name, payload in cases:
            with self.subTest(field_name=field_name, payload=payload):
                operation_id = str(uuid4())
                values = {
                    "before_snapshot_json": '{"value":3}',
                    "after_snapshot_json": '{"value":33}',
                    "evidence_json": '{"decision":"representative"}',
                }
                values[field_name] = payload
                with self.catalog.transaction() as connection:
                    connection.exec_driver_sql(
                        "UPDATE curation_probe SET value=CASE family WHEN 'alpha' THEN 11 ELSE 22 END"
                    )
                    connection.exec_driver_sql("PRAGMA ignore_check_constraints=ON")
                    connection.exec_driver_sql(
                        "INSERT INTO curation_operations "
                        "(id, action, subject_kind, subject_id, before_snapshot_json, before_sha256, "
                        "after_snapshot_json, after_sha256, stale_guard_sha256, evidence_json, "
                        "review_decision, result, operation_sha256, occurred_at) VALUES "
                        "(?, 'set_preferred', 'work', ?, ?, ?, ?, ?, ?, ?, "
                        "'not_required', 'applied', ?, '2026-07-25T00:00:00.000Z')",
                        (
                            operation_id, self.handler.subject_id,
                            values["before_snapshot_json"], before_hash,
                            values["after_snapshot_json"], after_hash, before_hash,
                            values["evidence_json"], operation.operation_sha256,
                        ),
                    )
                    connection.exec_driver_sql("PRAGMA ignore_check_constraints=OFF")
                before = self.state()

                with self.assertRaises(CurationAuditCorruptError):
                    owner.undo(operation_id, self.handler)

                self.assertEqual(self.state(), before)

    def test_unchanged_complete_footprint_rejects_without_audit(self) -> None:
        owner = CurationOperationOwner(self.catalog)
        unchanged = NoChangeProbeHandler(
            self.handler.action, self.handler.subject_kind, self.handler.subject_id
        )
        before = self.state()

        with self.assertRaises(CurationNoChangeError):
            owner.apply(replace(self.request(), handler=unchanged))

        self.assertEqual(self.state(), before)

    def test_concurrent_undo_appends_one_child(self) -> None:
        owner = CurationOperationOwner(self.catalog)
        applied = owner.apply(self.request())

        def undo_once() -> str:
            try:
                owner.undo(applied.id, self.handler)
            except CurationAlreadyUndoneError:
                return "already_undone"
            return "undone"

        with ThreadPoolExecutor(max_workers=2) as executor:
            outcomes = sorted(executor.map(lambda _: undo_once(), range(2)))

        self.assertEqual(outcomes, ["already_undone", "undone"])
        with self.catalog.connect() as connection:
            children = connection.exec_driver_sql(
                "SELECT count(*) FROM curation_operations WHERE undo_of_operation_id=?",
                (applied.id,),
            ).scalar_one()
        self.assertEqual(children, 1)

    def test_busy_is_distinct_from_stale(self) -> None:
        contender = open_catalog_engine(self.catalog.path, busy_timeout_ms=0)
        self.addCleanup(contender.dispose)
        owner = CurationOperationOwner(contender)

        before = self.state()
        with self.catalog.critical_transaction():
            with self.assertRaises(CurationBusyError):
                owner.apply(self.request())
        self.assertEqual(self.state(), before)

    def test_malformed_subject_and_handler_mismatch_have_zero_mutation(self) -> None:
        owner = CurationOperationOwner(self.catalog)
        before = self.state()

        with self.assertRaises(ValueError):
            owner.apply(replace(self.request(), handler=replace(self.handler, subject_id="invalid")))

        applied = owner.apply(self.request())
        applied_state = self.state()
        with self.assertRaises(CurationBoundaryError):
            owner.undo(applied.id, replace(self.handler, subject_id=str(uuid4())))
        self.assertEqual(self.state(), applied_state)
        self.assertNotEqual(applied_state, before)


if __name__ == "__main__":
    import unittest

    unittest.main()
