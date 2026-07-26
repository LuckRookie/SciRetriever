from __future__ import annotations

from collections.abc import Mapping
from dataclasses import replace
from enum import Enum
from io import BytesIO
import os
from pathlib import Path
import stat

from sciretriever.config_models import SciRetrieverConfig
from sciretriever.config_wp6 import parse_wp6_sections
from sciretriever.errors import ConfigError


MAX_CONFIG_BYTES = 1024 * 1024
ROOT_KEYS = {
    "schema_version", "paths", "credentials", "discovery", "search", "acquisition",
    "analysis", "package", "expansion", "curation", "export",
    "document_start_interval_seconds",
}
CREDENTIAL_KEYS = {
    "unpaywall_email", "semantic_scholar_api_key", "elsevier_api_key",
    "wiley_api_key", "springer_api_key",
}


class ConfigLoadFailure(str, Enum):
    FILE_INACCESSIBLE = "config file is not accessible"
    PATH_NOT_REGULAR = "config path must be a regular non-symlink file"
    DIRECTORY_INACCESSIBLE = "config directory is not accessible"
    DIRECTORY_INVALID = "config directory must be a real directory"
    OPEN_UNSAFE = "config file could not be opened safely"
    FILE_CHANGED = "config file changed while opening"
    FILE_TOO_LARGE = f"config file exceeds {MAX_CONFIG_BYTES} bytes"
    DIRECTORY_CHANGED = "config directory changed while reading"
    INVALID_TOML = "config file is not valid TOML"


class ConfigLoadError(ConfigError):
    def __init__(self, failure: ConfigLoadFailure) -> None:
        super().__init__(failure.value)
        self.failure = failure


def _read_config_snapshot(config_path: Path) -> tuple[os.stat_result, bytes, Path]:
    try:
        before = config_path.lstat()
    except OSError as error:
        raise ConfigLoadError(ConfigLoadFailure.FILE_INACCESSIBLE) from error
    if stat.S_ISLNK(before.st_mode) or not stat.S_ISREG(before.st_mode):
        raise ConfigLoadError(ConfigLoadFailure.PATH_NOT_REGULAR)
    try:
        canonical_path = config_path.resolve(strict=True)
    except OSError as error:
        raise ConfigLoadError(ConfigLoadFailure.FILE_INACCESSIBLE) from error
    canonical_parent = canonical_path.parent
    try:
        parent_before = canonical_parent.lstat()
    except OSError as error:
        raise ConfigLoadError(ConfigLoadFailure.DIRECTORY_INACCESSIBLE) from error
    if stat.S_ISLNK(parent_before.st_mode) or not stat.S_ISDIR(parent_before.st_mode):
        raise ConfigLoadError(ConfigLoadFailure.DIRECTORY_INVALID)
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(canonical_path, flags)
    except OSError as error:
        raise ConfigLoadError(ConfigLoadFailure.OPEN_UNSAFE) from error
    try:
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode):
            raise ConfigLoadError(ConfigLoadFailure.PATH_NOT_REGULAR)
        if (before.st_dev, before.st_ino) != (metadata.st_dev, metadata.st_ino):
            raise ConfigLoadError(ConfigLoadFailure.FILE_CHANGED)
        with os.fdopen(descriptor, "rb", closefd=True) as stream:
            descriptor = -1
            payload = stream.read(MAX_CONFIG_BYTES + 1)
    finally:
        if descriptor >= 0:
            os.close(descriptor)
    if len(payload) > MAX_CONFIG_BYTES:
        raise ConfigLoadError(ConfigLoadFailure.FILE_TOO_LARGE)
    try:
        parent_after = canonical_parent.lstat()
    except OSError as error:
        raise ConfigLoadError(ConfigLoadFailure.DIRECTORY_CHANGED) from error
    if (
        stat.S_ISLNK(parent_after.st_mode)
        or not stat.S_ISDIR(parent_after.st_mode)
        or (parent_before.st_dev, parent_before.st_ino)
        != (parent_after.st_dev, parent_after.st_ino)
    ):
        raise ConfigLoadError(ConfigLoadFailure.DIRECTORY_CHANGED)
    return metadata, payload, canonical_parent


def load_config(path: str | os.PathLike[str]) -> SciRetrieverConfig:
    """Load one strict config file without creating or modifying filesystem entries."""
    from sciretriever.config import (
        TOML_DECODE_ERROR, TOML_LOAD,
        _parse_acquisition, _parse_analysis, _parse_credentials, _parse_discovery,
        _parse_package, _parse_paths, _parse_search,
    )

    config_path = Path(path).expanduser()
    metadata, payload, parent = _read_config_snapshot(config_path)
    try:
        root = TOML_LOAD(BytesIO(payload))
    except TOML_DECODE_ERROR as error:
        raise ConfigLoadError(ConfigLoadFailure.INVALID_TOML) from error
    unknown = sorted(set(root) - ROOT_KEYS)
    if unknown:
        raise ConfigError(f"unknown config field: {unknown[0]}")
    version = root.get("schema_version")
    if not isinstance(version, int) or isinstance(version, bool) or version != 1:
        raise ConfigError("config field schema_version must be integer 1")
    credentials = _parse_credentials(root)
    if any(credentials.get(name) is not None for name in CREDENTIAL_KEYS):
        if os.name == "posix" and metadata.st_mode & 0o077:
            raise ConfigError("config file containing credentials must have mode 0600 or stricter")
    expansion, curation, export, interval = parse_wp6_sections(root)
    acquisition = _parse_acquisition(root, parent)
    acquisition_table = root.get("acquisition", {})
    if isinstance(acquisition_table, Mapping):
        browser_table = acquisition_table.get("browser", {})
        if isinstance(browser_table, Mapping):
            raw_profile = browser_table.get("profile_dir")
            if isinstance(raw_profile, str):
                profile_reference = Path(raw_profile).expanduser()
                if not profile_reference.is_absolute():
                    profile_reference = parent / profile_reference
                acquisition = replace(
                    acquisition,
                    browser=replace(acquisition.browser, profile_reference=profile_reference),
                )
    return SciRetrieverConfig(
        schema_version=version,
        paths=_parse_paths(root, parent),
        credentials=credentials,
        discovery=_parse_discovery(root),
        search=_parse_search(root),
        acquisition=acquisition,
        analysis=_parse_analysis(root),
        package=_parse_package(root),
        expansion=expansion,
        curation=curation,
        export=export,
        document_start_interval_seconds=interval,
    )


__all__ = ("ConfigLoadError", "ConfigLoadFailure", "MAX_CONFIG_BYTES", "load_config")
