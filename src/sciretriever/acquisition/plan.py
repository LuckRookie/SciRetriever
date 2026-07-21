"""Strict, credential-free durable P5 source plans."""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
import json
import re
from typing import Mapping

from sciretriever.acquisition.models import validate_provider_name
from sciretriever.core.enums import AssetRole


SOURCE_PLAN_SCHEMA_VERSION = 1
_TOKEN = re.compile(r"^[a-z][a-z0-9_-]{0,63}$")
_SECRET_MARKERS = ("api_key", "apikey", "password", "secret", "token", "credential")


class RoutingMode(str, Enum):
    SERIAL = "serial"
    RACE = "race"


def _token(value: str, field_name: str) -> str:
    if not isinstance(value, str) or not _TOKEN.fullmatch(value):
        raise ValueError(f"{field_name} must be a lowercase token")
    return value


@dataclass(frozen=True, slots=True)
class SourceEntry:
    candidate_id: str
    provider: str
    priority: int
    tier: int = 0
    locator: str | None = None
    config_refs: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        object.__setattr__(self, "candidate_id", _token(self.candidate_id, "candidate_id"))
        object.__setattr__(self, "provider", validate_provider_name(self.provider))
        for name, value in (("priority", self.priority), ("tier", self.tier)):
            if not isinstance(value, int) or isinstance(value, bool) or value < 0:
                raise ValueError(f"{name} must be a nonnegative integer")
        if self.locator is not None:
            object.__setattr__(self, "locator", _token(self.locator, "locator"))
        refs = tuple(_token(value, "config_ref") for value in self.config_refs)
        if len(set(refs)) != len(refs):
            raise ValueError("config_refs must be unique")
        if any(marker in value for value in refs for marker in _SECRET_MARKERS):
            raise ValueError("source plans may reference configuration names, not credential values")
        object.__setattr__(self, "config_refs", refs)

    def to_dict(self) -> dict[str, object]:
        return {
            "candidate_id": self.candidate_id,
            "config_refs": list(self.config_refs),
            "locator": self.locator,
            "priority": self.priority,
            "provider": self.provider,
            "tier": self.tier,
        }

    @classmethod
    def from_dict(cls, value: Mapping[str, object]) -> "SourceEntry":
        expected = {"candidate_id", "config_refs", "locator", "priority", "provider", "tier"}
        if set(value) != expected:
            raise ValueError("source entry fields are not exact")
        refs = value["config_refs"]
        if not isinstance(refs, list) or any(not isinstance(item, str) for item in refs):
            raise ValueError("config_refs must be a string list")
        candidate_id = value["candidate_id"]
        provider = value["provider"]
        priority = value["priority"]
        tier = value["tier"]
        locator = value["locator"]
        if not isinstance(candidate_id, str) or not isinstance(provider, str):
            raise ValueError("candidate_id and provider must be strings")
        if not isinstance(priority, int) or isinstance(priority, bool):
            raise ValueError("priority must be an integer")
        if not isinstance(tier, int) or isinstance(tier, bool):
            raise ValueError("tier must be an integer")
        if locator is not None and not isinstance(locator, str):
            raise ValueError("locator must be a string or null")
        return cls(
            candidate_id=candidate_id,
            provider=provider,
            priority=priority,
            tier=tier,
            locator=locator,
            config_refs=tuple(refs),
        )


@dataclass(frozen=True, slots=True)
class SourcePlan:
    role: AssetRole
    mode: RoutingMode
    entries: tuple[SourceEntry, ...]
    schema_version: int = SOURCE_PLAN_SCHEMA_VERSION

    def __post_init__(self) -> None:
        if self.schema_version != SOURCE_PLAN_SCHEMA_VERSION:
            raise ValueError("unsupported source plan schema version")
        if not isinstance(self.role, AssetRole):
            raise TypeError("role must be an AssetRole")
        if not isinstance(self.mode, RoutingMode):
            raise TypeError("mode must be a RoutingMode")
        if not self.entries:
            raise ValueError("source plan requires at least one entry")
        ids = [entry.candidate_id for entry in self.entries]
        if len(set(ids)) != len(ids):
            raise ValueError("candidate_id values must be unique")
        ordered = tuple(sorted(self.entries, key=lambda item: (item.tier, item.priority, item.candidate_id)))
        if ordered != self.entries:
            raise ValueError("source plan entries must be in deterministic tier/priority/id order")

    def to_dict(self) -> dict[str, object]:
        return {
            "entries": [entry.to_dict() for entry in self.entries],
            "mode": self.mode.value,
            "role": self.role.value,
            "schema_version": self.schema_version,
        }

    def to_json(self) -> str:
        return json.dumps(self.to_dict(), sort_keys=True, separators=(",", ":"), ensure_ascii=True)

    @classmethod
    def from_dict(cls, value: Mapping[str, object]) -> "SourcePlan":
        if set(value) != {"entries", "mode", "role", "schema_version"}:
            raise ValueError("source plan fields are not exact")
        entries = value["entries"]
        if not isinstance(entries, list) or any(not isinstance(item, dict) for item in entries):
            raise ValueError("source plan entries must be an object list")
        role = value["role"]
        mode = value["mode"]
        version = value["schema_version"]
        if not isinstance(role, str) or not isinstance(mode, str):
            raise ValueError("source plan role and mode must be strings")
        if not isinstance(version, int) or isinstance(version, bool):
            raise ValueError("source plan schema_version must be an integer")
        try:
            return cls(
                role=AssetRole(role),
                mode=RoutingMode(mode),
                entries=tuple(SourceEntry.from_dict(item) for item in entries),
                schema_version=version,
            )
        except (TypeError, ValueError) as error:
            raise ValueError(f"invalid source plan: {error}") from error

    @classmethod
    def from_json(cls, value: str) -> "SourcePlan":
        if not isinstance(value, str):
            raise TypeError("source plan JSON must be a string")
        try:
            decoded = json.loads(value)
        except json.JSONDecodeError as error:
            raise ValueError("source plan is not valid JSON") from error
        if not isinstance(decoded, dict):
            raise ValueError("source plan must be a JSON object")
        plan = cls.from_dict(decoded)
        if plan.to_json() != value:
            raise ValueError("source plan JSON must be canonical")
        return plan


__all__ = ("RoutingMode", "SOURCE_PLAN_SCHEMA_VERSION", "SourceEntry", "SourcePlan")
