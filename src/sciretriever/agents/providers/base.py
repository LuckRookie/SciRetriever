"""Shared mechanics for concrete Agents protocol adapters.

Concrete protocol envelopes live in :mod:`.openai_responses`,
:mod:`.openai_chat` and :mod:`.anthropic`.
This package-level support keeps the security-sensitive Network call, budgets,
stable failures, credential binding, and provenance hashing identical without
creating a project-wide LLM infrastructure module.
"""

from __future__ import annotations

import base64
import ipaddress
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime

from sciretriever.agents.calls import (
    AgentCallLimits,
    AgentProvenance,
    AgentResult,
    AgentStructuredResult,
    AgentUsage,
)
from sciretriever.agents.capabilities import AgentCapability
from sciretriever.agents.failures import (
    AgentFailure,
    AgentRemoteErrorKind,
    agent_failure,
)
from sciretriever.agents.messages import AgentImagePart, utf8_size
from sciretriever.agents.ports import AgentProviderCall
from sciretriever.agents.tools import (
    AgentToolCall,
    canonical_json_bytes,
    parse_strict_json_object,
    validate_tool_arguments,
)
from sciretriever.logging.api import get_logger
from sciretriever.model.access import AccessFailure, Header, TransportResponse
from sciretriever.model.primitives import sha256_digest
from sciretriever.network.admission import (
    AccessFeedback,
    AccessPolicy,
    AccessScope,
)
from sciretriever.network.http import HttpClient
from sciretriever.network.policy import (
    AddressClass,
    DestinationPolicy,
    NormalizedURL,
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

provider_failure = agent_failure
_LOGGER = get_logger("sciretriever.agents")
_MAX_ERROR_CLASSIFICATION_BYTES = 64 * 1024


@dataclass(frozen=True, slots=True)
class _ParsedResult:
    """Protocol-neutral result before provenance is attached."""

    text: str | None = None
    tool_name: str | None = None
    tool_arguments: str | None = None
    usage: AgentUsage = AgentUsage()

    @classmethod
    def structured(cls, text: str, usage: AgentUsage) -> _ParsedResult:
        return cls(text=text, usage=usage)

    @classmethod
    def tool(cls, name: str, arguments: str, usage: AgentUsage) -> _ParsedResult:
        return cls(tool_name=name, tool_arguments=arguments, usage=usage)


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
        limits: AgentCallLimits,
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
        if not isinstance(limits, AgentCallLimits):
            raise TypeError("limits must be AgentCallLimits")
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

    def execute(self, call: AgentProviderCall) -> AgentResult:
        """Execute exactly one Runtime-bound call through this Provider protocol."""

        if not isinstance(call, AgentProviderCall):
            raise TypeError("call must be an AgentProviderCall")
        started = time.monotonic()
        try:
            self._check_capabilities(call)
            limits = self._effective_limits(call)
            self._check_call_budgets(call, limits)
            _LOGGER.debug(
                "event=agent-call-started role=%s provider=%s wire_model=%s "
                "protocol=%s stream=%s capabilities=%s reasoning_effort=%s "
                "input_bytes=%d schema_bytes=%d tool_count=%d image_count=%d "
                "max_output_tokens=%d timeout_seconds=%.3f",
                call.role.value,
                self._provider_name,
                call.model,
                self._protocol_revision,
                _stream_label(call.stream),
                _capability_names(call),
                call.reasoning_effort.value,
                _request_input_bytes(call),
                utf8_size(call.response_schema or ""),
                len(call.tools),
                len(call.image_parts),
                call.max_output_tokens,
                limits.overall_timeout_seconds,
            )
            body = self._build_request_body(call)
            if type(body) is not bytes:
                raise TypeError("provider request builder must return bytes")
            if len(body) > limits.max_request_bytes:
                raise provider_failure("request-budget")
            result = self._request(call, body, limits)
            response = self._response(result.body, call, limits)
        except AgentFailure as error:
            self._log_failure(call, error, started)
            raise
        except Exception:
            _LOGGER.debug(
                "event=agent-call-finished role=%s provider=%s wire_model=%s "
                "protocol=%s stream=%s capabilities=%s reasoning_effort=%s "
                "outcome=failed code=agent-internal retryable=false elapsed_ms=%d "
                "reason=The Agent adapter encountered an internal error. "
                "action=Review the Debug transcript and adapter implementation.",
                call.role.value,
                self._provider_name,
                call.model,
                self._protocol_revision,
                _stream_label(call.stream),
                _capability_names(call),
                call.reasoning_effort.value,
                int((time.monotonic() - started) * 1000),
            )
            raise
        usage = response.provenance.usage
        result_kind = "tool" if isinstance(response, AgentToolCall) else "structured"
        _LOGGER.debug(
            "event=agent-call-finished role=%s provider=%s wire_model=%s "
            "protocol=%s stream=%s capabilities=%s reasoning_effort=%s "
            "outcome=success result=%s input_tokens=%d output_tokens=%d "
            "response_bytes=%d elapsed_ms=%d",
            call.role.value,
            self._provider_name,
            call.model,
            self._protocol_revision,
            _stream_label(call.stream),
            _capability_names(call),
            call.reasoning_effort.value,
            result_kind,
            usage.input_tokens,
            usage.output_tokens,
            usage.response_bytes,
            int((time.monotonic() - started) * 1000),
        )
        return response

    def _log_failure(
        self,
        call: AgentProviderCall,
        error: AgentFailure,
        started: float,
    ) -> None:
        evidence_format = ""
        evidence_values: list[object] = []
        if error.http_status is not None:
            evidence_format += " http_status=%d"
            evidence_values.append(error.http_status)
        if error.access_code is not None:
            evidence_format += " access_code=%s"
            evidence_values.append(error.access_code)
        if error.remote_error is not None:
            evidence_format += " remote_error=%s"
            evidence_values.append(error.remote_error)
        failure = error.failure
        _LOGGER.debug(
            "event=agent-call-finished role=%s provider=%s wire_model=%s "
            "protocol=%s stream=%s capabilities=%s reasoning_effort=%s "
            "outcome=failed code=%s retryable=%s"
            + evidence_format
            + " elapsed_ms=%d reason=%s action=%s",
            call.role.value,
            self._provider_name,
            call.model,
            self._protocol_revision,
            _stream_label(call.stream),
            _capability_names(call),
            call.reasoning_effort.value,
            failure.code,
            str(failure.retryable).lower(),
            *evidence_values,
            int((time.monotonic() - started) * 1000),
            failure.reason,
            failure.action,
        )

    @staticmethod
    def _check_capabilities(call: AgentProviderCall) -> None:
        if AgentCapability.STRUCTURED_TEXT not in call.capabilities and (
            AgentCapability.TOOL_DECISION not in call.capabilities
        ):
            raise provider_failure("capability")
        if AgentCapability.STRUCTURED_TEXT in call.capabilities and call.response_schema is None:
            raise provider_failure("capability")
        if AgentCapability.TOOL_DECISION in call.capabilities and not call.tools:
            raise provider_failure("capability")
        if AgentCapability.STRUCTURED_TEXT in call.capabilities and call.tools:
            raise provider_failure("capability")
        if AgentCapability.IMAGE_INPUT in call.capabilities and not call.image_parts:
            raise provider_failure("capability")

    def _response(
        self,
        body: bytes,
        call: AgentProviderCall,
        limits: AgentCallLimits,
    ) -> AgentResult:
        parsed = self._parse_result(body, call)
        if not isinstance(parsed, _ParsedResult):
            raise TypeError("provider response parser returned an unsupported value")
        _validate_usage(parsed.usage, call, limits)
        provenance = AgentProvenance(
            provider=self._provider_name,
            model=call.model,
            input_sha256=call.input_sha256,
            parameters_sha256=sha256_digest(self._parameter_bytes(call, limits)),
            usage=AgentUsage(
                input_tokens=parsed.usage.input_tokens,
                output_tokens=parsed.usage.output_tokens,
                response_bytes=len(body),
            ),
        )
        if call.tools:
            return self._tool_response(parsed, call, provenance, limits)
        return self._structured_response(parsed, provenance, limits)

    @staticmethod
    def _tool_response(
        parsed: _ParsedResult,
        call: AgentProviderCall,
        provenance: AgentProvenance,
        limits: AgentCallLimits,
    ) -> AgentToolCall:
        if parsed.tool_name is None or parsed.tool_arguments is None:
            raise provider_failure("tool")
        declaration = next(
            (tool for tool in call.tools if tool.name == parsed.tool_name),
            None,
        )
        if declaration is None:
            raise provider_failure("tool")
        try:
            if utf8_size(parsed.tool_arguments) > limits.max_result_bytes:
                raise provider_failure("result-budget")
        except ValueError:
            raise provider_failure("tool") from None
        try:
            validate_tool_arguments(declaration, parsed.tool_arguments)
            return AgentToolCall(
                tool_name=parsed.tool_name,
                arguments=parsed.tool_arguments,
                provenance=provenance,
            )
        except (TypeError, ValueError):
            raise provider_failure("tool") from None

    def _structured_response(
        self,
        parsed: _ParsedResult,
        provenance: AgentProvenance,
        limits: AgentCallLimits,
    ) -> AgentStructuredResult:
        if parsed.text is None or parsed.tool_name is not None:
            raise provider_failure("structured-response")
        try:
            result_size = utf8_size(parsed.text)
        except ValueError:
            raise provider_failure("structured-response") from None
        if result_size > limits.max_result_bytes:
            raise provider_failure("result-budget")
        try:
            parse_strict_json_object(parsed.text)
            return AgentStructuredResult(result=parsed.text, provenance=provenance)
        except (TypeError, ValueError):
            raise provider_failure("structured-response") from None

    def _request(
        self,
        call: AgentProviderCall,
        body: bytes,
        limits: AgentCallLimits,
    ) -> TransportResponse:
        result = self._http_client.request(
            self._access_scope,
            self._endpoint,
            self._access_policy,
            method="POST",
            headers=self._safe_headers(call),
            credential_headers=self._credential_headers(),
            credential_allowed_origins=(
                () if self._credential_origin is None else (self._credential_origin,)
            ),
            body=body,
            destination_policy=self._destination_policy,
            connect_timeout_seconds=limits.connect_timeout_seconds,
            read_timeout_seconds=limits.read_timeout_seconds,
            overall_timeout_seconds=limits.overall_timeout_seconds,
            max_response_bytes=limits.max_response_bytes,
            max_redirects=limits.max_redirects,
            max_retries=limits.max_retries,
            cancel_event=call.cancel_event,
            response_feedback=_response_feedback,
        )
        if isinstance(result, AccessFailure):
            if result.code == "oversize":
                raise provider_failure("response-budget", access_code=result.code)
            if result.code == "timeout":
                raise provider_failure("timeout", access_code=result.code)
            if result.code == "cancelled":
                raise provider_failure("cancelled", access_code=result.code)
            raise provider_failure(
                "access",
                retryable=result.retryable,
                access_code=result.code,
            )
        if not isinstance(result, TransportResponse):
            raise TypeError("HttpClient returned an unsupported result")
        _raise_http_status(result.status, result.body)
        return result

    def _effective_limits(self, call: AgentProviderCall) -> AgentCallLimits:
        """Apply the stricter of adapter and Runtime-bound single-call limits.

        The adapter limits protect the configured provider lane while every
        call may impose smaller role-specific limits.  Taking the minimum
        at the boundary prevents a permissive adapter default from defeating a
        Runtime-bound call contract.
        """

        return AgentCallLimits.stricter(self._limits, call.limits)

    def _check_call_budgets(
        self,
        call: AgentProviderCall,
        limits: AgentCallLimits,
    ) -> None:
        if utf8_size(call.prompt) > limits.max_prompt_bytes:
            raise provider_failure("input-budget")
        input_bytes = sum(utf8_size(part.text) for part in call.text_parts)
        input_bytes += sum(len(part.data) for part in call.image_parts)
        input_bytes += len(_tools_bytes(call))
        if input_bytes > limits.max_input_bytes:
            raise provider_failure("input-budget")
        if (
            call.response_schema is not None
            and utf8_size(call.response_schema) > limits.max_schema_bytes
        ):
            raise provider_failure("input-budget")
        if call.max_output_tokens > limits.max_output_tokens:
            raise provider_failure("output-budget")
        request_tokens = _conservative_token_estimate(
            input_bytes + utf8_size(call.response_schema or "")
        )
        if request_tokens + call.max_output_tokens > limits.context_window_tokens:
            raise provider_failure("context-budget")

    def _parameter_bytes(
        self,
        call: AgentProviderCall,
        limits: AgentCallLimits,
    ) -> bytes:
        effective_schema = canonical_json_bytes(
            parse_strict_json_object(call.response_schema or "{}")
        )
        return canonical_json_bytes(
            {
                "provider": self._provider_name,
                "protocol_revision": self._protocol_revision,
                "model": call.model,
                "role": call.role.value,
                "prompt_sha256": str(sha256_digest(call.prompt.encode("utf-8"))),
                "response_schema_sha256": str(sha256_digest(effective_schema)),
                "parts_sha256": str(sha256_digest(_parts_bytes(call))),
                "tools_sha256": str(sha256_digest(_tools_bytes(call))),
                "max_output_tokens": call.max_output_tokens,
                "reasoning_effort": call.reasoning_effort.value,
                "stream": call.stream,
                "provider_parameters": self._provider_parameters(),
                "endpoint_sha256": str(sha256_digest(self._endpoint.encode("utf-8"))),
                "context_window_tokens": limits.context_window_tokens,
            }
        )

    def _safe_headers(self, call: AgentProviderCall) -> tuple[Header, ...]:
        raise NotImplementedError

    def _credential_headers(self) -> tuple[tuple[str, str], ...]:
        raise NotImplementedError

    def _build_request_body(self, call: AgentProviderCall) -> bytes:
        raise NotImplementedError

    def _parse_result(self, body: bytes, call: AgentProviderCall) -> _ParsedResult:
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


def image_data_url(part: AgentImagePart) -> str:
    """Encode an already bounded image without exposing a filesystem path."""

    if not isinstance(part, AgentImagePart):
        raise TypeError("image part is invalid")
    encoded = base64.b64encode(part.data).decode("ascii")
    return f"data:{part.media_type};base64,{encoded}"


def openai_responses_input_parts(call: AgentProviderCall) -> list[dict[str, object]]:
    """Convert neutral text/image parts to Responses content blocks."""

    parts: list[dict[str, object]] = []
    # The first text part is the consumer's system/developer instruction and
    # is encoded separately by each protocol adapter.  Only subsequent text
    # parts belong to the user turn; putting the first part here would send the
    # same prompt twice and alter model behavior.
    for part in call.text_parts[1:]:
        parts.append({"type": "input_text", "text": part.text})
    for image in call.image_parts:
        parts.append({"type": "input_image", "image_url": image_data_url(image)})
    if not parts:
        raise provider_failure("input-budget")
    return parts


def openai_chat_input_parts(call: AgentProviderCall) -> list[dict[str, object]]:
    """Convert neutral text/image parts to Chat Completions content blocks."""

    parts: list[dict[str, object]] = []
    for part in call.text_parts[1:]:
        parts.append({"type": "text", "text": part.text})
    for image in call.image_parts:
        parts.append({"type": "image_url", "image_url": {"url": image_data_url(image)}})
    if not parts:
        raise provider_failure("input-budget")
    return parts


def anthropic_input_parts(call: AgentProviderCall) -> list[dict[str, object]]:
    """Convert neutral text/image parts to Anthropic content blocks."""

    parts: list[dict[str, object]] = []
    # ``call.prompt`` is encoded in Anthropic's top-level system field.  Do not
    # repeat it in the user message.
    for part in call.text_parts[1:]:
        parts.append({"type": "text", "text": part.text})
    for image in call.image_parts:
        encoded = base64.b64encode(image.data).decode("ascii")
        parts.append(
            {
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": image.media_type,
                    "data": encoded,
                },
            }
        )
    if not parts:
        raise provider_failure("input-budget")
    return parts


def tool_declarations(
    call: AgentProviderCall,
    *,
    anthropic: bool = False,
) -> list[dict[str, object]]:
    """Encode only closed, validated tool declarations."""

    result: list[dict[str, object]] = []
    for declaration in call.tools:
        schema = parse_strict_json_object(declaration.input_schema)
        if anthropic:
            result.append(
                {
                    "name": declaration.name,
                    "description": declaration.description,
                    "input_schema": schema,
                }
            )
        else:
            result.append(
                {
                    "type": "function",
                    "name": declaration.name,
                    "description": declaration.description,
                    "parameters": schema,
                    "strict": True,
                }
            )
    return result


def _parts_bytes(call: AgentProviderCall) -> bytes:
    values: list[dict[str, object]] = [
        {"media_type": part.media_type, "text": part.text} for part in call.text_parts
    ]
    values.extend(
        {
            "media_type": image.media_type,
            "width": image.width,
            "height": image.height,
            "sha256": str(sha256_digest(image.data)),
        }
        for image in call.image_parts
    )
    return canonical_json_bytes(values)


def _capability_names(call: AgentProviderCall) -> str:
    return ",".join(sorted(value.value for value in call.capabilities))


def _stream_label(enabled: bool) -> str:
    return "on" if enabled else "off"


def _request_input_bytes(call: AgentProviderCall) -> int:
    total = sum(utf8_size(part.text) for part in call.text_parts)
    total += sum(len(image.data) for image in call.image_parts)
    total += len(_tools_bytes(call))
    return total


def _tools_bytes(call: AgentProviderCall) -> bytes:
    return canonical_json_bytes(
        [
            {
                "name": declaration.name,
                "description": declaration.description,
                "schema": parse_strict_json_object(declaration.input_schema),
            }
            for declaration in call.tools
        ]
    )


def usage_from_payload(payload: object) -> AgentUsage:
    """Read bounded token counters without trusting arbitrary provider fields."""

    if not isinstance(payload, dict):
        raise provider_failure("protocol")
    missing = object()
    input_tokens = payload.get("input_tokens", payload.get("prompt_tokens", missing))
    output_tokens = payload.get("output_tokens", payload.get("completion_tokens", missing))
    if type(input_tokens) is not int or type(output_tokens) is not int:
        raise provider_failure("protocol")
    if input_tokens < 0 or output_tokens < 0 or input_tokens > 10**9 or output_tokens > 10**9:
        raise provider_failure("protocol")
    return AgentUsage(input_tokens=input_tokens, output_tokens=output_tokens)


def _validate_usage(
    usage: AgentUsage,
    call: AgentProviderCall,
    limits: AgentCallLimits,
) -> None:
    if not isinstance(usage, AgentUsage):
        raise provider_failure("protocol")
    if usage.output_tokens > call.max_output_tokens or usage.output_tokens > (
        limits.max_output_tokens
    ):
        raise provider_failure("output-budget")
    if usage.input_tokens + usage.output_tokens > limits.context_window_tokens:
        raise provider_failure("context-budget")


def _conservative_token_estimate(byte_count: int) -> int:
    if type(byte_count) is not int or byte_count < 0:
        raise TypeError("byte_count must be a non-negative integer")
    return byte_count


def _normalized_agent_endpoint(
    *,
    base_url: str,
    endpoint_suffix: str,
) -> tuple[NormalizedURL, NormalizedURL]:
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
    return base, endpoint


def agent_request_endpoint(*, base_url: str, endpoint_suffix: str) -> str:
    """Return the exact secret-free endpoint used by an Agent request."""

    _base, endpoint = _normalized_agent_endpoint(
        base_url=base_url,
        endpoint_suffix=endpoint_suffix,
    )
    return endpoint.url


def agent_http_connection(
    *,
    base_url: str,
    endpoint_suffix: str,
    api_key: str | None,
) -> tuple[str, Origin | None, DestinationPolicy]:
    """Build one exact LLM endpoint and its fail-closed destination policy."""

    base, endpoint = _normalized_agent_endpoint(
        base_url=base_url,
        endpoint_suffix=endpoint_suffix,
    )
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


def _remote_error_kind(status: int, body: bytes) -> AgentRemoteErrorKind | None:
    """Classify only bounded, known error fields without retaining provider text."""

    if not body or len(body) > _MAX_ERROR_CLASSIFICATION_BYTES:
        return None
    try:
        root = parse_strict_json_object(body)
    except (TypeError, ValueError):
        return None
    error = root.get("error")
    if not isinstance(error, dict):
        return None
    code = error.get("code")
    error_type = error.get("type")
    parameter = error.get("param")
    known_values = {
        value.casefold().replace("-", "_")
        for value in (code, error_type)
        if type(value) is str and len(value) <= 128
    }
    normalized_parameter = (
        parameter.casefold().replace("-", "_")
        if type(parameter) is str and len(parameter) <= 128
        else None
    )
    code_kinds: dict[str, AgentRemoteErrorKind] = {
        "image_not_supported": "image-unsupported",
        "model_not_found": "model-not-found",
        "reasoning_not_supported": "reasoning-unsupported",
        "response_format_not_supported": "structured-output-unsupported",
        "structured_output_not_supported": "structured-output-unsupported",
        "tool_not_supported": "tool-unsupported",
        "tools_not_supported": "tool-unsupported",
        "unknown_model": "model-not-found",
        "unsupported_reasoning": "reasoning-unsupported",
        "unsupported_response_format": "structured-output-unsupported",
        "vision_not_supported": "image-unsupported",
    }
    for value in known_values:
        classified = code_kinds.get(value)
        if classified is not None:
            return classified
    if normalized_parameter == "model":
        return "model-not-found" if status == 404 else "model-rejected"
    parameter_kinds: dict[str, AgentRemoteErrorKind] = {
        "functions": "tool-unsupported",
        "image": "image-unsupported",
        "image_url": "image-unsupported",
        "input_image": "image-unsupported",
        "reasoning": "reasoning-unsupported",
        "reasoning.effort": "reasoning-unsupported",
        "reasoning_effort": "reasoning-unsupported",
        "response_format": "structured-output-unsupported",
        "text.format": "structured-output-unsupported",
        "text_format": "structured-output-unsupported",
        "tool_choice": "tool-unsupported",
        "tools": "tool-unsupported",
    }
    if normalized_parameter is not None and normalized_parameter in parameter_kinds:
        return parameter_kinds[normalized_parameter]
    if known_values & {
        "bad_request",
        "invalid_request",
        "invalid_request_error",
        "unprocessable_entity",
    }:
        return "request-rejected"
    return None


def _raise_http_status(status: int, body: bytes = b"") -> None:
    if status == 200:
        return
    remote_error = _remote_error_kind(status, body) if status in {400, 404, 422} else None
    kind = {
        400: "request-rejected",
        401: "authentication",
        403: "authorization",
        404: "not-found",
        405: "endpoint",
        408: "timeout",
        422: "request-rejected",
        429: "quota",
    }.get(status)
    if kind is None and 300 <= status <= 399:
        kind = "redirect"
    if kind is None and 500 <= status <= 599:
        kind = "remote-service"
    if kind is not None:
        raise provider_failure(
            kind,
            http_status=status,
            remote_error=remote_error,
        )
    raise provider_failure(
        "http-status",
        retryable=False,
        http_status=status,
        remote_error=remote_error,
    )


__all__ = (
    "ANTHROPIC_ACCESS_SCOPE",
    "ANTHROPIC_BASELINE_ACCESS_POLICY",
    "OPENAI_ACCESS_SCOPE",
    "OPENAI_BASELINE_ACCESS_POLICY",
    "agent_http_connection",
    "agent_request_endpoint",
    "anthropic_input_parts",
    "image_data_url",
    "openai_chat_input_parts",
    "openai_responses_input_parts",
    "tool_declarations",
    "usage_from_payload",
    "ProviderHttpAdapterBase",
)
