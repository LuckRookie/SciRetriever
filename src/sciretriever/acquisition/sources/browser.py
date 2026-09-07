"""Generic Agent-controlled Browser PDF acquisition.

Acquisition supplies one bounded article goal and one safe starting locator.
Network owns the Browser lifecycle, stable observations, exact action binding,
settlement, capture correlation and cleanup. The Browser Agent sees only a
stable observation and chooses one of the six closed actions; it never receives
a selector, arbitrary URL, Browser object, credential or publication handle.

This source contains no Publisher click program. A Publisher profile may still
own admission or rate-limit facts outside this module, but the absence of a
site-specific selector or PDF path never prevents a safe article landing from
reaching the Agent.
"""

from __future__ import annotations

import hashlib
import re
import threading
import time
from collections.abc import Callable, Generator, Iterable, Iterator
from contextlib import AbstractContextManager, closing
from dataclasses import dataclass, field
from datetime import datetime, timezone
from io import BytesIO
from typing import BinaryIO, Final, Protocol, runtime_checkable
from urllib.parse import quote
from uuid import uuid4

from sciretriever.acquisition.browser_control import (
    AgentBrowserController,
    BrowserAgentResult,
    BrowserArticleGoal,
    BrowserStepSessionFactory,
)
from sciretriever.acquisition.outcomes import RouteExecutionResult
from sciretriever.acquisition.planning import (
    AccessRouteHint,
    AccessRouteHintKind,
    RouteReadiness,
)
from sciretriever.acquisition.ports import (
    AcquisitionFailure,
    AcquisitionSourceFailure,
    BrowserPdfAssociationEvidence,
    CandidateKeyTracker,
    TemporaryPdf,
)
from sciretriever.acquisition.routes import (
    RouteExecutionContext,
    RouteInstallationStatus,
    delivery_results,
)
from sciretriever.acquisition.routing import (
    AcquisitionEvidence,
    AcquisitionRequest,
    build_acquisition_evidence,
)
from sciretriever.acquisition.sources.direct import WebAccessProfileResolver
from sciretriever.agents.api import AgentRole, AgentRuntime
from sciretriever.logging.api import get_logger
from sciretriever.model.access import (
    AccessFailure,
    BrowserCapture,
    BrowserCaptureBatch,
    BrowserCaptureKind,
    BrowserRequest,
    BrowserResult,
)
from sciretriever.model.acquisition import (
    AcquisitionPath,
    AssetHintKind,
    AssetRole,
    PdfCandidate,
)
from sciretriever.model.literature import Identifier
from sciretriever.model.primitives import ProvenanceId, Sha256, SourceKind, UtcTimestamp
from sciretriever.model.provenance import Provenance
from sciretriever.model.report import StableFailure
from sciretriever.network.admission import AccessPolicy, AccessScope
from sciretriever.network.browser import (
    BrowserCaptureDecision,
    BrowserCaptureEvidence,
    BrowserCapturePolicy,
    BrowserDestinationGuard,
    BrowserDestinationKind,
    BrowserFlowController,
    BrowserFlowSession,
    BrowserOperationLimits,
    BrowserRequestObservation,
)
from sciretriever.network.browser_control import (
    BrowserBlocked,
    BrowserBlockedReason,
    BrowserCancelled,
    BrowserCaptured,
    BrowserFailed,
    BrowserObservation,
    BrowserPageState,
    BrowserStepAssessment,
    BrowserStepSession,
    Stop,
)
from sciretriever.network.policy import (
    NormalizedURL,
    PolicyError,
    normalize_url_with_configured_port,
)

_SOURCE_NAME: Final[str] = "controlled-browser"
_ROUTE_KEY: Final[re.Pattern[str]] = re.compile(
    r"^browser:[a-z0-9][a-z0-9-]{0,119}$",
    re.ASCII,
)
_DOI_RESOLVER_ORIGIN: Final[str] = "https://doi.org"
_TIMEOUT_SECONDS: Final[float] = 60.0
_MAX_DOWNLOAD_BYTES: Final[int] = 64 * 1024 * 1024
_BASELINE_WEB_POLICY: Final[AccessPolicy] = AccessPolicy(
    max_concurrency=1,
    min_start_interval=1.0,
)
_BROWSER_OPERATION_LIMITS: Final[BrowserOperationLimits] = BrowserOperationLimits(
    max_capture_bytes=_MAX_DOWNLOAD_BYTES,
    action_timeout_seconds=10.0,
    capture_wait_timeout_seconds=10.0,
)
_CAPTURE_PRIORITY: Final[tuple[BrowserCaptureKind, ...]] = (
    BrowserCaptureKind.DOWNLOAD,
    BrowserCaptureKind.RESPONSE,
    BrowserCaptureKind.POPUP,
)
_PDF_MEDIA_TYPES: Final[frozenset[str]] = frozenset({"application/pdf", "application/octet-stream"})
_CHALLENGE_MARKERS: Final[tuple[str, ...]] = (
    "checking your browser",
    "just a moment",
    "performing security verification",
    "security check",
    "verify you are human",
    "verifying you are human",
)
_LOGGER = get_logger(__name__)

ProvenanceIdFactory = Callable[[], ProvenanceId]
Clock = Callable[[], UtcTimestamp]


def _new_provenance_id() -> ProvenanceId:
    return ProvenanceId(str(uuid4()))


def _utc_now() -> UtcTimestamp:
    value = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    return UtcTimestamp(value)


def _elapsed_ms(started_ns: int) -> int:
    return max(0, (time.monotonic_ns() - started_ns) // 1_000_000)


def _failure(
    *,
    code: str,
    reason: str,
    action: str,
    retryable: bool,
) -> StableFailure:
    return StableFailure(
        code=code,
        reason=reason,
        action=action,
        retryable=retryable,
    )


def _contract_failure() -> StableFailure:
    return _failure(
        code="acquisition-browser-contract",
        reason="A generic Browser component violated its neutral contract.",
        action="Correct the Browser Source assembly.",
        retryable=False,
    )


def _runtime_failure() -> StableFailure:
    return _failure(
        code="acquisition-browser-runtime-failed",
        reason="The Browser runtime failed before the article flow completed.",
        action="Check the Browser runtime and retry the article.",
        retryable=True,
    )


def _cancelled_failure() -> StableFailure:
    return _failure(
        code="acquisition-browser-cancelled",
        reason="The Browser article flow was cancelled.",
        action="Retry the acquisition operation when ready.",
        retryable=True,
    )


def _candidate_timeout_failure() -> StableFailure:
    return _failure(
        code="acquisition-browser-candidate-timeout",
        reason="A possible PDF capture did not complete before Browser settlement.",
        action="Retry after checking the Publisher response and Browser runtime.",
        retryable=True,
    )


def _no_progress_failure(reason: BrowserBlockedReason) -> StableFailure:
    code = (
        "acquisition-browser-repeated-action"
        if reason is BrowserBlockedReason.REPEATED_SELF_TRANSITION
        else "acquisition-browser-action-cycle"
    )
    return _failure(
        code=code,
        reason="The Browser Agent repeated a page transition that made no progress.",
        action="Review the model decision or retry after the page changes.",
        retryable=False,
    )


def _page_failure(state: BrowserPageState) -> StableFailure:
    values: dict[BrowserPageState, tuple[str, str, str, bool]] = {
        BrowserPageState.LOGIN_REQUIRED: (
            "acquisition-browser-login-required",
            "The Browser page requires an explicit login.",
            "Use an authorized API or provide the PDF manually.",
            False,
        ),
        BrowserPageState.MFA_REQUIRED: (
            "acquisition-browser-mfa-required",
            "The Browser page requires explicit MFA.",
            "Complete access outside automation or use another approved source.",
            False,
        ),
        BrowserPageState.ACCESS_DENIED: (
            "acquisition-browser-access-denied",
            "The Publisher denied this Browser request.",
            "Check article access outside automation or use another approved source.",
            False,
        ),
        BrowserPageState.NOT_ENTITLED: (
            "acquisition-browser-not-entitled",
            "The Publisher page does not grant access to the primary PDF.",
            "Use an entitled profile, an authorized API, or another approved source.",
            False,
        ),
        BrowserPageState.NOT_FOUND: (
            "acquisition-browser-not-found",
            "The Publisher page reports that the requested article is not available.",
            "Check the article metadata or use another approved source.",
            False,
        ),
        BrowserPageState.FAILED: (
            "acquisition-browser-page-failed",
            "The Browser page reached a failed state.",
            "Review the Browser diagnostics before retrying.",
            True,
        ),
    }
    try:
        code, reason, action, retryable = values[state]
    except KeyError:
        raise AcquisitionFailure(_contract_failure()) from None
    return _failure(code=code, reason=reason, action=action, retryable=retryable)


def _stop_failure(reason: str) -> StableFailure | None:
    states = {
        "login-required": BrowserPageState.LOGIN_REQUIRED,
        "mfa-required": BrowserPageState.MFA_REQUIRED,
        "not-entitled": BrowserPageState.NOT_ENTITLED,
        "access-denied": BrowserPageState.ACCESS_DENIED,
        "not-found": BrowserPageState.NOT_FOUND,
    }
    state = states.get(reason)
    if state is not None:
        return _page_failure(state)
    if reason == "challenge-unresolved":
        return _failure(
            code="acquisition-browser-challenge-unresolved",
            reason="The Browser Agent could not complete the visible access challenge.",
            action="Retry the Browser route or use another approved source.",
            retryable=True,
        )
    return None


def _agent_access_failure(value: AccessFailure) -> StableFailure:
    if not isinstance(value, AccessFailure):
        raise AcquisitionFailure(_contract_failure())
    return _failure(
        code=value.code,
        reason=value.reason,
        action=value.action,
        retryable=value.retryable,
    )


CONTROLLED_BROWSER_PRODUCTION_STATUS: Final[RouteInstallationStatus] = RouteInstallationStatus(
    readiness=RouteReadiness.READY
)


@runtime_checkable
class BrowserRunner(Protocol):
    """Structural subset of :meth:`network.browser.BrowserClient.run`."""

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
    ) -> BrowserResult: ...


@dataclass(frozen=True, slots=True, repr=False)
class GenericBrowserDestinationGuard:
    """Admit safe HTTPS destinations reached inside this article flow.

    The Agent cannot provide a URL; it may only act on an observed element or
    screenshot point. Navigation targets therefore originate from the open
    page, while Network still performs normal URL, DNS, address and host checks
    for every request and redirect.
    """

    exact_start_url: str = field(repr=False)
    article_origins: tuple[str, ...] = field(default=(), repr=False)

    def __post_init__(self) -> None:
        normalized = _safe_https_url(self.exact_start_url)
        object.__setattr__(self, "exact_start_url", normalized.url)
        if not isinstance(self.article_origins, tuple):
            raise TypeError("article_origins must be a tuple")
        origins: list[str] = [normalized.origin.text]
        for value in self.article_origins:
            origin = _safe_https_url(value)
            if origin.path != "/" or origin.query:
                raise ValueError("article_origins must contain only HTTPS origins")
            if origin.origin.text not in origins:
                origins.append(origin.origin.text)
        if len(origins) > 32:
            raise ValueError("article_origins exceeds the Browser origin limit")
        object.__setattr__(self, "article_origins", tuple(origins))

    def check(self, url: str, kind: BrowserDestinationKind) -> None:
        if not isinstance(kind, BrowserDestinationKind):
            raise TypeError("kind must be BrowserDestinationKind")
        _safe_https_url(url)

    def connection_origins(self) -> tuple[str, ...]:
        """Prebind article origins already established before Browser launch."""

        return self.article_origins

    def __reduce__(self) -> str | tuple[object, ...]:
        raise TypeError("GenericBrowserDestinationGuard cannot be serialized")


def build_generic_browser_destination_guard(
    exact_start_url: str,
    *,
    article_origins: tuple[str, ...] = (),
) -> GenericBrowserDestinationGuard:
    return GenericBrowserDestinationGuard(
        exact_start_url=exact_start_url,
        article_origins=article_origins,
    )


@dataclass(frozen=True, slots=True, repr=False)
class _BrowserAction:
    start_url: str
    scope_origin: str
    evidence_kind: str
    identity: str = field(repr=False)
    article_goal: BrowserArticleGoal = field(repr=False)

    def __reduce__(self) -> str | tuple[object, ...]:
        raise TypeError("_BrowserAction cannot be serialized")


@dataclass(frozen=True, slots=True)
class _GenericStepPolicy:
    """Preserve Network's current page state without Publisher selectors."""

    def assess(self, observation: BrowserObservation) -> BrowserStepAssessment:
        if not isinstance(observation, BrowserObservation):
            raise TypeError("Browser step supplied an invalid observation")
        page_state = observation.page_state
        if page_state is BrowserPageState.NORMAL:
            visible_labels = " ".join(
                (
                    *(surface.title for surface in observation.surfaces),
                    *(element.name for element in observation.elements),
                )
            ).casefold()
            if any(marker in visible_labels for marker in _CHALLENGE_MARKERS):
                page_state = BrowserPageState.CHALLENGE
        return BrowserStepAssessment(
            page_state=page_state,
            matches_observation=True,
        )


@dataclass(frozen=True, slots=True)
class _GenericStepSessionFactory:
    def open(
        self,
        session: BrowserFlowSession,
        *,
        timeout_seconds: float,
    ) -> BrowserStepSession:
        if not isinstance(session, BrowserFlowSession):
            raise TypeError("Browser flow session violated its structural contract")
        return session.browser_steps(
            policy=_GenericStepPolicy(),
            timeout_seconds=timeout_seconds,
        )


class _GenericCapturePolicy:
    """Gate body access by media type; byte and identity checks follow later.

    Browser document navigations are prefetched through Network's neutral
    ``fetch/fulfill`` bridge.  Some headed Chromium/CloakBrowser combinations
    expose an inline or embedded PDF navigation as a response but do not emit
    a readable native ``Download`` object.  Keeping the fetched response as
    the private body source makes that variation transparent to Agent control
    while still letting the final Acquisition identity gate decide whether
    the bytes are usable.  Normal browser navigations use GET or POST, and
    ``Route.fetch`` performs that already initiated request once before
    fulfilling it back to Chromium.  Non-navigation subresources continue
    through the normal route path.
    """

    __slots__ = ("_accepted", "action")

    def __init__(self, action: _BrowserAction) -> None:
        if not isinstance(action, _BrowserAction):
            raise TypeError("action must be _BrowserAction")
        self.action = action
        self._accepted: dict[tuple[BrowserCaptureKind, str, str], BrowserCaptureEvidence] = {}

    @staticmethod
    def _capture_key(
        kind: BrowserCaptureKind,
        locator: str,
        media_type: str,
    ) -> tuple[BrowserCaptureKind, str, str]:
        return kind, _safe_source_url(locator), _media_type(media_type)

    def decide(self, evidence: BrowserCaptureEvidence) -> BrowserCaptureDecision:
        if not isinstance(evidence, BrowserCaptureEvidence):
            raise TypeError("evidence must be BrowserCaptureEvidence")
        media_type = _media_type(evidence.media_type)
        try:
            _safe_https_url(evidence.locator)
        except (TypeError, ValueError):
            decision = BrowserCaptureDecision.REJECT
        else:
            decision = (
                BrowserCaptureDecision.ACCEPT
                if media_type in _PDF_MEDIA_TYPES
                else BrowserCaptureDecision.REJECT
            )
        if decision is BrowserCaptureDecision.ACCEPT:
            self._accepted[
                self._capture_key(evidence.kind, evidence.locator, evidence.media_type)
            ] = evidence
        _LOGGER.debug(
            "event=browser-capture-policy-decision strategy=generic decision=%s "
            "capture_kind=%s media_type=%s correlation=%s",
            decision.value,
            evidence.kind.value,
            media_type or "unknown",
            evidence.correlation.value,
        )
        return decision

    @staticmethod
    def prefetch(observation: BrowserRequestObservation) -> bool:
        """Retain a body-readable source for one browser document navigation."""

        if not isinstance(observation, BrowserRequestObservation):
            raise TypeError("observation must be BrowserRequestObservation")
        return observation.is_navigation and observation.method in {"GET", "POST"}

    def association_evidence(
        self,
        capture: BrowserCapture,
    ) -> BrowserPdfAssociationEvidence | None:
        if not isinstance(capture, BrowserCapture):
            raise TypeError("capture must be BrowserCapture")
        try:
            key = self._capture_key(
                capture.kind,
                capture.stream.final_locator,
                capture.stream.media_type,
            )
        except (TypeError, ValueError):
            return None
        evidence = self._accepted.get(key)
        if evidence is None:
            return None
        return BrowserPdfAssociationEvidence(
            start_locator=_safe_source_url(self.action.start_url),
            start_kind=self.action.evidence_kind,
            capture_locator=_safe_source_url(evidence.locator),
            capture_kind=evidence.kind.value,
            correlation=evidence.correlation.value,
            request_navigation=evidence.request_navigation,
            from_exact_start=evidence.from_exact_start,
            redirect_depth=evidence.redirect_depth,
            native_download=evidence.native_download,
        )

    def __reduce__(self) -> str | tuple[object, ...]:
        raise TypeError("_GenericCapturePolicy cannot be serialized")


class _BrowserTemporaryPdfContent:
    """In-memory neutral delivery with deterministic idempotent cleanup."""

    __slots__ = ("_chunks", "_lock")

    def __init__(self, chunks: tuple[bytes, ...]) -> None:
        if not isinstance(chunks, tuple) or any(not isinstance(chunk, bytes) for chunk in chunks):
            raise TypeError("chunks must contain bytes")
        self._chunks: tuple[bytes, ...] | None = chunks
        self._lock = threading.Lock()

    def open(self) -> AbstractContextManager[BinaryIO]:
        with self._lock:
            chunks = self._chunks
        if chunks is None:
            raise RuntimeError("temporary Browser content is closed")
        return closing(BytesIO(b"".join(chunks)))

    def discard(self) -> None:
        with self._lock:
            self._chunks = None


def _safe_https_url(value: object) -> NormalizedURL:
    if not isinstance(value, str):
        raise TypeError("Browser URL must be text")
    try:
        normalized = normalize_url_with_configured_port(value)
    except (PolicyError, TypeError, ValueError):
        raise ValueError("Browser URL is unsafe") from None
    if normalized.scheme != "https":
        raise ValueError("Browser URL must use HTTPS")
    return normalized


def _safe_source_url(value: str) -> str:
    normalized = _safe_https_url(value)
    return f"{normalized.origin.text}{normalized.path}"


def _media_type(value: str) -> str:
    if not isinstance(value, str):
        return ""
    return value.split(";", 1)[0].strip().casefold()


def _canonical_doi(evidence: AcquisitionEvidence) -> Identifier | None:
    values = tuple(
        identifier for identifier in evidence.identifiers if identifier.namespace == "doi"
    )
    return values[0] if len(values) == 1 else None


def _doi_resolver_url(doi: Identifier) -> str:
    return _safe_https_url(f"{_DOI_RESOLVER_ORIGIN}/{quote(doi.value, safe='/')}").url


def _bounded_text(value: str | None, maximum: int) -> str | None:
    if value is None:
        return None
    encoded = value.strip().encode("utf-8", "strict")
    if not encoded:
        return None
    if len(encoded) <= maximum:
        return value.strip()
    return encoded[:maximum].decode("utf-8", "ignore").strip() or None


def _article_goal(evidence: AcquisitionEvidence) -> BrowserArticleGoal:
    doi = _canonical_doi(evidence)
    landing_origins: list[str] = []
    asset_origins: list[str] = []
    for observed in evidence.asset_hints:
        try:
            origin = _safe_https_url(observed.hint.url).origin.text
        except (TypeError, ValueError):
            continue
        target = (
            landing_origins if observed.hint.kind is AssetHintKind.LANDING_PAGE else asset_origins
        )
        if origin not in target:
            target.append(origin)
    if evidence.resolved_landing_origin is not None:
        try:
            origin = _safe_https_url(evidence.resolved_landing_origin).origin.text
        except (TypeError, ValueError):
            pass
        else:
            if origin not in landing_origins:
                landing_origins.append(origin)
    return BrowserArticleGoal(
        doi=None if doi is None else doi.value,
        title=_bounded_text(evidence.metadata.title, 512),
        authors=tuple(
            value
            for author in evidence.metadata.authors[:16]
            if (value := _bounded_text(author.display_name, 256)) is not None
        ),
        landing_origins=tuple(landing_origins[:16]),
        asset_origins=tuple(asset_origins[:16]),
    )


def _eligible_hint(role: AssetRole | None) -> bool:
    return role is None or role is AssetRole.PRIMARY_PDF


def _candidate_key(action: _BrowserAction) -> str:
    identity = "\x00".join(
        (
            _SOURCE_NAME,
            AcquisitionPath.CONTROLLED_BROWSER.value,
            action.evidence_kind,
            action.identity,
        )
    )
    return f"controlled-browser:{hashlib.sha256(identity.encode()).hexdigest()}"


def _capture_candidate_key(action: _BrowserAction, capture: BrowserCapture) -> str:
    digest = hashlib.sha256(b"".join(capture.stream.chunks)).hexdigest()
    identity = "\x00".join(
        (
            _candidate_key(action),
            capture.kind.value,
            capture.stream.final_locator,
            digest,
        )
    )
    return f"controlled-browser:{hashlib.sha256(identity.encode()).hexdigest()}"


def _terminal_failure(result: BrowserAgentResult) -> StableFailure | None:
    step = result.step
    if isinstance(step, BrowserCancelled):
        return _cancelled_failure()
    if isinstance(step, BrowserFailed):
        return _agent_access_failure(step.failure)
    if isinstance(step, BrowserCaptured):
        return None
    if not isinstance(step, BrowserBlocked):
        return _contract_failure()
    reason = step.reason
    if reason is BrowserBlockedReason.STOPPED:
        action = result.last_action
        if not isinstance(action, Stop) or action.reason is None:
            return _contract_failure()
        return _stop_failure(action.reason)
    if reason is BrowserBlockedReason.CANDIDATE_TIMEOUT:
        return _candidate_timeout_failure()
    if reason in {
        BrowserBlockedReason.REPEATED_SELF_TRANSITION,
        BrowserBlockedReason.REPEATED_CYCLE_EDGE,
    }:
        return _no_progress_failure(reason)
    if reason in {
        BrowserBlockedReason.LOGIN_REQUIRED,
        BrowserBlockedReason.MFA_REQUIRED,
        BrowserBlockedReason.ACCESS_DENIED,
        BrowserBlockedReason.PAGE_FAILED,
    }:
        return _page_failure(step.observation.page_state)
    return None


class ControlledBrowserPdfSource:
    """Final-tier PDF Source controlled exclusively by one Browser Agent."""

    __slots__ = (
        "_agent_runtime",
        "_cancel_event",
        "_clock",
        "_operator_policy",
        "_provenance_id_factory",
        "_route_key",
        "_runner",
        "_web_access_profile_resolver",
    )

    def __init__(
        self,
        *,
        runner: BrowserRunner,
        agent_runtime: AgentRuntime,
        route_key: str = "browser:generic",
        web_access_profile_resolver: WebAccessProfileResolver | None = None,
        access_policy: AccessPolicy | None = None,
        cancel_event: threading.Event | None = None,
        provenance_id_factory: ProvenanceIdFactory = _new_provenance_id,
        clock: Clock = _utc_now,
    ) -> None:
        if not isinstance(runner, BrowserRunner):
            raise TypeError("runner must implement BrowserRunner")
        if not isinstance(agent_runtime, AgentRuntime):
            raise TypeError("agent_runtime must be AgentRuntime")
        if not agent_runtime.readiness(AgentRole.BROWSER).ready:
            raise ValueError("Browser Agent runtime must be ready")
        if type(route_key) is not str or _ROUTE_KEY.fullmatch(route_key) is None:
            raise ValueError("route_key must be a stable Browser route key")
        if web_access_profile_resolver is not None and not isinstance(
            web_access_profile_resolver,
            WebAccessProfileResolver,
        ):
            raise TypeError("web_access_profile_resolver is invalid")
        if access_policy is not None and not isinstance(access_policy, AccessPolicy):
            raise TypeError("access_policy must be AccessPolicy or None")
        if cancel_event is not None and not isinstance(cancel_event, threading.Event):
            raise TypeError("cancel_event must be threading.Event or None")
        if not callable(provenance_id_factory) or not callable(clock):
            raise TypeError("Browser factories must be callable")
        self._runner = runner
        self._agent_runtime = agent_runtime
        self._route_key = route_key
        self._web_access_profile_resolver = (
            web_access_profile_resolver or WebAccessProfileResolver()
        )
        self._operator_policy = access_policy or _BASELINE_WEB_POLICY
        self._cancel_event = cancel_event
        self._provenance_id_factory = provenance_id_factory
        self._clock = clock

    @property
    def source_name(self) -> str:
        return _SOURCE_NAME

    @property
    def acquisition_path(self) -> AcquisitionPath:
        return AcquisitionPath.CONTROLLED_BROWSER

    @property
    def route_key(self) -> str:
        return self._route_key

    @property
    def browser_operation_limits(self) -> BrowserOperationLimits:
        return _BROWSER_OPERATION_LIMITS

    def execute(self, context: RouteExecutionContext) -> Iterable[RouteExecutionResult]:
        if not isinstance(context, RouteExecutionContext):
            raise TypeError("context must be RouteExecutionContext")
        return delivery_results(
            self._deliveries(
                context.request,
                context.evidence,
                context.route_hints,
                context.candidate_keys,
            )
        )

    def _deliveries(
        self,
        request: AcquisitionRequest,
        evidence: AcquisitionEvidence,
        route_hints: tuple[AccessRouteHint, ...],
        candidate_keys: CandidateKeyTracker,
    ) -> Iterable[TemporaryPdf]:
        if not isinstance(request, AcquisitionRequest):
            raise TypeError("request must be AcquisitionRequest")
        if not isinstance(evidence, AcquisitionEvidence):
            raise TypeError("evidence must be AcquisitionEvidence")
        if not isinstance(route_hints, tuple) or any(
            not isinstance(hint, AccessRouteHint) for hint in route_hints
        ):
            raise TypeError("route_hints must contain AccessRouteHint values")
        if not isinstance(candidate_keys, CandidateKeyTracker):
            raise TypeError("candidate_keys must be CandidateKeyTracker")
        try:
            expected = build_acquisition_evidence(request)
        except Exception:
            raise AcquisitionFailure(_contract_failure()) from None
        if expected != evidence:
            raise AcquisitionFailure(_contract_failure())
        return self._acquire_actions(self._actions(evidence, route_hints), candidate_keys)

    @staticmethod
    def _actions(
        evidence: AcquisitionEvidence,
        route_hints: tuple[AccessRouteHint, ...],
    ) -> tuple[_BrowserAction, ...]:
        goal = _article_goal(evidence)
        canonical_landings = tuple(
            hint.value for hint in route_hints if hint.kind is AccessRouteHintKind.CANONICAL_LANDING
        )
        candidates: list[tuple[str, str, str]] = [
            (value, "landing", value) for value in canonical_landings
        ]
        for observed in evidence.asset_hints:
            hint = observed.hint
            if not _eligible_hint(hint.asset_role):
                continue
            if canonical_landings:
                try:
                    if _safe_https_url(hint.url).origin.text == _DOI_RESOLVER_ORIGIN:
                        continue
                except (TypeError, ValueError):
                    continue
            kind = "landing" if hint.kind is AssetHintKind.LANDING_PAGE else "direct-file"
            candidates.append((hint.url, kind, hint.url))
        doi = _canonical_doi(evidence)
        if (
            not canonical_landings
            and doi is not None
            and evidence.resolved_landing_origin is not None
        ):
            candidates.append(
                (
                    _doi_resolver_url(doi),
                    "doi-resolver",
                    f"{doi.value}\x00{evidence.resolved_landing_origin}",
                )
            )
        actions: list[_BrowserAction] = []
        seen: set[str] = set()
        for start, kind, identity in candidates:
            try:
                normalized = _safe_https_url(start)
            except (TypeError, ValueError):
                continue
            dedupe = f"{kind}\x00{normalized.url}"
            if dedupe in seen:
                continue
            seen.add(dedupe)
            scope_origin = (
                goal.landing_origins[0] if goal.landing_origins else normalized.origin.text
            )
            actions.append(
                _BrowserAction(
                    start_url=normalized.url,
                    scope_origin=scope_origin,
                    evidence_kind=kind,
                    identity=identity,
                    article_goal=goal,
                )
            )
        return tuple(actions)

    def _acquire_actions(
        self,
        actions: tuple[_BrowserAction, ...],
        candidate_keys: CandidateKeyTracker,
    ) -> Iterator[TemporaryPdf]:
        first_failure: AcquisitionSourceFailure | None = None
        for action in actions:
            failure = yield from self._acquire_action(action, candidate_keys)
            if failure is not None and first_failure is None:
                first_failure = failure
        if first_failure is not None:
            raise first_failure

    def _acquire_action(
        self,
        action: _BrowserAction,
        candidate_keys: CandidateKeyTracker,
    ) -> Generator[TemporaryPdf, None, AcquisitionSourceFailure | None]:
        started_ns = time.monotonic_ns()
        key = _candidate_key(action)
        if not self._claim(candidate_keys, key):
            return None
        try:
            result, agent_result, policy = self._run_action(action)
            if isinstance(result, BrowserCaptureBatch):
                deliveries = self._capture_deliveries(
                    action,
                    result,
                    policy,
                    candidate_keys,
                )
                delivered = 0
                for temporary in deliveries:
                    delivered += 1
                    yield temporary
                if delivered:
                    _LOGGER.info(
                        "event=browser-article-finished outcome=delivered capture_count=%d "
                        "agent_outcome=%s elapsed_ms=%d",
                        delivered,
                        agent_result.outcome,
                        _elapsed_ms(started_ns),
                    )
                    return None
            failure = self._result_failure(result, agent_result)
            if failure is not None:
                return failure
            _LOGGER.info(
                "event=browser-article-finished outcome=miss agent_outcome=%s elapsed_ms=%d",
                agent_result.outcome,
                _elapsed_ms(started_ns),
            )
            return None
        except AcquisitionSourceFailure as error:
            return error
        except AcquisitionFailure:
            raise
        except Exception:
            return AcquisitionSourceFailure(_runtime_failure())

    @staticmethod
    def _claim(candidate_keys: CandidateKeyTracker, key: str) -> bool:
        try:
            return candidate_keys.claim(key)
        except Exception:
            raise AcquisitionFailure(_contract_failure()) from None

    def _capture_deliveries(
        self,
        action: _BrowserAction,
        result: BrowserCaptureBatch,
        policy: _GenericCapturePolicy,
        candidate_keys: CandidateKeyTracker,
    ) -> Iterator[TemporaryPdf]:
        for capture in self._ordered_captures(result):
            association = policy.association_evidence(capture)
            if association is None:
                continue
            capture_key = _capture_candidate_key(action, capture)
            if self._claim(candidate_keys, capture_key):
                yield self._temporary_pdf(
                    action,
                    capture_key,
                    capture,
                    association,
                )

    @staticmethod
    def _result_failure(
        result: BrowserResult,
        agent_result: BrowserAgentResult,
    ) -> AcquisitionSourceFailure | None:
        failure = _terminal_failure(agent_result)
        if failure is not None:
            if failure.code == "acquisition-browser-cancelled":
                raise AcquisitionFailure(failure)
            return AcquisitionSourceFailure(failure)
        if isinstance(result, AccessFailure) and result.code not in {
            "no-download",
            "not-found",
            "not-entitled",
        }:
            return AcquisitionSourceFailure(_agent_access_failure(result))
        return None

    def _run_action(
        self,
        action: _BrowserAction,
    ) -> tuple[BrowserResult, BrowserAgentResult, _GenericCapturePolicy]:
        step_factory = _GenericStepSessionFactory()
        if not isinstance(step_factory, BrowserStepSessionFactory):
            raise AcquisitionFailure(_contract_failure())
        controller = AgentBrowserController(
            runtime=self._agent_runtime,
            step_factory=step_factory,
            article_goal=action.article_goal,
            cancel_event=self._cancel_event,
        )
        policy = _GenericCapturePolicy(action)
        scope_url = _safe_https_url(action.scope_origin)
        scope, profile_policy = self._web_access_profile_resolver.resolve(scope_url)
        effective_policy = AccessPolicy.strictest(
            _BASELINE_WEB_POLICY,
            profile_policy,
            self._operator_policy,
        )
        try:
            article_origins = tuple(
                dict.fromkeys(
                    (
                        action.scope_origin,
                        *action.article_goal.landing_origins,
                        *action.article_goal.asset_origins,
                    )
                )
            )[:31]
            result = self._runner.run(
                scope,
                BrowserRequest(
                    url=action.start_url,
                    timeout_seconds=_TIMEOUT_SECONDS,
                    max_response_bytes=_MAX_DOWNLOAD_BYTES,
                ),
                effective_policy,
                controller=controller,
                destination_guard=build_generic_browser_destination_guard(
                    action.start_url,
                    article_origins=article_origins,
                ),
                capture_policy=policy,
                navigation_only=False,
                discard_unapproved_subresources=True,
                limits=_BROWSER_OPERATION_LIMITS,
                timeout_seconds=_TIMEOUT_SECONDS,
                cancel_event=self._cancel_event,
            )
        except AcquisitionFailure:
            raise
        except Exception:
            raise AcquisitionSourceFailure(_runtime_failure()) from None
        agent_result = controller.result
        if agent_result is None:
            if isinstance(result, AccessFailure):
                raise AcquisitionSourceFailure(_agent_access_failure(result))
            raise AcquisitionFailure(_contract_failure())
        return result, agent_result, policy

    @staticmethod
    def _ordered_captures(result: BrowserCaptureBatch) -> tuple[BrowserCapture, ...]:
        priority = {kind: index for index, kind in enumerate(_CAPTURE_PRIORITY)}
        return tuple(sorted(result.captures, key=lambda item: priority[item.kind]))

    def _temporary_pdf(
        self,
        action: _BrowserAction,
        key: str,
        capture: BrowserCapture,
        association: BrowserPdfAssociationEvidence,
    ) -> TemporaryPdf:
        content = _BrowserTemporaryPdfContent(capture.stream.chunks)
        try:
            return TemporaryPdf(
                candidate=PdfCandidate(
                    candidate_key=key,
                    source_name=self.source_name,
                    acquisition_path=self.acquisition_path,
                    declared_media_type=capture.stream.media_type,
                ),
                content=content,
                safe_source_url=_safe_source_url(capture.stream.final_locator),
                provenance=self._provenance(action),
                browser_association=association,
            )
        except Exception:
            content.discard()
            raise AcquisitionFailure(_contract_failure()) from None

    def _provenance(self, action: _BrowserAction) -> Provenance:
        try:
            provenance_id = self._provenance_id_factory()
            observed_at = self._clock()
        except Exception:
            raise AcquisitionFailure(_contract_failure()) from None
        if not isinstance(provenance_id, ProvenanceId) or not isinstance(
            observed_at,
            UtcTimestamp,
        ):
            raise AcquisitionFailure(_contract_failure())
        parameters = "\x00".join(
            (
                "generic-browser-v1",
                action.evidence_kind,
                action.scope_origin,
                action.article_goal.doi or "",
                action.article_goal.title or "",
            )
        )
        return Provenance(
            provenance_id=provenance_id,
            source_kind=SourceKind.ASSET_PROVIDER,
            source_name=self.source_name,
            source_record_id="generic-browser@1",
            observed_at=observed_at,
            input_sha256=None,
            parameters_sha256=Sha256(hashlib.sha256(parameters.encode()).hexdigest()),
        )


__all__ = (
    "BrowserFlowSession",
    "BrowserRunner",
    "CONTROLLED_BROWSER_PRODUCTION_STATUS",
    "ControlledBrowserPdfSource",
    "GenericBrowserDestinationGuard",
    "build_generic_browser_destination_guard",
)
