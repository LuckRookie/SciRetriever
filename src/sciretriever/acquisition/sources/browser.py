"""Evidence-routed, declarative controlled-Browser PDF acquisition.

This adapter selects exactly one controller before an article flow starts.
Rules use reviewed static discovery and click knowledge; Agent control starts
from the first unified observation and may operate an ordinary visible
challenge through six closed actions.  Both modes reuse Network's guarded
action/capture runtime.  Neither receives a page, context, process, profile,
Cookie, download object, vendor lifecycle handle, login/MFA input, arbitrary
URL, selector execution handle, or script capability.

The Network Browser checks every real destination against both its general
URL/DNS/admission policy and the closed site-rule guard supplied here.  The
guard receives only a normalized, query-free locator and an operation kind;
it cannot weaken Network policy or access Browser vendor objects.  Production
readiness is installed only when the closed production rule catalog is
nonempty; runtime/profile readiness remains a separate Bootstrap concern.
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
from enum import Enum, unique
from io import BytesIO
from typing import BinaryIO, Final, NoReturn, Protocol, runtime_checkable
from urllib.parse import quote
from uuid import uuid4

from sciretriever.acquisition.browser_control import (
    AgentBrowserController,
    BrowserAgentControlFactory,
    BrowserAgentControlSession,
    BrowserAgentDisposition,
    BrowserAgentResult,
    BrowserControllerKind,
    RuleBrowserController,
)
from sciretriever.acquisition.outcomes import RouteExecutionResult
from sciretriever.acquisition.planning import RouteReadiness, runtime_url_origin
from sciretriever.acquisition.ports import (
    AcquisitionFailure,
    AcquisitionSourceFailure,
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
from sciretriever.acquisition.sources.browser_rules import (
    PRODUCTION_BROWSER_RULE_CATALOG,
    BrowserActionKind,
    BrowserCaptureDisposition,
    BrowserChallengeResourceMatch,
    BrowserPageMarkerKind,
    BrowserRuleAction,
    BrowserRuleCatalog,
    BrowserSiteRule,
)
from sciretriever.acquisition.sources.browser_rules.model import BrowserChallengePathFamily
from sciretriever.acquisition.sources.direct import WebAccessProfileResolver
from sciretriever.agents.api import AgentRuntime
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
from sciretriever.model.primitives import ProvenanceId, SourceKind, UtcTimestamp
from sciretriever.model.provenance import Provenance
from sciretriever.model.report import StableFailure
from sciretriever.network.admission import AccessPolicy, AccessScope
from sciretriever.network.browser import (
    BrowserCaptureGuard,
    BrowserDestinationGuard,
    BrowserDestinationKind,
    BrowserFlowController,
    BrowserFlowSession,
    BrowserOperationLimits,
    BrowserPageObservation,
    BrowserRequestObservation,
)
from sciretriever.network.browser_control import (
    BrowserAction,
    BrowserActionReceipt,
    BrowserControlSession,
    BrowserObservation,
    BrowserPageState,
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
_MAX_DISCOVERED_PDF_ATTEMPTS: Final[int] = 4
_BASELINE_WEB_POLICY: Final[AccessPolicy] = AccessPolicy(
    max_concurrency=1,
    min_start_interval=1.0,
)
_BROWSER_OPERATION_LIMITS: Final[BrowserOperationLimits] = BrowserOperationLimits(
    max_capture_bytes=_MAX_DOWNLOAD_BYTES,
    action_timeout_seconds=10.0,
    capture_wait_timeout_seconds=10.0,
)
_KNOWN_BROWSER_FAILURES: Final[frozenset[str]] = frozenset(
    {
        "policy",
        "admission",
        "cancelled",
        "timeout",
        "oversize",
        "challenge-resource-blocked",
        "cleanup",
        "runtime",
    }
)
_LOGGER = get_logger(__name__)


@unique
class _ChallengeRejectionReason(str, Enum):
    """Bounded, payload-free reasons for a challenge-resource rejection."""

    CAPTURE = "capture"
    POPUP = "popup"
    ORIGIN = "origin"
    RESOURCE_TYPE = "resource-type"
    PATH = "path"
    TOP_FRAME_MISSING = "top-frame-missing"
    TOP_FRAME_UNSAFE = "top-frame-unsafe"
    ARTICLE_MISMATCH = "article-mismatch"
    FRAME_DEPTH_MISSING = "frame-depth-missing"
    ANCESTRY_MISSING = "ancestry-missing"
    ANCESTRY_UNSAFE = "ancestry-unsafe"
    ANCESTRY_NO_PUBLISHER = "ancestry-no-publisher"
    TOP_FRAME_NAVIGATION = "top-frame-navigation"
    TOP_FRAME_DEPTH = "top-frame-depth"
    REDIRECT_CHAIN = "redirect-chain"


ProvenanceIdFactory = Callable[[], ProvenanceId]
Clock = Callable[[], UtcTimestamp]


def _new_provenance_id() -> ProvenanceId:
    return ProvenanceId(str(uuid4()))


def _utc_now() -> UtcTimestamp:
    value = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    return UtcTimestamp(value)


def _elapsed_ms(started_ns: int) -> int:
    return max(0, (time.monotonic_ns() - started_ns) // 1_000_000)


def _stable_failure(
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


def _browser_failure(code: str) -> StableFailure:
    normalized = code if code in _KNOWN_BROWSER_FAILURES else "runtime"
    details: dict[str, tuple[str, str, bool]] = {
        "policy": (
            "The controlled Browser destination was rejected.",
            "Check the local site rule and Network destination policy.",
            False,
        ),
        "admission": (
            "The controlled Browser could not obtain shared web admission.",
            "Retry after the shared web scope is available.",
            True,
        ),
        "cancelled": (
            "The controlled Browser operation was cancelled.",
            "Retry the acquisition operation when appropriate.",
            True,
        ),
        "timeout": (
            "The controlled Browser operation timed out.",
            "Retry after checking Browser and provider availability.",
            True,
        ),
        "oversize": (
            "The controlled Browser capture exceeded its per-capture byte limit.",
            "Use another approved PDF source.",
            False,
        ),
        "challenge": (
            "The controlled Browser encountered an unsupported access challenge.",
            "Use another approved source or complete access outside automation.",
            False,
        ),
        "challenge-resource-blocked": (
            "The controlled Browser challenge resource was blocked by local policy.",
            "Review the approved challenge resource profile before retrying.",
            False,
        ),
        "cleanup": (
            "The controlled Browser could not clean up all runtime resources.",
            "Check the Browser runtime before retrying.",
            True,
        ),
        "runtime": (
            "The controlled Browser runtime failed.",
            "Check the Browser runtime and verified local rule before retrying.",
            True,
        ),
    }
    reason, action, retryable = details[normalized]
    return _stable_failure(
        code=f"acquisition-browser-{normalized}-failed",
        reason=reason,
        action=action,
        retryable=retryable,
    )


def _browser_page_failure(state: BrowserPageState) -> StableFailure:
    details: dict[BrowserPageState, tuple[str, str, str, bool]] = {
        BrowserPageState.LOGIN_REQUIRED: (
            "acquisition-browser-login-required",
            "The controlled Browser page requires an explicit login.",
            "Use an authorized API or provide the PDF manually; Browser login is unsupported.",
            False,
        ),
        BrowserPageState.MFA_REQUIRED: (
            "acquisition-browser-mfa-required",
            "The controlled Browser page requires explicit MFA.",
            "Use an authorized API or provide the PDF manually; Browser MFA is unsupported.",
            False,
        ),
        BrowserPageState.ACCESS_DENIED: (
            "acquisition-browser-access-denied",
            "The Publisher denied this Browser request without a more specific page reason.",
            "Check article access outside automation or use another approved source.",
            False,
        ),
    }
    try:
        code, reason, action, retryable = details[state]
    except KeyError:
        raise AcquisitionFailure(_contract_failure()) from None
    return _stable_failure(
        code=code,
        reason=reason,
        action=action,
        retryable=retryable,
    )


def _browser_marker_failure(kind: BrowserPageMarkerKind) -> StableFailure:
    details: dict[BrowserPageMarkerKind, tuple[str, str, str, bool]] = {
        BrowserPageMarkerKind.RATE_LIMITED: (
            "acquisition-browser-rate-limited",
            "The controlled Browser provider is currently rate limited.",
            "Retry after the provider risk group becomes available.",
            True,
        ),
        BrowserPageMarkerKind.IP_BLOCKED: (
            "acquisition-browser-ip-blocked",
            "The controlled Browser provider reported an IP access block.",
            "Review provider access outside automation before retrying.",
            False,
        ),
        BrowserPageMarkerKind.ACCOUNT_WARNING: (
            "acquisition-browser-account-warning",
            "The controlled Browser provider reported an account safety warning.",
            "Review the provider account outside automation before retrying.",
            False,
        ),
    }
    try:
        code, reason, action, retryable = details[kind]
    except KeyError:
        raise AcquisitionFailure(_contract_failure()) from None
    return _stable_failure(
        code=code,
        reason=reason,
        action=action,
        retryable=retryable,
    )


def _challenge_resource_blocked_failure() -> StableFailure:
    return _stable_failure(
        code="acquisition-browser-challenge-resource-blocked",
        reason="A reviewed challenge dependency was blocked by local Network policy.",
        action="Review the Publisher challenge resource profile before retrying.",
        retryable=False,
    )


def _challenge_unresolved_failure() -> StableFailure:
    return _stable_failure(
        code="acquisition-browser-challenge-unresolved",
        reason="The selected Browser controller stopped while the access challenge remained.",
        action="Retry later or select another approved PDF source.",
        retryable=True,
    )


def _contract_failure() -> StableFailure:
    return _stable_failure(
        code="acquisition-browser-contract",
        reason="A controlled Browser component violated its neutral contract.",
        action="Correct the local Browser Source assembly.",
        retryable=False,
    )


def _page_state_conflict_failure() -> StableFailure:
    return _stable_failure(
        code="acquisition-browser-page-state-conflict",
        reason="The controlled Browser page matched conflicting access states.",
        action="Review the local Provider page markers before retrying.",
        retryable=False,
    )


_PRODUCTION_FAILURE: Final[StableFailure] = _stable_failure(
    code="acquisition-browser-production-unavailable",
    reason="No complete production Browser provider profile is verified.",
    action="Keep controlled Browser acquisition disabled until one is verified.",
    retryable=False,
)
CONTROLLED_BROWSER_PRODUCTION_STATUS: Final[RouteInstallationStatus] = (
    RouteInstallationStatus(readiness=RouteReadiness.READY)
    if PRODUCTION_BROWSER_RULE_CATALOG.rules
    else RouteInstallationStatus(
        readiness=RouteReadiness.UNSUPPORTED,
        failure=_PRODUCTION_FAILURE,
    )
)


@runtime_checkable
class BrowserRunner(Protocol):
    """Structural subset of ``network.browser.BrowserClient.run``.

    The private Network ``_BrowserSession`` type is intentionally absent.  A
    compatible runner supplies an object that structurally implements the
    neutral controller seam while invoking one article-local Browser flow.
    """

    def run(
        self,
        scope: AccessScope,
        request: BrowserRequest | str,
        policy: AccessPolicy,
        *,
        controller: BrowserFlowController | None = None,
        destination_guard: BrowserDestinationGuard | None = None,
        capture_guard: BrowserCaptureGuard | None = None,
        navigation_only: bool = False,
        discard_unapproved_subresources: bool = False,
        limits: BrowserOperationLimits | None = None,
        timeout_seconds: float | None = None,
        cancel_event: threading.Event | None = None,
    ) -> BrowserResult: ...


@dataclass(frozen=True, slots=True, repr=False)
class _BrowserAction:
    rule: BrowserSiteRule
    start_url: str
    evidence_kind: str
    landing_url: str | None
    identifiers: tuple[Identifier, ...] = field(repr=False)
    identity: str = field(repr=False)


@dataclass(frozen=True, slots=True)
class _PageClassification:
    page_state: BrowserPageState
    authenticated: bool
    entitled: bool
    conflict: bool
    matched: frozenset[BrowserPageMarkerKind]
    failure: StableFailure | None = field(default=None, repr=False)


@dataclass(slots=True)
class _BrowserAttemptFacts:
    """Current article facts without a parallel lifecycle or transition history."""

    page_state: BrowserPageState = BrowserPageState.NORMAL
    failure: StableFailure | None = field(default=None, repr=False)

    def observe(self, classification: _PageClassification) -> None:
        self.page_state = classification.page_state
        if self.failure is None and classification.failure is not None:
            self.failure = classification.failure

    def fail(self, failure: StableFailure) -> None:
        if self.failure is None:
            self.failure = failure


@dataclass(frozen=True, slots=True)
class _DeterministicRuleExecution:
    """Typed state owned by one reviewed Publisher deterministic controller."""

    rule: BrowserSiteRule
    capture_guard: _RuleCaptureGuard
    facts: _BrowserAttemptFacts = field(repr=False)

    def run(self, session: BrowserFlowSession) -> None:
        ControlledBrowserPdfSource._run_rule_flow(
            session,
            self.rule,
            self.capture_guard,
            self.facts,
        )


@dataclass(slots=True)
class _PublisherAgentControl:
    """Add Publisher page classification to Network's neutral control handle."""

    inner: BrowserControlSession
    session: BrowserFlowSession
    rule: BrowserSiteRule
    capture_guard: _RuleCaptureGuard
    facts: _BrowserAttemptFacts

    def observe(self) -> BrowserObservation:
        if ControlledBrowserPdfSource._expected_capture_available(self.session, self.rule):
            return self.inner.observe(page_state=self.facts.page_state)
        classification, page = _classify_page(self.session, self.rule)
        self.capture_guard.bind_landing(page.locator)
        self.facts.observe(classification)
        return self.inner.observe(page_state=classification.page_state)

    def execute(
        self,
        action: BrowserAction,
        observation: BrowserObservation,
        *,
        timeout_seconds: float,
    ) -> BrowserActionReceipt:
        return self.inner.execute(action, observation, timeout_seconds=timeout_seconds)


@dataclass(frozen=True, slots=True)
class _PublisherAgentControlFactory:
    """Open one Publisher-classified control view for the current article."""

    rule: BrowserSiteRule
    capture_guard: _RuleCaptureGuard
    facts: _BrowserAttemptFacts = field(repr=False)

    def open(self, session: BrowserFlowSession) -> BrowserAgentControlSession:
        if not isinstance(session, BrowserFlowSession):
            raise TypeError("Browser flow session violated its structural contract")
        inner = session.control_session()
        if not isinstance(inner, BrowserControlSession):
            raise TypeError("Browser control session violated its structural contract")
        return _PublisherAgentControl(
            inner=inner,
            session=session,
            rule=self.rule,
            capture_guard=self.capture_guard,
            facts=self.facts,
        )


@dataclass(slots=True)
class _BrowserSourceMetrics:
    attempted: int = 0
    delivered: int = 0
    failed: int = 0


@dataclass(frozen=True, slots=True, repr=False)
class BrowserRuleDestinationGuard:
    """Allow only one exact resolver start plus the rule's reviewed origins."""

    rule: BrowserSiteRule
    exact_start_url: str
    _landing_observer: Callable[[str], bool] | None = field(
        default=None,
        init=True,
        repr=False,
        compare=False,
    )
    _top_frame_locator: str | None = field(default=None, init=False, repr=False, compare=False)
    _top_frame_lock: threading.Lock = field(
        default_factory=threading.Lock,
        init=False,
        repr=False,
        compare=False,
    )
    _challenge_admitted_count: int = field(default=0, init=False, repr=False, compare=False)
    _challenge_blocked_count: int = field(default=0, init=False, repr=False, compare=False)

    def __post_init__(self) -> None:
        if not isinstance(self.rule, BrowserSiteRule):
            raise TypeError("rule must be a BrowserSiteRule")
        try:
            normalized = normalize_url_with_configured_port(self.exact_start_url)
        except (PolicyError, TypeError, ValueError):
            raise ValueError("exact_start_url must be a safe Browser URL") from None
        object.__setattr__(self, "exact_start_url", normalized.url)

    def check(self, url: str, kind: BrowserDestinationKind) -> None:
        if not isinstance(kind, BrowserDestinationKind):
            raise TypeError("kind must be a BrowserDestinationKind")
        try:
            normalized = normalize_url_with_configured_port(url)
        except (PolicyError, TypeError, ValueError):
            raise ValueError("Browser destination is not a safe URL") from None
        if self.rule.allows_url(normalized.url):
            return
        profile = self.rule.challenge_resource_profile
        if (
            profile is not None
            and normalized.origin.text == profile.origin
            and kind
            in {
                BrowserDestinationKind.REQUEST,
                BrowserDestinationKind.NAVIGATION,
                BrowserDestinationKind.RESPONSE,
            }
        ):
            # A challenge origin is admitted provisionally here so Network can
            # resolve/pin it.  ``check_request`` below is the mandatory
            # context-sensitive gate before route continuation or body read.
            return
        if (
            kind
            in {
                BrowserDestinationKind.INITIAL_NAVIGATION,
                BrowserDestinationKind.NAVIGATION,
                BrowserDestinationKind.RESPONSE,
            }
            and normalized.url == self.exact_start_url
        ):
            # A DOI-resolver entry is deliberately admitted only as the exact
            # initial locator.  Its HTTP response is the other half of that
            # same admitted navigation and must pass the response guard before
            # the reviewed Publisher redirect can be followed.  This does not
            # authorize arbitrary resolver requests, downloads, or redirects.
            return
        raise ValueError("Browser destination is outside the closed site rule")

    def connection_origins(self) -> tuple[str, ...]:
        """Return the finite Provider origins that the native tunnel may pin."""

        start = normalize_url_with_configured_port(self.exact_start_url).origin.text
        challenge = self.rule.challenge_resource_profile
        challenge_origins = () if challenge is None else challenge.connection_origins
        return tuple(dict.fromkeys((start, *self.rule.allowed_origins, *challenge_origins)))

    def check_request(self, observation: BrowserRequestObservation) -> None:
        """Admit only a bounded challenge dependency from this article page."""

        if not isinstance(observation, BrowserRequestObservation):
            raise TypeError("observation must be a BrowserRequestObservation")
        self._track_top_frame(observation)
        # A challenge-cleared top-frame navigation can immediately trigger a
        # PDF response before Acquisition gets to re-observe the page.  Bind
        # only from Network's context-rich request proof (top frame,
        # non-popup, exact Publisher origin) and only after this rule has
        # admitted at least one reviewed challenge resource.  Ordinary
        # Publisher navigations therefore retain the monotonic capture guard
        # behavior and cannot silently replace article identity.
        with self._top_frame_lock:
            challenge_admitted = self._challenge_admitted_count > 0
        if (
            self._landing_observer is not None
            and self.rule.challenge_resource_profile is not None
            and observation.is_navigation
            and observation.is_top_frame
            and not observation.is_popup
            and normalize_url_with_configured_port(observation.locator).origin.text
            in self.rule.recognized_landing_origins
            and challenge_admitted
        ):
            self._landing_observer(observation.locator)
        if self.rule.challenge_resource_profile is None or not self.rule.allows_challenge_origin(
            observation.locator
        ):
            # Ordinary Publisher requests are already handled by ``check``;
            # this hook only owns the special third-party dependency.
            return
        try:
            self._validate_challenge(observation)
        except Exception:
            with self._top_frame_lock:
                object.__setattr__(
                    self,
                    "_challenge_blocked_count",
                    self._challenge_blocked_count + 1,
                )
            raise
        with self._top_frame_lock:
            object.__setattr__(
                self,
                "_challenge_admitted_count",
                self._challenge_admitted_count + 1,
            )

    def challenge_resource_counts(self) -> tuple[int, int]:
        """Return aggregate, payload-free challenge dependency counts."""

        with self._top_frame_lock:
            return self._challenge_admitted_count, self._challenge_blocked_count

    def _track_top_frame(self, observation: BrowserRequestObservation) -> None:
        if not observation.is_navigation or not observation.is_top_frame or observation.is_popup:
            return
        top_locator = observation.top_frame_locator or observation.locator
        try:
            top = normalize_url_with_configured_port(top_locator)
        except (PolicyError, TypeError, ValueError):
            return
        if top.origin.text not in self.rule.recognized_landing_origins:
            return
        with self._top_frame_lock:
            previous = self._top_frame_locator
            if previous is None:
                object.__setattr__(self, "_top_frame_locator", top.url)
            elif observation.redirect_depth > 0:
                # A same-origin challenge redirect is still part of the
                # current article's navigation chain.  Playwright exposes the
                # redirected Publisher path as the frame locator, so retaining
                # the pre-redirect path would reject the first reviewed
                # challenge resource even though its origin and redirect
                # chain are bound to this article.  Only a same-origin
                # redirect can advance the binding; an ordinary same-origin
                # navigation (including a different article) and a
                # cross-origin redirect remain fail-closed.
                try:
                    previous_origin = normalize_url_with_configured_port(previous).origin.text
                except (PolicyError, TypeError, ValueError):
                    previous_origin = None
                if previous_origin == top.origin.text:
                    object.__setattr__(self, "_top_frame_locator", top.url)

    @staticmethod
    def _log_challenge_rejection(
        observation: BrowserRequestObservation,
        reason: _ChallengeRejectionReason,
        path_family: BrowserChallengePathFamily,
    ) -> None:
        """Log only bounded request shape, never a locator or payload."""

        _LOGGER.debug(
            "event=browser-challenge-resource-rejected reason=%s path_family=%s "
            "resource_type=%s request_kind=%s frame_depth=%s ancestry_depth=%d "
            "is_top_frame=%s is_navigation=%s",
            reason.value,
            path_family.value,
            observation.resource_type,
            observation.kind.value,
            observation.frame_depth,
            len(observation.frame_ancestry),
            str(observation.is_top_frame).lower(),
            str(observation.is_navigation).lower(),
        )

    def _reject_challenge(
        self,
        observation: BrowserRequestObservation,
        reason: _ChallengeRejectionReason,
        message: str,
    ) -> NoReturn:
        profile = self.rule.challenge_resource_profile
        path_family = (
            BrowserChallengePathFamily.OTHER
            if profile is None
            else profile.path_family(observation)
        )
        self._log_challenge_rejection(observation, reason, path_family)
        raise ValueError(message)

    def _validate_challenge(self, observation: BrowserRequestObservation) -> None:
        # Network reports a tentative ``RESPONSE`` capture kind for every
        # successful response, including the challenge iframe document and
        # its script.  Those resources must be allowed to load.  A reviewed
        # challenge PDF/body remains forbidden before body access; the
        # provider capture guard is a second defence for all other paths.
        if observation.capture_kind is not None and observation.locator.casefold().endswith(".pdf"):
            self._reject_challenge(
                observation,
                _ChallengeRejectionReason.CAPTURE,
                "challenge resources cannot be captured",
            )
        if observation.is_popup:
            self._reject_challenge(
                observation,
                _ChallengeRejectionReason.POPUP,
                "challenge resources cannot originate in a popup",
            )
        profile = self.rule.challenge_resource_profile
        if profile is None:
            self._reject_challenge(
                observation,
                _ChallengeRejectionReason.ORIGIN,
                "challenge dependency is not reviewed",
            )
        profile_match = profile.match_reason(observation)
        if profile_match is not BrowserChallengeResourceMatch.ADMITTED:
            reason = (
                _ChallengeRejectionReason.RESOURCE_TYPE
                if profile_match is BrowserChallengeResourceMatch.RESOURCE_TYPE_MISMATCH
                else _ChallengeRejectionReason.PATH
                if profile_match is BrowserChallengeResourceMatch.PATH_MISMATCH
                else _ChallengeRejectionReason.ORIGIN
            )
            self._reject_challenge(
                observation,
                reason,
                "challenge path or resource type is not reviewed",
            )
        self._validate_challenge_frame(observation)
        if observation.redirect_depth > 8:
            self._reject_challenge(
                observation,
                _ChallengeRejectionReason.REDIRECT_CHAIN,
                "challenge redirect chain is too deep",
            )

    def _validate_challenge_frame(self, observation: BrowserRequestObservation) -> None:
        if observation.top_frame_locator is None:
            self._reject_challenge(
                observation,
                _ChallengeRejectionReason.TOP_FRAME_MISSING,
                "challenge request lacks top-frame proof",
            )
        try:
            top = normalize_url_with_configured_port(observation.top_frame_locator)
        except (PolicyError, TypeError, ValueError):
            self._reject_challenge(
                observation,
                _ChallengeRejectionReason.TOP_FRAME_UNSAFE,
                "challenge top frame is not a safe URL",
            )
        if top.origin.text not in self.rule.recognized_landing_origins:
            self._reject_challenge(
                observation,
                _ChallengeRejectionReason.ANCESTRY_NO_PUBLISHER,
                "challenge request is not attached to this Publisher",
            )
        with self._top_frame_lock:
            expected_top = self._top_frame_locator
        if expected_top is not None and expected_top != top.url:
            observer = self._landing_observer
            if observer is None or not observer(top.url):
                self._reject_challenge(
                    observation,
                    _ChallengeRejectionReason.ARTICLE_MISMATCH,
                    "challenge request belongs to another article",
                )
            with self._top_frame_lock:
                object.__setattr__(self, "_top_frame_locator", top.url)
        if observation.frame_depth is None:
            self._reject_challenge(
                observation,
                _ChallengeRejectionReason.FRAME_DEPTH_MISSING,
                "challenge request lacks frame depth",
            )
        self._validate_challenge_ancestry(observation)
        if observation.is_navigation and observation.is_top_frame:
            self._reject_challenge(
                observation,
                _ChallengeRejectionReason.TOP_FRAME_NAVIGATION,
                "challenge origin cannot be a top-level navigation",
            )
        if observation.is_top_frame and observation.frame_depth != 0:
            self._reject_challenge(
                observation,
                _ChallengeRejectionReason.TOP_FRAME_DEPTH,
                "top-frame challenge proof is inconsistent",
            )

    def _validate_challenge_ancestry(self, observation: BrowserRequestObservation) -> None:
        if observation.frame_depth is None:
            self._reject_challenge(
                observation,
                _ChallengeRejectionReason.FRAME_DEPTH_MISSING,
                "challenge request lacks frame depth",
            )
        if observation.frame_depth > 0:
            if not observation.frame_ancestry:
                self._reject_challenge(
                    observation,
                    _ChallengeRejectionReason.ANCESTRY_MISSING,
                    "challenge iframe lacks bounded ancestry",
                )
            try:
                ancestry = tuple(
                    normalize_url_with_configured_port(value)
                    for value in observation.frame_ancestry
                )
            except (PolicyError, TypeError, ValueError):
                self._reject_challenge(
                    observation,
                    _ChallengeRejectionReason.ANCESTRY_UNSAFE,
                    "challenge frame ancestry is not safe",
                )
            if not any(
                candidate.origin.text in self.rule.recognized_landing_origins
                for candidate in ancestry
            ):
                self._reject_challenge(
                    observation,
                    _ChallengeRejectionReason.ANCESTRY_NO_PUBLISHER,
                    "challenge frame ancestry has no Publisher ancestor",
                )


def build_browser_rule_destination_guard(
    rule: BrowserSiteRule,
    exact_start_url: str,
    landing_observer: Callable[[str], bool] | None = None,
) -> BrowserRuleDestinationGuard:
    """Build the one reviewed destination guard shared by Browser entrypoints."""

    return BrowserRuleDestinationGuard(
        rule=rule,
        exact_start_url=exact_start_url,
        _landing_observer=landing_observer,
    )


@dataclass(slots=True, repr=False)
class _RuleCaptureGuard:
    """Capture only reviewed main-PDF locator prefixes in the current rule."""

    action: _BrowserAction
    _landing_url: str | None = field(init=False, default=None, repr=False)
    _lock: threading.Lock = field(default_factory=threading.Lock, init=False, repr=False)

    def __post_init__(self) -> None:
        if not isinstance(self.action, _BrowserAction):
            raise TypeError("action must be a _BrowserAction")
        self._landing_url = self.action.landing_url

    def bind_landing(self, value: str) -> None:
        """Bind the reviewed final article landing reached through DOI resolution."""

        try:
            normalized = normalize_url_with_configured_port(value)
        except (PolicyError, TypeError, ValueError):
            return
        if normalized.origin.text != self.action.rule.landing_origin:
            return
        with self._lock:
            if self._landing_url is None:
                self._landing_url = normalized.url

    def rebind_landing(self, value: str) -> bool:
        """Replace the landing after a reviewed challenge redirects the page.

        The action starts with the locator that was supplied by metadata (which
        can itself be a challenge page).  Once the challenge has cleared,
        Acquisition has a fresh page observation proving the exact Publisher
        landing that owns the subsequent PDF response.  Keep the ordinary
        ``bind_landing`` operation monotonic for intermediate observations, but
        explicitly replace that initial locator at this lifecycle boundary.
        """

        try:
            normalized = normalize_url_with_configured_port(value)
        except (PolicyError, TypeError, ValueError):
            return False
        if normalized.origin.text != self.action.rule.landing_origin:
            return False
        with self._lock:
            if self._landing_url is not None and not self.action.rule.matches_article_landing(
                normalized.url,
                landing_url=self._landing_url,
                identifiers=self.action.identifiers,
            ):
                return False
            self._landing_url = normalized.url
            return True

    @property
    def landing_url(self) -> str | None:
        """Return the latest exact-origin article landing observed in this flow."""

        with self._lock:
            return self._landing_url

    def allows(
        self,
        url: str,
        kind: BrowserCaptureKind,
        media_type: str,
    ) -> bool:
        action = self.action
        with self._lock:
            landing_url = self._landing_url
        return (
            action.rule.classify_capture(
                url,
                kind,
                media_type,
                landing_url=landing_url,
                identifiers=action.identifiers,
            )
            is BrowserCaptureDisposition.PRIMARY
        )


class _BrowserTemporaryPdfContent:
    """An in-memory neutral delivery with deterministic idempotent cleanup."""

    __slots__ = ("_chunks", "_lock")

    def __init__(self, chunks: tuple[bytes, ...]) -> None:
        if not isinstance(chunks, tuple) or any(not isinstance(chunk, bytes) for chunk in chunks):
            raise TypeError("chunks must be a tuple of bytes")
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


def _normalized_url(value: object) -> NormalizedURL:
    if not isinstance(value, str):
        raise AcquisitionFailure(_browser_failure("policy"))
    try:
        return normalize_url_with_configured_port(value)
    except (PolicyError, TypeError, ValueError):
        raise AcquisitionFailure(_browser_failure("policy")) from None


def _canonical_doi(evidence: AcquisitionEvidence) -> Identifier | None:
    dois = tuple(identifier for identifier in evidence.identifiers if identifier.namespace == "doi")
    return dois[0] if len(dois) == 1 else None


def _doi_resolver_url(doi: Identifier) -> str:
    encoded = quote(doi.value, safe="/")
    return _normalized_url(f"{_DOI_RESOLVER_ORIGIN}/{encoded}").url


def _reviewed_doi_start_url(
    rule: BrowserSiteRule,
    doi: Identifier,
    identifiers: tuple[Identifier, ...],
) -> str:
    locator = rule.doi_pdf_locator(identifiers)
    return _doi_resolver_url(doi) if locator is None else locator


def _candidate_key(action: _BrowserAction) -> str:
    identity = "\x00".join(
        (
            _SOURCE_NAME,
            AcquisitionPath.CONTROLLED_BROWSER.value,
            action.rule.rule_id,
            str(action.rule.revision),
            action.rule.fingerprint.root,
            action.evidence_kind,
            action.identity,
        )
    )
    digest = hashlib.sha256(identity.encode("utf-8", "strict")).hexdigest()
    return f"controlled-browser:{digest}"


def _capture_candidate_key(action: _BrowserAction, capture: BrowserCapture) -> str:
    stream = capture.stream
    body_digest = hashlib.sha256(b"".join(stream.chunks)).hexdigest()
    identity = "\x00".join(
        (
            _candidate_key(action),
            capture.kind.value,
            stream.final_locator,
            body_digest,
        )
    )
    digest = hashlib.sha256(identity.encode("utf-8", "strict")).hexdigest()
    return f"controlled-browser:{digest}"


def _eligible_landing_role(role: AssetRole | None) -> bool:
    return role is None or role is AssetRole.PRIMARY_PDF


def _result_ends_without_pdf(result: BrowserResult) -> bool:
    """Interpret one Network result without inventing a second Browser lifecycle."""

    if isinstance(result, BrowserCaptureBatch):
        return False
    if not isinstance(result, AccessFailure):
        raise AcquisitionFailure(_contract_failure())
    if result.code in {"no-download", "not-found", "not-entitled"}:
        return True
    if result.code == "challenge":
        raise AcquisitionSourceFailure(_challenge_unresolved_failure())
    if result.code == "access-denied":
        raise AcquisitionSourceFailure(_browser_page_failure(BrowserPageState.ACCESS_DENIED))
    if result.code in {"rate-limit", "rate-limited"}:
        raise AcquisitionSourceFailure(_browser_marker_failure(BrowserPageMarkerKind.RATE_LIMITED))
    if result.code == "ip-blocked":
        raise AcquisitionSourceFailure(_browser_marker_failure(BrowserPageMarkerKind.IP_BLOCKED))
    if result.code == "account-warning":
        raise AcquisitionSourceFailure(
            _browser_marker_failure(BrowserPageMarkerKind.ACCOUNT_WARNING)
        )
    return False


def _log_browser_terminal(
    rule: BrowserSiteRule,
    *,
    page_state: BrowserPageState,
    failure: StableFailure,
    started_ns: int,
) -> None:
    """Explain one classified Browser stop without logging page contents."""

    _LOGGER.warning(
        "event=browser-flow-finished browser_rule_id=%s stage=page-state "
        "outcome=%s disposition=failure code=%s retryable=%s elapsed_ms=%d "
        "reason=%s action=%s",
        rule.rule_id,
        page_state.value,
        failure.code,
        str(failure.retryable).lower(),
        _elapsed_ms(started_ns),
        failure.reason,
        failure.action,
    )


def _agent_terminal_text(disposition: BrowserAgentDisposition) -> tuple[str, str]:
    """Return safe operator guidance for one Browser Agent disposition."""

    values: dict[BrowserAgentDisposition, tuple[str, str]] = {
        BrowserAgentDisposition.CAPTURE_AVAILABLE: (
            "The Browser Agent found that an approved PDF response is ready.",
            "Continue with capture validation.",
        ),
        BrowserAgentDisposition.STOPPED: (
            "The Browser Agent stopped without an approved PDF response.",
            "Use another approved source or retry the Browser route.",
        ),
        BrowserAgentDisposition.PAGE_TERMINAL: (
            "The Browser page reached a terminal access state.",
            "Review the reported page state or use another approved source.",
        ),
        BrowserAgentDisposition.CANCELLED: (
            "The Browser Agent operation was cancelled.",
            "Retry the acquisition operation when appropriate.",
        ),
        BrowserAgentDisposition.NO_PROGRESS: (
            "The Browser Agent proved that the selected action did not change this page.",
            "Use another approved source or retry after the page changes.",
        ),
        BrowserAgentDisposition.FAILED: (
            "The Browser Agent could not complete a safe action.",
            "Check Browser Agent capability and retry the route.",
        ),
    }
    return values[disposition]


_PAGE_MARKER_OUTCOMES: Final[dict[BrowserPageMarkerKind, str]] = {
    BrowserPageMarkerKind.LOGIN_REQUIRED: "login-required",
    BrowserPageMarkerKind.MFA_REQUIRED: "mfa-required",
    BrowserPageMarkerKind.NOT_ENTITLED: "not-entitled",
    BrowserPageMarkerKind.PAYWALL: "not-entitled",
    BrowserPageMarkerKind.ACCESS_DENIED: "access-denied",
    BrowserPageMarkerKind.CHALLENGE: "challenge",
    BrowserPageMarkerKind.RATE_LIMITED: "rate-limited",
    BrowserPageMarkerKind.IP_BLOCKED: "ip-blocked",
    BrowserPageMarkerKind.ACCOUNT_WARNING: "account-warning",
    BrowserPageMarkerKind.NOT_FOUND: "not-found",
}
_PAGE_STATES_BY_OUTCOME: Final[dict[str, BrowserPageState]] = {
    "login-required": BrowserPageState.LOGIN_REQUIRED,
    "mfa-required": BrowserPageState.MFA_REQUIRED,
    "not-entitled": BrowserPageState.NOT_ENTITLED,
    "access-denied": BrowserPageState.ACCESS_DENIED,
    "challenge": BrowserPageState.CHALLENGE,
    "rate-limited": BrowserPageState.FAILED,
    "ip-blocked": BrowserPageState.FAILED,
    "account-warning": BrowserPageState.FAILED,
    "not-found": BrowserPageState.NOT_FOUND,
}


def _page_classification_failure(
    page_state: BrowserPageState,
    matched: set[BrowserPageMarkerKind],
    *,
    conflict: bool,
) -> StableFailure | None:
    if conflict:
        return _page_state_conflict_failure()
    if page_state in {
        BrowserPageState.LOGIN_REQUIRED,
        BrowserPageState.MFA_REQUIRED,
        BrowserPageState.ACCESS_DENIED,
    }:
        return _browser_page_failure(page_state)
    for marker_kind in (
        BrowserPageMarkerKind.RATE_LIMITED,
        BrowserPageMarkerKind.IP_BLOCKED,
        BrowserPageMarkerKind.ACCOUNT_WARNING,
    ):
        if marker_kind in matched:
            return _browser_marker_failure(marker_kind)
    return None


def _classify_page(
    session: BrowserFlowSession,
    rule: BrowserSiteRule,
) -> tuple[_PageClassification, BrowserPageObservation]:
    observation_started_ns = time.monotonic_ns()
    _LOGGER.debug(
        "event=browser-page-observation-started browser_rule_id=%s",
        rule.rule_id,
    )
    observation = session.observe()
    _LOGGER.debug(
        "event=browser-page-observation-finished browser_rule_id=%s "
        "outcome=observed http_status=%s elapsed_ms=%d",
        rule.rule_id,
        "missing" if observation.status_code is None else observation.status_code,
        _elapsed_ms(observation_started_ns),
    )
    matched: set[BrowserPageMarkerKind] = set()
    observed_text: dict[str, str] = {}
    for marker in rule.page_markers:
        marker_started_ns = time.monotonic_ns()
        _LOGGER.debug(
            "event=browser-page-marker-check-started browser_rule_id=%s "
            "marker_id=%s selector_count=%d text_marker_count=%d",
            rule.rule_id,
            marker.marker_id,
            len(marker.css_selectors),
            len(marker.text_markers),
        )
        selector_match = any(session.has_selector(selector) for selector in marker.css_selectors)
        text_match = False
        for selector, fragment in marker.text_markers:
            text_value = observed_text.get(selector)
            if text_value is None:
                text_value = session.text(selector).casefold()
                observed_text[selector] = text_value
            if fragment in text_value:
                text_match = True
                break
        marker_match = selector_match or text_match or marker.matches_observation(observation)
        if marker_match:
            matched.add(marker.kind)
        _LOGGER.debug(
            "event=browser-page-marker-check-finished browser_rule_id=%s "
            "marker_id=%s outcome=%s elapsed_ms=%d",
            rule.rule_id,
            marker.marker_id,
            "matched" if marker_match else "miss",
            _elapsed_ms(marker_started_ns),
        )

    # A bare 403 is less specific than a reviewed page signal. Keep the
    # generic denial only when no challenge, paywall, login, throttling, or
    # other explicit terminal marker explains the response.
    if BrowserPageMarkerKind.ACCESS_DENIED in matched and any(
        kind in matched
        for kind in _PAGE_MARKER_OUTCOMES
        if kind is not BrowserPageMarkerKind.ACCESS_DENIED
    ):
        matched.remove(BrowserPageMarkerKind.ACCESS_DENIED)

    authenticated = BrowserPageMarkerKind.AUTHENTICATED in matched
    entitled = BrowserPageMarkerKind.ENTITLED in matched
    outcomes = {outcome for kind, outcome in _PAGE_MARKER_OUTCOMES.items() if kind in matched}
    login_conflict = authenticated and bool(
        matched
        & {
            BrowserPageMarkerKind.LOGIN_REQUIRED,
            BrowserPageMarkerKind.MFA_REQUIRED,
        }
    )
    entitlement_conflict = entitled and "not-entitled" in outcomes
    conflict = len(outcomes) > 1 or login_conflict or entitlement_conflict
    page_state = (
        BrowserPageState.NORMAL if not outcomes else _PAGE_STATES_BY_OUTCOME[next(iter(outcomes))]
    )
    if conflict:
        page_state = BrowserPageState.FAILED
    failure = _page_classification_failure(page_state, matched, conflict=conflict)
    return (
        _PageClassification(
            page_state=page_state,
            authenticated=authenticated,
            entitled=entitled,
            conflict=conflict,
            matched=frozenset(matched),
            failure=failure,
        ),
        observation,
    )


def _browser_rule_resolver(
    catalog: BrowserRuleCatalog,
    resolver: WebAccessProfileResolver | None,
) -> WebAccessProfileResolver:
    if resolver is None:
        profiles: dict[str, tuple[AccessScope, AccessPolicy]] = {}
        for rule in catalog.rules:
            profile = (
                AccessScope(rule.web_scope_provider_name, "web"),
                _BASELINE_WEB_POLICY,
            )
            for origin in rule.allowed_origins:
                hostname = _normalized_url(origin).hostname
                existing = profiles.get(hostname)
                if existing is not None and existing != profile:
                    raise ValueError("Browser rules assign one host to conflicting web scopes")
                profiles[hostname] = profile
        checked = WebAccessProfileResolver(profiles)
    else:
        checked = resolver
    for rule in catalog.rules:
        scope, _policy = checked.resolve(_normalized_url(rule.landing_origin))
        if scope != AccessScope(rule.web_scope_provider_name, "web"):
            raise ValueError("Browser rule web scope does not match the shared host profile")
    return checked


class ControlledBrowserPdfSource:
    """Controlled-Browser Source driven only by strong, local routing evidence."""

    __slots__ = (
        "_runner",
        "_route_key",
        "_rule_catalog",
        "_web_access_profile_resolver",
        "_operator_policy",
        "_cancel_event",
        "_provenance_id_factory",
        "_clock",
        "_browser_controller",
        "_agent_runtime",
    )

    def __init__(  # noqa: C901
        self,
        *,
        runner: BrowserRunner,
        route_key: str = "browser:controlled",
        rule_catalog: BrowserRuleCatalog = PRODUCTION_BROWSER_RULE_CATALOG,
        web_access_profile_resolver: WebAccessProfileResolver | None = None,
        access_policy: AccessPolicy | None = None,
        cancel_event: threading.Event | None = None,
        provenance_id_factory: ProvenanceIdFactory = _new_provenance_id,
        clock: Clock = _utc_now,
        browser_controller: BrowserControllerKind = BrowserControllerKind.RULES,
        agent_runtime: AgentRuntime | None = None,
    ) -> None:
        if not isinstance(runner, BrowserRunner):
            raise TypeError("runner must implement BrowserRunner")
        if type(route_key) is not str or _ROUTE_KEY.fullmatch(route_key) is None:
            raise ValueError("route_key must be a stable Browser route key")
        if not isinstance(rule_catalog, BrowserRuleCatalog):
            raise TypeError("rule_catalog must be a BrowserRuleCatalog")
        if web_access_profile_resolver is not None and not isinstance(
            web_access_profile_resolver,
            WebAccessProfileResolver,
        ):
            raise TypeError(
                "web_access_profile_resolver must be a WebAccessProfileResolver or None"
            )
        if access_policy is not None and not isinstance(access_policy, AccessPolicy):
            raise TypeError("access_policy must be an AccessPolicy or None")
        if cancel_event is not None and not isinstance(cancel_event, threading.Event):
            raise TypeError("cancel_event must be a threading.Event or None")
        if not callable(provenance_id_factory):
            raise TypeError("provenance_id_factory must be callable")
        if not callable(clock):
            raise TypeError("clock must be callable")
        if not isinstance(browser_controller, BrowserControllerKind):
            raise TypeError("browser_controller must be BrowserControllerKind")
        if agent_runtime is not None and not isinstance(agent_runtime, AgentRuntime):
            raise TypeError("agent_runtime must be AgentRuntime or None")
        if browser_controller is BrowserControllerKind.AGENT and agent_runtime is None:
            raise ValueError("Agent Browser control requires an AgentRuntime")
        if browser_controller is BrowserControllerKind.RULES and agent_runtime is not None:
            raise ValueError("Rules Browser control must not receive an AgentRuntime")
        resolver = _browser_rule_resolver(rule_catalog, web_access_profile_resolver)
        self._runner = runner
        self._route_key = route_key
        self._rule_catalog = rule_catalog
        self._web_access_profile_resolver = resolver
        self._operator_policy = access_policy or _BASELINE_WEB_POLICY
        self._cancel_event = cancel_event
        self._provenance_id_factory = provenance_id_factory
        self._clock = clock
        self._browser_controller = browser_controller
        self._agent_runtime = agent_runtime

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
    def browser_controller(self) -> BrowserControllerKind:
        """Return the controller frozen when this Source was assembled."""

        return self._browser_controller

    @property
    def browser_operation_limits(self) -> BrowserOperationLimits:
        """Expose immutable single-operation limits for assembly and tests."""

        return _BROWSER_OPERATION_LIMITS

    def execute(self, context: RouteExecutionContext) -> Iterable[RouteExecutionResult]:
        if not isinstance(context, RouteExecutionContext):
            raise TypeError("context must be RouteExecutionContext")
        return delivery_results(
            self._deliveries(context.request, context.evidence, context.candidate_keys)
        )

    def _deliveries(
        self,
        request: AcquisitionRequest,
        evidence: AcquisitionEvidence,
        candidate_keys: CandidateKeyTracker,
    ) -> Iterable[TemporaryPdf]:
        if not isinstance(request, AcquisitionRequest):
            raise TypeError("request must be an AcquisitionRequest")
        if not isinstance(evidence, AcquisitionEvidence):
            raise TypeError("evidence must be AcquisitionEvidence")
        if not isinstance(candidate_keys, CandidateKeyTracker):
            raise TypeError("candidate_keys must be a CandidateKeyTracker")
        try:
            expected_evidence = build_acquisition_evidence(request)
        except Exception:
            raise AcquisitionFailure(_contract_failure()) from None
        if evidence != expected_evidence:
            raise AcquisitionFailure(_contract_failure())
        actions = self._actions(evidence)
        return self._acquire_actions(actions, candidate_keys)

    def _actions(self, evidence: AcquisitionEvidence) -> tuple[_BrowserAction, ...]:
        doi = _canonical_doi(evidence)
        actions = list(self._landing_actions(evidence, doi))
        if doi is None:
            return tuple(actions)
        routed_rules = {(action.rule.rule_id, action.rule.revision) for action in actions}
        actions.extend(self._asset_origin_doi_actions(evidence, doi, routed_rules))
        routed_rules.update((action.rule.rule_id, action.rule.revision) for action in actions)
        resolved = self._resolved_origin_doi_action(evidence, doi, routed_rules)
        if resolved is not None:
            actions.append(resolved)
        return tuple(actions)

    def _landing_actions(
        self,
        evidence: AcquisitionEvidence,
        doi: Identifier | None,
    ) -> tuple[_BrowserAction, ...]:
        actions: list[_BrowserAction] = []
        seen: set[tuple[str, str, int]] = set()
        for observed in evidence.asset_hints:
            hint = observed.hint
            if hint.kind is not AssetHintKind.LANDING_PAGE or not _eligible_landing_role(
                hint.asset_role
            ):
                continue
            try:
                landing = normalize_url_with_configured_port(hint.url)
            except (PolicyError, TypeError, ValueError):
                continue
            rule = self._rule_catalog.match_origin(landing.origin.text)
            if rule is None:
                continue
            identity_key = (landing.url, rule.rule_id, rule.revision)
            if identity_key in seen:
                continue
            seen.add(identity_key)
            reviewed_locator = None if doi is None else rule.doi_pdf_locator(evidence.identifiers)
            actions.append(
                _BrowserAction(
                    rule=rule,
                    start_url=landing.url if reviewed_locator is None else reviewed_locator,
                    evidence_kind=(
                        "asset-hint" if reviewed_locator is None else "asset-hint-doi-template"
                    ),
                    landing_url=landing.url,
                    identifiers=evidence.identifiers,
                    identity=landing.url,
                )
            )
        return tuple(actions)

    def _asset_origin_doi_actions(
        self,
        evidence: AcquisitionEvidence,
        doi: Identifier,
        routed_rules: set[tuple[str, int]],
    ) -> tuple[_BrowserAction, ...]:
        actions: list[_BrowserAction] = []
        for observed in evidence.asset_hints:
            try:
                asset_origin = runtime_url_origin(observed.hint.url)
            except (TypeError, ValueError):
                continue
            rule = self._rule_catalog.match_origin(asset_origin)
            if rule is None or (rule.rule_id, rule.revision) in routed_rules:
                continue
            routed_rules.add((rule.rule_id, rule.revision))
            actions.append(
                _BrowserAction(
                    rule=rule,
                    start_url=_reviewed_doi_start_url(rule, doi, evidence.identifiers),
                    evidence_kind="asset-origin-doi",
                    landing_url=None,
                    identifiers=evidence.identifiers,
                    identity=f"{doi.value}\x00{asset_origin}",
                )
            )
        return tuple(actions)

    def _resolved_origin_doi_action(
        self,
        evidence: AcquisitionEvidence,
        doi: Identifier,
        routed_rules: set[tuple[str, int]],
    ) -> _BrowserAction | None:
        resolved_origin = evidence.resolved_landing_origin
        if resolved_origin is None:
            return None
        rule = self._rule_catalog.match_origin(resolved_origin)
        if rule is None or (rule.rule_id, rule.revision) in routed_rules:
            return None
        return _BrowserAction(
            rule=rule,
            start_url=_reviewed_doi_start_url(rule, doi, evidence.identifiers),
            evidence_kind="doi-resolved-origin",
            landing_url=None,
            identifiers=evidence.identifiers,
            identity=f"{doi.value}\x00{resolved_origin}",
        )

    def _acquire_actions(
        self,
        actions: tuple[_BrowserAction, ...],
        candidate_keys: CandidateKeyTracker,
    ) -> Iterator[TemporaryPdf]:
        source_started_ns = time.monotonic_ns()
        metrics = _BrowserSourceMetrics()
        source_outcome = "empty" if not actions else "miss"
        _LOGGER.debug(
            "event=browser-source-started route_key=%s action_count=%d eligible=%s disposition=%s",
            self.route_key,
            len(actions),
            str(bool(actions)).lower(),
            "eligible" if actions else "empty",
        )
        first_failure: AcquisitionSourceFailure | None = None
        try:
            for action in actions:
                action_failure = yield from self._acquire_action(
                    action,
                    candidate_keys,
                    metrics,
                )
                if metrics.delivered:
                    source_outcome = "delivered"
                if action_failure is not None:
                    if first_failure is None:
                        first_failure = action_failure
            if first_failure is not None:
                source_outcome = "failure"
                raise first_failure
        except AcquisitionFailure:
            source_outcome = "fatal"
            raise
        except GeneratorExit:
            raise
        except BaseException:
            source_outcome = "aborted"
            raise
        finally:
            if metrics.delivered and source_outcome in {"empty", "miss"}:
                source_outcome = "delivered"
            _LOGGER.debug(
                "event=browser-source-finished route_key=%s action_count=%d attempted=%d "
                "delivered=%d failed=%d outcome=%s elapsed_ms=%d",
                self.route_key,
                len(actions),
                metrics.attempted,
                metrics.delivered,
                metrics.failed,
                source_outcome,
                _elapsed_ms(source_started_ns),
            )

    def _acquire_action(
        self,
        action: _BrowserAction,
        candidate_keys: CandidateKeyTracker,
        metrics: _BrowserSourceMetrics,
    ) -> Generator[TemporaryPdf, None, AcquisitionSourceFailure | None]:
        candidate_started_ns = time.monotonic_ns()
        key = _candidate_key(action)
        if not self._claim_candidate(candidate_keys, key):
            _LOGGER.debug(
                "event=browser-candidate-skipped route_key=%s browser_rule_id=%s "
                "candidate_id=%s disposition=skipped next=next-candidate elapsed_ms=%d "
                "reason=already-tried",
                self.route_key,
                action.rule.rule_id,
                key,
                _elapsed_ms(candidate_started_ns),
            )
            return None
        metrics.attempted += 1
        _LOGGER.debug(
            "event=browser-candidate-started route_key=%s browser_rule_id=%s "
            "provider_group=%s web_scope=%s evidence_kind=%s candidate_id=%s "
            "attempted=true",
            self.route_key,
            action.rule.rule_id,
            action.rule.web_scope_provider_name,
            action.rule.web_scope_provider_name,
            action.evidence_kind,
            key,
        )
        candidate_delivered = 0
        try:
            result, page_state, page_failure, capture_guard = self._run_action(action)
            if page_failure is not None:
                raise AcquisitionSourceFailure(page_failure)
            if page_state in {
                BrowserPageState.NOT_ENTITLED,
                BrowserPageState.NOT_FOUND,
            } or _result_ends_without_pdf(result):
                self._log_candidate_finished(
                    action,
                    key=key,
                    delivered=0,
                    page_state=page_state,
                    result=result,
                    started_ns=candidate_started_ns,
                )
                return None
            captures = self._capture_deliveries(
                action,
                result,
                candidate_keys,
                landing_url=capture_guard.landing_url,
            )
            try:
                for temporary_pdf in captures:
                    candidate_delivered += 1
                    metrics.delivered += 1
                    yield temporary_pdf
            finally:
                captures.close()
            self._log_candidate_finished(
                action,
                key=key,
                delivered=candidate_delivered,
                page_state=page_state,
                result=result,
                started_ns=candidate_started_ns,
            )
            return None
        except AcquisitionSourceFailure as error:
            metrics.failed += 1
            _LOGGER.debug(
                "event=browser-candidate-failed route_key=%s browser_rule_id=%s "
                "provider_group=%s candidate_id=%s disposition=failure "
                "next=next-candidate delivered=%d elapsed_ms=%d "
                "code=%s retryable=%s reason=%s action=%s",
                self.route_key,
                action.rule.rule_id,
                action.rule.web_scope_provider_name,
                key,
                candidate_delivered,
                _elapsed_ms(candidate_started_ns),
                error.failure.code,
                str(error.failure.retryable).lower(),
                error.failure.reason,
                error.failure.action,
            )
            return error

    def _log_candidate_finished(
        self,
        action: _BrowserAction,
        *,
        key: str,
        delivered: int,
        page_state: BrowserPageState,
        result: BrowserResult,
        started_ns: int,
    ) -> None:
        result_value = (
            "capture"
            if isinstance(result, BrowserCaptureBatch)
            else result.code
            if isinstance(result, AccessFailure)
            else "invalid"
        )
        _LOGGER.debug(
            "event=browser-candidate-finished route_key=%s browser_rule_id=%s "
            "provider_group=%s candidate_id=%s disposition=%s next=%s delivered=%d "
            "page_state=%s result=%s elapsed_ms=%d",
            self.route_key,
            action.rule.rule_id,
            action.rule.web_scope_provider_name,
            key,
            "delivered" if delivered else "miss",
            "route-consumer" if delivered else "next-candidate",
            delivered,
            page_state.value,
            result_value,
            _elapsed_ms(started_ns),
        )

    def _capture_deliveries(
        self,
        action: _BrowserAction,
        result: BrowserResult,
        candidate_keys: CandidateKeyTracker,
        *,
        landing_url: str | None,
    ) -> Generator[TemporaryPdf, None, None]:
        priority = {kind: index for index, kind in enumerate(action.rule.capture_priority)}
        captures = sorted(
            self._captures_from_result(result),
            key=lambda capture: priority[capture.kind],
        )
        for capture in captures:
            disposition = self._capture_disposition(
                action,
                capture,
                landing_url=landing_url,
            )
            _LOGGER.debug(
                "event=browser-capture-classified route_key=%s browser_rule_id=%s "
                "capture_kind=%s disposition=%s",
                self.route_key,
                action.rule.rule_id,
                capture.kind.value,
                disposition.value,
            )
            if disposition in {
                BrowserCaptureDisposition.SUPPLEMENT,
                BrowserCaptureDisposition.EXCLUDED,
                BrowserCaptureDisposition.WRONG_ARTICLE,
            }:
                continue
            if disposition is not BrowserCaptureDisposition.PRIMARY:
                raise AcquisitionSourceFailure(_browser_failure("policy"))
            capture_key = _capture_candidate_key(action, capture)
            if not self._claim_candidate(candidate_keys, capture_key):
                continue
            temporary_pdf = self._temporary_from_capture(
                action,
                capture_key,
                capture,
                landing_url=landing_url,
            )
            try:
                yield temporary_pdf
            except BaseException:
                _LOGGER.debug(
                    "event=browser-resource-cleanup route_key=%s browser_rule_id=%s "
                    "candidate_id=%s resource=temporary-capture outcome=discarded",
                    self.route_key,
                    action.rule.rule_id,
                    capture_key,
                )
                temporary_pdf.content.discard()
                raise

    @staticmethod
    def _capture_disposition(
        action: _BrowserAction,
        capture: BrowserCapture,
        *,
        landing_url: str | None,
    ) -> BrowserCaptureDisposition:
        stream = capture.stream
        return action.rule.classify_capture(
            stream.final_locator,
            capture.kind,
            stream.media_type,
            landing_url=landing_url,
            identifiers=action.identifiers,
        )

    @staticmethod
    def _claim_candidate(candidate_keys: CandidateKeyTracker, key: str) -> bool:
        try:
            return candidate_keys.claim(key)
        except Exception:
            raise AcquisitionFailure(_contract_failure()) from None

    @staticmethod
    def _captures_from_result(result: BrowserResult) -> tuple[BrowserCapture, ...]:
        if isinstance(result, AccessFailure):
            if result.code == "no-download":
                return ()
            failure = _browser_failure(result.code)
            if result.code in {"cancelled", "cleanup"}:
                raise AcquisitionFailure(failure)
            raise AcquisitionSourceFailure(failure)
        if not isinstance(result, BrowserCaptureBatch):
            raise AcquisitionFailure(_contract_failure())
        return result.captures

    def _temporary_from_capture(
        self,
        action: _BrowserAction,
        key: str,
        capture: BrowserCapture,
        *,
        landing_url: str | None,
    ) -> TemporaryPdf:
        if not isinstance(capture, BrowserCapture):
            raise AcquisitionFailure(_contract_failure())
        result = capture.stream
        try:
            final_url = _normalized_url(result.final_locator)
        except AcquisitionFailure as error:
            raise AcquisitionSourceFailure(error.failure) from None
        if (
            self._capture_disposition(
                action,
                capture,
                landing_url=landing_url,
            )
            is not BrowserCaptureDisposition.PRIMARY
        ):
            # Defence in depth: a compatible runner must already have
            # rejected this locator and media type through the pre-body
            # capture guard before access.
            raise AcquisitionSourceFailure(_browser_failure("policy"))
        content = _BrowserTemporaryPdfContent(result.chunks)
        try:
            return TemporaryPdf(
                candidate=PdfCandidate(
                    candidate_key=key,
                    source_name=self.source_name,
                    acquisition_path=self.acquisition_path,
                    declared_media_type=result.media_type,
                ),
                content=content,
                safe_source_url=action.rule.safe_capture_locator(final_url.url),
                provenance=self._provenance(action.rule),
            )
        except Exception:
            content.discard()
            raise AcquisitionFailure(_contract_failure()) from None

    def _run_action(  # noqa: C901
        self,
        action: _BrowserAction,
    ) -> tuple[
        BrowserResult,
        BrowserPageState,
        StableFailure | None,
        _RuleCaptureGuard,
    ]:
        action_started_ns = time.monotonic_ns()
        facts = _BrowserAttemptFacts()
        capture_guard = _RuleCaptureGuard(action)
        destination_guard = build_browser_rule_destination_guard(
            action.rule,
            action.start_url,
            capture_guard.rebind_landing,
        )

        agent_controller: AgentBrowserController | None = None
        if self._browser_controller is BrowserControllerKind.RULES:
            flow_controller: BrowserFlowController = RuleBrowserController(
                _DeterministicRuleExecution(
                    rule=action.rule,
                    capture_guard=capture_guard,
                    facts=facts,
                )
            )
        else:
            runtime = self._agent_runtime
            if runtime is None:
                raise AcquisitionFailure(_contract_failure())
            control_factory = _PublisherAgentControlFactory(
                rule=action.rule,
                capture_guard=capture_guard,
                facts=facts,
            )
            if not isinstance(control_factory, BrowserAgentControlFactory):
                raise AcquisitionFailure(_contract_failure())
            agent_controller = AgentBrowserController(
                runtime=runtime,
                control_factory=control_factory,
                cancel_event=self._cancel_event,
            )
            flow_controller = agent_controller

        try:
            scope, effective_policy = self._access_profile(action.rule)
            result = self._runner.run(
                scope,
                BrowserRequest(
                    url=action.start_url,
                    timeout_seconds=_TIMEOUT_SECONDS,
                    max_response_bytes=_MAX_DOWNLOAD_BYTES,
                ),
                effective_policy,
                controller=flow_controller,
                destination_guard=destination_guard,
                capture_guard=capture_guard,
                navigation_only=False,
                discard_unapproved_subresources=True,
                limits=_BROWSER_OPERATION_LIMITS,
                timeout_seconds=_TIMEOUT_SECONDS,
                cancel_event=self._cancel_event,
            )
        except AcquisitionFailure:
            raise
        except Exception:
            raise AcquisitionSourceFailure(_browser_failure("runtime")) from None
        if agent_controller is not None:
            agent_result = agent_controller.result
            if agent_result is None:
                facts.fail(_contract_failure())
            else:
                self._apply_agent_result(
                    action.rule,
                    agent_result,
                    facts,
                )
        challenge_admitted_count, challenge_blocked_count = (
            destination_guard.challenge_resource_counts()
        )
        if challenge_blocked_count:
            facts.fail(_challenge_resource_blocked_failure())
            _LOGGER.debug(
                "event=browser-challenge-resource-summary browser_rule_id=%s "
                "stage=resource-blocked evidence_kind=network-guard "
                "resource_admitted=%d resource_blocked=%d",
                action.rule.rule_id,
                challenge_admitted_count,
                challenge_blocked_count,
            )
        if facts.failure is not None:
            _log_browser_terminal(
                action.rule,
                page_state=facts.page_state,
                failure=facts.failure,
                started_ns=action_started_ns,
            )
        return (
            result,
            facts.page_state,
            facts.failure,
            capture_guard,
        )

    @staticmethod
    def _apply_agent_result(  # noqa: C901
        rule: BrowserSiteRule,
        result: BrowserAgentResult,
        facts: _BrowserAttemptFacts,
    ) -> None:
        """Translate one operation-local Agent result into route semantics."""

        if not isinstance(result, BrowserAgentResult):
            raise TypeError("Browser Agent returned an invalid result")
        if result.page_state is not None:
            facts.page_state = result.page_state
        if result.disposition in {
            BrowserAgentDisposition.STOPPED,
            BrowserAgentDisposition.NO_PROGRESS,
        }:
            if result.page_state is BrowserPageState.CHALLENGE:
                facts.fail(_challenge_unresolved_failure())
        elif result.disposition in {
            BrowserAgentDisposition.CANCELLED,
            BrowserAgentDisposition.FAILED,
        }:
            facts.fail(_contract_failure() if result.failure is None else result.failure)
        elif result.disposition is BrowserAgentDisposition.PAGE_TERMINAL:
            page_state = result.page_state
            if page_state is None or page_state is BrowserPageState.NORMAL:
                facts.fail(_contract_failure())
            elif page_state is BrowserPageState.CHALLENGE:
                facts.fail(_challenge_unresolved_failure())
            elif page_state in {
                BrowserPageState.LOGIN_REQUIRED,
                BrowserPageState.MFA_REQUIRED,
                BrowserPageState.ACCESS_DENIED,
            }:
                facts.fail(_browser_page_failure(page_state))
            elif page_state is BrowserPageState.FAILED and facts.failure is None:
                facts.fail(_contract_failure())

        if facts.failure is None:
            failure_code = "none"
            reason, next_action = _agent_terminal_text(result.disposition)
        else:
            failure_code = facts.failure.code
            reason = facts.failure.reason
            next_action = facts.failure.action
        log = (
            _LOGGER.info
            if result.disposition is BrowserAgentDisposition.CAPTURE_AVAILABLE
            else _LOGGER.warning
        )
        log(
            "event=browser-agent-finished browser_rule_id=%s stage=agent "
            "agent_invoked=true outcome=%s disposition=%s action_count=%d "
            "page_state=%s capture=%s action_kind=%s failure_code=%s "
            "reason=%s action=%s",
            rule.rule_id,
            result.disposition.value,
            result.disposition.value,
            result.action_count,
            "none" if result.page_state is None else result.page_state.value,
            result.capture_state.value,
            "none" if result.last_action is None else result.last_action.kind.value,
            failure_code,
            reason,
            next_action,
        )

    @staticmethod
    def _run_rule_flow(  # noqa: C901
        session: BrowserFlowSession,
        rule: BrowserSiteRule,
        capture_guard: _RuleCaptureGuard,
        facts: _BrowserAttemptFacts,
    ) -> None:
        if not isinstance(session, BrowserFlowSession):
            raise TypeError("Browser flow session violated its structural contract")
        if ControlledBrowserPdfSource._expected_capture_available(session, rule):
            _LOGGER.debug(
                "event=browser-rule-actions-skipped browser_rule_id=%s "
                "decision_reason=initial-capture-available outcome=continue",
                rule.rule_id,
            )
            return
        classification, terminal = ControlledBrowserPdfSource._apply_page_state(
            session,
            rule,
            capture_guard,
            facts,
            checkpoint="initial",
        )
        if terminal:
            return
        if ControlledBrowserPdfSource._expected_capture_available(session, rule):
            _LOGGER.debug(
                "event=browser-rule-actions-skipped browser_rule_id=%s "
                "decision_reason=capture-already-available outcome=continue",
                rule.rule_id,
            )
            return
        if ControlledBrowserPdfSource._try_discovered_pdf_locators(session, rule):
            return
        entitlement_missing = rule.actions_require_entitlement and not classification.entitled
        if entitlement_missing:
            _LOGGER.debug(
                "event=browser-rule-actions-skipped browser_rule_id=%s "
                "decision_reason=entitlement-marker-absent outcome=normal-miss",
                rule.rule_id,
            )
        elif ControlledBrowserPdfSource._run_provider_actions(
            session,
            rule,
            capture_guard,
            facts,
        ):
            return
        _classification, terminal = ControlledBrowserPdfSource._apply_page_state(
            session,
            rule,
            capture_guard,
            facts,
            checkpoint="final",
        )
        if terminal or ControlledBrowserPdfSource._expected_capture_available(session, rule):
            return

    @staticmethod
    def _try_discovered_pdf_locators(
        session: BrowserFlowSession,
        rule: BrowserSiteRule,
    ) -> bool:
        discovered = session.discover_pdf_locators()
        if not isinstance(discovered, tuple):
            raise TypeError("Browser PDF discovery violated its structural contract")
        _LOGGER.debug(
            "event=browser-pdf-locators-discovered browser_rule_id=%s candidate_count=%d "
            "attempt_count=%d",
            rule.rule_id,
            len(discovered),
            min(len(discovered), _MAX_DISCOVERED_PDF_ATTEMPTS),
        )
        for locator in discovered[:_MAX_DISCOVERED_PDF_ATTEMPTS]:
            if type(locator) is not str:
                raise TypeError("Browser PDF discovery returned an invalid locator")
            session.open_verified_locator(locator)
            if ControlledBrowserPdfSource._expected_capture_available(session, rule):
                return True
        return False

    @staticmethod
    def _run_provider_actions(
        session: BrowserFlowSession,
        rule: BrowserSiteRule,
        capture_guard: _RuleCaptureGuard,
        facts: _BrowserAttemptFacts,
    ) -> bool:
        for action_index, action in enumerate(rule.actions, start=1):
            if not ControlledBrowserPdfSource._run_rule_action(session, action, rule):
                _LOGGER.debug(
                    "event=browser-rule-action-skipped browser_rule_action=%s "
                    "decision_reason=not-actionable outcome=normal-miss",
                    action.kind.value,
                )
                return False
            if ControlledBrowserPdfSource._expected_capture_available(session, rule):
                return True
            _classification, terminal = ControlledBrowserPdfSource._apply_page_state(
                session,
                rule,
                capture_guard,
                facts,
                checkpoint=f"post-action-{action_index}",
            )
            if terminal:
                return True
        return False

    @staticmethod
    def _expected_capture_available(
        session: BrowserFlowSession,
        rule: BrowserSiteRule,
    ) -> bool:
        return any(session.capture_available(kind) for kind in rule.capture_priority)

    @staticmethod
    def _apply_page_state(  # noqa: C901
        session: BrowserFlowSession,
        rule: BrowserSiteRule,
        capture_guard: _RuleCaptureGuard,
        facts: _BrowserAttemptFacts,
        *,
        checkpoint: str,
    ) -> tuple[_PageClassification, bool]:
        started_ns = time.monotonic_ns()
        _LOGGER.debug(
            "event=browser-page-state-check-started browser_rule_id=%s checkpoint=%s",
            rule.rule_id,
            checkpoint,
        )
        try:
            classification, observation = _classify_page(session, rule)
            capture_guard.bind_landing(observation.locator)
        except BaseException:
            _LOGGER.debug(
                "event=browser-page-state-check-finished browser_rule_id=%s "
                "checkpoint=%s outcome=failure elapsed_ms=%d",
                rule.rule_id,
                checkpoint,
                _elapsed_ms(started_ns),
            )
            raise
        _LOGGER.debug(
            "event=browser-page-state-check-finished browser_rule_id=%s "
            "checkpoint=%s outcome=classified page_state=%s authenticated=%s "
            "entitled=%s conflict=%s elapsed_ms=%d",
            rule.rule_id,
            checkpoint,
            classification.page_state.value,
            str(classification.authenticated).lower(),
            str(classification.entitled).lower(),
            str(classification.conflict).lower(),
            _elapsed_ms(started_ns),
        )
        facts.observe(classification)
        if facts.failure is not None:
            return classification, True
        if classification.page_state in {
            BrowserPageState.NOT_ENTITLED,
            BrowserPageState.NOT_FOUND,
        }:
            return classification, True
        if classification.page_state is BrowserPageState.CHALLENGE and checkpoint == "final":
            facts.fail(_challenge_unresolved_failure())
            return classification, True
        return classification, False

    @staticmethod
    def _run_rule_action(
        session: BrowserFlowSession,
        action: BrowserRuleAction,
        rule: BrowserSiteRule,
    ) -> bool:
        if not isinstance(action, BrowserRuleAction):
            raise TypeError("Browser rule action violated its closed contract")
        _LOGGER.debug(
            "event=browser-rule-action browser_rule_action=%s",
            action.kind.value,
        )
        if action.kind in {
            BrowserActionKind.WAIT_FOR_CAPTURE,
            BrowserActionKind.WAIT_FOR_ANY_CAPTURE,
        }:
            ControlledBrowserPdfSource._run_wait_action(session, action, rule)
            return True
        return ControlledBrowserPdfSource._run_navigation_action(session, action)

    @staticmethod
    def _run_navigation_action(
        session: BrowserFlowSession,
        action: BrowserRuleAction,
    ) -> bool:
        if action.kind is BrowserActionKind.CLICK:
            if action.selector is None:
                raise TypeError("click action lost its static selector")
            clicked = session.click(action.selector)
            if type(clicked) is not bool:
                raise TypeError("click action returned an invalid outcome")
            return clicked
        if action.kind is BrowserActionKind.OPEN_VIEWER:
            if action.locator is None:
                raise TypeError("viewer action lost its static locator")
            session.open_viewer(action.locator)
            return True
        if action.kind is BrowserActionKind.OPEN_VERIFIED_LOCATOR:
            if action.locator is None:
                raise TypeError("verified-locator action lost its static locator")
            session.open_verified_locator(action.locator)
            return True
        raise TypeError("unknown Browser navigation action")

    @staticmethod
    def _run_wait_action(
        session: BrowserFlowSession,
        action: BrowserRuleAction,
        rule: BrowserSiteRule,
    ) -> None:
        if action.kind is BrowserActionKind.WAIT_FOR_CAPTURE:
            if action.capture_kind is None:
                raise TypeError("wait action lost its capture kind")
            session.wait_for_capture(action.capture_kind)
            return
        if action.kind is BrowserActionKind.WAIT_FOR_ANY_CAPTURE:
            session.wait_for_any_capture(rule.capture_priority)
            return
        raise TypeError("unknown Browser wait action")

    def _access_profile(self, rule: BrowserSiteRule) -> tuple[AccessScope, AccessPolicy]:
        profile_url = _normalized_url(rule.landing_origin)
        scope, profile_policy = self._web_access_profile_resolver.resolve(profile_url)
        if scope != AccessScope(rule.web_scope_provider_name, "web"):
            raise TypeError("Browser rule web scope changed after assembly")
        return scope, AccessPolicy.strictest(
            _BASELINE_WEB_POLICY,
            profile_policy,
            self._operator_policy,
        )

    def _provenance(self, rule: BrowserSiteRule) -> Provenance:
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
        return Provenance(
            provenance_id=provenance_id,
            source_kind=SourceKind.ASSET_PROVIDER,
            source_name=self.source_name,
            source_record_id=f"{rule.rule_id}@{rule.revision}",
            observed_at=observed_at,
            input_sha256=None,
            parameters_sha256=rule.fingerprint,
        )


__all__ = (
    "BrowserFlowSession",
    "BrowserRuleDestinationGuard",
    "BrowserRunner",
    "build_browser_rule_destination_guard",
    "CONTROLLED_BROWSER_PRODUCTION_STATUS",
    "ControlledBrowserPdfSource",
)
