"""Stable diagnostic contracts and sanitization boundary."""

from .codec import decode_diagnostic, encode_diagnostic
from .contracts import ActionCode, AttemptMetadata, DiagnosticEnvelope, FailureStage, ReasonCode
from .mapping import map_exception
from .projection import AttemptSummary, FailureProjection, JobProjection, diagnostic_from_details
from .redaction import REDACTED, redact, redact_text, redact_url

__all__ = (
    "ActionCode", "AttemptMetadata", "DiagnosticEnvelope", "FailureStage", "REDACTED", "ReasonCode",
    "AttemptSummary", "FailureProjection", "JobProjection", "decode_diagnostic", "diagnostic_from_details", "encode_diagnostic", "map_exception", "redact", "redact_text", "redact_url",
)
