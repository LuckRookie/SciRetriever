"""Launch helpers for the production headed Browser adapter.

The Profile lease and native PDF preference are Network-owned launch concerns,
not properties of Playwright's page-event wrappers. This module intentionally
contains no vendor import; the production CloakBrowser adapter consumes these
helpers through the same opaque Profile lease boundary.
"""

from __future__ import annotations

import json
import os
import stat
import tempfile
from pathlib import Path

_PREFERENCES_MAX_BYTES = 16 * 1024 * 1024
_PREFERENCES_MODE = 0o600
_DIRECTORY_MODE = 0o700


def _current_uid() -> int | None:
    value = getattr(os, "geteuid", None)
    if not callable(value):
        return None
    result = value()
    return result if type(result) is int else None


def _reject_duplicate_preferences(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate Preferences key")
        result[key] = value
    return result


def _reject_preferences_constant(value: str) -> object:
    del value
    raise ValueError("invalid Preferences constant")


class BrowserRuntimeBoundaryError(RuntimeError):
    """Payload-free failure from a neutral Browser launch helper."""


def _runtime_error() -> BrowserRuntimeBoundaryError:
    return BrowserRuntimeBoundaryError("controlled Browser runtime failed")


def runtime_profile_directory(profile_lease: object) -> Path:
    """Validate and return the owner-controlled Profile lease directory."""

    candidate = getattr(profile_lease, "directory", None)
    if not isinstance(candidate, Path):
        raise _runtime_error()
    try:
        if candidate.is_symlink() or not candidate.is_dir():
            raise _runtime_error()
    except BrowserRuntimeBoundaryError:
        raise
    except OSError:
        raise _runtime_error() from None
    return candidate


def _read_preferences(path: Path) -> tuple[dict[str, object], os.stat_result]:  # noqa: C901
    try:
        metadata = os.lstat(path)
        if (
            stat.S_ISLNK(metadata.st_mode)
            or not stat.S_ISREG(metadata.st_mode)
            or metadata.st_nlink != 1
            or metadata.st_size > _PREFERENCES_MAX_BYTES
        ):
            raise _runtime_error()
        flags = os.O_RDONLY
        for name in ("O_CLOEXEC", "O_NOFOLLOW", "O_BINARY"):
            value = getattr(os, name, 0)
            if isinstance(value, int):
                flags |= value
        descriptor = os.open(path, flags)
    except BrowserRuntimeBoundaryError:
        raise
    except OSError:
        raise _runtime_error() from None
    try:
        opened = os.fstat(descriptor)
        if (
            stat.S_ISLNK(opened.st_mode)
            or not stat.S_ISREG(opened.st_mode)
            or opened.st_nlink != 1
            or opened.st_size > _PREFERENCES_MAX_BYTES
            or opened.st_dev != metadata.st_dev
            or opened.st_ino != metadata.st_ino
        ):
            raise _runtime_error()
        payload = bytearray()
        while len(payload) <= _PREFERENCES_MAX_BYTES:
            chunk = os.read(descriptor, min(65_536, _PREFERENCES_MAX_BYTES + 1 - len(payload)))
            if not chunk:
                break
            payload.extend(chunk)
        after = os.fstat(descriptor)
        current = os.lstat(path)
        if (
            len(payload) > _PREFERENCES_MAX_BYTES
            or after.st_dev != opened.st_dev
            or after.st_ino != opened.st_ino
            or after.st_size != len(payload)
            or current.st_dev != after.st_dev
            or current.st_ino != after.st_ino
            or current.st_size != after.st_size
        ):
            raise _runtime_error()
    except BrowserRuntimeBoundaryError:
        raise
    except (OSError, ValueError):
        raise _runtime_error() from None
    finally:
        os.close(descriptor)
    try:
        value = json.loads(
            payload.decode("utf-8"),
            object_pairs_hook=_reject_duplicate_preferences,
            parse_constant=_reject_preferences_constant,
        )
    except (RecursionError, UnicodeDecodeError, TypeError, ValueError):
        raise _runtime_error() from None
    if not isinstance(value, dict):
        raise _runtime_error()
    return value, metadata


def _write_preferences_atomically(  # noqa: C901
    path: Path,
    payload: bytes,
    *,
    expected: os.stat_result | None,
) -> None:
    parent = path.parent
    try:
        parent_metadata = os.lstat(parent)
        if (
            stat.S_ISLNK(parent_metadata.st_mode)
            or not stat.S_ISDIR(parent_metadata.st_mode)
            or (_current_uid() is not None and parent_metadata.st_uid != _current_uid())
            or stat.S_IMODE(parent_metadata.st_mode) != _DIRECTORY_MODE
        ):
            raise _runtime_error()
    except BrowserRuntimeBoundaryError:
        raise
    except OSError:
        raise _runtime_error() from None
    descriptor: int | None = None
    staging: Path | None = None
    try:
        descriptor_raw, staging_raw = tempfile.mkstemp(
            prefix=".preferences-",
            suffix=".staging",
            dir=parent,
        )
        descriptor, staging = descriptor_raw, Path(staging_raw)
        os.fchmod(descriptor, _PREFERENCES_MODE)
        offset = 0
        while offset < len(payload):
            count = os.write(descriptor, payload[offset:])
            if count <= 0:
                raise _runtime_error()
            offset += count
        os.fsync(descriptor)
        os.close(descriptor)
        descriptor = None
        if expected is not None:
            current = os.lstat(path)
            if (
                stat.S_ISLNK(current.st_mode)
                or not stat.S_ISREG(current.st_mode)
                or current.st_nlink != 1
                or current.st_dev != expected.st_dev
                or current.st_ino != expected.st_ino
            ):
                raise _runtime_error()
        os.replace(staging, path)
        staging = None
        try:
            directory_descriptor = os.open(parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
            try:
                os.fsync(directory_descriptor)
            finally:
                os.close(directory_descriptor)
        except OSError:
            # The replacement is already visible and the Browser lease owns
            # this directory; a directory durability failure is still a
            # runtime failure, not a silent success.
            raise _runtime_error() from None
    except BrowserRuntimeBoundaryError:
        raise
    except OSError:
        raise _runtime_error() from None
    finally:
        if descriptor is not None:
            os.close(descriptor)
        if staging is not None:
            try:
                staging.unlink()
            except OSError:
                pass


def configure_pdf_download_preference(directory: Path) -> None:
    """Atomically merge the controlled native PDF preferences.

    The language/profile seed runs before this helper.  Consequently the
    ``Preferences`` file normally already exists and must be extended rather
    than skipped.  Only the two PDF keys are owned here; all other JSON values
    are preserved.  A contradictory operator/browser value is ambiguous and
    fails closed instead of silently changing the Profile's policy.
    """

    try:
        default = directory / "Default"
        default.mkdir(mode=_DIRECTORY_MODE, parents=False, exist_ok=True)
        default_metadata = os.lstat(default)
        if (
            stat.S_ISLNK(default_metadata.st_mode)
            or not stat.S_ISDIR(default_metadata.st_mode)
            or (_current_uid() is not None and default_metadata.st_uid != _current_uid())
            or stat.S_IMODE(default_metadata.st_mode) != _DIRECTORY_MODE
        ):
            raise _runtime_error()
        preferences = default / "Preferences"
        if os.path.lexists(preferences):
            values, metadata = _read_preferences(preferences)
        else:
            values, metadata = {}, None
        if "plugins" not in values:
            plugins: dict[str, object] = {}
        elif isinstance(values["plugins"], dict):
            plugins_value = values["plugins"]
            plugins = dict(plugins_value)
        else:
            raise _runtime_error()
        if "always_open_pdf_externally" in plugins and (
            type(plugins["always_open_pdf_externally"]) is not bool
            or plugins["always_open_pdf_externally"] is not True
        ):
            raise _runtime_error()
        if "open_pdf_in_system_reader" in plugins and (
            type(plugins["open_pdf_in_system_reader"]) is not bool
            or plugins["open_pdf_in_system_reader"] is not False
        ):
            raise _runtime_error()
        changed = "always_open_pdf_externally" not in plugins
        changed = changed or "open_pdf_in_system_reader" not in plugins
        if not changed:
            return
        plugins["always_open_pdf_externally"] = True
        plugins["open_pdf_in_system_reader"] = False
        values["plugins"] = plugins
        payload = json.dumps(
            values,
            ensure_ascii=True,
            separators=(",", ":"),
            sort_keys=True,
        ).encode("utf-8")
        _write_preferences_atomically(preferences, payload, expected=metadata)
    except BrowserRuntimeBoundaryError:
        raise
    except (OSError, TypeError, ValueError):
        raise _runtime_error() from None


__all__ = (
    "BrowserRuntimeBoundaryError",
    "configure_pdf_download_preference",
    "runtime_profile_directory",
)
