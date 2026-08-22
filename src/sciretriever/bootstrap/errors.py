"""Stable, path-free errors shared by the bootstrap package."""


class BootstrapError(RuntimeError):
    """Stable, path-free and secret-free production assembly failure."""

    _CODES = frozenset(
        {
            "configuration-invalid",
            "paths-not-ready",
            "parser-not-ready",
            "analysis-not-ready",
            "browser-agent-not-ready",
            "metadata-not-ready",
            "acquisition-not-ready",
            "storage-unavailable",
            "assembly-failed",
        }
    )

    def __init__(self, code: str) -> None:
        safe = code if code in self._CODES else "assembly-failed"
        self.code = safe
        super().__init__(safe)

    def __repr__(self) -> str:
        return f"BootstrapError(code={self.code!r})"


__all__ = ("BootstrapError",)
