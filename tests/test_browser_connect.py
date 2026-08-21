from __future__ import annotations

import socket
import unittest
from dataclasses import dataclass
from urllib.parse import urlsplit

from sciretriever.network.browser_connect import (
    BrowserConnectProxy,
    BrowserNativeTransportError,
)


@dataclass(frozen=True, slots=True)
class _Binding:
    scheme: str
    hostname: str
    port: int
    address: str
    verified_addresses: tuple[str, ...]
    authority: str
    tls_server_name: str


def _binding(address: str = "127.0.0.1") -> _Binding:
    return _Binding(
        scheme="https",
        hostname="publisher.example",
        port=443,
        address=address,
        verified_addresses=(address,),
        authority="publisher.example",
        tls_server_name="publisher.example",
    )


class BrowserConnectProxyLaneTests(unittest.TestCase):
    def setUp(self) -> None:
        self.proxy = BrowserConnectProxy(maximum_article_bytes=10)
        self.addCleanup(self._close_proxy)

    def _close_proxy(self) -> None:
        try:
            self.proxy.close()
        except BrowserNativeTransportError:
            pass

    def test_same_authority_and_address_share_authorization_owners(self) -> None:
        first, second = object(), object()
        binding = _binding()
        self.assertIs(self.proxy.begin_lane(first), first)
        self.assertIs(self.proxy.begin_lane(second), second)
        self.assertIs(self.proxy.authorize(first, binding), binding)
        self.assertIs(self.proxy.authorize(second, binding), binding)

        authorization = self.proxy._authorizations[("https", "publisher.example", 443)]
        self.assertEqual(authorization.owners, {first, second})

        self.assertTrue(self.proxy.end_lane(first))
        authorization = self.proxy._authorizations[("https", "publisher.example", 443)]
        self.assertEqual(authorization.owners, {second})
        self.assertTrue(self.proxy.end_lane(second))
        self.assertNotIn(("https", "publisher.example", 443), self.proxy._authorizations)

    def test_same_authority_with_a_different_pinned_address_fails_closed(self) -> None:
        first, second = object(), object()
        self.proxy.begin_lane(first)
        self.proxy.begin_lane(second)
        self.proxy.authorize(first, _binding())

        with self.assertRaises(BrowserNativeTransportError):
            self.proxy.authorize(second, _binding("127.0.0.2"))

        self.assertEqual(
            self.proxy._authorizations[("https", "publisher.example", 443)].owners,
            {first},
        )
        self.assertTrue(self.proxy.end_lane(first))
        self.assertTrue(self.proxy.end_lane(second))

    def test_one_lane_end_keeps_a_shared_connection_until_the_last_owner(self) -> None:
        first, second = object(), object()
        binding = _binding()
        self.proxy.begin_lane(first)
        self.proxy.begin_lane(second)
        self.proxy.authorize(first, binding)
        self.proxy.authorize(second, binding)
        local, peer = socket.socketpair()
        self.addCleanup(peer.close)
        key = ("https", "publisher.example", 443)
        self.proxy._track(local, key, frozenset({first, second}))

        self.assertTrue(self.proxy.end_lane(first))
        self.assertGreaterEqual(local.fileno(), 0)
        self.assertEqual(self.proxy._connections[local].owners, {second})

        self.assertTrue(self.proxy.end_lane(second))
        self.assertEqual(local.fileno(), -1)

    def test_lane_budget_failure_does_not_clear_another_lane_state(self) -> None:
        first, second = object(), object()
        binding = _binding()
        self.proxy.begin_lane(first)
        self.proxy.begin_lane(second)
        self.proxy.authorize(first, binding)
        self.proxy.authorize(second, binding)
        self.proxy._consume(8, frozenset({first}))

        with self.assertRaises(BrowserNativeTransportError):
            self.proxy._consume(4, frozenset({first, second}))

        self.assertTrue(self.proxy._lanes[first].failed)
        self.assertFalse(self.proxy._lanes[second].failed)
        self.assertFalse(self.proxy.end_lane(first))
        self.assertIn(("https", "publisher.example", 443), self.proxy._authorizations)
        self.assertTrue(self.proxy.end_lane(second))

    def test_unauthorized_connect_is_rejected_without_external_connection(self) -> None:
        parsed = urlsplit(self.proxy.server_url)
        self.assertIsNotNone(parsed.port)
        with socket.create_connection(("127.0.0.1", parsed.port or 0), timeout=1.0) as client:
            client.sendall(
                b"CONNECT publisher.example:443 HTTP/1.1\r\nHost: publisher.example:443\r\n\r\n"
            )
            response = client.recv(4096)

        self.assertTrue(response.startswith(b"HTTP/1.1 403 Forbidden"))

    def test_close_cleans_listener_connections_and_workers_idempotently(self) -> None:
        token = object()
        self.proxy.begin_lane(token)
        self.proxy.authorize(token, _binding())
        local, peer = socket.socketpair()
        self.addCleanup(peer.close)
        self.proxy._track(
            local,
            ("https", "publisher.example", 443),
            frozenset({token}),
        )

        self.proxy.close()
        self.assertEqual(local.fileno(), -1)
        self.assertFalse(self.proxy._thread.is_alive())
        self.assertFalse(any(worker.is_alive() for worker in self.proxy._workers))
        self.proxy.close()


if __name__ == "__main__":
    unittest.main()
