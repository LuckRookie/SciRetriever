"""Evidence-routed, declarative controlled-Browser PDF acquisition.

This adapter exposes only a closed structural Browser capability set to local
rules: observe a bounded query-free page snapshot, read bounded marker text,
perform a static click, open one reviewed viewer/locator, or wait for one
closed capture kind.  It never receives a page, context, process, profile,
Cookie, download object, or vendor lifecycle handle, and it never fills
login/MFA forms or attempts to solve challenges.

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
from io import BytesIO
from typing import BinaryIO, Final, Protocol, runtime_checkable
from urllib.parse import quote
from uuid import uuid4

from sciretriever.acquisition.browser_state import (
    BrowserFlowDisposition,
    BrowserRunState,
    BrowserRunStateMachine,
    BrowserStateDecision,
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
    BrowserPageMarkerKind,
    BrowserRuleAction,
    BrowserRuleCatalog,
    BrowserSiteRule,
)
from sciretriever.acquisition.sources.direct import WebAccessProfileResolver
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
    BrowserBudget,
    BrowserCaptureGuard,
    BrowserDestinationGuard,
    BrowserDestinationKind,
    BrowserFlowSession,
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
_CONSERVATIVE_BROWSER_BUDGET: Final[BrowserBudget] = BrowserBudget(
    max_navigations=2,
    max_requests=64,
    max_popups=2,
    max_downloads=4,
    max_captures=4,
    max_bytes_per_download=_MAX_DOWNLOAD_BYTES,
    max_total_bytes=_MAX_DOWNLOAD_BYTES,
    max_total_seconds=_TIMEOUT_SECONDS,
)
_KNOWN_BROWSER_FAILURES: Final[frozenset[str]] = frozenset(
    {
        "policy",
        "admission",
        "cancelled",
        "timeout",
        "budget",
        "oversize",
        "challenge",
        "cleanup",
        "runtime",
    }
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
        "budget": (
            "The controlled Browser resource budget was exceeded.",
            "Review the verified local site rule before retrying.",
            False,
        ),
        "oversize": (
            "The controlled Browser download exceeded its byte budget.",
            "Use another approved PDF source.",
            False,
        ),
        "challenge": (
            "The controlled Browser encountered an unsupported access challenge.",
            "Use another approved source or complete access outside automation.",
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


def _browser_state_failure(state: BrowserRunState) -> StableFailure:
    details: dict[BrowserRunState, tuple[str, str, str, bool]] = {
        BrowserRunState.LOGIN_REQUIRED: (
            "acquisition-browser-login-required",
            "The controlled Browser page requires an explicit login.",
            "Complete login outside automated acquisition and use an approved source.",
            False,
        ),
        BrowserRunState.MFA_REQUIRED: (
            "acquisition-browser-mfa-required",
            "The controlled Browser page requires explicit MFA.",
            "Complete MFA outside automated acquisition and use an approved source.",
            False,
        ),
        BrowserRunState.CHALLENGE_REQUIRED: (
            "acquisition-browser-challenge-required",
            "The controlled Browser encountered an unsupported access challenge.",
            "Review the provider session before retrying controlled Browser acquisition.",
            False,
        ),
        BrowserRunState.RATE_LIMITED: (
            "acquisition-browser-rate-limited",
            "The controlled Browser provider is currently rate limited.",
            "Retry after the provider risk group becomes available.",
            True,
        ),
        BrowserRunState.IP_BLOCKED: (
            "acquisition-browser-ip-blocked",
            "The controlled Browser provider reported an IP access block.",
            "Review provider access outside automation before retrying.",
            False,
        ),
        BrowserRunState.ACCOUNT_WARNING: (
            "acquisition-browser-account-warning",
            "The controlled Browser provider reported an account safety warning.",
            "Review the provider account outside automation before retrying.",
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
    compatible runner supplies an object that structurally implements
    :class:`BrowserFlowSession` only while invoking ``flow``.
    """

    def run(
        self,
        scope: AccessScope,
        request: BrowserRequest | str,
        policy: AccessPolicy,
        *,
        flow: Callable[[BrowserFlowSession], object] | None = None,
        destination_guard: BrowserDestinationGuard | None = None,
        capture_guard: BrowserCaptureGuard | None = None,
        navigation_only: bool = False,
        budget: BrowserBudget | None = None,
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
    state: BrowserRunState | None
    authenticated: bool
    entitled: bool
    conflict: bool
    matched: frozenset[BrowserPageMarkerKind]


@dataclass(slots=True)
class _BrowserSourceMetrics:
    attempted: int = 0
    delivered: int = 0
    failed: int = 0


@dataclass(frozen=True, slots=True, repr=False)
class _RuleDestinationGuard:
    """Allow only one exact resolver start plus the rule's reviewed origins."""

    rule: BrowserSiteRule
    exact_start_url: str

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
        if (
            kind
            in {
                BrowserDestinationKind.INITIAL_NAVIGATION,
                BrowserDestinationKind.NAVIGATION,
            }
            and normalized.url == self.exact_start_url
        ):
            return
        raise ValueError("Browser destination is outside the closed site rule")


@dataclass(frozen=True, slots=True, repr=False)
class _RuleCaptureGuard:
    """Capture only reviewed main-PDF locator prefixes in the current rule."""

    action: _BrowserAction

    def __post_init__(self) -> None:
        if not isinstance(self.action, _BrowserAction):
            raise TypeError("action must be a _BrowserAction")

    def allows(
        self,
        url: str,
        kind: BrowserCaptureKind,
        media_type: str,
    ) -> bool:
        action = self.action
        return (
            action.rule.classify_capture(
                url,
                kind,
                media_type,
                landing_url=action.landing_url,
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


def _state_for_browser_result(result: BrowserResult) -> BrowserRunState:
    if isinstance(result, BrowserCaptureBatch):
        return BrowserRunState.PDF_CAPTURED
    if not isinstance(result, AccessFailure):
        return BrowserRunState.RUNTIME_FAILED
    return {
        "no-download": BrowserRunState.NOT_FOUND,
        "not-found": BrowserRunState.NOT_FOUND,
        "not-entitled": BrowserRunState.NOT_ENTITLED,
        "rate-limit": BrowserRunState.RATE_LIMITED,
        "rate-limited": BrowserRunState.RATE_LIMITED,
        "ip-blocked": BrowserRunState.IP_BLOCKED,
        "challenge": BrowserRunState.CHALLENGE_REQUIRED,
    }.get(result.code, BrowserRunState.RUNTIME_FAILED)


def _state_ends_without_pdf(state_machine: BrowserRunStateMachine) -> bool:
    decision = state_machine.decision
    if decision is None or decision.continues_current_flow:
        raise AcquisitionFailure(_contract_failure())
    if decision.flow_disposition is BrowserFlowDisposition.NORMAL_MISS:
        return True
    if decision.flow_disposition in {
        BrowserFlowDisposition.DEFERRED,
        BrowserFlowDisposition.ACTION_REQUIRED,
    }:
        raise AcquisitionSourceFailure(_browser_state_failure(decision.state))
    return False


def _browser_state_value(state_machine: BrowserRunStateMachine) -> str:
    state = state_machine.state
    return "none" if state is None else state.value


def _transition_browser_state(
    state_machine: BrowserRunStateMachine,
    state: BrowserRunState,
    *,
    rule_id: str,
) -> BrowserStateDecision:
    previous = state_machine.state
    decision = state_machine.transition(state)
    if previous is not state:
        _LOGGER.debug(
            "event=browser-state-transition route_key=browser:controlled "
            "browser_rule_id=%s previous_state=%s state=%s disposition=%s group_effect=%s",
            rule_id,
            "none" if previous is None else previous.value,
            state.value,
            decision.flow_disposition.value,
            decision.group_effect.value,
        )
    return decision


_TERMINAL_PAGE_STATES: Final[dict[BrowserPageMarkerKind, BrowserRunState]] = {
    BrowserPageMarkerKind.LOGIN_REQUIRED: BrowserRunState.LOGIN_REQUIRED,
    BrowserPageMarkerKind.MFA_REQUIRED: BrowserRunState.MFA_REQUIRED,
    BrowserPageMarkerKind.NOT_ENTITLED: BrowserRunState.NOT_ENTITLED,
    BrowserPageMarkerKind.PAYWALL: BrowserRunState.NOT_ENTITLED,
    BrowserPageMarkerKind.CHALLENGE_REQUIRED: BrowserRunState.CHALLENGE_REQUIRED,
    BrowserPageMarkerKind.RATE_LIMITED: BrowserRunState.RATE_LIMITED,
    BrowserPageMarkerKind.IP_BLOCKED: BrowserRunState.IP_BLOCKED,
    BrowserPageMarkerKind.ACCOUNT_WARNING: BrowserRunState.ACCOUNT_WARNING,
    BrowserPageMarkerKind.NOT_FOUND: BrowserRunState.NOT_FOUND,
}


def _classify_page(
    session: BrowserFlowSession,
    rule: BrowserSiteRule,
) -> _PageClassification:
    observation_started_ns = time.monotonic_ns()
    _LOGGER.debug(
        "event=browser-page-observation-started browser_rule_id=%s",
        rule.rule_id,
    )
    observation = session.observe()
    _LOGGER.debug(
        "event=browser-page-observation-finished browser_rule_id=%s "
        "outcome=observed status_code=%s elapsed_ms=%d",
        rule.rule_id,
        "missing" if observation.status_code is None else observation.status_code,
        _elapsed_ms(observation_started_ns),
    )
    matched: set[BrowserPageMarkerKind] = set()
    for marker in rule.page_markers:
        marker_started_ns = time.monotonic_ns()
        _LOGGER.debug(
            "event=browser-page-marker-check-started browser_rule_id=%s "
            "marker_id=%s selector_count=%d",
            rule.rule_id,
            marker.marker_id,
            len(marker.css_selectors),
        )
        selector_match = any(session.has_selector(selector) for selector in marker.css_selectors)
        marker_match = selector_match or marker.matches_observation(observation)
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

    authenticated = BrowserPageMarkerKind.AUTHENTICATED in matched
    entitled = BrowserPageMarkerKind.ENTITLED in matched
    terminal_states = {state for kind, state in _TERMINAL_PAGE_STATES.items() if kind in matched}
    login_conflict = authenticated and bool(
        matched
        & {
            BrowserPageMarkerKind.LOGIN_REQUIRED,
            BrowserPageMarkerKind.MFA_REQUIRED,
        }
    )
    entitlement_conflict = entitled and BrowserRunState.NOT_ENTITLED in terminal_states
    conflict = len(terminal_states) > 1 or login_conflict or entitlement_conflict
    state = None if not terminal_states else next(iter(terminal_states))
    if conflict:
        state = BrowserRunState.RUNTIME_FAILED
    elif state is None and authenticated:
        state = BrowserRunState.AUTHENTICATED
    return _PageClassification(
        state=state,
        authenticated=authenticated,
        entitled=entitled,
        conflict=conflict,
        matched=frozenset(matched),
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
    )

    def __init__(
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
        resolver = _browser_rule_resolver(rule_catalog, web_access_profile_resolver)
        self._runner = runner
        self._route_key = route_key
        self._rule_catalog = rule_catalog
        self._web_access_profile_resolver = resolver
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
    def browser_budget(self) -> BrowserBudget:
        """Expose the immutable conservative budget for assembly/tests."""

        return _CONSERVATIVE_BROWSER_BUDGET

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
            result, state_machine, page_failure = self._run_action(action)
            if page_failure is not None:
                raise AcquisitionSourceFailure(page_failure)
            if _state_ends_without_pdf(state_machine):
                self._log_candidate_finished(
                    action,
                    key=key,
                    delivered=0,
                    state_machine=state_machine,
                    started_ns=candidate_started_ns,
                )
                return None
            captures = self._capture_deliveries(action, result, candidate_keys)
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
                state_machine=state_machine,
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
        state_machine: BrowserRunStateMachine,
        started_ns: int,
    ) -> None:
        _LOGGER.debug(
            "event=browser-candidate-finished route_key=%s browser_rule_id=%s "
            "provider_group=%s candidate_id=%s disposition=%s next=%s delivered=%d "
            "state=%s elapsed_ms=%d",
            self.route_key,
            action.rule.rule_id,
            action.rule.web_scope_provider_name,
            key,
            "delivered" if delivered else "miss",
            "route-consumer" if delivered else "next-candidate",
            delivered,
            _browser_state_value(state_machine),
            _elapsed_ms(started_ns),
        )

    def _capture_deliveries(
        self,
        action: _BrowserAction,
        result: BrowserResult,
        candidate_keys: CandidateKeyTracker,
    ) -> Generator[TemporaryPdf, None, None]:
        priority = {kind: index for index, kind in enumerate(action.rule.capture_priority)}
        captures = sorted(
            self._captures_from_result(result),
            key=lambda capture: priority[capture.kind],
        )
        for capture in captures:
            disposition = self._capture_disposition(action, capture)
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
    ) -> BrowserCaptureDisposition:
        stream = capture.stream
        return action.rule.classify_capture(
            stream.final_locator,
            capture.kind,
            stream.media_type,
            landing_url=action.landing_url,
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
    ) -> TemporaryPdf:
        if not isinstance(capture, BrowserCapture):
            raise AcquisitionFailure(_contract_failure())
        result = capture.stream
        try:
            final_url = _normalized_url(result.final_locator)
        except AcquisitionFailure as error:
            raise AcquisitionSourceFailure(error.failure) from None
        if self._capture_disposition(action, capture) is not BrowserCaptureDisposition.PRIMARY:
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
                safe_source_url=final_url.url,
                provenance=self._provenance(action.rule),
            )
        except Exception:
            content.discard()
            raise AcquisitionFailure(_contract_failure()) from None

    def _run_action(
        self,
        action: _BrowserAction,
    ) -> tuple[BrowserResult, BrowserRunStateMachine, StableFailure | None]:
        state_machine = BrowserRunStateMachine()
        _transition_browser_state(
            state_machine,
            BrowserRunState.OPEN,
            rule_id=action.rule.rule_id,
        )
        page_failure: list[StableFailure] = []

        def flow(session: BrowserFlowSession) -> None:
            self._run_rule_flow(session, action.rule, state_machine, page_failure)

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
                flow=flow,
                destination_guard=_RuleDestinationGuard(action.rule, action.start_url),
                capture_guard=_RuleCaptureGuard(action),
                navigation_only=True,
                budget=_CONSERVATIVE_BROWSER_BUDGET,
                timeout_seconds=_TIMEOUT_SECONDS,
                cancel_event=self._cancel_event,
            )
        except AcquisitionFailure:
            raise
        except Exception:
            _transition_browser_state(
                state_machine,
                BrowserRunState.RUNTIME_FAILED,
                rule_id=action.rule.rule_id,
            )
            raise AcquisitionSourceFailure(_browser_failure("runtime")) from None
        result_state = _state_for_browser_result(result)
        decision = state_machine.decision
        if (
            decision is None
            or decision.continues_current_flow
            or result_state is BrowserRunState.RUNTIME_FAILED
        ):
            _transition_browser_state(
                state_machine,
                result_state,
                rule_id=action.rule.rule_id,
            )
        return result, state_machine, page_failure[0] if page_failure else None

    @staticmethod
    def _run_rule_flow(
        session: BrowserFlowSession,
        rule: BrowserSiteRule,
        state_machine: BrowserRunStateMachine,
        page_failure: list[StableFailure],
    ) -> None:
        if not isinstance(session, BrowserFlowSession):
            raise TypeError("Browser flow session violated its structural contract")
        classification, terminal = ControlledBrowserPdfSource._apply_page_state(
            session,
            rule,
            state_machine,
            page_failure,
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
        if rule.actions_require_entitlement and not classification.entitled:
            _LOGGER.debug(
                "event=browser-rule-actions-skipped browser_rule_id=%s "
                "decision_reason=entitlement-marker-absent outcome=normal-miss",
                rule.rule_id,
            )
            return
        for action_index, action in enumerate(rule.actions, start=1):
            ControlledBrowserPdfSource._run_rule_action(session, action)
            if ControlledBrowserPdfSource._expected_capture_available(session, rule):
                return
            _classification, terminal = ControlledBrowserPdfSource._apply_page_state(
                session,
                rule,
                state_machine,
                page_failure,
                checkpoint=f"post-action-{action_index}",
            )
            if terminal:
                return

    @staticmethod
    def _expected_capture_available(
        session: BrowserFlowSession,
        rule: BrowserSiteRule,
    ) -> bool:
        return any(
            action.capture_kind is not None and session.capture_available(action.capture_kind)
            for action in rule.actions
        )

    @staticmethod
    def _apply_page_state(
        session: BrowserFlowSession,
        rule: BrowserSiteRule,
        state_machine: BrowserRunStateMachine,
        page_failure: list[StableFailure],
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
            classification = _classify_page(session, rule)
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
            "none" if classification.state is None else classification.state.value,
            str(classification.authenticated).lower(),
            str(classification.entitled).lower(),
            str(classification.conflict).lower(),
            _elapsed_ms(started_ns),
        )
        if classification.conflict and not page_failure:
            page_failure.append(_page_state_conflict_failure())
        if classification.state is None:
            return classification, False
        decision = _transition_browser_state(
            state_machine,
            classification.state,
            rule_id=rule.rule_id,
        )
        return classification, decision.is_terminal

    @staticmethod
    def _run_rule_action(
        session: BrowserFlowSession,
        action: BrowserRuleAction,
    ) -> None:
        if not isinstance(action, BrowserRuleAction):
            raise TypeError("Browser rule action violated its closed contract")
        _LOGGER.debug(
            "event=browser-rule-action browser_rule_action=%s",
            action.kind.value,
        )
        if action.kind is BrowserActionKind.CLICK:
            if action.selector is None:
                raise TypeError("click action lost its static selector")
            session.click(action.selector)
            return
        if action.kind is BrowserActionKind.OPEN_VIEWER:
            if action.locator is None:
                raise TypeError("viewer action lost its static locator")
            session.open_viewer(action.locator)
            return
        if action.kind is BrowserActionKind.OPEN_VERIFIED_LOCATOR:
            if action.locator is None:
                raise TypeError("verified-locator action lost its static locator")
            session.open_verified_locator(action.locator)
            return
        if action.kind is BrowserActionKind.WAIT_FOR_CAPTURE:
            if action.capture_kind is None:
                raise TypeError("wait action lost its capture kind")
            session.wait_for_capture(action.capture_kind)
            return
        raise TypeError("unknown Browser rule action")

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
    "BrowserRunner",
    "CONTROLLED_BROWSER_PRODUCTION_STATUS",
    "ControlledBrowserPdfSource",
)
