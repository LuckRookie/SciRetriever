"""Parser-neutral structural acceptance rules for staged Parsing output."""

from __future__ import annotations

import re
from typing import NoReturn

from pydantic import ValidationError

from sciretriever.model.parsing import (
    ParserProvenance,
    ParserRequest,
    ParserResource,
    ParserResult,
    parser_result_sha256,
)
from sciretriever.model.primitives import Sha256
from sciretriever.parsing.ports import (
    ParserResultPublicationCommand,
    StagedParserOutput,
)
from sciretriever.parsing.resources import (
    ParserResourceConversionError,
    validate_normalized_parser_artifacts,
)

_CONTROL_CHARACTER = re.compile(r"[\x00-\x1f\x7f]")
_STABLE_PARSER_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")


class ParserStructureError(ValueError):
    """A fixed, path-free rejection of malformed staged Parser output."""

    def __init__(self) -> None:
        super().__init__("staged parser output is invalid")


def _fail() -> NoReturn:
    raise ParserStructureError() from None


def _validate_parser_name(value: object) -> None:
    if type(value) is not str:
        _fail()
    candidate = value.strip()
    if not candidate or candidate != value or _CONTROL_CHARACTER.search(candidate) is not None:
        _fail()
    if _STABLE_PARSER_NAME.fullmatch(candidate) is None:
        _fail()


def _validated_provenance(value: object, source_sha256: Sha256) -> ParserProvenance:
    if not isinstance(value, ParserProvenance):
        _fail()
    try:
        provenance = ParserProvenance.model_validate(value.model_dump())
    except (ValidationError, TypeError, ValueError):
        _fail()
    shared = provenance.provenance
    if shared.input_sha256 != source_sha256:
        _fail()
    _validate_parser_name(shared.source_name)
    return provenance


def prepare_parser_result(
    request: ParserRequest,
    output: object,
) -> ParserResultPublicationCommand:
    """Validate one adapter output and build the exact future-P3 command."""

    if not isinstance(request, ParserRequest) or not isinstance(output, StagedParserOutput):
        _fail()
    if (
        output.source_asset_id != request.source_asset_id
        or output.source_sha256 != request.source_sha256
        or type(output.page_count) is not int
        or output.page_count < 1
    ):
        _fail()

    try:
        accepted = validate_normalized_parser_artifacts(
            output.markdown,
            resources=output.resources,
        )
        markdown = accepted.markdown.artifact
        resources = tuple(
            ParserResource(
                reference=resource.reference,
                artifact=resource.artifact.artifact,
            )
            for resource in accepted.resources
        )
    except (
        ParserResourceConversionError,
        ValidationError,
        UnicodeError,
        TypeError,
        ValueError,
        RecursionError,
    ):
        _fail()
    provenance = _validated_provenance(output.provenance, request.source_sha256)
    result_hash = parser_result_sha256(
        source_asset_id=request.source_asset_id,
        source_sha256=request.source_sha256,
        page_count=output.page_count,
        markdown=markdown,
        resources=resources,
        provenance=provenance,
    )
    try:
        result = ParserResult(
            source_asset_id=request.source_asset_id,
            source_sha256=request.source_sha256,
            page_count=output.page_count,
            markdown=markdown,
            resources=resources,
            result_sha256=result_hash,
            provenance=provenance,
        )
        return ParserResultPublicationCommand(
            result=result,
            markdown=accepted.markdown,
            resources=accepted.resources,
        )
    except (ValidationError, TypeError, ValueError):
        _fail()


__all__ = ("ParserStructureError", "prepare_parser_result")
