"""Verified local-file primitives for ordinary configuration and credentials.

This module owns bounded, no-follow reads and owner-only credential-directory
validation.  It contains no TOML schema or credential policy.
"""

from __future__ import annotations

import os
import stat
from pathlib import Path
from typing import Final

from sciretriever.configuration.errors import fail as _fail
from sciretriever.configuration.filesystem import current_uid as _current_uid
from sciretriever.configuration.filesystem import mode as _mode
from sciretriever.configuration.filesystem import same_identity as _same_identity
from sciretriever.configuration.filesystem import same_metadata as _same_metadata

_MAX_CONFIGURATION_BYTES: Final[int] = 1_048_576
_MAX_CREDENTIALS_BYTES: Final[int] = 1_048_576
_DIRECTORY_MODE: Final[int] = 0o700
_FILE_MODE: Final[int] = 0o600


def _lstat(path: Path, *, missing_ok: bool, credentials: bool) -> os.stat_result | None:
    try:
        value = os.lstat(path)
    except FileNotFoundError:
        if missing_ok:
            return None
        _fail(
            "credentials file is unavailable"
            if credentials
            else "configuration file is unavailable"
        )
    except OSError:
        _fail(
            "credentials file is unavailable"
            if credentials
            else "configuration file is unavailable"
        )
    if stat.S_ISLNK(value.st_mode):
        _fail(
            "credentials file is a symbolic link"
            if credentials
            else "configuration file is a symbolic link"
        )
    return value


def _validate_regular_file(
    metadata: os.stat_result,
    *,
    credentials: bool,
    secure: bool,
) -> None:
    if not stat.S_ISREG(metadata.st_mode):
        _fail(
            "credentials file is not a regular file"
            if credentials
            else "configuration file is not a regular file"
        )
    limit = _MAX_CREDENTIALS_BYTES if credentials else _MAX_CONFIGURATION_BYTES
    if metadata.st_size > limit:
        _fail("configuration input is too large")
    if secure and (
        metadata.st_uid != _current_uid() or _mode(metadata) != _FILE_MODE or metadata.st_nlink != 1
    ):
        _fail(
            "credentials file has unsafe ownership or permissions"
            if credentials
            else "configuration file has unsafe ownership or permissions"
        )


def _open_verified(path: Path, *, credentials: bool, secure: bool) -> tuple[int, os.stat_result]:
    flags = os.O_RDONLY
    for name in ("O_CLOEXEC", "O_NOFOLLOW", "O_BINARY"):
        value = getattr(os, name, 0)
        if isinstance(value, int):
            flags |= value
    try:
        descriptor = os.open(path, flags)
    except FileNotFoundError:
        _fail(
            "credentials file is unavailable"
            if credentials
            else "configuration file is unavailable"
        )
    except OSError:
        _fail(
            "credentials file is unavailable"
            if credentials
            else "configuration file is unavailable"
        )
    try:
        metadata = os.fstat(descriptor)
        _validate_regular_file(metadata, credentials=credentials, secure=secure)
        named = _lstat(path, missing_ok=False, credentials=credentials)
        if named is None or not _same_identity(named, metadata):
            _fail(
                "credentials file changed during read"
                if credentials
                else "configuration file changed during read"
            )
        return descriptor, metadata
    except BaseException:
        os.close(descriptor)
        raise


def _read_bounded(descriptor: int, *, credentials: bool) -> bytes:
    limit = _MAX_CREDENTIALS_BYTES if credentials else _MAX_CONFIGURATION_BYTES
    result = bytearray()
    while len(result) <= limit:
        remaining = limit + 1 - len(result)
        try:
            chunk = os.read(descriptor, min(65_536, remaining))
        except OSError:
            _fail(
                "credentials file is unavailable"
                if credentials
                else "configuration file is unavailable"
            )
        if not chunk:
            break
        result.extend(chunk)
    if len(result) > limit:
        _fail("configuration input is too large")
    return bytes(result)


def _read_verified(path: Path, *, credentials: bool, secure: bool) -> tuple[bytes, os.stat_result]:
    """Read through one descriptor and detect path/content replacement races."""

    named_before = _lstat(path, missing_ok=False, credentials=credentials)
    if named_before is None:  # pragma: no cover - guarded by ``missing_ok``.
        _fail(
            "credentials file is unavailable"
            if credentials
            else "configuration file is unavailable"
        )
    descriptor, descriptor_before = _open_verified(path, credentials=credentials, secure=secure)
    try:
        # Re-check the name immediately after open, before any bytes are read.
        named_after_open = _lstat(path, missing_ok=False, credentials=credentials)
        if named_after_open is None or not _same_identity(named_after_open, descriptor_before):
            _fail(
                "credentials file changed during read"
                if credentials
                else "configuration file changed during read"
            )
        payload = _read_bounded(descriptor, credentials=credentials)
        try:
            descriptor_after = os.fstat(descriptor)
        except OSError:
            _fail(
                "credentials file changed during read"
                if credentials
                else "configuration file changed during read"
            )
        named_after = _lstat(path, missing_ok=False, credentials=credentials)
        if named_after is None or not _same_identity(named_after, descriptor_after):
            _fail(
                "credentials file changed during read"
                if credentials
                else "configuration file changed during read"
            )
        _validate_regular_file(descriptor_after, credentials=credentials, secure=secure)
        if (
            not _same_metadata(descriptor_before, descriptor_after)
            or len(payload) != descriptor_after.st_size
        ):
            _fail(
                "credentials file changed during read"
                if credentials
                else "configuration file changed during read"
            )
        return payload, descriptor_after
    finally:
        os.close(descriptor)


def _secure_directory(path: Path, *, create: bool) -> Path:
    return _secure_private_directory(path, create=create, credentials=True)


def _secure_configuration_directory(path: Path, *, create: bool) -> Path:
    return _secure_private_directory(path, create=create, credentials=False)


def _secure_private_directory(
    path: Path,
    *,
    create: bool,
    credentials: bool,
) -> Path:
    metadata = _lstat_directory(path, missing_ok=True, credentials=credentials)
    if metadata is None and not create:
        _fail(
            "credentials directory is unavailable"
            if credentials
            else "configuration directory is unavailable"
        )
    if metadata is None:
        try:
            path.mkdir(mode=_DIRECTORY_MODE, parents=False, exist_ok=False)
        except FileExistsError:
            metadata = _lstat_directory(
                path,
                missing_ok=False,
                credentials=credentials,
            )
        except OSError:
            _fail(
                "credentials directory is unavailable"
                if credentials
                else "configuration directory is unavailable"
            )
        else:
            metadata = _lstat_directory(
                path,
                missing_ok=False,
                credentials=credentials,
            )
    if metadata is None:  # pragma: no cover - defensive.
        _fail(
            "credentials directory is unavailable"
            if credentials
            else "configuration directory is unavailable"
        )
    if not stat.S_ISDIR(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
        _fail(
            "credentials directory is not a regular directory"
            if credentials
            else "configuration directory is not a regular directory"
        )
    if metadata.st_uid != _current_uid() or _mode(metadata) != _DIRECTORY_MODE:
        _fail(
            "credentials directory has unsafe ownership or permissions"
            if credentials
            else "configuration directory has unsafe ownership or permissions"
        )
    return path


def _lstat_directory(
    path: Path,
    *,
    missing_ok: bool,
    credentials: bool = True,
) -> os.stat_result | None:
    try:
        metadata = os.lstat(path)
    except FileNotFoundError:
        if missing_ok:
            return None
        _fail(
            "credentials directory is unavailable"
            if credentials
            else "configuration directory is unavailable"
        )
    except OSError:
        _fail(
            "credentials directory is unavailable"
            if credentials
            else "configuration directory is unavailable"
        )
    if stat.S_ISLNK(metadata.st_mode):
        _fail(
            "credentials directory is a symbolic link"
            if credentials
            else "configuration directory is a symbolic link"
        )
    if not stat.S_ISDIR(metadata.st_mode):
        _fail(
            "credentials directory is not a regular directory"
            if credentials
            else "configuration directory is not a regular directory"
        )
    return metadata
