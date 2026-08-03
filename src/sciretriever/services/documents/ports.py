from __future__ import annotations

from typing import Protocol

from sciretriever.model import assets as asset_models
from sciretriever.model import execution as execution_models
from sciretriever.model import parsing as parsing_models


class ParserFailure(Exception):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


class ParserPort(Protocol):
    def parse(self, request: parsing_models.ParserRequest) -> parsing_models.ParserResult: ...


class DocumentArtifactStorePort(Protocol):
    def publish(self, artifact: asset_models.StagedArtifact) -> asset_models.PublishedArtifact: ...


class DocumentAcceptancePort(Protocol):
    def publish(
        self, acceptance: execution_models.ValidatedDocumentAcceptance
    ) -> asset_models.AssetPublication | None: ...


__all__ = ("DocumentAcceptancePort", "DocumentArtifactStorePort", "ParserFailure", "ParserPort")
