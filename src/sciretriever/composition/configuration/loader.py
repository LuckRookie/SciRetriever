from __future__ import annotations

import os
import stat
import sys
from io import BytesIO
from pathlib import Path
from typing import Final, Mapping

from pydantic import ValidationError

if sys.version_info >= (3, 11):
    import tomllib
else:  # pragma: no cover - exercised on Python 3.10
    import tomli as tomllib

from sciretriever.model.configuration import TargetConfig

from .errors import raise_configuration_error
from .paths import TomlTable, prepare_paths
from .validation import validate_configuration

MAX_CONFIGURATION_BYTES: Final = 1_048_576
CONFIGURATION_ENVIRONMENT: Final = "SCIRETRIEVER_CONFIG"


def load_configuration(path: str | Path) -> TargetConfig:
    """Load and validate one target TOML file without resolving secrets."""
    config_path = _configuration_path(path)
    payload = _read_configuration(config_path)
    try:
        base_dir = config_path.parent.resolve(strict=True)
    except OSError:
        raise_configuration_error(("config",), "configuration directory is unavailable")
    return _parse_payload(payload, base_dir)


def parse_configuration(
    payload: str | bytes, *, base_dir: str | Path | None = None
) -> TargetConfig:
    """Parse target TOML bytes or text without reading files or environment variables."""
    raw = payload.encode("utf-8") if isinstance(payload, str) else payload
    if len(raw) > MAX_CONFIGURATION_BYTES:
        raise_configuration_error(("config",), "configuration file exceeds the size limit")
    base = Path.cwd() if base_dir is None else Path(base_dir).expanduser().resolve()
    return _parse_payload(raw, base)


def select_configuration_path(
    explicit: str | Path | None = None,
    *,
    environment: Mapping[str, str] | None = None,
    cwd: str | Path | None = None,
) -> Path:
    """Select a config path using explicit, environment, then local-file precedence."""
    if explicit is not None:
        return Path(explicit).expanduser()
    values = os.environ if environment is None else environment
    configured = values.get(CONFIGURATION_ENVIRONMENT)
    if configured:
        return Path(configured).expanduser()
    local = (Path.cwd() if cwd is None else Path(cwd)) / "config.toml"
    if local.is_file():
        return local
    raise FileNotFoundError(local)


def load_selected_configuration(
    explicit: str | Path | None = None,
    *,
    environment: Mapping[str, str] | None = None,
    cwd: str | Path | None = None,
) -> TargetConfig:
    """Select a config path and load it using documented precedence."""
    return load_configuration(select_configuration_path(explicit, environment=environment, cwd=cwd))


def load_target_config(path: str | Path) -> TargetConfig:
    """Load the target configuration contract from a TOML file."""
    return load_configuration(path)


def _configuration_path(path: str | Path) -> Path:
    return Path(path).expanduser()


def _read_configuration(path: Path) -> bytes:
    """Read one regular configuration file through one verified descriptor."""
    named_before = _named_stat(path, initial=True)
    descriptor = _open_descriptor(path)
    try:
        descriptor_before = _descriptor_stat(descriptor)
        _validate_regular_configuration_file(descriptor_before)
        _require_same_file(named_before, descriptor_before)
        named_after_open = _named_stat(path)
        _validate_regular_configuration_file(named_after_open)
        _require_same_file(named_after_open, descriptor_before)
        payload = _read_bounded(descriptor)
        descriptor_after = _descriptor_stat(descriptor)
        named_after = _named_stat(path)
        _verify_after_read(
            named_after,
            descriptor_before,
            descriptor_after,
            len(payload),
        )
        return payload
    finally:
        os.close(descriptor)


def _open_descriptor(path: Path) -> int:
    flags = os.O_RDONLY
    for flag_name in ("O_CLOEXEC", "O_NOFOLLOW", "O_BINARY"):
        flag = getattr(os, flag_name, 0)
        if isinstance(flag, int):
            flags |= flag
    try:
        return os.open(path, flags)
    except FileNotFoundError:
        raise
    except OSError:
        raise_configuration_error(("config",), "configuration file could not be opened")


def _read_bounded(descriptor: int) -> bytes:
    payload = bytearray()
    while len(payload) <= MAX_CONFIGURATION_BYTES:
        remaining = MAX_CONFIGURATION_BYTES + 1 - len(payload)
        try:
            chunk = os.read(descriptor, min(65_536, remaining))
        except OSError:
            raise_configuration_error(("config",), "configuration file could not be read")
        if not chunk:
            break
        payload.extend(chunk)
    if len(payload) > MAX_CONFIGURATION_BYTES:
        raise_configuration_error(("config",), "configuration file exceeds the size limit")
    return bytes(payload)


def _verify_after_read(
    named_after: os.stat_result,
    descriptor_before: os.stat_result,
    descriptor_after: os.stat_result,
    payload_length: int,
) -> None:
    _validate_regular_configuration_file(descriptor_after)
    _validate_regular_configuration_file(named_after)
    _require_same_file(named_after, descriptor_after)
    if not _metadata_unchanged(descriptor_before, descriptor_after):
        raise_configuration_error(("config",), "configuration file changed during read")
    if payload_length != descriptor_after.st_size:
        raise_configuration_error(("config",), "configuration file changed during read")


def _named_stat(path: Path, *, initial: bool = False) -> os.stat_result:
    try:
        metadata = os.lstat(path)
    except FileNotFoundError:
        if initial:
            raise
        raise_configuration_error(("config",), "configuration file changed during read")
    except OSError:
        raise_configuration_error(("config",), "configuration file identity is unavailable")
    if stat.S_ISLNK(metadata.st_mode):
        raise_configuration_error(("config",), "configuration file must not be a symbolic link")
    return metadata


def _descriptor_stat(descriptor: int) -> os.stat_result:
    try:
        return os.fstat(descriptor)
    except OSError:
        raise_configuration_error(("config",), "configuration descriptor is unavailable")


def _validate_regular_configuration_file(metadata: os.stat_result) -> None:
    if not stat.S_ISREG(metadata.st_mode):
        raise_configuration_error(("config",), "configuration path must be a regular file")
    if metadata.st_size > MAX_CONFIGURATION_BYTES:
        raise_configuration_error(("config",), "configuration file exceeds the size limit")


def _require_same_file(first: os.stat_result, second: os.stat_result) -> None:
    if not os.path.samestat(first, second):
        raise_configuration_error(("config",), "configuration file identity changed during read")


def _metadata_unchanged(first: os.stat_result, second: os.stat_result) -> bool:
    return (
        first.st_dev == second.st_dev
        and first.st_ino == second.st_ino
        and stat.S_IFMT(first.st_mode) == stat.S_IFMT(second.st_mode)
        and first.st_size == second.st_size
        and first.st_mtime_ns == second.st_mtime_ns
        and first.st_ctime_ns == second.st_ctime_ns
    )


def _parse_payload(raw: bytes, base_dir: Path) -> TargetConfig:
    payload: TomlTable = tomllib.load(BytesIO(raw))
    prepare_paths(payload, base_dir)
    try:
        config = TargetConfig.model_validate(payload)
    except ValidationError:
        raise
    return validate_configuration(config)


__all__ = (
    "CONFIGURATION_ENVIRONMENT",
    "MAX_CONFIGURATION_BYTES",
    "load_configuration",
    "load_selected_configuration",
    "load_target_config",
    "parse_configuration",
    "select_configuration_path",
)
