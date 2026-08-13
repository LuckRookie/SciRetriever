"""Safe public acquisition from neutral direct-file and landing-page hints.

``DirectPdfSource`` is deliberately not a Provider.  It consumes only accepted
``AssetHint`` evidence and delegates every real locator to the shared Network
HTTP boundary.  The package-level ``PublicLocatorFetcher`` is also the common
public-locator primitive for later protocol Sources: it owns claim-before-I/O,
conservative web admission, neutral temporary-byte lifetime, and provenance.
"""

from __future__ import annotations

import hashlib
import re
import threading
from collections.abc import Callable, Iterable, Iterator, Mapping
from contextlib import AbstractContextManager, closing
from datetime import datetime, timezone
from html.parser import HTMLParser
from io import BytesIO
from typing import BinaryIO, Final
from urllib.parse import urljoin
from uuid import uuid4

from sciretriever.acquisition.ports import (
    AcquisitionFailure,
    CandidateKeyTracker,
    TemporaryPdf,
)
from sciretriever.acquisition.routing import (
    AcquisitionEvidence,
    AcquisitionRequest,
    build_acquisition_evidence,
)
from sciretriever.acquisition.rules import DEFAULT_MAX_PDF_BYTES
from sciretriever.model.access import AccessFailure, Header, TransportResponse
from sciretriever.model.acquisition import (
    AcquisitionPath,
    AssetHint,
    AssetHintKind,
    AssetRole,
    PdfCandidate,
)
from sciretriever.model.primitives import ProvenanceId, SourceKind, UtcTimestamp
from sciretriever.model.provenance import Provenance
from sciretriever.model.report import StableFailure
from sciretriever.network.admission import AccessPolicy, AccessScope
from sciretriever.network.http import HttpClient
from sciretriever.network.policy import NormalizedURL, PolicyError, normalize_url

_CONTROL_CHARACTER = re.compile(r"[\x00-\x1f\x7f]")
_DIRECT_SOURCE_NAME: Final[str] = "direct"
_LANDING_RESPONSE_BYTES: Final[int] = 2 * 1024 * 1024
_MAX_STATIC_LOCATORS: Final[int] = 64
_CONSERVATIVE_WEB_POLICY: Final[AccessPolicy] = AccessPolicy(
    max_concurrency=1,
    cooldown_after_completion=30.0,
)

ProvenanceIdFactory = Callable[[], ProvenanceId]
Clock = Callable[[], UtcTimestamp]


def _default_provenance_id() -> ProvenanceId:
    return ProvenanceId(str(uuid4()))


def _utc_now() -> UtcTimestamp:
    value = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    return UtcTimestamp(value)


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


def _network_failure(*, retryable: bool = True) -> StableFailure:
    return _failure(
        code="acquisition-public-locator-network-failed",
        reason="A public PDF locator could not be accessed safely.",
        action="Check the source and shared Network policy before retrying.",
        retryable=retryable,
    )


def _access_failure(value: AccessFailure) -> StableFailure:
    if value.code == "cancelled":
        return _failure(
            code="acquisition-interrupted",
            reason="Automatic PDF acquisition was interrupted before commit.",
            action="Retry the operation when ready.",
            retryable=True,
        )
    return _network_failure(retryable=value.retryable)


def _status_failure(*, retryable: bool) -> StableFailure:
    return _failure(
        code="acquisition-public-locator-response-failed",
        reason="A public PDF locator returned a non-miss failure response.",
        action="Check source availability or access requirements before retrying.",
        retryable=retryable,
    )


def _protocol_failure() -> StableFailure:
    return _failure(
        code="acquisition-public-locator-protocol-failed",
        reason="A public PDF locator returned an unusable protocol response.",
        action="Check the source protocol before retrying.",
        retryable=True,
    )


def _contract_failure() -> StableFailure:
    return _failure(
        code="acquisition-public-locator-contract",
        reason="A public locator component violated its neutral contract.",
        action="Correct the acquisition Source assembly.",
        retryable=False,
    )


def _safe_text(value: object, *, field_name: str) -> str:
    if not isinstance(value, str):
        raise TypeError(f"{field_name} must be a string")
    candidate = value.strip()
    if not candidate or _CONTROL_CHARACTER.search(candidate) is not None:
        raise ValueError(f"{field_name} must be safe and nonblank")
    return candidate


def _safe_candidate_key(value: object) -> str:
    candidate = _safe_text(value, field_name="candidate_key")
    if "://" in candidate:
        raise ValueError("candidate_key must not contain a locator")
    return candidate


def _optional_record_id(value: object) -> str | None:
    if value is None:
        return None
    return _safe_text(value, field_name="source_record_id")


def _media_type(value: object) -> str | None:
    if value is None:
        return None
    candidate = _safe_text(value, field_name="declared_media_type")
    bare = candidate.partition(";")[0].strip().casefold()
    return bare or None


def _is_pdf_media_type(value: str | None) -> bool:
    return _media_type(value) == "application/pdf"


def _canonical_locator(value: object) -> NormalizedURL:
    if not isinstance(value, str):
        raise AcquisitionFailure(_network_failure(retryable=False))
    try:
        return normalize_url(value)
    except (PolicyError, TypeError, ValueError):
        raise AcquisitionFailure(_network_failure(retryable=False)) from None


def _fingerprint(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8", "strict")).hexdigest()


def _locator_candidate_key(source_name: str, locator: NormalizedURL) -> str:
    identity = f"{source_name}\x00public-bytes\x00{locator.url}"
    return f"public-locator:{_fingerprint(identity)}"


def _profile_hostname(value: object) -> str:
    try:
        candidate = _safe_text(value, field_name="profile hostname")
        if any(marker in candidate for marker in ("://", "/", "\\", "@", "?", "#", ":")):
            raise ValueError("profile hostname must not contain a locator or port")
        normalized = normalize_url(f"https://{candidate}")
    except (PolicyError, TypeError, ValueError):
        raise ValueError("profile hostname must be a canonicalizable hostname") from None
    if normalized.path != "/" or normalized.query:
        raise ValueError("profile hostname must not contain a path or query")
    return normalized.hostname


def _header_media_type(headers: tuple[Header, ...]) -> str | None:
    for header in headers:
        if header.name.casefold() == "content-type":
            return _media_type(header.value)
    return None


def _validated_locator_inputs(
    *,
    locator: object,
    candidate_key: object,
    source_name: object,
    source_record_id: object,
    declared_media_type: object,
) -> tuple[NormalizedURL, str, str, str | None, str | None]:
    try:
        key = _safe_candidate_key(candidate_key)
        name = _safe_text(source_name, field_name="source_name")
        record_id = _optional_record_id(source_record_id)
        media_type = _media_type(declared_media_type)
    except (TypeError, ValueError):
        raise AcquisitionFailure(_contract_failure()) from None
    return _canonical_locator(locator), key, name, record_id, media_type


def _claim_candidate(candidate_keys: CandidateKeyTracker, candidate_key: str) -> bool:
    try:
        return candidate_keys.claim(candidate_key)
    except Exception:
        raise AcquisitionFailure(_contract_failure()) from None


def _is_normal_miss(response: TransportResponse) -> bool:
    if response.status in {204, 404, 410}:
        return True
    if not 200 <= response.status < 300:
        retryable = response.status in {408, 425, 429} or response.status >= 500
        raise AcquisitionFailure(_status_failure(retryable=retryable))
    return False


class WebAccessProfileResolver:
    """Resolve canonical hosts to local web admission profiles.

    The optional mapping is deliberately supplied by composition rather than
    embedded here: production assembly may make multiple publisher hosts share
    one stable provider/web scope, while an unknown host safely falls back to
    its own hostname scope.  Resolution is an exact-host, process-local lookup
    and never performs DNS or any other I/O.
    """

    __slots__ = ("_profiles_by_hostname",)

    def __init__(
        self,
        profiles_by_hostname: Mapping[str, tuple[AccessScope, AccessPolicy]] | None = None,
    ) -> None:
        if profiles_by_hostname is not None and not isinstance(profiles_by_hostname, Mapping):
            raise TypeError("profiles_by_hostname must be a mapping or None")
        profiles: dict[str, tuple[AccessScope, AccessPolicy]] = {}
        for raw_hostname, profile in (
            () if profiles_by_hostname is None else profiles_by_hostname.items()
        ):
            hostname = _profile_hostname(raw_hostname)
            if type(profile) is not tuple or len(profile) != 2:
                raise TypeError("web access profiles must contain an AccessScope and AccessPolicy")
            scope, policy = profile
            if not isinstance(scope, AccessScope):
                raise TypeError("web access profile scope must be an AccessScope")
            if scope.channel != "web":
                raise ValueError("web access profile scope must use the web channel")
            if not isinstance(policy, AccessPolicy):
                raise TypeError("web access profile policy must be an AccessPolicy")
            if hostname in profiles:
                raise ValueError("profiles_by_hostname contains a duplicate canonical hostname")
            profiles[hostname] = (
                scope,
                AccessPolicy.strictest(_CONSERVATIVE_WEB_POLICY, policy),
            )
        self._profiles_by_hostname = profiles

    def resolve(self, safe_url: NormalizedURL) -> tuple[AccessScope, AccessPolicy]:
        """Return a conservative provider/web profile without performing I/O."""

        if type(safe_url) is not NormalizedURL:
            raise TypeError("safe_url must be a NormalizedURL")
        profile = self._profiles_by_hostname.get(safe_url.hostname)
        if profile is not None:
            return profile
        return AccessScope(safe_url.hostname, "web"), _CONSERVATIVE_WEB_POLICY


class _MemoryTemporaryPdfContent:
    """One bounded in-memory delivery consumed by A2 and released idempotently."""

    __slots__ = ("_lock", "_payload")

    def __init__(self, payload: bytes) -> None:
        if not isinstance(payload, bytes):
            raise TypeError("payload must be bytes")
        self._payload: bytes | None = payload
        self._lock = threading.Lock()

    def open(self) -> AbstractContextManager[BinaryIO]:
        with self._lock:
            payload = self._payload
        if payload is None:
            raise RuntimeError("temporary PDF content is closed")
        return closing(BytesIO(payload))

    def discard(self) -> None:
        with self._lock:
            self._payload = None


class _StaticPdfLocatorParser(HTMLParser):
    """Extract only explicit, non-executable PDF locator declarations."""

    __slots__ = ("locators", "overflowed")

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.locators: list[str] = []
        self.overflowed = False

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if self.overflowed:
            return
        attributes = {
            name.casefold(): value
            for name, value in attrs
            if isinstance(name, str) and isinstance(value, str)
        }
        folded_tag = tag.casefold()
        locator: str | None = None
        if folded_tag == "meta":
            name = attributes.get("name")
            if name is not None and name.strip().casefold() == "citation_pdf_url":
                locator = attributes.get("content")
        elif _is_pdf_media_type(attributes.get("type")):
            locator_attribute = {
                "a": "href",
                "link": "href",
                "embed": "src",
                "object": "data",
            }.get(folded_tag)
            if locator_attribute is not None:
                locator = attributes.get(locator_attribute)
        if locator is None or not locator.strip():
            return
        self.locators.append(locator.strip())
        if len(self.locators) > _MAX_STATIC_LOCATORS:
            self.overflowed = True


def _static_pdf_locators(body: bytes, final_url: str) -> tuple[NormalizedURL, ...]:
    try:
        parser = _StaticPdfLocatorParser()
        parser.feed(body.decode("utf-8-sig", errors="replace"))
        parser.close()
        if parser.overflowed:
            raise ValueError("too many static PDF locators")
    except Exception:
        raise AcquisitionFailure(_protocol_failure()) from None

    result: list[NormalizedURL] = []
    seen: set[str] = set()
    for raw_locator in parser.locators:
        candidate = _canonical_locator(urljoin(final_url, raw_locator))
        if candidate.url in seen:
            continue
        seen.add(candidate.url)
        result.append(candidate)
    return tuple(result)


class PublicLocatorFetcher:
    """Fetch safe public locators into neutral ``TemporaryPdf`` deliveries."""

    __slots__ = (
        "_http_client",
        "_web_access_profile_resolver",
        "_web_policy",
        "_max_pdf_response_bytes",
        "_max_landing_response_bytes",
        "_cancel_event",
        "_provenance_id_factory",
        "_clock",
    )

    def __init__(
        self,
        *,
        http_client: HttpClient,
        web_access_profile_resolver: WebAccessProfileResolver | None = None,
        access_policy: AccessPolicy | None = None,
        max_pdf_response_bytes: int = DEFAULT_MAX_PDF_BYTES,
        max_landing_response_bytes: int = _LANDING_RESPONSE_BYTES,
        cancel_event: threading.Event | None = None,
        provenance_id_factory: ProvenanceIdFactory = _default_provenance_id,
        clock: Clock = _utc_now,
    ) -> None:
        if not isinstance(http_client, HttpClient):
            raise TypeError("http_client must be an HttpClient")
        if web_access_profile_resolver is not None and not isinstance(
            web_access_profile_resolver, WebAccessProfileResolver
        ):
            raise TypeError(
                "web_access_profile_resolver must be a WebAccessProfileResolver or None"
            )
        if access_policy is not None and not isinstance(access_policy, AccessPolicy):
            raise TypeError("access_policy must be an AccessPolicy or None")
        for field_name, value in (
            ("max_pdf_response_bytes", max_pdf_response_bytes),
            ("max_landing_response_bytes", max_landing_response_bytes),
        ):
            if type(value) is not int or value <= 0:
                raise ValueError(f"{field_name} must be a positive integer")
        if cancel_event is not None and not isinstance(cancel_event, threading.Event):
            raise TypeError("cancel_event must be a threading.Event or None")
        if not callable(provenance_id_factory):
            raise TypeError("provenance_id_factory must be callable")
        if not callable(clock):
            raise TypeError("clock must be callable")

        self._http_client = http_client
        self._web_access_profile_resolver = (
            WebAccessProfileResolver()
            if web_access_profile_resolver is None
            else web_access_profile_resolver
        )
        self._web_policy = (
            _CONSERVATIVE_WEB_POLICY
            if access_policy is None
            else AccessPolicy.strictest(_CONSERVATIVE_WEB_POLICY, access_policy)
        )
        self._max_pdf_response_bytes = max_pdf_response_bytes
        self._max_landing_response_bytes = max_landing_response_bytes
        self._cancel_event = cancel_event
        self._provenance_id_factory = provenance_id_factory
        self._clock = clock

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
    ) -> Iterable[TemporaryPdf]:
        """Claim and fetch one locator, optionally following explicit static PDF links."""

        return self._acquire_locator(
            locator=locator,
            candidate_key=candidate_key,
            source_name=source_name,
            source_record_id=source_record_id,
            declared_media_type=declared_media_type,
            candidate_keys=candidate_keys,
            allow_static_landing_discovery=allow_static_landing_discovery,
        )

    def _acquire_locator(
        self,
        *,
        locator: str,
        candidate_key: str,
        source_name: str,
        source_record_id: str | None,
        declared_media_type: str | None,
        candidate_keys: CandidateKeyTracker,
        allow_static_landing_discovery: bool,
    ) -> Iterator[TemporaryPdf]:
        if not isinstance(candidate_keys, CandidateKeyTracker):
            raise AcquisitionFailure(_contract_failure())
        if type(allow_static_landing_discovery) is not bool:
            raise AcquisitionFailure(_contract_failure())
        canonical, key, name, record_id, input_media_type = _validated_locator_inputs(
            locator=locator,
            candidate_key=candidate_key,
            source_name=source_name,
            source_record_id=source_record_id,
            declared_media_type=declared_media_type,
        )
        if not _claim_candidate(candidate_keys, key):
            return

        result = self._request(canonical)
        if _is_normal_miss(result):
            return

        final_locator = _canonical_locator(result.final_url)
        media_type = input_media_type or _header_media_type(result.headers)
        content = _MemoryTemporaryPdfContent(result.body)
        try:
            temporary_pdf = TemporaryPdf(
                candidate=PdfCandidate(
                    candidate_key=key,
                    source_name=name,
                    acquisition_path=AcquisitionPath.PUBLIC,
                    declared_media_type=media_type,
                ),
                content=content,
                safe_source_url=final_locator.url,
                provenance=self._provenance(
                    source_name=name,
                    source_record_id=record_id,
                ),
            )
        except Exception:
            content.discard()
            raise AcquisitionFailure(_contract_failure()) from None
        try:
            yield temporary_pdf
        except BaseException:
            content.discard()
            raise
        if not allow_static_landing_discovery:
            return
        if len(result.body) > self._max_landing_response_bytes:
            raise AcquisitionFailure(_protocol_failure())
        for discovered in _static_pdf_locators(result.body, result.final_url):
            yield from self._acquire_locator(
                locator=discovered.url,
                candidate_key=_locator_candidate_key(name, discovered),
                source_name=name,
                source_record_id=record_id,
                declared_media_type="application/pdf",
                candidate_keys=candidate_keys,
                allow_static_landing_discovery=False,
            )

    def _request(self, locator: NormalizedURL) -> TransportResponse:
        try:
            scope, profile_policy = self._web_access_profile_resolver.resolve(locator)
            if (
                not isinstance(scope, AccessScope)
                or scope.channel != "web"
                or not isinstance(profile_policy, AccessPolicy)
            ):
                raise TypeError("invalid web access profile")
            effective_policy = AccessPolicy.strictest(self._web_policy, profile_policy)

            def guard_redirect_target(target_url: str) -> None:
                target = _canonical_locator(target_url)
                target_scope, target_profile_policy = self._web_access_profile_resolver.resolve(
                    target
                )
                target_policy = AccessPolicy.strictest(
                    self._web_policy,
                    target_profile_policy,
                )
                if target_scope != scope:
                    raise ValueError("redirect target uses another web access scope")
                if AccessPolicy.strictest(effective_policy, target_policy) != effective_policy:
                    raise ValueError("redirect target requires a stricter web access policy")

            result = self._http_client.request(
                scope,
                locator.url,
                effective_policy,
                # A landing response may itself be the PDF regardless of its
                # declaration.  It therefore reaches the same byte ceiling as
                # a direct locator; the smaller HTML parse ceiling is applied
                # only after A2 has had the opportunity to accept the body.
                max_response_bytes=self._max_pdf_response_bytes,
                cancel_event=self._cancel_event,
                redirect_target_guard=guard_redirect_target,
            )
        except Exception:
            raise AcquisitionFailure(_network_failure()) from None
        if isinstance(result, AccessFailure):
            raise AcquisitionFailure(_access_failure(result))
        if not isinstance(result, TransportResponse):
            raise AcquisitionFailure(_protocol_failure())
        return result

    def _provenance(
        self,
        *,
        source_name: str,
        source_record_id: str | None,
    ) -> Provenance:
        try:
            provenance_id = self._provenance_id_factory()
            observed_at = self._clock()
        except Exception:
            raise AcquisitionFailure(_contract_failure()) from None
        if not isinstance(provenance_id, ProvenanceId) or not isinstance(observed_at, UtcTimestamp):
            raise AcquisitionFailure(_contract_failure())
        return Provenance(
            provenance_id=provenance_id,
            source_kind=SourceKind.ASSET_PROVIDER,
            source_name=source_name,
            source_record_id=source_record_id,
            observed_at=observed_at,
            input_sha256=None,
            parameters_sha256=None,
        )


def _eligible_primary_hint(hint: AssetHint) -> bool:
    return hint.asset_role is None or hint.asset_role is AssetRole.PRIMARY_PDF


def _ordered_unique_hints(
    evidence: AcquisitionEvidence,
) -> tuple[tuple[AssetHint, NormalizedURL, bool], ...]:
    eligible = [
        observed for observed in evidence.asset_hints if _eligible_primary_hint(observed.hint)
    ]
    eligible.sort(key=lambda observed: 0 if observed.hint.kind is AssetHintKind.DIRECT_FILE else 1)
    result: list[tuple[AssetHint, NormalizedURL, bool]] = []
    positions: dict[str, int] = {}
    for observed in eligible:
        hint = observed.hint
        canonical = _canonical_locator(hint.url)
        existing_position = positions.get(canonical.url)
        if existing_position is None:
            positions[canonical.url] = len(result)
            result.append((hint, canonical, hint.kind is AssetHintKind.LANDING_PAGE))
            continue
        prior_hint, prior_locator, allow_static = result[existing_position]
        if hint.kind is AssetHintKind.LANDING_PAGE and not allow_static:
            # A duplicate landing declaration does not issue a second request,
            # but it permits static discovery if A2 rejects the shared body.
            result[existing_position] = (prior_hint, prior_locator, True)
    return tuple(result)


class DirectPdfSource:
    """Public-stage ``PdfSource`` for neutral direct-file and landing hints."""

    __slots__ = ("_fetcher",)

    def __init__(self, *, fetcher: PublicLocatorFetcher) -> None:
        if not isinstance(fetcher, PublicLocatorFetcher):
            raise TypeError("fetcher must be a PublicLocatorFetcher")
        self._fetcher = fetcher

    @property
    def source_name(self) -> str:
        return _DIRECT_SOURCE_NAME

    @property
    def acquisition_path(self) -> AcquisitionPath:
        return AcquisitionPath.PUBLIC

    def is_applicable(self, evidence: AcquisitionEvidence) -> bool:
        if not isinstance(evidence, AcquisitionEvidence):
            raise TypeError("evidence must be AcquisitionEvidence")
        return any(_eligible_primary_hint(observed.hint) for observed in evidence.asset_hints)

    def acquire(
        self,
        request: AcquisitionRequest,
        evidence: AcquisitionEvidence,
        candidate_keys: CandidateKeyTracker,
    ) -> Iterable[TemporaryPdf]:
        if not isinstance(request, AcquisitionRequest):
            raise TypeError("request must be AcquisitionRequest")
        if not isinstance(evidence, AcquisitionEvidence):
            raise TypeError("evidence must be AcquisitionEvidence")
        if not isinstance(candidate_keys, CandidateKeyTracker):
            raise TypeError("candidate_keys must be CandidateKeyTracker")
        try:
            expected_evidence = build_acquisition_evidence(request)
        except Exception:
            raise AcquisitionFailure(_contract_failure()) from None
        if evidence != expected_evidence:
            raise AcquisitionFailure(_contract_failure())
        return self._acquire_hints(evidence, candidate_keys)

    def _acquire_hints(
        self,
        evidence: AcquisitionEvidence,
        candidate_keys: CandidateKeyTracker,
    ) -> Iterator[TemporaryPdf]:
        for hint, canonical, allow_static in _ordered_unique_hints(evidence):
            yield from self._fetcher.acquire(
                locator=canonical.url,
                candidate_key=_locator_candidate_key(self.source_name, canonical),
                source_name=self.source_name,
                source_record_id=None,
                declared_media_type=hint.media_type,
                candidate_keys=candidate_keys,
                allow_static_landing_discovery=allow_static,
            )


__all__ = (
    "DirectPdfSource",
    "PublicLocatorFetcher",
    "WebAccessProfileResolver",
)
