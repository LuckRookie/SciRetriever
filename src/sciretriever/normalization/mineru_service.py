"""Recoverable MinerU parsing and immutable parser-artifact publication."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
import hashlib
import json
import time
from typing import Protocol

from sciretriever.catalog import (
    ArtifactRegistration, ArtifactRepository, AssetRepository, ExternalParserAttemptRepository,
    NormalizedArtifactRecord, ProcessingRunRecord, ProcessingRunRepository,
)
from sciretriever.catalog.engine import CatalogEngine
from sciretriever.config import MinerUConfig
from sciretriever.core.derivation import canonical_json_bytes, canonical_sha256, stable_derivation_id
from sciretriever.core.enums import AssetRole
from sciretriever.errors import MinerUError, MinerUErrorCategory
from sciretriever.errors import CatalogError, StorageError
from sciretriever.storage import DerivedArtifactStore

from .mineru_archive import admit_mineru_archive
from .mineru_client import MinerUClient
from .mineru_contracts import MinerUArchiveEntry, MinerUHealth, MinerUResult, MinerUResultState, MinerUTask, MinerUTaskStatus, ValidatedMinerUArchive


MINERU_PARSER_MEDIA_TYPE = "application/vnd.sciretriever.mineru-parser.v1+json"
Clock = Callable[[], float]
Sleep = Callable[[float], None]


class MinerUServiceClient(Protocol):
    def health(self, timeout: float) -> MinerUHealth | None: ...
    def submit(self, filename: str, pdf: bytes, timeout: float) -> MinerUTask: ...
    def status(self, task_id: str, timeout: float) -> MinerUTask | None: ...
    def result(self, task_id: str, timeout: float) -> MinerUResult: ...


@dataclass(frozen=True, slots=True)
class MinerUParsingResult:
    run: ProcessingRunRecord
    parser_artifact: NormalizedArtifactRecord
    supporting_artifacts: tuple[NormalizedArtifactRecord, ...]
    archive: ValidatedMinerUArchive


class MinerUParsingService:
    def __init__(
        self, catalog: CatalogEngine, derived_store: DerivedArtifactStore,
        config: MinerUConfig, client: MinerUServiceClient, *, clock: Clock = time.monotonic,
        sleep: Sleep = time.sleep,
    ) -> None:
        self.runs = ProcessingRunRepository(catalog)
        self.assets = AssetRepository(catalog)
        self.attempts = ExternalParserAttemptRepository(catalog)
        self.artifacts = ArtifactRepository(catalog)
        self.store = derived_store
        self.config = config
        self.client = client
        self._clock = clock
        self._sleep = sleep

    def _parameters(self) -> object:
        return {
            "service_version": self.config.service_version,
            "api_protocol": self.config.api_protocol,
            "backend": self.config.backend,
            "model": self.config.model,
            "max_attempts": self.config.max_attempts,
        }

    def _remaining(self, deadline: float) -> float:
        remaining = deadline - self._clock()
        if remaining <= 0:
            raise MinerUError(MinerUErrorCategory.TIMEOUT, "MinerU parsing deadline exceeded", retryable=True)
        return remaining

    def _load_success(self, run: ProcessingRunRecord) -> MinerUParsingResult:
        try:
            details = json.loads(run.details_json or "{}")
            output_ids = details["output_artifact_ids"]
            if (
                run.state.value != "succeeded"
                or run.stage.value != "parsing"
                or run.input_raw_asset_id is None
                or run.input_artifact_id is not None
                or not isinstance(details, dict)
                or set(details) != {
                    "work_version_id",
                    "stage",
                    "producer",
                    "producer_version",
                    "parameters",
                    "input_raw_asset_ids",
                    "input_artifact_ids",
                    "parameters_sha256",
                    "output_artifact_ids",
                }
                or details.get("work_version_id") != run.work_version_id
                or details.get("stage") != "parsing"
                or details.get("producer") != "mineru"
                or details.get("producer_version") != self.config.service_version
                or details.get("parameters") != self._parameters()
                or details.get("parameters_sha256") != canonical_sha256(self._parameters())
                or details.get("input_raw_asset_ids") != [run.input_raw_asset_id]
                or details.get("input_artifact_ids") != []
                or not isinstance(output_ids, list)
                or not output_ids
                or not all(isinstance(value, str) for value in output_ids)
                or run.output_artifact_id != output_ids[0]
            ):
                raise ValueError
            records = tuple(self.artifacts.get(value) for value in output_ids)
        except (KeyError, TypeError, ValueError) as error:
            raise MinerUError(MinerUErrorCategory.PROTOCOL, "MinerU parsing replay state is invalid") from error
        typed = tuple(record for record in records if record is not None)
        parser = next((record for record in typed if record.kind == "mineru_parser"), None)
        if (
            parser is None or len(typed) != len(records)
            or len({record.id for record in typed}) != len(typed)
            or any(record.work_version_id != run.work_version_id for record in typed)
            or any(record.raw_asset_id != parser.raw_asset_id for record in typed)
        ):
            raise MinerUError(MinerUErrorCategory.PROTOCOL, "MinerU parsing replay has missing artifacts")
        publication = self.store.find_published(parser.kind, parser.id)
        if publication is None or (publication.sha256, publication.byte_size) != (parser.sha256, parser.byte_size):
            raise MinerUError(MinerUErrorCategory.PROTOCOL, "MinerU parser artifact storage is inconsistent")
        try:
            manifest = json.loads(self.store.read_verified(publication))
            manifest_entries = manifest["entries"]
            if (
                not isinstance(manifest, dict) or manifest.get("schema_version") != 1
                or manifest.get("kind") != "mineru_parser"
                or manifest.get("processing_run_id") != run.id
                or manifest.get("input_raw_asset_id") != parser.raw_asset_id
                or not isinstance(manifest_entries, list)
            ):
                raise ValueError
        except (KeyError, TypeError, ValueError) as error:
            raise MinerUError(MinerUErrorCategory.PROTOCOL, "MinerU parser manifest is invalid") from error
        entries: list[MinerUArchiveEntry] = []
        by_id = {record.id: record for record in typed}
        expected_provenance = {
            "producer": "mineru",
            "producer_version": self.config.service_version,
            "api_protocol": self.config.api_protocol,
            "backend": self.config.backend,
            "model": self.config.model,
            "model_identity": "operator_attested",
            "processing_run_id": run.id,
            "input_raw_asset_id": parser.raw_asset_id,
        }
        if json.loads(parser.provenance_json) != expected_provenance:
            raise MinerUError(
                MinerUErrorCategory.PROTOCOL,
                "MinerU parser provenance is invalid",
            )
        seen_ids: set[str] = set()
        seen_paths: set[str] = set()
        for item in manifest_entries:
            if not isinstance(item, dict):
                raise MinerUError(MinerUErrorCategory.PROTOCOL, "MinerU parser manifest is invalid")
            artifact_id = item.get("artifact_id")
            path = item.get("path")
            media_type = item.get("media_type")
            sha256 = item.get("sha256")
            byte_size = item.get("byte_size")
            if (
                not isinstance(artifact_id, str) or artifact_id in seen_ids
                or not isinstance(path, str) or path.casefold() in seen_paths
                or not isinstance(media_type, str) or not isinstance(sha256, str)
                or not isinstance(byte_size, int) or isinstance(byte_size, bool) or byte_size <= 0
            ):
                raise MinerUError(MinerUErrorCategory.PROTOCOL, "MinerU parser manifest is invalid")
            seen_ids.add(artifact_id)
            seen_paths.add(path.casefold())
            record = by_id.get(artifact_id)
            expected_id = stable_derivation_id(
                "mineru_parser_entry",
                {"run_id": run.id, "path": path, "sha256": sha256},
            )
            if (
                artifact_id != expected_id
                or record is None
                or record.kind != "mineru_parser_entry"
                or record.raw_asset_id != parser.raw_asset_id
                or json.loads(record.provenance_json)
                != {**expected_provenance, "archive_path": path}
            ):
                raise MinerUError(MinerUErrorCategory.PROTOCOL, "MinerU parser manifest is incomplete")
            stored = self.store.find_published(record.kind, record.id)
            if stored is None or (stored.sha256, stored.byte_size) != (sha256, byte_size) or (record.sha256, record.byte_size, record.media_type) != (sha256, byte_size, media_type):
                raise MinerUError(MinerUErrorCategory.PROTOCOL, "MinerU parser entry storage is inconsistent")
            entries.append(MinerUArchiveEntry(path, media_type, sha256, self.store.read_verified(stored)))
        if seen_ids != {record.id for record in typed if record.id != parser.id}:
            raise MinerUError(MinerUErrorCategory.PROTOCOL, "MinerU parser manifest is incomplete")
        expected_parser_id = stable_derivation_id(
            "mineru_parser", {"run_id": run.id, "entries": manifest_entries}
        )
        if parser.id != expected_parser_id:
            raise MinerUError(
                MinerUErrorCategory.PROTOCOL,
                "MinerU parser deterministic identity is invalid",
            )
        archive = self._archive_from_entries(tuple(entries))
        if manifest.get("primary") != {
            "middle": archive.middle.path,
            "model": archive.model.path,
            "content_list": archive.content_list.path,
        }:
            raise MinerUError(MinerUErrorCategory.PROTOCOL, "MinerU parser manifest primary entries are inconsistent")
        supporting = tuple(record for record in typed if record.id != parser.id)
        return MinerUParsingResult(run, parser, supporting, archive)

    @staticmethod
    def _archive_from_entries(entries: tuple[MinerUArchiveEntry, ...]) -> ValidatedMinerUArchive:
        def exactly_one(suffix: str) -> MinerUArchiveEntry:
            matches = tuple(value for value in entries if value.path.lower().endswith(suffix))
            if len(matches) != 1:
                raise MinerUError(MinerUErrorCategory.PROTOCOL, "MinerU parser manifest has invalid primary entries")
            return matches[0]

        middle = exactly_one("_middle.json")
        model = exactly_one("_model.json")
        content = exactly_one("_content_list.json")
        primary = {middle.path, model.path, content.path}
        return ValidatedMinerUArchive(middle, model, content, tuple(value for value in entries if value.path not in primary))

    def _publish(
        self, work_version_id: str, raw_asset_id: str, run: ProcessingRunRecord,
        archive: ValidatedMinerUArchive,
    ) -> tuple[NormalizedArtifactRecord, ...]:
        registrations: list[ArtifactRegistration] = []
        manifest_entries = []
        provenance = {
            "producer": "mineru", "producer_version": self.config.service_version,
            "api_protocol": self.config.api_protocol, "backend": self.config.backend,
            "model": self.config.model, "model_identity": "operator_attested",
            "processing_run_id": run.id, "input_raw_asset_id": raw_asset_id,
        }
        for entry in archive.entries:
            artifact_id = stable_derivation_id("mineru_parser_entry", {
                "run_id": run.id, "path": entry.path, "sha256": entry.sha256,
            })
            publication = self.store.publish_bytes("mineru_parser_entry", artifact_id, entry.payload)
            registrations.append(ArtifactRegistration(
                artifact_id, "mineru_parser_entry", "1", publication.storage_path,
                publication.sha256, entry.media_type, publication.byte_size,
                {**provenance, "archive_path": entry.path},
            ))
            manifest_entries.append({
                "artifact_id": artifact_id, "path": entry.path, "media_type": entry.media_type,
                "sha256": entry.sha256, "byte_size": len(entry.payload),
            })
        parser_id = stable_derivation_id("mineru_parser", {
            "run_id": run.id, "entries": manifest_entries,
        })
        manifest = canonical_json_bytes({
            "schema_version": 1, "kind": "mineru_parser", "processing_run_id": run.id,
            "input_raw_asset_id": raw_asset_id, "entries": manifest_entries,
            "primary": {
                "middle": archive.middle.path, "model": archive.model.path,
                "content_list": archive.content_list.path,
            },
        })
        publication = self.store.publish_bytes("mineru_parser", parser_id, manifest)
        registrations.append(ArtifactRegistration(
            parser_id, "mineru_parser", "1", publication.storage_path, publication.sha256,
            MINERU_PARSER_MEDIA_TYPE, publication.byte_size, provenance,
        ))
        return self.artifacts.register_pair_after_publication(
            work_version_id, raw_asset_id, tuple(registrations),
        )

    def run(
        self, work_version_id: str, raw_asset_id: str, pdf: bytes, *, filename: str = "document.pdf",
    ) -> MinerUParsingResult:
        if not isinstance(pdf, bytes) or not pdf.startswith(b"%PDF-"):
            raise MinerUError(MinerUErrorCategory.CONFIGURATION, "MinerU input must be PDF bytes")
        digest = hashlib.sha256(pdf).hexdigest()
        raw = self.assets.get_raw_asset_by_sha256(digest)
        links = self.assets.get_work_version_assets(work_version_id)
        if (
            raw is None or raw.id != raw_asset_id or raw.media_type != "application/pdf"
            or not any(
                link.raw_asset_id == raw_asset_id and link.asset_role is AssetRole.PRIMARY_PDF
                for link in links
            )
        ):
            raise MinerUError(MinerUErrorCategory.CONFIGURATION, "MinerU input does not match the primary PDF asset")
        run = self.runs.claim_or_resume(
            work_version_id, "parsing", "mineru", self.config.service_version,
            self._parameters(), input_raw_asset_ids=(raw_asset_id,),
        )
        with self.store.run_lock(run.id):
            current = self.runs.get(run.id)
            if current is None:
                raise MinerUError(MinerUErrorCategory.PROTOCOL, "MinerU parsing run is missing")
            if current.state.value == "succeeded":
                return self._load_success(current)
            deadline = self._clock() + self.config.overall_deadline
            active = self.attempts.active_for_run(current.id)
            try:
                self.client.health(self._remaining(deadline))
                while True:
                    if active is not None and active.external_task_id is None:
                        self.attempts.finish(active.id, "failed")
                        active = None
                    if active is None:
                        if len(self.attempts.list_for_run(current.id)) >= self.config.max_attempts:
                            raise MinerUError(
                                MinerUErrorCategory.REMOTE_FAILED,
                                "MinerU parsing attempt limit exhausted",
                            )
                        active = self.attempts.create(current.id, {"reason": "submit"})
                        task = self.client.submit(filename, pdf, self._remaining(deadline))
                        active = self.attempts.attach_task(active.id, task.task_id)
                    task_id = active.external_task_id
                    if task_id is None:
                        raise MinerUError(MinerUErrorCategory.PROTOCOL, "MinerU attempt recovery state is invalid")
                    task = self.client.status(task_id, self._remaining(deadline))
                    if task is None:
                        self.attempts.finish(active.id, "expired")
                        active = None
                        continue
                    if task.status is MinerUTaskStatus.FAILED:
                        raise MinerUError(MinerUErrorCategory.REMOTE_FAILED, "MinerU task failed")
                    if task.status is MinerUTaskStatus.COMPLETED:
                        result = self.client.result(task.task_id, self._remaining(deadline))
                        if result.state is MinerUResultState.EXPIRED:
                            self.attempts.finish(active.id, "expired")
                            active = None
                            continue
                        if result.state is MinerUResultState.PENDING:
                            self._sleep(min(self.config.poll_interval, self._remaining(deadline)))
                            continue
                        if result.archive is None:
                            raise MinerUError(MinerUErrorCategory.PROTOCOL, "MinerU completed result has no archive")
                        archive = admit_mineru_archive(result.archive, self.config)
                        registered = self._publish(work_version_id, raw_asset_id, current, archive)
                        self.attempts.finish(active.id, "succeeded")
                        succeeded = self.runs.succeed(current.id, output_artifact_ids=tuple(item.id for item in registered))
                        parser = next((item for item in registered if item.kind == "mineru_parser"), None)
                        if parser is None:
                            raise MinerUError(MinerUErrorCategory.PROTOCOL, "MinerU parser publication is incomplete")
                        return MinerUParsingResult(succeeded, parser, tuple(item for item in registered if item.id != parser.id), archive)
                    self._sleep(min(self.config.poll_interval, self._remaining(deadline)))
            except KeyboardInterrupt:
                if active is not None and active.external_task_id is None:
                    self.attempts.finish(active.id, "failed")
                if active is None or active.external_task_id is None:
                    self.runs.fail(
                        current.id,
                        MinerUErrorCategory.INTERRUPTED.value,
                        "MinerU parsing interrupted locally",
                    )
                raise
            except MinerUError as error:
                if active is not None:
                    self.attempts.finish(active.id, "failed")
                self.runs.fail(current.id, error.category.value, str(error), retryable=error.retryable)
                raise
            except (CatalogError, StorageError) as error:
                if active is not None and self.attempts.active_for_run(current.id) is not None:
                    self.attempts.finish(active.id, "failed")
                wrapped = MinerUError(MinerUErrorCategory.PROTOCOL, "MinerU artifact publication failed")
                self.runs.fail(current.id, wrapped.category.value, str(wrapped))
                raise wrapped from error


__all__ = ("MINERU_PARSER_MEDIA_TYPE", "MinerUParsingResult", "MinerUParsingService")
