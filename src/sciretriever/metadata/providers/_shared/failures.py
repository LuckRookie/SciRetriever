"""Fixed, redacted failures shared by Metadata provider adapters.

Only expected access/protocol/data failures should be translated here.  The
helpers deliberately accept no URL, cursor, header, response body, exception,
or credential value, so a caller cannot accidentally interpolate private
provider material into a stable failure.  Programming exceptions and
BaseException subclasses remain outside this module and must propagate.
"""

from __future__ import annotations

from sciretriever.metadata.ports import MetadataProviderFailure
from sciretriever.model.access import AccessFailure
from sciretriever.model.report import StableFailure


def _fixed_failure(
    *,
    code: str,
    reason: str,
    action: str,
    retryable: bool,
) -> MetadataProviderFailure:
    return MetadataProviderFailure(
        StableFailure(
            code=code,
            reason=reason,
            action=action,
            retryable=retryable,
        )
    )


def access_failure_to_provider_failure(value: AccessFailure) -> MetadataProviderFailure:
    """Translate one already-neutral Network failure without copying its text."""

    if not isinstance(value, AccessFailure):
        raise TypeError("value must be an AccessFailure")
    if value.code == "oversize":
        return response_too_large_failure()
    return _fixed_failure(
        code="metadata-provider-access",
        reason="The metadata provider could not be reached through the safe access boundary.",
        action="Retry the metadata request or review the provider readiness.",
        retryable=value.retryable,
    )


def response_too_large_failure() -> MetadataProviderFailure:
    return _fixed_failure(
        code="metadata-provider-response-too-large",
        reason="The metadata provider response exceeded the parsing budget.",
        action="Reduce the request size or update the provider adapter.",
        retryable=False,
    )


def malformed_json_failure() -> MetadataProviderFailure:
    return _fixed_failure(
        code="metadata-provider-malformed-json",
        reason="The metadata provider returned malformed JSON.",
        action="Retry the request or update the provider adapter.",
        retryable=True,
    )


def malformed_xml_failure() -> MetadataProviderFailure:
    return _fixed_failure(
        code="metadata-provider-malformed-xml",
        reason="The metadata provider returned malformed XML.",
        action="Retry the request or update the provider adapter.",
        retryable=True,
    )


def unsafe_xml_failure() -> MetadataProviderFailure:
    return _fixed_failure(
        code="metadata-provider-unsafe-xml",
        reason="The metadata provider returned unsupported XML declarations.",
        action="Update the provider adapter before retrying this response.",
        retryable=False,
    )


def unknown_shape_failure() -> MetadataProviderFailure:
    return _fixed_failure(
        code="metadata-provider-unknown-shape",
        reason="The metadata provider returned an unsupported response shape.",
        action="Update the provider adapter before retrying this response.",
        retryable=False,
    )


def invalid_record_failure() -> MetadataProviderFailure:
    return _fixed_failure(
        code="metadata-provider-invalid-record",
        reason="The metadata provider returned a record that could not be converted safely.",
        action="Update the provider adapter before retrying this record.",
        retryable=False,
    )


def conflicting_header_failure() -> MetadataProviderFailure:
    return _fixed_failure(
        code="metadata-provider-conflicting-header",
        reason="The metadata provider returned conflicting response feedback.",
        action="Retry the request or update the provider adapter.",
        retryable=True,
    )


__all__ = (
    "access_failure_to_provider_failure",
    "conflicting_header_failure",
    "invalid_record_failure",
    "malformed_json_failure",
    "malformed_xml_failure",
    "response_too_large_failure",
    "unknown_shape_failure",
    "unsafe_xml_failure",
)
