"""Acquisition compatibility facade over shared pinned HTTPS mechanics."""

from typing import Callable, Mapping, Protocol

from sciretriever.acquisition.url_policy import UrlPolicy
from sciretriever.errors import AcquisitionError
from sciretriever.network.policy import NetworkPolicyError
from sciretriever.network import HeadersResponse, HttpResponse, QueryParams
from sciretriever.network.secure import (
    MAX_REDIRECTS, MAX_RESPONSE_BYTES, HttpsDialer, PinnedHttpsDialer,
    SecureHttpsTransport, _read_bounded as _shared_read_bounded,
)


class _Readable(Protocol):
    def read(self, n: int = -1) -> bytes: ...


def _read_bounded(stream: _Readable, headers: Mapping[str, str], max_bytes: int) -> bytes:
    try:
        return _shared_read_bounded(stream, headers, max_bytes)
    except NetworkPolicyError as error:
        raise AcquisitionError(str(error)) from error


class UrllibAcquisitionTransport(SecureHttpsTransport):
    """Compatibility name preserving acquisition error and policy behavior."""

    def __init__(self, policy: UrlPolicy | None = None, *,
                 max_bytes: int = MAX_RESPONSE_BYTES,
                 max_redirects: int = MAX_REDIRECTS,
                 resolver: Callable[[str], tuple[str, ...]] | None = None,
                 dialer: HttpsDialer | None = None) -> None:
        kwargs = {"max_bytes": max_bytes, "max_redirects": max_redirects, "dialer": dialer}
        if resolver is not None:
            kwargs["resolver"] = resolver
        super().__init__(policy or UrlPolicy(), **kwargs)

    def get(
        self,
        url: str,
        *,
        params: QueryParams | None = None,
        headers: Mapping[str, str] | None = None,
        timeout: float | None = None,
    ) -> HttpResponse:
        try:
            return super().get(
                url, params=params, timeout=timeout, headers=headers
            )
        except NetworkPolicyError as error:
            raise AcquisitionError(str(error)) from error

    def head(
        self,
        url: str,
        *,
        params: QueryParams | None = None,
        headers: Mapping[str, str] | None = None,
        timeout: float | None = None,
    ) -> HeadersResponse:
        try:
            return super().head(url, params=params, timeout=timeout, headers=headers)
        except NetworkPolicyError as error:
            raise AcquisitionError(str(error)) from error


__all__ = ("MAX_REDIRECTS", "MAX_RESPONSE_BYTES", "PinnedHttpsDialer", "UrllibAcquisitionTransport")
