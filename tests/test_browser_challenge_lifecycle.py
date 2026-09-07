from __future__ import annotations

import inspect
import pickle
import unittest
from dataclasses import replace

from sciretriever.model.primitives import sha256_digest
from sciretriever.network import browser as browser_module
from sciretriever.network import browser_control as control_module
from sciretriever.network.browser_control import (
    BrowserActionKind,
    BrowserActionOutcome,
    BrowserActionReceipt,
    BrowserAgentStatus,
    BrowserBounds,
    BrowserCaptureState,
    BrowserElement,
    BrowserElementState,
    BrowserObservation,
    BrowserPageState,
    BrowserScreenshot,
    BrowserScrollState,
    BrowserSurface,
    BrowserSurfaceKind,
    BrowserViewport,
    ClickElement,
    ClickPoint,
    GoBack,
    ScrollSurface,
    Stop,
    WaitForChange,
    execution_binding_fingerprint,
    stable_action_intent_fingerprint,
    stable_semantic_page_fingerprint,
)


def _surface(
    surface_id: str,
    page_id: str,
    kind: BrowserSurfaceKind,
    *,
    parent: str | None,
    origin: str = "https://publisher.test",
    path: str = "/article",
    bounds: BrowserBounds | None = None,
) -> BrowserSurface:
    viewport = BrowserViewport(1280, 720)
    return BrowserSurface(
        surface_id=surface_id,
        page_id=page_id,
        kind=kind,
        parent_surface_id=parent,
        origin=origin,
        path=path,
        title=f"{kind.value} fixture",
        viewport=viewport,
        bounds=bounds or BrowserBounds(0, 0, 1280, 720),
        scroll=BrowserScrollState(0, 0, 0, 1440),
    )


def _observation(
    *,
    page_state: BrowserPageState = BrowserPageState.NORMAL,
    agent_status: BrowserAgentStatus = BrowserAgentStatus.RUNNING,
    capture_state: BrowserCaptureState = BrowserCaptureState.NONE,
    revision: int = 1,
    screenshot_content: bytes = b"unified-browser-screenshot",
    screenshot_id: str = "i00000001",
) -> BrowserObservation:
    surfaces = (
        _surface("s00000001", "p00000001", BrowserSurfaceKind.PAGE, parent=None),
        _surface(
            "s00000002",
            "p00000001",
            BrowserSurfaceKind.FRAME,
            parent="s00000001",
            path="/article/frame",
            bounds=BrowserBounds(20, 20, 800, 600),
        ),
        _surface(
            "s00000003",
            "p00000001",
            BrowserSurfaceKind.SHADOW,
            parent="s00000002",
            path="/article/frame",
            bounds=BrowserBounds(40, 40, 600, 400),
        ),
        _surface(
            "s00000004",
            "p00000001",
            BrowserSurfaceKind.VIEWER,
            parent="s00000003",
            path="/article/viewer",
            bounds=BrowserBounds(60, 60, 500, 300),
        ),
        _surface(
            "s00000005",
            "p00000002",
            BrowserSurfaceKind.POPUP,
            parent=None,
            path="/article/popup",
        ),
        _surface(
            "s00000006",
            "p00000002",
            BrowserSurfaceKind.VIEWER,
            parent="s00000005",
            path="/article/popup/viewer",
            bounds=BrowserBounds(100, 100, 700, 500),
        ),
    )
    viewport = BrowserViewport(1280, 720)
    return BrowserObservation(
        article_token="article-fixture",
        revision=revision,
        page_id="p00000002",
        surfaces=surfaces,
        elements=(
            BrowserElement(
                element_id="e00000001",
                surface_id="s00000003",
                role="button",
                name="Continue",
                state=BrowserElementState.ENABLED,
                bounds=BrowserBounds(100, 100, 120, 40),
            ),
            BrowserElement(
                element_id="e00000002",
                surface_id="s00000006",
                role="button",
                name="Disabled download",
                state=BrowserElementState.DISABLED,
                bounds=BrowserBounds(200, 200, 160, 40),
            ),
        ),
        screenshot=BrowserScreenshot(
            screenshot_id=screenshot_id,
            article_token="article-fixture",
            page_id="p00000002",
            surface_id="s00000005",
            revision=revision,
            viewport=viewport,
            media_type="image/png",
            sha256=sha256_digest(screenshot_content),
            content=screenshot_content,
        ),
        page_state=page_state,
        agent_status=agent_status,
        capture_state=capture_state,
    )


def _remap_opaque_ids(observation: BrowserObservation) -> BrowserObservation:
    page_ids = {"p00000001": "p00000011", "p00000002": "p00000012"}
    surface_ids = {f"s0000000{index}": f"s0000001{index}" for index in range(1, 7)}
    remapped_surfaces = tuple(
        replace(
            surface,
            surface_id=surface_ids[surface.surface_id],
            page_id=page_ids[surface.page_id],
            parent_surface_id=(
                None
                if surface.parent_surface_id is None
                else surface_ids[surface.parent_surface_id]
            ),
        )
        for surface in observation.surfaces
    )
    remapped_elements = tuple(
        replace(
            element,
            element_id=f"e0000001{index}",
            surface_id=surface_ids[element.surface_id],
        )
        for index, element in enumerate(observation.elements, start=1)
    )
    return replace(
        observation,
        article_token="article-remapped",
        page_id=page_ids[observation.page_id],
        surfaces=remapped_surfaces,
        elements=remapped_elements,
        screenshot=replace(
            observation.screenshot,
            screenshot_id="i00000011",
            article_token="article-remapped",
            page_id=page_ids[observation.screenshot.page_id],
            surface_id=surface_ids[observation.screenshot.surface_id],
        ),
    )


class BrowserObservationContractTests(unittest.TestCase):
    def test_page_state_vocabulary_has_only_the_eight_unified_values(self) -> None:
        self.assertEqual(
            tuple(value.value for value in BrowserPageState),
            (
                "normal",
                "challenge",
                "login-required",
                "mfa-required",
                "not-entitled",
                "access-denied",
                "not-found",
                "failed",
            ),
        )
        self.assertNotIn("interaction", " ".join(value.value for value in BrowserPageState))
        self.assertNotIn("settle", " ".join(value.value for value in BrowserPageState))

    def test_page_agent_and_capture_dimensions_are_orthogonal(self) -> None:
        observations = tuple(
            _observation(
                page_state=page_state,
                agent_status=agent_status,
                capture_state=capture_state,
            )
            for page_state in BrowserPageState
            for agent_status in BrowserAgentStatus
            for capture_state in BrowserCaptureState
        )
        self.assertEqual(len(observations), 8 * 3 * 3)
        self.assertEqual(
            {(value.page_state, value.agent_status, value.capture_state) for value in observations},
            {
                (page_state, agent_status, capture_state)
                for page_state in BrowserPageState
                for agent_status in BrowserAgentStatus
                for capture_state in BrowserCaptureState
            },
        )

    def test_challenge_is_an_ordinary_observation_not_a_special_target(self) -> None:
        observation = _observation(
            page_state=BrowserPageState.CHALLENGE,
            capture_state=BrowserCaptureState.CANDIDATE,
        )
        self.assertIs(observation.page_state, BrowserPageState.CHALLENGE)
        self.assertIs(observation.agent_status, BrowserAgentStatus.RUNNING)
        self.assertIs(observation.capture_state, BrowserCaptureState.CANDIDATE)
        self.assertEqual(len(observation.surfaces), 6)
        self.assertEqual(len(observation.elements), 2)
        self.assertFalse(hasattr(observation, "resources"))
        self.assertFalse(hasattr(observation, "settled"))

    def test_surface_tree_covers_page_popup_frame_shadow_and_viewer(self) -> None:
        observation = _observation()
        self.assertEqual(
            {surface.kind for surface in observation.surfaces},
            {
                BrowserSurfaceKind.PAGE,
                BrowserSurfaceKind.POPUP,
                BrowserSurfaceKind.FRAME,
                BrowserSurfaceKind.SHADOW,
                BrowserSurfaceKind.VIEWER,
            },
        )
        by_id = {surface.surface_id: surface for surface in observation.surfaces}
        for surface in observation.surfaces:
            if surface.parent_surface_id is not None:
                self.assertEqual(
                    by_id[surface.parent_surface_id].page_id,
                    surface.page_id,
                )
        self.assertEqual(observation.primary_surface.kind, BrowserSurfaceKind.POPUP)
        self.assertEqual(observation.origin, "https://publisher.test")
        self.assertEqual(observation.path, "/article/popup")

    def test_surface_tree_rejects_cross_page_parent_and_cycles(self) -> None:
        observation = _observation()
        cross_page = replace(
            observation.surfaces[1],
            parent_surface_id="s00000005",
        )
        with self.assertRaisesRegex(ValueError, "same page"):
            replace(
                observation,
                surfaces=(observation.surfaces[0], cross_page, *observation.surfaces[2:]),
            )
        frame = replace(observation.surfaces[1], parent_surface_id="s00000003")
        shadow = replace(observation.surfaces[2], parent_surface_id="s00000002")
        with self.assertRaisesRegex(ValueError, "cycle"):
            replace(
                observation,
                surfaces=(
                    observation.surfaces[0],
                    frame,
                    shadow,
                    *observation.surfaces[3:],
                ),
            )

    def test_elements_are_surface_scoped_and_only_enabled_values_are_actionable(self) -> None:
        observation = _observation()
        self.assertEqual(
            tuple(element.element_id for element in observation.actionable_elements),
            ("e00000001",),
        )
        self.assertTrue(observation.elements[0].visible)
        self.assertFalse(observation.elements[1].enabled)
        with self.assertRaisesRegex(ValueError, "element surface"):
            replace(
                observation,
                elements=(replace(observation.elements[0], surface_id="sffffffff"),),
            )

    def test_screenshot_is_bound_to_article_page_surface_viewport_revision_and_hash(self) -> None:
        observation = _observation()
        screenshot = observation.screenshot
        self.assertEqual(screenshot.article_token, observation.article_token)
        self.assertEqual(screenshot.page_id, observation.page_id)
        self.assertEqual(screenshot.revision, observation.revision)
        self.assertEqual(screenshot.viewport, observation.viewport)
        self.assertEqual(screenshot.sha256, sha256_digest(screenshot.content))
        with self.assertRaisesRegex(ValueError, "identity"):
            replace(observation, screenshot=replace(screenshot, page_id="p00000001"))
        with self.assertRaisesRegex(ValueError, "hash"):
            replace(screenshot, sha256=sha256_digest(b"different"))

    def test_semantic_fingerprint_is_stable_and_pixel_hash_is_exact(self) -> None:
        first = _observation()
        same = _observation()
        changed_pixels = _observation(
            screenshot_content=b"different-screenshot",
            screenshot_id="i00000002",
        )
        self.assertEqual(
            stable_semantic_page_fingerprint(first),
            stable_semantic_page_fingerprint(same),
        )
        self.assertEqual(
            stable_semantic_page_fingerprint(first),
            stable_semantic_page_fingerprint(changed_pixels),
        )
        self.assertNotEqual(
            execution_binding_fingerprint(first),
            execution_binding_fingerprint(changed_pixels),
        )

    def test_stable_and_exact_fingerprints_separate_semantics_from_bindings(self) -> None:
        baseline = _observation()
        transient = _observation(
            revision=2,
            screenshot_content=b"new-pixels",
            screenshot_id="i00000002",
        )
        remapped = _remap_opaque_ids(baseline)
        geometry_jitter = replace(
            baseline,
            elements=(
                replace(
                    baseline.elements[0],
                    bounds=replace(baseline.elements[0].bounds, x=101, y=101),
                ),
                baseline.elements[1],
            ),
        )
        semantically_same = (transient, remapped, geometry_jitter)
        for observation in semantically_same:
            with self.subTest(kind="stable", revision=observation.revision):
                self.assertEqual(
                    stable_semantic_page_fingerprint(baseline),
                    stable_semantic_page_fingerprint(observation),
                )
                self.assertNotEqual(
                    execution_binding_fingerprint(baseline),
                    execution_binding_fingerprint(observation),
                )

        changed_location = replace(
            baseline,
            surfaces=(
                *baseline.surfaces[:4],
                replace(baseline.surfaces[4], path="/different-article"),
                baseline.surfaces[5],
            ),
        )
        changed_actionability = replace(
            baseline,
            elements=(
                replace(
                    baseline.elements[0],
                    state=BrowserElementState.DISABLED,
                ),
                baseline.elements[1],
            ),
        )
        changed_structure = replace(
            baseline,
            elements=(baseline.elements[0],),
        )
        semantic_changes = (
            replace(baseline, page_state=BrowserPageState.CHALLENGE),
            changed_location,
            changed_actionability,
            changed_structure,
        )
        for observation in semantic_changes:
            with self.subTest(kind="meaningful", state=observation.page_state.value):
                self.assertNotEqual(
                    stable_semantic_page_fingerprint(baseline),
                    stable_semantic_page_fingerprint(observation),
                )
                self.assertNotEqual(
                    execution_binding_fingerprint(baseline),
                    execution_binding_fingerprint(observation),
                )

    def test_stable_action_intent_uses_semantics_point_buckets_and_scroll_classes(
        self,
    ) -> None:
        baseline = _observation()
        transient = _observation(
            revision=2,
            screenshot_content=b"new-pixels",
            screenshot_id="i00000002",
        )
        remapped = _remap_opaque_ids(baseline)
        click = ClickElement(
            baseline.article_token,
            "p00000001",
            "s00000003",
            baseline.revision,
            "e00000001",
        )
        transient_click = replace(
            click,
            revision=transient.revision,
        )
        remapped_click = ClickElement(
            remapped.article_token,
            "p00000011",
            "s00000013",
            remapped.revision,
            "e00000011",
        )
        self.assertEqual(
            stable_action_intent_fingerprint(click, baseline),
            stable_action_intent_fingerprint(transient_click, transient),
        )
        self.assertEqual(
            stable_action_intent_fingerprint(click, baseline),
            stable_action_intent_fingerprint(remapped_click, remapped),
        )

        renamed = replace(
            baseline,
            elements=(
                replace(baseline.elements[0], name="Verify access"),
                baseline.elements[1],
            ),
        )
        self.assertNotEqual(
            stable_action_intent_fingerprint(click, baseline),
            stable_action_intent_fingerprint(click, renamed),
        )

        point = ClickPoint(
            baseline.article_token,
            baseline.page_id,
            "s00000006",
            baseline.revision,
            baseline.screenshot.screenshot_id,
            240,
            220,
        )
        nearby_point = replace(point, x=241, y=221)
        distant_point = replace(point, x=600, y=500)
        self.assertEqual(
            stable_action_intent_fingerprint(point, baseline),
            stable_action_intent_fingerprint(nearby_point, baseline),
        )
        self.assertNotEqual(
            stable_action_intent_fingerprint(point, baseline),
            stable_action_intent_fingerprint(distant_point, baseline),
        )

        scroll = ScrollSurface(
            baseline.article_token,
            baseline.page_id,
            "s00000006",
            baseline.revision,
            200,
        )
        self.assertEqual(
            stable_action_intent_fingerprint(scroll, baseline),
            stable_action_intent_fingerprint(replace(scroll, delta_y=400), baseline),
        )
        self.assertNotEqual(
            stable_action_intent_fingerprint(scroll, baseline),
            stable_action_intent_fingerprint(replace(scroll, delta_y=401), baseline),
        )
        self.assertNotEqual(
            stable_action_intent_fingerprint(scroll, baseline),
            stable_action_intent_fingerprint(replace(scroll, delta_y=-200), baseline),
        )

    def test_receipt_expresses_every_closed_outcome_without_payload(self) -> None:
        for outcome in BrowserActionOutcome:
            with self.subTest(outcome=outcome.value):
                receipt = BrowserActionReceipt(
                    action_kind=BrowserActionKind.CLICK_POINT,
                    outcome=outcome,
                    article_token="article-fixture",
                    page_id="p00000002",
                    surface_id="s00000006",
                    before_revision=1,
                    after_revision=2,
                    elapsed_milliseconds=5,
                    failure_code=(
                        "browser-action-failed" if outcome is BrowserActionOutcome.FAILURE else None
                    ),
                )
                self.assertIs(receipt.outcome, outcome)
        with self.assertRaisesRegex(ValueError, "failure receipt"):
            BrowserActionReceipt(
                BrowserActionKind.CLICK_POINT,
                BrowserActionOutcome.FAILURE,
                "article-fixture",
                "p00000002",
                "s00000006",
                1,
                None,
                5,
            )

    def test_observation_and_screenshot_do_not_serialize_or_leak_content_in_repr(self) -> None:
        observation = _observation()
        with self.assertRaises(TypeError):
            pickle.dumps(observation)
        representation = repr(observation)
        self.assertNotIn("Continue", representation)
        self.assertNotIn("unified-browser-screenshot", representation)
        self.assertNotIn("/article/popup", representation)


class BrowserClosedActionContractTests(unittest.TestCase):
    def test_six_actions_bind_only_current_article_page_surface_or_screenshot(self) -> None:
        observation = _observation()
        actions = (
            ClickElement(
                observation.article_token,
                "p00000001",
                "s00000003",
                observation.revision,
                "e00000001",
            ),
            ClickPoint(
                observation.article_token,
                observation.page_id,
                "s00000006",
                observation.revision,
                observation.screenshot.screenshot_id,
                240,
                220,
            ),
            ScrollSurface(
                observation.article_token,
                observation.page_id,
                "s00000006",
                observation.revision,
                400,
            ),
            GoBack(observation.article_token, observation.page_id, observation.revision),
            WaitForChange(observation.article_token, observation.page_id, observation.revision),
            Stop(observation.article_token, observation.page_id, observation.revision, "done"),
        )
        self.assertEqual(
            tuple(action.kind for action in actions),
            tuple(BrowserActionKind),
        )
        for action in actions:
            parameters = inspect.signature(type(action)).parameters
            self.assertNotIn("url", parameters)
            self.assertNotIn("selector", parameters)
            self.assertNotIn("javascript", parameters)

    def test_public_network_surface_has_no_vendor_or_challenge_lifecycle_types(self) -> None:
        removed = {
            "BrowserAgentActionCommand",
            "BrowserAgentActionPort",
            "BrowserAgentObservation",
            "BrowserObservationBudget",
            "BrowserChallengeObservation",
            "BrowserChallengeResourceFacts",
            "BrowserChallengeState",
            "BrowserChallengeStateMachine",
        }
        transient = {
            "BrowserControlSession",
            "BrowserStepDriver",
            "BrowserTransition",
            "BrowserTransitionKind",
        }
        for module in (control_module, browser_module):
            with self.subTest(module=module.__name__):
                self.assertTrue(removed.isdisjoint(vars(module)))
        public_names = set(control_module.__all__)
        self.assertTrue(
            {
                "BrowserObservation",
                "BrowserReady",
                "BrowserCaptured",
                "BrowserBlocked",
                "BrowserFailed",
                "BrowserCancelled",
                "BrowserStepPolicy",
                "BrowserStepSession",
            }
            <= public_names
        )
        self.assertTrue(removed.isdisjoint(public_names))
        self.assertTrue(transient.isdisjoint(public_names))
        self.assertFalse(hasattr(browser_module.BrowserFlowSession, "control_session"))


if __name__ == "__main__":
    unittest.main()
