"""Human-readable production logging presentation contracts."""

from __future__ import annotations

import io
import logging
import os
import re
import unittest
from concurrent.futures import ThreadPoolExecutor
from contextlib import redirect_stderr
from unittest.mock import patch

from sciretriever.logging.api import configure_logging, get_logger


class _TtyBuffer(io.StringIO):
    def isatty(self) -> bool:
        return True


class LoggingPresentationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.project_logger = logging.getLogger("sciretriever")
        self.snapshot = (
            list(self.project_logger.handlers),
            self.project_logger.level,
            self.project_logger.propagate,
            self.project_logger.disabled,
        )
        self.project_logger.handlers.clear()
        self.project_logger.disabled = False

    def tearDown(self) -> None:
        for handler in tuple(self.project_logger.handlers):
            if handler not in self.snapshot[0]:
                handler.close()
        self.project_logger.handlers[:] = self.snapshot[0]
        self.project_logger.setLevel(self.snapshot[1])
        self.project_logger.propagate = self.snapshot[2]
        self.project_logger.disabled = self.snapshot[3]

    def test_debug_event_has_readable_layout_ordered_fields_and_failure_lines(self) -> None:
        stderr = io.StringIO()
        logger = get_logger("sciretriever.entry.completion")

        with redirect_stderr(stderr):
            configure_logging(level=logging.DEBUG)
            logger.warning(
                "event=completion-target-failed progress=4/10 target_kind=meta-literature "
                "target_id=safe-target literature_id=safe-literature stage=acquisition "
                "code=acquisition-route-failed retryable=true "
                "reason=A route failed without ending the operation. "
                "action=Continue with the next applicable route."
            )

        output = stderr.getvalue()
        lines = output.splitlines()
        self.assertEqual(len(lines), 3)
        self.assertRegex(
            lines[0],
            re.compile(
                r"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} "
                r"WARN\s+completion\s+✗ target failed "
                r"\[completion-target-failed\] "
            ),
        )
        self.assertLess(lines[0].index("progress=4/10"), lines[0].index("stage=acquisition"))
        self.assertLess(lines[0].index("stage=acquisition"), lines[0].index("code="))
        self.assertLess(lines[0].index("code="), lines[0].index("retryable=true"))
        self.assertIn("@ entry.completion:", lines[0])
        self.assertEqual(
            lines[1],
            "    reason  A route failed without ending the operation.",
        )
        self.assertEqual(
            lines[2],
            "    action  Continue with the next applicable route.",
        )
        self.assertNotIn("sciretriever.entry.completion", output)
        self.assertNotIn("\x1b[", output)

    def test_normal_event_omits_source_location_but_keeps_event_identity(self) -> None:
        stderr = io.StringIO()
        logger = get_logger("sciretriever.metadata.service")

        with redirect_stderr(stderr):
            configure_logging(level=logging.INFO)
            logger.info(
                "event=metadata-provider-finished provider=datacite "
                "outcome=SCAN_LIMIT_REACHED raw_item_count=100 "
                "observation_count=51 empty_item_count=49 rejected_record_count=0 "
                "elapsed_ms=3309"
            )

        output = stderr.getvalue()
        self.assertIn("INFO", output)
        self.assertIn("metadata", output)
        self.assertIn("✓ provider finished", output)
        self.assertIn("[metadata-provider-finished]", output)
        self.assertIn("provider=datacite", output)
        self.assertIn("outcome=SCAN_LIMIT_REACHED", output)
        self.assertIn("raw=100", output)
        self.assertIn("observations=51", output)
        self.assertIn("empty=49", output)
        self.assertIn("rejected=0", output)
        self.assertIn("elapsed=3.309s", output)
        self.assertNotIn("@ metadata.service:", output)

    def test_tty_uses_color_and_no_color_disables_it(self) -> None:
        logger = get_logger("sciretriever.network.http")
        colored = _TtyBuffer()
        with patch.dict(os.environ, {"TERM": "xterm-256color"}, clear=False):
            os.environ.pop("NO_COLOR", None)
            with redirect_stderr(colored):
                configure_logging(level=logging.INFO)
                logger.info(
                    "event=network-request-finished provider=example channel=web "
                    "status=200 response_bytes=2048 elapsed_ms=125"
                )
        self.assertIn("\x1b[", colored.getvalue())

        monochrome = _TtyBuffer()
        with patch.dict(os.environ, {"NO_COLOR": "1"}, clear=False):
            with redirect_stderr(monochrome):
                configure_logging(level=logging.INFO)
                logger.info(
                    "event=network-request-finished provider=example channel=web "
                    "status=200 response_bytes=2048 elapsed_ms=125"
                )
        self.assertNotIn("\x1b[", monochrome.getvalue())

    def test_unknown_event_and_plain_message_have_safe_fallbacks(self) -> None:
        stderr = io.StringIO()
        logger = get_logger("sciretriever.logging.presentation")

        with redirect_stderr(stderr):
            configure_logging(level=logging.DEBUG)
            logger.debug("event=future-step-started custom_field=safe-value")
            logger.info("ordinary progress message")

        output = stderr.getvalue()
        self.assertIn("[future-step-started]", output)
        self.assertIn("custom-field=safe-value", output)
        self.assertIn("ordinary progress message", output)
        self.assertIn("@ logging.presentation:", output)

    def test_extended_browser_fields_are_ordered_compact_and_outcome_aware(self) -> None:
        stderr = io.StringIO()
        logger = get_logger("sciretriever.network.browser_scheduler")

        with redirect_stderr(stderr):
            configure_logging(level=logging.DEBUG)
            logger.debug(
                "event=browser-article-finished attempt_key=article-7 "
                "provider_group=springer session_key=springer session_reused=true "
                "attempted=true disposition=failed next=route-result "
                "queue_wait_ms=250 elapsed_ms=1500"
            )

        output = stderr.getvalue()
        first_line = output.splitlines()[0]
        self.assertIn("✗ article finished", first_line)
        self.assertLess(
            first_line.index("provider-group=springer"),
            first_line.index("attempt-key="),
        )
        self.assertLess(first_line.index("session-key=springer"), first_line.index("disposition="))
        self.assertLess(first_line.index("disposition=failed"), first_line.index("attempted=true"))
        self.assertIn("queue-wait=0.250s", first_line)
        self.assertIn("elapsed=1.500s", first_line)

    def test_discovery_rejection_keeps_literature_decision_reason_readable(self) -> None:
        stderr = io.StringIO()
        logger = get_logger("sciretriever.entry.discovery")

        with redirect_stderr(stderr):
            configure_logging(level=logging.DEBUG)
            logger.debug(
                "event=discovery-observation-rejected provider=europe-pmc "
                "observation_id=safe-observation "
                "decision_reason=metadata-title-or-doi-required"
            )

        first_line = stderr.getvalue().splitlines()[0]
        self.assertIn("DEBUG", first_line)
        self.assertIn("discovery", first_line)
        self.assertIn("[discovery-observation-rejected]", first_line)
        self.assertIn("provider=europe-pmc", first_line)
        self.assertIn("decision-reason=metadata-title-or-doi-required", first_line)
        self.assertLess(first_line.index("provider="), first_line.index("decision-reason="))
        self.assertNotIn("reason  ", first_line)

    def test_elsevier_status_only_diagnostic_is_structured_and_body_free(self) -> None:
        stderr = io.StringIO()
        logger = get_logger("sciretriever.acquisition.providers.elsevier")

        with redirect_stderr(stderr):
            configure_logging(level=logging.DEBUG)
            logger.debug(
                "event=elsevier-authorized-response-classified provider_group=elsevier "
                "route_key=api:elsevier-article-object stage=lookup http_status=403 "
                "http_status_class=client-error representation=missing "
                "envelope=http-status disposition=failure failure_kind=entitlement"
            )

        first_line = stderr.getvalue().splitlines()[0]
        self.assertIn("[elsevier-authorized-response-classified]", first_line)
        self.assertIn("http-status=403", first_line)
        self.assertIn("http-status-class=client-error", first_line)
        self.assertIn("representation=missing", first_line)
        self.assertIn("failure-kind=entitlement", first_line)
        self.assertLess(first_line.index("stage=lookup"), first_line.index("provider-group="))
        self.assertLess(first_line.index("route-key="), first_line.index("http-status=403"))
        self.assertLess(first_line.index("http-status=403"), first_line.index("representation="))
        self.assertLess(first_line.index("representation="), first_line.index("envelope="))
        self.assertLess(first_line.index("disposition=failure"), first_line.index("failure-kind="))
        self.assertNotIn("body", first_line)
        self.assertNotIn("vendor", first_line)

    def test_concurrent_event_records_remain_one_complete_line_each(self) -> None:
        stderr = io.StringIO()
        logger = get_logger("sciretriever.metadata.service")

        def emit(index: int) -> None:
            logger.debug(
                "event=metadata-item-disposition provider=fixture raw_item_ordinal=%d "
                "disposition=accepted observation_delta=1 relation_delta=2 "
                "observation_count=%d relation_count=%d",
                index,
                index,
                index * 2,
            )

        with redirect_stderr(stderr):
            configure_logging(level=logging.DEBUG)
            with ThreadPoolExecutor(max_workers=8) as executor:
                tuple(executor.map(emit, range(1, 33)))

        lines = stderr.getvalue().splitlines()
        self.assertEqual(len(lines), 32)
        self.assertTrue(all(line.count("[metadata-item-disposition]") == 1 for line in lines))
        self.assertTrue(all("raw-item=" in line for line in lines))
        self.assertTrue(all("observation-delta=1" in line for line in lines))
        self.assertTrue(all("relation-delta=2" in line for line in lines))


if __name__ == "__main__":
    unittest.main()
