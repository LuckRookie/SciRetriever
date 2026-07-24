"""Read-only acquisition policy and provider readiness checks."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import asdict, dataclass
import os
from pathlib import Path
import shutil
import stat
from urllib.parse import urlsplit

from sciretriever.acquisition.url_policy import UrlPolicy
from sciretriever.acquisition.policy_files import read_policy_lines
from sciretriever.config import ACQUISITION_PROVIDERS, CredentialsConfig, SciRetrieverConfig, get_credential
from sciretriever.acquisition.browser import validate_browser_profile
from sciretriever.core.enums import AssetRole
from sciretriever.network import HeadersTransport
from sciretriever.errors import SciRetrieverError


READINESS_STATUSES = frozenset({"ready", "missing", "invalid", "unreachable", "not_checked"})
_REQUIRED_CREDENTIALS = {
    "unpaywall": ("SCIRETRIEVER_UNPAYWALL_EMAIL", "unpaywall_email"),
    "elsevier": ("SCIRETRIEVER_ELSEVIER_API_KEY", "elsevier_api_key"),
    "wiley": ("SCIRETRIEVER_WILEY_API_KEY", "wiley_api_key"),
    "springer": ("SCIRETRIEVER_SPRINGER_API_KEY", "springer_api_key"),
}


@dataclass(frozen=True, slots=True)
class PreflightCheck:
    name: str
    status: str
    reason: str

    def __post_init__(self) -> None:
        if self.status not in READINESS_STATUSES:
            raise ValueError("unsupported preflight status")


@dataclass(frozen=True, slots=True)
class PreflightReport:
    status: str
    policy: Mapping[str, object]
    checks: tuple[PreflightCheck, ...]

    def to_dict(self) -> dict[str, object]:
        return {
            "checks": [asdict(check) for check in self.checks],
            "policy": dict(self.policy),
            "status": self.status,
        }


def _path_kind(path: Path, *, directory: bool) -> PreflightCheck:
    name = "storage_root" if directory else "catalog"
    try:
        metadata = path.lstat()
    except FileNotFoundError:
        if directory:
            return PreflightCheck(name, "missing", "path does not exist")
        parent = path.parent
        try:
            parent_metadata = parent.lstat()
        except OSError:
            return PreflightCheck(name, "missing", "catalog parent does not exist")
        if stat.S_ISLNK(parent_metadata.st_mode) or not stat.S_ISDIR(parent_metadata.st_mode):
            return PreflightCheck(name, "invalid", "catalog parent must be a real directory")
        if not os.access(parent, os.R_OK | os.W_OK | os.X_OK):
            return PreflightCheck(name, "invalid", "catalog parent is not readable and writable")
        return PreflightCheck(name, "ready", "catalog parent is readable and writable")
    except OSError:
        return PreflightCheck(name, "invalid", "path is not accessible")
    expected = stat.S_ISDIR(metadata.st_mode) if directory else stat.S_ISREG(metadata.st_mode)
    if stat.S_ISLNK(metadata.st_mode) or not expected:
        return PreflightCheck(name, "invalid", "path has an invalid filesystem type")
    required = os.R_OK | os.W_OK | os.X_OK if directory else os.R_OK | os.W_OK
    if not os.access(path, required):
        return PreflightCheck(name, "invalid", "path is not readable and writable")
    if not directory:
        parent_check = _path_kind(path.parent, directory=True)
        if parent_check.status != "ready":
            return PreflightCheck(name, "invalid", "catalog parent is not a readable and writable real directory")
    return PreflightCheck(name, "ready", "path is ready")


def _regular_file(path: Path, name: str) -> PreflightCheck:
    try:
        metadata = path.lstat()
    except FileNotFoundError:
        return PreflightCheck(name, "missing", "file does not exist")
    except OSError:
        return PreflightCheck(name, "invalid", "file is not accessible")
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
        return PreflightCheck(name, "invalid", "file must be regular and non-symlink")
    if not os.access(path, os.R_OK):
        return PreflightCheck(name, "invalid", "file is not readable")
    return PreflightCheck(name, "ready", "file is readable")


def _providers(config: SciRetrieverConfig) -> tuple[tuple[str, ...], str, PreflightCheck | None]:
    acquisition = config.acquisition
    providers = acquisition.providers or ()
    if not providers:
        return (), AssetRole.PRIMARY_PDF.value, PreflightCheck(
            "providers", "missing", "no providers are configured"
        )
    return providers, AssetRole.PRIMARY_PDF.value, None


def _validate_forbidden_values(values: tuple[str, ...]) -> None:
    for value in values:
        try:
            parsed = urlsplit(value)
            port = parsed.port
        except ValueError as error:
            raise ValueError("invalid forbidden URL") from error
        if (
            parsed.scheme.lower() != "https"
            or not parsed.hostname
            or parsed.username is not None
            or parsed.password is not None
            or port not in (None, 443)
        ):
            raise ValueError("invalid forbidden URL")


def _provider_checks(
    providers: tuple[str, ...],
    credentials: CredentialsConfig,
    *,
    readiness: str,
    direct_url: str | None,
    transport: HeadersTransport | None,
    timeout: float,
    env: Mapping[str, str],
) -> list[PreflightCheck]:
    checks: list[PreflightCheck] = []
    for provider in providers:
        credential = _REQUIRED_CREDENTIALS.get(provider)
        if credential is not None and get_credential(credential[0], env=env) is None and credentials.get(credential[1]) is None:
            checks.append(PreflightCheck(f"provider:{provider}", "missing", "required credential is missing"))
            continue
        if provider != "direct":
            checks.append(PreflightCheck(f"provider:{provider}", "not_checked", "provider requires a response body to resolve an asset URL"))
            continue
        if readiness == "none":
            checks.append(PreflightCheck("provider:direct", "not_checked", "headers readiness is disabled"))
        elif direct_url is None:
            checks.append(PreflightCheck("provider:direct", "missing", "direct URL is required for headers readiness"))
        elif transport is None:
            checks.append(PreflightCheck("provider:direct", "not_checked", "headers transport is unavailable"))
        else:
            try:
                response = transport.head(direct_url, timeout=timeout)
                status = "ready" if 200 <= response.status < 300 else "unreachable"
                reason = "headers request succeeded" if status == "ready" else "headers request returned a non-success status"
                checks.append(PreflightCheck("provider:direct", status, reason))
            except (OSError, ValueError, SciRetrieverError):
                checks.append(PreflightCheck("provider:direct", "unreachable", "headers request failed"))
    return checks


def run_preflight(
    config: SciRetrieverConfig,
    *,
    direct_url: str | None = None,
    transport: HeadersTransport | None = None,
    transport_factory: Callable[[UrlPolicy, int], HeadersTransport] | None = None,
    disk_usage: Callable[[str | os.PathLike[str]], shutil._ntuple_diskusage] = shutil.disk_usage,
    env: Mapping[str, str] | None = None,
) -> PreflightReport:
    """Validate effective acquisition policy without constructing runtime state."""
    checks: list[PreflightCheck] = [PreflightCheck("config", "ready", "strict TOML loaded")]
    if config.paths.catalog is None:
        checks.append(PreflightCheck("catalog", "missing", "catalog path is not configured"))
    else:
        checks.append(_path_kind(config.paths.catalog, directory=False))
    storage = config.paths.storage_root
    if storage is None:
        checks.append(PreflightCheck("storage_root", "missing", "storage root is not configured"))
    else:
        storage_check = _path_kind(storage, directory=True)
        checks.append(storage_check)
        if storage_check.status == "ready":
            try:
                free = disk_usage(storage).free
            except OSError:
                checks.append(PreflightCheck("storage_capacity", "unreachable", "disk capacity is unavailable"))
            else:
                required = config.acquisition.preflight.min_free_bytes
                status = "ready" if free >= required else "invalid"
                reason = "free space satisfies policy" if status == "ready" else "free space is below policy minimum"
                checks.append(PreflightCheck("storage_capacity", status, reason))
    browser = config.acquisition.browser
    if browser.enabled:
        if storage is None:
            checks.append(PreflightCheck("browser_profile", "invalid", "browser profile is invalid"))
        else:
            try:
                validate_browser_profile(browser, storage)
            except (OSError, SciRetrieverError, ValueError):
                checks.append(PreflightCheck("browser_profile", "invalid", "browser profile is invalid"))
            else:
                checks.append(PreflightCheck("browser_profile", "ready", "browser profile is ready"))
    else:
        checks.append(PreflightCheck("browser_profile", "not_checked", "browser is disabled"))
    forbidden = config.acquisition.forbidden_urls
    forbidden_values: tuple[str, ...] = ()
    forbidden_valid = True
    if forbidden is not None:
        file_check = _regular_file(forbidden, "forbidden_urls")
        checks.append(file_check)
        if file_check.status == "ready":
            try:
                forbidden_values = read_policy_lines(forbidden)
                _validate_forbidden_values(forbidden_values)
            except (OSError, UnicodeError, ValueError):
                checks[-1] = PreflightCheck("forbidden_urls", "invalid", "forbidden URL file is invalid")
                forbidden_valid = False
        else:
            forbidden_valid = False
    providers, effective_role, plan_check = _providers(config)
    if plan_check is not None:
        checks.append(plan_check)
    effective_transport = transport
    if (
        effective_transport is None
        and transport_factory is not None
        and forbidden_valid
        and config.acquisition.preflight.readiness == "headers"
    ):
        effective_transport = transport_factory(
            UrlPolicy(forbidden_urls=forbidden_values),
            config.acquisition.preflight.max_asset_bytes,
        )
    checks.extend(_provider_checks(
        providers,
        config.credentials,
        readiness=config.acquisition.preflight.readiness,
        direct_url=direct_url,
        transport=effective_transport,
        timeout=config.acquisition.preflight.timeout,
        env=os.environ if env is None else env,
    ))
    preflight = config.acquisition.preflight
    policy: dict[str, object] = {
        "asset_role": effective_role,
        "max_asset_bytes": preflight.max_asset_bytes,
        "min_free_bytes": preflight.min_free_bytes,
        "providers": list(providers),
        "readiness": preflight.readiness,
        "timeout_seconds": preflight.timeout,
    }
    status = "ready" if all(check.status in {"ready", "not_checked"} for check in checks) else "invalid"
    return PreflightReport(status, policy, tuple(checks))


__all__ = ("PreflightCheck", "PreflightReport", "READINESS_STATUSES", "run_preflight")
