import hashlib
from pathlib import Path
import sys
from unittest import TestCase
from uuid import uuid4


REPOSITORY = Path(__file__).resolve().parents[1]
SRC = REPOSITORY / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from sciretriever.core.enums import AssetRole
from sciretriever.errors import NormalizationError
from sciretriever.normalization import NormalizationParameters, RawNormalizationInput, normalize_inputs


class NormalizationBoundTests(TestCase):
    def value(self, payload: bytes) -> RawNormalizationInput:
        return RawNormalizationInput(str(uuid4()), AssetRole.XML, "application/xml", hashlib.sha256(payload).hexdigest(), payload)

    def test_malformed_entity_and_bounds_fail_without_output(self) -> None:
        cases = (
            (b"<broken>", NormalizationParameters()),
            (b'<!DOCTYPE a [<!ENTITY x "bad">]><a>&x;</a>', NormalizationParameters()),
            (b"<a>too long</a>", NormalizationParameters(max_text_characters=2)),
            (b"<a>bytes</a>", NormalizationParameters(max_input_bytes=2)),
        )
        for payload, parameters in cases:
            with self.subTest(payload=payload), self.assertRaises(NormalizationError):
                normalize_inputs((self.value(payload),), parameters)

    def test_depth_and_element_bounds_are_independent(self) -> None:
        cases = (
            (b"<a><b><c>text</c></b></a>", NormalizationParameters(max_depth=2)),
            (b"<a><b/><c/></a>", NormalizationParameters(max_elements=2)),
        )
        for payload, parameters in cases:
            with self.subTest(payload=payload), self.assertRaises(NormalizationError):
                normalize_inputs((self.value(payload),), parameters)


if __name__ == "__main__":
    import unittest
    unittest.main()
