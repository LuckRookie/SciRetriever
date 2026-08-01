from __future__ import annotations

import contextlib
import io
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch
from uuid import uuid4

from sciretriever.catalog import create_catalog_engine, initialize_catalog
from sciretriever.cli.main import main


class CurationCliTests(unittest.TestCase):
    temporary: TemporaryDirectory[str]
    catalog_path: Path
    work_a: str
    work_b: str
    version_a: str
    version_b: str
    review_id: str
    tag_id: str
    author_a: str
    author_b: str

    def setUp(self) -> None:
        guard = patch("sciretriever.catalog.engine.require_staged_write_override")
        guard.start()
        self.addCleanup(guard.stop)
        self.temporary = TemporaryDirectory(prefix="sciretriever-cli-curation-wp6-")
        self.addCleanup(self.temporary.cleanup)
        self.catalog_path = Path(self.temporary.name) / "catalog.sqlite"
        self.work_a, self.work_b = str(uuid4()), str(uuid4())
        self.version_a, self.version_b = str(uuid4()), str(uuid4())
        self.review_id, self.tag_id = str(uuid4()), str(uuid4())
        self.author_a, self.author_b = str(uuid4()), str(uuid4())
        catalog = create_catalog_engine(self.catalog_path)
        initialize_catalog(catalog)
        with catalog.transaction() as connection:
            connection.exec_driver_sql(
                "INSERT INTO works (id) VALUES (?),(?)", (self.work_a, self.work_b)
            )
            connection.exec_driver_sql(
                "INSERT INTO work_versions "
                "(id,work_id,version_class,normalized_title,title,language,stable_version_key) "
                "VALUES (?,?,'preprint','alpha','Alpha','en','preprint'),"
                "(?,?,'formal_publication','beta','Beta','en','formal')",
                (self.version_a, self.work_a, self.version_b, self.work_b),
            )
            connection.exec_driver_sql(
                "INSERT INTO identity_reviews "
                "(id,identifiers_json,candidate_work_ids_json,reason) VALUES (?,'[]',?,'manual')",
                (self.review_id, json.dumps(sorted((self.work_a, self.work_b)), separators=(",", ":"))),
            )
            connection.exec_driver_sql(
                "INSERT INTO tags (id,canonical_name,normalized_name) VALUES (?,'cli-tag','cli-tag')",
                (self.tag_id,),
            )
            connection.exec_driver_sql(
                "INSERT INTO authors (id,display_name,normalized_name,orcid) VALUES "
                "(?,'A','a',NULL),(?,'B','b','0000-0002-1825-0097')",
                (self.author_a, self.author_b),
            )
        catalog.dispose()

    def invoke(self, *arguments: str) -> tuple[int, str, str]:
        stdout, stderr = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            result = main(["--no-config", "library", *arguments])
        return result, stdout.getvalue(), stderr.getvalue()

    def catalog_args(self) -> tuple[str, str]:
        return "--catalog", str(self.catalog_path)

    def test_every_curation_command_has_help(self) -> None:
        commands = (
            ("review",), ("merge-work",), ("regroup-version",),
            ("preferred", "set"), ("preferred", "clear"),
            ("metadata", "set"), ("metadata", "clear"),
            ("tag", "add"), ("tag", "remove"), ("author", "merge"),
            ("audit",), ("undo",),
        )
        for command in commands:
            with self.subTest(command=command), contextlib.redirect_stdout(io.StringIO()):
                with self.assertRaises(SystemExit) as raised:
                    main(["--no-config", "library", *command, "--help"])
            self.assertEqual(raised.exception.code, 0)

    def test_review_merge_audit_and_cross_invocation_undo(self) -> None:
        reviewed = self.invoke(
            "review", *self.catalog_args(), "--review-id", self.review_id,
            "--decision", "confirmed", "--evidence", "decision=user_confirmed",
        )
        merged = self.invoke(
            "merge-work", *self.catalog_args(), "--source-work-id", self.work_a,
            "--target-work-id", self.work_b, "--evidence", "decision=user_confirmed",
        )

        self.assertEqual((reviewed[0], merged[0]), (0, 0), reviewed[2] + merged[2])
        merge_output = json.loads(merged[1])
        self.assertEqual(merge_output["action"], "merge_work")
        self.assertEqual(merge_output["subject_id"], self.work_a)
        self.assertEqual(list(merge_output), sorted(merge_output))
        audited = self.invoke("audit", *self.catalog_args(), "--operation-id", merge_output["operation_id"])
        self.assertEqual(audited[0], 0, audited[2])
        self.assertEqual(json.loads(audited[1])["operation_id"], merge_output["operation_id"])

        undone = self.invoke(
            "undo", *self.catalog_args(), "--operation-id", merge_output["operation_id"]
        )

        self.assertEqual(undone[0], 0, undone[2])
        self.assertEqual(json.loads(undone[1])["result"], "undone")

    def test_remaining_mutations_reach_the_single_owner(self) -> None:
        commands = (
            ("regroup-version", "--work-version-id", self.version_a, "--target-work-id", self.work_b,
             "--evidence", "decision=user_confirmed"),
            ("preferred", "set", "--work-id", self.work_b, "--work-version-id", self.version_b),
            ("preferred", "clear", "--work-id", self.work_b),
            ("metadata", "set", "--work-version-id", self.version_b, "--field", "language", "--value", "fr"),
            ("metadata", "clear", "--work-version-id", self.version_b, "--field", "language"),
            ("tag", "add", "--work-id", self.work_b, "--tag-id", self.tag_id),
            ("tag", "remove", "--work-id", self.work_b, "--tag-id", self.tag_id),
            ("author", "merge", "--source-author-id", self.author_a, "--target-author-id", self.author_b),
        )
        for command in commands:
            with self.subTest(command=command):
                result, stdout, stderr = self.invoke(*command, *self.catalog_args())
                self.assertEqual(result, 0, stderr)
                self.assertEqual(json.loads(stdout)["result"], "applied")

    def test_invalid_input_conflict_and_stale_undo_have_distinct_safe_exits(self) -> None:
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as invalid:
            main(["--no-config", "library", "merge-work", *self.catalog_args(),
                  "--source-work-id", "bad", "--target-work-id", self.work_b,
                  "--evidence", "decision=user_confirmed"])
        self.assertEqual(invalid.exception.code, 2)
        conflict = self.invoke(
            "merge-work", *self.catalog_args(), "--source-work-id", self.work_a,
            "--target-work-id", self.work_a, "--evidence", "decision=user_confirmed",
        )
        self.assertEqual(conflict[0], 3)
        self.assertEqual(conflict[1], "")
        self.assertEqual(json.loads(conflict[2]), {"error": "operation_conflict"})

        merged = self.invoke(
            "merge-work", *self.catalog_args(), "--source-work-id", self.work_a,
            "--target-work-id", self.work_b, "--evidence", "decision=user_confirmed",
        )
        operation_id = json.loads(merged[1])["operation_id"]
        self.assertEqual(self.invoke("undo", *self.catalog_args(), "--operation-id", operation_id)[0], 0)
        stale = self.invoke("undo", *self.catalog_args(), "--operation-id", operation_id)
        self.assertEqual(stale[0], 3)
        self.assertEqual(json.loads(stale[2]), {"error": "operation_conflict"})


if __name__ == "__main__":
    unittest.main()
