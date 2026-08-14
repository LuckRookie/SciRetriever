"""OpenAI Responses API adapter for the Analysis-private LLM port."""

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
from sciretriever.network.admission import AccessPolicy
from sciretriever.network.http import HttpClient

_PROVIDER_NAME = "openai"
_PROTOCOL_REVISION = "responses-v1"


class OpenAIAnalysisLLMAdapter(ProviderHttpAdapterBase):
    """Bounded OpenAI Responses API implementation with no SDK dependency."""

    def __init__(
        self,
        *,
        http_client: HttpClient,
        api_key: str | None,
        base_url: str = "https://api.openai.com/v1",
        limits: LLMProviderLimits | None = None,
        access_policy: AccessPolicy | None = None,
        provider_name: str = _PROVIDER_NAME,
        service_name: str = "responses",
    ) -> None:
        from sciretriever.network.admission import AccessScope

        endpoint, credential_origin, destination_policy = analysis_http_connection(
            base_url=base_url,
            endpoint_suffix="/responses",
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
                "input": [
                    {
                        "role": "developer",
                        "content": [{"type": "input_text", "text": call.prompt}],
                    },
                    {
                        "role": "user",
                        "content": [{"type": "input_text", "text": call.structured_input}],
                    },
                ],
                "text": {
                    "format": {
                        "type": "json_schema",
                        "name": f"sciretriever_{call.request.kind.value.replace('-', '_')}",
                        "strict": True,
                        "schema": schema,
                    }
                },
                "max_output_tokens": call.request.max_output_tokens,
            }
        )

    def _parse_result(self, body: bytes, call: AnalysisLLMCall) -> str:
        root = _response_root(body, call)
        return _message_text(_single_message(root.get("output")))

    def _provider_parameters(self) -> dict[str, object]:
        return {
            "instruction_role": "developer",
            "structured_output": "json-schema-strict",
        }


def _response_root(body: bytes, call: AnalysisLLMCall) -> dict[str, object]:
    try:
        root = parse_strict_json_object(body)
    except (TypeError, ValueError):
        raise provider_failure("protocol") from None
    if root.get("object") != "response":
        raise provider_failure("protocol")
    status = root.get("status")
    if status == "incomplete":
        details = root.get("incomplete_details")
        if isinstance(details, dict) and details.get("reason") == "max_output_tokens":
            raise provider_failure("truncated")
        raise provider_failure("protocol")
    if status != "completed":
        raise provider_failure("protocol")
    if root.get("model") != call.request.model:
        raise provider_failure("model-mismatch")
    return root


def _single_message(output: object) -> dict[str, object]:
    if not isinstance(output, list):
        raise provider_failure("protocol")
    messages: list[dict[str, object]] = []
    for item in output:
        if not isinstance(item, dict):
            raise provider_failure("protocol")
        item_type = item.get("type")
        if item_type == "message":
            messages.append(item)
        elif item_type != "reasoning":
            raise provider_failure("protocol")
    if len(messages) != 1:
        raise provider_failure("protocol")
    return messages[0]


def _message_text(message: dict[str, object]) -> str:
    if message.get("status") != "completed" or message.get("role") != "assistant":
        raise provider_failure("protocol")
    content = message.get("content")
    if not isinstance(content, list) or not content:
        raise provider_failure("protocol")
    if any(isinstance(item, dict) and item.get("type") == "refusal" for item in content):
        raise provider_failure("refusal")
    if len(content) != 1 or not isinstance(content[0], dict):
        raise provider_failure("protocol")
    output_text = content[0]
    text = output_text.get("text")
    if output_text.get("type") != "output_text" or type(text) is not str:
        raise provider_failure("protocol")
    return text


__all__ = ("OpenAIAnalysisLLMAdapter",)
