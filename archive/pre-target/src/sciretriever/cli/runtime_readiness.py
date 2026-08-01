from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from enum import Enum
from importlib import import_module
from typing import Any, Protocol

import requests

from .runtime_probe_http import (
    HttpJsonProbe,
    ProbeIdentity,
    parse_crossref,
    parse_openalex,
    parse_semantic_scholar,
)
from sciretriever.config import SciRetrieverConfig, get_credential
from sciretriever.normalization import MinerUClient
from sciretriever.errors import MinerUError


MAX_RUNTIME_TIMEOUT = 30.0


class CapabilityKind(str, Enum):
    ACQUISITION = "acquisition"
    GRAPH = "graph"
    MINERU = "mineru"
    LLM = "llm"


class CapabilityProbe(Protocol):
    def probe(self, timeout: float) -> ProbeIdentity: ...


@dataclass(frozen=True, slots=True)
class RuntimeCheck:
    name: str
    status: str
    reason: str


@dataclass(frozen=True, slots=True)
class _MinerUProbe:
    client: MinerUClient

    def probe(self, timeout: float) -> ProbeIdentity:
        try:
            health = self.client.health(timeout)
        except MinerUError as error:
            raise RuntimeError(f"MinerU probe failed ({type(error).__name__})") from None
        return ProbeIdentity(f"mineru:{health.version}:{health.protocol_version}")


@dataclass(frozen=True, slots=True)
class _OpenAIModelProbe:
    api_key: str
    endpoint: str
    model: str

    def probe(self, timeout: float) -> ProbeIdentity:
        openai_module = import_module("openai")
        openai_class: Any = getattr(openai_module, "OpenAI")
        openai_error: Any = getattr(openai_module, "OpenAIError")
        client = openai_class(
            api_key=self.api_key,
            base_url=self.endpoint,
            timeout=timeout,
            max_retries=0,
        )
        try:
            response = client.models.retrieve(self.model)
        except openai_error as error:
            raise RuntimeError(f"LLM probe failed ({type(error).__name__})") from None
        identity = getattr(response, "id", None)
        if not isinstance(identity, str):
            raise RuntimeError("LLM identity response is invalid")
        return ProbeIdentity(identity)


@dataclass(frozen=True, slots=True)
class RuntimeReadiness:
    acquisition: Mapping[str, CapabilityProbe] = field(default_factory=dict)
    graph: Mapping[str, CapabilityProbe] = field(default_factory=dict)
    mineru: CapabilityProbe | None = None
    llm: CapabilityProbe | None = None

    @staticmethod
    def _run(
        kind: CapabilityKind,
        name: str,
        expected: str,
        expected_capabilities: frozenset[str],
        timeout: float,
        probe: CapabilityProbe | None,
    ) -> RuntimeCheck:
        check_name = f"runtime:{kind.value}:{name}"
        if probe is None:
            return RuntimeCheck(check_name, "invalid", "enabled capability runtime adapter is unavailable")
        try:
            result = probe.probe(min(timeout, MAX_RUNTIME_TIMEOUT))
        except (OSError, RuntimeError, TimeoutError, requests.RequestException) as error:
            return RuntimeCheck(
                check_name,
                "unreachable",
                f"bounded read-only probe failed ({type(error).__name__})",
            )
        if result.identity != expected:
            return RuntimeCheck(check_name, "invalid", "runtime identity mismatch")
        if not expected_capabilities.issubset(result.capabilities):
            return RuntimeCheck(check_name, "invalid", "runtime capability mismatch")
        return RuntimeCheck(
            check_name, "ready", "bounded read-only identity and capability probe succeeded"
        )

    def check(self, config: SciRetrieverConfig) -> tuple[RuntimeCheck, ...]:
        checks: list[RuntimeCheck] = []
        timeout = config.acquisition.preflight.timeout
        for provider in config.acquisition.providers or ():
            checks.append(self._run(
                CapabilityKind.ACQUISITION,
                provider,
                provider,
                frozenset({"acquisition"}),
                timeout,
                self.acquisition.get(provider),
            ))
        if config.expansion.depth > 0:
            for provider in config.search.providers or ():
                directions = (
                    frozenset({"graph:references", "graph:cited-by"})
                    if config.expansion.direction == "both"
                    else frozenset({f"graph:{config.expansion.direction}"})
                )
                checks.append(self._run(
                    CapabilityKind.GRAPH,
                    provider,
                    provider,
                    directions,
                    timeout,
                    self.graph.get(provider),
                ))
        mineru = config.analysis.mineru
        if mineru.mode != "disabled":
            checks.append(self._run(
                CapabilityKind.MINERU,
                "service",
                f"mineru:{mineru.service_version}:{mineru.api_protocol}",
                frozenset(),
                timeout,
                self.mineru,
            ))
        llm = config.analysis.llm
        if llm.endpoint is not None and llm.model is not None:
            checks.append(self._run(
                CapabilityKind.LLM,
                "model",
                llm.model,
                frozenset(),
                llm.timeout,
                self.llm,
            ))
        return tuple(checks)


_OPENALEX_PROBE = (
    "https://api.openalex.org/works/https://doi.org/10.1038/nature12373"
    "?select=id,referenced_works,cited_by_api_url"
)
_SEMANTIC_SCHOLAR_PROBE = (
    "https://api.semanticscholar.org/graph/v1/paper/DOI:10.1038/nature12373"
    "?fields=paperId,references.paperId,citations.paperId"
)


def build_runtime_readiness(
    config: SciRetrieverConfig,
    *,
    env: Mapping[str, str],
) -> RuntimeReadiness:
    acquisition: dict[str, CapabilityProbe] = {
        "crossref": HttpJsonProbe("https://api.crossref.org/works?rows=0", parse_crossref),
        "openalex": HttpJsonProbe(_OPENALEX_PROBE, parse_openalex),
        "semantic-scholar": HttpJsonProbe(_SEMANTIC_SCHOLAR_PROBE, parse_semantic_scholar),
    }
    graph: dict[str, CapabilityProbe] = {
        "openalex": HttpJsonProbe(_OPENALEX_PROBE, parse_openalex),
        "semantic-scholar": HttpJsonProbe(_SEMANTIC_SCHOLAR_PROBE, parse_semantic_scholar),
    }
    mineru_probe = None
    if config.analysis.mineru.mode != "disabled":
        mineru_probe = _MinerUProbe(MinerUClient(config.analysis.mineru, env=env))
    llm = config.analysis.llm
    llm_probe = None
    if llm.endpoint is not None and llm.model is not None and llm.credential_env is not None:
        credential = get_credential(llm.credential_env, env=env)
        if credential is not None:
            llm_probe = _OpenAIModelProbe(credential, llm.endpoint, llm.model)
    return RuntimeReadiness(acquisition, graph, mineru_probe, llm_probe)


__all__ = (
    "CapabilityKind",
    "CapabilityProbe",
    "ProbeIdentity",
    "RuntimeCheck",
    "RuntimeReadiness",
    "build_runtime_readiness",
)
