"""Bounded, non-persistent model discovery for Agent provider setup.

This adapter performs one explicit read-only ``GET /models`` through the
shared Network boundary.  It deliberately returns only small, secret-free
setup observations; the result is never a runtime model registry or a source
of implicit capability claims.
"""

from __future__ import annotations

from dataclasses import dataclass

from sciretriever.agents.messages import _model_identity
from sciretriever.agents.tools import parse_strict_json_object
from sciretriever.model.access import AccessFailure, Header, TransportResponse
from sciretriever.model.configuration import AgentProtocol, AgentReasoningEffort
from sciretriever.network.admission import AccessPolicy, AccessScope
from sciretriever.network.http import HttpClient

from .base import (
    ANTHROPIC_BASELINE_ACCESS_POLICY,
    OPENAI_BASELINE_ACCESS_POLICY,
    _private_api_key,
    _raise_http_status,
    _response_feedback,
    agent_http_connection,
    provider_failure,
)

_ANTHROPIC_VERSION = "2023-06-01"
_MAX_CATALOG_MODELS = 100
_MAX_RESPONSE_BYTES = 1_048_576


@dataclass(frozen=True, slots=True)
class AgentModelSummary:
    """One provider-reported model identity and optional capability hints."""

    model: str
    display_name: str | None = None
    context_window_tokens: int | None = None
    max_output_tokens: int | None = None
    image_input: bool | None = None
    reasoning_efforts: tuple[AgentReasoningEffort, ...] = ()
    reasoning_efforts_reported: bool = False

    def __post_init__(self) -> None:
        object.__setattr__(self, "model", _model_identity(self.model))
        if self.display_name is not None:
            object.__setattr__(self, "display_name", _model_identity(self.display_name))
        if self.context_window_tokens is not None and (
            type(self.context_window_tokens) is not int or self.context_window_tokens < 1_024
        ):
            raise ValueError("model context window is invalid")
        if self.max_output_tokens is not None and (
            type(self.max_output_tokens) is not int or self.max_output_tokens < 1
        ):
            raise ValueError("model output limit is invalid")
        if self.image_input is not None and type(self.image_input) is not bool:
            raise TypeError("model image capability must be bool or None")
        if not isinstance(self.reasoning_efforts, tuple) or any(
            not isinstance(value, AgentReasoningEffort)
            or value is AgentReasoningEffort.PROVIDER_DEFAULT
            for value in self.reasoning_efforts
        ):
            raise TypeError("model reasoning efforts are invalid")
        if len(self.reasoning_efforts) != len(set(self.reasoning_efforts)):
            raise ValueError("model reasoning efforts must be unique")
        if type(self.reasoning_efforts_reported) is not bool:
            raise TypeError("model reasoning effort report flag must be bool")
        if self.reasoning_efforts and not self.reasoning_efforts_reported:
            raise ValueError("model reasoning efforts require a provider report")


@dataclass(frozen=True, slots=True)
class AgentModelCatalog:
    """One bounded provider observation used only by the configuration UI."""

    models: tuple[AgentModelSummary, ...]
    truncated: bool = False

    def __post_init__(self) -> None:
        if not isinstance(self.models, tuple) or any(
            not isinstance(value, AgentModelSummary) for value in self.models
        ):
            raise TypeError("model catalog contains invalid entries")
        if len(self.models) > _MAX_CATALOG_MODELS:
            raise ValueError("model catalog exceeds its item limit")
        identities = tuple(value.model for value in self.models)
        if len(identities) != len(set(identities)):
            raise ValueError("model catalog identities must be unique")
        if type(self.truncated) is not bool:
            raise TypeError("model catalog truncated flag must be bool")


class AgentModelCatalogClient:
    """Read the current service's model list through one exact safe origin."""

    __slots__ = (
        "_access_policy",
        "_access_scope",
        "_api_key",
        "_credential_origin",
        "_destination_policy",
        "_endpoint",
        "_http_client",
        "_protocol",
    )

    def __init__(
        self,
        *,
        http_client: HttpClient,
        protocol: AgentProtocol,
        base_url: str,
        api_key: str | None,
        provider_name: str,
    ) -> None:
        if not isinstance(http_client, HttpClient):
            raise TypeError("http_client must be an HttpClient")
        if not isinstance(protocol, AgentProtocol):
            raise TypeError("protocol must be an AgentProtocol")
        checked_key = None if api_key is None else _private_api_key(api_key)
        endpoint, credential_origin, destination_policy = agent_http_connection(
            base_url=base_url,
            endpoint_suffix="/models",
            api_key=checked_key,
        )
        self._http_client = http_client
        self._protocol = protocol
        self._api_key = checked_key
        self._endpoint = endpoint
        self._credential_origin = credential_origin
        self._destination_policy = destination_policy
        self._access_scope = AccessScope(provider_name, "api", "models")
        baseline = (
            ANTHROPIC_BASELINE_ACCESS_POLICY
            if protocol is AgentProtocol.ANTHROPIC_MESSAGES
            else OPENAI_BASELINE_ACCESS_POLICY
        )
        self._access_policy = AccessPolicy.strictest(
            baseline,
            AccessPolicy(max_concurrency=1),
        )

    def __repr__(self) -> str:
        return f"<AgentModelCatalogClient credentialed={self._api_key is not None}>"

    def list_models(self) -> AgentModelCatalog:
        """Perform one bounded GET and strictly parse its first model page."""

        result = self._http_client.request(
            self._access_scope,
            self._endpoint,
            self._access_policy,
            method="GET",
            headers=self._safe_headers(),
            credential_headers=self._credential_headers(),
            credential_allowed_origins=(
                () if self._credential_origin is None else (self._credential_origin,)
            ),
            destination_policy=self._destination_policy,
            connect_timeout_seconds=5.0,
            read_timeout_seconds=10.0,
            overall_timeout_seconds=15.0,
            max_response_bytes=_MAX_RESPONSE_BYTES,
            max_redirects=0,
            follow_redirects=False,
            max_retries=0,
            response_feedback=_response_feedback,
        )
        if isinstance(result, AccessFailure):
            if result.code == "oversize":
                raise provider_failure("response-budget", access_code=result.code)
            if result.code == "timeout":
                raise provider_failure("timeout", access_code=result.code)
            raise provider_failure(
                "access",
                retryable=result.retryable,
                access_code=result.code,
            )
        if not isinstance(result, TransportResponse):
            raise TypeError("HttpClient returned an unsupported result")
        _raise_http_status(result.status, result.body)
        return (
            _anthropic_catalog(result.body)
            if self._protocol is AgentProtocol.ANTHROPIC_MESSAGES
            else _openai_catalog(result.body)
        )

    def _safe_headers(self) -> tuple[Header, ...]:
        headers = [Header(name="Accept", value="application/json")]
        if self._protocol is AgentProtocol.ANTHROPIC_MESSAGES:
            headers.append(Header(name="Anthropic-Version", value=_ANTHROPIC_VERSION))
        return tuple(headers)

    def _credential_headers(self) -> tuple[tuple[str, str], ...]:
        if self._api_key is None:
            return ()
        if self._protocol is AgentProtocol.ANTHROPIC_MESSAGES:
            return (("X-Api-Key", self._api_key),)
        return (("Authorization", f"Bearer {self._api_key}"),)


def _openai_catalog(body: bytes) -> AgentModelCatalog:
    root = _catalog_root(body)
    if root.get("object") != "list":
        raise provider_failure("protocol")
    entries = _catalog_entries(root)
    summaries = tuple(
        AgentModelSummary(model=_entry_model(entry)) for entry in entries[:_MAX_CATALOG_MODELS]
    )
    return _checked_catalog(summaries, truncated=len(entries) > _MAX_CATALOG_MODELS)


def _anthropic_catalog(body: bytes) -> AgentModelCatalog:
    root = _catalog_root(body)
    entries = _catalog_entries(root)
    has_more = root.get("has_more", False)
    if type(has_more) is not bool:
        raise provider_failure("protocol")
    summaries = tuple(_anthropic_summary(entry) for entry in entries[:_MAX_CATALOG_MODELS])
    return _checked_catalog(
        summaries,
        truncated=has_more or len(entries) > _MAX_CATALOG_MODELS,
    )


def _catalog_root(body: bytes) -> dict[str, object]:
    try:
        return parse_strict_json_object(body)
    except (TypeError, ValueError):
        raise provider_failure("protocol") from None


def _catalog_entries(root: dict[str, object]) -> list[dict[str, object]]:
    data = root.get("data")
    if not isinstance(data, list) or any(not isinstance(value, dict) for value in data):
        raise provider_failure("protocol")
    return data


def _entry_model(entry: dict[str, object]) -> str:
    value = entry.get("id")
    try:
        return _model_identity(value)
    except (TypeError, ValueError):
        raise provider_failure("protocol") from None


def _anthropic_summary(entry: dict[str, object]) -> AgentModelSummary:
    model = _entry_model(entry)
    display = entry.get("display_name")
    if display is not None:
        try:
            display = _model_identity(display)
        except (TypeError, ValueError):
            raise provider_failure("protocol") from None
    context = _optional_integer(entry, "max_input_tokens", minimum=1_024)
    max_output = _optional_integer(entry, "max_tokens", minimum=1)
    capabilities = entry.get("capabilities")
    if capabilities is not None and not isinstance(capabilities, dict):
        raise provider_failure("protocol")
    image_input = _capability_supported(capabilities, "image_input")
    reasoning_efforts, reasoning_efforts_reported = _reasoning_efforts(capabilities)
    try:
        return AgentModelSummary(
            model=model,
            display_name=display,
            context_window_tokens=context,
            max_output_tokens=max_output,
            image_input=image_input,
            reasoning_efforts=reasoning_efforts,
            reasoning_efforts_reported=reasoning_efforts_reported,
        )
    except (TypeError, ValueError):
        raise provider_failure("protocol") from None


def _optional_integer(
    value: dict[str, object],
    field: str,
    *,
    minimum: int,
) -> int | None:
    item = value.get(field)
    if item is None:
        return None
    if type(item) is not int or item < minimum:
        raise provider_failure("protocol")
    return item


def _capability_supported(
    capabilities: dict[str, object] | None,
    field: str,
) -> bool | None:
    if capabilities is None or field not in capabilities:
        return None
    item = capabilities[field]
    if not isinstance(item, dict) or type(item.get("supported")) is not bool:
        raise provider_failure("protocol")
    return item["supported"]


def _reasoning_efforts(
    capabilities: dict[str, object] | None,
) -> tuple[tuple[AgentReasoningEffort, ...], bool]:
    if capabilities is None or "effort" not in capabilities:
        return (), False
    effort = capabilities["effort"]
    if not isinstance(effort, dict) or type(effort.get("supported")) is not bool:
        raise provider_failure("protocol")
    values: list[AgentReasoningEffort] = []
    for level in (
        AgentReasoningEffort.LOW,
        AgentReasoningEffort.MEDIUM,
        AgentReasoningEffort.HIGH,
        AgentReasoningEffort.XHIGH,
        AgentReasoningEffort.MAX,
    ):
        item = effort.get(level.value)
        if item is None:
            continue
        if not isinstance(item, dict) or type(item.get("supported")) is not bool:
            raise provider_failure("protocol")
        if item["supported"]:
            values.append(level)
    if effort["supported"] is False and values:
        raise provider_failure("protocol")
    return tuple(values), True


def _checked_catalog(
    models: tuple[AgentModelSummary, ...],
    *,
    truncated: bool,
) -> AgentModelCatalog:
    try:
        return AgentModelCatalog(models=models, truncated=truncated)
    except (TypeError, ValueError):
        raise provider_failure("protocol") from None


__all__ = (
    "AgentModelCatalog",
    "AgentModelCatalogClient",
    "AgentModelSummary",
)
