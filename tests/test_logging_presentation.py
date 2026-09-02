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
        self.assertRegex(
            lines[0],
            re.compile(
                r"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} "
                r"WARN\s+completion\s+✗ target failed"
            ),
        )
        self.assertLess(output.index("progress=4/10"), output.index("stage=acquisition"))
        self.assertLess(output.index("stage=acquisition"), output.index("code="))
        self.assertLess(output.index("code="), output.index("retryable=true"))
        self.assertIn("[completion-target-failed]", output)
        self.assertIn("    reason  A route failed without ending the operation.", output)
        self.assertIn("    action  Continue with the next applicable route.", output)
        self.assertIn("    details literature-id=safe-literature", output)
        self.assertIn("    source  @ entry.completion:", output)
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

    def test_agents_component_and_action_required_outcomes_are_not_shown_as_success(self) -> None:
        stderr = io.StringIO()
        agents_logger = get_logger("sciretriever.agents")
        completion_logger = get_logger("sciretriever.entry.completion")

        with redirect_stderr(stderr):
            configure_logging(level=logging.DEBUG)
            agents_logger.debug(
                "event=agent-call-finished role=analysis provider=fixture "
                "wire_model=fixture-model stream=on outcome=failed"
            )
            completion_logger.warning(
                "event=completion-target-finished progress=1/1 outcome=needs-manual-pdf"
            )

        output = stderr.getvalue()
        self.assertRegex(output, r"DEBUG\s+agents\s+✗ call finished")
        self.assertRegex(output, r"WARN\s+completion\s+… target finished")

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
        self.assertIn("provider-group=springer", first_line)
        self.assertIn("disposition=failed", first_line)
        self.assertLess(output.index("provider-group=springer"), output.index("attempt-key="))
        self.assertLess(output.index("attempt-key="), output.index("session-key=springer"))
        self.assertLess(output.index("session-key=springer"), output.index("attempted=true"))
        self.assertIn("queue-wait=0.250s", output)
        self.assertIn("elapsed=1.500s", output)
        self.assertIn("    details attempt-key=", output)

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

        output = stderr.getvalue()
        first_line = output.splitlines()[0]
        self.assertIn("DEBUG", first_line)
        self.assertIn("discovery", first_line)
        self.assertIn("[discovery-observation-rejected]", output)
        self.assertIn("provider=europe-pmc", first_line)
        self.assertIn("decision-reason=metadata-title-or-doi-required", output)
        self.assertLess(output.index("provider="), output.index("decision-reason="))
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

        output = stderr.getvalue()
        self.assertIn("[elsevier-authorized-response-classified]", output)
        self.assertIn("http-status=403", output)
        self.assertIn("http-status-class=client-error", output)
        self.assertIn("representation=missing", output)
        self.assertIn("failure-kind=entitlement", output)
        self.assertLess(output.index("stage=lookup"), output.index("provider-group="))
        self.assertLess(output.index("route-key="), output.index("http-status=403"))
        self.assertLess(output.index("http-status=403"), output.index("representation="))
        self.assertLess(output.index("representation="), output.index("envelope="))
        self.assertLess(output.index("disposition=failure"), output.index("failure-kind="))
        self.assertNotIn("body", output)
        self.assertNotIn("vendor", output)

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

        blocks = tuple(
            block
            for block in re.split(r"(?=^\d{4}-\d{2}-\d{2} )", stderr.getvalue(), flags=re.M)
            if block
        )
        self.assertEqual(len(blocks), 32)
        self.assertTrue(all(block.count("[metadata-item-disposition]") == 1 for block in blocks))
        self.assertTrue(all("raw-item=" in block for block in blocks))
        self.assertTrue(all("observation-delta=1" in block for block in blocks))
        self.assertTrue(all("relation-delta=2" in block for block in blocks))

    def test_static_layout_folds_at_terminal_width_without_losing_event_or_fields(self) -> None:
        logger = get_logger("sciretriever.entry.completion")
        for width in (80, 120, 160):
            with self.subTest(width=width):
                stderr = _TtyBuffer()
                with patch.dict(
                    os.environ,
                    {"COLUMNS": str(width), "NO_COLOR": "1", "TERM": "xterm-256color"},
                    clear=False,
                ):
                    with redirect_stderr(stderr):
                        configure_logging(level=logging.DEBUG)
                        logger.warning(
                            "event=completion-target-failed progress=17/100 "
                            "target_kind=meta-literature target_id=safe-target "
                            "stage=analysis code=analysis-agent-response-invalid "
                            "retryable=false reason=%s action=%s",
                            "The returned structured result did not satisfy the expected contract.",
                            "Check the selected Model capability and retry the failed target.",
                        )

                output = stderr.getvalue()
                self.assertIn("[completion-target-failed]", output)
                self.assertIn("code=analysis-agent-response-invalid", output)
                self.assertIn("reason", output)
                self.assertIn("action", output)
                self.assertTrue(all(len(line) <= width for line in output.splitlines()))

    def test_non_tty_layout_folds_long_unbroken_safe_values(self) -> None:
        stderr = io.StringIO()
        logger = get_logger("sciretriever.logging.presentation")
        long_value = "safe" * 80

        with redirect_stderr(stderr):
            configure_logging(level=logging.INFO)
            logger.warning(
                "event=configuration-check-failed code=configuration-invalid "
                "retryable=false reason=%s action=Review the configuration.",
                long_value,
            )

        output = stderr.getvalue()
        self.assertIn("[configuration-check-failed]", output)
        self.assertIn(long_value[:40], output)
        self.assertTrue(all(len(line) <= 120 for line in output.splitlines()))


if __name__ == "__main__":
    unittest.main()
