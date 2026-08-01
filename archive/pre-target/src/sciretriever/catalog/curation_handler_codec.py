from __future__ import annotations

import json
from typing import TypeAlias

from sciretriever.catalog.author_curation import AuthorMergeHandler, _AuthorState
from sciretriever.catalog.curation_contracts import CurationBoundaryError, CurationHandler
from sciretriever.catalog.engine import CatalogEngine
from sciretriever.catalog.manual_metadata_curation import (
    ManualMetadataClearHandler,
    ManualMetadataSetHandler,
    _MetadataState,
)
from sciretriever.catalog.manual_tag_curation import ManualTagAddHandler, ManualTagRemoveHandler, _TagState
from sciretriever.catalog.preferred_curation import PreferredClearHandler, PreferredSetHandler, _PreferredState
from sciretriever.catalog.review_curation import ReviewResolutionHandler
from sciretriever.catalog.work_curation import WorkMergeHandler, WorkVersionRegroupHandler, _WorkState
from sciretriever.core.curation import ReviewDecision
from sciretriever.core.snapshots import SafeSnapshot, SnapshotValue


JsonValue: TypeAlias = SnapshotValue | list["JsonValue"] | dict[str, "JsonValue"]


def _work_state(state: _WorkState) -> list[JsonValue]:
    return [state.status, state.merged_into, state.preferred_id, state.preferred_manual,
            state.needs_review, state.review_reason, state.updated_at]


def _encode(handler: CurationHandler) -> dict[str, JsonValue] | None:
    match handler:
        case WorkMergeHandler():
            return {"kind": "merge_work", "source": handler.source_work_id, "target": handler.target_work_id,
                    "operation": handler.operation_id, "expected": handler.expected_before_sha256,
                    "source_state": _work_state(handler.source_state), "target_state": _work_state(handler.target_state),
                    "versions": list(handler.source_version_ids), "identifiers": list(handler.source_identifier_ids),
                    "source_tags": [list(row) for row in handler.source_tags],
                    "target_tags": [list(row) for row in handler.target_tags], "references": list(handler.reference_ids),
                    "reviews": [[row[0], row[1], list(row[2])] for row in handler.review_rows]}
        case WorkVersionRegroupHandler():
            return {"kind": "regroup", "version": handler.work_version_id, "source": handler.source_work_id,
                    "target": handler.target_work_id, "operation": handler.operation_id,
                    "expected": handler.expected_before_sha256, "source_state": _work_state(handler.source_state),
                    "target_state": _work_state(handler.target_state)}
        case ReviewResolutionHandler():
            return {"kind": "review", "review": handler.review_id, "decision": handler.decision.value,
                    "operation": handler.operation_id, "expected": handler.expected_before_sha256,
                    "state": handler.before_state, "before_decision": handler.before_decision,
                    "updated": handler.before_updated_at, "resolved": handler.before_resolved_at}
        case PreferredSetHandler() | PreferredClearHandler():
            value: dict[str, JsonValue] = {
                "kind": "preferred_set" if isinstance(handler, PreferredSetHandler) else "preferred_clear",
                "work": handler.work_id, "operation": handler.operation_id,
                "expected": handler.expected_before_sha256,
                "before": [handler.before.preferred_id, handler.before.manual, handler.before.updated_at],
            }
            if isinstance(handler, PreferredSetHandler):
                value["version"] = handler.work_version_id
            return value
        case ManualMetadataSetHandler() | ManualMetadataClearHandler():
            value = {"kind": "metadata_set" if isinstance(handler, ManualMetadataSetHandler) else "metadata_clear",
                     "version": handler.work_version_id, "field": handler.field_name,
                     "operation": handler.operation_id, "expected": handler.expected_before_sha256,
                     "before": [handler.before.override_json, handler.before.override_updated_at,
                                handler.before.canonical_value, handler.before.normalized_title,
                                handler.before.version_updated_at], "value_json": handler.value_json}
            return value
        case ManualTagAddHandler() | ManualTagRemoveHandler():
            return {"kind": "tag_add" if isinstance(handler, ManualTagAddHandler) else "tag_remove",
                    "work": handler.work_id, "tag": handler.tag_id, "operation": handler.operation_id,
                    "expected": handler.expected_before_sha256, "linked_at": handler.before.linked_at,
                    "present": handler.present}
        case AuthorMergeHandler():
            return {"kind": "author_merge", "source": handler.source_author_id,
                    "target": handler.target_author_id, "operation": handler.operation_id,
                    "expected": handler.expected_before_sha256,
                    "evidence": {name: item for name, item in handler.evidence.values},
                    "source_state": [handler.source_state.orcid, handler.source_state.status, handler.source_state.merged_into],
                    "target_state": [handler.target_state.orcid, handler.target_state.status, handler.target_state.merged_into],
                    "authorships": list(handler.source_authorship_ids), "collisions": handler.collision_count}
        case _:
            return None


def encode_handler(handler: CurationHandler) -> str | None:
    value = _encode(handler)
    if value is None:
        return None
    payload = json.dumps(value, ensure_ascii=True, allow_nan=False,
                         separators=(",", ":"), sort_keys=True).encode("ascii")
    if len(payload) > 65_536:
        raise CurationBoundaryError("undo_handler_bound")
    return payload.decode("ascii")


def _required(value: dict[str, JsonValue], name: str, expected: type[str] | type[int] | type[list]) -> str | int | list[JsonValue]:
    item = value.get(name)
    if not isinstance(item, expected):
        raise CurationBoundaryError("undo_handler_value")
    return item


def _string(value: dict[str, JsonValue], name: str) -> str:
    item = _required(value, name, str)
    if not isinstance(item, str):
        raise CurationBoundaryError("undo_handler_value")
    return item


def _optional_string(item: JsonValue) -> str | None:
    if item is None or isinstance(item, str):
        return item
    raise CurationBoundaryError("undo_handler_value")


def _strings(value: JsonValue) -> tuple[str, ...]:
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        raise CurationBoundaryError("undo_handler_value")
    return tuple(item for item in value if isinstance(item, str))


def _state(value: JsonValue) -> _WorkState:
    if not isinstance(value, list) or len(value) != 7:
        raise CurationBoundaryError("undo_handler_value")
    status, merged, preferred, manual, review, reason, updated = value
    if not isinstance(status, str) or not isinstance(manual, int) or not isinstance(review, int) or not isinstance(updated, str):
        raise CurationBoundaryError("undo_handler_value")
    return _WorkState(status, _optional_string(merged), _optional_string(preferred), manual, review,
                      _optional_string(reason), updated)


def decode_handler(catalog: CatalogEngine, payload: str) -> CurationHandler:
    try:
        if len(payload.encode("ascii")) > 65_536:
            raise CurationBoundaryError("undo_handler_bound")
        raw = json.loads(payload)
    except (UnicodeEncodeError, json.JSONDecodeError):
        raise CurationBoundaryError("undo_handler_json") from None
    if not isinstance(raw, dict):
        raise CurationBoundaryError("undo_handler_json")
    value: dict[str, JsonValue] = raw
    kind = _string(value, "kind")
    operation, expected = _string(value, "operation"), _string(value, "expected")
    match kind:
        case "merge_work":
            reviews_value = value.get("reviews")
            if not isinstance(reviews_value, list):
                raise CurationBoundaryError("undo_handler_value")
            reviews: list[tuple[str, str, tuple[str, ...]]] = []
            for row in reviews_value:
                if not isinstance(row, list) or len(row) != 3 or not isinstance(row[0], str) or not isinstance(row[1], str):
                    raise CurationBoundaryError("undo_handler_value")
                reviews.append((row[0], row[1], _strings(row[2])))
            def pairs(name: str) -> tuple[tuple[str, str], ...]:
                rows = value.get(name)
                if not isinstance(rows, list):
                    raise CurationBoundaryError("undo_handler_value")
                result: list[tuple[str, str]] = []
                for row in rows:
                    if not isinstance(row, list) or len(row) != 2 or not all(isinstance(item, str) for item in row):
                        raise CurationBoundaryError("undo_handler_value")
                    result.append((str(row[0]), str(row[1])))
                return tuple(result)
            return WorkMergeHandler(catalog, _string(value, "source"), _string(value, "target"), operation,
                                    expected, _state(value.get("source_state")), _state(value.get("target_state")),
                                    _strings(value.get("versions")), _strings(value.get("identifiers")),
                                    pairs("source_tags"), pairs("target_tags"), _strings(value.get("references")), tuple(reviews))
        case "regroup":
            return WorkVersionRegroupHandler(catalog, _string(value, "version"), _string(value, "source"),
                                             _string(value, "target"), operation, expected,
                                             _state(value.get("source_state")), _state(value.get("target_state")))
        case "review":
            return ReviewResolutionHandler(catalog, _string(value, "review"), ReviewDecision(_string(value, "decision")),
                                           operation, expected, _string(value, "state"),
                                           _optional_string(value.get("before_decision")), _string(value, "updated"),
                                           _optional_string(value.get("resolved")))
        case "preferred_set" | "preferred_clear":
            before = value.get("before")
            if not isinstance(before, list) or len(before) != 3 or not isinstance(before[1], int) or not isinstance(before[2], str):
                raise CurationBoundaryError("undo_handler_value")
            state = _PreferredState(_optional_string(before[0]), before[1], before[2])
            return (PreferredSetHandler(_string(value, "work"), _string(value, "version"), operation, expected, state)
                    if kind == "preferred_set" else PreferredClearHandler(_string(value, "work"), operation, expected, state))
        case "metadata_set" | "metadata_clear":
            before = value.get("before")
            if not isinstance(before, list) or len(before) != 5 or not isinstance(before[4], str):
                raise CurationBoundaryError("undo_handler_value")
            canonical = before[2]
            if canonical is not None and not isinstance(canonical, (str, int)):
                raise CurationBoundaryError("undo_handler_value")
            state = _MetadataState(_optional_string(before[0]), _optional_string(before[1]), canonical,
                                   _optional_string(before[3]), before[4])
            values = (_string(value, "version"), _string(value, "field"), operation, expected, state,
                      _optional_string(value.get("value_json")))
            return ManualMetadataSetHandler(*values) if kind == "metadata_set" else ManualMetadataClearHandler(*values)
        case "tag_add" | "tag_remove":
            state = _TagState(_optional_string(value.get("linked_at")))
            present = value.get("present")
            if not isinstance(present, bool):
                raise CurationBoundaryError("undo_handler_value")
            values = (_string(value, "work"), _string(value, "tag"), operation, expected, state, present)
            return ManualTagAddHandler(*values) if kind == "tag_add" else ManualTagRemoveHandler(*values)
        case "author_merge":
            source_state, target_state = value.get("source_state"), value.get("target_state")
            if not isinstance(source_state, list) or not isinstance(target_state, list) or len(source_state) != 3 or len(target_state) != 3:
                raise CurationBoundaryError("undo_handler_value")
            evidence = value.get("evidence")
            collisions = value.get("collisions")
            if not isinstance(evidence, dict) or not isinstance(collisions, int):
                raise CurationBoundaryError("undo_handler_value")
            evidence_values: dict[str, SnapshotValue] = {}
            for name, item in evidence.items():
                if not isinstance(name, str) or not isinstance(item, (str, int, bool, type(None))):
                    raise CurationBoundaryError("undo_handler_value")
                evidence_values[name] = item
            return AuthorMergeHandler(catalog, _string(value, "source"), _string(value, "target"), operation,
                                      expected, SafeSnapshot.from_dict(evidence_values),
                                      _AuthorState(_optional_string(source_state[0]), _string({"v": source_state[1]}, "v"), _optional_string(source_state[2])),
                                      _AuthorState(_optional_string(target_state[0]), _string({"v": target_state[1]}, "v"), _optional_string(target_state[2])),
                                      _strings(value.get("authorships")), collisions)
        case _:
            raise CurationBoundaryError("undo_handler_kind")


__all__ = ("decode_handler", "encode_handler")
