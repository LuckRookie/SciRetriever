"""Format-neutral package quality and source-map gates."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from sciretriever.core.enums import AssetRole, PackageQuality
from sciretriever.core.package import MISSING_PRIMARY_PDF
from sciretriever.errors import PackagingError
from ..normalization.contracts import NormalizationDraft


@dataclass(frozen=True, slots=True)
class QualityDecision:
    quality: PackageQuality
    limitations: tuple[str, ...]


class QualityGate:
    @staticmethod
    def _text_targets(content: dict[str, Any]) -> dict[str, str]:
        targets: dict[str, str] = {}
        for section_index, section in enumerate(content["sections"]):
            for field_name in ("title", "text"):
                value = section[field_name]
                if isinstance(value, str) and value:
                    targets[f"/sections/{section_index}/{field_name}"] = value
        for table_index, table in enumerate(content["tables"]):
            for field_name in ("caption", "notes"):
                value = table[field_name]
                if isinstance(value, str) and value:
                    targets[f"/tables/{table_index}/{field_name}"] = value
            for cell_index, cell in enumerate(table["cells"]):
                value = cell["text"]
                if value:
                    targets[f"/tables/{table_index}/cells/{cell_index}/text"] = value
        for reference_index, reference in enumerate(content["references"]):
            value = reference["text"]
            if value:
                targets[f"/references/{reference_index}/text"] = value
        return targets

    @staticmethod
    def _require_complete_cover(
        intervals: list[tuple[int, int]],
        length: int,
        subject: str,
    ) -> None:
        position = 0
        for start, end in sorted(intervals):
            if start < position:
                raise PackagingError(f"{subject} evidence overlaps")
            if start > position:
                raise PackagingError(f"{subject} evidence has a gap")
            position = end
        if position != length:
            raise PackagingError(f"{subject} evidence has a gap")

    def validate(self, roles: tuple[AssetRole, ...], draft: NormalizationDraft) -> QualityDecision:
        role_set = set(roles)
        if AssetRole.PRIMARY_PDF in role_set:
            decision = QualityDecision(PackageQuality.PDF_BACKED, ())
        elif role_set.intersection({AssetRole.XML, AssetRole.HTML}):
            decision = QualityDecision(PackageQuality.LIMITED_XML_HTML, (MISSING_PRIMARY_PDF,))
        else:
            raise PackagingError("a supplementary PDF alone cannot produce a package")
        units = {unit.unit_id: unit for unit in draft.source_units}
        content = draft.content.to_dict()
        targets = self._text_targets(content)
        source_intervals: dict[str, list[tuple[int, int]]] = {
            unit_id: [] for unit_id in units
        }
        target_intervals: dict[str, list[tuple[int, int]]] = {
            path: [] for path in targets
        }
        for evidence in draft.evidence:
            unit = units.get(evidence.source_unit_id)
            if unit is None or unit.file_id != evidence.file_id:
                raise PackagingError("evidence references an unknown source unit")
            target = targets.get(evidence.normalized_path)
            if target is None:
                raise PackagingError("evidence references an unknown normalized text target")
            source_text = unit.text[evidence.source_start:evidence.source_end]
            normalized_text = target[evidence.normalized_start:evidence.normalized_end]
            if source_text != normalized_text:
                raise PackagingError("evidence source and normalized spans do not match")
            source_intervals[unit.unit_id].append((evidence.source_start, evidence.source_end))
            target_intervals[evidence.normalized_path].append(
                (evidence.normalized_start, evidence.normalized_end)
            )
        for unit_id, unit in units.items():
            if unit.text:
                self._require_complete_cover(
                    source_intervals[unit_id], len(unit.text), "source-unit",
                )
        for path, target in targets.items():
            self._require_complete_cover(
                target_intervals[path], len(target), "normalized-target",
            )
        return decision


__all__ = ("QualityDecision", "QualityGate")
