from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from sciretriever.analysis import AnalysisProvider, AnalysisService, OpenAICompatibleAnalysisProvider
from sciretriever.catalog import AssetRepository, CompletionFactsRepository
from sciretriever.catalog.engine import CatalogEngine
from sciretriever.config import AnalysisConfig, MinerUConfig, get_credential
from sciretriever.normalization import MinerUClient, MinerUParsingService, MinerUSourceMapService
from sciretriever.normalization.mineru_contracts import (
    MinerUHealth, MinerUResult, MinerUTask,
)
from sciretriever.normalization.mineru_service import MinerUServiceClient
from sciretriever.storage import DerivedArtifactStore, RawAssetStore


CredentialReader = Callable[[str], str | None]


class MinerUClientFactory(Protocol):
    def __call__(self, config: MinerUConfig) -> MinerUServiceClient: ...


class AnalysisProviderFactory(Protocol):
    def __call__(
        self, *, api_key: str, base_url: str, model: str, timeout: float,
    ) -> AnalysisProvider: ...


class MinerUClientAdapter:
    def __init__(self, client: MinerUClient) -> None:
        self.client = client

    def health(self, timeout: float) -> MinerUHealth | None:
        return self.client.health(timeout)

    def submit(self, filename: str, pdf: bytes, timeout: float) -> MinerUTask:
        return self.client.submit(filename, pdf, timeout)

    def status(self, task_id: str, timeout: float) -> MinerUTask | None:
        return self.client.status(task_id, timeout)

    def result(self, task_id: str, timeout: float) -> MinerUResult:
        return self.client.result(task_id, timeout)


def _mineru_client(config: MinerUConfig) -> MinerUServiceClient:
    return MinerUClientAdapter(MinerUClient(config))


def _analysis_provider(
    *, api_key: str, base_url: str, model: str, timeout: float,
) -> AnalysisProvider:
    return OpenAICompatibleAnalysisProvider(
        api_key=api_key, base_url=base_url, model=model, timeout=timeout)


@dataclass(frozen=True, slots=True)
class AnalysisCliRuntime:
    config: AnalysisConfig
    credential_reader: CredentialReader = get_credential
    mineru_client_factory: MinerUClientFactory = _mineru_client
    analysis_provider_factory: AnalysisProviderFactory = _analysis_provider


@dataclass(frozen=True, slots=True)
class AnalysisRuntimeServices:
    facts: CompletionFactsRepository
    assets: AssetRepository
    raw_store: RawAssetStore
    parsing: MinerUParsingService
    mapping: MinerUSourceMapService
    analysis: AnalysisService
    max_pdf_bytes: int

    def __post_init__(self) -> None:
        if type(self.max_pdf_bytes) is not int or self.max_pdf_bytes <= 0:
            raise ValueError("maximum PDF bytes must be positive")


def build_analysis_services(
    runtime: AnalysisCliRuntime, engine: CatalogEngine, root: Path,
) -> AnalysisRuntimeServices:
    config = runtime.config
    endpoint, model, credential_env = (
        config.llm.endpoint, config.llm.model, config.llm.credential_env,
    )
    if endpoint is None or model is None or credential_env is None:
        raise ValueError("analysis LLM target is incomplete")
    credential = runtime.credential_reader(credential_env)
    if credential is None:
        raise ValueError("analysis LLM credential is unavailable")
    raw_store, derived_store = RawAssetStore(root), DerivedArtifactStore(root)
    client = runtime.mineru_client_factory(config.mineru)
    provider = runtime.analysis_provider_factory(
        api_key=credential, base_url=endpoint, model=model, timeout=config.llm.timeout)
    return AnalysisRuntimeServices(
        facts=CompletionFactsRepository(engine),
        assets=AssetRepository(engine),
        raw_store=raw_store,
        parsing=MinerUParsingService(engine, derived_store, config.mineru, client),
        mapping=MinerUSourceMapService(engine, raw_store, derived_store),
        analysis=AnalysisService(
            engine, derived_store, provider,
            max_input_characters=config.llm.max_input_characters,
            max_source_units=config.llm.max_source_units,
            max_completion_tokens=config.llm.max_output_tokens,
            configuration={
                "endpoint": endpoint, "model": model, "timeout": config.llm.timeout,
            },
        ),
        max_pdf_bytes=config.mineru.max_upload_bytes,
    )


__all__ = (
    "AnalysisCliRuntime", "AnalysisProviderFactory", "AnalysisRuntimeServices", "CredentialReader",
    "MinerUClientAdapter", "MinerUClientFactory", "build_analysis_services",
)
