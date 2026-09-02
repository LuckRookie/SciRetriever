"""Compact, actionable diagnoses for configuration-test payloads."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Mapping
from urllib.parse import urlsplit


@dataclass(frozen=True, slots=True)
class ProbeDiagnosis:
    """The small set of facts a person needs after one configuration test."""

    request: str
    reason: str
    action: str | None = None

    def mapping(self) -> dict[str, object]:
        payload: dict[str, object] = {
            "request": self.request,
            "reason": self.reason,
        }
        if self.action is not None:
            payload["action"] = self.action
        return payload


def _mapping(value: object) -> Mapping[str, object]:
    return value if isinstance(value, Mapping) else {}


def _mapping_sequence(value: object) -> tuple[Mapping[str, object], ...]:
    if not isinstance(value, (list, tuple)):
        return ()
    return tuple(item for item in value if isinstance(item, Mapping))


def _safe_request_url(value: object) -> str | None:
    if type(value) is not str or not value or len(value) > 4_096:
        return None
    try:
        parsed = urlsplit(value)
    except ValueError:
        return None
    if (
        parsed.scheme not in {"http", "https"}
        or parsed.hostname is None
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
        or any(character.isspace() or ord(character) < 32 for character in value)
    ):
        return None
    return value


def _request_summary(item: Mapping[str, object]) -> str:
    details = _mapping(item.get("details"))
    method = details.get("request_method")
    url = _safe_request_url(details.get("request_url"))
    if method in {"GET", "POST"} and url is not None:
        request = f"{method} {url}"
        stream = details.get("stream")
        if method == "POST" and type(stream) is bool:
            request += f"\nStream · {'on' if stream else 'off'}"
        return request
    if item.get("capability") == "acquisition":
        return "Not sent"
    if item.get("capability") == "metadata":
        return "Bounded Metadata API request"
    if "access_key" in item:
        return "One approved Browser navigation"
    return "Not sent"


def _passed_diagnosis(item: Mapping[str, object], request: str) -> ProbeDiagnosis:
    details = _mapping(item.get("details"))
    request_kind = details.get("request_kind")
    if request_kind == "model-catalog":
        count = details.get("catalog_count")
        count_text = str(count) if type(count) is int else "the returned"
        return ProbeDiagnosis(
            request,
            f"Provider catalog request succeeded; {count_text} Model IDs were parsed.",
        )
    if request_kind == "model-text" or details.get("role") == "analysis":
        return ProbeDiagnosis(
            request,
            "Provider accepted the Model request and returned a valid strict response.",
        )
    if request_kind in {"model-image", "browser-agent-tool"}:
        return ProbeDiagnosis(
            request,
            "Provider accepted the Model request and returned a valid image/tool decision.",
        )
    if item.get("service") == "mineru":
        return ProbeDiagnosis(
            request,
            "MinerU is reachable and reports healthy release 3.4.4 with protocol 2.",
        )
    if item.get("capability") == "metadata":
        return ProbeDiagnosis(
            request,
            "Source accepted the request and returned a parseable minimal response.",
        )
    if "access_key" in item:
        return ProbeDiagnosis(
            request,
            "Browser launched and reached the approved minimal site target.",
        )
    return ProbeDiagnosis(request, "The configuration test passed.")


def _skipped_diagnosis(item: Mapping[str, object], request: str) -> ProbeDiagnosis:
    code = str(item.get("failure_code") or "")
    if code == "acquisition-probe-unavailable":
        return ProbeDiagnosis(
            "Not sent",
            "No safe config-only Download request exists without a real Literature item.",
            "Use complete pdf to verify this Source with an actual Literature record.",
        )
    if code in {"missing-required-credential", "model-provider-not-ready"}:
        return ProbeDiagnosis(
            "Not sent",
            "The required API Key is missing or is not bound to this service origin.",
            "Configure the Key for the shown Provider Base URL, then retry.",
        )
    if code in {"model-not-ready", "analysis-not-ready"}:
        return ProbeDiagnosis(
            "Not sent",
            "No locally ready Model is selected for this test.",
            "Select a configured Model and verify its Provider Key.",
        )
    if code in {"model-image-not-ready", "browser-agent-not-ready"}:
        return ProbeDiagnosis(
            "Not sent",
            "The selected Browser Model is not locally ready for image input.",
            "Select an image-capable Model and complete its Provider setup.",
        )
    if code == "parser-not-ready":
        return ProbeDiagnosis(
            "Not sent",
            "MinerU configuration or its required credential is incomplete.",
            "Check the connection mode, Base URL, upload authorization, and token.",
        )
    if code.startswith("browser-") or code == "needs-new-runtime-profile":
        return ProbeDiagnosis(
            "Not sent",
            "The controlled Browser is not locally ready.",
            "Complete the Browser runtime and Profile setup shown in Browser Status.",
        )
    return ProbeDiagnosis(
        "Not sent",
        "The request was not sent because local configuration is incomplete.",
        "Complete this area's required settings and retry.",
    )


def _remote_error_diagnosis(
    remote_error: str,
    *,
    status: int,
    request: str,
) -> ProbeDiagnosis | None:
    text = {
        "model-not-found": (
            f"HTTP {status}: Provider was reached, but the configured Model was not found.",
            "Check the exact Model name; Model IDs are case-sensitive on some Providers.",
        ),
        "model-rejected": (
            f"HTTP {status}: Provider rejected the configured Model value.",
            "Check the exact Model name and account access to that Model.",
        ),
        "reasoning-unsupported": (
            f"HTTP {status}: This Model or API does not accept the configured reasoning value.",
            "Change the Model reasoning setting to default and retry.",
        ),
        "structured-output-unsupported": (
            f"HTTP {status}: This Model or API rejected strict structured output.",
            "Choose a Model/API with strict JSON schema support.",
        ),
        "tool-unsupported": (
            f"HTTP {status}: This Model or API rejected the required tool decision.",
            "Choose a Browser Model/API with tool support.",
        ),
        "image-unsupported": (
            f"HTTP {status}: This Model or API rejected image input.",
            "Choose an image-capable Model and verify the Model declaration.",
        ),
        "request-rejected": (
            f"HTTP {status}: Provider rejected the Model request.",
            "Check the Model name, reasoning setting, and requested capability.",
        ),
    }.get(remote_error)
    if text is None:
        return None
    return ProbeDiagnosis(request, text[0], text[1])


def _http_diagnosis(  # noqa: C901 - explicit status families are the UX contract.
    item: Mapping[str, object],
    *,
    status: int,
    remote_error: str,
    request: str,
) -> ProbeDiagnosis:
    classified = _remote_error_diagnosis(
        remote_error,
        status=status,
        request=request,
    )
    if classified is not None:
        return classified
    details = _mapping(item.get("details"))
    if item.get("service") == "mineru":
        if status == 404:
            return ProbeDiagnosis(
                request,
                "HTTP 404: MinerU was reached, but the health endpoint was not found.",
                "Check the MinerU Base URL and confirm the protocol-2 service is running.",
            )
        return ProbeDiagnosis(
            request,
            f"HTTP {status}: MinerU returned an unexpected status for its health endpoint.",
            "Check the MinerU service, Base URL, and access settings.",
        )
    request_kind = details.get("request_kind")
    if status == 400 or status == 422:
        return ProbeDiagnosis(
            request,
            f"HTTP {status}: Provider rejected the Model request.",
            "Check the Model name, reasoning setting, and requested capability.",
        )
    if status == 401:
        return ProbeDiagnosis(
            request,
            "HTTP 401: Provider did not accept the API Key.",
            "Replace the Key bound to this exact Provider origin.",
        )
    if status == 403:
        return ProbeDiagnosis(
            request,
            "HTTP 403: Provider denied this account or Model request.",
            "Check the Key scope, account permissions, and Model access.",
        )
    if status == 404 and request_kind == "model-catalog":
        return ProbeDiagnosis(
            request,
            "HTTP 404: Provider was reached, but the Model catalog endpoint was not found.",
            "Check the Provider Base URL and API compatibility.",
        )
    if status == 404:
        return ProbeDiagnosis(
            request,
            "HTTP 404: Provider was reached, but the Model or API endpoint was not found.",
            "Check the exact Model name first, then the Provider Base URL and API type.",
        )
    if status == 405:
        return ProbeDiagnosis(
            request,
            "HTTP 405: This endpoint does not accept the selected API request.",
            "Check the Provider Base URL and API type.",
        )
    if status == 408:
        return ProbeDiagnosis(
            request,
            "HTTP 408: Provider timed out while handling the request.",
            "Retry later; if it repeats, check the Provider service.",
        )
    if status == 429:
        return ProbeDiagnosis(
            request,
            "HTTP 429: Provider rate limit or quota was reached.",
            "Wait for the limit to reset or review account quota.",
        )
    if 300 <= status <= 399:
        return ProbeDiagnosis(
            request,
            f"HTTP {status}: Provider returned an unexpected redirect.",
            "Configure the final Provider Base URL instead of a redirecting URL.",
        )
    if 500 <= status <= 599:
        return ProbeDiagnosis(
            request,
            f"HTTP {status}: Provider service failed after receiving the request.",
            "Retry later or check the Provider service status.",
        )
    return ProbeDiagnosis(
        request,
        f"HTTP {status}: The remote service returned an unexpected status.",
        "Check the shown request URL and the service's API documentation.",
    )


def _access_diagnosis(access_code: str, request: str) -> ProbeDiagnosis:
    if access_code == "tls":
        return ProbeDiagnosis(
            request,
            "TLS validation failed before the service could be reached.",
            "Check the hostname and certificate used by the shown request URL.",
        )
    if access_code == "policy":
        return ProbeDiagnosis(
            request,
            "The request could not reach an allowed destination "
            "(Base URL, DNS, or network policy).",
            "Check the shown URL, its DNS result, scheme, host, and port.",
        )
    if access_code in {"timeout", "admission"}:
        return ProbeDiagnosis(
            request,
            "The service connection timed out before a valid response arrived.",
            "Check connectivity to the shown URL and retry.",
        )
    if access_code == "transport":
        return ProbeDiagnosis(
            request,
            "A connection to the shown service URL could not be established.",
            "Check the Base URL, DNS, proxy/firewall, and whether the service is running.",
        )
    if access_code in {"oversize", "budget"}:
        return ProbeDiagnosis(
            request,
            "The service response exceeded the safe configuration-test limit.",
            "Check that the URL points to the expected API endpoint.",
        )
    return ProbeDiagnosis(
        request,
        "The request failed before a valid service response arrived.",
        "Check connectivity and the shown request URL, then retry.",
    )


def _source_failure_diagnosis(
    item: Mapping[str, object],
    request: str,
) -> ProbeDiagnosis:
    if item.get("network_reachable") is False:
        return ProbeDiagnosis(
            request,
            "The Source API could not be reached.",
            "Check network access to this Source and retry.",
        )
    if item.get("authentication_accepted") is False:
        return ProbeDiagnosis(
            request,
            "The Source API did not accept its configured credential.",
            "Replace or correct this Source's API Key.",
        )
    if item.get("api_product_usable") is False:
        return ProbeDiagnosis(
            request,
            "The Source was reached, but the configured API product is not usable.",
            "Check product selection, account entitlement, and request settings.",
        )
    if item.get("minimal_response_parseable") is False:
        return ProbeDiagnosis(
            request,
            "The Source responded, but its minimal response did not match the supported contract.",
            "Check Source API compatibility and retry.",
        )
    return ProbeDiagnosis(
        request,
        "The Source probe failed without enough safe evidence to identify one layer.",
        "Retry once; if it repeats, run with --debug and inspect the stable diagnostics.",
    )


def _failed_diagnosis(item: Mapping[str, object], request: str) -> ProbeDiagnosis:
    evidence = _mapping(item.get("failure_evidence"))
    status = evidence.get("http_status")
    remote_error = evidence.get("remote_error")
    if type(status) is int:
        return _http_diagnosis(
            item,
            status=status,
            remote_error=remote_error if type(remote_error) is str else "",
            request=request,
        )
    access_code = evidence.get("access_code")
    if type(access_code) is str:
        return _access_diagnosis(access_code, request)
    if item.get("capability") == "metadata":
        return _source_failure_diagnosis(item, request)
    if "access_key" in item:
        if item.get("browser_launched") is False:
            return ProbeDiagnosis(
                request,
                "The controlled Browser could not be launched.",
                "Check Browser Runtime and Profile status.",
            )
        return ProbeDiagnosis(
            request,
            "Browser launched, but the approved minimal site target was not reached.",
            "Check site connectivity and the selected Browser Profile.",
        )
    code = str(item.get("failure_code") or "")
    if code in {"agent-protocol", "agent-model-mismatch"}:
        return ProbeDiagnosis(
            request,
            "Provider responded, but the response did not match the selected API/Model contract.",
            "Check the Provider API type and exact Model name.",
        )
    if code in {
        "agent-structured-response",
        "analysis-llm-probe-contract",
        "browser-agent-probe-contract",
    }:
        return ProbeDiagnosis(
            request,
            "The Model responded, but the required structured result could not be validated.",
            "Check that this Model supports the tested structured-output or tool capability.",
        )
    if code == "mineru-protocol-invalid":
        return ProbeDiagnosis(
            request,
            "MinerU responded, but it is not the expected healthy 3.4.4 protocol-2 service.",
            "Check the MinerU deployment version, protocol, and Base URL.",
        )
    if code == "mineru-access-failed":
        return _access_diagnosis("transport", request)
    return ProbeDiagnosis(
        request,
        "The configuration test failed before it could validate the expected response.",
        "Check the shown request, local settings, and service compatibility.",
    )


def _diagnosis(item: Mapping[str, object]) -> ProbeDiagnosis:
    request = _request_summary(item)
    outcome = str(item.get("outcome", "failed"))
    if outcome == "passed":
        return _passed_diagnosis(item, request)
    if outcome == "skipped":
        return _skipped_diagnosis(item, request)
    return _failed_diagnosis(item, request)


def _diagnosed_item(item: Mapping[str, object]) -> dict[str, object]:
    result = dict(item)
    result["diagnosis"] = _diagnosis(item).mapping()
    return result


def diagnosed_probe_payload(payload: Mapping[str, object]) -> dict[str, object]:
    """Add the same compact diagnosis to human and JSON probe output."""

    if {"search", "download", "analyze", "parse"}.issubset(payload):
        result = dict(payload)
        for key in ("search", "download", "analyze", "parse", "browser"):
            child = payload.get(key)
            if isinstance(child, Mapping):
                result[key] = diagnosed_probe_payload(child)
        return result
    if "results" in payload:
        result = dict(payload)
        results = _mapping_sequence(payload.get("results"))
        result["results"] = [_diagnosed_item(item) for item in results]
        return result
    return _diagnosed_item(payload)


def diagnosis_lines(item: Mapping[str, object]) -> tuple[str, str, str | None]:
    """Return request, result reason, and optional next action for presentation."""

    diagnosis = _mapping(item.get("diagnosis"))
    if not diagnosis:
        diagnosis = _diagnosis(item).mapping()
    request = str(diagnosis.get("request") or "Not sent")
    reason = str(diagnosis.get("reason") or "No diagnosis available.")
    action_value = diagnosis.get("action")
    action = str(action_value) if type(action_value) is str else None
    return request, reason, action


__all__ = ("diagnosed_probe_payload", "diagnosis_lines", "ProbeDiagnosis")
