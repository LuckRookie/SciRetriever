"""Prepare/commit Parsing orchestration with private, single-use receipts."""

from __future__ import annotations

import threading
import weakref
from dataclasses import dataclass
from typing import TYPE_CHECKING

from pydantic import ValidationError

from sciretriever.model.parsing import ParserRequest, ParserResult
from sciretriever.model.primitives import AssetId
from sciretriever.model.report import StableFailure
from sciretriever.parsing.ports import (
    ParserPort,
    ParserResultPublicationCommand,
    ParserResultStorePort,
    ParsingFailure,
    StagedParserArtifact,
    StagedParserOutput,
    StagedParserResource,
)
from sciretriever.parsing.publication import same_parser_result_manifest
from sciretriever.parsing.rules import ParserStructureError, prepare_parser_result

if TYPE_CHECKING:
    from sciretriever.parsing.api import PreparedParsing


def _failure(*, code: str, reason: str, action: str, retryable: bool) -> StableFailure:
    return StableFailure(code=code, reason=reason, action=action, retryable=retryable)


def _stale_failure() -> StableFailure:
    return _failure(
        code="parsing-current-primary-stale",
        reason="The current primary PDF changed during parsing.",
        action="Refresh the Literature and retry parsing its current primary PDF.",
        retryable=False,
    )


def _cancelled_failure() -> StableFailure:
    return _failure(
        code="parsing-cancelled",
        reason="The controlled Parsing operation was cancelled.",
        action="Retry the target when Parsing should continue.",
        retryable=True,
    )


def _parser_failure() -> StableFailure:
    return _failure(
        code="parsing-parser-failed",
        reason="The selected Parser did not produce a complete staged result.",
        action="Check the selected Parser readiness and retry the target.",
        retryable=True,
    )


def _structure_failure() -> StableFailure:
    return _failure(
        code="parsing-structure-invalid",
        reason="The staged Parser result failed neutral structure validation.",
        action="Check the Parser adapter output contract before retrying.",
        retryable=False,
    )


def _publication_failure() -> StableFailure:
    return _failure(
        code="parsing-publication-failed",
        reason="The validated Parser result could not be committed safely.",
        action="Check local Storage integrity and retry the target.",
        retryable=True,
    )


def _read_failure() -> StableFailure:
    return _failure(
        code="parsing-read-failed",
        reason="The current Parser result could not be read safely.",
        action="Check local Storage integrity and retry the read.",
        retryable=True,
    )


def _contract_failure() -> StableFailure:
    return _failure(
        code="parsing-port-contract",
        reason="A Parsing component violated its neutral Port contract.",
        action="Correct the Parsing composition before retrying.",
        retryable=False,
    )


def _release_artifacts(artifacts: tuple[StagedParserArtifact, ...]) -> bool:
    """Attempt every idempotent capability release without leaking details."""

    succeeded = True
    for artifact in artifacts:
        try:
            artifact.discard()
        except Exception:
            succeeded = False
    return succeeded


def _release_output(output: object) -> bool:
    if not isinstance(output, StagedParserOutput):
        return True
    artifacts: list[StagedParserArtifact] = []
    if isinstance(output.markdown, StagedParserArtifact):
        artifacts.append(output.markdown)
    if isinstance(output.resources, tuple):
        artifacts.extend(
            resource.artifact
            for resource in output.resources
            if isinstance(resource, StagedParserResource)
            and isinstance(resource.artifact, StagedParserArtifact)
        )
    return _release_artifacts(tuple(artifacts))


def _release_command(command: ParserResultPublicationCommand) -> bool:
    return _release_artifacts(
        (command.markdown, *(resource.artifact for resource in command.resources))
    )


@dataclass(frozen=True, slots=True)
class _PreparedReceipt:
    request: ParserRequest
    command: ParserResultPublicationCommand


@dataclass(frozen=True, slots=True)
class _ActiveReceipt:
    receipt: _PreparedReceipt
    finalizer: weakref.finalize


class ParsingService:
    """Prepare outside the commit queue and publish one private receipt inside it."""

    def __init__(
        self,
        *,
        parser: ParserPort,
        result_store: ParserResultStorePort,
    ) -> None:
        if not isinstance(parser, ParserPort):
            raise TypeError("parser must implement the single ParserPort")
        if not isinstance(result_store, ParserResultStorePort):
            raise TypeError("result_store must implement ParserResultStorePort")
        self._parser = parser
        self._result_store = result_store
        self._active: weakref.WeakKeyDictionary[PreparedParsing, _ActiveReceipt] = (
            weakref.WeakKeyDictionary()
        )
        self._issued: weakref.WeakSet[PreparedParsing] = weakref.WeakSet()
        self._receipts_lock = threading.Lock()

    def prepare_current_primary(
        self,
        request: ParserRequest,
        *,
        cancel_event: threading.Event | None = None,
    ) -> PreparedParsing:
        """Run Parser I/O and neutral validation without publishing bytes or rows."""

        if not isinstance(request, ParserRequest):
            raise TypeError("request must be a ParserRequest")
        self._require_not_cancelled(cancel_event)
        self._require_current_primary(request)
        self._require_not_cancelled(cancel_event)

        output: object | None = None
        command: ParserResultPublicationCommand | None = None
        failure: ParsingFailure | None = None
        try:
            try:
                output = self._parser.parse(request, cancel_event=cancel_event)
            except ParsingFailure:
                self._require_not_cancelled(cancel_event)
                raise
            except Exception:
                self._require_not_cancelled(cancel_event)
                raise ParsingFailure(_parser_failure()) from None

            self._require_not_cancelled(cancel_event)
            try:
                command = prepare_parser_result(request, output)
            except ParserStructureError:
                raise ParsingFailure(_structure_failure()) from None
            self._require_not_cancelled(cancel_event)
        except ParsingFailure as error:
            failure = error

        released = _release_output(output)
        if failure is not None:
            if command is not None:
                _release_command(command)
            raise failure
        if command is None or not released:
            if command is not None:
                _release_command(command)
            raise ParsingFailure(_contract_failure())
        return self._issue(_PreparedReceipt(request=request, command=command))

    def commit_current_primary(self, prepared: PreparedParsing) -> ParserResult:
        """Consume one issued receipt and publish it through the single Storage path."""

        receipt = self._consume(prepared)
        result: ParserResult | None = None
        failure: ParsingFailure | None = None
        try:
            self._require_current_primary(receipt.request)
            try:
                committed = self._result_store.publish_current(receipt.command)
            except ParsingFailure:
                raise
            except Exception:
                raise ParsingFailure(_publication_failure()) from None
            if not same_parser_result_manifest(receipt.command.result, committed):
                raise ParsingFailure(_contract_failure())
            result = committed
        except ParsingFailure as error:
            failure = error

        released = _release_command(receipt.command)
        if failure is not None:
            raise failure
        if result is None or not released:
            raise ParsingFailure(_contract_failure())
        return result

    def discard_prepared(self, prepared: PreparedParsing) -> None:
        """Idempotently release this service's issued, uncommitted receipt."""

        active = self._remove_for_discard(prepared)
        if active is None:
            return
        if not _release_command(active.receipt.command):
            raise ParsingFailure(_contract_failure())

    def read_current_result(self, source_asset_id: AssetId) -> ParserResult | None:
        """Read the current result for one Asset without exposing Storage objects."""

        if not isinstance(source_asset_id, AssetId):
            raise TypeError("source_asset_id must be an AssetId")
        try:
            result = self._result_store.read_current(source_asset_id)
        except ParsingFailure:
            raise
        except Exception:
            raise ParsingFailure(_read_failure()) from None
        if result is None:
            return None
        if not isinstance(result, ParserResult) or result.source_asset_id != source_asset_id:
            raise ParsingFailure(_contract_failure())
        try:
            checked = ParserResult.model_validate(result.model_dump())
        except (ValidationError, TypeError, ValueError):
            raise ParsingFailure(_contract_failure()) from None
        if checked != result:
            raise ParsingFailure(_contract_failure())
        return checked

    def _issue(self, receipt: _PreparedReceipt) -> PreparedParsing:
        from sciretriever.parsing.api import PreparedParsing

        prepared = PreparedParsing()
        finalizer = weakref.finalize(prepared, _release_command, receipt.command)
        with self._receipts_lock:
            self._issued.add(prepared)
            self._active[prepared] = _ActiveReceipt(receipt=receipt, finalizer=finalizer)
        return prepared

    def _consume(self, prepared: object) -> _PreparedReceipt:
        from sciretriever.parsing.api import PreparedParsing

        if type(prepared) is not PreparedParsing:
            raise ParsingFailure(_contract_failure())
        with self._receipts_lock:
            if prepared not in self._issued:
                raise ParsingFailure(_contract_failure())
            active = self._active.pop(prepared, None)
        if active is None:
            raise ParsingFailure(_contract_failure())
        active.finalizer.detach()
        return active.receipt

    def _remove_for_discard(self, prepared: object) -> _ActiveReceipt | None:
        from sciretriever.parsing.api import PreparedParsing

        if type(prepared) is not PreparedParsing:
            raise ParsingFailure(_contract_failure())
        with self._receipts_lock:
            if prepared not in self._issued:
                raise ParsingFailure(_contract_failure())
            active = self._active.pop(prepared, None)
        if active is not None:
            active.finalizer.detach()
        return active

    def _require_current_primary(self, request: ParserRequest) -> None:
        try:
            matches = self._result_store.current_primary_matches(
                request.source_asset_id,
                request.source_sha256,
            )
        except ParsingFailure:
            raise
        except Exception:
            raise ParsingFailure(_publication_failure()) from None
        if type(matches) is not bool:
            raise ParsingFailure(_contract_failure())
        if not matches:
            raise ParsingFailure(_stale_failure())

    @staticmethod
    def _require_not_cancelled(cancel_event: threading.Event | None) -> None:
        if cancel_event is None:
            return
        try:
            cancelled = cancel_event.is_set()
        except Exception:
            raise ParsingFailure(_contract_failure()) from None
        if type(cancelled) is not bool:
            raise ParsingFailure(_contract_failure())
        if cancelled:
            raise ParsingFailure(_cancelled_failure())


__all__ = ("ParsingService",)
