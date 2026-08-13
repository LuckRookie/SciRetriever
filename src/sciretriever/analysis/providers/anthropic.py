"""Anthropic Messages API adapter for the Analysis-private LLM port."""

from __future__ import annotations

from sciretriever.analysis.ports import (
    AnalysisLLMCall,
    LLMProviderLimits,
    canonical_json_bytes,
    parse_strict_json_object,
)
from sciretriever.analysis.providers import (
    ANTHROPIC_ACCESS_SCOPE,
    ANTHROPIC_BASELINE_ACCESS_POLICY,
    ANTHROPIC_CREDENTIAL_ORIGIN,
    ANTHROPIC_ENDPOINT,
    ProviderHttpAdapterBase,
    provider_failure,
)
from sciretriever.model.access import Header
from sciretriever.network.admission import AccessPolicy
from sciretriever.network.http import HttpClient

_PROVIDER_NAME = "anthropic"
_PROTOCOL_REVISION = "messages-2023-06-01"
_ANTHROPIC_VERSION = "2023-06-01"


class AnthropicAnalysisLLMAdapter(ProviderHttpAdapterBase):
    """Bounded Anthropic Messages API implementation with no SDK dependency."""

    def __init__(
        self,
        *,
        http_client: HttpClient,
        api_key: str,
        limits: LLMProviderLimits | None = None,
        access_policy: AccessPolicy | None = None,
    ) -> None:
        super().__init__(
            http_client=http_client,
            api_key=api_key,
            limits=limits or LLMProviderLimits(),
            access_policy=access_policy,
            provider_name=_PROVIDER_NAME,
            endpoint=ANTHROPIC_ENDPOINT,
            credential_origin=ANTHROPIC_CREDENTIAL_ORIGIN,
            access_scope=ANTHROPIC_ACCESS_SCOPE,
            baseline_policy=ANTHROPIC_BASELINE_ACCESS_POLICY,
            protocol_revision=_PROTOCOL_REVISION,
        )

    def _safe_headers(self) -> tuple[Header, ...]:
        return (
            Header(name="Accept", value="application/json"),
            Header(name="Content-Type", value="application/json"),
            Header(name="Anthropic-Version", value=_ANTHROPIC_VERSION),
        )

    def _credential_headers(self) -> tuple[tuple[str, str], ...]:
        return (("X-Api-Key", self._api_key),)

    def _build_request_body(self, call: AnalysisLLMCall) -> bytes:
        schema = parse_strict_json_object(call.response_schema)
        return canonical_json_bytes(
            {
                "model": call.request.model,
                "max_tokens": call.request.max_output_tokens,
                "system": call.prompt,
                "messages": [
                    {
                        "role": "user",
                        "content": call.structured_input,
                    }
                ],
                "output_config": {
                    "format": {
                        "type": "json_schema",
                        "schema": schema,
                    }
                },
            }
        )

    def _parse_result(self, body: bytes, call: AnalysisLLMCall) -> str:
        try:
            root = parse_strict_json_object(body)
        except (TypeError, ValueError):
            raise provider_failure("protocol") from None

        if root.get("type") != "message" or root.get("role") != "assistant":
            raise provider_failure("protocol")
        if root.get("model") != call.request.model:
            raise provider_failure("model-mismatch")
        stop_reason = root.get("stop_reason")
        if stop_reason == "refusal":
            raise provider_failure("refusal")
        if stop_reason == "max_tokens":
            raise provider_failure("truncated")
        if stop_reason not in {"end_turn", "stop_sequence"}:
            raise provider_failure("protocol")

        content = root.get("content")
        if not isinstance(content, list) or len(content) != 1:
            raise provider_failure("protocol")
        block = content[0]
        if not isinstance(block, dict):
            raise provider_failure("protocol")
        text = block.get("text")
        if block.get("type") != "text" or type(text) is not str:
            raise provider_failure("protocol")
        return text

    def _provider_parameters(self) -> dict[str, object]:
        return {
            "anthropic_version": _ANTHROPIC_VERSION,
            "structured_output": "output-config-json-schema",
        }


__all__ = ("AnthropicAnalysisLLMAdapter",)
