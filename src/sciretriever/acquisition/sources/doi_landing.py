"""Request-local DOI landing-origin resolution through the shared Network boundary."""

from __future__ import annotations

import threading
from typing import Final
from urllib.parse import urlsplit

from sciretriever.acquisition.ports import AcquisitionFailure
from sciretriever.model.access import AccessFailure, TransportResponse
from sciretriever.model.literature import Identifier
from sciretriever.model.report import StableFailure
from sciretriever.network.admission import AccessPolicy, AccessScope
from sciretriever.network.http import HttpClient
from sciretriever.network.policy import PolicyError, normalize_url

_DOI_RESOLVER_BASE: Final[str] = "https://doi.org"
_DOI_SCOPE: Final[AccessScope] = AccessScope("doi.org", "web")
_DOI_RESOLVER_ORIGINS: Final[frozenset[str]] = frozenset({"https://doi.org", "https://dx.doi.org"})
_BASELINE_WEB_POLICY: Final[AccessPolicy] = AccessPolicy(
    max_concurrency=1,
    cooldown_after_completion=30.0,
)
_MAX_RESOLVER_RESPONSE_BYTES: Final[int] = 64 * 1024


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
        code="acquisition-doi-resolution-network-failed",
        reason="The DOI landing origin could not be resolved safely.",
        action="Check the DOI resolver and shared Network policy before retrying.",
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
        code="acquisition-doi-resolution-response-failed",
        reason="The DOI resolver returned a non-miss failure response.",
        action="Check DOI resolver availability before retrying.",
        retryable=retryable,
    )


def _final_origin(value: str) -> str:
    try:
        parsed = urlsplit(value)
        hostname = parsed.hostname
        port = parsed.port
    except (TypeError, ValueError):
        raise AcquisitionFailure(_network_failure(retryable=False)) from None
    if (
        hostname is None
        or parsed.username is not None
        or parsed.password is not None
        or parsed.fragment
    ):
        raise AcquisitionFailure(_network_failure(retryable=False))
    host = f"[{hostname}]" if ":" in hostname else hostname
    authority = host if port is None else f"{host}:{port}"
    try:
        return normalize_url(f"{parsed.scheme}://{authority}").origin.text
    except (PolicyError, TypeError, ValueError):
        raise AcquisitionFailure(_network_failure(retryable=False)) from None


class DoiLandingResolver:
    """Resolve one canonical DOI to its final safe origin without creating a candidate."""

    __slots__ = ("_http_client", "_access_policy", "_cancel_event")

    def __init__(
        self,
        *,
        http_client: HttpClient,
        access_policy: AccessPolicy | None = None,
        cancel_event: threading.Event | None = None,
    ) -> None:
        if not isinstance(http_client, HttpClient):
            raise TypeError("http_client must be an HttpClient")
        if access_policy is not None and not isinstance(access_policy, AccessPolicy):
            raise TypeError("access_policy must be an AccessPolicy or None")
        if cancel_event is not None and not isinstance(cancel_event, threading.Event):
            raise TypeError("cancel_event must be a threading.Event or None")
        self._http_client = http_client
        self._access_policy = (
            _BASELINE_WEB_POLICY
            if access_policy is None
            else AccessPolicy.strictest(_BASELINE_WEB_POLICY, access_policy)
        )
        self._cancel_event = cancel_event

    def resolve(self, doi: Identifier | None) -> str | None:
        """Return only the normalized final origin, or ``None`` for no DOI/not found."""

        if doi is None:
            return None
        if not isinstance(doi, Identifier):
            raise TypeError("doi must be an Identifier or None")
        if doi.namespace != "doi":
            return None

        try:
            result = self._http_client.request(
                _DOI_SCOPE,
                _DOI_RESOLVER_BASE,
                self._access_policy,
                method="HEAD",
                path_parameter=doi.value,
                max_response_bytes=_MAX_RESOLVER_RESPONSE_BYTES,
                cancel_event=self._cancel_event,
            )
        except Exception:
            raise AcquisitionFailure(_network_failure()) from None
        if isinstance(result, AccessFailure):
            raise AcquisitionFailure(_access_failure(result))
        if not isinstance(result, TransportResponse):
            raise AcquisitionFailure(_network_failure())
        if result.status in {204, 404, 410}:
            return None
        if not 200 <= result.status < 300:
            retryable = result.status in {408, 425, 429} or result.status >= 500
            raise AcquisitionFailure(_status_failure(retryable=retryable))

        origin = _final_origin(result.final_url)
        return None if origin in _DOI_RESOLVER_ORIGINS else origin


__all__ = ("DoiLandingResolver",)
