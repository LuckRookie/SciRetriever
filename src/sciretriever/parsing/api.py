"""Public parser-neutral API for current-primary PDF parsing."""

from __future__ import annotations

import threading
from typing import NoReturn

from sciretriever.model.parsing import ParserRequest, ParserResult
from sciretriever.model.primitives import AssetId
from sciretriever.parsing.ports import ParsingFailure
from sciretriever.parsing.service import ParsingService as _ParsingService


class PreparedParsing:
    """Opaque, service-issued handle for one validated uncommitted result."""

    __slots__ = ("__weakref__",)

    def __init_subclass__(cls, **kwargs: object) -> None:
        del kwargs
        raise TypeError("PreparedParsing cannot be subclassed")

    def __repr__(self) -> str:
        return "<PreparedParsing>"

    def __reduce__(self) -> NoReturn:
        raise TypeError("PreparedParsing cannot be serialized")


class ParsingApi:
    """Thin public boundary over one explicitly assembled Parsing service."""

    def __init__(self, service: object) -> None:
        if not isinstance(service, _ParsingService):
            raise TypeError("service must be a ParsingService")
        self._service = service

    def prepare_current_primary(
        self,
        request: ParserRequest,
        *,
        cancel_event: threading.Event | None = None,
    ) -> PreparedParsing:
        """Run external parsing and validation without publishing any fact."""

        return self._service.prepare_current_primary(
            request,
            cancel_event=cancel_event,
        )

    def commit_current_primary(self, prepared: PreparedParsing) -> ParserResult:
        """Consume one service-issued handle and publish its validated result."""

        return self._service.commit_current_primary(prepared)

    def discard_prepared(self, prepared: PreparedParsing) -> None:
        """Idempotently release an uncommitted service-issued handle."""

        self._service.discard_prepared(prepared)

    def read_current_result(self, source_asset_id: AssetId) -> ParserResult | None:
        """Return the one current parser-neutral result for an Asset, if present."""

        return self._service.read_current_result(source_asset_id)


__all__ = ("ParsingApi", "ParsingFailure", "PreparedParsing")
