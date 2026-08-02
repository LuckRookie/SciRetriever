from __future__ import annotations

import unittest

from pydantic import ValidationError

from sciretriever.model.access import (
    BoundedByteStream,
    Header,
    TransportRequest,
    TransportResponse,
)


class TargetAccessModelTests(unittest.TestCase):
    def test_access_models_are_frozen_strict_round_trip_and_url_neutral(self) -> None:
        header = Header(name="Authorization", value="runtime-secret")
        stream = BoundedByteStream(
            chunks=(b"payload",),
            media_type="application/octet-stream",
            final_locator="opaque:final",
            size=7,
        )
        request = TransportRequest(
            method="GET",
            url="opaque:request",
            headers=(header,),
            body=None,
            timeout_seconds=2,
            max_response_bytes=8,
        )
        response = TransportResponse(
            status=200,
            final_url="opaque:response",
            headers=(header,),
            body=b"ok",
        )

        self.assertEqual(BoundedByteStream.model_validate_json(stream.model_dump_json()), stream)
        self.assertEqual(TransportRequest.model_validate_json(request.model_dump_json()), request)
        self.assertEqual(
            TransportResponse.model_validate_json(response.model_dump_json()), response
        )
        self.assertEqual(b"".join(stream.chunks), b"payload")
        self.assertNotIn("content", BoundedByteStream.__dict__)
        self.assertNotIn("runtime-secret", repr(header))
        with self.assertRaises(ValidationError):
            request.url = "changed"

    def test_access_models_reject_malformed_header_stream_and_request(self) -> None:
        cases = (
            lambda: Header(name="Bad\nName", value="x"),
            lambda: BoundedByteStream(
                chunks=(b"payload",),
                media_type="application/octet-stream",
                final_locator="opaque:final",
                size=6,
            ),
            lambda: TransportRequest(
                method="GET",
                url="opaque:request",
                headers=(),
                body=None,
                timeout_seconds=0,
                max_response_bytes=8,
            ),
        )
        for constructor in cases:
            with self.assertRaises(ValidationError):
                constructor()


if __name__ == "__main__":
    unittest.main()
