"""Shared, Analysis-private mechanics for concrete LLM HTTP adapters.

Concrete protocol envelopes live in :mod:`.openai` and :mod:`.anthropic`.
This package-level support keeps the security-sensitive Network call, budgets,
stable failures, credential binding, and provenance hashing identical without
creating a project-wide LLM infrastructure module.
"""

from __future__ import annotations

import ipaddress
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime

from sciretriever.analysis.ports import (
    AnalysisLLMCall,
    AnalysisLLMFailure,
    LLMProviderLimits,
    canonical_json_bytes,
    parse_strict_json_object,
    utf8_size,
)
from sciretriever.model.access import AccessFailure, Header, TransportResponse
from sciretriever.model.llm import LLMProvenance, LLMStructuredResponse
from sciretriever.model.primitives import sha256_digest
from sciretriever.model.report import StableFailure
from sciretriever.network.admission import (
    AccessFeedback,
    AccessPolicy,
    AccessScope,
)
from sciretriever.network.http import HttpClient
from sciretriever.network.policy import (
    AddressClass,
    DestinationPolicy,
    Origin,
    PolicyError,
    normalize_url_with_configured_port,
)

OPENAI_ACCESS_SCOPE = AccessScope(
    provider_name="openai",
    channel="api",
    service_name="responses",
)
ANTHROPIC_ACCESS_SCOPE = AccessScope(
    provider_name="anthropic",
    channel="api",
    service_name="messages",
)
OPENAI_BASELINE_ACCESS_POLICY = AccessPolicy(max_concurrency=1)
ANTHROPIC_BASELINE_ACCESS_POLICY = AccessPolicy(max_concurrency=1)

OPENAI_ENDPOINT = "https://api.openai.com/v1/responses"
ANTHROPIC_ENDPOINT = "https://api.anthropic.com/v1/messages"
OPENAI_CREDENTIAL_ORIGIN = Origin("https", "api.openai.com", 443)
ANTHROPIC_CREDENTIAL_ORIGIN = Origin("https", "api.anthropic.com", 443)

_FAILURES: dict[str, tuple[str, str, str, bool]] = {
    "credentials": (
        "analysis-llm-credentials",
        "The Analysis language-model credential is missing or invalid.",
        "Configure a valid Analysis provider credential before retrying.",
        False,
    ),
    "prompt-budget": (
        "analysis-llm-prompt-budget",
        "The private Analysis prompt exceeded its configured byte budget.",
        "Reduce the prompt or raise the bounded provider limit.",
        False,
    ),
    "input-budget": (
        "analysis-llm-input-budget",
        "The structured Analysis input exceeded its configured byte budget.",
        "Reduce the input or split the Analysis operation.",
        False,
    ),
    "schema-budget": (
        "analysis-llm-schema-budget",
        "The Analysis response schema exceeded its configured byte budget.",
        "Reduce the private response schema before retrying.",
        False,
    ),
    "request-budget": (
        "analysis-llm-request-budget",
        "The serialized provider request exceeded its configured byte budget.",
        "Reduce the bounded Analysis request before retrying.",
        False,
    ),
    "response-budget": (
        "analysis-llm-response-budget",
        "The provider response exceeded its configured byte budget.",
        "Reduce the requested output size before retrying.",
        False,
    ),
    "result-budget": (
        "analysis-llm-result-budget",
        "The structured provider result exceeded its configured byte budget.",
        "Reduce the requested structured output before retrying.",
        False,
    ),
    "token-budget": (
        "analysis-llm-token-budget",
        "The requested output token count exceeded its configured upper bound.",
        "Reduce the requested output token count before retrying.",
        False,
    ),
    "context-budget": (
        "analysis-llm-context-budget",
        "The complete Analysis request exceeded the configured context window.",
        "Reduce the input or output reserve, or configure the verified model context window.",
        False,
    ),
    "access": (
        "analysis-llm-access",
        "The language-model provider could not be reached through safe access.",
        "Retry later or review the provider readiness.",
        True,
    ),
    "timeout": (
        "analysis-llm-timeout",
        "The language-model provider operation timed out.",
        "Retry later or reduce the bounded request.",
        True,
    ),
    "authentication": (
        "analysis-llm-authentication",
        "The language-model provider did not authenticate this request.",
        "Review the provider credential readiness before retrying.",
        False,
    ),
    "authorization": (
        "analysis-llm-authorization",
        "The language-model provider did not authorize this request.",
        "Review the provider account and model readiness before retrying.",
        False,
    ),
    "quota": (
        "analysis-llm-quota",
        "The language-model provider throttled or exhausted this access scope.",
        "Retry after the shared access policy permits another request.",
        True,
    ),
    "http-status": (
        "analysis-llm-http-status",
        "The language-model provider returned an unsuccessful status.",
        "Retry later or review the provider readiness.",
        True,
    ),
    "refusal": (
        "analysis-llm-refusal",
        "The language-model provider refused the structured Analysis request.",
        "Review the private Analysis prompt before retrying.",
        False,
    ),
    "truncated": (
        "analysis-llm-truncated",
        "The language-model provider truncated the structured result.",
        "Adjust the bounded output request before retrying.",
        False,
    ),
    "protocol": (
        "analysis-llm-protocol",
        "The language-model provider returned an unsupported response structure.",
        "Update the provider adapter before retrying.",
        False,
    ),
    "model-mismatch": (
        "analysis-llm-model-mismatch",
        "The language-model provider returned a different model identity.",
        "Review the configured provider model before retrying.",
        False,
    ),
    "structured-response": (
        "analysis-llm-structured-response",
        "The language-model provider result was not one complete strict object.",
        "Retry the request or update the provider adapter.",
        True,
    ),
}


def provider_failure(kind: str, *, retryable: bool | None = None) -> AnalysisLLMFailure:
    try:
        code, reason, action, default_retryable = _FAILURES[kind]
    except KeyError:
        raise ValueError("unknown Analysis provider failure kind") from None
    return AnalysisLLMFailure(
        StableFailure(
            code=code,
            reason=reason,
            action=action,
            retryable=default_retryable if retryable is None else retryable,
        )
    )


class ProviderHttpAdapterBase:
    """Common safe access path for one fixed provider protocol and origin."""

    __slots__ = (
        "_access_policy",
        "_access_scope",
        "_api_key",
        "_credential_origin",
        "_destination_policy",
        "_endpoint",
        "_http_client",
        "_limits",
        "_protocol_revision",
        "_provider_name",
    )

    def __init__(
        self,
        *,
        http_client: HttpClient,
        api_key: str | None,
        limits: LLMProviderLimits,
        access_policy: AccessPolicy | None,
        provider_name: str,
        endpoint: str,
        credential_origin: Origin | None,
        destination_policy: DestinationPolicy,
        access_scope: AccessScope,
        baseline_policy: AccessPolicy,
        protocol_revision: str,
    ) -> None:
        if not isinstance(http_client, HttpClient):
            raise TypeError("http_client must be an HttpClient")
        if not isinstance(limits, LLMProviderLimits):
            raise TypeError("limits must be LLMProviderLimits")
        if access_policy is not None and not isinstance(access_policy, AccessPolicy):
            raise TypeError("access_policy must be an AccessPolicy or None")
        self._http_client = http_client
        if api_key is None:
            if credential_origin is not None:
                raise provider_failure("credentials")
            self._api_key = None
        else:
            if credential_origin is None:
                raise provider_failure("credentials")
            self._api_key = _private_api_key(api_key)
        self._limits = limits
        self._access_policy = (
            baseline_policy
            if access_policy is None
            else AccessPolicy.strictest(baseline_policy, access_policy)
        )
        self._provider_name = provider_name
        self._endpoint = endpoint
        self._credential_origin = credential_origin
        self._destination_policy = destination_policy
        self._access_scope = access_scope
        self._protocol_revision = protocol_revision

    def __repr__(self) -> str:
        return f"<{type(self).__name__} credentialed={self._api_key is not None}>"

    @property
    def provider_name(self) -> str:
        return self._provider_name

    def complete(self, call: AnalysisLLMCall) -> LLMStructuredResponse:
        if not isinstance(call, AnalysisLLMCall):
            raise TypeError("call must be an AnalysisLLMCall")
        self._check_call_budgets(call)
        body = self._build_request_body(call)
        if type(body) is not bytes:
            raise TypeError("provider request builder must return bytes")
        if len(body) > self._limits.max_request_bytes:
            raise provider_failure("request-budget")

        result = self._request(call, body)
        structured_result = self._parse_result(result.body, call)
        if type(structured_result) is not str:
            raise TypeError("provider response parser must return text")
        try:
            result_size = utf8_size(structured_result)
        except ValueError:
            raise provider_failure("structured-response") from None
        if result_size > self._limits.max_result_bytes:
            raise provider_failure("result-budget")
        try:
            parse_strict_json_object(structured_result)
        except (TypeError, ValueError):
            raise provider_failure("structured-response") from None

        return LLMStructuredResponse(
            result=structured_result,
            provenance=LLMProvenance(
                provider=self._provider_name,
                model=call.request.model,
                input_sha256=call.request.input_sha256,
                parameters_sha256=sha256_digest(self._parameter_bytes(call)),
            ),
        )

    def _request(self, call: AnalysisLLMCall, body: bytes) -> TransportResponse:
        result = self._http_client.request(
            self._access_scope,
            self._endpoint,
            self._access_policy,
            method="POST",
            headers=self._safe_headers(),
            credential_headers=self._credential_headers(),
            credential_allowed_origins=(
                () if self._credential_origin is None else (self._credential_origin,)
            ),
            body=body,
            destination_policy=self._destination_policy,
            connect_timeout_seconds=self._limits.connect_timeout_seconds,
            read_timeout_seconds=self._limits.read_timeout_seconds,
            overall_timeout_seconds=self._limits.overall_timeout_seconds,
            max_response_bytes=self._limits.max_response_bytes,
            max_redirects=self._limits.max_redirects,
            max_retries=self._limits.max_retries,
            cancel_event=call.cancel_event,
            response_feedback=_response_feedback,
        )
        if isinstance(result, AccessFailure):
            if result.code == "oversize":
                raise provider_failure("response-budget")
            if result.code == "timeout":
                raise provider_failure("timeout")
            raise provider_failure("access", retryable=result.retryable)
        if not isinstance(result, TransportResponse):
            raise TypeError("HttpClient returned an unsupported result")
        _raise_http_status(result.status)
        return result

    def _check_call_budgets(self, call: AnalysisLLMCall) -> None:
        values = (
            (call.prompt, self._limits.max_prompt_bytes, "prompt-budget"),
            (call.structured_input, self._limits.max_input_bytes, "input-budget"),
            (call.response_schema, self._limits.max_schema_bytes, "schema-budget"),
        )
        for value, maximum, failure_kind in values:
            if utf8_size(value) > maximum:
                raise provider_failure(failure_kind)
        if call.request.max_output_tokens > self._limits.max_output_tokens:
            raise provider_failure("token-budget")
        request_tokens = _conservative_token_estimate(
            utf8_size(call.prompt)
            + utf8_size(call.structured_input)
            + utf8_size(call.response_schema)
        )
        if request_tokens + call.request.max_output_tokens > self._limits.context_window_tokens:
            raise provider_failure("context-budget")

    def _parameter_bytes(self, call: AnalysisLLMCall) -> bytes:
        effective_schema = canonical_json_bytes(parse_strict_json_object(call.response_schema))
        return canonical_json_bytes(
            {
                "provider": self._provider_name,
                "protocol_revision": self._protocol_revision,
                "model": call.request.model,
                "request_kind": call.request.kind.value,
                "prompt_version": call.prompt_version,
                "prompt_sha256": str(sha256_digest(call.prompt.encode("utf-8"))),
                "response_schema_sha256": str(sha256_digest(effective_schema)),
                "max_output_tokens": call.request.max_output_tokens,
                "provider_parameters": self._provider_parameters(),
                "endpoint_sha256": str(sha256_digest(self._endpoint.encode("utf-8"))),
                "context_window_tokens": self._limits.context_window_tokens,
            }
        )

    def _safe_headers(self) -> tuple[Header, ...]:
        raise NotImplementedError

    def _credential_headers(self) -> tuple[tuple[str, str], ...]:
        raise NotImplementedError

    def _build_request_body(self, call: AnalysisLLMCall) -> bytes:
        raise NotImplementedError

    def _parse_result(self, body: bytes, call: AnalysisLLMCall) -> str:
        raise NotImplementedError

    def _provider_parameters(self) -> dict[str, object]:
        raise NotImplementedError


def _private_api_key(value: object) -> str:
    if type(value) is not str:
        raise provider_failure("credentials")
    try:
        encoded = value.encode("ascii", errors="strict")
    except UnicodeEncodeError:
        raise provider_failure("credentials") from None
    if (
        not encoded
        or len(encoded) > 8_192
        or value != value.strip()
        or any(
            character.isspace() or ord(character) < 33 or ord(character) > 126
            for character in value
        )
    ):
        raise provider_failure("credentials")
    return value


def _conservative_token_estimate(byte_count: int) -> int:
    if type(byte_count) is not int or byte_count < 0:
        raise TypeError("byte_count must be a non-negative integer")
    return (byte_count + 2) // 3


def analysis_http_connection(
    *,
    base_url: str,
    endpoint_suffix: str,
    api_key: str | None,
) -> tuple[str, Origin | None, DestinationPolicy]:
    """Build one exact LLM endpoint and its fail-closed destination policy."""

    if type(endpoint_suffix) is not str or not endpoint_suffix.startswith("/"):
        raise provider_failure("protocol")
    try:
        base = normalize_url_with_configured_port(
            base_url,
            allowed_schemes=("http", "https"),
        )
    except (PolicyError, TypeError, ValueError):
        raise provider_failure("protocol") from None
    if base.query:
        raise provider_failure("protocol")
    endpoint_text = base.url.rstrip("/") + endpoint_suffix
    try:
        endpoint = normalize_url_with_configured_port(
            endpoint_text,
            allowed_schemes=(base.scheme,),
        )
    except (PolicyError, TypeError, ValueError):
        raise provider_failure("protocol") from None
    if endpoint.origin != base.origin or endpoint.query:
        raise provider_failure("protocol")
    try:
        address = ipaddress.ip_address(base.hostname)
    except ValueError:
        address = None
    loopback = base.hostname == "localhost" or bool(address is not None and address.is_loopback)
    if base.scheme == "http":
        if not loopback or api_key is not None:
            raise provider_failure("credentials")
        allowed_addresses = (
            frozenset({"127.0.0.1", "::1"})
            if base.hostname == "localhost"
            else frozenset({str(address)})
        )
        policy = DestinationPolicy(
            allowed_schemes=frozenset({"http"}),
            allowed_classes=frozenset({AddressClass.LOOPBACK}),
            allowed_addresses=allowed_addresses,
            allowed_ports=frozenset({("http", base.port)}),
        )
        return endpoint.url, None, policy
    if loopback or address is not None or api_key is None:
        raise provider_failure("credentials")
    policy = DestinationPolicy(
        allowed_schemes=frozenset({"https"}),
        allowed_classes=frozenset({AddressClass.PUBLIC}),
        allowed_ports=frozenset({("https", base.port)}),
    )
    return endpoint.url, base.origin, policy


def _response_feedback(response: TransportResponse) -> AccessFeedback | None:
    if response.status != 429:
        return None
    values = [
        header.value.strip()
        for header in response.headers
        if header.name.casefold() == "retry-after"
    ]
    if not values or any(value != values[0] for value in values[1:]):
        return AccessFeedback(throttled=True)
    delay = _retry_after_delay(values[0])
    return AccessFeedback(retry_after=delay, throttled=True)


def _retry_after_delay(value: str) -> float | None:
    if value.isascii() and value.isdecimal():
        try:
            return float(int(value, 10))
        except (OverflowError, ValueError):
            return None
    try:
        parsed = parsedate_to_datetime(value)
    except (TypeError, ValueError, OverflowError):
        return None
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        return None
    return max(0.0, (parsed - datetime.now(timezone.utc)).total_seconds())


def _raise_http_status(status: int) -> None:
    if status == 200:
        return
    if status == 401:
        raise provider_failure("authentication")
    if status == 403:
        raise provider_failure("authorization")
    if status == 408:
        raise provider_failure("timeout")
    if status == 429:
        raise provider_failure("quota")
    raise provider_failure("http-status", retryable=status >= 500)


__all__ = (
    "ANTHROPIC_ACCESS_SCOPE",
    "ANTHROPIC_BASELINE_ACCESS_POLICY",
    "OPENAI_ACCESS_SCOPE",
    "OPENAI_BASELINE_ACCESS_POLICY",
)
