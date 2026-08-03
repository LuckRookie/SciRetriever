from __future__ import annotations

import unittest
from dataclasses import dataclass

from sciretriever.infrastructure.sources.assets import (
    AssetFetcherAdapter,
    AssetResolverAdapter,
    ResolverCandidate,
)
from sciretriever.model.access import TransportRequest, TransportResponse
from sciretriever.model.assets import AssetCandidate, ContentTarget
from sciretriever.model.primitives import AssetRole
from tests.target_core_asset_support import target


@dataclass(frozen=True, slots=True)
class _StaticTransport:
    response: TransportResponse

    def execute(self, request: TransportRequest) -> TransportResponse:
        del request
        return self.response


@dataclass(frozen=True, slots=True)
class _MalformedResolverClient:
    def resolve(self, target: ContentTarget) -> tuple[ResolverCandidate, ...]:
        del target
        return (ResolverCandidate(locator=" ", role=AssetRole.PRIMARY_PDF),)


class TargetAssetAdapterTests(unittest.TestCase):
    def test_fetcher_rejects_non_success_transport_response(self) -> None:
        adapter = AssetFetcherAdapter(
            _StaticTransport(
                TransportResponse(
                    status=404,
                    final_url="https://secret.invalid/missing",
                    headers=(),
                    body=b"provider error body",
                )
            ),
            timeout_seconds=30,
            max_response_bytes=1_000,
        )
        candidate = AssetCandidate(
            provider="provider",
            role=AssetRole.PRIMARY_PDF,
            locator="https://source.invalid/article",
            headers=(),
        )

        with self.assertRaises(OSError) as raised:
            adapter.fetch(candidate)

        self.assertNotIn("secret.invalid", str(raised.exception))
        self.assertNotIn("provider error body", str(raised.exception))

    def test_resolver_translates_malformed_candidate_to_local_failure(self) -> None:
        adapter = AssetResolverAdapter("provider", _MalformedResolverClient())

        with self.assertRaises(OSError) as raised:
            adapter.resolve(target())

        self.assertNotIn("locator", str(raised.exception))


if __name__ == "__main__":
    unittest.main()
