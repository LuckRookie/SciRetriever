from __future__ import annotations

import json
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Protocol

import anthropic
import openai

import sciretriever.model.llm as llm_models
from sciretriever.content.api import (
    AnalysisBounds,
    AnalysisValidationError,
    analysis_json_schema,
    validate_analysis_input,
    validate_analysis_text,
)
from sciretriever.model.analysis import AnalysisProposalV1
from sciretriever.model.documents import LightDocumentV1
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


class _OpenAICompletions(Protocol):
    def create(self, **kwargs) -> _OpenAIResponse: ...


class _OpenAIChat(Protocol):
    @property
    def completions(self) -> _OpenAICompletions: ...


class _OpenAIClient(Protocol):
    @property
    def chat(self) -> _OpenAIChat: ...


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


class _AnthropicMessages(Protocol):
    def create(self, **kwargs) -> _AnthropicResponse: ...


class _AnthropicClient(Protocol):
    @property
    def messages(self) -> _AnthropicMessages: ...


class _AnthropicFactory(Protocol):
    def __call__(
        self, *, api_key: str, base_url: str, timeout: float, max_retries: int
    ) -> _AnthropicClient: ...


class _OpenAISdkCompletions:
    def __init__(self, client: openai.OpenAI) -> None:
        self._client = client

    def create(self, **kwargs):
        return self._client.chat.completions.create(**kwargs)


class _OpenAISdkChat:
    def __init__(self, client: openai.OpenAI) -> None:
        self._completions = _OpenAISdkCompletions(client)

    @property
    def completions(self) -> _OpenAISdkCompletions:
        return self._completions


class _OpenAISdkClient:
    def __init__(self, client: openai.OpenAI) -> None:
        self._chat = _OpenAISdkChat(client)

    @property
    def chat(self) -> _OpenAISdkChat:
        return self._chat


class _AnthropicSdkMessages:
    def __init__(self, client: anthropic.Anthropic) -> None:
        self._client = client

    def create(self, **kwargs):
        return self._client.messages.create(**kwargs)


class _AnthropicSdkClient:
    def __init__(self, client: anthropic.Anthropic) -> None:
        self._messages = _AnthropicSdkMessages(client)

    @property
    def messages(self) -> _AnthropicSdkMessages:
        return self._messages


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
    max_source_units: int


class AnalysisAdapterError(Exception):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code

    def __str__(self) -> str:
        return self.code


def _bounds(config: AnalysisAdapterSettings) -> AnalysisBounds:
    return AnalysisBounds(
        config.max_input_characters,
        config.max_source_units,
        config.max_output_tokens * 16,
    )


def _input(request: llm_models.LLMRequest, config: AnalysisAdapterSettings) -> str:
    try:
        return validate_analysis_input(request.document, _bounds(config))
    except AnalysisValidationError as error:
        raise AnalysisAdapterError(error.code) from None


def _proposal(
    payload: str, document: LightDocumentV1, config: AnalysisAdapterSettings
) -> AnalysisProposalV1:
    if not payload.strip() or not payload.lstrip().startswith("{"):
        raise AnalysisAdapterError("analysis_invalid_content")
    try:
        return validate_analysis_text(payload, document, _bounds(config))
    except AnalysisValidationError as error:
        raise AnalysisAdapterError(error.code) from None


def _provenance(
    provider: str, request: llm_models.LLMRequest, source: str
) -> llm_models.LLMProvenance:
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
        input_sha256=sha256_digest(source.encode("ascii")),
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
        source = _input(request, self._config)
        try:
            client = self._factory(
                api_key=self._secret,
                base_url=self._config.base_url,
                timeout=self._config.timeout_seconds,
                max_retries=0,
            )
            response = client.chat.completions.create(
                model=request.model,
                messages=(
                    {
                        "role": "system",
                        "content": (
                            "Return one complete analysis object grounded only in the supplied "
                            "LightDocumentV1."
                        ),
                    },
                    {"role": "user", "content": source},
                ),
                response_format={
                    "type": "json_schema",
                    "json_schema": {
                        "name": "analysis_proposal_v1",
                        "schema": analysis_json_schema(),
                        "strict": True,
                    },
                },
                max_completion_tokens=request.max_output_tokens,
            )
        except NotImplementedError:
            raise AnalysisAdapterError("capability_unavailable") from None
        except (openai.APIError, OSError, TimeoutError):
            raise AnalysisAdapterError("analysis_provider_error") from None
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
            if content is None:
                raise AnalysisAdapterError("analysis_invalid_content")
        except (AttributeError, IndexError, TypeError):
            raise AnalysisAdapterError("analysis_unknown_response") from None
        return llm_models.LLMStructuredResponse(
            proposal=_proposal(content, request.document, self._config),
            provenance=_provenance("openai", request, source),
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
        source = _input(request, self._config)
        try:
            client = self._factory(
                api_key=self._secret,
                base_url=self._config.base_url,
                timeout=self._config.timeout_seconds,
                max_retries=0,
            )
            response = client.messages.create(
                model=request.model,
                max_tokens=request.max_output_tokens,
                messages=({"role": "user", "content": source},),
                output_config={"format": {"type": "json_schema", "schema": analysis_json_schema()}},
            )
        except NotImplementedError:
            raise AnalysisAdapterError("capability_unavailable") from None
        except (anthropic.APIError, OSError, TimeoutError):
            raise AnalysisAdapterError("analysis_provider_error") from None
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
        except (AttributeError, IndexError, TypeError):
            raise AnalysisAdapterError("analysis_unknown_response") from None
        return llm_models.LLMStructuredResponse(
            proposal=_proposal(text, request.document, self._config),
            provenance=_provenance("anthropic", request, source),
        )


__all__ = (
    "AnalysisAdapterError",
    "AnalysisAdapterSettings",
    "AnthropicAnalysisAdapter",
    "OpenAIAnalysisAdapter",
)
