from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Final, NewType, Protocol

import sciretriever.model.parsing as parsing_models
from sciretriever.model.documents import LightDocumentV1
from sciretriever.model.primitives import sha256_digest
from sciretriever.services.documents.ports import ParserFailure

MinerUTaskId = NewType("MinerUTaskId", str)
_MAX_TASK_ID_LENGTH: Final = 128
_TASK_ID_PATTERN: Final = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}", re.ASCII)


def parse_mineru_task_id(value: str) -> MinerUTaskId:
    if (
        not isinstance(value, str)
        or len(value) > _MAX_TASK_ID_LENGTH
        or _TASK_ID_PATTERN.fullmatch(value) is None
    ):
        raise ParserFailure("mineru-task-id")
    return MinerUTaskId(value)


class MinerUServicePort(Protocol):
    def submit(self, pdf: bytes) -> str: ...
    def poll(self, task_id: str) -> parsing_models.ParserTask: ...


class MinerUArchiveResultPort(Protocol):
    @property
    def document(self) -> LightDocumentV1: ...

    @property
    def pdf_pages(self) -> int: ...

    @property
    def block_manifest(self) -> tuple[parsing_models.ManifestBlock, ...]: ...


class MinerUArchivePort(Protocol):
    def parse(self, archive_bytes: bytes, pdf_bytes: bytes) -> MinerUArchiveResultPort: ...


@dataclass(frozen=True, slots=True)
class MinerUServiceBounds:
    max_polls: int = 120


@dataclass(frozen=True, slots=True)
class OperatorManagedMinerUAdapter:
    service: MinerUServicePort
    archive: MinerUArchivePort
    bounds: MinerUServiceBounds

    def parse(self, request: parsing_models.ParserRequest) -> parsing_models.ParserResult:
        if sha256_digest(request.pdf) != request.asset_sha256:
            raise ParserFailure("primary-pdf-alignment")
        raw_task_id = (
            self.service.submit(request.pdf)
            if request.resume_task_id is None
            else request.resume_task_id
        )
        task_id = parse_mineru_task_id(raw_task_id)
        for _ in range(self.bounds.max_polls):
            task = self.service.poll(str(task_id))
            returned_task_id = parse_mineru_task_id(task.task_id)
            if returned_task_id != task_id:
                raise ParserFailure("mineru-task-id-mismatch")
            if task.state is parsing_models.ParserTaskState.FAILED:
                raise ParserFailure("mineru-task-failed")
            if task.state is parsing_models.ParserTaskState.COMPLETED:
                if task.archive is None:
                    raise ParserFailure("mineru-result-missing")
                parsed = self.archive.parse(task.archive, request.pdf)
                return parsing_models.ParserResult(
                    document=parsed.document,
                    pdf_pages=parsed.pdf_pages,
                    block_manifest=parsed.block_manifest,
                    provenance=parsing_models.ParserProvenance(
                        parser_name="mineru",
                        parser_version="operator-managed",
                        backend="vlm",
                        model="operator-managed",
                        parameters_sha256=sha256_digest(b"{}"),
                        input_sha256=request.asset_sha256,
                        task_id=str(task_id),
                    ),
                )
            if task.archive is not None:
                raise ParserFailure("mineru-result-premature")
        raise ParserFailure("mineru-poll-bound")


__all__ = (
    "MinerUArchivePort",
    "MinerUArchiveResultPort",
    "MinerUServiceBounds",
    "MinerUServicePort",
    "MinerUTaskId",
    "OperatorManagedMinerUAdapter",
    "parse_mineru_task_id",
)
