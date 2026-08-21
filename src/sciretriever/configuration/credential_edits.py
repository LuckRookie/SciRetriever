"""Atomic publication and removal of Provider/core credential sections."""

from __future__ import annotations

import json
import os
import tempfile
from collections.abc import Callable, Mapping
from pathlib import Path

from sciretriever.configuration.credentials import (
    _CORE_CREDENTIAL_SPECS,
    _CORE_NEXT_ORIGIN_FIELD,
    _CORE_ORIGIN_FIELD,
    _CREDENTIAL_PROVIDER_NAMES,
    _UNSUPPORTED_CREDENTIAL_PROVIDERS,
    CredentialLookup,
    _canonical_credential_origin,
    _core_service_name,
    _credential_payload,
    _credential_specs,
    _credential_value,
    _CredentialBundle,
    _provider_name,
    _read_credentials,
    credential_path,
    load_credentials,
)
from sciretriever.configuration.documents import (
    _call_configuration_failpoint,
    _commit_configuration_staging,
    _configuration_update_payload,
    _prepare_configuration_staging,
)
from sciretriever.configuration.errors import ConfigurationError
from sciretriever.configuration.errors import fail as _fail
from sciretriever.configuration.file_store import (
    _FILE_MODE,
    _lstat,
    _read_verified,
    _secure_directory,
)
from sciretriever.configuration.filesystem import safe_path as _safe_path
from sciretriever.configuration.filesystem import same_metadata as _same_metadata
from sciretriever.model.configuration import (
    AnalysisConfig,
    Configuration,
    CoreCredentialService,
    ParsingConfig,
    ProviderName,
)


def _toml_quote(value: str) -> str:
    # JSON's basic-string escaping is a subset of TOML's basic-string syntax.
    return json.dumps(value, ensure_ascii=False)


def _render_credentials(
    values: Mapping[ProviderName, Mapping[str, str]],
    core: Mapping[CoreCredentialService, Mapping[str, str]],
) -> bytes:
    lines: list[str] = []
    for service in CoreCredentialService:
        section = core.get(service)
        if not section:
            continue
        lines.append(f"[{service.value}]\n")
        for field in sorted(section):
            lines.append(f"{field} = {_toml_quote(section[field])}\n")
        lines.append("\n")
    for provider in sorted(values, key=lambda item: item.value):
        section = values[provider]
        if not section:
            continue
        lines.append(f"[{provider.value}]\n")
        for field in sorted(section):
            value = section[field]
            lines.append(f"{field} = {_toml_quote(value)}\n")
        lines.append("\n")
    return "".join(lines).encode("utf-8")


def _core_section(secret: str, origin: str, service: CoreCredentialService) -> dict[str, str]:
    spec = _CORE_CREDENTIAL_SPECS[service]
    return {
        spec.secret_field: _credential_value(secret),
        _CORE_ORIGIN_FIELD: _canonical_credential_origin(origin),
    }


def _transition_core_section(
    current: Mapping[str, str],
    replacement: Mapping[str, str],
    service: CoreCredentialService,
) -> dict[str, str]:
    spec = _CORE_CREDENTIAL_SPECS[service]
    if current.get(_CORE_ORIGIN_FIELD) == replacement[_CORE_ORIGIN_FIELD]:
        return dict(replacement)
    primary_secret = current.get(spec.secret_field)
    primary_origin = current.get(_CORE_ORIGIN_FIELD)
    if primary_secret is None or primary_origin is None:
        _fail("credentials value is invalid")
    return {
        spec.secret_field: primary_secret,
        _CORE_ORIGIN_FIELD: primary_origin,
        spec.next_secret_field: replacement[spec.secret_field],
        _CORE_NEXT_ORIGIN_FIELD: replacement[_CORE_ORIGIN_FIELD],
    }


def _write_all(descriptor: int, payload: bytes) -> None:
    offset = 0
    while offset < len(payload):
        try:
            written = os.write(descriptor, payload[offset:])
        except OSError:
            _fail("credentials publication failed")
        if written <= 0:
            _fail("credentials publication failed")
        offset += written


def _call_failpoint(failpoint: Callable[[str], None] | None, name: str) -> None:
    if failpoint is None:
        return
    try:
        failpoint(name)
    except ConfigurationError:
        raise
    except BaseException:
        _fail("credentials publication was interrupted")


def _call_post_commit_observer(
    failpoint: Callable[[str], None] | None,
    name: str,
) -> None:
    """Notify a post-commit seam without turning it into a publication failure."""

    try:
        _call_failpoint(failpoint, name)
    except BaseException:
        # ``os.replace`` is the commit point.  Fault injection and cleanup
        # diagnostics after it cannot report failure because the new bytes
        # are already visible to readers.
        pass


def _directory_fd(path: Path) -> int:
    flags = os.O_RDONLY
    for name in ("O_CLOEXEC", "O_DIRECTORY", "O_BINARY"):
        value = getattr(os, name, 0)
        if isinstance(value, int):
            flags |= value
    try:
        return os.open(path, flags)
    except OSError:
        _fail("credentials publication failed")


def _write_and_sync_staging(
    descriptor: int,
    payload: bytes,
    failpoint: Callable[[str], None] | None,
) -> None:
    try:
        os.fchmod(descriptor, _FILE_MODE)
    except OSError:
        _fail("credentials publication failed")
    _call_failpoint(failpoint, "staging-created")
    _write_all(descriptor, payload)
    _call_failpoint(failpoint, "staging-written")
    try:
        os.fsync(descriptor)
    except OSError:
        _fail("credentials publication failed")
    _call_failpoint(failpoint, "staging-fsynced")


def _stage_credentials(
    directory: Path,
    payload: bytes,
    failpoint: Callable[[str], None] | None,
) -> Path:
    descriptor: int | None = None
    staging_path: Path | None = None
    try:
        try:
            descriptor, raw_path = tempfile.mkstemp(
                prefix=".credentials-",
                suffix=".staging",
                dir=directory,
                text=False,
            )
        except OSError:
            _fail("credentials publication failed")
        staging_path = Path(raw_path)
        _write_and_sync_staging(descriptor, payload, failpoint)
        os.close(descriptor)
        descriptor = None
        if staging_path is None:  # pragma: no cover - defensive.
            _fail("credentials publication failed")
        return staging_path
    except ConfigurationError:
        raise
    except BaseException:
        _fail("credentials publication failed")
    finally:
        if descriptor is not None:
            try:
                os.close(descriptor)
            except OSError:
                pass
        if staging_path is not None and descriptor is not None:
            try:
                staging_path.unlink()
            except (FileNotFoundError, OSError):
                pass


def _validate_staging(
    staging_path: Path,
    failpoint: Callable[[str], None] | None,
) -> None:
    staged_raw, _metadata = _read_verified(staging_path, credentials=True, secure=True)
    _credential_payload(staged_raw)
    _call_failpoint(failpoint, "staging-validated")


def _replace_staging(
    staging_path: Path,
    path: Path,
    expected_target: os.stat_result | None,
    failpoint: Callable[[str], None] | None,
) -> None:
    # Re-validate the owner-only directory immediately before the irreversible
    # rename.  This catches a directory replacement/symlink race in addition
    # to the target-file identity check below.
    _secure_directory(path.parent, create=False)
    current = _lstat(path, missing_ok=True, credentials=True)
    if expected_target is None:
        if current is not None:
            _fail("credentials file changed during read")
    elif current is None or not _same_metadata(expected_target, current):
        _fail("credentials file changed during read")
    _call_failpoint(failpoint, "before-replace")
    try:
        os.replace(staging_path, path)
    except OSError:
        _fail("credentials publication failed")


def _sync_directory(path: Path, failpoint: Callable[[str], None] | None) -> None:
    directory_fd = _directory_fd(path.parent)
    try:
        _call_post_commit_observer(failpoint, "before-directory-fsync")
        try:
            os.fsync(directory_fd)
        except OSError:
            _fail("credentials publication failed")
        _call_post_commit_observer(failpoint, "directory-fsynced")
    finally:
        try:
            os.close(directory_fd)
        except OSError:
            _fail("credentials publication failed")


def _atomic_publish(
    path: Path,
    payload: bytes,
    *,
    expected_target: os.stat_result | None,
    failpoint: Callable[[str], None] | None,
) -> None:
    directory = _secure_directory(path.parent, create=True)
    staging_path: Path | None = None
    try:
        staging_path = _stage_credentials(directory, payload, failpoint)
        _validate_staging(staging_path, failpoint)
        _replace_staging(staging_path, path, expected_target, failpoint)
        staging_path = None
        _call_post_commit_observer(failpoint, "after-replace")
        try:
            _sync_directory(path, failpoint)
        except BaseException:
            # Directory durability is still attempted, but a post-commit
            # failure cannot be returned as if the old file were retained.
            pass
    except ConfigurationError:
        raise
    except BaseException:
        _fail("credentials publication failed")
    finally:
        if staging_path is not None:
            try:
                staging_path.unlink()
            except FileNotFoundError:
                pass
            except OSError:
                pass


def _prepare_credentials_staging(path: Path, payload: bytes) -> Path:
    directory = _secure_directory(path.parent, create=True)
    staging = _stage_credentials(directory, payload, None)
    try:
        _validate_staging(staging, None)
        return staging
    except BaseException:
        try:
            staging.unlink()
        except OSError:
            pass
        raise


def _commit_credentials_staging(
    staging: Path,
    path: Path,
    expected: os.stat_result | None,
) -> None:
    _replace_staging(staging, path, expected, None)
    try:
        _sync_directory(path, None)
    except BaseException:
        # The rename is the commit point; directory durability was attempted.
        pass


def _validated_updates(
    provider: ProviderName | str,
    values: Mapping[str, str],
) -> tuple[ProviderName, dict[str, str]]:
    name = _provider_name(provider)
    if name in _UNSUPPORTED_CREDENTIAL_PROVIDERS:
        _fail("credentials provider is unsupported")
    if name not in _CREDENTIAL_PROVIDER_NAMES:
        _fail("credentials provider is unknown")
    if not isinstance(values, Mapping):
        _fail("credentials value is invalid")
    expected = {field.name for field in _credential_specs(name)}
    result: dict[str, str] = {}
    for field, value in values.items():
        if type(field) is not str or field not in expected:
            _fail("credentials field is unknown")
        result[field] = _credential_value(value)
    if not result:
        _fail("credentials value is invalid")
    return name, result


def set_credentials(
    provider: ProviderName | str,
    values: Mapping[str, str],
    *,
    home: str | Path | None = None,
    failpoint: Callable[[str], None] | None = None,
) -> CredentialLookup:
    """Atomically replace one provider section in the fixed credentials file."""

    name, updates = _validated_updates(provider, values)
    path = credential_path(home=home)
    values_before, core_before, metadata_before = _read_credentials(home)
    merged = {provider_name: dict(fields) for provider_name, fields in values_before.items()}
    merged[name] = updates
    payload = _render_credentials(merged, core_before)
    _atomic_publish(
        path,
        payload,
        expected_target=metadata_before,
        failpoint=failpoint,
    )
    return _CredentialBundle(
        {provider_name: dict(fields) for provider_name, fields in merged.items()},
        {service: dict(fields) for service, fields in core_before.items()},
    )


def remove_credentials(
    provider: ProviderName | str,
    *,
    home: str | Path | None = None,
    failpoint: Callable[[str], None] | None = None,
) -> CredentialLookup:
    """Atomically remove one provider section, leaving other sections intact."""

    name = _provider_name(provider)
    if name in _UNSUPPORTED_CREDENTIAL_PROVIDERS:
        return load_credentials(home=home)
    if name not in _CREDENTIAL_PROVIDER_NAMES:
        _fail("credentials provider is unknown")
    path = credential_path(home=home)
    values_before, core_before, metadata_before = _read_credentials(home)
    if name not in values_before:
        return _CredentialBundle(
            {provider_name: dict(fields) for provider_name, fields in values_before.items()},
            {service: dict(fields) for service, fields in core_before.items()},
        )
    del values_before[name]
    payload = _render_credentials(values_before, core_before)
    _atomic_publish(
        path,
        payload,
        expected_target=metadata_before,
        failpoint=failpoint,
    )
    return _CredentialBundle(
        {provider_name: dict(fields) for provider_name, fields in values_before.items()},
        {service: dict(fields) for service, fields in core_before.items()},
    )


def set_core_credentials(
    service: CoreCredentialService | str,
    *,
    secret: str,
    origin: str,
    home: str | Path | None = None,
    failpoint: Callable[[str], None] | None = None,
) -> CredentialLookup:
    """Atomically replace one origin-bound core-service secret section."""

    name = _core_service_name(service)
    section = _core_section(secret, origin, name)
    path = credential_path(home=home)
    providers_before, core_before, metadata_before = _read_credentials(home)
    merged_core = {item: dict(fields) for item, fields in core_before.items()}
    merged_core[name] = section
    payload = _render_credentials(providers_before, merged_core)
    _atomic_publish(
        path,
        payload,
        expected_target=metadata_before,
        failpoint=failpoint,
    )
    return _CredentialBundle(
        {provider: dict(fields) for provider, fields in providers_before.items()},
        {item: dict(fields) for item, fields in merged_core.items()},
    )


def remove_core_credentials(
    service: CoreCredentialService | str,
    *,
    home: str | Path | None = None,
    failpoint: Callable[[str], None] | None = None,
) -> CredentialLookup:
    """Atomically remove one core-service secret section."""

    name = _core_service_name(service)
    path = credential_path(home=home)
    providers_before, core_before, metadata_before = _read_credentials(home)
    if name not in core_before:
        return _CredentialBundle(providers_before, core_before)
    del core_before[name]
    payload = _render_credentials(providers_before, core_before)
    _atomic_publish(
        path,
        payload,
        expected_target=metadata_before,
        failpoint=failpoint,
    )
    return _CredentialBundle(providers_before, core_before)


def _core_credential_versions(
    name: CoreCredentialService,
    current_core: Mapping[CoreCredentialService, Mapping[str, str]],
    replacement: Mapping[str, str] | None,
) -> tuple[
    dict[CoreCredentialService, dict[str, str]],
    dict[CoreCredentialService, dict[str, str]],
]:
    merged = {item: dict(fields) for item, fields in current_core.items()}
    transitional = {item: dict(fields) for item, fields in merged.items()}
    final = {item: dict(fields) for item, fields in merged.items()}
    if replacement is None:
        final.pop(name, None)
        return transitional, final
    final[name] = dict(replacement)
    current = merged.get(name)
    transitional[name] = (
        dict(replacement)
        if current is None
        else _transition_core_section(current, replacement, name)
    )
    return transitional, final


def _prepare_core_update_stagings(
    *,
    selected: Path,
    configuration_payload: bytes,
    credentials_target: Path,
    transition_payload: bytes,
    final_payload: bytes,
    credentials_changed: bool,
    final_credentials_changed: bool,
) -> tuple[Path, Path | None, Path | None]:
    configuration_staging: Path | None = None
    transition_staging: Path | None = None
    final_staging: Path | None = None
    try:
        configuration_staging = _prepare_configuration_staging(
            selected,
            configuration_payload,
        )
        if credentials_changed:
            transition_staging = _prepare_credentials_staging(
                credentials_target,
                transition_payload,
            )
        if final_credentials_changed:
            final_staging = _prepare_credentials_staging(
                credentials_target,
                final_payload,
            )
        return configuration_staging, transition_staging, final_staging
    except BaseException:
        _cleanup_stagings(configuration_staging, transition_staging, final_staging)
        raise


def _cleanup_stagings(*stagings: Path | None) -> None:
    for staging in stagings:
        if staging is None:
            continue
        try:
            staging.unlink()
        except OSError:
            pass


def update_core_service_configuration(
    path: str | Path,
    service: CoreCredentialService | str,
    *,
    analysis: AnalysisConfig | None = None,
    parsing: ParsingConfig | None = None,
    secret: str | None,
    origin: str | None,
    home: str | Path | None = None,
    failpoint: Callable[[str], None] | None = None,
) -> Configuration:
    """Publish one core service's ordinary settings and secret safely.

    The two files cannot share one filesystem rename.  When a credentialed
    endpoint changes, a short-lived transition section first makes both the
    old and new origins usable.  The ordinary configuration is then
    published, after which the credential section is collapsed to the new
    origin.  An interruption at either commit point therefore leaves either
    the old or the new ordinary configuration runnable.
    """

    name = _core_service_name(service)
    if (name is CoreCredentialService.LLM) != (analysis is not None) or (
        name is CoreCredentialService.MINERU
    ) != (parsing is not None):
        _fail("configuration value is invalid")
    if (secret is None) != (origin is None):
        _fail("configuration value is invalid")
    selected = _safe_path(path)
    configuration_payload, configuration_expected, configuration = _configuration_update_payload(
        selected,
        analysis=analysis,
        parsing=parsing,
    )
    credentials_target = credential_path(home=home)
    providers, current_core, credentials_expected = _read_credentials(home)
    replacement = None if secret is None else _core_section(secret, origin or "", name)
    transitional_core, final_core = _core_credential_versions(
        name,
        current_core,
        replacement,
    )
    transition_payload = _render_credentials(providers, transitional_core)
    final_payload = _render_credentials(providers, final_core)
    credentials_changed = transitional_core != current_core
    final_credentials_changed = final_core != transitional_core
    # Cross-directory atomicity is impossible.  Prepare, fsync, and fully
    # reparse every file that may be committed before publishing the first
    # one.  The transition credentials keep both old and new origins runnable
    # across the two visible commit points.
    configuration_staging, transition_staging, final_staging = _prepare_core_update_stagings(
        selected=selected,
        configuration_payload=configuration_payload,
        credentials_target=credentials_target,
        transition_payload=transition_payload,
        final_payload=final_payload,
        credentials_changed=credentials_changed,
        final_credentials_changed=final_credentials_changed,
    )
    try:
        _call_configuration_failpoint(failpoint, "all-stagings-validated")

        if transition_staging is not None:
            _commit_credentials_staging(
                transition_staging,
                credentials_target,
                credentials_expected,
            )
            transition_staging = None
            _providers, _core, credentials_expected = _read_credentials(home)
            del _providers, _core
        if credentials_changed:
            # Keep the observation stable even when the replacement used the
            # same origin and did not require a two-origin recovery section.
            _call_configuration_failpoint(failpoint, "credentials-transition-published")

        assert configuration_staging is not None
        _commit_configuration_staging(
            configuration_staging,
            selected,
            configuration_expected,
        )
        configuration_staging = None
        _call_configuration_failpoint(failpoint, "configuration-published")

        if final_staging is not None:
            _call_configuration_failpoint(failpoint, "before-credentials-finalize")
            _commit_credentials_staging(
                final_staging,
                credentials_target,
                credentials_expected,
            )
            final_staging = None
            _call_post_commit_observer(failpoint, "credentials-finalized")
    finally:
        _cleanup_stagings(
            configuration_staging,
            transition_staging,
            final_staging,
        )
    return configuration
