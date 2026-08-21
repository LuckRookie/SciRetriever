"""Stable, value-free errors shared by the configuration package."""

from __future__ import annotations

from typing import NoReturn

_SAFE_MESSAGES = frozenset(
    {
        "configuration operation failed",
        "configuration input is malformed",
        "configuration input is too large",
        "configuration section is unknown",
        "configuration key is unknown",
        "configuration value is invalid",
        "configuration file is unavailable",
        "configuration file changed during read",
        "configuration file is not a regular file",
        "configuration file is a symbolic link",
        "configuration file has unsafe ownership or permissions",
        "configuration directory is unavailable",
        "configuration directory is not a regular directory",
        "configuration directory is a symbolic link",
        "configuration directory has unsafe ownership or permissions",
        "configuration publication failed",
        "configuration publication was interrupted",
        "credentials provider is unknown",
        "credentials field is unknown",
        "credentials provider is unsupported",
        "credentials service is unknown",
        "credentials value is invalid",
        "credentials file is unavailable",
        "credentials file changed during read",
        "credentials file is not a regular file",
        "credentials file is a symbolic link",
        "credentials file has unsafe ownership or permissions",
        "credentials directory is unavailable",
        "credentials directory is not a regular directory",
        "credentials directory is a symbolic link",
        "credentials directory has unsafe ownership or permissions",
        "credentials publication failed",
        "credentials publication was interrupted",
        "browser profile identity is invalid",
        "browser profile is unavailable",
        "browser profile storage is unavailable",
        "browser profile has unsafe ownership or permissions",
        "browser profile contains an unsafe filesystem entry",
        "browser profile changed during validation",
        "browser profile operation was cancelled",
        "browser profile cleanup failed",
        "browser profile removal failed",
        "browser profile changed during removal",
        "browser profile is already in use",
        "browser access configuration rollback failed",
        "browser policy group is unknown",
        "browser policy override would relax the baseline",
        "provider is unsupported",
        "capability is unsupported",
    }
)


class ConfigurationError(ValueError):
    """A stable error that cannot interpolate configuration or secret values."""

    def __init__(self, message: str = "configuration operation failed") -> None:
        super().__init__(message if message in _SAFE_MESSAGES else "configuration operation failed")


def fail(message: str) -> NoReturn:
    raise ConfigurationError(message)


__all__ = ("ConfigurationError", "fail")
