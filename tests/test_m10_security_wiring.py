from __future__ import annotations

import traceback
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import NoReturn
from unittest import TestCase, mock

from pydantic import ValidationError

import sciretriever.composition.wiring.graph as graph
import sciretriever.composition.wiring.provider_registry as provider_registry
from sciretriever.composition.configuration import parse_configuration
from sciretriever.composition.configuration.secrets import (
    SecretResolutionError,
    resolve_secret_reference,
)
from sciretriever.composition.wiring import ProviderDependencies
from sciretriever.infrastructure.llm import (
    AnalysisAdapterError,
    AnthropicAnalysisAdapter,
    OpenAIAnalysisAdapter,
)
from sciretriever.model.configuration import PathsConfig


def configuration_body(root: Path) -> str:
    return f'''schema_version = 2
[paths]
catalog = "{root / "catalog.sqlite"}"
storage_root = "{root / "storage"}"
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
base_url = "https://api.example.com/v1"
model = "analysis-model"
secret_ref = "env:ANALYSIS_SECRET"
[execution]
[library]
[access]
[credentials]
'''


class _ExplodingResolver:
    def __init__(self, sentinel: str) -> None:
        self.sentinel = sentinel

    def resolve(self, reference: str) -> str:
        raise RuntimeError(self.sentinel)


class _InterruptingResolver:
    def resolve(self, reference: str) -> str:
        raise KeyboardInterrupt("interrupt")


class M10SecretBoundaryTests(TestCase):
    def test_plain_resolver_exception_is_fresh_and_secret_free(self) -> None:
        sentinel = "RESOLVER-SENTINEL"
        with self.assertRaises(SecretResolutionError) as raised:
            resolve_secret_reference("env:SECRET", _ExplodingResolver(sentinel))
        error = raised.exception
        self.assertNotIn(sentinel, str(error))
        self.assertNotIn(sentinel, repr(error))
        self.assertNotIn(sentinel, "".join(traceback.format_exception(error)))
        self.assertEqual(error.reference, "env:SECRET")

    def test_keyboard_interrupt_from_resolver_is_not_caught(self) -> None:
        with self.assertRaises(KeyboardInterrupt):
            resolve_secret_reference("env:SECRET", _InterruptingResolver())

    def test_invalid_direct_config_has_zero_wiring_callbacks_or_files(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            valid = parse_configuration(configuration_body(root), base_dir=root)
            invalid = valid.model_copy(
                update={
                    "paths": PathsConfig(
                        catalog=Path("relative.sqlite"), storage_root=Path("relative-storage")
                    )
                }
            )
            dependencies = ProviderDependencies({}, {}, {}, mock.Mock())
            with (
                mock.patch.object(graph, "SqliteLiteratureRepository") as literature_repository,
                mock.patch.object(graph, "SqliteLibraryReadRepository") as library_repository,
                mock.patch.object(graph, "resolve_secret_reference") as resolver,
                mock.patch.object(
                    graph, "build_provider_registry_from_configuration"
                ) as provider_builder,
                self.assertRaises(ValidationError),
            ):
                graph.build_object_graph(
                    invalid,
                    provider_dependencies=dependencies,
                    secret_resolver=mock.Mock(),
                )
        literature_repository.assert_not_called()
        library_repository.assert_not_called()
        resolver.assert_not_called()
        provider_builder.assert_not_called()

    def test_invalid_direct_config_reaches_no_provider_builder(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            valid = parse_configuration(configuration_body(root), base_dir=root)
            invalid = valid.model_copy(
                update={"analysis": valid.analysis.model_copy(update={"model": " bad model"})}
            )
            with (
                mock.patch.object(provider_registry, "_build_provider_registry") as builder,
                self.assertRaises(ValidationError),
            ):
                provider_registry.build_provider_registry_from_configuration(
                    invalid, ProviderDependencies({}, {}, {}, mock.Mock())
                )
        builder.assert_not_called()


class _PlainFailureClient:
    def __init__(self, sentinel: str) -> None:
        self.sentinel = sentinel

    def create(self, **kwargs: str) -> NoReturn:
        raise RuntimeError(self.sentinel)


class _InterruptingClient:
    def create(self, **kwargs: str) -> NoReturn:
        raise KeyboardInterrupt("interrupt")


class M10LlmCallbackBoundaryTests(TestCase):
    def _request(self):
        from target_analysis_support import analysis_request, complete_document

        return analysis_request(complete_document())

    def _settings(self):
        from target_analysis_support import adapter_settings

        return adapter_settings()

    def test_plain_factory_exception_is_sanitized(self) -> None:
        sentinel = "LLM-FACTORY-SENTINEL"

        def factory(
            *, api_key: str, base_url: str, timeout: float, max_retries: int
        ) -> _PlainFailureClient:
            raise RuntimeError(sentinel)

        with self.assertRaises(AnalysisAdapterError) as raised:
            OpenAIAnalysisAdapter(self._settings(), "runtime-secret", factory).analyze(
                self._request()
            )
        self.assertEqual(str(raised.exception), "analysis_provider_error")
        self.assertNotIn(sentinel, "".join(traceback.format_exception(raised.exception)))
        self.assertNotIn("runtime-secret", repr(raised.exception))
        self.assertNotIn(sentinel, repr(raised.exception.__context__))

        with self.assertRaises(AnalysisAdapterError) as raised:
            AnthropicAnalysisAdapter(self._settings(), "runtime-secret", factory).analyze(
                self._request()
            )
        self.assertEqual(raised.exception.code, "analysis_provider_error")
        self.assertNotIn(sentinel, repr(raised.exception.__context__))

    def test_plain_create_exception_is_sanitized(self) -> None:
        sentinel = "LLM-CREATE-SENTINEL"

        def factory(
            *, api_key: str, base_url: str, timeout: float, max_retries: int
        ) -> _PlainFailureClient:
            return _PlainFailureClient(sentinel)

        with self.assertRaises(AnalysisAdapterError) as raised:
            OpenAIAnalysisAdapter(self._settings(), "runtime-secret", factory).analyze(
                self._request()
            )
        self.assertEqual(raised.exception.code, "analysis_provider_error")
        self.assertNotIn(sentinel, "".join(traceback.format_exception(raised.exception)))
        self.assertNotIn(sentinel, repr(raised.exception.__context__))

        with self.assertRaises(AnalysisAdapterError) as raised:
            AnthropicAnalysisAdapter(
                self._settings(),
                "runtime-secret",
                lambda **kwargs: _PlainFailureClient(sentinel),
            ).analyze(self._request())
        self.assertEqual(raised.exception.code, "analysis_provider_error")
        self.assertNotIn(sentinel, repr(raised.exception.__context__))

    def test_keyboard_interrupt_from_factory_and_create_propagates(self) -> None:
        def interrupting_factory(
            *, api_key: str, base_url: str, timeout: float, max_retries: int
        ) -> NoReturn:
            raise KeyboardInterrupt("factory")

        with self.assertRaises(KeyboardInterrupt):
            OpenAIAnalysisAdapter(self._settings(), "runtime-secret", interrupting_factory).analyze(
                self._request()
            )

        with self.assertRaises(KeyboardInterrupt):
            OpenAIAnalysisAdapter(
                self._settings(),
                "runtime-secret",
                lambda **kwargs: _InterruptingClient(),
            ).analyze(self._request())

        with self.assertRaises(KeyboardInterrupt):
            AnthropicAnalysisAdapter(
                self._settings(), "runtime-secret", interrupting_factory
            ).analyze(self._request())

        with self.assertRaises(KeyboardInterrupt):
            AnthropicAnalysisAdapter(
                self._settings(),
                "runtime-secret",
                lambda **kwargs: _InterruptingClient(),
            ).analyze(self._request())


if __name__ == "__main__":
    import unittest

    unittest.main()
