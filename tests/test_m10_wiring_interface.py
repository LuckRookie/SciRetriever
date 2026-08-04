from __future__ import annotations

import importlib
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase

from sciretriever.composition.configuration import parse_configuration
from sciretriever.composition.wiring import (
    ObjectGraph,
    ProviderDependencies,
    build_object_graph,
)
from sciretriever.infrastructure.sources.registry import Capability
from sciretriever.model.access import TransportRequest, TransportResponse
from sciretriever.model.assets import AssetCandidate
from sciretriever.model.primitives import AssetRole
from sciretriever.services.library.api import LibraryService
from sciretriever.services.literature.api import LiteratureService


class _RecordingTransport:
    def __init__(self) -> None:
        self.requests: list[TransportRequest] = []

    def execute(self, request: TransportRequest) -> TransportResponse:
        self.requests.append(request)
        return TransportResponse(
            status=200,
            final_url=request.url,
            headers=(),
            body=b"pdf",
        )


class M10WiringInterfaceTests(TestCase):
    def test_offline_graph_contains_only_constructible_service_apis(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            catalog = root / "catalog.sqlite"
            storage = root / "storage"
            body = f"""schema_version = 2
[paths]
catalog = "{catalog}"
storage_root = "{storage}"
[collection]
citation_providers = ["openalex"]
[sources]
providers = ["crossref"]
[assets]
providers = ["crossref"]
[parsing]
protocol = "loopback"
base_url = "http://127.0.0.1:8000"
model = "mineru-3.4.4"
[analysis]
protocol = "openai"
base_url = "https://api.openai.com/v1"
model = "gpt-5.1"
secret_ref = "env:SCIRETRIEVER_TEST_SECRET"
[execution]
[library]
[access]
[credentials]
"""
            graph = build_object_graph(parse_configuration(body, base_dir=root))
        self.assertIsInstance(graph, ObjectGraph)
        self.assertIsInstance(graph.literature, LiteratureService)
        self.assertIsInstance(graph.library, LibraryService)
        self.assertIsNone(graph.providers)
        self.assertIsNone(graph.analysis)

    def test_configuration_registers_only_selected_capabilities_and_preserves_fractional_timeout(
        self,
    ) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            catalog = root / "catalog.sqlite"
            storage = root / "storage"
            body = f"""schema_version = 2
[paths]
catalog = "{catalog}"
storage_root = "{storage}"
[collection]
citation_providers = ["openalex"]
[sources]
providers = ["crossref", "arxiv"]
[assets]
providers = ["crossref", "sci-hub"]
timeout_seconds = 12.5
[parsing]
protocol = "loopback"
base_url = "http://127.0.0.1:8000"
model = "mineru-3.4.4"
[analysis]
protocol = "openai"
base_url = "https://api.openai.com/v1"
model = "gpt-5.1"
secret_ref = "env:SCIRETRIEVER_TEST_SECRET"
[execution]
[library]
[access]
[credentials]
"""
            transport = _RecordingTransport()
            graph = build_object_graph(
                parse_configuration(body, base_dir=root),
                provider_dependencies=ProviderDependencies({}, {}, {}, transport),
            )

        assert graph.providers is not None
        self.assertEqual(
            graph.providers.names(Capability.METADATA),
            ("arxiv", "crossref"),
        )
        self.assertEqual(graph.providers.names(Capability.CITATION), ("openalex",))
        self.assertEqual(
            graph.providers.names(Capability.ASSET_RESOLVER),
            ("crossref", "sci-hub"),
        )
        self.assertEqual(
            graph.providers.names(Capability.ASSET_FETCHER),
            ("crossref", "sci-hub"),
        )
        graph.providers.asset_fetcher("crossref").fetch(
            AssetCandidate(
                provider="crossref",
                role=AssetRole.PRIMARY_PDF,
                locator="https://source.invalid/article",
                headers=(),
            )
        )
        self.assertEqual(transport.requests[0].timeout_seconds, 12.5)

    def test_interface_has_no_cli_or_fake_workflow_surface(self) -> None:
        interface = importlib.import_module("sciretriever.interface")
        self.assertFalse(hasattr(interface, "main"))
        self.assertFalse(hasattr(interface, "app"))
        repository = Path(__file__).resolve().parents[1]
        self.assertFalse(
            (repository / "src" / "sciretriever" / "interface" / "__main__.py").exists()
        )
        project = (repository / "pyproject.toml").read_text(encoding="utf-8")
        self.assertNotIn("[project.scripts]", project)


if __name__ == "__main__":
    import unittest

    unittest.main()
