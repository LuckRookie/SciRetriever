"""Crash-recoverable normal-path coordination for raw asset acceptance."""

from __future__ import annotations

from collections.abc import Callable
from typing import BinaryIO

from sciretriever.catalog.assets import AssetRepository
from sciretriever.catalog.records import AssetIntentRecord, RawAssetRecord, WorkVersionAssetRecord
from sciretriever.core.enums import AssetIntentState, AssetRole
from sciretriever.core.ids import new_uuid4, validate_uuid
from sciretriever.errors import CatalogError, StorageCorruptionError, StorageError
from sciretriever.diagnostics import map_exception

from .acceptance_records import (
    AssetAcceptanceContext,
    AssetAcceptanceResult,
    validate_catalog_records,
)
from .manager import RawAssetStore
from .records import PublicationResult, StagedAsset


def _noop_checkpoint(_name: str, _value: object) -> None:
    pass


class AssetAcceptanceCoordinator:
    """Coordinate the durable filesystem and catalog normal acceptance path."""

    def __init__(self, repository: AssetRepository, store: RawAssetStore) -> None:
        if not isinstance(repository, AssetRepository):
            raise TypeError("repository must be an AssetRepository")
        if not isinstance(store, RawAssetStore):
            raise TypeError("store must be a RawAssetStore")
        self._repository = repository
        self._store = store

    def existing_asset_id(
        self, work_version_id: str, asset_role: AssetRole
    ) -> str | None:
        """Return an already accepted immutable asset for invocation-local convergence."""

        return next(
            (
                link.raw_asset_id
                for link in self._repository.get_work_version_assets(work_version_id)
                if link.asset_role is asset_role
            ),
            None,
        )

    def accept(
        self,
        stream: BinaryIO,
        work_version_id: str,
        asset_role: AssetRole | str,
        media_type: str,
        format: str,
        provenance: object,
        *,
        intent_id: str | None = None,
        checkpoint: Callable[[str, object], None] = _noop_checkpoint,
    ) -> AssetAcceptanceResult:
        identifier = new_uuid4() if intent_id is None else validate_uuid(intent_id, "intent_id")
        if not callable(checkpoint):
            raise TypeError("checkpoint must be callable")

        staged: StagedAsset | None = None
        failure_subject_id: str | None = None
        phase = "stage"
        with self._store.lock():
            try:
                if intent_id is not None:
                    phase = "explicit_intent_lookup"
                    existing = self._repository.get_intent(identifier)
                    if existing is not None:
                        if existing.state is AssetIntentState.ABANDONED:
                            raise CatalogError(
                                f"cannot accept an abandoned asset intent: {existing.id}"
                            )
                        phase = "explicit_intent_validation"
                        existing = self._repository.create_intent(
                            identifier,
                            work_version_id,
                            asset_role,
                            existing.expected_sha256,
                            media_type,
                            format,
                            existing.expected_byte_size,
                            provenance,
                        )
                        if existing.state is AssetIntentState.ABANDONED:
                            raise CatalogError(
                                f"cannot accept an abandoned asset intent: {existing.id}"
                            )
                        failure_subject_id = existing.id
                        phase = f"explicit_{existing.state.value}_recovery"
                        return self._resume_explicit(existing)

                staged = self._store.stage(stream, intent_id=identifier)
                phase = "checkpoint_after_stage_fsync"
                checkpoint("after_stage_fsync", AssetAcceptanceContext(staged))

                phase = "intent_creation"
                intent = self._repository.create_intent(
                    identifier,
                    work_version_id,
                    asset_role,
                    staged.sha256,
                    media_type,
                    format,
                    staged.byte_size,
                    provenance,
                )
                failure_subject_id = intent.id
                if intent.id != identifier:
                    if intent.state is AssetIntentState.ABANDONED:
                        phase = "collision_abandoned_staging_remove"
                        self._store.remove_staged(staged)
                        staged = None
                        failure_subject_id = None
                        raise CatalogError(
                            f"cannot accept content for abandoned asset intent: {intent.id}"
                        )
                    phase = f"collision_{intent.state.value}_recovery"
                    return self._recover_collision(intent, staged)

                if intent.state is AssetIntentState.ABANDONED:
                    phase = "abandoned_staging_remove"
                    self._store.remove_staged(staged)
                    staged = None
                    failure_subject_id = None
                    raise CatalogError(f"cannot accept an abandoned asset intent: {intent.id}")
                if intent.state is AssetIntentState.FINALIZED:
                    phase = "same_id_finalized_recovery"
                    return self._recover_collision(intent, staged)
                if intent.state is AssetIntentState.PUBLISHED:
                    phase = "same_id_published_recovery"
                    return self._recover_collision(intent, staged)

                phase = "checkpoint_after_intent_commit"
                checkpoint("after_intent_commit", AssetAcceptanceContext(staged, intent))

                phase = "target_publication"
                publication = self._store.publish(staged)
                publication = self._store.verify_published(publication)
                reused_content = not publication.created
                target_context = AssetAcceptanceContext(
                    staged,
                    intent,
                    publication,
                    reused_content=reused_content,
                )
                phase = "checkpoint_after_target_fsync"
                checkpoint("after_target_fsync", target_context)

                phase = "catalog_publication"
                published_intent = self._repository.register_verified_published_intent(intent.id)
                raw_asset, work_asset = self._catalog_records(published_intent, publication)
                catalog_context = AssetAcceptanceContext(
                    staged,
                    published_intent,
                    publication,
                    raw_asset,
                    work_asset,
                    reused_content,
                )
                phase = "checkpoint_after_catalog_publish_commit"
                checkpoint("after_catalog_publish_commit", catalog_context)

                phase = "staging_remove"
                self._store.remove_staged(staged)
                phase = "checkpoint_after_staging_remove"
                checkpoint("after_staging_remove", catalog_context)

                phase = "intent_finalization"
                finalized_intent = self._repository.finalize_intent(intent.id)
                result = AssetAcceptanceResult(
                    finalized_intent,
                    raw_asset,
                    work_asset,
                    publication,
                    reused_content,
                )
                phase = "checkpoint_after_finalize_commit"
                checkpoint("after_finalize_commit", result)

                phase = "final_target_verification"
                verified = self._store.verify_published(publication)
                if verified != publication:
                    raise CatalogError("final publication verification changed its metadata")
                return result
            except Exception as error:
                if failure_subject_id is not None:
                    self._record_failure(failure_subject_id, phase, error)
                elif staged is not None:
                    self._store.remove_staged(staged)
                raise

    def _catalog_records(
        self,
        intent: AssetIntentRecord,
        publication: PublicationResult,
    ) -> tuple[RawAssetRecord, WorkVersionAssetRecord]:
        if intent.raw_asset_id is None:
            raise CatalogError("published intent does not reference a raw asset")
        raw_asset = self._repository.get_raw_asset(intent.raw_asset_id)
        if raw_asset is None:
            raise CatalogError("published intent raw asset is missing; reconciliation required")
        work_asset = next(
            (
                item
                for item in self._repository.get_work_version_assets(intent.work_version_id)
                if item.raw_asset_id == raw_asset.id and item.asset_role is intent.asset_role
            ),
            None,
        )
        if work_asset is None:
            raise CatalogError("published intent work link is missing; reconciliation required")
        try:
            validate_catalog_records(intent, raw_asset, work_asset, publication)
        except ValueError as error:
            raise CatalogError(
                "published intent metadata is inconsistent; reconciliation required"
            ) from error
        return raw_asset, work_asset

    @staticmethod
    def _staged_asset(intent: AssetIntentRecord) -> StagedAsset:
        return StagedAsset(
            intent.id,
            intent.temporary_path,
            intent.expected_sha256,
            intent.expected_byte_size,
        )

    def _resume_explicit(self, intent: AssetIntentRecord) -> AssetAcceptanceResult:
        if intent.state is AssetIntentState.ABANDONED:
            raise CatalogError(f"cannot accept an abandoned asset intent: {intent.id}")

        staged = self._staged_asset(intent)
        target_exists = self._store.published_exists(
            intent.expected_sha256,
            intent.expected_byte_size,
        )
        staged_exists = self._store.staged_exists(staged)
        if target_exists:
            publication = self._store.verify_published(
                intent.expected_sha256,
                intent.expected_byte_size,
            )
            return self._complete_existing(
                intent,
                publication,
                staged if staged_exists else None,
            )
        if staged_exists and intent.state in {
            AssetIntentState.PENDING,
            AssetIntentState.PUBLISHED,
        }:
            publication = self._store.publish(staged)
            publication = self._store.verify_published(publication)
            return self._complete_existing(intent, publication, staged)
        raise CatalogError(
            f"existing {intent.state.value} asset intent lacks recoverable verified evidence; "
            f"reconciliation required: {intent.id}"
        )

    def _recover_collision(
        self,
        intent: AssetIntentRecord,
        incoming: StagedAsset,
    ) -> AssetAcceptanceResult:
        if intent.state is AssetIntentState.ABANDONED:
            raise CatalogError(f"cannot publish an abandoned asset intent: {intent.id}")
        if intent.state is AssetIntentState.FINALIZED:
            publication = self._store.verify_published(
                intent.expected_sha256,
                intent.expected_byte_size,
            )
            raw_asset, work_asset = self._catalog_records(intent, publication)
            self._store.remove_staged(incoming)
            return AssetAcceptanceResult(intent, raw_asset, work_asset, publication, True)

        publication = self._store.publish(incoming)
        publication = self._store.verify_published(publication)
        return self._complete_existing(intent, publication, incoming)

    def _complete_existing(
        self,
        intent: AssetIntentRecord,
        publication: PublicationResult,
        staged: StagedAsset | None,
    ) -> AssetAcceptanceResult:
        published_intent = self._repository.register_verified_published_intent(intent.id)
        raw_asset, work_asset = self._catalog_records(published_intent, publication)
        if staged is not None:
            self._store.remove_staged(staged)
        finalized_intent = self._repository.finalize_intent(intent.id)
        verified = self._store.verify_published(publication)
        if verified != publication:
            raise CatalogError("final publication verification changed its metadata")
        return AssetAcceptanceResult(
            finalized_intent,
            raw_asset,
            work_asset,
            publication,
            not publication.created,
        )

    def _record_failure(self, intent_id: str, phase: str, error: Exception) -> None:
        category = _failure_category(phase, error)
        mapped_error = StorageError("storage operation failed") if isinstance(error, OSError) else error
        diagnostic = map_exception(
            mapped_error,
            retryable=not isinstance(error, (CatalogError, StorageCorruptionError)),
        )
        self._repository.append_intent_diagnostic(
            intent_id,
            category,
            diagnostic.summary,
            retryable=diagnostic.retryable,
            details={
                "diagnostic": diagnostic.to_dict(),
                "error_type": type(error).__name__,
                "phase": phase,
            },
        )


def _failure_category(phase: str, error: Exception) -> str:
    if isinstance(error, StorageCorruptionError):
        return "asset_storage_corruption"
    if phase.startswith("checkpoint_"):
        return "asset_checkpoint_failure"
    if phase in {"target_publication", "final_target_verification"}:
        return "asset_publication_failure"
    if "staging_remove" in phase:
        return "asset_staging_cleanup_failure"
    if phase in {"catalog_publication"}:
        return "asset_catalog_publication_failure"
    if phase in {"intent_finalization"}:
        return "asset_finalization_failure"
    return "asset_acceptance_failure"


__all__ = (
    "AssetAcceptanceContext",
    "AssetAcceptanceCoordinator",
    "AssetAcceptanceResult",
)
