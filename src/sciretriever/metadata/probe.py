"""Non-persistent evidence for explicit Metadata provider configuration probes.

Provider adapters own the official minimal request and response-envelope check.
This module only gives those adapters one neutral success/failure boundary.  It
deliberately carries no URL, response body, credential, timestamp, exception,
or business observation and has no persistence dependency.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Protocol, runtime_checkable

from sciretriever.metadata.ports import MetadataProviderFailure

_STABLE_NAME = re.compile(r"^[a-z][a-z0-9-]{0,127}$")


def system_probe_wall_clock() -> datetime:
    """Return current UTC time for Network-only response feedback.

    This clock is deliberately separate from the business observation clock.
    Its value is used only while interpreting provider response headers such
    as an HTTP-date ``Retry-After`` and never enters evidence or persistence.
    """

    return datetime.now(timezone.utc)


def probe_feedback_wall_time(clock: Callable[[], datetime]) -> datetime:
    """Read and validate an injected Network-only probe wall clock."""

    if not callable(clock):
        raise TypeError("probe wall clock must be callable")
    value = clock()
    if not isinstance(value, datetime) or value.tzinfo is None or value.utcoffset() is None:
        raise TypeError("probe wall clock must return an aware datetime")
    return value.astimezone(timezone.utc)


@dataclass(frozen=True, slots=True)
class MetadataProbeEvidence:
    """Successful, current-process evidence from one minimal Metadata probe."""

    provider_name: str
    network_reachable: bool = True
    authentication_accepted: bool = True
    api_product_usable: bool = True
    minimal_response_parseable: bool = True

    def __post_init__(self) -> None:
        if (
            type(self.provider_name) is not str
            or _STABLE_NAME.fullmatch(self.provider_name) is None
        ):
            raise ValueError("provider_name must be a stable provider key")
        checks = (
            self.network_reachable,
            self.authentication_accepted,
            self.api_product_usable,
            self.minimal_response_parseable,
        )
        if checks != (True, True, True, True):
            raise ValueError("successful Metadata probe evidence must be complete")


class MetadataProbeFailure(RuntimeError):
    """Stable failed probe checks without provider-private diagnostic material."""

    _MESSAGE = "metadata provider probe failed"

    def __init__(
        self,
        code: str,
        *,
        network_reachable: bool | None,
        authentication_accepted: bool | None,
        api_product_usable: bool | None,
        minimal_response_parseable: bool | None,
    ) -> None:
        if type(code) is not str or _STABLE_NAME.fullmatch(code) is None:
            raise ValueError("code must be a stable failure code")
        checks = (
            network_reachable,
            authentication_accepted,
            api_product_usable,
            minimal_response_parseable,
        )
        if any(value not in (True, False, None) for value in checks):
            raise TypeError("probe checks must be bool or None")
        if checks == (True, True, True, True):
            raise ValueError("failed Metadata probe cannot have all checks pass")
        terminal_seen = False
        for value in checks:
            if terminal_seen and value is not None:
                raise ValueError("failed Metadata probe checks must be sequential")
            if value is not True:
                terminal_seen = True
        super().__init__(self._MESSAGE)
        self.code = code
        self.network_reachable = network_reachable
        self.authentication_accepted = authentication_accepted
        self.api_product_usable = api_product_usable
        self.minimal_response_parseable = minimal_response_parseable

    def __repr__(self) -> str:
        return (
            "MetadataProbeFailure("
            f"code={self.code!r}, "
            f"network_reachable={self.network_reachable!r}, "
            f"authentication_accepted={self.authentication_accepted!r}, "
            f"api_product_usable={self.api_product_usable!r}, "
            "minimal_response_parseable="
            f"{self.minimal_response_parseable!r})"
        )


@runtime_checkable
class MetadataProbePort(Protocol):
    """Provider-local seam invoked only by an explicit configuration test."""

    @property
    def provider_name(self) -> str: ...

    def probe_metadata(self) -> MetadataProbeEvidence: ...


def run_metadata_probe(
    provider_name: str,
    operation: Callable[[], None],
    *,
    credential_present: bool,
) -> MetadataProbeEvidence:
    """Run one adapter-owned request and stabilize its expected failure.

    The translated exception is raised after leaving the provider exception
    handler so it retains no underlying exception context or response object.
    Programming errors remain visible to the caller instead of being mislabeled
    as provider diagnostics.
    """

    if type(provider_name) is not str or _STABLE_NAME.fullmatch(provider_name) is None:
        raise ValueError("provider_name must be a stable provider key")
    if not callable(operation):
        raise TypeError("operation must be callable")
    if type(credential_present) is not bool:
        raise TypeError("credential_present must be bool")
    failure: MetadataProbeFailure | None = None
    try:
        operation()
    except MetadataProviderFailure as error:
        failure = _translate_provider_failure(error, credential_present=credential_present)
    except Exception:
        failure = MetadataProbeFailure(
            "metadata-probe-failed",
            network_reachable=None,
            authentication_accepted=None,
            api_product_usable=None,
            minimal_response_parseable=None,
        )
    if failure is not None:
        raise failure from None
    return MetadataProbeEvidence(provider_name=provider_name)


def _translate_provider_failure(
    error: MetadataProviderFailure,
    *,
    credential_present: bool,
) -> MetadataProbeFailure:
    code = error.failure.code
    if code == "metadata-provider-access":
        checks = (False, None, None, None)
        output_code = "metadata-probe-network"
    elif code in {
        "metadata-provider-authentication",
        "metadata-provider-authentication-failed",
    }:
        checks = (True, False, None, None)
        output_code = "metadata-probe-authentication"
    elif code == "metadata-provider-access-denied":
        checks = (True, False, None, None) if credential_present else (True, True, False, None)
        output_code = (
            "metadata-probe-authentication" if credential_present else "metadata-probe-product"
        )
    elif code in {
        "metadata-provider-entitlement",
        "metadata-provider-entitlement-denied",
        "metadata-provider-query-rejected",
    }:
        checks = (True, True, False, None)
        output_code = "metadata-probe-product"
    elif code in {
        "metadata-provider-invalid-record",
        "metadata-provider-malformed-json",
        "metadata-provider-malformed-xml",
        "metadata-provider-protocol",
        "metadata-provider-response-too-large",
        "metadata-provider-unknown-shape",
        "metadata-provider-unsafe-xml",
    }:
        if code == "metadata-provider-response-too-large":
            checks = (True, None, None, None)
            output_code = "metadata-probe-response-too-large"
        else:
            checks = (True, True, True, False)
            output_code = "metadata-probe-response"
    elif code in {
        "metadata-provider-conflicting-header",
        "metadata-provider-http-status",
        "metadata-provider-throttled",
    }:
        checks = (True, None, None, None)
        output_code = "metadata-probe-provider"
    else:
        checks = (None, None, None, None)
        output_code = "metadata-probe-failed"
    return MetadataProbeFailure(
        output_code,
        network_reachable=checks[0],
        authentication_accepted=checks[1],
        api_product_usable=checks[2],
        minimal_response_parseable=checks[3],
    )


__all__ = (
    "MetadataProbeEvidence",
    "MetadataProbeFailure",
    "MetadataProbePort",
    "probe_feedback_wall_time",
    "run_metadata_probe",
    "system_probe_wall_clock",
)
