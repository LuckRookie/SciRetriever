from __future__ import annotations

import inspect
import json
import re
import threading
import unittest
from collections.abc import Callable, Iterable
from contextlib import AbstractContextManager
from pathlib import Path
from typing import BinaryIO, cast

from sciretriever.acquisition.planning import RouteReadiness
from sciretriever.acquisition.ports import (
    AcquisitionExpectedFacts,
    AcquisitionFailure,
    CandidateKeyTracker,
    TemporaryPdf,
)
from sciretriever.acquisition.routing import (
    AcquisitionEvidence,
    AcquisitionRequest,
    build_acquisition_evidence,
)
from sciretriever.acquisition.sources.browser import (
    CONTROLLED_BROWSER_PRODUCTION_STATUS,
    BrowserFlowSession,
    BrowserRunner,
    ControlledBrowserPdfSource,
)
from sciretriever.acquisition.sources.browser_rules import (
    PRODUCTION_BROWSER_RULE_CATALOG,
    BrowserActionKind,
    BrowserPageMarker,
    BrowserPageMarkerKind,
    BrowserRuleAction,
    BrowserRuleCatalog,
    BrowserSiteRule,
)
from sciretriever.acquisition.sources.direct import WebAccessProfileResolver
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
)
from sciretriever.model.provenance import Provenance
from sciretriever.network.admission import AccessPolicy, AccessScope
from sciretriever.network.browser import (
    BrowserBudget,
    BrowserCaptureGuard,
    BrowserClient,
    BrowserDestinationGuard,
    BrowserDestinationKind,
    BrowserPageObservation,
)

_TIME = UtcTimestamp("2026-08-11T12:00:00Z")
_FIXTURES = Path(__file__).parent / "fixtures" / "acquisition" / "browser"
_CANDIDATE_KEY = re.compile(r"controlled-browser:[0-9a-f]{64}\Z")


def _browser_client_runner_contract(client: BrowserClient) -> BrowserRunner:
    """Static assertion that A8 does not depend on Network's private session type."""

    return client


def _id(index: int) -> str:
    return f"{index:08x}-e89b-12d3-a456-426614174000"


class _IdFactory:
    def __init__(self, start: int = 1000) -> None:
        self._next = start

    def __call__(self) -> ProvenanceId:
        value = ProvenanceId(_id(self._next))
        self._next += 1
        return value


def _page_states() -> dict[str, dict[str, str]]:
    with (_FIXTURES / "page-states.json").open(encoding="utf-8") as stream:
        value = json.load(stream)
    if not isinstance(value, dict):
        raise AssertionError("browser fixture must contain an object")
    result: dict[str, dict[str, str]] = {}
    for state_name, raw_markers in value.items():
        if not isinstance(state_name, str) or not isinstance(raw_markers, dict):
            raise AssertionError("browser fixture state is invalid")
        markers: dict[str, str] = {}
        for selector, text in raw_markers.items():
            if not isinstance(selector, str) or not isinstance(text, str):
                raise AssertionError("browser fixture marker is invalid")
            markers[selector] = text
        result[state_name] = markers
    return result


def _access_page_states() -> dict[str, tuple[dict[str, str], BrowserPageObservation]]:
    with (_FIXTURES / "access-page-states.json").open(encoding="utf-8") as stream:
        value = json.load(stream)
    if not isinstance(value, dict):
        raise AssertionError("Browser access fixture must contain an object")
    result: dict[str, tuple[dict[str, str], BrowserPageObservation]] = {}
    for state_name, raw_state in value.items():
        if not isinstance(state_name, str) or not isinstance(raw_state, dict):
            raise AssertionError("Browser access fixture state is invalid")
        if set(raw_state) != {"locator", "status_code", "markers"}:
            raise AssertionError("Browser access fixture state is incomplete")
        locator = raw_state["locator"]
        status_code = raw_state["status_code"]
        raw_markers = raw_state["markers"]
        if (
            not isinstance(locator, str)
            or type(status_code) is not int
            or not isinstance(raw_markers, dict)
        ):
            raise AssertionError("Browser access fixture observation is invalid")
        markers: dict[str, str] = {}
        for selector, marker_text in raw_markers.items():
            if not isinstance(selector, str) or not isinstance(marker_text, str):
                raise AssertionError("Browser access fixture marker is invalid")
            markers[selector] = marker_text
        result[state_name] = (
            markers,
            BrowserPageObservation(locator=locator, status_code=status_code),
        )
    return result


def _access_page_markers() -> tuple[BrowserPageMarker, ...]:
    return (
        BrowserPageMarker(
            marker_id="authenticated",
            kind=BrowserPageMarkerKind.AUTHENTICATED,
            css_selectors=("#authenticated",),
        ),
        BrowserPageMarker(
            marker_id="article-entitled",
            kind=BrowserPageMarkerKind.ENTITLED,
            css_selectors=("#article-entitled",),
        ),
        BrowserPageMarker(
            marker_id="login-required",
            kind=BrowserPageMarkerKind.LOGIN_REQUIRED,
            css_selectors=("#login-required",),
            url_prefixes=("https://publisher.test/account/login",),
        ),
        BrowserPageMarker(
            marker_id="mfa-required",
            kind=BrowserPageMarkerKind.MFA_REQUIRED,
            css_selectors=("#mfa-required",),
            url_prefixes=("https://publisher.test/account/mfa",),
        ),
        BrowserPageMarker(
            marker_id="not-entitled",
            kind=BrowserPageMarkerKind.NOT_ENTITLED,
            response_statuses=(403,),
        ),
        BrowserPageMarker(
            marker_id="paywall",
            kind=BrowserPageMarkerKind.PAYWALL,
            response_statuses=(402,),
        ),
        BrowserPageMarker(
            marker_id="challenge-required",
            kind=BrowserPageMarkerKind.CHALLENGE_REQUIRED,
            css_selectors=("#access-challenge",),
        ),
        BrowserPageMarker(
            marker_id="rate-limited",
            kind=BrowserPageMarkerKind.RATE_LIMITED,
            response_statuses=(429,),
        ),
        BrowserPageMarker(
            marker_id="ip-blocked",
            kind=BrowserPageMarkerKind.IP_BLOCKED,
            response_statuses=(451,),
        ),
        BrowserPageMarker(
            marker_id="not-found",
            kind=BrowserPageMarkerKind.NOT_FOUND,
            response_statuses=(404,),
        ),
    )


def _failure(code: str) -> AccessFailure:
    return AccessFailure(
        code=code,
        reason="The fake Browser operation did not complete.",
        action="Use the next deterministic test action.",
        retryable=code not in {"policy", "budget", "oversize", "challenge"},
    )


def _download(
    body: bytes = b"browser bytes",
    *,
    final_locator: str = "https://publisher.test/article.pdf",
    media_type: str = "application/pdf",
) -> BrowserCaptureBatch:
    return BrowserCaptureBatch(
        captures=(
            BrowserCapture(
                kind=BrowserCaptureKind.DOWNLOAD,
                stream=BoundedByteStream(
                    chunks=(body,),
                    media_type=media_type,
                    final_locator=final_locator,
                    size=len(body),
                ),
            ),
        )
    )


def _capture_batch(
    *values: tuple[bytes, BrowserCaptureKind, str, str],
) -> BrowserCaptureBatch:
    return BrowserCaptureBatch(
        captures=tuple(
            BrowserCapture(
                kind=kind,
                stream=BoundedByteStream(
                    chunks=(body,),
                    media_type=media_type,
                    final_locator=locator,
                    size=len(body),
                ),
            )
            for body, kind, locator, media_type in values
        )
    )


class _FakeSession:
    def __init__(
        self,
        marker_text: dict[str, str] | None = None,
        observation: BrowserPageObservation | None = None,
    ) -> None:
        self.marker_text = {} if marker_text is None else marker_text
        self.observation = observation or BrowserPageObservation(
            locator="https://publisher.test/article",
            status_code=200,
        )
        self.text_calls: list[str] = []
        self.clicks: list[str] = []
        self.viewer_opens: list[str] = []
        self.verified_locator_opens: list[str] = []
        self.capture_waits: list[BrowserCaptureKind] = []
        self.fill_calls: list[tuple[str, str]] = []

    def text(self, selector: str) -> str:
        self.text_calls.append(selector)
        return self.marker_text.get(selector, "")

    def click(self, selector: str) -> None:
        self.clicks.append(selector)

    def open_viewer(self, locator: str) -> None:
        self.viewer_opens.append(locator)

    def open_verified_locator(self, locator: str) -> None:
        self.verified_locator_opens.append(locator)

    def wait_for_capture(self, kind: BrowserCaptureKind) -> None:
        self.capture_waits.append(kind)

    def observe(self) -> BrowserPageObservation:
        return self.observation

    # This deliberately exists on the fake so tests can prove A8 never uses a
    # login-filling capability even when a vendor object happened to expose it.
    def fill(self, selector: str, value: str) -> None:
        self.fill_calls.append((selector, value))


RunHook = Callable[[AccessScope, BrowserRequest, AccessPolicy, BrowserBudget], None]


class _FakeRunner:
    def __init__(
        self,
        results: Iterable[BrowserResult | BaseException | object],
        *,
        marker_states: Iterable[dict[str, str]] = (),
        page_observations: Iterable[BrowserPageObservation] = (),
        on_run: RunHook | None = None,
    ) -> None:
        self.results = list(results)
        self.marker_states = list(marker_states)
        self.page_observations = list(page_observations)
        self.on_run = on_run
        self.calls: list[dict[str, object]] = []
        self.sessions: list[_FakeSession] = []
        self.completed = 0

    def run(
        self,
        scope: AccessScope,
        request: BrowserRequest | str,
        policy: AccessPolicy,
        *,
        flow: Callable[[BrowserFlowSession], object] | None = None,
        destination_guard: BrowserDestinationGuard | None = None,
        capture_guard: BrowserCaptureGuard | None = None,
        budget: BrowserBudget | None = None,
        timeout_seconds: float | None = None,
        cancel_event: threading.Event | None = None,
    ) -> BrowserResult:
        if not isinstance(request, BrowserRequest):
            raise AssertionError("A8 must use a bounded BrowserRequest")
        if budget is None:
            raise AssertionError("A8 must supply a Browser budget")
        self.calls.append(
            {
                "scope": scope,
                "request": request,
                "policy": policy,
                "destination_guard": destination_guard,
                "capture_guard": capture_guard,
                "budget": budget,
                "timeout_seconds": timeout_seconds,
                "cancel_event": cancel_event,
            }
        )
        if self.on_run is not None:
            self.on_run(scope, request, policy, budget)
        marker_state = self.marker_states.pop(0) if self.marker_states else {}
        observation = (
            self.page_observations.pop(0)
            if self.page_observations
            else BrowserPageObservation(
                locator="https://publisher.test/article",
                status_code=200,
            )
        )
        session = _FakeSession(marker_state, observation)
        self.sessions.append(session)
        try:
            if flow is not None:
                flow(session)
            if not self.results:
                raise AssertionError("unexpected Browser invocation")
            result = self.results.pop(0)
            if isinstance(result, BaseException):
                raise result
            return cast(BrowserResult, result)
        finally:
            # The fake has no vendor resources.  This flag models the runner's
            # guarantee that its flow lifetime ended before returning.
            self.completed += 1


def _rule(
    *,
    rule_id: str = "fixture-publisher",
    revision: int = 1,
    landing_origin: str = "https://publisher.test",
    allowed_origins: tuple[str, ...] = (
        "https://publisher.test",
        "https://downloads.publisher.test",
    ),
    web_scope_provider_name: str = "publisher.test",
    actions: tuple[BrowserRuleAction, ...] | None = None,
    max_actions: int = 8,
    login_markers: tuple[str, ...] = ("#login-required",),
    mfa_markers: tuple[str, ...] = ("#mfa-required",),
    page_markers: tuple[BrowserPageMarker, ...] | None = None,
    capture_url_prefixes: tuple[str, ...] | None = None,
) -> BrowserSiteRule:
    markers = (
        tuple(
            marker
            for marker in (
                (
                    BrowserPageMarker(
                        marker_id="login-required",
                        kind=BrowserPageMarkerKind.LOGIN_REQUIRED,
                        css_selectors=login_markers,
                    )
                    if login_markers
                    else None
                ),
                (
                    BrowserPageMarker(
                        marker_id="mfa-required",
                        kind=BrowserPageMarkerKind.MFA_REQUIRED,
                        css_selectors=mfa_markers,
                    )
                    if mfa_markers
                    else None
                ),
            )
            if marker is not None
        )
        if page_markers is None
        else page_markers
    )
    prefixes = (
        tuple(
            prefix
            for origin in allowed_origins
            for prefix in (f"{origin}/article.pdf", f"{origin}/file")
        )
        if capture_url_prefixes is None
        else capture_url_prefixes
    )
    selected_actions = (
        (
            BrowserRuleAction(
                kind=BrowserActionKind.CLICK,
                selector="a[data-action='pdf']",
            ),
        )
        if actions is None
        else actions
    )
    return BrowserSiteRule(
        rule_id=rule_id,
        revision=revision,
        landing_origin=landing_origin,
        allowed_origins=allowed_origins,
        web_scope_provider_name=web_scope_provider_name,
        actions=selected_actions,
        max_actions=max_actions,
        page_markers=markers,
        capture_url_prefixes=prefixes,
    )


def _literature(
    *,
    identifiers: tuple[Identifier, ...] = (),
    publisher: str | None = None,
) -> Literature:
    return Literature(
        literature_id=LiteratureId(_id(1)),
        meta_literature_id=MetaLiteratureId(_id(2)),
        version_role=VersionRole.PUBLISHED,
        metadata=LiteratureMetadata(
            title="Controlled Browser fixture",
            identifiers=identifiers,
            publisher=publisher,
        ),
        status=LiteratureStatus.UNREVIEWED,
    )


def _observation(
    index: int,
    hints: tuple[AssetHint, ...] = (),
    *,
    provider_name: str = "fixture-metadata",
) -> MetadataObservation:
    return MetadataObservation(
        observation_id=ObservationId(_id(index)),
        provenance=Provenance(
            provenance_id=ProvenanceId(_id(index + 100)),
            source_kind=SourceKind.METADATA_PROVIDER,
            source_name=provider_name,
            source_record_id=f"record-{index}",
            observed_at=_TIME,
            input_sha256=Sha256("a" * 64),
            parameters_sha256=None,
        ),
        metadata=LiteratureMetadata(title="Observed Browser fixture"),
        asset_hints=hints,
    )


def _request(
    *,
    observations: tuple[MetadataObservation, ...] = (),
    literature: Literature | None = None,
    resolved_landing_origin: str | None = None,
) -> AcquisitionRequest:
    target = literature or _literature()
    return AcquisitionRequest(
        literature=target,
        expected_facts=AcquisitionExpectedFacts(
            literature_id=target.literature_id,
            meta_literature_id=target.meta_literature_id,
            metadata_revision=1,
            metadata_sha256=metadata_sha256(target.metadata),
            expected_no_primary_pdf=True,
        ),
        observations=observations,
        resolved_landing_origin=resolved_landing_origin,
    )


def _landing_hint(
    url: str = "https://publisher.test/article",
    *,
    kind: AssetHintKind = AssetHintKind.LANDING_PAGE,
    role: AssetRole | None = None,
) -> AssetHint:
    return AssetHint(url=url, kind=kind, asset_role=role)


def _evidence(request: AcquisitionRequest) -> AcquisitionEvidence:
    return build_acquisition_evidence(request)


def _source(
    runner: _FakeRunner,
    *,
    rule: BrowserSiteRule | None = None,
    profile_resolver: WebAccessProfileResolver | None = None,
    policy: AccessPolicy | None = None,
    cancel_event: threading.Event | None = None,
) -> ControlledBrowserPdfSource:
    return ControlledBrowserPdfSource(
        runner=runner,
        rule_catalog=BrowserRuleCatalog((_rule() if rule is None else rule,)),
        web_access_profile_resolver=profile_resolver,
        access_policy=policy,
        cancel_event=cancel_event,
        provenance_id_factory=_IdFactory(),
        clock=lambda: _TIME,
    )


def _payload(temporary_pdf: TemporaryPdf) -> bytes:
    context = temporary_pdf.content.open()
    if not isinstance(context, AbstractContextManager):
        raise AssertionError("temporary content did not return a context manager")
    with context as stream:
        return cast(BinaryIO, stream).read()


class BrowserRuleContractTests(unittest.TestCase):
    def test_production_catalog_and_readiness_are_explicitly_empty(self) -> None:
        self.assertEqual(PRODUCTION_BROWSER_RULE_CATALOG.rules, ())
        self.assertIs(
            CONTROLLED_BROWSER_PRODUCTION_STATUS.readiness,
            RouteReadiness.UNSUPPORTED,
        )
        self.assertIsNotNone(CONTROLLED_BROWSER_PRODUCTION_STATUS.failure)
        assert CONTROLLED_BROWSER_PRODUCTION_STATUS.failure is not None
        self.assertEqual(
            CONTROLLED_BROWSER_PRODUCTION_STATUS.failure.code,
            "acquisition-browser-production-unavailable",
        )

        runner = _FakeRunner([])
        source = ControlledBrowserPdfSource(runner=runner)
        request = _request(
            observations=(_observation(10, (_landing_hint(),)),),
        )
        self.assertEqual(source._actions(_evidence(request)), ())
        self.assertEqual(runner.calls, [])

    def test_rule_uses_exact_https_dns_origins_and_canonical_tokens(self) -> None:
        rule = _rule(
            rule_id="FIXTURE-PUBLISHER",
            landing_origin="https://PUBLISHER.test:443",
            allowed_origins=(
                "https://PUBLISHER.test:443",
                "https://downloads.publisher.test",
            ),
            web_scope_provider_name="PUBLISHER.TEST",
        )

        self.assertEqual(rule.rule_id, "fixture-publisher")
        self.assertEqual(rule.landing_origin, "https://publisher.test")
        self.assertEqual(rule.web_scope_provider_name, "publisher.test")
        self.assertTrue(rule.matches_origin("https://PUBLISHER.test:443/"))
        self.assertFalse(rule.matches_origin("https://sub.publisher.test"))
        self.assertTrue(rule.allows_url("https://downloads.publisher.test/file.pdf"))
        self.assertFalse(rule.allows_url("https://other.test/file.pdf"))

        invalid_origins = (
            "http://publisher.test",
            "https://*.publisher.test",
            "https://publisher.test/article",
            "https://publisher.test?rule=1",
            "https://127.0.0.1",
            "https://user@publisher.test",
        )
        for origin in invalid_origins:
            with self.subTest(origin=origin), self.assertRaises(ValueError):
                _rule(landing_origin=origin)

    def test_rule_preserves_one_explicit_nondefault_https_port(self) -> None:
        origin = "https://Publisher.test:38443"
        rule = _rule(
            landing_origin=origin,
            allowed_origins=(origin,),
        )

        self.assertEqual(rule.landing_origin, "https://publisher.test:38443")
        self.assertTrue(rule.matches_origin("https://PUBLISHER.test:38443/"))
        self.assertFalse(rule.matches_origin("https://publisher.test"))
        self.assertFalse(rule.matches_origin("https://publisher.test:38444"))
        self.assertTrue(rule.allows_url("https://publisher.test:38443/article.pdf"))
        self.assertFalse(rule.allows_url("https://publisher.test/article.pdf"))

    def test_rule_language_is_a_bounded_static_action_sequence(self) -> None:
        observe = _rule(actions=(), max_actions=0)
        self.assertEqual(observe.actions, ())
        self.assertEqual(observe.max_actions, 0)

        for selector in (
            "javascript:download()",
            "xpath=//a",
            "text=Download",
            "a >> button",
            "https://rules.test/selector",
            "a{color:red}",
        ):
            with self.subTest(selector=selector), self.assertRaises(ValueError):
                BrowserRuleAction(kind=BrowserActionKind.CLICK, selector=selector)
        with self.assertRaises(TypeError):
            BrowserRuleAction(kind=cast(BrowserActionKind, "script"))
        with self.assertRaises(ValueError):
            BrowserRuleAction(kind=BrowserActionKind.CLICK)
        with self.assertRaises(ValueError):
            BrowserRuleAction(
                kind=BrowserActionKind.CLICK,
                selector="#download",
                locator="https://publisher.test/article.pdf",
            )
        with self.assertRaises(ValueError):
            BrowserRuleAction(kind=BrowserActionKind.WAIT_FOR_CAPTURE)
        with self.assertRaises(ValueError):
            BrowserRuleAction(
                kind=BrowserActionKind.OPEN_VERIFIED_LOCATOR,
                locator="https://publisher.test/article.pdf?token=dynamic",
            )

        click = BrowserRuleAction(kind=BrowserActionKind.CLICK, selector="#download")
        with self.assertRaises(ValueError):
            _rule(actions=(click,) * 9)
        with self.assertRaises(ValueError):
            _rule(actions=(click, click), max_actions=1)
        with self.assertRaises(ValueError):
            _rule(actions=(), max_actions=9)
        with self.assertRaises(TypeError):
            _rule(actions=cast(tuple[BrowserRuleAction, ...], (object(),)))

        outside_locator = BrowserRuleAction(
            kind=BrowserActionKind.OPEN_VERIFIED_LOCATOR,
            locator="https://outside.test/article.pdf",
        )
        with self.assertRaises(ValueError):
            _rule(actions=(outside_locator,))
        unreviewed_locator = BrowserRuleAction(
            kind=BrowserActionKind.OPEN_VERIFIED_LOCATOR,
            locator="https://publisher.test/unreviewed.pdf",
        )
        with self.assertRaises(ValueError):
            _rule(actions=(unreviewed_locator,))
        with self.assertRaises(ValueError):
            _rule(login_markers=("#same",), mfa_markers=("#same",))

    def test_page_markers_are_bounded_static_and_rule_origin_scoped(self) -> None:
        marker = BrowserPageMarker(
            marker_id="login-required",
            kind=BrowserPageMarkerKind.LOGIN_REQUIRED,
            css_selectors=("form[data-login]",),
            url_prefixes=("https://publisher.test/account/login",),
            response_statuses=(401,),
        )
        rule = _rule(page_markers=(marker,))
        self.assertEqual(rule.page_markers, (marker,))
        self.assertNotIn("form[data-login]", repr(rule))

        invalid_markers: tuple[Callable[[], BrowserPageMarker], ...] = (
            lambda: BrowserPageMarker(
                marker_id="invalid-marker",
                kind=BrowserPageMarkerKind.LOGIN_REQUIRED,
            ),
            lambda: BrowserPageMarker(
                marker_id="invalid-marker",
                kind=BrowserPageMarkerKind.LOGIN_REQUIRED,
                css_selectors=("javascript:login()",),
            ),
            lambda: BrowserPageMarker(
                marker_id="invalid-marker",
                kind=BrowserPageMarkerKind.LOGIN_REQUIRED,
                url_prefixes=("http://publisher.test/account/login",),
            ),
            lambda: BrowserPageMarker(
                marker_id="invalid-marker",
                kind=BrowserPageMarkerKind.LOGIN_REQUIRED,
                url_prefixes=("https://publisher.test",),
            ),
            lambda: BrowserPageMarker(
                marker_id="invalid-marker",
                kind=BrowserPageMarkerKind.LOGIN_REQUIRED,
                url_prefixes=("https://publisher.test/account/login?next=article",),
            ),
            lambda: BrowserPageMarker(
                marker_id="invalid-marker",
                kind=BrowserPageMarkerKind.LOGIN_REQUIRED,
                response_statuses=(cast(int, True),),
            ),
            lambda: BrowserPageMarker(
                marker_id="invalid-marker",
                kind=BrowserPageMarkerKind.LOGIN_REQUIRED,
                response_statuses=(99,),
            ),
        )
        for index, construct in enumerate(invalid_markers):
            with self.subTest(index=index), self.assertRaises((TypeError, ValueError)):
                construct()

        outside = BrowserPageMarker(
            marker_id="outside-origin",
            kind=BrowserPageMarkerKind.LOGIN_REQUIRED,
            url_prefixes=("https://outside.test/account/login",),
        )
        with self.assertRaises(ValueError):
            _rule(page_markers=(outside,))

        duplicate_status = (
            BrowserPageMarker(
                marker_id="first-status",
                kind=BrowserPageMarkerKind.LOGIN_REQUIRED,
                response_statuses=(401,),
            ),
            BrowserPageMarker(
                marker_id="second-status",
                kind=BrowserPageMarkerKind.CHALLENGE_REQUIRED,
                response_statuses=(401,),
            ),
        )
        with self.assertRaises(ValueError):
            _rule(page_markers=duplicate_status)

    def test_rule_fingerprint_and_catalog_identity_are_stable(self) -> None:
        first = _rule()
        same = _rule()
        revised = _rule(revision=2)
        self.assertEqual(first.fingerprint, same.fingerprint)
        self.assertNotEqual(first.fingerprint, revised.fingerprint)
        wait = BrowserRuleAction(
            kind=BrowserActionKind.WAIT_FOR_CAPTURE,
            capture_kind=BrowserCaptureKind.DOWNLOAD,
        )
        click = BrowserRuleAction(kind=BrowserActionKind.CLICK, selector="#download")
        self.assertNotEqual(
            _rule(actions=(click, wait)).fingerprint,
            _rule(actions=(wait, click)).fingerprint,
        )
        self.assertNotIn("#download", repr(_rule(actions=(click, wait))))
        self.assertEqual(
            BrowserRuleCatalog((first,)).match_origin("https://publisher.test"),
            first,
        )

        with self.assertRaises(ValueError):
            BrowserRuleCatalog((first, _rule(revision=2)))
        with self.assertRaises(ValueError):
            BrowserRuleCatalog(
                (
                    first,
                    _rule(
                        rule_id="other-rule",
                        revision=2,
                        landing_origin="https://publisher.test",
                    ),
                )
            )

    def test_structural_ports_never_name_vendor_or_login_mutation_operations(self) -> None:
        self.assertTrue(isinstance(_FakeRunner([]), BrowserRunner))
        self.assertTrue(isinstance(_FakeSession(), BrowserFlowSession))
        session_methods = {
            name
            for name, value in inspect.getmembers(BrowserFlowSession)
            if inspect.isfunction(value) and not name.startswith("_")
        }
        self.assertEqual(
            session_methods,
            {
                "click",
                "observe",
                "open_verified_locator",
                "open_viewer",
                "text",
                "wait_for_capture",
            },
        )
        self.assertFalse(
            session_methods
            & {
                "fill",
                "navigate",
                "open_popup",
                "page",
                "context",
                "profile",
                "cookie",
                "script",
                "evaluate",
            }
        )


class ControlledBrowserApplicabilityTests(unittest.TestCase):
    def test_nondefault_port_hint_and_download_remain_exact_rule_scoped(self) -> None:
        origin = "https://publisher.test:38443"
        rule = _rule(landing_origin=origin, allowed_origins=(origin,))
        runner = _FakeRunner(
            [
                _download(
                    b"exact-port",
                    final_locator=f"{origin}/article.pdf",
                )
            ]
        )
        source = _source(runner, rule=rule)
        request = _request(
            observations=(
                _observation(
                    9,
                    (_landing_hint(f"{origin}/article", role=AssetRole.PRIMARY_PDF),),
                ),
            )
        )

        deliveries = list(source._deliveries(request, _evidence(request), CandidateKeyTracker()))

        self.assertEqual(len(deliveries), 1)
        self.assertEqual(deliveries[0].safe_source_url, f"{origin}/article.pdf")
        sent_request = runner.calls[0]["request"]
        self.assertIsInstance(sent_request, BrowserRequest)
        self.assertEqual(cast(BrowserRequest, sent_request).url, f"{origin}/article")

        wrong_port_runner = _FakeRunner(
            [_download(final_locator="https://publisher.test:38444/article.pdf")]
        )
        wrong_port_source = _source(wrong_port_runner, rule=rule)
        with self.assertRaises(AcquisitionFailure) as caught:
            list(
                wrong_port_source._deliveries(
                    request,
                    _evidence(request),
                    CandidateKeyTracker(),
                )
            )
        self.assertEqual(caught.exception.failure.code, "acquisition-browser-policy-failed")

    def test_only_primary_or_unspecified_landing_hints_on_an_exact_rule_apply(self) -> None:
        runner = _FakeRunner([])
        source = _source(runner)
        applicable_hints = (
            _landing_hint(),
            _landing_hint(
                "https://publisher.test/primary",
                role=AssetRole.PRIMARY_PDF,
            ),
        )
        for index, hint in enumerate(applicable_hints, start=10):
            with self.subTest(hint=hint):
                request = _request(observations=(_observation(index, (hint,)),))
                self.assertTrue(source._actions(_evidence(request)))

        excluded_hints = (
            _landing_hint(kind=AssetHintKind.DIRECT_FILE),
            _landing_hint(role=AssetRole.SUPPLEMENTARY_PDF),
            _landing_hint(role=AssetRole.XML),
            _landing_hint(role=AssetRole.HTML),
            _landing_hint("https://unknown.test/article"),
        )
        for index, hint in enumerate(excluded_hints, start=20):
            with self.subTest(hint=hint):
                request = _request(observations=(_observation(index, (hint,)),))
                self.assertFalse(source._actions(_evidence(request)))
        self.assertEqual(runner.calls, [])

    def test_doi_requires_matching_resolved_origin_while_weak_evidence_never_applies(self) -> None:
        runner = _FakeRunner([])
        source = _source(runner)
        doi_literature = _literature(
            identifiers=(Identifier(namespace="doi", value="10.1234/browser"),),
            publisher="Publisher text is not routing authority",
        )

        weak = _request(
            literature=doi_literature,
            observations=(_observation(30, provider_name="publisher.test"),),
        )
        self.assertFalse(source._actions(_evidence(weak)))

        origin_without_doi = _request(resolved_landing_origin="https://publisher.test")
        self.assertFalse(source._actions(_evidence(origin_without_doi)))

        mismatched = _request(
            literature=doi_literature,
            resolved_landing_origin="https://unknown.test",
        )
        self.assertFalse(source._actions(_evidence(mismatched)))

        strong = _request(
            literature=doi_literature,
            resolved_landing_origin="https://publisher.test",
        )
        self.assertTrue(source._actions(_evidence(strong)))
        self.assertEqual(runner.calls, [])

    def test_evidence_from_another_request_fails_before_browser_io(self) -> None:
        runner = _FakeRunner([])
        source = _source(runner)
        first = _request(observations=(_observation(40, (_landing_hint(),)),))
        other = _request(
            observations=(
                _observation(
                    41,
                    (_landing_hint("https://unknown.test/other"),),
                ),
            )
        )

        with self.assertRaises(AcquisitionFailure) as caught:
            source._deliveries(first, _evidence(other), CandidateKeyTracker())
        self.assertEqual(caught.exception.failure.code, "acquisition-browser-contract")
        self.assertEqual(runner.calls, [])

    def test_scope_mapping_must_match_rule_and_reuses_a5_profile_seam(self) -> None:
        provider_rule = _rule(web_scope_provider_name="fixture-publisher")
        with self.assertRaises(ValueError):
            _source(_FakeRunner([]), rule=provider_rule)

        profile_policy = AccessPolicy(
            max_concurrency=8,
            min_start_interval=3.0,
            cooldown_after_completion=2.0,
        )
        profile_resolver = WebAccessProfileResolver(
            {
                "publisher.test": (
                    AccessScope("fixture-publisher", "web"),
                    profile_policy,
                )
            }
        )
        runner = _FakeRunner([_failure("no-download")])
        source = _source(
            runner,
            rule=provider_rule,
            profile_resolver=profile_resolver,
            policy=AccessPolicy(
                max_concurrency=99,
                min_start_interval=7.0,
                cooldown_after_completion=1.0,
            ),
        )
        request = _request(observations=(_observation(42, (_landing_hint(),)),))
        self.assertEqual(
            list(source._deliveries(request, _evidence(request), CandidateKeyTracker())),
            [],
        )
        call = runner.calls[0]
        self.assertEqual(call["scope"], AccessScope("fixture-publisher", "web"))
        policy = call["policy"]
        self.assertIsInstance(policy, AccessPolicy)
        assert isinstance(policy, AccessPolicy)
        self.assertEqual(policy.max_concurrency, 1)
        self.assertEqual(policy.min_start_interval, 7.0)
        self.assertEqual(policy.cooldown_after_completion, 2.0)


class ControlledBrowserAcquisitionTests(unittest.TestCase):
    def test_claim_precedes_run_and_download_is_a_neutral_unvalidated_temporary_pdf(
        self,
    ) -> None:
        tracker = CandidateKeyTracker()

        def assert_claimed(
            _scope: AccessScope,
            _request_value: BrowserRequest,
            _policy: AccessPolicy,
            _budget: BrowserBudget,
        ) -> None:
            self.assertEqual(len(tracker.tried_candidate_keys), 1)

        runner = _FakeRunner(
            [
                _download(
                    b"<html>not a PDF</html>",
                    final_locator="https://downloads.publisher.test/file?view=full",
                )
            ],
            on_run=assert_claimed,
        )
        source = _source(runner)
        request = _request(
            observations=(
                _observation(
                    50,
                    (_landing_hint("https://publisher.test/article?view=full"),),
                ),
            )
        )

        deliveries = list(source._deliveries(request, _evidence(request), tracker))

        self.assertEqual(len(deliveries), 1)
        delivery = deliveries[0]
        self.assertEqual(_payload(delivery), b"<html>not a PDF</html>")
        self.assertEqual(delivery.candidate.declared_media_type, "application/pdf")
        self.assertIs(delivery.candidate.acquisition_path, AcquisitionPath.CONTROLLED_BROWSER)
        self.assertEqual(delivery.candidate.source_name, "controlled-browser")
        self.assertRegex(delivery.candidate.candidate_key, _CANDIDATE_KEY)
        for private_value in (
            "publisher.test",
            "view=full",
            "data-action",
            "article",
            "browser bytes",
        ):
            self.assertNotIn(private_value, delivery.candidate.candidate_key)
        self.assertIn(delivery.candidate.candidate_key, tracker.tried_candidate_keys)
        self.assertEqual(
            delivery.safe_source_url, "https://downloads.publisher.test/file?view=full"
        )
        self.assertEqual(delivery.provenance.source_record_id, "fixture-publisher@1")
        self.assertEqual(delivery.provenance.parameters_sha256, _rule().fingerprint)
        self.assertIsNone(delivery.provenance.input_sha256)
        delivery.content.discard()

    def test_multiple_capture_mechanisms_become_independent_temporary_candidates(self) -> None:
        runner = _FakeRunner(
            [
                _capture_batch(
                    (
                        b"%PDF-download",
                        BrowserCaptureKind.DOWNLOAD,
                        "https://publisher.test/article.pdf",
                        "application/pdf",
                    ),
                    (
                        b"%PDF-response",
                        BrowserCaptureKind.RESPONSE,
                        "https://downloads.publisher.test/file",
                        "application/pdf",
                    ),
                    (
                        b"%PDF-viewer",
                        BrowserCaptureKind.VIEWER,
                        "https://downloads.publisher.test/file/viewer",
                        "application/pdf",
                    ),
                    (
                        b"%PDF-official",
                        BrowserCaptureKind.VERIFIED_LOCATOR,
                        "https://downloads.publisher.test/file/object",
                        "application/octet-stream",
                    ),
                )
            ]
        )
        source = _source(runner)
        request = _request(observations=(_observation(501, (_landing_hint(),)),))
        tracker = CandidateKeyTracker()

        deliveries = list(source._deliveries(request, _evidence(request), tracker))

        self.assertEqual(len(deliveries), 4)
        self.assertEqual(
            tuple(_payload(delivery) for delivery in deliveries),
            (
                b"%PDF-download",
                b"%PDF-response",
                b"%PDF-viewer",
                b"%PDF-official",
            ),
        )
        self.assertEqual(len({delivery.candidate.candidate_key for delivery in deliveries}), 4)
        self.assertEqual(len(tracker.tried_candidate_keys), 5)
        capture_guard = runner.calls[0]["capture_guard"]
        self.assertIsInstance(capture_guard, BrowserCaptureGuard)
        assert isinstance(capture_guard, BrowserCaptureGuard)
        self.assertTrue(
            capture_guard.allows(
                "https://downloads.publisher.test/file/object",
                BrowserCaptureKind.VERIFIED_LOCATOR,
                "application/octet-stream",
            )
        )
        self.assertFalse(
            capture_guard.allows(
                "https://downloads.publisher.test/unreviewed.pdf",
                BrowserCaptureKind.RESPONSE,
                "application/pdf",
            )
        )
        self.assertFalse(
            capture_guard.allows(
                "https://downloads.publisher.test/file",
                BrowserCaptureKind.RESPONSE,
                "text/html",
            )
        )
        for delivery in deliveries:
            delivery.content.discard()

    def test_excluded_and_duplicate_actions_do_not_run_browser_twice(self) -> None:
        first_runner = _FakeRunner([_download()])
        first_source = _source(first_runner)
        duplicate_hints = (
            _landing_hint("https://publisher.test/article"),
            _landing_hint("https://PUBLISHER.test:443/article"),
        )
        request = _request(observations=(_observation(51, duplicate_hints),))
        first_tracker = CandidateKeyTracker()
        first = list(first_source._deliveries(request, _evidence(request), first_tracker))
        self.assertEqual(len(first), 1)
        self.assertEqual(len(first_runner.calls), 1)
        tried_keys = first_tracker.tried_candidate_keys
        self.assertEqual(len(tried_keys), 2)
        first[0].content.discard()

        excluded_runner = _FakeRunner([])
        excluded_source = _source(excluded_runner)
        excluded = list(
            excluded_source._deliveries(
                request,
                _evidence(request),
                CandidateKeyTracker(tried_keys),
            )
        )
        self.assertEqual(excluded, [])
        self.assertEqual(excluded_runner.calls, [])

    def test_stronger_landing_hint_prevents_replaying_the_same_rule_via_doi(self) -> None:
        runner = _FakeRunner([_failure("no-download")])
        source = _source(runner)
        request = _request(
            observations=(_observation(511, (_landing_hint(),)),),
            literature=_literature(
                identifiers=(Identifier(namespace="doi", value="10.1234/browser"),),
            ),
            resolved_landing_origin="https://publisher.test",
        )

        self.assertEqual(
            list(source._deliveries(request, _evidence(request), CandidateKeyTracker())),
            [],
        )
        self.assertEqual(len(runner.calls), 1)
        browser_request = runner.calls[0]["request"]
        self.assertIsInstance(browser_request, BrowserRequest)
        assert isinstance(browser_request, BrowserRequest)
        self.assertEqual(browser_request.url, "https://publisher.test/article")

    def test_empty_and_ordered_actions_use_only_the_closed_session_capabilities(self) -> None:
        observe_runner = _FakeRunner([_failure("no-download")])
        observe_rule = _rule(actions=(), max_actions=0)
        observe_source = _source(observe_runner, rule=observe_rule)
        request = _request(observations=(_observation(52, (_landing_hint(),)),))
        self.assertEqual(
            list(
                observe_source._deliveries(
                    request,
                    _evidence(request),
                    CandidateKeyTracker(),
                )
            ),
            [],
        )
        self.assertEqual(observe_runner.sessions[0].clicks, [])

        actions = (
            BrowserRuleAction(
                kind=BrowserActionKind.CLICK,
                selector="a[data-action='pdf']",
            ),
            BrowserRuleAction(
                kind=BrowserActionKind.OPEN_VIEWER,
                locator="https://downloads.publisher.test/file/viewer",
            ),
            BrowserRuleAction(
                kind=BrowserActionKind.OPEN_VERIFIED_LOCATOR,
                locator="https://downloads.publisher.test/file/object",
            ),
            BrowserRuleAction(
                kind=BrowserActionKind.WAIT_FOR_CAPTURE,
                capture_kind=BrowserCaptureKind.VERIFIED_LOCATOR,
            ),
        )
        action_runner = _FakeRunner([_download()])
        action_source = _source(action_runner, rule=_rule(actions=actions, max_actions=4))
        deliveries = list(
            action_source._deliveries(
                request,
                _evidence(request),
                CandidateKeyTracker(),
            )
        )
        session = action_runner.sessions[0]
        self.assertEqual(session.clicks, ["a[data-action='pdf']"])
        self.assertEqual(
            session.viewer_opens,
            ["https://downloads.publisher.test/file/viewer"],
        )
        self.assertEqual(
            session.verified_locator_opens,
            ["https://downloads.publisher.test/file/object"],
        )
        self.assertEqual(session.capture_waits, [BrowserCaptureKind.VERIFIED_LOCATOR])
        self.assertEqual(session.fill_calls, [])
        deliveries[0].content.discard()

    def test_doi_flow_starts_at_canonical_resolver_but_uses_landing_web_scope(self) -> None:
        runner = _FakeRunner([_failure("no-download")])
        source = _source(runner)
        request = _request(
            literature=_literature(
                identifiers=(Identifier(namespace="doi", value="10.1234/alpha(1)"),),
            ),
            resolved_landing_origin="https://publisher.test",
        )

        self.assertEqual(
            list(source._deliveries(request, _evidence(request), CandidateKeyTracker())),
            [],
        )

        call = runner.calls[0]
        self.assertEqual(call["scope"], AccessScope("publisher.test", "web"))
        browser_request = call["request"]
        self.assertIsInstance(browser_request, BrowserRequest)
        assert isinstance(browser_request, BrowserRequest)
        self.assertEqual(browser_request.url, "https://doi.org/10.1234/alpha%281%29")

        guard = call["destination_guard"]
        self.assertIsInstance(guard, BrowserDestinationGuard)
        assert isinstance(guard, BrowserDestinationGuard)
        guard.check(browser_request.url, BrowserDestinationKind.INITIAL_NAVIGATION)
        guard.check(browser_request.url, BrowserDestinationKind.NAVIGATION)
        guard.check(
            "https://publisher.test/article",
            BrowserDestinationKind.NAVIGATION,
        )
        guard.check(
            "https://downloads.publisher.test/article.pdf",
            BrowserDestinationKind.DOWNLOAD,
        )
        with self.assertRaises(ValueError):
            guard.check(browser_request.url, BrowserDestinationKind.REQUEST)
        with self.assertRaises(ValueError):
            guard.check(
                "https://public-but-forbidden.test/article.pdf",
                BrowserDestinationKind.DOWNLOAD,
            )

    def test_no_download_is_normal_but_every_other_browser_failure_is_system_failure(
        self,
    ) -> None:
        request = _request(observations=(_observation(53, (_landing_hint(),)),))

        no_download = _source(_FakeRunner([_failure("no-download")]))
        self.assertEqual(
            list(
                no_download._deliveries(
                    request,
                    _evidence(request),
                    CandidateKeyTracker(),
                )
            ),
            [],
        )

        for code in (
            "policy",
            "admission",
            "cancelled",
            "timeout",
            "budget",
            "oversize",
            "challenge",
            "cleanup",
            "runtime",
        ):
            with self.subTest(code=code):
                source = _source(_FakeRunner([_failure(code)]))
                with self.assertRaises(AcquisitionFailure) as caught:
                    list(
                        source._deliveries(
                            request,
                            _evidence(request),
                            CandidateKeyTracker(),
                        )
                    )
                self.assertEqual(
                    caught.exception.failure.code,
                    (
                        "acquisition-browser-challenge-required"
                        if code == "challenge"
                        else f"acquisition-browser-{code}-failed"
                    ),
                )

    def test_runtime_result_states_have_stable_route_escalation(self) -> None:
        request = _request(observations=(_observation(531, (_landing_hint(),)),))
        for code in ("not-found", "not-entitled"):
            with self.subTest(code=code):
                source = _source(_FakeRunner([_failure(code)]))
                self.assertEqual(
                    list(
                        source._deliveries(
                            request,
                            _evidence(request),
                            CandidateKeyTracker(),
                        )
                    ),
                    [],
                )

        for code, expected_code in (
            ("rate-limit", "acquisition-browser-rate-limited"),
            ("rate-limited", "acquisition-browser-rate-limited"),
            ("ip-blocked", "acquisition-browser-ip-blocked"),
        ):
            with self.subTest(code=code):
                source = _source(_FakeRunner([_failure(code)]))
                with self.assertRaises(AcquisitionFailure) as caught:
                    list(
                        source._deliveries(
                            request,
                            _evidence(request),
                            CandidateKeyTracker(),
                        )
                    )
                self.assertEqual(caught.exception.failure.code, expected_code)

    def test_login_and_mfa_markers_are_explicit_failures_without_fill_or_click(self) -> None:
        states = _page_states()
        request = _request(observations=(_observation(54, (_landing_hint(),)),))
        for state_name, expected_code in (
            ("login", "acquisition-browser-login-required"),
            ("mfa", "acquisition-browser-mfa-required"),
            ("login-and-mfa", "acquisition-browser-page-state-conflict"),
        ):
            with self.subTest(state=state_name):
                runner = _FakeRunner(
                    [_download()],
                    marker_states=(states[state_name],),
                )
                source = _source(runner)
                with self.assertRaises(AcquisitionFailure) as caught:
                    list(
                        source._deliveries(
                            request,
                            _evidence(request),
                            CandidateKeyTracker(),
                        )
                    )
                self.assertEqual(caught.exception.failure.code, expected_code)
                self.assertEqual(runner.sessions[0].clicks, [])
                self.assertEqual(runner.sessions[0].fill_calls, [])
                self.assertEqual(runner.completed, 1)

    def test_page_marker_matrix_separates_authentication_and_article_entitlement(self) -> None:
        states = _access_page_states()
        request = _request(observations=(_observation(541, (_landing_hint(),)),))
        rule = _rule(page_markers=_access_page_markers())

        for state_name in (
            "ordinary",
            "authenticated",
            "entitled",
            "authenticated-and-entitled",
        ):
            with self.subTest(state=state_name):
                markers, observation = states[state_name]
                runner = _FakeRunner(
                    [_download()],
                    marker_states=(markers,),
                    page_observations=(observation,),
                )
                source = _source(runner, rule=rule)
                deliveries = list(
                    source._deliveries(
                        request,
                        _evidence(request),
                        CandidateKeyTracker(),
                    )
                )
                self.assertEqual(len(deliveries), 1)
                self.assertEqual(runner.sessions[0].clicks, ["a[data-action='pdf']"])
                self.assertEqual(runner.sessions[0].fill_calls, [])

        for state_name in (
            "not-entitled",
            "paywall",
            "not-found",
            "authenticated-but-not-entitled",
        ):
            with self.subTest(state=state_name):
                markers, observation = states[state_name]
                runner = _FakeRunner(
                    [_download()],
                    marker_states=(markers,),
                    page_observations=(observation,),
                )
                source = _source(runner, rule=rule)
                self.assertEqual(
                    list(
                        source._deliveries(
                            request,
                            _evidence(request),
                            CandidateKeyTracker(),
                        )
                    ),
                    [],
                )
                self.assertEqual(runner.sessions[0].clicks, [])

    def test_page_marker_terminal_states_have_one_safe_escalation(self) -> None:
        states = _access_page_states()
        request = _request(observations=(_observation(542, (_landing_hint(),)),))
        rule = _rule(page_markers=_access_page_markers())
        expected = {
            "login-required": "acquisition-browser-login-required",
            "mfa-required": "acquisition-browser-mfa-required",
            "challenge-required": "acquisition-browser-challenge-required",
            "rate-limited": "acquisition-browser-rate-limited",
            "ip-blocked": "acquisition-browser-ip-blocked",
        }

        for state_name, expected_code in expected.items():
            with self.subTest(state=state_name):
                markers, observation = states[state_name]
                runner = _FakeRunner(
                    [_download()],
                    marker_states=(markers,),
                    page_observations=(observation,),
                )
                source = _source(runner, rule=rule)
                with self.assertRaises(AcquisitionFailure) as caught:
                    list(
                        source._deliveries(
                            request,
                            _evidence(request),
                            CandidateKeyTracker(),
                        )
                    )
                self.assertEqual(caught.exception.failure.code, expected_code)
                self.assertEqual(runner.sessions[0].clicks, [])
                self.assertEqual(runner.sessions[0].fill_calls, [])

    def test_conflicting_page_markers_fail_closed_with_safe_diagnosis(self) -> None:
        states = _access_page_states()
        request = _request(observations=(_observation(543, (_landing_hint(),)),))
        rule = _rule(page_markers=_access_page_markers())
        for state_name in (
            "login-and-mfa-conflict",
            "authentication-conflict",
            "entitlement-conflict",
        ):
            with self.subTest(state=state_name):
                markers, observation = states[state_name]
                runner = _FakeRunner(
                    [_download()],
                    marker_states=(markers,),
                    page_observations=(observation,),
                )
                source = _source(runner, rule=rule)
                with self.assertRaises(AcquisitionFailure) as caught:
                    list(
                        source._deliveries(
                            request,
                            _evidence(request),
                            CandidateKeyTracker(),
                        )
                    )
                failure = caught.exception.failure
                self.assertEqual(failure.code, "acquisition-browser-page-state-conflict")
                self.assertNotIn("publisher.test", repr(failure))
                self.assertNotIn("#", repr(failure))
                self.assertEqual(runner.sessions[0].clicks, [])
                self.assertEqual(runner.sessions[0].fill_calls, [])

    def test_budget_cancel_and_policy_are_always_conservative(self) -> None:
        cancelled = threading.Event()
        operator_policy = AccessPolicy(
            max_concurrency=9,
            min_start_interval=5.0,
            cooldown_after_completion=1.0,
        )
        runner = _FakeRunner([_failure("no-download")])
        source = _source(
            runner,
            policy=operator_policy,
            cancel_event=cancelled,
        )
        request = _request(observations=(_observation(55, (_landing_hint(),)),))

        self.assertEqual(
            list(source._deliveries(request, _evidence(request), CandidateKeyTracker())),
            [],
        )

        call = runner.calls[0]
        budget = call["budget"]
        self.assertEqual(budget, source.browser_budget)
        assert isinstance(budget, BrowserBudget)
        self.assertEqual(budget.max_downloads, 4)
        self.assertEqual(budget.max_popups, 2)
        self.assertEqual(budget.max_captures, 4)
        self.assertLessEqual(budget.max_requests, 64)
        self.assertEqual(call["cancel_event"], cancelled)
        policy = call["policy"]
        assert isinstance(policy, AccessPolicy)
        self.assertEqual(policy.max_concurrency, 1)
        self.assertEqual(policy.min_start_interval, 5.0)
        self.assertEqual(policy.cooldown_after_completion, 1.0)

    def test_final_download_origin_remains_a_defence_in_depth_check(self) -> None:
        request = _request(observations=(_observation(56, (_landing_hint(),)),))
        allowed_runner = _FakeRunner(
            [
                _download(
                    final_locator="https://downloads.publisher.test/article.pdf",
                )
            ]
        )
        allowed_source = _source(allowed_runner)
        allowed = list(
            allowed_source._deliveries(
                request,
                _evidence(request),
                CandidateKeyTracker(),
            )
        )
        self.assertEqual(len(allowed), 1)
        allowed[0].content.discard()

        forbidden_runner = _FakeRunner(
            [_download(final_locator="https://public-but-forbidden.test/article.pdf")]
        )
        forbidden_source = _source(forbidden_runner)
        with self.assertRaises(AcquisitionFailure) as caught:
            list(
                forbidden_source._deliveries(
                    request,
                    _evidence(request),
                    CandidateKeyTracker(),
                )
            )
        self.assertEqual(caught.exception.failure.code, "acquisition-browser-policy-failed")
        # The fake does not execute Network's per-hop guard.  The Source still
        # refuses publication if a nonconforming runner returns an invalid locator.
        self.assertEqual(len(forbidden_runner.calls), 1)
        self.assertEqual(forbidden_runner.completed, 1)

    def test_runtime_exception_and_unexpected_result_are_stable_contract_failures(self) -> None:
        request = _request(observations=(_observation(57, (_landing_hint(),)),))
        exception_source = _source(_FakeRunner([RuntimeError("private sentinel")]))
        with self.assertRaises(AcquisitionFailure) as exception_caught:
            list(
                exception_source._deliveries(
                    request,
                    _evidence(request),
                    CandidateKeyTracker(),
                )
            )
        self.assertEqual(
            exception_caught.exception.failure.code,
            "acquisition-browser-runtime-failed",
        )
        self.assertNotIn("sentinel", repr(exception_caught.exception.failure))

        contract_source = _source(_FakeRunner([object()]))
        with self.assertRaises(AcquisitionFailure) as contract_caught:
            list(
                contract_source._deliveries(
                    request,
                    _evidence(request),
                    CandidateKeyTracker(),
                )
            )
        self.assertEqual(contract_caught.exception.failure.code, "acquisition-browser-contract")

    def test_generator_close_and_explicit_discard_release_temporary_bytes(self) -> None:
        runner = _FakeRunner([_download(b"temporary")])
        source = _source(runner)
        request = _request(observations=(_observation(58, (_landing_hint(),)),))
        iterator = iter(source._deliveries(request, _evidence(request), CandidateKeyTracker()))
        delivery = next(iterator)
        self.assertEqual(_payload(delivery), b"temporary")

        close = getattr(iterator, "close", None)
        self.assertTrue(callable(close))
        assert callable(close)
        close()
        with self.assertRaises(RuntimeError):
            delivery.content.open()
        delivery.content.discard()
        delivery.content.discard()


if __name__ == "__main__":
    unittest.main()
