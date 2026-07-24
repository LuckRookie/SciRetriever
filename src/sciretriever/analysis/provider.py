"""Provider-neutral analysis protocol and OpenAI-compatible boundary adapter."""

from __future__ import annotations

from importlib import import_module
from typing import Any, Protocol

from sciretriever.errors import AnalysisError

from .contracts import AnalysisProviderRequest, AnalysisProviderResponse


class AnalysisProvider(Protocol):
    provider_name: str
    model: str

    def analyze(self, request: AnalysisProviderRequest) -> AnalysisProviderResponse: ...


class OpenAICompatibleAnalysisProvider:
    provider_name = "openai_compatible"

    def __init__(self, *, api_key: str, base_url: str, model: str, timeout: float) -> None:
        if not all(isinstance(value, str) and value.strip() for value in (api_key, base_url, model)):
            raise ValueError("api_key, base_url, and model must be non-blank")
        if not isinstance(timeout, (int, float)) or isinstance(timeout, bool) or timeout <= 0:
            raise ValueError("timeout must be positive")
        self.model = model
        openai_class: Any = getattr(import_module("openai"), "OpenAI")
        self._client = openai_class(api_key=api_key, base_url=base_url, timeout=float(timeout), max_retries=0)

    def analyze(self, request: AnalysisProviderRequest) -> AnalysisProviderResponse:
        try:
            response = self._client.chat.completions.create(
                model=self.model,
                messages=[{"role": "system", "content": request.system_prompt},
                          {"role": "user", "content": request.input_json}],
                temperature=0,
                max_completion_tokens=request.max_completion_tokens,
                response_format={"type": "json_schema", "json_schema": {
                    "name": "sciretriever_analysis", "strict": True, "schema": request.response_schema}},
            )
            content = response.choices[0].message.content
            if not isinstance(content, str) or not content.strip():
                raise AnalysisError("analysis provider returned empty structured content")
            if len(content) > request.max_completion_tokens * 16:
                raise AnalysisError("analysis provider response exceeds character bound")
            response_model = response.model
            if not isinstance(response_model, str) or response_model != self.model:
                raise AnalysisError("analysis provider returned an unexpected model identity")
            return AnalysisProviderResponse(content, self.provider_name, self.model)
        except AnalysisError:
            raise
        except Exception as error:
            raise AnalysisError(f"analysis provider request failed ({type(error).__name__})") from None


__all__ = ("AnalysisProvider", "OpenAICompatibleAnalysisProvider")
