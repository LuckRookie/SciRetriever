from __future__ import annotations

import pickle
import unittest

from sciretriever.acquisition.browser_state import (
    BrowserGroupEffect,
    BrowserRunState,
    decision_for_browser_state,
)
from sciretriever.acquisition.sources.browser import (
    BrowserChallengeState,
    BrowserChallengeStateMachine,
    _browser_state_for_challenge,
    _settle_challenge,
    build_browser_rule_destination_guard,
)
from sciretriever.acquisition.sources.browser_rules import (
    BrowserActionKind,
    BrowserChallengeResourceProfile,
    BrowserPageMarker,
    BrowserPageMarkerKind,
    BrowserRuleAction,
    BrowserSiteRule,
)
from sciretriever.model.access import BrowserCaptureKind
from sciretriever.network.browser import (
    BrowserChallengeObservation,
    BrowserChallengeResourceFacts,
    BrowserDestinationKind,
    BrowserPageObservation,
    BrowserRequestObservation,
)
from sciretriever.network.browser_control import BrowserAgentActionPort


def _profile() -> BrowserChallengeResourceProfile:
    return BrowserChallengeResourceProfile(
        origin="https://challenges.cloudflare.com",
        path_prefixes=("https://challenges.cloudflare.com/cdn-cgi/challenge-platform/",),
        resource_types=("script", "document", "fetch", "image"),
        interaction_selectors=("#challenge-form",),
        settling_selectors=("#challenge-running",),
    )


def _rule() -> BrowserSiteRule:
    return BrowserSiteRule(
        rule_id="challenge-fixture",
        revision=1,
        landing_origin="https://publisher.test",
        allowed_origins=("https://publisher.test",),
        web_scope_provider_name="challenge-fixture",
        actions=(BrowserRuleAction(kind=BrowserActionKind.WAIT_FOR_ANY_CAPTURE),),
        max_actions=1,
        page_markers=(
            BrowserPageMarker(
                marker_id="challenge",
                kind=BrowserPageMarkerKind.CHALLENGE_REQUIRED,
                css_selectors=("#challenge-running",),
                text_markers=(("title", "just a moment"),),
            ),
            BrowserPageMarker(
                marker_id="entitled",
                kind=BrowserPageMarkerKind.ENTITLED,
                css_selectors=("#entitled",),
            ),
        ),
        capture_url_prefixes=("https://publisher.test/article.pdf",),
        challenge_resource_profile=_profile(),
    )


class _ChallengeSession:
    def __init__(self, snapshots: tuple[BrowserChallengeObservation, ...]) -> None:
        self._snapshots = list(snapshots)
        self._current = "challenge"
        self.wait_calls: list[float] = []

    def click(self, selector: str) -> bool:
        del selector
        return False

    def open_viewer(self, locator: str) -> None:
        del locator

    def open_verified_locator(self, locator: str) -> None:
        del locator

    def discover_pdf_locators(self) -> tuple[str, ...]:
        return ()

    def capture_available(self, kind: BrowserCaptureKind) -> bool:
        del kind
        return False

    def wait_for_capture(self, kind: BrowserCaptureKind) -> None:
        del kind

    def wait_for_any_capture(self, kinds: tuple[BrowserCaptureKind, ...]) -> None:
        del kinds

    def agent_action_port(self) -> BrowserAgentActionPort:
        raise AssertionError("challenge lifecycle fixture does not expose Agent actions")

    def has_selector(self, selector: str) -> bool:
        return selector == "#challenge-form" and self._current == "interaction"

    def text(self, selector: str) -> str:
        if selector == "title":
            return "Just a Moment" if self._current == "challenge" else "Article"
        return ""

    def observe(self) -> BrowserPageObservation:
        return BrowserPageObservation(
            locator="https://publisher.test/article",
            status_code=200,
        )

    def challenge_observation(self) -> BrowserChallengeObservation:
        return self._snapshots[0]

    def wait_for_challenge_settle(self, timeout_seconds: float) -> BrowserChallengeObservation:
        self.wait_calls.append(timeout_seconds)
        if len(self._snapshots) > 1:
            self._snapshots.pop(0)
        return self._snapshots[0]


class _DelayedNavigationSession(_ChallengeSession):
    """Network-quiet snapshots before a later JavaScript top-frame navigation."""

    def wait_for_challenge_settle(self, timeout_seconds: float) -> BrowserChallengeObservation:
        value = super().wait_for_challenge_settle(timeout_seconds)
        if len(self.wait_calls) == 2:
            self._current = "article"
        return value


class _InterruptedSettleSession(_ChallengeSession):
    def wait_for_challenge_settle(self, timeout_seconds: float) -> BrowserChallengeObservation:
        self.wait_calls.append(timeout_seconds)
        raise RuntimeError("fixture Network cancellation")


class BrowserChallengeLifecycleTests(unittest.TestCase):
    def test_state_machine_has_bounded_transient_and_terminal_paths(self) -> None:
        machine = BrowserChallengeStateMachine()
        self.assertEqual(machine.state, BrowserChallengeState.RESOURCE_LOADING)
        machine.transition(BrowserChallengeState.SETTLING)
        cleared = machine.transition(BrowserChallengeState.CLEARED)
        self.assertEqual(
            cleared.history,
            (
                BrowserChallengeState.RESOURCE_LOADING,
                BrowserChallengeState.SETTLING,
                BrowserChallengeState.CLEARED,
            ),
        )
        with self.assertRaises(RuntimeError):
            machine.transition(BrowserChallengeState.INTERACTION_REQUIRED)
        with self.assertRaises(TypeError):
            pickle.dumps(machine)

        blocked = BrowserChallengeStateMachine()
        blocked.transition(BrowserChallengeState.RESOURCE_BLOCKED)
        with self.assertRaises(RuntimeError):
            blocked.transition(BrowserChallengeState.SETTLING)

    def test_automatic_clear_returns_to_provider_page_classification(self) -> None:
        page = BrowserPageObservation(locator="https://publisher.test/article", status_code=200)
        initial = BrowserChallengeObservation(
            page=page,
            resources=BrowserChallengeResourceFacts(admitted_count=2, pending_count=1),
            settled=False,
        )
        final = BrowserChallengeObservation(
            page=page,
            resources=BrowserChallengeResourceFacts(admitted_count=3),
            settled=True,
        )
        session = _ChallengeSession((initial, final))
        session._current = "article"
        state, classification = _settle_challenge(session, _rule())
        self.assertEqual(state, BrowserChallengeState.CLEARED)
        self.assertIsNotNone(classification)
        assert classification is not None
        self.assertTrue(classification.entitled is False)
        self.assertEqual(len(session.wait_calls), 1)
        self.assertLessEqual(session.wait_calls[0], 5.0)

    def test_interaction_and_timeout_are_distinct_terminal_states(self) -> None:
        page = BrowserPageObservation(locator="https://publisher.test/article", status_code=200)
        observation = BrowserChallengeObservation(
            page=page,
            resources=BrowserChallengeResourceFacts(admitted_count=1),
            settled=True,
        )
        interaction = _ChallengeSession((observation,))
        interaction._current = "interaction"
        state, _classification = _settle_challenge(interaction, _rule())
        self.assertEqual(state, BrowserChallengeState.INTERACTION_REQUIRED)
        self.assertEqual(interaction.wait_calls, [])

        timeout = _ChallengeSession((observation, observation))
        state, _classification = _settle_challenge(timeout, _rule())
        self.assertEqual(state, BrowserChallengeState.SETTLE_TIMEOUT)
        self.assertGreaterEqual(len(timeout.wait_calls), 2)
        self.assertLessEqual(timeout.wait_calls[0], 5.0)

    def test_settle_keeps_observing_after_network_quiet_before_js_navigation(self) -> None:
        page = BrowserPageObservation(locator="https://publisher.test/article", status_code=200)
        quiet = BrowserChallengeObservation(
            page=page,
            resources=BrowserChallengeResourceFacts(admitted_count=2, pending_count=0),
            settled=True,
        )
        session = _DelayedNavigationSession((quiet, quiet))
        state, classification = _settle_challenge(session, _rule())
        self.assertEqual(state, BrowserChallengeState.CLEARED)
        self.assertIsNotNone(classification)
        self.assertGreaterEqual(len(session.wait_calls), 2)

    def test_runtime_interruption_escapes_the_page_challenge_lifecycle(self) -> None:
        page = BrowserPageObservation(locator="https://publisher.test/article", status_code=200)
        observation = BrowserChallengeObservation(
            page=page,
            resources=BrowserChallengeResourceFacts(admitted_count=1, pending_count=1),
            settled=False,
        )
        session = _InterruptedSettleSession((observation,))

        with self.assertRaisesRegex(RuntimeError, "Network cancellation"):
            _settle_challenge(session, _rule())

        self.assertEqual(len(session.wait_calls), 1)

    def test_only_manual_interaction_opens_challenge_circuit(self) -> None:
        self.assertEqual(
            _browser_state_for_challenge(BrowserChallengeState.INTERACTION_REQUIRED),
            BrowserRunState.CHALLENGE_REQUIRED,
        )
        self.assertEqual(
            _browser_state_for_challenge(BrowserChallengeState.RESOURCE_BLOCKED),
            BrowserRunState.ACCESS_DENIED,
        )
        self.assertEqual(
            _browser_state_for_challenge(BrowserChallengeState.SETTLE_TIMEOUT),
            BrowserRunState.ACCESS_DENIED,
        )
        self.assertEqual(
            _browser_state_for_challenge(BrowserChallengeState.FAILED),
            BrowserRunState.RUNTIME_FAILED,
        )
        self.assertIs(
            decision_for_browser_state(BrowserRunState.ACCESS_DENIED).group_effect,
            BrowserGroupEffect.NONE,
        )

    def test_challenge_logs_are_actionable_without_page_content(self) -> None:
        page = BrowserPageObservation(locator="https://publisher.test/article", status_code=200)
        initial = BrowserChallengeObservation(
            page=page,
            resources=BrowserChallengeResourceFacts(admitted_count=2, pending_count=1),
            settled=False,
        )
        final = BrowserChallengeObservation(
            page=page,
            resources=BrowserChallengeResourceFacts(admitted_count=3),
            settled=True,
        )
        session = _ChallengeSession((initial, final))
        session._current = "article"

        with self.assertLogs(
            "sciretriever.acquisition.sources.browser",
            level="INFO",
        ) as captured:
            state, _classification = _settle_challenge(session, _rule())

        self.assertEqual(state, BrowserChallengeState.CLEARED)
        output = "\n".join(captured.output)
        self.assertIn("event=browser-challenge-started", output)
        self.assertIn("event=browser-challenge-finished", output)
        self.assertIn("evidence_kind=page-state-transition", output)
        self.assertIn("outcome=cleared", output)
        self.assertIn("resource_admitted=3", output)
        self.assertIn("reason=Automatic verification completed", output)
        self.assertIn("action=Continue with the reviewed PDF acquisition steps.", output)
        self.assertNotIn("Just a Moment", output)
        self.assertNotIn("#challenge-form", output)
        self.assertNotIn("challenge.js", output)

    def test_guard_counts_only_bounded_challenge_facts(self) -> None:
        guard = build_browser_rule_destination_guard(_rule(), "https://publisher.test/article")
        valid = BrowserRequestObservation(
            locator="https://challenges.cloudflare.com/cdn-cgi/challenge-platform/challenge.js",
            kind=BrowserDestinationKind.REQUEST,
            resource_type="script",
            is_navigation=False,
            is_top_frame=True,
            frame_depth=0,
            top_frame_locator="https://publisher.test/article",
        )
        guard.check_request(valid)
        self.assertEqual(guard.challenge_resource_facts().admitted_count, 1)
        frame_response = BrowserRequestObservation(
            locator="https://challenges.cloudflare.com/cdn-cgi/challenge-platform/frame",
            kind=BrowserDestinationKind.RESPONSE,
            resource_type="document",
            is_navigation=True,
            is_top_frame=False,
            frame_depth=1,
            frame_ancestry=("https://publisher.test/article",),
            top_frame_locator="https://publisher.test/article",
            capture_kind=BrowserCaptureKind.RESPONSE,
        )
        # Network reports a tentative RESPONSE kind for every successful
        # response; the challenge iframe/document must therefore load even
        # though a challenge PDF/body is never capture-eligible.
        guard.check_request(frame_response)
        self.assertEqual(guard.challenge_resource_facts().admitted_count, 2)
        image_response = BrowserRequestObservation(
            locator="https://challenges.cloudflare.com/cdn-cgi/challenge-platform/challenge.gif",
            kind=BrowserDestinationKind.RESPONSE,
            resource_type="image",
            is_navigation=False,
            is_top_frame=False,
            frame_depth=1,
            frame_ancestry=("https://publisher.test/article",),
            top_frame_locator="https://publisher.test/article",
            capture_kind=BrowserCaptureKind.RESPONSE,
        )
        # RESPONSE is Network's tentative classification for a successful
        # subresource response, not permission to expose the image as a
        # capture.  The bounded iframe image must still reach the page.
        guard.check_request(image_response)
        self.assertEqual(guard.challenge_resource_facts().admitted_count, 3)
        body_capture = BrowserRequestObservation(
            locator="https://challenges.cloudflare.com/cdn-cgi/challenge-platform/challenge.pdf",
            kind=BrowserDestinationKind.RESPONSE,
            resource_type="fetch",
            is_navigation=False,
            is_top_frame=False,
            frame_depth=1,
            frame_ancestry=("https://publisher.test/article",),
            top_frame_locator="https://publisher.test/article",
            capture_kind=BrowserCaptureKind.RESPONSE,
        )
        with self.assertRaises(ValueError):
            guard.check_request(body_capture)
        self.assertEqual(guard.challenge_resource_facts().blocked_count, 1)
        invalid = BrowserRequestObservation(
            locator="https://challenges.cloudflare.com/other.js",
            kind=BrowserDestinationKind.REQUEST,
            resource_type="script",
            is_navigation=False,
            is_top_frame=True,
            frame_depth=0,
            top_frame_locator="https://publisher.test/article",
        )
        with self.assertRaises(ValueError):
            guard.check_request(invalid)
        facts = guard.challenge_resource_facts()
        self.assertEqual(facts.admitted_count, 3)
        self.assertEqual(facts.blocked_count, 2)


if __name__ == "__main__":
    unittest.main()
