"""Request-local DOI landing-origin resolution through the shared Network boundary."""

from __future__ import annotations

import threading
from datetime import datetime, timezone
from typing import Final
from urllib.parse import urljoin

from sciretriever.acquisition.planning import DoiLandingResolution
from sciretriever.acquisition.ports import AcquisitionFailure, AcquisitionSourceFailure
from sciretriever.model.access import AccessFailure, TransportResponse
from sciretriever.model.literature import Identifier
from sciretriever.model.report import StableFailure
from sciretriever.network.admission import AccessFeedback, AccessPolicy, AccessScope
from sciretriever.network.http import HttpClient
from sciretriever.network.policy import PolicyError, normalize_url
from sciretriever.network.response_feedback import FeedbackHeaderError, retry_after_feedback

_DOI_RESOLVER_BASE: Final[str] = "https://doi.org"
_DOI_SCOPE: Final[AccessScope] = AccessScope("doi.org", "web")
_DOI_RESOLVER_ORIGINS: Final[frozenset[str]] = frozenset({"https://doi.org", "https://dx.doi.org"})
_BASELINE_WEB_POLICY: Final[AccessPolicy] = AccessPolicy(
    max_concurrency=1,
    min_start_interval=1.0,
)
_MAX_RESOLVER_RESPONSE_BYTES: Final[int] = 64 * 1024
_REDIRECT_STATUSES: Final[frozenset[int]] = frozenset({301, 302, 303, 307, 308})


def _throttling_feedback(response: TransportResponse) -> AccessFeedback | None:
    try:
        standard = retry_after_feedback(
            response.status,
            response.headers,
            wall_now=datetime.now(timezone.utc),
        )
    except FeedbackHeaderError:
        return AccessFeedback(throttled=True)
    if standard is not None:
        return standard
    if response.status >= 500:
        return AccessFeedback(throttled=True)
    return None


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


def _resolution_from_response(result: TransportResponse) -> DoiLandingResolution | None:
    if result.status in {204, 404, 410}:
        return None
    if result.status in _REDIRECT_STATUSES:
        location = next(
            (header.value for header in result.headers if header.name.casefold() == "location"),
            None,
        )
        if location is None:
            raise AcquisitionSourceFailure(_status_failure(retryable=False))
        try:
            canonical = normalize_url(urljoin(result.final_url, location))
        except (PolicyError, TypeError, ValueError):
            raise AcquisitionSourceFailure(_network_failure(retryable=False)) from None
        if canonical.origin.text in _DOI_RESOLVER_ORIGINS:
            return None
        return DoiLandingResolution(
            canonical_landing_url=canonical.url,
            origin=canonical.origin.text,
        )
    if 200 <= result.status < 300:
        return None
    retryable = result.status in {408, 425, 429} or result.status >= 500
    raise AcquisitionSourceFailure(_status_failure(retryable=retryable))


class DoiLandingResolver:
    """Resolve one canonical DOI to its final safe origin without creating a candidate."""

    __slots__ = (
        "_http_client",
        "_access_policy",
        "_cancel_event",
    )

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

    def resolve(self, doi: Identifier) -> DoiLandingResolution | None:
        """Return a safe canonical landing and origin, or a normal miss."""

        if not isinstance(doi, Identifier):
            raise TypeError("doi must be an Identifier")
        if doi.namespace != "doi":
            return None

        try:
            result = self._http_client.request(
                _DOI_SCOPE,
                _DOI_RESOLVER_BASE,
                self._access_policy,
                method="GET",
                path_parameter=doi.value,
                max_response_bytes=_MAX_RESOLVER_RESPONSE_BYTES,
                follow_redirects=False,
                cancel_event=self._cancel_event,
                response_feedback=_throttling_feedback,
            )
        except Exception:
            raise AcquisitionSourceFailure(_network_failure()) from None
        if isinstance(result, AccessFailure):
            failure = _access_failure(result)
            if result.code == "cancelled":
                raise AcquisitionFailure(failure)
            raise AcquisitionSourceFailure(failure)
        if not isinstance(result, TransportResponse):
            raise AcquisitionSourceFailure(_network_failure())
        return _resolution_from_response(result)


__all__ = ("DoiLandingResolver",)
