"""Deterministic recovery for catalog intents and immutable raw assets."""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum

from sciretriever.catalog.assets import AssetRepository
from sciretriever.catalog.records import AssetIntentRecord, RawAssetRecord
from sciretriever.core.enums import AssetIntentState
from sciretriever.errors import StorageCorruptionError

from .manager import RawAssetStore
from .records import StagedAsset


class _Presence(str, Enum):
    ABSENT = "absent"
    VALID = "valid"
    CORRUPT = "corrupt"


@dataclass(frozen=True, slots=True)
class ReconciliationItem:
    intent_id: str
    before_state: AssetIntentState
    after_state: AssetIntentState
    action: str
    failures: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class ReconciliationReport:
    items: tuple[ReconciliationItem, ...]
    staging_orphans: tuple[str, ...]
    removed_staging_orphans: tuple[str, ...]
    unknown_staging: tuple[str, ...]


class RawAssetReconciler:
    """Converge filesystem and catalog state while holding one exclusive lock."""

    def __init__(self, store: RawAssetStore, assets: AssetRepository) -> None:
        if not isinstance(store, RawAssetStore):
            raise TypeError("store must be a RawAssetStore")
        if not isinstance(assets, AssetRepository):
            raise TypeError("assets must be an AssetRepository")
        self._store = store
        self._assets = assets

    @staticmethod
    def _staged_asset(intent: AssetIntentRecord) -> StagedAsset:
        return StagedAsset(
            intent.id,
            intent.temporary_path,
            intent.expected_sha256,
            intent.expected_byte_size,
        )

    def _staged_presence(self, staged: StagedAsset) -> _Presence:
        try:
            return _Presence.VALID if self._store.staged_exists(staged) else _Presence.ABSENT
        except StorageCorruptionError:
            return _Presence.CORRUPT

    def _target_presence(self, intent: AssetIntentRecord) -> _Presence:
        try:
            exists = self._store.published_exists(
                intent.expected_sha256, intent.expected_byte_size
            )
        except StorageCorruptionError:
            return _Presence.CORRUPT
        return _Presence.VALID if exists else _Presence.ABSENT

    @staticmethod
    def _raw_metadata(
        intent: AssetIntentRecord, raw: RawAssetRecord | None
    ) -> tuple[dict[str, object], dict[str, object] | None]:
        expected: dict[str, object] = {
            "sha256": intent.expected_sha256,
            "storage_path": intent.storage_path,
            "media_type": intent.media_type,
            "format": intent.format,
            "byte_size": intent.expected_byte_size,
        }
        if raw is None:
            return expected, None
        actual: dict[str, object] = {
            "sha256": raw.sha256,
            "storage_path": raw.storage_path,
            "media_type": raw.media_type,
            "format": raw.format,
            "byte_size": raw.byte_size,
        }
        return expected, actual

    def _metadata_matches(self, intent: AssetIntentRecord) -> bool:
        if intent.raw_asset_id is None:
            return True
        raw = self._assets.get_raw_asset(intent.raw_asset_id)
        expected, actual = self._raw_metadata(intent, raw)
        return actual == expected

    def _record_failure(
        self,
        intent: AssetIntentRecord,
        category: str,
        message: str,
        *,
        staged: _Presence,
        target: _Presence,
        extra: object | None = None,
    ) -> str:
        details: dict[str, object] = {
            "staged": staged.value,
            "target": target.value,
        }
        if extra is not None:
            details["metadata"] = extra
        failure = self._assets.append_intent_diagnostic(
            intent.id,
            category,
            message,
            retryable=False,
            details=details,
        )
        return failure.id

    def _abandon(
        self,
        intent: AssetIntentRecord,
        category: str,
        message: str,
        *,
        staged: _Presence,
        target: _Presence,
    ) -> tuple[AssetIntentRecord, str]:
        details = {
            "intent_state": intent.state.value,
            "staged": staged.value,
            "target": target.value,
        }
        abandoned, failure = self._assets.abandon_pending_intent_with_diagnostic(
            intent.id,
            category,
            message,
            retryable=False,
            details=details,
        )
        if failure is None:
            raise RuntimeError("pending abandonment did not produce a diagnostic")
        return abandoned, failure.id

    def _metadata_failure(
        self,
        intent: AssetIntentRecord,
        staged: _Presence,
        target: _Presence,
    ) -> ReconciliationItem:
        raw = (
            None
            if intent.raw_asset_id is None
            else self._assets.get_raw_asset(intent.raw_asset_id)
        )
        expected, actual = self._raw_metadata(intent, raw)
        failure_id = self._record_failure(
            intent,
            "raw_asset_metadata_mismatch",
            "raw asset metadata does not match its intent",
            staged=staged,
            target=target,
            extra={"expected": expected, "actual": actual},
        )
        return ReconciliationItem(
            intent.id,
            intent.state,
            intent.state,
            "retained_catalog_mismatch",
            (failure_id,),
        )

    def _reconcile_pending(
        self,
        intent: AssetIntentRecord,
        staged_asset: StagedAsset,
        staged: _Presence,
        target: _Presence,
    ) -> ReconciliationItem:
        if target is _Presence.CORRUPT:
            abandoned, failure_id = self._abandon(
                intent,
                "raw_target_corruption",
                "pending intent has a corrupt published target",
                staged=staged,
                target=target,
            )
            return ReconciliationItem(
                intent.id,
                intent.state,
                abandoned.state,
                "abandoned_corrupt_target",
                (failure_id,),
            )

        if target is _Presence.VALID:
            failures: tuple[str, ...] = ()
            if staged is _Presence.CORRUPT:
                failures = (
                    self._record_failure(
                        intent,
                        "staged_asset_corruption",
                        "staged asset does not match its intent",
                        staged=staged,
                        target=target,
                    ),
                )
            published = self._assets.register_verified_published_intent(intent.id)
            if staged is _Presence.VALID:
                self._store.remove_staged(staged_asset)
            finalized = self._assets.finalize_intent(intent.id)
            action = (
                "registered_target_removed_stage_finalized"
                if staged is _Presence.VALID
                else "registered_target_finalized"
                if staged is _Presence.ABSENT
                else "registered_target_retained_corrupt_stage_finalized"
            )
            return ReconciliationItem(
                intent.id, intent.state, finalized.state, action, failures
            )

        if staged is _Presence.VALID:
            self._store.publish_recovery_locked(staged_asset)
            self._assets.register_verified_published_intent(intent.id)
            self._store.remove_staged(staged_asset)
            finalized = self._assets.finalize_intent(intent.id)
            return ReconciliationItem(
                intent.id,
                intent.state,
                finalized.state,
                "published_registered_removed_stage_finalized",
            )

        category = (
            "staged_asset_corruption"
            if staged is _Presence.CORRUPT
            else "asset_evidence_missing"
        )
        message = (
            "pending intent has a corrupt staged asset and no published target"
            if staged is _Presence.CORRUPT
            else "pending intent has neither staged nor published evidence"
        )
        abandoned, failure_id = self._abandon(
            intent, category, message, staged=staged, target=target
        )
        action = (
            "abandoned_corrupt_stage"
            if staged is _Presence.CORRUPT
            else "abandoned_missing_evidence"
        )
        return ReconciliationItem(
            intent.id, intent.state, abandoned.state, action, (failure_id,)
        )

    def _reconcile_published(
        self,
        intent: AssetIntentRecord,
        staged_asset: StagedAsset,
        staged: _Presence,
        target: _Presence,
    ) -> ReconciliationItem:
        if not self._metadata_matches(intent):
            return self._metadata_failure(intent, staged, target)

        if target is _Presence.CORRUPT:
            failure_id = self._record_failure(
                intent,
                "raw_target_corruption",
                "published intent target is corrupt",
                staged=staged,
                target=target,
            )
            return ReconciliationItem(
                intent.id,
                intent.state,
                intent.state,
                "retained_corrupt_target",
                (failure_id,),
            )

        if target is _Presence.ABSENT:
            if staged is _Presence.VALID:
                self._store.publish_recovery_locked(staged_asset)
                self._store.remove_staged(staged_asset)
                finalized = self._assets.finalize_intent(intent.id)
                return ReconciliationItem(
                    intent.id,
                    intent.state,
                    finalized.state,
                    "recreated_removed_stage_finalized",
                )
            failures: list[str] = []
            if staged is _Presence.CORRUPT:
                failures.append(
                    self._record_failure(
                        intent,
                        "staged_asset_corruption",
                        "staged asset does not match its intent",
                        staged=staged,
                        target=target,
                    )
                )
            failures.append(
                self._record_failure(
                    intent,
                    "raw_target_missing",
                    "published intent target is missing and cannot be recovered",
                    staged=staged,
                    target=target,
                )
            )
            return ReconciliationItem(
                intent.id,
                intent.state,
                intent.state,
                "retained_missing_target",
                tuple(failures),
            )

        failures_tuple: tuple[str, ...] = ()
        if staged is _Presence.VALID:
            self._store.remove_staged(staged_asset)
            action = "removed_stage_finalized"
        elif staged is _Presence.CORRUPT:
            failures_tuple = (
                self._record_failure(
                    intent,
                    "staged_asset_corruption",
                    "staged asset does not match its intent",
                    staged=staged,
                    target=target,
                ),
            )
            action = "retained_corrupt_stage_finalized"
        else:
            action = "finalized"
        finalized = self._assets.finalize_intent(intent.id)
        return ReconciliationItem(
            intent.id, intent.state, finalized.state, action, failures_tuple
        )

    def _reconcile_finalized(
        self,
        intent: AssetIntentRecord,
        staged_asset: StagedAsset,
        staged: _Presence,
        target: _Presence,
    ) -> ReconciliationItem:
        if not self._metadata_matches(intent):
            return self._metadata_failure(intent, staged, target)

        if target is not _Presence.VALID:
            category = (
                "raw_target_missing"
                if target is _Presence.ABSENT
                else "raw_target_corruption"
            )
            message = (
                "finalized intent target is missing"
                if target is _Presence.ABSENT
                else "finalized intent target is corrupt"
            )
            failure_id = self._record_failure(
                intent, category, message, staged=staged, target=target
            )
            return ReconciliationItem(
                intent.id,
                intent.state,
                intent.state,
                "retained_integrity_failure",
                (failure_id,),
            )

        if staged is _Presence.VALID:
            self._store.remove_staged(staged_asset)
            return ReconciliationItem(
                intent.id, intent.state, intent.state, "removed_redundant_stage"
            )
        if staged is _Presence.CORRUPT:
            failure_id = self._record_failure(
                intent,
                "staged_asset_corruption",
                "staged asset does not match its intent",
                staged=staged,
                target=target,
            )
            return ReconciliationItem(
                intent.id,
                intent.state,
                intent.state,
                "retained_corrupt_stage",
                (failure_id,),
            )
        return ReconciliationItem(
            intent.id, intent.state, intent.state, "terminal_valid"
        )

    def _reconcile_intent(self, intent: AssetIntentRecord) -> ReconciliationItem:
        if intent.state is AssetIntentState.ABANDONED:
            return ReconciliationItem(
                intent.id, intent.state, intent.state, "terminal_abandoned"
            )

        staged_asset = self._staged_asset(intent)
        staged = self._staged_presence(staged_asset)
        target = self._target_presence(intent)
        if intent.state is AssetIntentState.PENDING:
            return self._reconcile_pending(intent, staged_asset, staged, target)
        if intent.state is AssetIntentState.PUBLISHED:
            return self._reconcile_published(intent, staged_asset, staged, target)
        return self._reconcile_finalized(intent, staged_asset, staged, target)

    def reconcile_all(self) -> ReconciliationReport:
        """Scan and reconcile all known and orphan staging entries atomically."""

        with self._store.lock(exclusive=True):
            intents = self._assets.list_all_intents()
            recognized, unknown = self._store.enumerate_staging()
            owned_paths = {intent.temporary_path for intent in intents}
            orphans = tuple(path for path in recognized if path not in owned_paths)
            items = tuple(self._reconcile_intent(intent) for intent in intents)
            removed_orphans = tuple(
                path
                for path in orphans
                if self._store.remove_staging_orphan_locked(path)
            )
        return ReconciliationReport(items, orphans, removed_orphans, unknown)


__all__ = (
    "RawAssetReconciler",
    "ReconciliationItem",
    "ReconciliationReport",
)
