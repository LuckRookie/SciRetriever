"""Operator-injected neutral locators for configured ``sci-hub`` acquisition.

This module deliberately owns no remote protocol.  An injected resolver sees
only the target's accepted immutable identifiers and returns a finite tuple of
neutral HTTPS locators.  Every locator is validated locally, then handed to
A5's public locator boundary for the actual URL, DNS, redirect, admission, and
byte work.
"""

from __future__ import annotations

import hashlib
import ipaddress
import threading
from collections.abc import Iterable, Iterator
from typing import Final, Protocol

from sciretriever.acquisition.ports import (
    AcquisitionFailure,
    AcquisitionSourceFailure,
    CandidateKeyTracker,
    SourceReadiness,
    TemporaryPdf,
)
from sciretriever.acquisition.routing import (
    AcquisitionEvidence,
    AcquisitionRequest,
    build_acquisition_evidence,
)
from sciretriever.model.acquisition import AcquisitionPath, PdfCandidate
from sciretriever.model.literature import Identifier
from sciretriever.model.primitives import SourceKind
from sciretriever.model.report import StableFailure
from sciretriever.network.policy import (
    AddressClass,
    NormalizedURL,
    PolicyError,
    classify_address,
    normalize_url,
)

_SOURCE_NAME: Final[str] = "sci-hub"
_RESOLVER_KEY_DOMAIN: Final[bytes] = b"sciretriever/configured-sci-hub/resolver/v1"
_LOCATOR_KEY_DOMAIN: Final[bytes] = b"sciretriever/configured-sci-hub/locator/v1"


class ConfiguredLocatorResolver(Protocol):
    """Private composition seam that emits only neutral locator strings."""

    def resolve(
        self,
        identifiers: tuple[Identifier, ...],
        *,
        cancel_event: threading.Event | None = None,
    ) -> tuple[str, ...]: ...


class PublicLocatorFetcher(Protocol):
    """The package-internal A5 handoff used for every configured locator."""

    def acquire(
        self,
        *,
        locator: str,
        candidate_key: str,
        source_name: str,
        source_record_id: str | None,
        declared_media_type: str | None,
        candidate_keys: CandidateKeyTracker,
        allow_static_landing_discovery: bool,
    ) -> Iterable[TemporaryPdf]: ...


class _Sha256Digest(Protocol):
    def update(self, data: bytes, /) -> None: ...


def configured_sci_hub_readiness(
    resolver: ConfiguredLocatorResolver | None,
) -> SourceReadiness:
    """Return the local resolver readiness used later by Acquisition assembly."""

    if resolver is None:
        return SourceReadiness(is_ready=False, failure=_missing_resolver_failure())
    if not _has_callable_method(resolver, "resolve"):
        raise TypeError("resolver must expose resolve() or be None")
    return SourceReadiness(is_ready=True)


class ConfiguredSciHubPdfSource:
    """PUBLIC Source over one explicitly injected, operator-approved resolver."""

    source_name = _SOURCE_NAME
    acquisition_path = AcquisitionPath.PUBLIC

    def __init__(
        self,
        *,
        resolver: ConfiguredLocatorResolver | None,
        locator_fetcher: PublicLocatorFetcher,
        cancel_event: threading.Event | None = None,
    ) -> None:
        configured_sci_hub_readiness(resolver)
        if not _has_callable_method(locator_fetcher, "acquire"):
            raise TypeError("locator_fetcher must expose acquire()")
        if cancel_event is not None and not isinstance(cancel_event, threading.Event):
            raise TypeError("cancel_event must be a threading.Event or None")
        self._resolver = resolver
        self._locator_fetcher = locator_fetcher
        self._cancel_event = cancel_event

    @property
    def readiness(self) -> SourceReadiness:
        """Expose the same secret-free local decision consumed by A10 assembly."""

        return configured_sci_hub_readiness(self._resolver)

    def is_applicable(self, evidence: AcquisitionEvidence) -> bool:
        if not isinstance(evidence, AcquisitionEvidence):
            raise TypeError("evidence must be AcquisitionEvidence")
        return bool(evidence.identifiers)

    def acquire(
        self,
        request: AcquisitionRequest,
        evidence: AcquisitionEvidence,
        candidate_keys: CandidateKeyTracker,
    ) -> Iterator[TemporaryPdf]:
        _validate_acquire_inputs(request, evidence, candidate_keys)
        _raise_if_cancelled(self._cancel_event)

        identifiers = evidence.identifiers
        if not identifiers:
            return
        resolver = self._resolver
        if resolver is None:
            raise AcquisitionFailure(_missing_resolver_failure())

        resolver_key = _resolver_candidate_key(identifiers)
        if not _claim(candidate_keys, resolver_key):
            return

        raw_locators = _call_resolver(
            resolver,
            identifiers,
            cancel_event=self._cancel_event,
        )
        _raise_if_cancelled(self._cancel_event)
        locators, first_failure = _validated_unique_locators(raw_locators)
        _raise_if_cancelled(self._cancel_event)

        for locator in locators:
            _raise_if_cancelled(self._cancel_event)
            try:
                deliveries = self._locator_fetcher.acquire(
                    locator=locator.url,
                    candidate_key=_locator_candidate_key(locator),
                    source_name=self.source_name,
                    source_record_id=None,
                    declared_media_type=None,
                    candidate_keys=candidate_keys,
                    allow_static_landing_discovery=True,
                )
                yield from _repackage_and_close(
                    deliveries,
                    candidate_keys=candidate_keys,
                    cancel_event=self._cancel_event,
                )
            except AcquisitionSourceFailure as error:
                if first_failure is None:
                    first_failure = error
            except AcquisitionFailure:
                raise
            except Exception:
                raise AcquisitionSourceFailure(_fetcher_failure()) from None
        if first_failure is not None:
            raise first_failure


def _has_callable_method(value: object, name: str) -> bool:
    try:
        method = getattr(value, name, None)
    except Exception:
        return False
    return callable(method)


def _validate_acquire_inputs(
    request: AcquisitionRequest,
    evidence: AcquisitionEvidence,
    candidate_keys: CandidateKeyTracker,
) -> None:
    if not isinstance(request, AcquisitionRequest):
        raise TypeError("request must be AcquisitionRequest")
    if not isinstance(evidence, AcquisitionEvidence):
        raise TypeError("evidence must be AcquisitionEvidence")
    if not isinstance(candidate_keys, CandidateKeyTracker):
        raise TypeError("candidate_keys must be CandidateKeyTracker")
    try:
        expected_evidence = build_acquisition_evidence(request)
    except Exception:
        raise AcquisitionFailure(_evidence_failure()) from None
    if evidence != expected_evidence:
        raise AcquisitionFailure(_evidence_failure())


def _resolver_candidate_key(identifiers: tuple[Identifier, ...]) -> str:
    try:
        digest = hashlib.sha256(_RESOLVER_KEY_DOMAIN)
        for identifier in identifiers:
            _add_digest_part(digest, identifier.namespace)
            _add_digest_part(digest, identifier.value)
        return f"sci-hub-resolver:{digest.hexdigest()}"
    except Exception:
        raise AcquisitionFailure(_contract_failure()) from None


def _locator_candidate_key(locator: NormalizedURL) -> str:
    try:
        digest = hashlib.sha256(_LOCATOR_KEY_DOMAIN)
        _add_digest_part(digest, locator.url)
        return f"sci-hub-locator:{digest.hexdigest()}"
    except Exception:
        raise AcquisitionFailure(_contract_failure()) from None


def _add_digest_part(digest: _Sha256Digest, value: str) -> None:
    payload = value.encode("utf-8", "strict")
    digest.update(len(payload).to_bytes(8, "big"))
    digest.update(payload)


def _claim(candidate_keys: CandidateKeyTracker, candidate_key: str) -> bool:
    try:
        return candidate_keys.claim(candidate_key)
    except Exception:
        raise AcquisitionFailure(_contract_failure()) from None


def _call_resolver(
    resolver: ConfiguredLocatorResolver,
    identifiers: tuple[Identifier, ...],
    *,
    cancel_event: threading.Event | None,
) -> object:
    try:
        return resolver.resolve(identifiers, cancel_event=cancel_event)
    except Exception:
        if cancel_event is not None and cancel_event.is_set():
            raise AcquisitionFailure(_cancelled_failure()) from None
        raise AcquisitionSourceFailure(_resolver_failure()) from None


def _validated_unique_locators(
    value: object,
) -> tuple[tuple[NormalizedURL, ...], AcquisitionSourceFailure | None]:
    if type(value) is not tuple:
        raise AcquisitionSourceFailure(_resolver_contract_failure())
    result: list[NormalizedURL] = []
    seen: set[str] = set()
    first_failure: AcquisitionSourceFailure | None = None
    for raw_locator in value:
        try:
            locator = _validated_locator(raw_locator)
        except AcquisitionSourceFailure as error:
            if first_failure is None:
                first_failure = error
            continue
        if locator.url in seen:
            continue
        seen.add(locator.url)
        result.append(locator)
    return tuple(result), first_failure


def _validated_locator(value: object) -> NormalizedURL:
    if type(value) is not str:
        raise AcquisitionSourceFailure(_locator_failure())
    try:
        locator = normalize_url(value, allowed_schemes=("https",))
    except (PolicyError, TypeError, ValueError):
        raise AcquisitionSourceFailure(_locator_failure()) from None

    try:
        literal = ipaddress.ip_address(locator.hostname)
    except ValueError:
        return locator
    try:
        address_class = classify_address(literal)
    except (PolicyError, TypeError, ValueError):
        raise AcquisitionSourceFailure(_locator_failure()) from None
    if address_class is not AddressClass.PUBLIC:
        raise AcquisitionSourceFailure(_locator_failure())
    return locator


def _repackage_and_close(
    deliveries: Iterable[TemporaryPdf],
    *,
    candidate_keys: CandidateKeyTracker,
    cancel_event: threading.Event | None,
) -> Iterator[TemporaryPdf]:
    try:
        iterator = iter(deliveries)
    except Exception:
        raise AcquisitionFailure(_fetcher_contract_failure()) from None
    try:
        while True:
            _raise_if_cancelled(cancel_event)
            try:
                delivery = next(iterator)
            except StopIteration:
                return
            except AcquisitionFailure:
                raise
            except Exception:
                raise AcquisitionSourceFailure(_fetcher_failure()) from None

            if not isinstance(delivery, TemporaryPdf):
                raise AcquisitionFailure(_fetcher_contract_failure())
            if cancel_event is not None and cancel_event.is_set():
                _discard(delivery)
                raise AcquisitionFailure(_cancelled_failure())
            repackaged = _repackage(delivery, candidate_keys=candidate_keys)
            try:
                yield repackaged
            except BaseException:
                _discard(repackaged)
                raise
    finally:
        _close_iterator(iterator)


def _repackage(
    delivery: TemporaryPdf,
    *,
    candidate_keys: CandidateKeyTracker,
) -> TemporaryPdf:
    candidate = delivery.candidate
    provenance = delivery.provenance
    try:
        claimed = candidate_keys.contains(candidate.candidate_key)
    except Exception:
        _discard(delivery)
        raise AcquisitionFailure(_fetcher_contract_failure()) from None
    if (
        not claimed
        or candidate.source_name != _SOURCE_NAME
        or candidate.acquisition_path is not AcquisitionPath.PUBLIC
        or provenance.source_kind is not SourceKind.ASSET_PROVIDER
        or provenance.source_name != _SOURCE_NAME
        or provenance.source_record_id is not None
    ):
        _discard(delivery)
        raise AcquisitionFailure(_fetcher_contract_failure())
    try:
        return TemporaryPdf(
            candidate=PdfCandidate(
                candidate_key=candidate.candidate_key,
                source_name=_SOURCE_NAME,
                acquisition_path=AcquisitionPath.PUBLIC,
                declared_media_type=candidate.declared_media_type,
            ),
            content=delivery.content,
            safe_source_url=None,
            provenance=provenance,
        )
    except Exception:
        _discard(delivery)
        raise AcquisitionFailure(_fetcher_contract_failure()) from None


def _discard(temporary_pdf: TemporaryPdf) -> None:
    try:
        temporary_pdf.content.discard()
    except Exception:
        raise AcquisitionFailure(_cleanup_failure()) from None


def _close_iterator(iterator: Iterator[TemporaryPdf]) -> None:
    try:
        close = getattr(iterator, "close", None)
    except Exception:
        raise AcquisitionFailure(_cleanup_failure()) from None
    if close is None:
        return
    if not callable(close):
        raise AcquisitionFailure(_fetcher_contract_failure())
    try:
        close()
    except AcquisitionFailure:
        raise
    except Exception:
        raise AcquisitionFailure(_cleanup_failure()) from None


def _raise_if_cancelled(cancel_event: threading.Event | None) -> None:
    if cancel_event is not None and cancel_event.is_set():
        raise AcquisitionFailure(_cancelled_failure())


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


def _missing_resolver_failure() -> StableFailure:
    return _stable_failure(
        code="acquisition-configured-sci-hub-resolver-missing",
        reason="The configured locator resolver is not injected.",
        action="Inject an operator-approved resolver or disable this Source.",
        retryable=False,
    )


def _cancelled_failure() -> StableFailure:
    return _stable_failure(
        code="acquisition-configured-sci-hub-cancelled",
        reason="Configured locator acquisition was cancelled.",
        action="Retry only when the operation should continue.",
        retryable=True,
    )


def _resolver_failure() -> StableFailure:
    return _stable_failure(
        code="acquisition-configured-sci-hub-resolver-failed",
        reason="The injected configured locator resolver failed.",
        action="Review the private resolver and retry the acquisition request.",
        retryable=True,
    )


def _resolver_contract_failure() -> StableFailure:
    return _stable_failure(
        code="acquisition-configured-sci-hub-resolver-contract",
        reason="The injected resolver did not return a finite locator tuple.",
        action="Correct the private resolver contract before retrying.",
        retryable=False,
    )


def _locator_failure() -> StableFailure:
    return _stable_failure(
        code="acquisition-configured-sci-hub-locator-invalid",
        reason="The injected resolver returned an unsafe locator.",
        action="Correct the private resolver to return neutral safe HTTPS locators.",
        retryable=False,
    )


def _evidence_failure() -> StableFailure:
    return _stable_failure(
        code="acquisition-configured-sci-hub-evidence-mismatch",
        reason="Configured locator evidence does not belong to the acquisition request.",
        action="Rebuild routing evidence from the current acquisition request.",
        retryable=False,
    )


def _fetcher_failure() -> StableFailure:
    return _stable_failure(
        code="acquisition-configured-sci-hub-fetcher-failed",
        reason="The public locator boundary failed before normal exhaustion.",
        action="Check the shared public locator boundary before retrying.",
        retryable=True,
    )


def _fetcher_contract_failure() -> StableFailure:
    return _stable_failure(
        code="acquisition-configured-sci-hub-fetcher-contract",
        reason="The public locator boundary violated its neutral delivery contract.",
        action="Correct the Acquisition component assembly.",
        retryable=False,
    )


def _cleanup_failure() -> StableFailure:
    return _stable_failure(
        code="acquisition-configured-sci-hub-cleanup-failed",
        reason="Configured locator temporary content could not be released safely.",
        action="Check the Acquisition runtime before retrying.",
        retryable=True,
    )


def _contract_failure() -> StableFailure:
    return _stable_failure(
        code="acquisition-configured-sci-hub-contract",
        reason="The configured locator Source violated its neutral contract.",
        action="Correct the Acquisition component assembly.",
        retryable=False,
    )


__all__ = (
    "ConfiguredLocatorResolver",
    "ConfiguredSciHubPdfSource",
    "PublicLocatorFetcher",
    "configured_sci_hub_readiness",
)
