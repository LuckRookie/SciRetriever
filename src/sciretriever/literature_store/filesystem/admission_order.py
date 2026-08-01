from __future__ import annotations

from contextvars import ContextVar
from dataclasses import dataclass
from uuid import UUID, uuid4


class AdmissionOrderError(Exception):
    __slots__ = ("reason",)

    def __init__(self, reason: str) -> None:
        self.reason = reason
        super().__init__(reason)

    def __str__(self) -> str:
        return self.reason


@dataclass(frozen=True, slots=True)
class HeldAdmission:
    entry_id: UUID
    rank: int
    fingerprint: str
    kind: str


class AdmissionOrderTracker:
    def __init__(self) -> None:
        self._entries: ContextVar[tuple[HeldAdmission, ...]] = ContextVar(
            f"sciretriever-admission-{uuid4()}", default=()
        )

    def add(self, rank: int, fingerprint: str, kind: str) -> HeldAdmission:
        held = self._entries.get()
        if held and (rank, fingerprint) < (held[-1].rank, held[-1].fingerprint):
            raise AdmissionOrderError(
                "admission locks must follow canonical rank and fingerprint order"
            )
        if held and held[-1].kind == "core" and kind not in ("core", "batch"):
            raise AdmissionOrderError(
                "core-write may only precede another ordered core lock or exchange owner"
            )
        if held and held[-1].rank == 20 and kind != "output":
            raise AdmissionOrderError("owner locks may only be followed by output")
        entry = HeldAdmission(uuid4(), rank, fingerprint, kind)
        self._entries.set(held + (entry,))
        return entry

    def remove(self, entry: HeldAdmission) -> None:
        self._entries.set(
            tuple(value for value in self._entries.get() if value.entry_id != entry.entry_id)
        )
