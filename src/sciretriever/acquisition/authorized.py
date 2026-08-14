"""Verified-contract boundary for authorized primary-PDF Provider APIs.

This module contains only secret-free contracts.  Concrete endpoints,
credential values, HTTP response handling, and Network calls remain in each
Provider client.  A Provider adapter may use :class:`AuthorizedPdfSource`
only after its endpoint, credential, response, entitlement, primary-PDF, and
access-policy contracts have all been verified.

The injected client owns Network and vendor-private work.  Only closed,
secret-free lookup/download decisions cross into the generic Source, which
then produces the same neutral :class:`~sciretriever.acquisition.ports.TemporaryPdf`
used by every other acquisition path.
"""

from __future__ import annotations

import hashlib
import re
from collections.abc import Callable, Iterator, Mapping
from dataclasses import dataclass
from datetime import datetime, timezone
from enum import Enum, unique
from types import MappingProxyType
from typing import Final, Protocol, TypeAlias, runtime_checkable
from urllib.parse import urlsplit
from uuid import uuid4

from sciretriever.acquisition.ports import (
    AcquisitionFailure,
    AcquisitionSourceFailure,
    CandidateKeyTracker,
    SourceReadiness,
    TemporaryPdf,
    TemporaryPdfContent,
)
from sciretriever.acquisition.routing import (
    AcquisitionEvidence,
    AcquisitionRequest,
    ProviderRecordIdentity,
    build_acquisition_evidence,
)
from sciretriever.logging.api import get_logger
from sciretriever.model.acquisition import AcquisitionPath, PdfCandidate
from sciretriever.model.primitives import ProvenanceId, SourceKind, UtcTimestamp
from sciretriever.model.provenance import Provenance
from sciretriever.model.report import StableFailure

_CONTROL_CHARACTER = re.compile(r"[\x00-\x1f\x7f]")
_STABLE_KEY = re.compile(r"^[a-z0-9][a-z0-9._-]*$")
_CREDENTIAL_FIELD = re.compile(r"^[a-z][a-z0-9_]*$")
_MAX_IDENTITY_CHARS = 4096
_LOGGER = get_logger(__name__)

ProvenanceIdFactory = Callable[[], ProvenanceId]
Clock = Callable[[], UtcTimestamp]


def _default_provenance_id() -> ProvenanceId:
    return ProvenanceId(str(uuid4()))


def _utc_now() -> UtcTimestamp:
    value = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    return UtcTimestamp(value)


def _safe_text(value: object, *, field_name: str) -> str:
    if not isinstance(value, str):
        raise TypeError(f"{field_name} must be a string")
    candidate = value.strip()
    if (
        not candidate
        or len(candidate) > _MAX_IDENTITY_CHARS
        or _CONTROL_CHARACTER.search(candidate) is not None
    ):
        raise ValueError(f"{field_name} must be safe and nonblank")
    return candidate


def _stable_key(value: object, *, field_name: str) -> str:
    candidate = _safe_text(value, field_name=field_name).casefold()
    if _STABLE_KEY.fullmatch(candidate) is None:
        raise ValueError(f"{field_name} must be a stable key")
    return candidate


def _safe_label(value: object, *, field_name: str) -> str:
    candidate = _safe_text(value, field_name=field_name)
    if "://" in candidate or "\\" in candidate:
        raise ValueError(f"{field_name} must not contain an endpoint or path")
    return candidate


def _identity_value(value: object, *, field_name: str) -> str:
    candidate = _safe_text(value, field_name=field_name)
    if "://" in candidate or "\\" in candidate:
        raise ValueError(f"{field_name} must be a stable non-URL identity")
    return candidate


def _credential_field(value: object) -> str:
    candidate = _safe_text(value, field_name="credential field").casefold()
    if _CREDENTIAL_FIELD.fullmatch(candidate) is None:
        raise ValueError("credential field must be a stable field name")
    return candidate


def _media_type(value: object) -> str | None:
    if value is None:
        return None
    candidate = _safe_text(value, field_name="media_type")
    bare = candidate.partition(";")[0].strip().casefold()
    if not bare or "/" not in bare:
        raise ValueError("media_type must be a normalized media type")
    return bare


def _origin(value: object) -> str:
    candidate = _safe_text(value, field_name="origin")
    try:
        parsed = urlsplit(candidate)
        port = parsed.port
    except ValueError as error:
        raise ValueError("origin must be an absolute HTTPS origin") from error
    if (
        parsed.scheme.casefold() != "https"
        or parsed.hostname is None
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path not in {"", "/"}
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError("origin must be an absolute HTTPS origin")
    host = parsed.hostname.casefold()
    if ":" in host and not host.startswith("["):
        host = f"[{host}]"
    authority = host if port in {None, 443} else f"{host}:{port}"
    return f"https://{authority}"


def _unique_tuple(values: tuple[str, ...], *, field_name: str) -> tuple[str, ...]:
    if len(values) != len(set(values)):
        raise ValueError(f"{field_name} must be unique")
    return values


def _credential_fields_tuple(value: object) -> tuple[str, ...]:
    if not isinstance(value, tuple):
        raise TypeError("required_credential_fields must be a tuple")
    fields = tuple(_credential_field(item) for item in value)
    return _unique_tuple(fields, field_name="required_credential_fields")


def _namespace_tuple(
    value: object,
    *,
    field_name: str,
    item_name: str,
    required: bool,
) -> tuple[str, ...]:
    if not isinstance(value, tuple):
        raise TypeError(f"{field_name} must be a tuple")
    namespaces = tuple(_stable_key(item, field_name=item_name) for item in value)
    if required and not namespaces:
        raise ValueError(f"{field_name} must not be empty")
    return _unique_tuple(namespaces, field_name=field_name)


def _record_identity_rules_tuple(
    value: object,
) -> tuple[AuthorizedRecordIdentityRule, ...]:
    if not isinstance(value, tuple):
        raise TypeError("provider_record_identity_rules must be a tuple")
    if any(not isinstance(item, AuthorizedRecordIdentityRule) for item in value):
        raise TypeError(
            "provider_record_identity_rules must contain AuthorizedRecordIdentityRule values"
        )
    rules = value
    if len(rules) != len(set(rules)):
        raise ValueError("provider_record_identity_rules must be unique")
    return rules


def _origins_tuple(value: object) -> tuple[str, ...]:
    if not isinstance(value, tuple):
        raise TypeError("doi_landing_origins must be a tuple")
    origins = tuple(_origin(item) for item in value)
    return _unique_tuple(origins, field_name="doi_landing_origins")


def _normal_miss_set(value: object) -> frozenset[AuthorizedNormalMiss]:
    if not isinstance(value, frozenset):
        raise TypeError("normal_miss_reasons must be a frozenset")
    if any(not isinstance(item, AuthorizedNormalMiss) for item in value):
        raise TypeError("normal_miss_reasons must contain AuthorizedNormalMiss values")
    return value


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


def _failure(
    *,
    code: str,
    reason: str,
    action: str,
    retryable: bool,
    isolated: bool = False,
) -> AcquisitionFailure:
    failure = _stable_failure(
        code=code,
        reason=reason,
        action=action,
        retryable=retryable,
    )
    failure_type = AcquisitionSourceFailure if isolated else AcquisitionFailure
    return failure_type(failure)


@unique
class AuthorizedEvidenceKind(str, Enum):
    """Closed strong-evidence classes accepted by a verified API contract."""

    STABLE_PROVIDER_LOCATOR = "stable-provider-locator"
    PROVIDER_RECORD_IDENTITY = "provider-record-identity"
    DOI_LANDING_ORIGIN = "doi-landing-origin"


@unique
class AuthorizedEntitlement(str, Enum):
    """Per-Literature content entitlement decided by a real Provider call."""

    GRANTED = "granted"
    DENIED = "denied"
    UNKNOWN = "unknown"


@unique
class AuthorizedNormalMiss(str, Enum):
    """The only potential normal misses a verified contract may opt into."""

    HTTP_204 = "http-204"
    HTTP_404 = "http-404"
    HTTP_410 = "http-410"
    NO_PRIMARY = "no-primary"


@unique
class AuthorizedClientFailureKind(str, Enum):
    """Secret-free failures a vendor client must translate before returning."""

    ACCESS = "access"
    AUTHENTICATION = "authentication"
    ENTITLEMENT = "entitlement"
    QUOTA = "quota"
    SERVICE = "service"
    RESPONSE_SCHEMA = "response-schema"
    NON_PDF_PRODUCT = "non-pdf-product"
    AMBIGUOUS_PRIMARY_PDF = "ambiguous-primary-pdf"
    CANCELLED = "cancelled"
    CLEANUP = "cleanup"


class AuthorizedClientFailure(RuntimeError):
    """A redacted vendor-client failure with no HTTP or credential detail."""

    __slots__ = ("kind",)

    def __init__(self, kind: AuthorizedClientFailureKind) -> None:
        if not isinstance(kind, AuthorizedClientFailureKind):
            raise TypeError("kind must be an AuthorizedClientFailureKind")
        self.kind = kind
        super().__init__("authorized provider client failed")

    def __repr__(self) -> str:
        return f"AuthorizedClientFailure(kind={self.kind.value!r})"


@dataclass(frozen=True, slots=True)
class AuthorizedRecordIdentityRule:
    """Declarative recognition of one Provider-owned record-ID namespace.

    A nonblank prefix is mandatory.  Merely observing that metadata came from
    a provider (for example, an ordinary Scopus EID) can therefore never make
    an authorized content API applicable.
    """

    provider_name: str
    record_id_prefix: str
    target_namespace: str

    def __post_init__(self) -> None:
        object.__setattr__(
            self,
            "provider_name",
            _stable_key(self.provider_name, field_name="provider_name"),
        )
        object.__setattr__(
            self,
            "record_id_prefix",
            _safe_label(self.record_id_prefix, field_name="record_id_prefix"),
        )
        object.__setattr__(
            self,
            "target_namespace",
            _stable_key(self.target_namespace, field_name="target_namespace"),
        )

    def recognize(self, identity: ProviderRecordIdentity) -> str | None:
        """Return the contract-recognized record value without performing I/O."""

        if not isinstance(identity, ProviderRecordIdentity):
            raise TypeError("identity must be a ProviderRecordIdentity")
        if identity.provider_name.casefold() != self.provider_name:
            return None
        if not identity.record_id.startswith(self.record_id_prefix):
            return None
        remainder = identity.record_id[len(self.record_id_prefix) :].strip()
        try:
            return _identity_value(remainder, field_name="provider record identity")
        except (TypeError, ValueError):
            return None


@dataclass(frozen=True, slots=True)
class AuthorizedProviderContract:
    """Secret-free facts proven before an authorized Source can be built."""

    source_name: str
    product_name: str
    contract_revision: str
    required_credential_fields: tuple[str, ...]
    stable_locator_namespaces: tuple[str, ...]
    provider_record_identity_rules: tuple[AuthorizedRecordIdentityRule, ...]
    doi_landing_origins: tuple[str, ...]
    download_locator_namespaces: tuple[str, ...]
    normal_miss_reasons: frozenset[AuthorizedNormalMiss]
    download_proves_entitlement: bool = False

    def __post_init__(self) -> None:
        object.__setattr__(
            self,
            "source_name",
            _stable_key(self.source_name, field_name="source_name"),
        )
        object.__setattr__(
            self,
            "product_name",
            _safe_label(self.product_name, field_name="product_name"),
        )
        object.__setattr__(
            self,
            "contract_revision",
            _safe_label(self.contract_revision, field_name="contract_revision"),
        )
        object.__setattr__(
            self,
            "required_credential_fields",
            _credential_fields_tuple(self.required_credential_fields),
        )
        object.__setattr__(
            self,
            "stable_locator_namespaces",
            _namespace_tuple(
                self.stable_locator_namespaces,
                field_name="stable_locator_namespaces",
                item_name="stable locator namespace",
                required=False,
            ),
        )
        object.__setattr__(
            self,
            "provider_record_identity_rules",
            _record_identity_rules_tuple(self.provider_record_identity_rules),
        )
        object.__setattr__(
            self,
            "doi_landing_origins",
            _origins_tuple(self.doi_landing_origins),
        )
        object.__setattr__(
            self,
            "download_locator_namespaces",
            _namespace_tuple(
                self.download_locator_namespaces,
                field_name="download_locator_namespaces",
                item_name="download locator namespace",
                required=True,
            ),
        )
        object.__setattr__(
            self,
            "normal_miss_reasons",
            _normal_miss_set(self.normal_miss_reasons),
        )
        if type(self.download_proves_entitlement) is not bool:
            raise TypeError("download_proves_entitlement must be a bool")
        if not (
            self.stable_locator_namespaces
            or self.provider_record_identity_rules
            or self.doi_landing_origins
        ):
            raise ValueError("an authorized contract must declare strong applicability evidence")


@dataclass(frozen=True, slots=True)
class AuthorizedLookupTarget:
    """A strong, non-URL request identity handed to the private client."""

    evidence_kind: AuthorizedEvidenceKind
    namespace: str
    value: str
    provider_record_source: str | None = None
    resolved_landing_origin: str | None = None

    def __post_init__(self) -> None:
        if not isinstance(self.evidence_kind, AuthorizedEvidenceKind):
            raise TypeError("evidence_kind must be an AuthorizedEvidenceKind")
        object.__setattr__(
            self,
            "namespace",
            _stable_key(self.namespace, field_name="target namespace"),
        )
        object.__setattr__(
            self,
            "value",
            _identity_value(self.value, field_name="target value"),
        )
        if self.provider_record_source is not None:
            object.__setattr__(
                self,
                "provider_record_source",
                _stable_key(
                    self.provider_record_source,
                    field_name="provider_record_source",
                ),
            )
        if self.resolved_landing_origin is not None:
            object.__setattr__(
                self,
                "resolved_landing_origin",
                _origin(self.resolved_landing_origin),
            )
        if self.evidence_kind is AuthorizedEvidenceKind.PROVIDER_RECORD_IDENTITY:
            if self.provider_record_source is None or self.resolved_landing_origin is not None:
                raise ValueError("provider record targets require only their record source")
        elif self.evidence_kind is AuthorizedEvidenceKind.DOI_LANDING_ORIGIN:
            if (
                self.namespace != "doi"
                or self.provider_record_source is not None
                or self.resolved_landing_origin is None
            ):
                raise ValueError("DOI landing targets require a DOI and resolved origin")
        elif self.provider_record_source is not None or self.resolved_landing_origin is not None:
            raise ValueError("stable locator targets must not carry other evidence")


@dataclass(frozen=True, slots=True)
class AuthorizedDownloadLocator:
    """A verified non-URL locator identity returned by a private client lookup."""

    namespace: str
    value: str
    declared_media_type: str | None
    source_record_id: str | None

    def __post_init__(self) -> None:
        object.__setattr__(
            self,
            "namespace",
            _stable_key(self.namespace, field_name="download locator namespace"),
        )
        object.__setattr__(
            self,
            "value",
            _identity_value(self.value, field_name="download locator value"),
        )
        object.__setattr__(self, "declared_media_type", _media_type(self.declared_media_type))
        if self.source_record_id is not None:
            object.__setattr__(
                self,
                "source_record_id",
                _identity_value(self.source_record_id, field_name="source_record_id"),
            )


@dataclass(frozen=True, slots=True)
class AuthorizedLookupMiss:
    """A contract-defined normal miss bound to one lookup target."""

    target: AuthorizedLookupTarget
    reason: AuthorizedNormalMiss

    def __post_init__(self) -> None:
        if not isinstance(self.target, AuthorizedLookupTarget):
            raise TypeError("target must be an AuthorizedLookupTarget")
        if not isinstance(self.reason, AuthorizedNormalMiss):
            raise TypeError("reason must be an AuthorizedNormalMiss")


@dataclass(frozen=True, slots=True)
class AuthorizedLookupDownloads:
    """Primary-PDF locator decisions paired with per-Literature entitlement."""

    target: AuthorizedLookupTarget
    entitlement: AuthorizedEntitlement
    downloads: tuple[AuthorizedDownloadLocator, ...]

    def __post_init__(self) -> None:
        if not isinstance(self.target, AuthorizedLookupTarget):
            raise TypeError("target must be an AuthorizedLookupTarget")
        if not isinstance(self.entitlement, AuthorizedEntitlement):
            raise TypeError("entitlement must be an AuthorizedEntitlement")
        if not isinstance(self.downloads, tuple):
            raise TypeError("downloads must be a tuple")
        if not self.downloads:
            raise ValueError("downloads must not be empty; use an explicit normal miss")
        if any(not isinstance(value, AuthorizedDownloadLocator) for value in self.downloads):
            raise TypeError("downloads must contain AuthorizedDownloadLocator values")
        if len(self.downloads) != len(set(self.downloads)):
            raise ValueError("downloads must be unique")


AuthorizedLookupResult: TypeAlias = AuthorizedLookupMiss | AuthorizedLookupDownloads


@dataclass(frozen=True, slots=True)
class AuthorizedDownloadMiss:
    """A contract-defined normal miss bound to one download locator."""

    locator: AuthorizedDownloadLocator
    reason: AuthorizedNormalMiss

    def __post_init__(self) -> None:
        if not isinstance(self.locator, AuthorizedDownloadLocator):
            raise TypeError("locator must be an AuthorizedDownloadLocator")
        if not isinstance(self.reason, AuthorizedNormalMiss):
            raise TypeError("reason must be an AuthorizedNormalMiss")


@dataclass(frozen=True, slots=True, repr=False)
class AuthorizedPdfDownload:
    """One bounded, still-unvalidated primary-PDF response from the client."""

    locator: AuthorizedDownloadLocator
    content: TemporaryPdfContent
    media_type: str | None
    safe_source_url: str | None
    entitlement: AuthorizedEntitlement = AuthorizedEntitlement.GRANTED

    def __post_init__(self) -> None:
        if not isinstance(self.locator, AuthorizedDownloadLocator):
            raise TypeError("locator must be an AuthorizedDownloadLocator")
        if not isinstance(self.content, TemporaryPdfContent):
            raise TypeError("content must implement TemporaryPdfContent")
        object.__setattr__(self, "media_type", _media_type(self.media_type))
        if self.safe_source_url is not None and not isinstance(self.safe_source_url, str):
            raise TypeError("safe_source_url must be a string or None")
        if not isinstance(self.entitlement, AuthorizedEntitlement):
            raise TypeError("entitlement must be an AuthorizedEntitlement")

    def __repr__(self) -> str:
        return "<AuthorizedPdfDownload>"


AuthorizedDownloadResult: TypeAlias = AuthorizedDownloadMiss | AuthorizedPdfDownload


@runtime_checkable
class AuthorizedProviderClient(Protocol):
    """Package-internal neutral client surface; credentials stay in the implementation."""

    def lookup(self, target: AuthorizedLookupTarget) -> AuthorizedLookupResult: ...

    def download(self, locator: AuthorizedDownloadLocator) -> AuthorizedDownloadResult: ...


def authorized_source_readiness(
    contract: AuthorizedProviderContract | None,
    *,
    product_ready: bool,
    access_policy_ready: bool,
    present_credential_fields: frozenset[str],
) -> SourceReadiness:
    """Evaluate local readiness using field presence only, never secret values.

    Authentication acceptance and a concrete Literature's content entitlement
    are intentionally absent.  They are real-call decisions handled by the
    injected Provider client.
    """

    if contract is not None and not isinstance(contract, AuthorizedProviderContract):
        raise TypeError("contract must be an AuthorizedProviderContract or None")
    if type(product_ready) is not bool:
        raise TypeError("product_ready must be a bool")
    if type(access_policy_ready) is not bool:
        raise TypeError("access_policy_ready must be a bool")
    if not isinstance(present_credential_fields, frozenset):
        raise TypeError("present_credential_fields must be a frozenset")
    present = frozenset(_credential_field(value) for value in present_credential_fields)
    if contract is None:
        return SourceReadiness(
            is_ready=False,
            failure=_stable_failure(
                code="acquisition-authorized-source-unsupported",
                reason="The authorized acquisition Source has no verified production contract.",
                action="Keep the Source disabled until its complete contract is verified.",
                retryable=False,
            ),
        )
    if not product_ready:
        return SourceReadiness(
            is_ready=False,
            failure=_stable_failure(
                code="acquisition-authorized-product-not-ready",
                reason="The configured authorized content product is not ready.",
                action="Review the selected content product before retrying.",
                retryable=False,
            ),
        )
    if not access_policy_ready:
        return SourceReadiness(
            is_ready=False,
            failure=_stable_failure(
                code="acquisition-authorized-access-policy-missing",
                reason="The authorized content API has no executable access policy.",
                action="Configure a verified provider access policy before retrying.",
                retryable=False,
            ),
        )
    if any(field not in present for field in contract.required_credential_fields):
        return SourceReadiness(
            is_ready=False,
            failure=_stable_failure(
                code="acquisition-authorized-credential-missing",
                reason="Required authorized content credentials are not configured.",
                action="Configure the required credential fields before retrying.",
                retryable=False,
            ),
        )
    return SourceReadiness(is_ready=True)


class AuthorizedPdfSource:
    """Generic Source usable only behind one completely verified contract."""

    __slots__ = (
        "_client",
        "_clock",
        "_contract",
        "_provenance_id_factory",
    )

    def __init__(
        self,
        *,
        contract: AuthorizedProviderContract,
        client: AuthorizedProviderClient,
        provenance_id_factory: ProvenanceIdFactory = _default_provenance_id,
        clock: Clock = _utc_now,
    ) -> None:
        if not isinstance(contract, AuthorizedProviderContract):
            raise TypeError("contract must be an AuthorizedProviderContract")
        if not isinstance(client, AuthorizedProviderClient):
            raise TypeError("client must implement AuthorizedProviderClient")
        if not callable(provenance_id_factory):
            raise TypeError("provenance_id_factory must be callable")
        if not callable(clock):
            raise TypeError("clock must be callable")
        self._contract = contract
        self._client = client
        self._provenance_id_factory = provenance_id_factory
        self._clock = clock

    @property
    def contract(self) -> AuthorizedProviderContract:
        return self._contract

    @property
    def source_name(self) -> str:
        return self._contract.source_name

    @property
    def acquisition_path(self) -> AcquisitionPath:
        return AcquisitionPath.AUTHORIZED_PROVIDER_API

    def __repr__(self) -> str:
        return f"<AuthorizedPdfSource source_name={self.source_name!r}>"

    def is_applicable(self, evidence: AcquisitionEvidence) -> bool:
        if not isinstance(evidence, AcquisitionEvidence):
            raise TypeError("evidence must be AcquisitionEvidence")
        return bool(_lookup_targets(self._contract, evidence))

    def acquire(
        self,
        request: AcquisitionRequest,
        evidence: AcquisitionEvidence,
        candidate_keys: CandidateKeyTracker,
    ) -> Iterator[TemporaryPdf]:
        _validate_acquire_inputs(request, evidence, candidate_keys)
        targets = _lookup_targets(self._contract, evidence)
        _LOGGER.debug(
            "event=authorized-source-started source=%s literature_id=%s target_count=%d",
            self.source_name,
            request.literature.literature_id,
            len(targets),
        )
        first_failure: AcquisitionSourceFailure | None = None
        for target_index, target in enumerate(targets, start=1):
            try:
                yield from self._acquire_target(
                    target=target,
                    target_index=target_index,
                    target_count=len(targets),
                    candidate_keys=candidate_keys,
                )
            except AcquisitionSourceFailure as error:
                if first_failure is None:
                    first_failure = error
        if first_failure is not None:
            raise first_failure

    def _acquire_target(
        self,
        *,
        target: AuthorizedLookupTarget,
        target_index: int,
        target_count: int,
        candidate_keys: CandidateKeyTracker,
    ) -> Iterator[TemporaryPdf]:
        lookup_key = _lookup_candidate_key(self._contract, target)
        if not _claim(candidate_keys, lookup_key):
            _LOGGER.debug(
                "event=authorized-lookup-skipped source=%s target=%d/%d reason=already-tried",
                self.source_name,
                target_index,
                target_count,
            )
            return
        _LOGGER.debug(
            "event=authorized-lookup-started source=%s target=%d/%d candidate_id=%s",
            self.source_name,
            target_index,
            target_count,
            _diagnostic_key(lookup_key),
        )
        try:
            lookup = self._lookup(target)
            self._require_lookup_binding(lookup, target)
            if isinstance(lookup, AuthorizedLookupMiss):
                self._accept_normal_miss(lookup.reason)
                _LOGGER.debug(
                    "event=authorized-lookup-finished source=%s target=%d/%d "
                    "outcome=miss reason=%s",
                    self.source_name,
                    target_index,
                    target_count,
                    lookup.reason.value,
                )
                return
            self._require_lookup_entitlement(lookup.entitlement)
        except AcquisitionSourceFailure as error:
            _log_isolated_failure(
                event="authorized-lookup-failed",
                source_name=self.source_name,
                ordinal=target_index,
                total=target_count,
                error=error,
            )
            raise
        _LOGGER.debug(
            "event=authorized-lookup-finished source=%s target=%d/%d "
            "outcome=downloads download_count=%d",
            self.source_name,
            target_index,
            target_count,
            len(lookup.downloads),
        )
        first_failure: AcquisitionSourceFailure | None = None
        for download_index, locator in enumerate(lookup.downloads, start=1):
            try:
                yield from self._acquire_download(
                    target=target,
                    locator=locator,
                    download_index=download_index,
                    download_count=len(lookup.downloads),
                    candidate_keys=candidate_keys,
                )
            except AcquisitionSourceFailure as error:
                _log_isolated_failure(
                    event="authorized-download-failed",
                    source_name=self.source_name,
                    ordinal=download_index,
                    total=len(lookup.downloads),
                    error=error,
                )
                if first_failure is None:
                    first_failure = error
        if first_failure is not None:
            raise first_failure

    def _acquire_download(
        self,
        *,
        target: AuthorizedLookupTarget,
        locator: AuthorizedDownloadLocator,
        download_index: int,
        download_count: int,
        candidate_keys: CandidateKeyTracker,
    ) -> Iterator[TemporaryPdf]:
        self._validate_download_locator(locator)
        download_key = _download_candidate_key(self._contract, locator)
        if not _claim(candidate_keys, download_key):
            _LOGGER.debug(
                "event=authorized-download-skipped source=%s download=%d/%d reason=already-tried",
                self.source_name,
                download_index,
                download_count,
            )
            return
        _LOGGER.debug(
            "event=authorized-download-started source=%s download=%d/%d candidate_id=%s",
            self.source_name,
            download_index,
            download_count,
            _diagnostic_key(download_key),
        )
        result = self._download(locator)
        self._require_download_binding(result, locator)
        if isinstance(result, AuthorizedDownloadMiss):
            self._accept_normal_miss(result.reason)
            _LOGGER.debug(
                "event=authorized-download-finished source=%s download=%d/%d "
                "outcome=miss reason=%s",
                self.source_name,
                download_index,
                download_count,
                result.reason.value,
            )
            return
        try:
            self._require_entitlement(result.entitlement)
            _require_primary_pdf_media(result.media_type)
        except AcquisitionFailure:
            self._discard_content(result.content)
            raise
        temporary = self._temporary_pdf(
            target=target,
            locator=locator,
            download=result,
            candidate_key=download_key,
        )
        try:
            _LOGGER.debug(
                "event=authorized-download-finished source=%s download=%d/%d "
                "outcome=pdf candidate_id=%s",
                self.source_name,
                download_index,
                download_count,
                _diagnostic_key(download_key),
            )
            yield temporary
        except BaseException:
            self._discard_content(temporary.content)
            raise

    def _lookup(self, target: AuthorizedLookupTarget) -> AuthorizedLookupResult:
        try:
            result = self._client.lookup(target)
        except AuthorizedClientFailure as error:
            raise _client_failure(error.kind) from None
        except Exception:
            raise _client_contract_failure() from None
        if not isinstance(result, (AuthorizedLookupMiss, AuthorizedLookupDownloads)):
            raise _client_contract_failure()
        return result

    def _download(self, locator: AuthorizedDownloadLocator) -> AuthorizedDownloadResult:
        try:
            result = self._client.download(locator)
        except AuthorizedClientFailure as error:
            raise _client_failure(error.kind) from None
        except Exception:
            raise _client_contract_failure() from None
        if not isinstance(result, (AuthorizedDownloadMiss, AuthorizedPdfDownload)):
            raise _client_contract_failure()
        return result

    def _require_lookup_binding(
        self,
        result: AuthorizedLookupResult,
        target: AuthorizedLookupTarget,
    ) -> None:
        if result.target != target:
            raise _response_schema_failure()

    def _require_download_binding(
        self,
        result: AuthorizedDownloadResult,
        locator: AuthorizedDownloadLocator,
    ) -> None:
        if result.locator == locator:
            return
        if isinstance(result, AuthorizedPdfDownload):
            self._discard_content(result.content)
        raise _response_schema_failure()

    def _accept_normal_miss(self, reason: AuthorizedNormalMiss) -> None:
        if reason not in self._contract.normal_miss_reasons:
            raise _response_schema_failure()

    def _require_entitlement(self, entitlement: AuthorizedEntitlement) -> None:
        if entitlement is AuthorizedEntitlement.GRANTED:
            return
        if entitlement is AuthorizedEntitlement.DENIED:
            raise _client_failure(AuthorizedClientFailureKind.ENTITLEMENT)
        raise _entitlement_unproven_failure()

    def _require_lookup_entitlement(self, entitlement: AuthorizedEntitlement) -> None:
        if (
            entitlement is AuthorizedEntitlement.UNKNOWN
            and self._contract.download_proves_entitlement
        ):
            return
        self._require_entitlement(entitlement)

    def _validate_download_locator(self, locator: AuthorizedDownloadLocator) -> None:
        if locator.namespace not in self._contract.download_locator_namespaces:
            raise _response_schema_failure()
        _require_primary_pdf_media(locator.declared_media_type)

    def _temporary_pdf(
        self,
        *,
        target: AuthorizedLookupTarget,
        locator: AuthorizedDownloadLocator,
        download: AuthorizedPdfDownload,
        candidate_key: str,
    ) -> TemporaryPdf:
        try:
            provenance_id = self._provenance_id_factory()
            observed_at = self._clock()
            if not isinstance(provenance_id, ProvenanceId):
                raise TypeError("invalid provenance ID")
            if not isinstance(observed_at, UtcTimestamp):
                raise TypeError("invalid observation time")
            provenance = Provenance(
                provenance_id=provenance_id,
                source_kind=SourceKind.ASSET_PROVIDER,
                source_name=self.source_name,
                source_record_id=locator.source_record_id or target.value,
                observed_at=observed_at,
                input_sha256=None,
                parameters_sha256=None,
            )
            return TemporaryPdf(
                candidate=PdfCandidate(
                    candidate_key=candidate_key,
                    source_name=self.source_name,
                    acquisition_path=AcquisitionPath.AUTHORIZED_PROVIDER_API,
                    declared_media_type=download.media_type,
                ),
                content=download.content,
                safe_source_url=download.safe_source_url,
                provenance=provenance,
            )
        except AcquisitionFailure:
            raise
        except Exception:
            self._discard_content(download.content)
            raise _client_contract_failure() from None

    def _discard_content(self, content: TemporaryPdfContent) -> None:
        try:
            content.discard()
        except Exception:
            raise _client_failure(AuthorizedClientFailureKind.CLEANUP) from None


def _diagnostic_key(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8", "strict")).hexdigest()[:16]


def _log_isolated_failure(
    *,
    event: str,
    source_name: str,
    ordinal: int,
    total: int,
    error: AcquisitionSourceFailure,
) -> None:
    failure = error.failure
    _LOGGER.warning(
        "event=%s source=%s item=%d/%d code=%s retryable=%s reason=%s action=%s",
        event,
        source_name,
        ordinal,
        total,
        failure.code,
        str(failure.retryable).lower(),
        failure.reason,
        failure.action,
    )


def _validate_acquire_inputs(
    request: AcquisitionRequest,
    evidence: AcquisitionEvidence,
    candidate_keys: CandidateKeyTracker,
) -> None:
    if not isinstance(request, AcquisitionRequest):
        raise TypeError("request must be an AcquisitionRequest")
    if not isinstance(evidence, AcquisitionEvidence):
        raise TypeError("evidence must be AcquisitionEvidence")
    if not isinstance(candidate_keys, CandidateKeyTracker):
        raise TypeError("candidate_keys must be CandidateKeyTracker")
    try:
        expected = build_acquisition_evidence(request)
    except Exception:
        raise _evidence_failure() from None
    if evidence != expected:
        raise _evidence_failure()


def _lookup_targets(
    contract: AuthorizedProviderContract,
    evidence: AcquisitionEvidence,
) -> tuple[AuthorizedLookupTarget, ...]:
    result: list[AuthorizedLookupTarget] = []
    _append_unique_targets(result, _stable_locator_targets(contract, evidence))
    _append_unique_targets(result, _record_identity_targets(contract, evidence))
    _append_unique_targets(result, _doi_origin_targets(contract, evidence))
    return tuple(result)


def _append_unique_targets(
    result: list[AuthorizedLookupTarget],
    values: tuple[AuthorizedLookupTarget, ...],
) -> None:
    for value in values:
        if value not in result:
            result.append(value)


def _stable_locator_targets(
    contract: AuthorizedProviderContract,
    evidence: AcquisitionEvidence,
) -> tuple[AuthorizedLookupTarget, ...]:
    result: list[AuthorizedLookupTarget] = []
    for locator in evidence.stable_provider_locators:
        if locator.namespace not in contract.stable_locator_namespaces:
            continue
        try:
            target = AuthorizedLookupTarget(
                evidence_kind=AuthorizedEvidenceKind.STABLE_PROVIDER_LOCATOR,
                namespace=locator.namespace,
                value=locator.value,
            )
        except (TypeError, ValueError):
            continue
        if target not in result:
            result.append(target)
    return tuple(result)


def _record_identity_targets(
    contract: AuthorizedProviderContract,
    evidence: AcquisitionEvidence,
) -> tuple[AuthorizedLookupTarget, ...]:
    result: list[AuthorizedLookupTarget] = []
    for identity in evidence.provider_record_identities:
        for rule in contract.provider_record_identity_rules:
            value = rule.recognize(identity)
            if value is None:
                continue
            target = AuthorizedLookupTarget(
                evidence_kind=AuthorizedEvidenceKind.PROVIDER_RECORD_IDENTITY,
                namespace=rule.target_namespace,
                value=value,
                provider_record_source=identity.provider_name,
            )
            if target not in result:
                result.append(target)
    return tuple(result)


def _doi_origin_targets(
    contract: AuthorizedProviderContract,
    evidence: AcquisitionEvidence,
) -> tuple[AuthorizedLookupTarget, ...]:
    resolved_origin = evidence.resolved_landing_origin
    if resolved_origin is None:
        return ()
    try:
        normalized_origin = _origin(resolved_origin)
    except (TypeError, ValueError):
        return ()
    if normalized_origin not in contract.doi_landing_origins:
        return ()
    result = tuple(
        AuthorizedLookupTarget(
            evidence_kind=AuthorizedEvidenceKind.DOI_LANDING_ORIGIN,
            namespace="doi",
            value=identifier.value,
            resolved_landing_origin=normalized_origin,
        )
        for identifier in evidence.identifiers
        if identifier.namespace == "doi"
    )
    if len(result) != len(set(result)):
        return tuple(dict.fromkeys(result))
    return tuple(result)


def _claim(candidate_keys: CandidateKeyTracker, candidate_key: str) -> bool:
    try:
        return candidate_keys.claim(candidate_key)
    except Exception:
        raise _client_contract_failure() from None


def _digest_fields(fields: tuple[str, ...]) -> str:
    digest = hashlib.sha256()
    for field in fields:
        encoded = field.encode("utf-8", "strict")
        digest.update(len(encoded).to_bytes(8, "big"))
        digest.update(encoded)
    return digest.hexdigest()


def _lookup_candidate_key(
    contract: AuthorizedProviderContract,
    target: AuthorizedLookupTarget,
) -> str:
    digest = _digest_fields(
        (
            contract.source_name,
            contract.product_name,
            contract.contract_revision,
            "lookup",
            target.evidence_kind.value,
            target.namespace,
            target.value,
            target.provider_record_source or "",
            target.resolved_landing_origin or "",
        )
    )
    return f"authorized:{contract.source_name}:lookup:{digest}"


def _download_candidate_key(
    contract: AuthorizedProviderContract,
    locator: AuthorizedDownloadLocator,
) -> str:
    digest = _digest_fields(
        (
            contract.source_name,
            contract.product_name,
            contract.contract_revision,
            "download",
            locator.namespace,
            locator.value,
            locator.source_record_id or "",
        )
    )
    return f"authorized:{contract.source_name}:download:{digest}"


def _require_primary_pdf_media(media_type: str | None) -> None:
    if media_type == "application/pdf":
        return
    if media_type is not None and (
        media_type in {"application/xml", "text/xml", "application/jats+xml"}
        or media_type.endswith("+xml")
    ):
        raise _client_failure(AuthorizedClientFailureKind.NON_PDF_PRODUCT)
    raise _client_failure(AuthorizedClientFailureKind.AMBIGUOUS_PRIMARY_PDF)


def _client_failure(kind: AuthorizedClientFailureKind) -> AcquisitionFailure:
    values: Final[dict[AuthorizedClientFailureKind, tuple[str, str, str, bool]]] = {
        AuthorizedClientFailureKind.ACCESS: (
            "acquisition-authorized-access",
            "The authorized content API could not be reached safely.",
            "Retry the request or review the Provider access boundary.",
            True,
        ),
        AuthorizedClientFailureKind.AUTHENTICATION: (
            "acquisition-authorized-authentication",
            "The authorized content API did not accept the configured credentials.",
            "Review the Provider credentials before retrying.",
            False,
        ),
        AuthorizedClientFailureKind.ENTITLEMENT: (
            "acquisition-authorized-entitlement",
            "The Provider denied this Literature's primary content entitlement.",
            "Review the content product and Literature entitlement before retrying.",
            False,
        ),
        AuthorizedClientFailureKind.QUOTA: (
            "acquisition-authorized-quota",
            "The authorized content API quota prevented this request.",
            "Retry after the shared Provider quota permits access.",
            True,
        ),
        AuthorizedClientFailureKind.SERVICE: (
            "acquisition-authorized-service",
            "The authorized content API service did not complete the request.",
            "Retry after the Provider service is available.",
            True,
        ),
        AuthorizedClientFailureKind.RESPONSE_SCHEMA: (
            "acquisition-authorized-response-schema",
            "The authorized content API returned an inconsistent response shape.",
            "Update the verified Provider contract before retrying.",
            False,
        ),
        AuthorizedClientFailureKind.NON_PDF_PRODUCT: (
            "acquisition-authorized-non-pdf-product",
            "The authorized content product returned XML or another non-PDF object.",
            "Use only a verified primary-PDF product for this Source.",
            False,
        ),
        AuthorizedClientFailureKind.AMBIGUOUS_PRIMARY_PDF: (
            "acquisition-authorized-primary-pdf-ambiguous",
            "The authorized content response did not unambiguously identify a primary PDF.",
            "Verify the Provider primary-PDF response contract before retrying.",
            False,
        ),
        AuthorizedClientFailureKind.CANCELLED: (
            "acquisition-authorized-cancelled",
            "The authorized content operation was cancelled.",
            "Retry when the acquisition operation can run to completion.",
            True,
        ),
        AuthorizedClientFailureKind.CLEANUP: (
            "acquisition-authorized-cleanup",
            "Authorized content temporary resources could not be cleaned safely.",
            "Check the acquisition runtime before retrying.",
            True,
        ),
    }
    code, reason, action, retryable = values[kind]
    return _failure(
        code=code,
        reason=reason,
        action=action,
        retryable=retryable,
        isolated=kind
        not in {
            AuthorizedClientFailureKind.CANCELLED,
            AuthorizedClientFailureKind.CLEANUP,
        },
    )


def _response_schema_failure() -> AcquisitionFailure:
    return _client_failure(AuthorizedClientFailureKind.RESPONSE_SCHEMA)


def _entitlement_unproven_failure() -> AcquisitionFailure:
    return _failure(
        code="acquisition-authorized-entitlement-unproven",
        reason="The Provider did not prove this Literature's primary content entitlement.",
        action="Verify the content product entitlement before retrying.",
        retryable=False,
        isolated=True,
    )


def _evidence_failure() -> AcquisitionFailure:
    return _failure(
        code="acquisition-authorized-evidence-mismatch",
        reason="Authorized routing evidence does not belong to this acquisition request.",
        action="Rebuild routing evidence from the current acquisition request.",
        retryable=False,
    )


def _client_contract_failure() -> AcquisitionFailure:
    return _failure(
        code="acquisition-authorized-client-contract",
        reason="An authorized Provider client violated its neutral contract.",
        action="Correct the Provider client before retrying.",
        retryable=False,
    )


# CORE API v3 documents registered-key PDF downloads for exact Work/Output
# identities.  The download response itself proves the concrete document's
# entitlement; the local lookup is deliberately I/O-free and returns UNKNOWN.
CORE_AUTHORIZED_CONTRACT: Final[AuthorizedProviderContract] = AuthorizedProviderContract(
    source_name="core",
    product_name="CORE API v3 PDF download",
    contract_revision="core-v3-2026-08-13",
    required_credential_fields=("api_key",),
    stable_locator_namespaces=(),
    provider_record_identity_rules=(
        AuthorizedRecordIdentityRule(
            provider_name="core",
            record_id_prefix="work:",
            target_namespace="core-work",
        ),
        AuthorizedRecordIdentityRule(
            provider_name="core",
            record_id_prefix="output:",
            target_namespace="core-output",
        ),
    ),
    doi_landing_origins=(),
    download_locator_namespaces=("core-work-pdf", "core-output-pdf"),
    normal_miss_reasons=frozenset(
        {
            AuthorizedNormalMiss.HTTP_204,
            AuthorizedNormalMiss.HTTP_404,
            AuthorizedNormalMiss.HTTP_410,
        }
    ),
    download_proves_entitlement=True,
)

WILEY_AUTHORIZED_CONTRACT: Final[AuthorizedProviderContract] = AuthorizedProviderContract(
    source_name="wiley",
    product_name="Wiley Online Library TDM API PDF download",
    contract_revision="wiley-tdm-v1-client-1.2.0-2026-08-13",
    required_credential_fields=("tdm_api_token",),
    stable_locator_namespaces=(),
    provider_record_identity_rules=(),
    doi_landing_origins=("https://onlinelibrary.wiley.com",),
    download_locator_namespaces=("wiley-tdm-pdf",),
    normal_miss_reasons=frozenset({AuthorizedNormalMiss.HTTP_404}),
    download_proves_entitlement=True,
)

# Elsevier Article Retrieval and Springer Full Text are verified XML/JATS or
# object products rather than primary-PDF APIs, so neither is registered as an
# authorized PDF Source.
UNSUPPORTED_AUTHORIZED_API_PROVIDER_KEYS: Final[frozenset[str]] = frozenset(
    {"elsevier", "springer"}
)
PRODUCTION_AUTHORIZED_PROVIDER_CATALOG: Final[Mapping[str, AuthorizedProviderContract]] = (
    MappingProxyType(
        {
            "core": CORE_AUTHORIZED_CONTRACT,
            "wiley": WILEY_AUTHORIZED_CONTRACT,
        }
    )
)


__all__ = (
    "AuthorizedClientFailure",
    "AuthorizedClientFailureKind",
    "AuthorizedDownloadLocator",
    "AuthorizedDownloadMiss",
    "AuthorizedDownloadResult",
    "AuthorizedEntitlement",
    "AuthorizedEvidenceKind",
    "AuthorizedLookupDownloads",
    "AuthorizedLookupMiss",
    "AuthorizedLookupResult",
    "AuthorizedLookupTarget",
    "AuthorizedNormalMiss",
    "AuthorizedPdfDownload",
    "AuthorizedPdfSource",
    "AuthorizedProviderClient",
    "AuthorizedProviderContract",
    "AuthorizedRecordIdentityRule",
    "CORE_AUTHORIZED_CONTRACT",
    "Clock",
    "PRODUCTION_AUTHORIZED_PROVIDER_CATALOG",
    "ProvenanceIdFactory",
    "UNSUPPORTED_AUTHORIZED_API_PROVIDER_KEYS",
    "WILEY_AUTHORIZED_CONTRACT",
    "authorized_source_readiness",
)
