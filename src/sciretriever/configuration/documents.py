"""Ordinary TOML selection, parsing, diffing, and atomic editing.

The public surface remains :mod:`sciretriever.configuration`.  This file
knows the ordinary configuration document format but not Provider
credential values or runtime probes.
"""

from __future__ import annotations

import os
import sys
import tempfile
from collections.abc import Callable, MutableMapping
from pathlib import Path
from typing import Final, Mapping

if sys.version_info >= (3, 11):
    import tomllib
else:  # pragma: no cover - Python 3.10 uses the locked tomli dependency.
    import tomli as tomllib

import tomlkit
from pydantic import BaseModel, ValidationError
from tomlkit.exceptions import TOMLKitError

from sciretriever.configuration.browser_access import configured_browser_group_policies
from sciretriever.configuration.browser_profiles import (
    BrowserProfileCancellation,
    browser_profile_status,
    initialize_browser_profile,
    remove_browser_profile,
)
from sciretriever.configuration.browser_profiles import (
    check_browser_profile_cancel as _check_browser_profile_cancel,
)
from sciretriever.configuration.errors import ConfigurationError
from sciretriever.configuration.errors import fail as _fail
from sciretriever.configuration.file_store import (
    _FILE_MODE,
    _MAX_CONFIGURATION_BYTES,
    _MAX_CREDENTIALS_BYTES,
    _lstat,
    _lstat_directory,
    _read_verified,
    _secure_configuration_directory,
)
from sciretriever.configuration.filesystem import safe_path as _safe_path
from sciretriever.configuration.filesystem import same_metadata as _same_metadata
from sciretriever.model.configuration import (
    AnalysisConfig,
    BrowserConfig,
    BrowserProfilePresence,
    Configuration,
    ModelProvidersConfig,
    ModelsConfig,
    ParsingConfig,
    SourcesConfig,
)

_CONFIGURATION_DIRECTORY_NAME: Final[str] = ".sciretriever"
_CONFIGURATION_FILE_NAME: Final[str] = "config.toml"


def _empty_configuration() -> Configuration:
    return Configuration()


def _parse_toml(raw: bytes, *, credentials: bool) -> dict[str, object]:
    if len(raw) > (_MAX_CREDENTIALS_BYTES if credentials else _MAX_CONFIGURATION_BYTES):
        _fail("configuration input is too large")
    try:
        text = raw.decode("utf-8")
        value = tomllib.loads(text)
    except (UnicodeDecodeError, tomllib.TOMLDecodeError):
        _fail("configuration input is malformed")
    if not isinstance(value, dict):  # pragma: no cover - tomllib always returns a dict.
        _fail("configuration input is malformed")
    return value


_CONFIGURATION_SECTIONS: Final[frozenset[str]] = frozenset(
    {
        "paths",
        "sources",
        "assets",
        "parsing",
        "providers",
        "models",
        "analyze",
        "browser",
        "execution",
        "library",
    }
)


def _parse_configuration_payload(raw: bytes) -> Configuration:
    payload = _parse_toml(raw, credentials=False)
    if set(payload) - _CONFIGURATION_SECTIONS:
        _fail("configuration section is unknown")
    try:
        value = Configuration.model_validate(payload)
    except ValidationError as error:
        # ``hide_input_in_errors`` on all models means the originating value is
        # not rendered, but use a stable boundary error nevertheless.
        del error
        _fail("configuration value is invalid")
    if value.browser.policy_overrides:
        configured_browser_group_policies(value.browser)
    return value


def parse_configuration(payload: str | bytes) -> Configuration:
    """Parse ordinary configuration text without reading files or secrets."""

    raw = payload.encode("utf-8") if isinstance(payload, str) else payload
    if not isinstance(raw, bytes):
        _fail("configuration value is invalid")
    return _parse_configuration_payload(raw)


def load_configuration(path: str | Path) -> Configuration:
    """Parse one explicitly selected ordinary TOML document.

    This low-level reader does not select the production configuration.  CLI,
    Entry, and Bootstrap use :func:`load_user_configuration` instead.
    """

    selected = _safe_path(path)
    raw, _metadata = _read_verified(selected, credentials=False, secure=False)
    return _parse_configuration_payload(raw)


def configuration_path(*, home: str | Path | None = None) -> Path:
    """Return the one user-level ordinary configuration path.

    ``home`` is a controlled dependency-injection seam for offline tests.  A
    caller cannot select another filename or directory below that home.
    """

    base = Path.home() if home is None else _safe_path(home)
    return base / _CONFIGURATION_DIRECTORY_NAME / _CONFIGURATION_FILE_NAME


def _read_private_configuration_path(
    path: Path,
    *,
    missing_ok: bool,
) -> tuple[bytes, os.stat_result | None]:
    directory = _lstat_directory(
        path.parent,
        missing_ok=True,
        credentials=False,
    )
    if directory is None:
        if missing_ok:
            return b"", None
        _fail("configuration file is unavailable")
    _secure_configuration_directory(path.parent, create=False)
    metadata = _lstat(path, missing_ok=missing_ok, credentials=False)
    if metadata is None:
        return b"", None
    return _read_verified(path, credentials=False, secure=True)


def _read_user_configuration(
    *,
    home: str | Path | None,
    missing_ok: bool,
) -> tuple[bytes, os.stat_result | None]:
    return _read_private_configuration_path(
        configuration_path(home=home),
        missing_ok=missing_ok,
    )


def load_user_configuration(*, home: str | Path | None = None) -> Configuration:
    """Load the fixed user-level ordinary configuration."""

    raw, _metadata = _read_user_configuration(home=home, missing_ok=False)
    return _parse_configuration_payload(raw)


ConfigurationChange = tuple[str, object, object]


def configuration_diff(
    before: Configuration,
    after: Configuration,
    *,
    sections: tuple[str, ...] = ("providers", "models", "analyze", "browser", "parsing"),
) -> tuple[ConfigurationChange, ...]:
    """Return a stable, non-secret ordinary-configuration field diff."""

    if not isinstance(before, Configuration) or not isinstance(after, Configuration):
        _fail("configuration value is invalid")
    if not isinstance(sections, tuple) or any(
        type(section) is not str
        or section not in {"sources", "providers", "models", "analyze", "browser", "parsing"}
        for section in sections
    ):
        _fail("configuration value is invalid")
    before_payload = before.model_dump(mode="json")
    after_payload = after.model_dump(mode="json")
    changes: list[ConfigurationChange] = []
    field_by_section = {"analyze": "analysis"}
    for section in sections:
        field = field_by_section.get(section, section)
        old = before_payload[field]
        new = after_payload[field]
        if not isinstance(old, dict) or not isinstance(new, dict):
            _fail("configuration value is invalid")
        for field in sorted(set(old) | set(new)):
            if old.get(field) != new.get(field):
                changes.append((f"{section}.{field}", old.get(field), new.get(field)))
    return tuple(changes)


def _configuration_document(raw: bytes) -> tomlkit.TOMLDocument:
    if len(raw) > _MAX_CONFIGURATION_BYTES:
        _fail("configuration input is too large")
    try:
        document = tomlkit.parse(raw.decode("utf-8"))
    except (UnicodeDecodeError, TOMLKitError):
        _fail("configuration input is malformed")
    return document


def _configuration_section_payload(value: BaseModel) -> dict[str, object]:
    # The TOML document is a public configuration boundary.  Keep Python-only
    # attribute spellings (for example ``sci_hub``) inside the model and emit
    # the documented aliases (for example ``sci-hub``) when publishing it.
    payload = value.model_dump(mode="json", by_alias=True, exclude_none=True)
    if not isinstance(payload, dict):
        _fail("configuration value is invalid")
    return payload


def _replace_document_section(
    document: tomlkit.TOMLDocument,
    section: str,
    value: BaseModel,
) -> None:
    payload = _configuration_section_payload(value)
    current = document.get(section)
    if current is None:
        table = tomlkit.table()
        document[section] = table
    elif isinstance(current, dict):
        table = current
    else:
        _fail("configuration value is invalid")

    def merge_table(
        target: MutableMapping[str, object],
        replacement: Mapping[str, object],
    ) -> None:
        # Keep TOMLKit table nodes in place so comments attached to existing
        # scalar fields (including nested role tables) survive an edit.
        for field in tuple(target):
            if field not in replacement:
                del target[field]
        for field, field_value in replacement.items():
            existing = target.get(field)
            if isinstance(field_value, Mapping):
                if isinstance(existing, dict):
                    merge_table(existing, field_value)
                else:
                    nested = tomlkit.table()
                    merge_table(nested, field_value)
                    target[field] = nested
            else:
                target[field] = field_value

    merge_table(table, payload)


def _read_editable_configuration(
    *,
    home: str | Path | None,
) -> tuple[bytes, os.stat_result | None]:
    return _read_user_configuration(home=home, missing_ok=True)


def load_editable_user_configuration(
    *,
    home: str | Path | None = None,
) -> Configuration:
    """Load the fixed user config, treating a missing target as empty."""

    raw, _metadata = _read_editable_configuration(home=home)
    return _empty_configuration() if not raw else _parse_configuration_payload(raw)


def _stage_configuration(
    path: Path,
    payload: bytes,
    failpoint: Callable[[str], None] | None,
) -> Path:
    if len(payload) > _MAX_CONFIGURATION_BYTES:
        _fail("configuration input is too large")
    descriptor: int | None = None
    staging: Path | None = None
    try:
        try:
            descriptor, raw_path = tempfile.mkstemp(
                prefix=".config-",
                suffix=".staging",
                dir=path.parent,
                text=False,
            )
        except OSError:
            _fail("configuration publication failed")
        staging = Path(raw_path)
        try:
            os.fchmod(descriptor, _FILE_MODE)
            _call_configuration_failpoint(failpoint, "staging-created")
            _write_configuration_bytes(descriptor, payload)
            _call_configuration_failpoint(failpoint, "staging-written")
            os.fsync(descriptor)
        except OSError:
            _fail("configuration publication failed")
        _call_configuration_failpoint(failpoint, "staging-fsynced")
        os.close(descriptor)
        descriptor = None
        return staging
    finally:
        if descriptor is not None:
            try:
                os.close(descriptor)
            except OSError:
                pass
            if staging is not None:
                try:
                    staging.unlink()
                except OSError:
                    pass


def _write_configuration_bytes(descriptor: int, payload: bytes) -> None:
    offset = 0
    while offset < len(payload):
        try:
            written = os.write(descriptor, payload[offset:])
        except OSError:
            _fail("configuration publication failed")
        if written <= 0:
            _fail("configuration publication failed")
        offset += written


def _call_configuration_failpoint(
    failpoint: Callable[[str], None] | None,
    name: str,
) -> None:
    if failpoint is None:
        return
    try:
        failpoint(name)
    except ConfigurationError:
        raise
    except BaseException:
        _fail("configuration publication was interrupted")


def _open_directory_for_sync(path: Path) -> int:
    flags = os.O_RDONLY
    for name in ("O_CLOEXEC", "O_DIRECTORY", "O_BINARY"):
        value = getattr(os, name, 0)
        if isinstance(value, int):
            flags |= value
    try:
        return os.open(path, flags)
    except OSError:
        _fail("configuration publication failed")


def _replace_configuration_staging(
    staging: Path,
    path: Path,
    expected: os.stat_result | None,
    failpoint: Callable[[str], None] | None,
) -> None:
    _secure_configuration_directory(path.parent, create=False)
    current = _lstat(path, missing_ok=True, credentials=False)
    if expected is None:
        if current is not None:
            _fail("configuration file changed during read")
    elif current is None or not _same_metadata(expected, current):
        _fail("configuration file changed during read")
    _call_configuration_failpoint(failpoint, "before-replace")
    try:
        os.replace(staging, path)
    except OSError:
        _fail("configuration publication failed")


def _publish_configuration(
    path: Path,
    payload: bytes,
    expected: os.stat_result | None,
    failpoint: Callable[[str], None] | None,
) -> None:
    staging: Path | None = None
    directory_fd: int | None = None
    try:
        _secure_configuration_directory(path.parent, create=True)
        staging = _stage_configuration(path, payload, failpoint)
        staged_raw, _metadata = _read_verified(staging, credentials=False, secure=True)
        _parse_configuration_payload(staged_raw)
        _call_configuration_failpoint(failpoint, "staging-validated")
        _replace_configuration_staging(staging, path, expected, failpoint)
        staging = None
        try:
            directory_fd = _open_directory_for_sync(path.parent)
            os.fsync(directory_fd)
        except OSError:
            _fail("configuration publication failed")
    finally:
        if directory_fd is not None:
            try:
                os.close(directory_fd)
            except OSError:
                pass
        if staging is not None:
            try:
                staging.unlink()
            except OSError:
                pass


def _prepare_configuration_staging(path: Path, payload: bytes) -> Path:
    _secure_configuration_directory(path.parent, create=True)
    staging = _stage_configuration(path, payload, None)
    try:
        staged_raw, _metadata = _read_verified(staging, credentials=False, secure=True)
        _parse_configuration_payload(staged_raw)
        return staging
    except BaseException:
        try:
            staging.unlink()
        except OSError:
            pass
        raise


def _commit_configuration_staging(
    staging: Path,
    path: Path,
    expected: os.stat_result | None,
) -> None:
    _replace_configuration_staging(staging, path, expected, None)
    directory_fd: int | None = None
    try:
        directory_fd = _open_directory_for_sync(path.parent)
        os.fsync(directory_fd)
    except BaseException:
        # The rename is already visible.  As with credentials publication,
        # durability is attempted but a post-commit failure cannot restore
        # the old file or be reported as if it were retained.
        pass
    finally:
        if directory_fd is not None:
            try:
                os.close(directory_fd)
            except OSError:
                pass


def update_configuration_sections(
    *,
    sources: SourcesConfig | None = None,
    providers: ModelProvidersConfig | None = None,
    models: ModelsConfig | None = None,
    analysis: AnalysisConfig | None = None,
    parsing: ParsingConfig | None = None,
    browser: BrowserConfig | None = None,
    home: str | Path | None = None,
    failpoint: Callable[[str], None] | None = None,
) -> Configuration:
    """Round-trip selected sections in the fixed user configuration."""

    selected = configuration_path(home=home)
    if (
        sources is None
        and providers is None
        and models is None
        and analysis is None
        and parsing is None
        and browser is None
    ):
        _fail("configuration value is invalid")
    if sources is not None and not isinstance(sources, SourcesConfig):
        _fail("configuration value is invalid")
    if providers is not None and not isinstance(providers, ModelProvidersConfig):
        _fail("configuration value is invalid")
    if models is not None and not isinstance(models, ModelsConfig):
        _fail("configuration value is invalid")
    if analysis is not None and not isinstance(analysis, AnalysisConfig):
        _fail("configuration value is invalid")
    if parsing is not None and not isinstance(parsing, ParsingConfig):
        _fail("configuration value is invalid")
    if browser is not None and not isinstance(browser, BrowserConfig):
        _fail("configuration value is invalid")
    payload, expected, configuration = _configuration_update_payload(
        selected,
        sources=sources,
        providers=providers,
        analysis=analysis,
        models=models,
        parsing=parsing,
        browser=browser,
    )
    _publish_configuration(selected, payload, expected, failpoint)
    return configuration


def configure_browser_access_profile(
    browser: BrowserConfig,
    *,
    home: str | Path | None = None,
    cancel_event: BrowserProfileCancellation | None = None,
    failpoint: Callable[[str], None] | None = None,
) -> Configuration:
    """Atomically select an enabled profile after safely initializing it.

    The ordinary configuration payload is prepared before any profile is
    created.  A newly created empty profile is removed if publication cannot
    reach its commit point; an existing profile is never removed during
    rollback.  This function never opens a Browser or reads profile bytes.
    """

    selected = configuration_path(home=home)
    if not isinstance(browser, BrowserConfig):
        _fail("configuration value is invalid")
    if not browser.enabled or browser.profile is None:
        _fail("enabled Browser access requires a selected profile")
    if cancel_event is not None and not isinstance(cancel_event, BrowserProfileCancellation):
        _fail("configuration value is invalid")
    _check_browser_profile_cancel(cancel_event)
    payload, expected, configuration = _configuration_update_payload(
        selected,
        browser=browser,
    )
    presence = browser_profile_status(browser.profile, home=home).presence
    if presence is BrowserProfilePresence.ATTENTION:
        _fail("browser profile requires operator attention")
    created = presence is BrowserProfilePresence.MISSING
    staging: Path | None = None
    profile_initialized = False
    try:
        initialize_browser_profile(
            browser.profile,
            home=home,
            cancel_event=cancel_event,
        )
        profile_initialized = True
        _call_configuration_failpoint(failpoint, "profile-initialized")
        staging = _prepare_configuration_staging(selected, payload)
        _call_configuration_failpoint(failpoint, "configuration-staged")
        _commit_configuration_staging(staging, selected, expected)
        staging = None
        return configuration
    except BaseException:
        if created and profile_initialized:
            try:
                remove_browser_profile(browser.profile, home=home)
            except ConfigurationError:
                _fail("browser access configuration rollback failed")
        raise
    finally:
        if staging is not None:
            try:
                staging.unlink()
            except OSError:
                pass


def _configuration_update_payload(
    path: Path,
    *,
    sources: SourcesConfig | None = None,
    providers: ModelProvidersConfig | None = None,
    models: ModelsConfig | None = None,
    analysis: AnalysisConfig | None = None,
    parsing: ParsingConfig | None = None,
    browser: BrowserConfig | None = None,
) -> tuple[bytes, os.stat_result | None, Configuration]:
    raw, expected = _read_private_configuration_path(path, missing_ok=True)
    document = _configuration_document(raw)
    if sources is not None:
        _replace_document_section(document, "sources", sources)
    if providers is not None:
        _replace_document_section(document, "providers", providers)
    if models is not None:
        _replace_document_section(document, "models", models)
    if analysis is not None:
        _replace_document_section(document, "analyze", analysis)
    if parsing is not None:
        _replace_document_section(document, "parsing", parsing)
    if browser is not None:
        _replace_document_section(document, "browser", browser)
    try:
        payload = tomlkit.dumps(document).encode("utf-8")
    except (TOMLKitError, UnicodeEncodeError, ValueError, TypeError):
        _fail("configuration value is invalid")
    return payload, expected, _parse_configuration_payload(payload)
