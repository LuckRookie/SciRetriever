from __future__ import annotations

import unittest
from datetime import datetime, timezone

from sciretriever.model.access import Header
from sciretriever.network.admission import AccessFeedback
from sciretriever.network.response_feedback import (
    FeedbackHeaderError,
    header_value,
    nonnegative_integer_header,
    nonnegative_number_header,
    parse_retry_after,
    quota_reset_deadline,
    retry_after_feedback,
)

_NOW = datetime(2026, 8, 15, 0, 0, tzinfo=timezone.utc)


class NetworkResponseFeedbackTests(unittest.TestCase):
    def test_headers_are_case_insensitive_and_conflicts_fail_closed(self) -> None:
        headers = (
            Header(name="X-RateLimit-Remaining", value=" 4 "),
            Header(name="x-ratelimit-remaining", value="4"),
        )

        self.assertEqual(header_value(headers, "X-RATELIMIT-REMAINING"), "4")
        self.assertEqual(nonnegative_integer_header(headers, "x-ratelimit-remaining"), 4)
        with self.assertRaises(FeedbackHeaderError):
            header_value(
                headers + (Header(name="X-RateLimit-Remaining", value="5"),),
                "X-RateLimit-Remaining",
            )

    def test_numeric_feedback_rejects_negative_nonfinite_and_text_values(self) -> None:
        for value in ("-1", "nan", "inf", "one"):
            with self.subTest(value=value), self.assertRaises(FeedbackHeaderError):
                nonnegative_number_header(
                    (Header(name="X-Quota", value=value),),
                    "X-Quota",
                )
        with self.assertRaises(FeedbackHeaderError):
            nonnegative_integer_header(
                (Header(name="X-Quota", value="1.5"),),
                "X-Quota",
            )

    def test_retry_after_supports_delta_and_http_date_without_wall_deadlines(self) -> None:
        self.assertEqual(parse_retry_after("5", wall_now=_NOW), 5.0)
        self.assertEqual(
            parse_retry_after("Sat, 15 Aug 2026 00:00:07 GMT", wall_now=_NOW),
            7.0,
        )
        self.assertIsNone(parse_retry_after("invalid", wall_now=_NOW))
        self.assertEqual(
            retry_after_feedback(
                429,
                (Header(name="Retry-After", value="5"),),
                wall_now=_NOW,
            ),
            AccessFeedback(retry_after=5.0, throttled=True),
        )
        self.assertEqual(
            retry_after_feedback(
                429,
                (Header(name="Retry-After", value="invalid"),),
                wall_now=_NOW,
            ),
            AccessFeedback(throttled=True),
        )

    def test_epoch_reset_is_projected_into_monotonic_process_time(self) -> None:
        reset = int(_NOW.timestamp()) + 90
        self.assertEqual(
            quota_reset_deadline(
                str(reset),
                wall_now=_NOW,
                monotonic_now=12.0,
            ),
            102.0,
        )
        with self.assertRaises(FeedbackHeaderError):
            quota_reset_deadline(
                "not-an-epoch",
                wall_now=_NOW,
                monotonic_now=12.0,
            )


if __name__ == "__main__":
    unittest.main()
