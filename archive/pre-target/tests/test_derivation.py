import importlib
import json
from pathlib import Path
import sys
from unittest import TestCase


REPOSITORY = Path(__file__).resolve().parents[1]
SRC = REPOSITORY / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

derivation = importlib.import_module("sciretriever.core.derivation")
ids = importlib.import_module("sciretriever.core.ids")


class DerivationTests(TestCase):
    def test_mapping_order_is_canonical(self) -> None:
        first = {"producer": "normalizer", "parameters": {"pages": 20, "units": 200}}
        second = {"parameters": {"units": 200, "pages": 20}, "producer": "normalizer"}

        self.assertEqual(derivation.canonical_json_bytes(first), derivation.canonical_json_bytes(second))
        self.assertEqual(derivation.canonical_sha256(first), derivation.canonical_sha256(second))
        self.assertEqual(
            derivation.stable_derivation_id("processing_run", first),
            derivation.stable_derivation_id("processing_run", second),
        )
        self.assertEqual(
            json.loads(derivation.canonical_json_bytes(first).decode("ascii")), first
        )

    def test_material_key_changes_change_hash_and_id(self) -> None:
        base = {"producer_version": "1", "parameters": {"pages": 20}, "inputs": ["a", "b"]}
        changed = (
            {**base, "producer_version": "2"},
            {**base, "parameters": {"pages": 21}},
            {**base, "inputs": ["b", "a"]},
        )
        baseline_hash = derivation.canonical_sha256(base)
        baseline_id = derivation.stable_derivation_id("normalized_artifact", base)
        ids.validate_uuid(baseline_id)

        for value in changed:
            with self.subTest(value=value):
                self.assertNotEqual(derivation.canonical_sha256(value), baseline_hash)
                self.assertNotEqual(
                    derivation.stable_derivation_id("normalized_artifact", value), baseline_id
                )

    def test_ascii_compact_json_and_tuple_arrays(self) -> None:
        payload = derivation.canonical_json_bytes({"name": "Caf\u00e9", "items": (1, 2)})
        self.assertEqual(payload, b'{"items":[1,2],"name":"Caf\\u00e9"}')

    def test_invalid_json_values_and_kinds_fail(self) -> None:
        for value in (float("nan"), {"bad": object()}, {1, 2}):
            with self.subTest(value=value), self.assertRaises(ValueError):
                derivation.canonical_json_bytes(value)
        for kind in ("", "ProcessingRun", "processing-run", " processing_run"):
            with self.subTest(kind=kind), self.assertRaises(ValueError):
                derivation.stable_derivation_id(kind, {})
        with self.assertRaises(TypeError):
            derivation.stable_derivation_id(1, {})


if __name__ == "__main__":
    import unittest

    unittest.main()
