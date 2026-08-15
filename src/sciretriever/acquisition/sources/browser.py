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
readiness remains disabled until provider rules, sessions and end-to-end
fixtures are verified.
"""

from __future__ import annotations

import hashlib
import threading
from collections.abc import Callable, Iterable, Iterator
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
)
from sciretriever.acquisition.outcomes import RouteExecutionResult
from sciretriever.acquisition.planning import RouteReadiness
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
    BrowserPageMarkerKind,
    BrowserRuleAction,
    BrowserRuleCatalog,
    BrowserSiteRule,
)
from sciretriever.acquisition.sources.direct import WebAccessProfileResolver
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

ProvenanceIdFactory = Callable[[], ProvenanceId]
Clock = Callable[[], UtcTimestamp]


def _new_provenance_id() -> ProvenanceId:
    return ProvenanceId(str(uuid4()))


def _utc_now() -> UtcTimestamp:
    value = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    return UtcTimestamp(value)


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
CONTROLLED_BROWSER_PRODUCTION_STATUS: Final[RouteInstallationStatus] = RouteInstallationStatus(
    readiness=RouteReadiness.UNSUPPORTED,
    failure=_PRODUCTION_FAILURE,
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
        budget: BrowserBudget | None = None,
        timeout_seconds: float | None = None,
        cancel_event: threading.Event | None = None,
    ) -> BrowserResult: ...


@dataclass(frozen=True, slots=True, repr=False)
class _BrowserAction:
    rule: BrowserSiteRule
    start_url: str
    evidence_kind: str
    identity: str = field(repr=False)


@dataclass(frozen=True, slots=True)
class _PageClassification:
    state: BrowserRunState | None
    authenticated: bool
    entitled: bool
    conflict: bool


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

    rule: BrowserSiteRule

    def __post_init__(self) -> None:
        if not isinstance(self.rule, BrowserSiteRule):
            raise TypeError("rule must be a BrowserSiteRule")

    def allows(
        self,
        url: str,
        kind: BrowserCaptureKind,
        media_type: str,
    ) -> bool:
        return self.rule.allows_capture(url, kind, media_type)


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
    return next(
        (identifier for identifier in evidence.identifiers if identifier.namespace == "doi"),
        None,
    )


def _doi_resolver_url(doi: Identifier) -> str:
    encoded = quote(doi.value, safe="/")
    return _normalized_url(f"{_DOI_RESOLVER_ORIGIN}/{encoded}").url


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


_TERMINAL_PAGE_STATES: Final[dict[BrowserPageMarkerKind, BrowserRunState]] = {
    BrowserPageMarkerKind.LOGIN_REQUIRED: BrowserRunState.LOGIN_REQUIRED,
    BrowserPageMarkerKind.MFA_REQUIRED: BrowserRunState.MFA_REQUIRED,
    BrowserPageMarkerKind.NOT_ENTITLED: BrowserRunState.NOT_ENTITLED,
    BrowserPageMarkerKind.PAYWALL: BrowserRunState.NOT_ENTITLED,
    BrowserPageMarkerKind.CHALLENGE_REQUIRED: BrowserRunState.CHALLENGE_REQUIRED,
    BrowserPageMarkerKind.RATE_LIMITED: BrowserRunState.RATE_LIMITED,
    BrowserPageMarkerKind.IP_BLOCKED: BrowserRunState.IP_BLOCKED,
    BrowserPageMarkerKind.NOT_FOUND: BrowserRunState.NOT_FOUND,
}


def _classify_page(
    session: BrowserFlowSession,
    rule: BrowserSiteRule,
) -> _PageClassification:
    observation = session.observe()
    matched: set[BrowserPageMarkerKind] = set()
    for marker in rule.page_markers:
        selector_match = any(session.text(selector).strip() for selector in marker.css_selectors)
        if selector_match or marker.matches_observation(observation):
            matched.add(marker.kind)

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
    )


class ControlledBrowserPdfSource:
    """Controlled-Browser Source driven only by strong, local routing evidence."""

    __slots__ = (
        "_runner",
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
        rule_catalog: BrowserRuleCatalog = PRODUCTION_BROWSER_RULE_CATALOG,
        web_access_profile_resolver: WebAccessProfileResolver | None = None,
        access_policy: AccessPolicy | None = None,
        cancel_event: threading.Event | None = None,
        provenance_id_factory: ProvenanceIdFactory = _new_provenance_id,
        clock: Clock = _utc_now,
    ) -> None:
        if not isinstance(runner, BrowserRunner):
            raise TypeError("runner must implement BrowserRunner")
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
        resolver = (
            WebAccessProfileResolver()
            if web_access_profile_resolver is None
            else web_access_profile_resolver
        )
        for rule in rule_catalog.rules:
            scope, _policy = resolver.resolve(_normalized_url(rule.landing_origin))
            if scope != AccessScope(rule.web_scope_provider_name, "web"):
                raise ValueError("Browser rule web scope does not match the shared host profile")
        self._runner = runner
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
        return "browser:controlled"

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
        return self._acquire_actions(self._actions(evidence), candidate_keys)

    def _actions(self, evidence: AcquisitionEvidence) -> tuple[_BrowserAction, ...]:
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
            actions.append(
                _BrowserAction(
                    rule=rule,
                    start_url=landing.url,
                    evidence_kind="asset-hint",
                    identity=landing.url,
                )
            )

        doi = _canonical_doi(evidence)
        resolved_origin = evidence.resolved_landing_origin
        if doi is not None and resolved_origin is not None:
            rule = self._rule_catalog.match_origin(resolved_origin)
            rule_already_routed = rule is not None and any(
                action.rule.rule_id == rule.rule_id and action.rule.revision == rule.revision
                for action in actions
            )
            if rule is not None and not rule_already_routed:
                start_url = _doi_resolver_url(doi)
                identity_key = (start_url, rule.rule_id, rule.revision)
                if identity_key not in seen:
                    actions.append(
                        _BrowserAction(
                            rule=rule,
                            start_url=start_url,
                            evidence_kind="doi-resolved-origin",
                            identity=f"{doi.value}\x00{resolved_origin}",
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
            try:
                key = _candidate_key(action)
                if not self._claim_candidate(candidate_keys, key):
                    continue
                result, state_machine, page_failure = self._run_action(action)
                if page_failure is not None:
                    raise AcquisitionSourceFailure(page_failure)
                if _state_ends_without_pdf(state_machine):
                    continue
                yield from self._capture_deliveries(action, result, candidate_keys)
            except AcquisitionSourceFailure as error:
                if first_failure is None:
                    first_failure = error
                continue
        if first_failure is not None:
            raise first_failure

    def _capture_deliveries(
        self,
        action: _BrowserAction,
        result: BrowserResult,
        candidate_keys: CandidateKeyTracker,
    ) -> Iterator[TemporaryPdf]:
        for capture in self._captures_from_result(result):
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
                temporary_pdf.content.discard()
                raise

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
        if not action.rule.allows_capture(
            final_url.url,
            capture.kind,
            result.media_type,
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
        state_machine.transition(BrowserRunState.OPEN)
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
                capture_guard=_RuleCaptureGuard(action.rule),
                budget=_CONSERVATIVE_BROWSER_BUDGET,
                timeout_seconds=_TIMEOUT_SECONDS,
                cancel_event=self._cancel_event,
            )
        except AcquisitionFailure:
            raise
        except Exception:
            state_machine.transition(BrowserRunState.RUNTIME_FAILED)
            raise AcquisitionSourceFailure(_browser_failure("runtime")) from None
        result_state = _state_for_browser_result(result)
        decision = state_machine.decision
        if (
            decision is None
            or decision.continues_current_flow
            or result_state is BrowserRunState.RUNTIME_FAILED
        ):
            state_machine.transition(result_state)
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
        if ControlledBrowserPdfSource._apply_page_state(
            session,
            rule,
            state_machine,
            page_failure,
        ):
            return
        for action in rule.actions:
            ControlledBrowserPdfSource._run_rule_action(session, action)
            if ControlledBrowserPdfSource._apply_page_state(
                session,
                rule,
                state_machine,
                page_failure,
            ):
                return

    @staticmethod
    def _apply_page_state(
        session: BrowserFlowSession,
        rule: BrowserSiteRule,
        state_machine: BrowserRunStateMachine,
        page_failure: list[StableFailure],
    ) -> bool:
        classification = _classify_page(session, rule)
        if classification.conflict and not page_failure:
            page_failure.append(_page_state_conflict_failure())
        if classification.state is None:
            return False
        return state_machine.transition(classification.state).is_terminal

    @staticmethod
    def _run_rule_action(
        session: BrowserFlowSession,
        action: BrowserRuleAction,
    ) -> None:
        if not isinstance(action, BrowserRuleAction):
            raise TypeError("Browser rule action violated its closed contract")
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
