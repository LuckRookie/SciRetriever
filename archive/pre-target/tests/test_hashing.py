import importlib
import sys
import tempfile
from io import BytesIO
from pathlib import Path
from unittest import TestCase


REPOSITORY = Path(__file__).resolve().parents[1]
SRC = REPOSITORY / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

hashing = importlib.import_module("sciretriever.core.hashing")
DEFAULT_CHUNK_SIZE = hashing.DEFAULT_CHUNK_SIZE
sha256_bytes = hashing.sha256_bytes
sha256_file = hashing.sha256_file
sha256_stream = hashing.sha256_stream


class HashingTests(TestCase):
    def test_known_vectors(self) -> None:
        self.assertEqual(DEFAULT_CHUNK_SIZE, 1024 * 1024)
        self.assertEqual(
            sha256_bytes(b""),
            "e3b0c44298fc1c149afbf4c8996fb924"
            "27ae41e4649b934ca495991b7852b855",
        )
        self.assertEqual(
            sha256_bytes(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223"
            "b00361a396177a9cb410ff61f20015ad",
        )

    def test_stream_and_file_match_bytes(self) -> None:
        data = b"SciRetriever\x00" * 257
        expected = sha256_bytes(data)

        self.assertEqual(sha256_stream(BytesIO(data), chunk_size=17), expected)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "asset.bin"
            path.write_bytes(data)
            self.assertEqual(sha256_file(path, chunk_size=31), expected)

    def test_hash_is_independent_of_chunk_size(self) -> None:
        data = bytes(range(256)) * 19
        hashes = {
            sha256_stream(BytesIO(data), chunk_size=chunk_size)
            for chunk_size in (1, 7, 256, DEFAULT_CHUNK_SIZE)
        }
        self.assertEqual(hashes, {sha256_bytes(data)})

    def test_nonpositive_chunk_size_is_rejected(self) -> None:
        for chunk_size in (0, -1):
            with self.subTest(chunk_size=chunk_size), self.assertRaises(ValueError):
                sha256_stream(BytesIO(b"abc"), chunk_size=chunk_size)
            with self.subTest(chunk_size=chunk_size), self.assertRaises(ValueError):
                sha256_file("unused.bin", chunk_size=chunk_size)

    def test_missing_file_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            missing = Path(directory) / "missing.bin"
            with self.assertRaises(FileNotFoundError):
                sha256_file(missing)
