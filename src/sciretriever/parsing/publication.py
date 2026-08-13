"""Parsing-owned publication facade for a validated staged result.

The facade contains no filesystem or Catalog mechanics.  It preserves the
feature direction by accepting only Parsing's public Storage Port, delegates
one complete command, and accepts either the offered result or the existing
current result for the same canonical manifest.  Attempt provenance identity
and observation time are deliberately outside that manifest hash.
"""

from __future__ import annotations

from sciretriever.model.parsing import ParserResult
from sciretriever.parsing.ports import (
    ParserResultPublicationCommand,
    ParserResultStorePort,
)


def _manifest_identity(result: ParserResult) -> tuple[object, ...]:
    parser_provenance = result.provenance
    shared = parser_provenance.provenance
    return (
        result.result_sha256,
        result.source_asset_id,
        result.source_sha256,
        result.page_count,
        result.markdown,
        result.resources,
        shared.source_kind,
        shared.source_name,
        shared.source_record_id,
        shared.input_sha256,
        shared.parameters_sha256,
        parser_provenance.parser_version,
        parser_provenance.mode,
        parser_provenance.model_identity,
    )


def same_parser_result_manifest(offered: ParserResult, committed: object) -> bool:
    """Return whether results differ at most by attempt provenance ID/time."""

    return isinstance(committed, ParserResult) and _manifest_identity(
        committed
    ) == _manifest_identity(offered)


class ParserResultPublisher:
    """Publish one validated command through the assembled Storage Port."""

    __slots__ = ("_store",)

    def __init__(self, store: ParserResultStorePort) -> None:
        if not isinstance(store, ParserResultStorePort):
            raise TypeError("store must implement ParserResultStorePort")
        self._store = store

    def publish(self, command: ParserResultPublicationCommand) -> ParserResult:
        if not isinstance(command, ParserResultPublicationCommand):
            raise TypeError("command must be a ParserResultPublicationCommand")
        result = self._store.publish_current(command)
        if not same_parser_result_manifest(command.result, result):
            raise RuntimeError("parser result publication violated its contract")
        return result


__all__ = ("ParserResultPublisher", "same_parser_result_manifest")
