from __future__ import annotations

from dataclasses import dataclass

from sciretriever.content.ports import Header, TransportRequest, TransportResponse
from sciretriever.network.policy import NetworkPolicyError
from sciretriever.network.secure import SecureHttpsTransport


@dataclass(frozen=True, slots=True)
class TransportFailure(Exception):
    code: str
    retryable: bool

    def __str__(self) -> str:
        return self.code


class BoundedHttpsTransportAdapter:
    def __init__(self, transport: SecureHttpsTransport) -> None:
        self._transport = transport

    def execute(self, request: TransportRequest) -> TransportResponse:
        if request.method != "GET" or request.body is not None:
            raise TransportFailure("unsupported-transport-request", False)
        if request.max_response_bytes > self._transport.max_bytes:
            raise TransportFailure("response-budget-exceeds-transport-cap", False)
        try:
            response = self._transport.get(
                request.url,
                headers={header.name: header.value for header in request.headers},
                timeout=float(request.timeout_seconds),
            )
        except NetworkPolicyError:
            raise TransportFailure("secure-transport-rejected", False) from None
        if len(response.body) > request.max_response_bytes:
            raise TransportFailure("response-body-too-large", False)
        headers = tuple(
            Header(name, value) for name, value in sorted(response.headers.items())
        )
        return TransportResponse(
            response.status, response.url, headers, response.body,
        )


__all__ = ("BoundedHttpsTransportAdapter", "TransportFailure")
