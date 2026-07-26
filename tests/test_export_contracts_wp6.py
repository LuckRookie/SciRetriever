from __future__ import annotations

import json
import os
from pathlib import Path
import tempfile
import unittest

from sciretriever.core.export import (
    ExportFormat,
    ExportMode,
    PackageExportDisposition,
    PackageExportRequest,
    PackageReferencePolicy,
    ReadingExportReferences,
    ReadingExportRequest,
    parse_export_request,
)
from sciretriever.core.export_errors import ExportContractError


WORK_ID = "00000000-0000-0000-0000-000000000001"
VERSION_ID = "00000000-0000-0000-0000-000000000002"
PACKAGE_HASH = "a" * 64


def _reading_payload() -> bytes:
    return json.dumps({
        "format": "jsonl",
        "mode": "reading",
        "references": "include",
        "selector": {"work_id": WORK_ID},
    }, sort_keys=True, separators=(",", ":")).encode("ascii")


def _package_payload(*, exact: bool = True) -> bytes:
    selector: dict[str, str | int] = {"work_version_id": VERSION_ID}
    if exact:
        selector.update(package_version=3, package_sha256=PACKAGE_HASH)
    return json.dumps({
        "format": "json",
        "mode": "package",
        "reference_policy": "always_include",
        "selector": selector,
    }, sort_keys=True, separators=(",", ":")).encode("ascii")


def run_contract_driver(root: Path) -> dict[str, str | int]:
    catalog = root / "catalog.sqlite"
    catalog.write_bytes(b"catalog")
    reading = parse_export_request(_reading_payload(), root / "reading.jsonl", catalog)
    package = parse_export_request(_package_payload(), root / "package.json", catalog)
    assert isinstance(reading, ReadingExportRequest)
    assert isinstance(package, PackageExportRequest)
    rejected = 0
    invalid = (
        {"mode": "reading", "format": "json", "references": "omit", "selector": {}},
        {"mode": "package", "format": "json", "reference_policy": "always_include",
         "selector": {"work_version_id": VERSION_ID, "package_version": 1}},
        {"mode": "package", "format": "json", "reference_policy": "always_include",
         "selector": {"work_version_id": VERSION_ID}, "include_references": False},
    )
    for value in invalid:
        try:
            parse_export_request(
                json.dumps(value, sort_keys=True, separators=(",", ":")).encode("ascii"),
                root / "rejected.json",
                catalog,
            )
        except (TypeError, ValueError):
            rejected += 1
    return {
        "package_disposition": PackageExportDisposition.REPLAYED.value,
        "package_hash": package.selector.package_sha256 or "",
        "package_references": package.reference_policy.value,
        "reading_mode": reading.mode.value,
        "reading_references": reading.references.value,
        "rejected": rejected,
    }


class ExportContractTests(unittest.TestCase):
    def test_happy_requests_are_typed_and_canonical(self) -> None:
        # Given
        with tempfile.TemporaryDirectory(prefix="sciretriever-export-contract-") as raw:
            root = Path(raw)
            catalog = root / "catalog.sqlite"
            catalog.write_bytes(b"catalog")

            # When
            reading = parse_export_request(_reading_payload(), root / "reading.jsonl", catalog)
            package = parse_export_request(_package_payload(), root / "package.json", catalog)

            # Then
            self.assertIsInstance(reading, ReadingExportRequest)
            self.assertIsInstance(package, PackageExportRequest)
            assert isinstance(reading, ReadingExportRequest)
            assert isinstance(package, PackageExportRequest)
            self.assertEqual(reading.mode, ExportMode.READING)
            self.assertEqual(reading.references, ReadingExportReferences.INCLUDE)
            self.assertEqual(reading.output_format, ExportFormat.JSONL)
            self.assertEqual(package.mode, ExportMode.PACKAGE)
            self.assertEqual(package.reference_policy, PackageReferencePolicy.ALWAYS_INCLUDE)
            self.assertEqual(package.selector.package_version, 3)
            self.assertEqual(package.selector.package_sha256, PACKAGE_HASH)
            self.assertEqual(reading.to_json_bytes(), _reading_payload())
            self.assertEqual(package.to_json_bytes(), _package_payload())
            for forbidden in (str(root), "catalog.sqlite", "SECRET-SENTINEL"):
                self.assertNotIn(forbidden, reading.to_json_bytes().decode("ascii"))
                self.assertNotIn(forbidden, package.to_json_bytes().decode("ascii"))

    def test_package_latest_selector_and_dispositions_are_explicit(self) -> None:
        # Given
        with tempfile.TemporaryDirectory(prefix="sciretriever-export-contract-") as raw:
            root = Path(raw)
            catalog = root / "catalog.sqlite"
            catalog.write_bytes(b"catalog")

            # When
            request = parse_export_request(_package_payload(exact=False), root / "package.json", catalog)

            # Then
            self.assertIsInstance(request, PackageExportRequest)
            assert isinstance(request, PackageExportRequest)
            self.assertIsNone(request.selector.package_version)
            self.assertIsNone(request.selector.package_sha256)
            self.assertEqual(
                tuple(value.value for value in PackageExportDisposition),
                ("replayed", "new_version"),
            )

    def test_incompatible_unknown_and_wrongly_typed_options_reject(self) -> None:
        # Given
        invalid = (
            {"mode": "reading", "format": "json", "references": "omit", "selector": {}},
            {"mode": "reading", "format": "json", "references": "omit",
             "selector": {"work_id": WORK_ID, "work_version_id": VERSION_ID}},
            {"mode": "reading", "format": "json", "references": False,
             "selector": {"work_id": WORK_ID}},
            {"mode": "package", "format": "json", "reference_policy": "always_include",
             "selector": {"work_version_id": VERSION_ID, "package_version": 1}},
            {"mode": "package", "format": "json", "reference_policy": "always_include",
             "selector": {"work_version_id": VERSION_ID, "package_sha256": PACKAGE_HASH}},
            {"mode": "package", "format": "jsonl", "reference_policy": "always_include",
             "selector": {"work_version_id": VERSION_ID}},
            {"mode": "package", "format": "json", "reference_policy": "always_include",
             "selector": {"work_version_id": VERSION_ID}, "include_references": True},
            {"mode": "reading", "format": "json", "references": "omit",
             "selector": {"work_id": WORK_ID}, "secret": "SECRET-SENTINEL"},
        )

        # When / Then
        with tempfile.TemporaryDirectory(prefix="sciretriever-export-contract-") as raw:
            root = Path(raw)
            catalog = root / "catalog.sqlite"
            catalog.write_bytes(b"catalog")
            for value in invalid:
                with self.subTest(value=value):
                    payload = json.dumps(value, sort_keys=True, separators=(",", ":")).encode("ascii")
                    with self.assertRaises((TypeError, ValueError)):
                        parse_export_request(payload, root / "output.json", catalog)

    def test_hostile_values_and_duplicate_keys_do_not_escape_in_errors(self) -> None:
        # Given
        sentinel = "SECRET-SENTINEL-/runtime/private/catalog.sqlite"
        payloads = (
            json.dumps({"mode": sentinel}).encode("utf-8"),
            f'{{"mode":"reading","mode":"{sentinel}"}}'.encode("utf-8"),
            json.dumps({
                "mode": "reading", "format": "json", "references": "omit",
                "selector": {"work_id": WORK_ID}, sentinel: True,
            }).encode("utf-8"),
        )

        # When / Then
        with tempfile.TemporaryDirectory(prefix="sciretriever-export-contract-") as raw:
            root = Path(raw)
            catalog = root / "catalog.sqlite"
            catalog.write_bytes(b"catalog")
            for payload in payloads:
                with self.subTest(payload=payload):
                    with self.assertRaises((TypeError, ValueError)) as raised:
                        parse_export_request(payload, root / "output.json", catalog)
                    self.assertNotIn(sentinel, str(raised.exception))

    def test_unsafe_symlink_hardlink_and_sidecar_destinations_reject(self) -> None:
        # Given
        with tempfile.TemporaryDirectory(prefix="sciretriever-export-contract-") as raw:
            root = Path(raw)
            catalog = root / "catalog.sqlite"
            catalog.write_bytes(b"catalog")
            ordinary = root / "ordinary.json"
            ordinary.write_bytes(b"existing")
            hardlink = root / "ordinary-hardlink.json"
            os.link(ordinary, hardlink)
            symlink = root / "ordinary-symlink.json"
            symlink.symlink_to(ordinary)
            unsafe = (
                catalog, Path(f"{catalog}-wal"), Path(f"{catalog}-shm"),
                Path(f"{catalog}-journal"), hardlink, symlink, root / "missing" / "output.json",
            )

            # When / Then
            for destination in unsafe:
                with self.subTest(destination=destination):
                    with self.assertRaises((OSError, ValueError)):
                        parse_export_request(_reading_payload(), destination, catalog)

    def test_catalog_alias_precedes_generic_link_classification(self) -> None:
        with tempfile.TemporaryDirectory(prefix="sciretriever-export-contract-") as raw:
            root = Path(raw)
            catalog = root / "catalog.sqlite"
            catalog.write_bytes(b"catalog")
            catalog_hardlink = root / "catalog-hardlink"
            os.link(catalog, catalog_hardlink)
            ordinary = root / "ordinary"
            ordinary.write_bytes(b"ordinary")
            ordinary_hardlink = root / "ordinary-hardlink"
            os.link(ordinary, ordinary_hardlink)

            with self.assertRaisesRegex(ExportContractError, "catalog storage"):
                parse_export_request(_reading_payload(), catalog_hardlink, catalog)
            with self.assertRaisesRegex(ExportContractError, "single-link regular file"):
                parse_export_request(_reading_payload(), ordinary_hardlink, catalog)

    def test_export_contract_error_accepts_normal_traceback_assignment(self) -> None:
        error = ExportContractError("stable export failure")

        try:
            raise error
        except ExportContractError as captured:
            captured.__traceback__ = captured.__traceback__

        self.assertEqual(str(error), "stable export failure")

    def test_contract_driver_reports_literal_invariants(self) -> None:
        # Given / When
        with tempfile.TemporaryDirectory(prefix="sciretriever-export-driver-") as raw:
            result = run_contract_driver(Path(raw))

        # Then
        self.assertEqual(result, {
            "package_disposition": "replayed",
            "package_hash": PACKAGE_HASH,
            "package_references": "always_include",
            "reading_mode": "reading",
            "reading_references": "include",
            "rejected": 3,
        })


if __name__ == "__main__":
    unittest.main()
