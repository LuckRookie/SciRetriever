from __future__ import annotations


class CandidateRejected(OSError):
    __slots__ = ("code",)

    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(code)

    def __str__(self) -> str:
        return self.code


__all__ = ("CandidateRejected",)
