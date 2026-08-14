"""OpenAI Chat Completions adapter for the Analysis-private LLM port."""

from __future__ import annotations

from sciretriever.analysis.ports import (
    AnalysisLLMCall,
    LLMProviderLimits,
    canonical_json_bytes,
    parse_strict_json_object,
)
from sciretriever.analysis.providers import (
    OPENAI_BASELINE_ACCESS_POLICY,
    ProviderHttpAdapterBase,
    analysis_http_connection,
    provider_failure,
)
from sciretriever.model.access import Header
from sciretriever.network.admission import AccessPolicy, AccessScope
from sciretriever.network.http import HttpClient

_PROVIDER_NAME = "openai"
_PROTOCOL_REVISION = "chat-completions-v1"


class OpenAIChatCompletionsAnalysisLLMAdapter(ProviderHttpAdapterBase):
    """Bounded Chat Completions implementation with strict JSON schema output."""

    def __init__(
        self,
        *,
        http_client: HttpClient,
        api_key: str | None,
        base_url: str = "https://api.openai.com/v1",
        limits: LLMProviderLimits | None = None,
        access_policy: AccessPolicy | None = None,
        provider_name: str = _PROVIDER_NAME,
        service_name: str = "chat-completions",
    ) -> None:
        endpoint, credential_origin, destination_policy = analysis_http_connection(
            base_url=base_url,
            endpoint_suffix="/chat/completions",
            api_key=api_key,
        )
        super().__init__(
            http_client=http_client,
            api_key=api_key,
            limits=limits or LLMProviderLimits(),
            access_policy=access_policy,
            provider_name=provider_name,
            endpoint=endpoint,
            credential_origin=credential_origin,
            destination_policy=destination_policy,
            access_scope=AccessScope(provider_name, "api", service_name),
            baseline_policy=OPENAI_BASELINE_ACCESS_POLICY,
            protocol_revision=_PROTOCOL_REVISION,
        )

    def _safe_headers(self) -> tuple[Header, ...]:
        return (
            Header(name="Accept", value="application/json"),
            Header(name="Content-Type", value="application/json"),
        )

    def _credential_headers(self) -> tuple[tuple[str, str], ...]:
        return () if self._api_key is None else (("Authorization", f"Bearer {self._api_key}"),)

    def _build_request_body(self, call: AnalysisLLMCall) -> bytes:
        schema = parse_strict_json_object(call.response_schema)
        return canonical_json_bytes(
            {
                "model": call.request.model,
                "messages": [
                    {"role": "developer", "content": call.prompt},
                    {"role": "user", "content": call.structured_input},
                ],
                "response_format": {
                    "type": "json_schema",
                    "json_schema": {
                        "name": f"sciretriever_{call.request.kind.value.replace('-', '_')}",
                        "strict": True,
                        "schema": schema,
                    },
                },
                "max_completion_tokens": call.request.max_output_tokens,
            }
        )

    def _parse_result(self, body: bytes, call: AnalysisLLMCall) -> str:
        try:
            root = parse_strict_json_object(body)
        except (TypeError, ValueError):
            raise provider_failure("protocol") from None
        model = root.get("model")
        if type(model) is not str or model != call.request.model:
            raise provider_failure("model-mismatch")
        choices = root.get("choices")
        if not isinstance(choices, list) or len(choices) != 1:
            raise provider_failure("protocol")
        choice = choices[0]
        if not isinstance(choice, dict) or choice.get("index") != 0:
            raise provider_failure("protocol")
        finish_reason = choice.get("finish_reason")
        if finish_reason == "length":
            raise provider_failure("truncated")
        if finish_reason != "stop":
            raise provider_failure("protocol")
        message = choice.get("message")
        if not isinstance(message, dict) or message.get("role") != "assistant":
            raise provider_failure("protocol")
        if message.get("refusal") not in {None, ""}:
            raise provider_failure("refusal")
        content = message.get("content")
        if type(content) is not str:
            raise provider_failure("protocol")
        return content

    def _provider_parameters(self) -> dict[str, object]:
        return {
            "instruction_role": "developer",
            "structured_output": "response-format-json-schema-strict",
        }


__all__ = ("OpenAIChatCompletionsAnalysisLLMAdapter",)
