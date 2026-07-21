import os
import sys
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase, mock


REPOSITORY = Path(__file__).resolve().parents[1]
SRC = REPOSITORY / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from sciretriever.core.contracts import (
    CandidateMetadata,
    DownloadManifestEntry,
    Identifier,
    Provenance,
)
from sciretriever.discovery.manifest import write_manifest


def entry(value="10.1/x"):
    return DownloadManifestEntry(
        (Identifier("doi", value),),
        CandidateMetadata("Title", "Abstract"),
        ("label",),
        False,
        False,
        None,
        Provenance(
            ("crossref",),
            "2026-07-20T12:00:00Z",
            "00000000-0000-4000-8000-000000000001",
        ),
    )


class ManifestTests(TestCase):
    def setUp(self):
        self.temporary_directory = TemporaryDirectory()
        self.addCleanup(self.temporary_directory.cleanup)
        self.directory = Path(self.temporary_directory.name)
        self.output = self.directory / "manifest.jsonl"

    def test_output_round_trip_and_empty_manifest(self):
        entries = (entry("10.1/b"), entry("10.1/a"))
        write_manifest(entries, self.output)
        raw = self.output.read_bytes()
        self.assertTrue(raw.endswith(b"\n"))
        self.assertEqual(
            tuple(DownloadManifestEntry.from_json_line(line) for line in raw.decode().splitlines()),
            entries,
        )
        write_manifest((), self.output)
        self.assertEqual(self.output.read_bytes(), b"")

    def test_parent_must_exist(self):
        with self.assertRaises(FileNotFoundError):
            write_manifest((), self.directory / "missing" / "manifest.jsonl")

    def test_serialization_failure_preserves_existing_and_cleans_temp(self):
        self.output.write_bytes(b"existing\n")
        with mock.patch.object(
            DownloadManifestEntry, "to_json_line", side_effect=RuntimeError("serialize failed")
        ):
            with self.assertRaisesRegex(RuntimeError, "serialize failed"):
                write_manifest((entry(),), self.output)
        self.assertEqual(self.output.read_bytes(), b"existing\n")
        self.assertEqual(tuple(self.directory.glob(".manifest.jsonl.*.tmp")), ())

    def test_replace_failure_preserves_existing_and_cleans_temp(self):
        self.output.write_bytes(b"existing\n")
        with mock.patch("sciretriever.discovery.manifest.os.replace", side_effect=OSError("replace failed")):
            with self.assertRaisesRegex(OSError, "replace failed"):
                write_manifest((entry(),), self.output)
        self.assertEqual(self.output.read_bytes(), b"existing\n")
        self.assertEqual(tuple(self.directory.glob(".manifest.jsonl.*.tmp")), ())

    def test_temp_is_restrictive_and_no_residue_remains(self):
        real_replace = os.replace
        observed_modes = []

        def inspect_replace(source, destination):
            observed_modes.append(Path(source).stat().st_mode & 0o777)
            real_replace(source, destination)

        with mock.patch("sciretriever.discovery.manifest.os.replace", side_effect=inspect_replace):
            write_manifest((entry(),), self.output)
        self.assertEqual(observed_modes, [0o600])
        self.assertEqual(tuple(self.directory.glob(".manifest.jsonl.*.tmp")), ())


if __name__ == "__main__":
    import unittest

    unittest.main()
