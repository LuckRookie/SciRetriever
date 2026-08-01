from __future__ import annotations

import json

from cli_wp2_fixture import *


class ReadingExportWp6Tests(CliWp2Fixture):
    def setUp(self):
        self.temporary = TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        self.catalog = self.base / "catalog.sqlite"
        engine = create_catalog_engine(self.catalog, allow_repository_write=True)
        initialize_catalog(engine)
        engine.dispose()

    def seed_reference_graph(self):
        engine = open_catalog_engine(self.catalog, allow_repository_write=True)
        works = WorkRepository(engine)
        source = works.ingest_version(
            provider="provider-secret", provider_record_id="SOURCE-SECRET",
            title="Source", doi="10.1000/source", version_class="formal_publication",
        )
        cited = works.ingest_version(
            provider="provider-secret", provider_record_id="CITED-SECRET",
            title="Cited", doi="10.1000/cited", version_class="formal_publication",
        )
        references = ReferenceRepository(engine)
        references.add(source.id, 0, "resolved backend text", cited_work_id=cited.work_id)
        references.add(source.id, 1, "duplicate resolved text", cited_work_id=cited.work_id)
        references.add(source.id, 2, "cycle text", cited_work_id=source.work_id)
        hostile = "  Citation\u0000\n title  " + ("x" * 3000)
        references.add(
            source.id, 3, hostile,
            identifier=Identifier("doi", "10.1000/unresolved"),
        )
        references.add(
            source.id, 4, hostile,
            identifier=Identifier("doi", "10.1000/unresolved"),
        )
        engine.dispose()
        return source, cited

    def test_export_includes_ordered_bounded_safe_references_only_when_requested(self):
        # Given
        source, cited = self.seed_reference_graph()
        default_output = self.base / "default.json"
        referenced_output = self.base / "referenced.json"

        # When
        default_result = self.invoke([
            "library", "export", "--mode", "reading", "--catalog", str(self.catalog),
            "--work-id", source.work_id, "--output", str(default_output),
        ])
        referenced_result = self.invoke([
            "library", "export", "--mode", "reading", "--catalog", str(self.catalog),
            "--work-id", source.work_id, "--output", str(referenced_output),
            "--include-references",
        ])

        # Then
        self.assertEqual((default_result[0], default_result[2]), (0, ""))
        self.assertEqual((referenced_result[0], referenced_result[2]), (0, ""))
        default_row = json.loads(default_output.read_bytes())[0]
        referenced_bytes = referenced_output.read_bytes()
        referenced_row = json.loads(referenced_bytes)[0]
        self.assertNotIn("references", default_row)
        self.assertEqual(referenced_row["references"][0], {
            "citation_text": None,
            "identifiers": [{"namespace": "doi", "value": "10.1000/cited"}],
            "reference_order": 0,
            "resolved_work_id": cited.work_id,
        })
        self.assertEqual(len(referenced_row["references"]), 2)
        unresolved = referenced_row["references"][1]
        self.assertEqual(unresolved["reference_order"], 3)
        self.assertIsNone(unresolved["resolved_work_id"])
        self.assertEqual(
            unresolved["identifiers"],
            [{"namespace": "doi", "value": "10.1000/unresolved"}],
        )
        self.assertLessEqual(len(unresolved["citation_text"]), 2048)
        self.assertNotIn("\u0000", unresolved["citation_text"])
        for forbidden in (
            b"SOURCE-SECRET", b"CITED-SECRET", b"provider-secret", b"raw_reference",
            b"provenance", b"source_artifact_id", b"locator_json", b"storage_path",
        ):
            self.assertNotIn(forbidden, referenced_bytes)

    def test_jsonl_reference_export_is_deterministic_and_has_no_temporary_residue(self):
        # Given
        source, _ = self.seed_reference_graph()
        first = self.base / "first.jsonl"
        second = self.base / "second.jsonl"

        # When
        results = tuple(self.invoke([
            "library", "export", "--mode", "reading", "--catalog", str(self.catalog),
            "--work-version-id", source.id, "--output", str(destination),
            "--format", "jsonl", "--include-references",
        ]) for destination in (first, second))

        # Then
        self.assertEqual(tuple((code, error) for code, _, error in results), ((0, ""), (0, "")))
        self.assertEqual(first.read_bytes(), second.read_bytes())
        self.assertEqual(len(first.read_text(encoding="utf-8").splitlines()), 1)
        self.assertEqual(tuple(self.base.glob(".*.tmp")), ())

    def test_reference_export_rejects_non_catalog_symlink_and_hardlink_targets(self):
        # Given
        source, _ = self.seed_reference_graph()
        ordinary = self.base / "ordinary.json"
        ordinary.write_bytes(b"preserved")
        hardlink = self.base / "hardlink.json"
        os.link(ordinary, hardlink)
        symlink = self.base / "symlink.json"
        symlink.symlink_to(ordinary)

        # When
        results = tuple(self.invoke([
            "library", "export", "--mode", "reading", "--catalog", str(self.catalog),
            "--work-id", source.work_id, "--output", str(destination),
            "--include-references",
        ]) for destination in (hardlink, symlink))

        # Then
        self.assertEqual(tuple((code, output) for code, output, _ in results), ((1, ""), (1, "")))
        self.assertEqual(ordinary.read_bytes(), b"preserved")
        self.assertEqual(tuple(self.base.glob(".*.tmp")), ())


if __name__ == "__main__":
    import unittest
    unittest.main()
