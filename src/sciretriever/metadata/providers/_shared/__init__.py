"""Narrow mechanical helpers shared by concrete Metadata provider adapters."""

from .failures import (
    access_failure_to_provider_failure,
    invalid_record_failure,
)
from .feedback import (
    header_value,
    interpreted_access_feedback,
    monotonic_deadline_from_wall_time,
    parse_retry_after,
    retry_after_feedback,
)
from .identity import (
    stabilize_provider_metadata_observation,
    stabilize_provider_relation_observation,
)
from .parsing import (
    optional_nonblank_string,
    optional_nonnegative_integer,
    parse_bounded_json,
    parse_bounded_xml,
    require_json_array,
    require_json_object,
    require_xml_root,
    strict_nonnegative_integer,
    xml_children,
)

__all__ = (
    "access_failure_to_provider_failure",
    "header_value",
    "interpreted_access_feedback",
    "invalid_record_failure",
    "monotonic_deadline_from_wall_time",
    "optional_nonblank_string",
    "optional_nonnegative_integer",
    "parse_bounded_json",
    "parse_bounded_xml",
    "parse_retry_after",
    "require_json_array",
    "require_json_object",
    "require_xml_root",
    "retry_after_feedback",
    "stabilize_provider_metadata_observation",
    "stabilize_provider_relation_observation",
    "strict_nonnegative_integer",
    "xml_children",
)
