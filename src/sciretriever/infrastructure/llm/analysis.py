# noqa: E501  # noqa: SIZE_OK - OpenAI and Anthropic adapters share one response-boundary contract.
from __future__ import annotations

import json
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Protocol, TypeVar

import anthropic
import openai
from pydantic import ValidationError

import sciretriever.model.llm as llm_models
from sciretriever.model.analysis import AnalysisProposalV1
from sciretriever.model.primitives import sha256_digest


class _OpenAIMessage(Protocol):
    content: str | None
    refusal: str | None


class _OpenAIChoice(Protocol):
    finish_reason: str | None
    message: _OpenAIMessage


class _OpenAIResponse(Protocol):
    model: str
    choices: Sequence[_OpenAIChoice]


class _OpenAIClient(Protocol):
    def create(self, **kwargs) -> _OpenAIResponse: ...


class _OpenAIFactory(Protocol):
    def __call__(
        self, *, api_key: str, base_url: str, timeout: float, max_retries: int
    ) -> _OpenAIClient: ...


class _AnthropicBlock(Protocol):
    type: str
    text: str


class _AnthropicResponse(Protocol):
    model: str
    stop_reason: str | None
    content: Sequence[_AnthropicBlock]


class _AnthropicClient(Protocol):
    def create(self, **kwargs) -> _AnthropicResponse: ...


class _AnthropicFactory(Protocol):
    def __call__(
        self, *, api_key: str, base_url: str, timeout: float, max_retries: int
    ) -> _AnthropicClient: ...


class _OpenAISdkClient:
    def __init__(self, client: openai.OpenAI) -> None:
        self._client = client

    def create(self, **kwargs) -> _OpenAIResponse:
        return self._client.chat.completions.create(**kwargs)


class _AnthropicSdkClient:
    def __init__(self, client: anthropic.Anthropic) -> None:
        self._client = client

    def create(self, **kwargs) -> _AnthropicResponse:
        return self._client.messages.create(**kwargs)


def _openai_factory(
    *, api_key: str, base_url: str, timeout: float, max_retries: int
) -> _OpenAIClient:
    return _OpenAISdkClient(
        openai.OpenAI(
            api_key=api_key,
            base_url=base_url,
            timeout=timeout,
            max_retries=max_retries,
        )
    )


def _anthropic_factory(
    *, api_key: str, base_url: str, timeout: float, max_retries: int
) -> _AnthropicClient:
    return _AnthropicSdkClient(
        anthropic.Anthropic(
            api_key=api_key,
            base_url=base_url,
            timeout=timeout,
            max_retries=max_retries,
        )
    )


@dataclass(frozen=True, slots=True)
class AnalysisAdapterSettings:
    base_url: str
    model: str
    timeout_seconds: float
    max_output_tokens: int
    max_input_characters: int


class AnalysisAdapterError(Exception):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code

    def __str__(self) -> str:
        return self.code


ResultT = TypeVar("ResultT")


def _provider_call(callback: Callable[[], ResultT]) -> ResultT:
    error_code = "analysis_provider_error"
    try:
        result = callback()
    except NotImplementedError:
        error_code = "capability_unavailable"
    except Exception:  # noqa: BLE001  # noqa: BROAD_EXCEPT_OK
        error_code = "analysis_provider_error"
    else:
        return result
    raise AnalysisAdapterError(error_code) from None


def _source(request: llm_models.LLMRequest, config: AnalysisAdapterSettings) -> str:
    if len(request.source) > config.max_input_characters:
        raise AnalysisAdapterError("analysis_input_too_large")
    return request.source


def _proposal(payload: str, config: AnalysisAdapterSettings) -> AnalysisProposalV1:
    if len(payload) > config.max_output_tokens * 16:
        raise AnalysisAdapterError("analysis_output_too_large")
    if not payload.strip() or not payload.lstrip().startswith("{"):
        raise AnalysisAdapterError("analysis_invalid_content")
    try:
        return AnalysisProposalV1.model_validate_json(payload)
    except ValidationError:
        raise AnalysisAdapterError("analysis_invalid_output") from None


def _provenance(provider: str, request: llm_models.LLMRequest) -> llm_models.LLMProvenance:
    parameters = json.dumps(
        {
            "max_output_tokens": request.max_output_tokens,
            "model": request.model,
        },
        ensure_ascii=True,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("ascii")
    return llm_models.LLMProvenance(
        provider=provider,
        model=request.model,
        input_sha256=request.input_sha256,
        parameters_sha256=sha256_digest(parameters),
    )


class OpenAIAnalysisAdapter:
    def __init__(
        self,
        config: AnalysisAdapterSettings,
        secret: str,
        client_factory: _OpenAIFactory | None = None,
    ) -> None:
        self._config = config
        self._secret = secret
        self._factory: _OpenAIFactory = client_factory or _openai_factory

    def analyze(self, request: llm_models.LLMRequest) -> llm_models.LLMStructuredResponse:
        source = _source(request, self._config)
        client = _provider_call(
            lambda: self._factory(
                api_key=self._secret,
                base_url=self._config.base_url,
                timeout=self._config.timeout_seconds,
                max_retries=0,
            )
        )
        response = _provider_call(
            lambda: client.create(
                model=request.model,
                messages=(
                    {
                        "role": "system",
                        "content": (
                            "Return one complete analysis object grounded only in the supplied "
                            "source."
                        ),
                    },
                    {"role": "user", "content": source},
                ),
                response_format={
                    "type": "json_schema",
                    "json_schema": {
                        "name": "analysis_proposal_v1",
                        "schema": AnalysisProposalV1.model_json_schema(),
                        "strict": True,
                    },
                },
                max_completion_tokens=request.max_output_tokens,
            )
        )
        try:
            if response.model != request.model:
                raise AnalysisAdapterError("analysis_model_mismatch")
            if len(response.choices) != 1:
                raise AnalysisAdapterError("analysis_unknown_response")
            choice = response.choices[0]
            if choice.message.refusal is not None:
                raise AnalysisAdapterError("analysis_refused")
            if choice.finish_reason != "stop":
                raise AnalysisAdapterError(
                    "analysis_truncated"
                    if choice.finish_reason == "length"
                    else "analysis_unknown_status"
                )
            content = choice.message.content
            if not isinstance(content, str):
                raise AnalysisAdapterError("analysis_invalid_content")
        except (AttributeError, IndexError, TypeError):
            raise AnalysisAdapterError("analysis_unknown_response") from None
        return llm_models.LLMStructuredResponse(
            proposal=_proposal(content, self._config),
            provenance=_provenance("openai", request),
        )


class AnthropicAnalysisAdapter:
    def __init__(
        self,
        config: AnalysisAdapterSettings,
        secret: str,
        client_factory: _AnthropicFactory | None = None,
    ) -> None:
        self._config = config
        self._secret = secret
        self._factory: _AnthropicFactory = client_factory or _anthropic_factory

    def analyze(self, request: llm_models.LLMRequest) -> llm_models.LLMStructuredResponse:
        source = _source(request, self._config)
        client = _provider_call(
            lambda: self._factory(
                api_key=self._secret,
                base_url=self._config.base_url,
                timeout=self._config.timeout_seconds,
                max_retries=0,
            )
        )
        response = _provider_call(
            lambda: client.create(
                model=request.model,
                max_tokens=request.max_output_tokens,
                messages=({"role": "user", "content": source},),
                output_config={
                    "format": {
                        "type": "json_schema",
                        "schema": AnalysisProposalV1.model_json_schema(),
                    }
                },
            )
        )
        try:
            if response.model != request.model:
                raise AnalysisAdapterError("analysis_model_mismatch")
            if response.stop_reason == "refusal":
                raise AnalysisAdapterError("analysis_refused")
            if response.stop_reason != "end_turn":
                raise AnalysisAdapterError(
                    "analysis_truncated"
                    if response.stop_reason == "max_tokens"
                    else "analysis_unknown_status"
                )
            if len(response.content) != 1:
                raise AnalysisAdapterError("analysis_unknown_response")
            block = response.content[0]
            if block.type != "text":
                raise AnalysisAdapterError(
                    "analysis_refused" if block.type == "refusal" else "analysis_unknown_block"
                )
            text = block.text
            if not isinstance(text, str):
                raise AnalysisAdapterError("analysis_invalid_content")
        except (AttributeError, IndexError, TypeError):
            raise AnalysisAdapterError("analysis_unknown_response") from None
        return llm_models.LLMStructuredResponse(
            proposal=_proposal(text, self._config),
            provenance=_provenance("anthropic", request),
        )


__all__ = (
    "AnalysisAdapterError",
    "AnalysisAdapterSettings",
    "AnthropicAnalysisAdapter",
    "OpenAIAnalysisAdapter",
)
