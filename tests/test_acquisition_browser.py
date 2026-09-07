from __future__ import annotations

import json
import threading
import unittest
from dataclasses import replace
from typing import cast

from sciretriever.acquisition.outcomes import RouteOutcome
from sciretriever.acquisition.planning import AccessRouteHint, AccessRouteHintKind
from sciretriever.acquisition.ports import (
    AcquisitionExpectedFacts,
    AcquisitionFailure,
    AcquisitionRequest,
    AcquisitionSourceFailure,
    CandidateKeyTracker,
)
from sciretriever.acquisition.routes import RouteExecutionContext
from sciretriever.acquisition.routing import build_acquisition_evidence
from sciretriever.acquisition.sources.browser import (
    CONTROLLED_BROWSER_PRODUCTION_STATUS,
    ControlledBrowserPdfSource,
    GenericBrowserDestinationGuard,
    _GenericStepPolicy,
    build_generic_browser_destination_guard,
)
from sciretriever.agents.api import (
    AgentCallLimits,
    AgentModelCapabilities,
    AgentProvenance,
    AgentRole,
    AgentRoleBinding,
    AgentRuntime,
    AgentToolCall,
    AgentUsage,
)
from sciretriever.agents.ports import AgentProviderCall
from sciretriever.literature.content import metadata_sha256
from sciretriever.model.access import (
    AccessFailure,
    BoundedByteStream,
    BrowserCapture,
    BrowserCaptureBatch,
    BrowserCaptureKind,
    BrowserRequest,
    BrowserResult,
)
from sciretriever.model.acquisition import (
    AcquisitionPath,
    AssetHint,
    AssetHintKind,
    AssetRole,
)
from sciretriever.model.literature import (
    Author,
    AuthorKind,
    Identifier,
    Literature,
    LiteratureStatus,
    VersionRole,
)
from sciretriever.model.metadata import LiteratureMetadata, MetadataObservation
from sciretriever.model.primitives import (
    LiteratureId,
    MetaLiteratureId,
    ObservationId,
    ProvenanceId,
    Sha256,
    SourceKind,
    UtcTimestamp,
    sha256_digest,
)
from sciretriever.model.provenance import Provenance
from sciretriever.network.admission import AccessPolicy, AccessScope
from sciretriever.network.browser import (
    BrowserCaptureCorrelation,
    BrowserCaptureEvidence,
    BrowserCapturePolicy,
    BrowserDestinationGuard,
    BrowserDestinationKind,
    BrowserFlowController,
    BrowserFlowSession,
    BrowserOperationLimits,
    BrowserPageObservation,
)
from sciretriever.network.browser_control import (
    BROWSER_OBSERVATION_MEDIA_TYPE,
    BrowserAction,
    BrowserActionOutcome,
    BrowserActionReceipt,
    BrowserAgentStatus,
    BrowserBounds,
    BrowserCandidateTimeoutTransition,
    BrowserCapturedTransition,
    BrowserCaptureState,
    BrowserElement,
    BrowserElementState,
    BrowserObservation,
    BrowserPageState,
    BrowserScreenshot,
    BrowserScrollState,
    BrowserSettledTransition,
    BrowserStepDriver,
    BrowserStepPolicy,
    BrowserStepSession,
    BrowserStoppedTransition,
    BrowserSurface,
    BrowserSurfaceKind,
    BrowserTransition,
    BrowserViewport,
    Stop,
)

_TIME = UtcTimestamp("2026-09-05T00:00:00Z")
_DOI = "10.1000/generic-browser"
_PDF = b"%PDF-1.7\nfixture-main-pdf"


def _id(index: int) -> str:
    return f"{index:08x}-e89b-42d3-a456-426614174000"


def _observation(
    *,
    revision: int = 1,
    page_state: BrowserPageState = BrowserPageState.NORMAL,
    capture_state: BrowserCaptureState = BrowserCaptureState.NONE,
    agent_status: BrowserAgentStatus = BrowserAgentStatus.RUNNING,
    surface_title: str = "Generic Browser article",
) -> BrowserObservation:
    viewport = BrowserViewport(width=1280, height=720)
    screenshot = f"browser-screen-{revision}".encode()
    return BrowserObservation(
        article_token="article-fixture",
        revision=revision,
        page_id="p00000001",
        surfaces=(
            BrowserSurface(
                surface_id="s00000001",
                page_id="p00000001",
                kind=BrowserSurfaceKind.PAGE,
                parent_surface_id=None,
                origin="https://publisher.invalid",
                path="/article/generic-browser",
                title=surface_title,
                viewport=viewport,
                bounds=BrowserBounds(x=0, y=0, width=1280, height=720),
                scroll=BrowserScrollState(x=0, y=0, maximum_x=0, maximum_y=1400),
            ),
        ),
        elements=(
            BrowserElement(
                element_id="e00000001",
                surface_id="s00000001",
                role="button",
                name="Download PDF",
                state=BrowserElementState.ENABLED,
                bounds=BrowserBounds(x=20, y=20, width=180, height=40),
            ),
        ),
        screenshot=BrowserScreenshot(
            screenshot_id=f"i{revision:08x}",
            article_token="article-fixture",
            page_id="p00000001",
            surface_id="s00000001",
            revision=revision,
            viewport=viewport,
            media_type=BROWSER_OBSERVATION_MEDIA_TYPE,
            sha256=sha256_digest(screenshot),
            content=screenshot,
        ),
        page_state=page_state,
        agent_status=agent_status,
        capture_state=capture_state,
    )


class _AgentProvider:
    provider_name = "fixture-browser-agent"

    def __init__(self, action: str = "click_element", *, stop_reason: str = "normal-miss") -> None:
        self.action = action
        self.stop_reason = stop_reason
        self.calls: list[AgentProviderCall] = []

    def execute(self, call: AgentProviderCall) -> AgentToolCall:
        self.calls.append(call)
        summary = json.loads(call.text_parts[1].text)
        arguments: dict[str, object] = {
            "article_token": summary["article_token"],
            "page_id": summary["page_id"],
            "revision": summary["revision"],
        }
        if self.action == "click_element":
            arguments.update(
                {
                    "surface_id": "s00000001",
                    "element_id": "e00000001",
                }
            )
        elif self.action == "stop":
            arguments["reason"] = self.stop_reason
        encoded = json.dumps(arguments, sort_keys=True, separators=(",", ":"))
        return AgentToolCall(
            tool_name=self.action,
            arguments=encoded,
            provenance=AgentProvenance(
                provider=self.provider_name,
                model=call.model,
                input_sha256=call.input_sha256,
                parameters_sha256=sha256_digest(b"browser-test-parameters"),
                usage=AgentUsage(output_tokens=1, response_bytes=len(encoded)),
            ),
        )


def _runtime(provider: _AgentProvider) -> AgentRuntime:
    return AgentRuntime(
        adapter=provider,
        browser=AgentRoleBinding(
            role=AgentRole.BROWSER,
            model="fixture-browser-model",
            capabilities=AgentModelCapabilities(
                context_window_tokens=1_000_000,
                max_output_tokens=131_072,
                image_input=True,
                tool_decision=True,
                supported_image_media_types=frozenset({BROWSER_OBSERVATION_MEDIA_TYPE}),
                max_image_count=1,
                max_image_bytes=2 * 1024 * 1024,
            ),
            limits=AgentCallLimits(
                max_prompt_bytes=131_072,
                max_input_bytes=2 * 1024 * 1024,
                max_request_bytes=3 * 1024 * 1024,
                max_response_bytes=1 * 1024 * 1024,
                max_result_bytes=1 * 1024 * 1024,
                max_output_tokens=131_072,
                context_window_tokens=1_000_000,
            ),
        ),
    )


class _Driver:
    def __init__(
        self,
        *,
        terminal: str = "captured",
        page_state: BrowserPageState = BrowserPageState.NORMAL,
    ) -> None:
        self.terminal = terminal
        self.current = _observation(page_state=page_state)
        self.actions: list[BrowserAction] = []

    def begin(
        self,
        *,
        page_state: BrowserPageState,
        timeout_seconds: float,
    ) -> BrowserObservation:
        del page_state
        if timeout_seconds <= 0:
            raise AssertionError("Browser timeout must be positive")
        return self.current

    def settle(
        self,
        observation: BrowserObservation,
        *,
        timeout_seconds: float,
    ) -> BrowserTransition:
        if timeout_seconds <= 0:
            raise AssertionError("Browser timeout must be positive")
        return BrowserSettledTransition(observation=observation, changed=False)

    def execute(
        self,
        action: BrowserAction,
        observation: BrowserObservation,
        *,
        timeout_seconds: float,
    ) -> BrowserTransition:
        if timeout_seconds <= 0:
            raise AssertionError("Browser timeout must be positive")
        self.actions.append(action)
        if isinstance(action, Stop):
            stopped = replace(observation, agent_status=BrowserAgentStatus.STOPPED)
            return BrowserStoppedTransition(
                receipt=_receipt(action, observation, stopped),
                observation=stopped,
            )
        if self.terminal == "candidate-timeout":
            candidate = _observation(revision=2, capture_state=BrowserCaptureState.CANDIDATE)
            return BrowserCandidateTimeoutTransition(
                observation=candidate,
                receipt=_receipt(action, observation, candidate),
            )
        captured = _observation(revision=2, capture_state=BrowserCaptureState.CAPTURED)
        return BrowserCapturedTransition(
            observation=captured,
            receipt=_receipt(action, observation, captured),
        )


def _receipt(
    action: BrowserAction,
    before: BrowserObservation,
    after: BrowserObservation,
) -> BrowserActionReceipt:
    return BrowserActionReceipt(
        action_kind=action.kind,
        outcome=BrowserActionOutcome.APPLIED,
        article_token=before.article_token,
        page_id=before.page_id,
        surface_id=action.surface_id,
        before_revision=before.revision,
        after_revision=after.revision,
        elapsed_milliseconds=1,
    )


class _FlowSession:
    def __init__(self, driver: _Driver) -> None:
        self.driver = driver

    def browser_steps(
        self,
        policy: BrowserStepPolicy,
        *,
        timeout_seconds: float,
    ) -> BrowserStepSession:
        return BrowserStepSession(
            driver=cast(BrowserStepDriver, self.driver),
            policy=policy,
            timeout_seconds=timeout_seconds,
        )

    def click(self, selector: str) -> bool:
        del selector
        raise AssertionError("generic Agent control does not use selectors")

    def open_viewer(self, locator: str) -> None:
        del locator
        raise AssertionError("generic Agent control does not inject locators")

    def open_verified_locator(self, locator: str) -> None:
        del locator
        raise AssertionError("generic Agent control does not inject locators")

    def discover_pdf_locators(self) -> tuple[str, ...]:
        return ()

    def capture_available(self, kind: BrowserCaptureKind) -> bool:
        del kind
        return False

    def wait_for_capture(self, kind: BrowserCaptureKind) -> None:
        del kind

    def wait_for_any_capture(self, kinds: tuple[BrowserCaptureKind, ...]) -> None:
        del kinds

    def has_selector(self, selector: str) -> bool:
        del selector
        return False

    def text(self, selector: str) -> str:
        del selector
        return ""

    def observe(self) -> BrowserPageObservation:
        return BrowserPageObservation("https://publisher.invalid/article/generic-browser", 200)


class _Runner:
    def __init__(
        self,
        result: BrowserResult,
        *,
        terminal: str = "captured",
        page_state: BrowserPageState = BrowserPageState.NORMAL,
        fail: bool = False,
        run_controller: bool = True,
    ) -> None:
        self.result = result
        self.driver = _Driver(terminal=terminal, page_state=page_state)
        self.fail = fail
        self.run_controller = run_controller
        self.calls: list[tuple[AccessScope, BrowserRequest, AccessPolicy]] = []
        self.destination_guard: BrowserDestinationGuard | None = None
        self.capture_policy: BrowserCapturePolicy | None = None

    def run(
        self,
        scope: AccessScope,
        request: BrowserRequest | str,
        policy: AccessPolicy,
        *,
        controller: BrowserFlowController | None = None,
        destination_guard: BrowserDestinationGuard | None = None,
        capture_policy: BrowserCapturePolicy | None = None,
        navigation_only: bool = False,
        discard_unapproved_subresources: bool = False,
        limits: BrowserOperationLimits | None = None,
        timeout_seconds: float | None = None,
        cancel_event: threading.Event | None = None,
    ) -> BrowserResult:
        del limits, timeout_seconds, cancel_event
        if self.fail:
            raise RuntimeError("browser fixture failure")
        if not isinstance(request, BrowserRequest):
            raise AssertionError("generic Browser must use a bounded request")
        if controller is None or destination_guard is None or capture_policy is None:
            raise AssertionError("generic Browser requires controller and Network policies")
        if navigation_only or not discard_unapproved_subresources:
            raise AssertionError("generic Browser operation flags are incorrect")
        self.calls.append((scope, request, policy))
        self.destination_guard = destination_guard
        self.capture_policy = capture_policy
        if self.run_controller:
            controller.run(cast(BrowserFlowSession, _FlowSession(self.driver)))
        if isinstance(self.result, BrowserCaptureBatch):
            for capture in self.result.captures:
                capture_policy.decide(
                    BrowserCaptureEvidence(
                        locator=capture.stream.final_locator,
                        kind=capture.kind,
                        media_type=capture.stream.media_type,
                        correlation=BrowserCaptureCorrelation.DIRECT_REQUEST,
                        request_navigation=True,
                        from_exact_start=capture.stream.final_locator == request.url,
                        redirect_depth=0,
                        native_download=capture.kind is BrowserCaptureKind.DOWNLOAD,
                    )
                )
        return self.result


def _capture(
    *,
    kind: BrowserCaptureKind = BrowserCaptureKind.DOWNLOAD,
    body: bytes = _PDF,
    media_type: str = "application/pdf",
    locator: str = "https://publisher.invalid/article/generic-browser.pdf",
) -> BrowserCapture:
    return BrowserCapture(
        kind=kind,
        stream=BoundedByteStream(
            chunks=(body,),
            media_type=media_type,
            final_locator=locator,
            size=len(body),
        ),
    )


def _failure(code: str = "no-download") -> AccessFailure:
    return AccessFailure(
        code=code,
        reason="The Browser fixture did not return a PDF.",
        action="Try another source.",
        retryable=False,
    )


def _request(
    *,
    hint: AssetHint | None = None,
    resolved_landing_origin: str | None = None,
) -> AcquisitionRequest:
    metadata = LiteratureMetadata(
        title="Generic Browser article",
        authors=(Author(kind=AuthorKind.PERSON, display_name="Ada Lovelace"),),
        identifiers=(Identifier(namespace="doi", value=_DOI),),
    )
    literature = Literature(
        literature_id=LiteratureId(_id(1)),
        meta_literature_id=MetaLiteratureId(_id(2)),
        version_role=VersionRole.PUBLISHED,
        metadata=metadata,
        status=LiteratureStatus.UNREVIEWED,
    )
    observations: tuple[MetadataObservation, ...] = ()
    if hint is not None:
        observations = (
            MetadataObservation(
                observation_id=ObservationId(_id(3)),
                provenance=Provenance(
                    provenance_id=ProvenanceId(_id(4)),
                    source_kind=SourceKind.METADATA_PROVIDER,
                    source_name="fixture-metadata",
                    source_record_id="fixture-record",
                    observed_at=_TIME,
                    input_sha256=Sha256("a" * 64),
                    parameters_sha256=None,
                ),
                metadata=metadata,
                asset_hints=(hint,),
            ),
        )
    return AcquisitionRequest(
        literature=literature,
        expected_facts=AcquisitionExpectedFacts(
            literature_id=literature.literature_id,
            meta_literature_id=literature.meta_literature_id,
            metadata_revision=1,
            metadata_sha256=metadata_sha256(metadata),
            expected_no_primary_pdf=True,
        ),
        observations=observations,
        resolved_landing_origin=resolved_landing_origin,
    )


def _context(
    request: AcquisitionRequest,
    *,
    route_hints: tuple[AccessRouteHint, ...] = (),
) -> RouteExecutionContext:
    return RouteExecutionContext(
        request=request,
        evidence=build_acquisition_evidence(request),
        route_hints=route_hints,
        candidate_keys=CandidateKeyTracker(),
    )


class GenericBrowserSourceTests(unittest.TestCase):
    def test_generic_step_policy_classifies_a_visible_challenge(self) -> None:
        assessment = _GenericStepPolicy().assess(
            _observation(surface_title="Just a moment — verify you are human")
        )

        self.assertIs(assessment.page_state, BrowserPageState.CHALLENGE)

    def test_generic_destination_guard_accepts_only_safe_https_destinations(self) -> None:
        guard = build_generic_browser_destination_guard(
            "https://doi.org/10.1234/generic-browser",
            article_origins=(
                "https://publisher.invalid",
                "https://assets.invalid",
                "https://publisher.invalid",
            ),
        )
        self.assertIsInstance(guard, GenericBrowserDestinationGuard)
        self.assertEqual(
            guard.connection_origins(),
            (
                "https://doi.org",
                "https://publisher.invalid",
                "https://assets.invalid",
            ),
        )
        guard.check("https://assets.invalid/article.pdf", BrowserDestinationKind.DOWNLOAD)
        with self.assertRaises(ValueError):
            guard.check("http://assets.invalid/article.pdf", BrowserDestinationKind.DOWNLOAD)
        with self.assertRaises(ValueError):
            build_generic_browser_destination_guard(
                "https://doi.org/10.1234/generic-browser",
                article_origins=("https://publisher.invalid/article",),
            )

    def test_landing_hint_enters_agent_and_article_goal_reaches_the_model(self) -> None:
        provider = _AgentProvider()
        runner = _Runner(BrowserCaptureBatch(captures=(_capture(),)))
        source = ControlledBrowserPdfSource(runner=runner, agent_runtime=_runtime(provider))
        request = _request(
            hint=AssetHint(
                url="https://publisher.invalid/article/generic-browser",
                kind=AssetHintKind.LANDING_PAGE,
                asset_role=AssetRole.PRIMARY_PDF,
            )
        )

        results = tuple(source.execute(_context(request)))

        self.assertEqual(CONTROLLED_BROWSER_PRODUCTION_STATUS.readiness.value, "ready")
        self.assertEqual(tuple(result.outcome for result in results), (RouteOutcome.PDF_DELIVERED,))
        delivery = results[0].temporary_pdf
        self.assertIsNotNone(delivery)
        assert delivery is not None
        self.assertEqual(delivery.candidate.acquisition_path, AcquisitionPath.CONTROLLED_BROWSER)
        self.assertEqual(delivery.candidate.source_name, "controlled-browser")
        self.assertEqual(
            delivery.safe_source_url, "https://publisher.invalid/article/generic-browser.pdf"
        )
        self.assertEqual(len(provider.calls), 1)
        summary = json.loads(provider.calls[0].text_parts[1].text)
        self.assertEqual(
            summary["article_goal"],
            {
                "doi": _DOI,
                "title": "Generic Browser article",
                "authors": ["Ada Lovelace"],
                "landing_origins": ["https://publisher.invalid"],
                "asset_origins": [],
            },
        )
        self.assertEqual(len(runner.driver.actions), 1)
        delivery.content.discard()

    def test_doi_fallback_uses_the_resolver_but_retains_the_landing_scope(self) -> None:
        provider = _AgentProvider()
        runner = _Runner(BrowserCaptureBatch(captures=(_capture(),)))
        source = ControlledBrowserPdfSource(runner=runner, agent_runtime=_runtime(provider))
        request = _request(resolved_landing_origin="https://publisher.invalid")

        results = tuple(source.execute(_context(request)))

        self.assertEqual(results[0].outcome, RouteOutcome.PDF_DELIVERED)
        scope, browser_request, _policy = runner.calls[0]
        self.assertEqual(scope, AccessScope("publisher.invalid", "web"))
        self.assertEqual(browser_request.url, f"https://doi.org/{_DOI}")
        assert isinstance(runner.destination_guard, GenericBrowserDestinationGuard)
        self.assertEqual(
            runner.destination_guard.connection_origins(),
            ("https://doi.org", "https://publisher.invalid"),
        )
        results[0].temporary_pdf.content.discard()  # type: ignore[union-attr]

    def test_canonical_landing_hint_starts_browser_on_the_resolved_page(self) -> None:
        provider = _AgentProvider()
        runner = _Runner(BrowserCaptureBatch(captures=(_capture(),)))
        source = ControlledBrowserPdfSource(runner=runner, agent_runtime=_runtime(provider))
        request = _request(resolved_landing_origin="https://publisher.invalid")
        hint = AccessRouteHint(
            kind=AccessRouteHintKind.CANONICAL_LANDING,
            value="https://publisher.invalid/article/generic-browser",
            source_route_key="public:doi-landing",
            profile_access_key="publisher-invalid",
        )

        results = tuple(source.execute(_context(request, route_hints=(hint,))))

        self.assertEqual(results[0].outcome, RouteOutcome.PDF_DELIVERED)
        _scope, browser_request, _policy = runner.calls[0]
        self.assertEqual(
            browser_request.url,
            "https://publisher.invalid/article/generic-browser",
        )
        self.assertEqual(len(runner.calls), 1)
        results[0].temporary_pdf.content.discard()  # type: ignore[union-attr]

    def test_capture_mechanisms_are_ordered_and_non_pdf_delivery_is_rejected(self) -> None:
        provider = _AgentProvider()
        captures = BrowserCaptureBatch(
            captures=(
                _capture(kind=BrowserCaptureKind.POPUP, body=b"popup"),
                _capture(
                    kind=BrowserCaptureKind.DOWNLOAD,
                    body=b"download",
                    locator="https://assets.invalid/download.pdf",
                ),
                _capture(
                    kind=BrowserCaptureKind.RESPONSE,
                    body=b"html",
                    media_type="text/html",
                    locator="https://publisher.invalid/article/body",
                ),
            )
        )
        runner = _Runner(captures)
        source = ControlledBrowserPdfSource(runner=runner, agent_runtime=_runtime(provider))
        request = _request(
            hint=AssetHint(
                url="https://publisher.invalid/article/generic-browser",
                kind=AssetHintKind.LANDING_PAGE,
            )
        )

        results = tuple(source.execute(_context(request)))

        self.assertEqual(len(results), 2)
        bodies: list[bytes] = []
        for result in results:
            self.assertEqual(result.outcome, RouteOutcome.PDF_DELIVERED)
            assert result.temporary_pdf is not None
            with result.temporary_pdf.content.open() as stream:
                bodies.append(stream.read())
            result.temporary_pdf.content.discard()
        self.assertEqual(bodies, [b"download", b"popup"])

    def test_supplement_hint_and_empty_evidence_do_not_start_the_browser(self) -> None:
        provider = _AgentProvider()
        runner = _Runner(BrowserCaptureBatch(captures=(_capture(),)))
        source = ControlledBrowserPdfSource(runner=runner, agent_runtime=_runtime(provider))
        supplement = _request(
            hint=AssetHint(
                url="https://publisher.invalid/article/supplement.pdf",
                kind=AssetHintKind.DIRECT_FILE,
                asset_role=AssetRole.SUPPLEMENTARY_PDF,
            )
        )
        without_action = _request()

        for request in (supplement, without_action):
            with self.subTest(request=request):
                result = tuple(source.execute(_context(request)))
                self.assertEqual(
                    tuple(item.outcome for item in result),
                    (RouteOutcome.NORMAL_MISS,),
                )
        self.assertEqual(runner.calls, [])
        self.assertEqual(provider.calls, [])

    def test_stop_is_a_normal_miss_and_pending_candidate_does_not_end_agent_early(self) -> None:
        request = _request(
            hint=AssetHint(
                url="https://publisher.invalid/article/generic-browser",
                kind=AssetHintKind.LANDING_PAGE,
            )
        )
        stop_provider = _AgentProvider("stop")
        stop_source = ControlledBrowserPdfSource(
            runner=_Runner(_failure(), terminal="stopped"),
            agent_runtime=_runtime(stop_provider),
        )
        self.assertEqual(
            tuple(item.outcome for item in stop_source.execute(_context(request))),
            (RouteOutcome.NORMAL_MISS,),
        )

        timeout_source = ControlledBrowserPdfSource(
            runner=_Runner(_failure(), terminal="candidate-timeout"),
            agent_runtime=_runtime(_AgentProvider()),
        )
        with self.assertRaises(AcquisitionSourceFailure) as caught:
            tuple(timeout_source.execute(_context(request)))
        self.assertEqual(caught.exception.failure.code, "controller-safety-limit")

    def test_agent_stop_preserves_specific_visible_page_reason(self) -> None:
        request = _request(
            hint=AssetHint(
                url="https://publisher.invalid/article/generic-browser",
                kind=AssetHintKind.LANDING_PAGE,
            )
        )
        expected = {
            "challenge-unresolved": "acquisition-browser-challenge-unresolved",
            "login-required": "acquisition-browser-login-required",
            "mfa-required": "acquisition-browser-mfa-required",
            "not-entitled": "acquisition-browser-not-entitled",
            "access-denied": "acquisition-browser-access-denied",
            "not-found": "acquisition-browser-not-found",
        }
        for stop_reason, failure_code in expected.items():
            with self.subTest(stop_reason=stop_reason):
                source = ControlledBrowserPdfSource(
                    runner=_Runner(_failure(), terminal="stopped"),
                    agent_runtime=_runtime(_AgentProvider("stop", stop_reason=stop_reason)),
                )
                with self.assertRaises(AcquisitionSourceFailure) as caught:
                    tuple(source.execute(_context(request)))
                self.assertEqual(caught.exception.failure.code, failure_code)

    def test_cancellation_is_operation_wide_and_runtime_failure_is_source_scoped(self) -> None:
        request = _request(
            hint=AssetHint(
                url="https://publisher.invalid/article/generic-browser",
                kind=AssetHintKind.LANDING_PAGE,
            )
        )
        cancelled = threading.Event()
        cancelled.set()
        cancelled_source = ControlledBrowserPdfSource(
            runner=_Runner(_failure()),
            agent_runtime=_runtime(_AgentProvider()),
            cancel_event=cancelled,
        )
        with self.assertRaises(AcquisitionFailure) as caught:
            tuple(cancelled_source.execute(_context(request)))
        self.assertEqual(caught.exception.failure.code, "acquisition-browser-cancelled")

        failed_source = ControlledBrowserPdfSource(
            runner=_Runner(_failure(), fail=True),
            agent_runtime=_runtime(_AgentProvider()),
        )
        with self.assertRaises(AcquisitionSourceFailure) as caught:
            tuple(failed_source.execute(_context(request)))
        self.assertEqual(caught.exception.failure.code, "acquisition-browser-runtime-failed")

    def test_network_failure_before_first_observation_is_not_a_contract_failure(self) -> None:
        request = _request(
            hint=AssetHint(
                url="https://publisher.invalid/article/generic-browser",
                kind=AssetHintKind.LANDING_PAGE,
            )
        )
        source = ControlledBrowserPdfSource(
            runner=_Runner(_failure("policy"), run_controller=False),
            agent_runtime=_runtime(_AgentProvider()),
        )

        with self.assertRaises(AcquisitionSourceFailure) as caught:
            tuple(source.execute(_context(request)))

        self.assertEqual(caught.exception.failure.code, "policy")

    def test_candidate_claim_prevents_replaying_the_same_article_action(self) -> None:
        provider = _AgentProvider()
        runner = _Runner(BrowserCaptureBatch(captures=(_capture(),)))
        source = ControlledBrowserPdfSource(runner=runner, agent_runtime=_runtime(provider))
        request = _request(
            hint=AssetHint(
                url="https://publisher.invalid/article/generic-browser",
                kind=AssetHintKind.LANDING_PAGE,
            )
        )
        context = _context(request)

        first = tuple(source.execute(context))
        second = tuple(source.execute(context))

        self.assertEqual(first[0].outcome, RouteOutcome.PDF_DELIVERED)
        self.assertEqual(second[0].outcome, RouteOutcome.NORMAL_MISS)
        self.assertEqual(len(runner.calls), 1)
        assert first[0].temporary_pdf is not None
        first[0].temporary_pdf.content.discard()


if __name__ == "__main__":
    unittest.main()
