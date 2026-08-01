from library_wp2_fixture import *


class LibraryRelationsWp2Tests(LibraryWp2Fixture):
    def test_references_and_cited_by_are_one_hop_and_preferred_version_based(self) -> None:
        references = self.library.references(work_id=self.target.work_id).items
        self.assertEqual([item.work_id for item in references], [
            self.ambiguous_one.work_id, self.ambiguous_two.work_id,
        ])
        self.assertEqual(self.library.references(work_version_id=self.preprint.id).items, ())
        cited_by = self.library.cited_by(self.target.work_id).items
        self.assertEqual({item.work_id for item in cited_by}, {
            self.formal.work_id, self.citing_formal.work_id,
        })
        source = next(item for item in cited_by if item.work_id == self.formal.work_id)
        self.assertEqual(source.work_version_id, self.formal.id)

    def test_cited_by_from_nonpreferred_version_returns_preferred_version(self) -> None:
        cited_by = self.library.cited_by(self.target.work_id).items
        citing = next(item for item in cited_by if item.work_id == self.citing_preprint.work_id)
        self.assertEqual(citing.work_version_id, self.citing_formal.id)
        self.assertTrue(citing.is_preferred)

    def test_empty_order_limit_and_selector_validation(self) -> None:
        self.assertEqual(self.library.search("no such value").items, ())
        all_items = self.library.search().items
        self.assertEqual(all_items, self.library.search().items)
        self.assertEqual(self.library.search(limit=2).items, all_items[:2])
        for bad_limit in (0, -1, True):
            with self.subTest(limit=bad_limit), self.assertRaises((TypeError, ValueError)):
                self.library.search(limit=bad_limit)
        with self.assertRaises(TypeError):
            self.library.search(limit=cast(int, 1.5))
        with self.assertRaisesRegex(ValueError, "exactly one"):
            self.library.exact_lookup()
        with self.assertRaisesRegex(ValueError, "exactly one"):
            self.library.exact_lookup(doi="10.1000/target", title="x")
        with self.assertRaisesRegex(ValueError, "canonical lowercase UUID"):
            self.library.exact_lookup(work_id="not-a-uuid")

    def test_safe_export_is_deterministic_and_has_no_backend_leakage(self) -> None:
        result = self.library.exact_lookup(
            work_id=self.target.work_id, include_light_content=True,
        )
        row = result.to_rows()[0]
        self.assertEqual(row["authors"], ["Ada Lovelace"])
        self.assertEqual(row["publisher"], "Science Press")
        self.assertEqual(row["venue"], "Journal of Energy")
        self.assertEqual(row["tags"], ["battery materials"])
        self.assertEqual(row["identifiers"], [
            {"namespace": "doi", "value": "10.1000/target"},
            {"namespace": "pmid", "value": "12345678"},
            {"namespace": "arxiv", "value": "2401.00001"},
        ])
        self.assertEqual(len(cast(list[object], row["light_content"])), 0)
        self.assertEqual(result.to_json(), result.to_json())
        self.assertEqual(json.loads(result.to_json()), list(result.to_rows()))
        self.assertEqual([json.loads(line) for line in result.to_jsonl().splitlines()], list(result.to_rows()))
        serialized = result.to_json()
        forbidden = (
            "SECRET-RECORD", "SECRET-HASH", "SECRET-OPENALEX-ID",
            "NEVER-EXPORT", "provider_record_id", "provenance_json", "storage_path",
            "sha256", "content_json", "raw_reference", "locator_json",
        )
        for value in forbidden:
            self.assertNotIn(value, serialized)

    def test_queries_accept_read_only_engine_without_mutating_rows(self) -> None:
        before = self.counts()
        self.library.exact_lookup(doi="10.1000/target", include_light_content=True)
        self.library.search("solid electrolyte", filters=LibraryFilters(publication_year=2024))
        self.library.references(work_id=self.target.work_id)
        self.library.cited_by(self.target.work_id)
        self.assertEqual(self.counts(), before)


if __name__ == "__main__":
    import unittest

    unittest.main()
