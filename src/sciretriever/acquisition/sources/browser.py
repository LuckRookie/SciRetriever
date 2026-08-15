"""Evidence-routed, declarative controlled-Browser PDF acquisition.

This adapter exposes only two structural Browser capabilities to local rules:
read bounded marker text and perform one explicit click.  It never receives a
page, context, process, profile, Cookie, download object, or vendor lifecycle
handle, and it never fills login/MFA forms or attempts to solve challenges.

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
    BrowserRuleAction,
    BrowserRuleCatalog,
    BrowserSiteRule,
)
from sciretriever.acquisition.sources.direct import WebAccessProfileResolver
from sciretriever.model.access import (
    AccessFailure,
    BoundedByteStream,
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
    BrowserDestinationGuard,
    BrowserDestinationKind,
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
    max_popups=1,
    max_downloads=1,
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
class BrowserFlowSession(Protocol):
    """The complete Source-visible Browser capability surface."""

    def click(self, selector: str) -> None: ...

    def text(self, selector: str) -> str: ...


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


def _eligible_landing_role(role: AssetRole | None) -> bool:
    return role is None or role is AssetRole.PRIMARY_PDF


def _state_for_browser_result(result: BrowserResult) -> BrowserRunState:
    if isinstance(result, BoundedByteStream):
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
                result, state_machine = self._run_action(action)
                if _state_ends_without_pdf(state_machine):
                    continue
                temporary_pdf = self._temporary_from_result(action, key, result)
                if temporary_pdf is None:
                    continue
                try:
                    yield temporary_pdf
                except BaseException:
                    temporary_pdf.content.discard()
                    raise
            except AcquisitionSourceFailure as error:
                if first_failure is None:
                    first_failure = error
                continue
        if first_failure is not None:
            raise first_failure

    @staticmethod
    def _claim_candidate(candidate_keys: CandidateKeyTracker, key: str) -> bool:
        try:
            return candidate_keys.claim(key)
        except Exception:
            raise AcquisitionFailure(_contract_failure()) from None

    def _temporary_from_result(
        self,
        action: _BrowserAction,
        key: str,
        result: BrowserResult,
    ) -> TemporaryPdf | None:
        if isinstance(result, AccessFailure):
            if result.code == "no-download":
                return None
            failure = _browser_failure(result.code)
            if result.code in {"cancelled", "cleanup"}:
                raise AcquisitionFailure(failure)
            raise AcquisitionSourceFailure(failure)
        if not isinstance(result, BoundedByteStream):
            raise AcquisitionFailure(_contract_failure())
        try:
            final_url = _normalized_url(result.final_locator)
        except AcquisitionFailure as error:
            raise AcquisitionSourceFailure(error.failure) from None
        if not action.rule.allows_url(final_url.url):
            # Defence in depth: a compatible runner must already have
            # rejected this locator through the per-hop guard before access.
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
    ) -> tuple[BrowserResult, BrowserRunStateMachine]:
        state_machine = BrowserRunStateMachine()
        state_machine.transition(BrowserRunState.OPEN)

        def flow(session: BrowserFlowSession) -> None:
            self._run_rule_flow(session, action.rule, state_machine)

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
        return result, state_machine

    @staticmethod
    def _run_rule_flow(
        session: BrowserFlowSession,
        rule: BrowserSiteRule,
        state_machine: BrowserRunStateMachine,
    ) -> None:
        if not isinstance(session, BrowserFlowSession):
            raise TypeError("Browser flow session violated its structural contract")
        for state, selectors in (
            (BrowserRunState.MFA_REQUIRED, rule.mfa_markers),
            (BrowserRunState.LOGIN_REQUIRED, rule.login_markers),
        ):
            if any(session.text(selector).strip() for selector in selectors):
                state_machine.transition(state)
                return
        if rule.action is BrowserRuleAction.EXPLICIT_CLICK:
            selector = rule.click_selector
            if selector is None:
                raise TypeError("explicit-click rule lost its selector")
            session.click(selector)

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
