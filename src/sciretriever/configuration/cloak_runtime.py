"""Explicit, owner-only CloakBrowser binary/cache lifecycle.

The Python wrapper and its patched Chromium binary are separate release
objects.  Configuration owns the binary cache and the cross-process lock.  A
normal ``status`` call only performs bounded local checks; the vendor wrapper
is imported and its downloader is called only by an explicit install/update
action.
"""

from __future__ import annotations

import ctypes
import errno
import hashlib
import importlib
import importlib.metadata
import json
import os
import platform
import re
import stat
import sys
import tempfile
import threading
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Final, Iterator, Literal, Protocol, runtime_checkable

from .errors import ConfigurationError
from .errors import fail as _fail
from .file_store import _secure_directory
from .filesystem import current_uid as _current_uid
from .filesystem import mode as _mode
from .filesystem import safe_path as _safe_path
from .filesystem import same_identity as _same_identity
from .filesystem import same_metadata as _same_metadata

_RUNTIME_DIRECTORY_NAME: Final[str] = "cloakbrowser-cache"
_ROOT_MANIFEST_NAME: Final[str] = "binary-manifest.json"
_VERSION_MANIFEST_NAME: Final[str] = ".sciretriever-binary-manifest.json"
_LOCK_NAME: Final[str] = ".runtime.lock"
_BINARY_NAME: Final[str] = "chrome"
_ARCHIVE_NAME: Final[str] = "cloakbrowser-linux-x64.tar.gz"
_SIGNED_MANIFEST_NAME: Final[str] = "SHA256SUMS"
_SIGNED_MANIFEST_SIGNATURE_NAME: Final[str] = "SHA256SUMS.sig"
_PRIMARY_RELEASE_BASE: Final[str] = "https://cloakbrowser.dev"
_FALLBACK_RELEASE_BASE: Final[str] = "https://github.com/CloakHQ/cloakbrowser/releases/download"
_CREDENTIALS_DIRECTORY_NAME: Final[str] = ".sciretriever"
_DIRECTORY_MODE: Final[int] = 0o700
_FILE_MODE: Final[int] = 0o600
_EXECUTABLE_MODE: Final[int] = 0o700

# Manifest bytes and extracted bundle bytes have intentionally independent
# limits.  A browser archive may contain many large locale/resource files while
# the control manifests must always be cheap to inspect.
_MANIFEST_MAX_BYTES: Final[int] = 64 * 1024
_MAX_BUNDLE_FILE_BYTES: Final[int] = 512 * 1024 * 1024
_MAX_BUNDLE_BYTES: Final[int] = 2 * 1024 * 1024 * 1024
_VERSION_RE: Final[re.Pattern[str]] = re.compile(r"^[0-9]+(?:\.[0-9]+){3,4}$")
_SHA256_RE: Final[re.Pattern[str]] = re.compile(r"^[0-9a-f]{64}$")
_VENDOR_ENV_LOCK = threading.RLock()
_PROXY_ENV_NAMES: Final[frozenset[str]] = frozenset(
    {
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "http_proxy",
        "https_proxy",
        "all_proxy",
        "NO_PROXY",
        "no_proxy",
    }
)

CLOAKBROWSER_WRAPPER_VERSION: Final[str] = "0.5.8"
CLOAKBROWSER_PLAYWRIGHT_VERSION: Final[str] = "1.55.0"
CLOAKBROWSER_BROWSER_VERSION: Final[str] = "146.0.7680.177.5"
CLOAKBROWSER_PLATFORM: Final[str] = "linux-x64"
CLOAKBROWSER_ORIGIN: Final[str] = "https://cloakbrowser.dev"
CLOAKBROWSER_ARCHIVE_SHA256: Final[str] = (
    "4a12bcde95fa1bb1beef2b41ab5e5c27c36be78e3be3d0dac8c64d705216670e"
)
_UNSUPPORTED_PLATFORM_REASON: Final[str] = "unsupported-platform"
_DEPENDENCY_VERSION_MISMATCH_REASON: Final[str] = "dependency-version-mismatch"


@dataclass(frozen=True, slots=True)
class CloakBinarySpec:
    """One reviewed wrapper/Playwright/archive candidate."""

    version: str = CLOAKBROWSER_BROWSER_VERSION
    platform: str = CLOAKBROWSER_PLATFORM
    archive_sha256: str = CLOAKBROWSER_ARCHIVE_SHA256
    wrapper_version: str = CLOAKBROWSER_WRAPPER_VERSION
    playwright_version: str = CLOAKBROWSER_PLAYWRIGHT_VERSION
    origin: str = CLOAKBROWSER_ORIGIN
    signature_algorithm: Literal["ed25519"] = "ed25519"
    compatible_playwright: str = "==1.55.0"

    def __post_init__(self) -> None:
        if type(self.version) is not str or _VERSION_RE.fullmatch(self.version) is None:
            raise ValueError("Cloak binary version is invalid")
        if self.platform != CLOAKBROWSER_PLATFORM:
            raise ValueError("Cloak binary platform is invalid")
        if (
            type(self.archive_sha256) is not str
            or _SHA256_RE.fullmatch(self.archive_sha256) is None
        ):
            raise ValueError("Cloak binary digest is invalid")
        if self.wrapper_version != CLOAKBROWSER_WRAPPER_VERSION:
            raise ValueError("Cloak wrapper version is invalid")
        if self.playwright_version != CLOAKBROWSER_PLAYWRIGHT_VERSION:
            raise ValueError("Playwright version is invalid")
        if self.origin != CLOAKBROWSER_ORIGIN or self.signature_algorithm != "ed25519":
            raise ValueError("Cloak release origin is invalid")
        if type(self.compatible_playwright) is not str or not self.compatible_playwright:
            raise ValueError("Playwright compatibility range is invalid")


DEFAULT_CLOAK_BINARY_SPEC: Final[CloakBinarySpec] = CloakBinarySpec()


def _production_gate_reason() -> str | None:
    """Return a stable local reason when the reviewed runtime cannot run.

    The production binary is a Linux x86_64 artifact and its wrapper/API
    contract is pinned to the versions above.  This check deliberately uses
    only host metadata and package metadata: it must not import CloakBrowser,
    invoke its downloader, inspect environment overrides, or perform any
    network operation.  Injected installer/verifier managers bypass this
    production gate so offline fixtures remain portable and deterministic.
    """

    if sys.platform != "linux" or platform.machine() != "x86_64":
        return _UNSUPPORTED_PLATFORM_REASON
    try:
        wrapper_version = importlib.metadata.version("cloakbrowser")
        playwright_version = importlib.metadata.version("playwright")
    except importlib.metadata.PackageNotFoundError:
        return _DEPENDENCY_VERSION_MISMATCH_REASON
    except (ImportError, OSError, ValueError):
        return _DEPENDENCY_VERSION_MISMATCH_REASON
    if (
        wrapper_version != CLOAKBROWSER_WRAPPER_VERSION
        or playwright_version != CLOAKBROWSER_PLAYWRIGHT_VERSION
    ):
        return _DEPENDENCY_VERSION_MISMATCH_REASON
    return None


@dataclass(frozen=True, slots=True)
class CloakBinaryVerification:
    """Strong verifier evidence; a bare bool/dict is deliberately rejected."""

    version: str
    platform: str
    archive_sha256: str
    signature_algorithm: Literal["ed25519"]
    signature_verified: bool
    executable_sha256: str
    bundle_sha256: str


@dataclass(frozen=True, slots=True)
class _CloakBinaryReleaseEvidence:
    """Authenticated evidence bound to the exact archive downloaded this run."""

    version: str
    platform: str
    archive_sha256: str
    signature_algorithm: Literal["ed25519"]
    signature_verified: bool


@runtime_checkable
class CloakBinaryInstaller(Protocol):
    """Installer seam that extracts a complete bundle into ``destination``.

    The production implementation returns private release evidence tied to the
    exact archive downloaded during this call. Injected offline installers
    return ``None`` and pair with their injected verifier.
    """

    def install(
        self,
        destination: Path,
        spec: CloakBinarySpec,
        license_key: str | None = None,
    ) -> object | None: ...


@runtime_checkable
class CloakBinaryVerifier(Protocol):
    """Vendor Ed25519/version/archive verifier seam."""

    def verify(
        self,
        bundle: Path,
        spec: CloakBinarySpec,
        release_evidence: object | None = None,
    ) -> CloakBinaryVerification: ...


@dataclass(frozen=True, slots=True, repr=False)
class CloakRuntimeStatus:
    """Secret/path-free local cache readiness."""

    presence: Literal["missing", "configured", "attention"]
    ready: bool
    version: str | None = None
    previous_version: str | None = None
    signature_verified: bool = False
    update_available: bool = False
    rollback_available: bool = False
    reason: str | None = None

    @property
    def binary_presence(self) -> bool:
        return self.presence == "configured"

    @property
    def binary_version(self) -> str | None:
        return self.version

    @property
    def verified(self) -> bool:
        return self.ready and self.signature_verified

    def __repr__(self) -> str:
        return (
            "CloakRuntimeStatus("
            f"presence={self.presence!r}, ready={self.ready!r}, version={self.version!r}, "
            f"previous_version={self.previous_version!r}, "
            f"signature_verified={self.signature_verified!r}, "
            f"update_available={self.update_available!r}, "
            f"rollback_available={self.rollback_available!r}, reason={self.reason!r})"
        )


class _ManifestError(ValueError):
    pass


def _reject_duplicate_json_keys(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise _ManifestError("duplicate JSON key")
        result[key] = value
    return result


def _reject_json_constant(value: str) -> object:
    del value
    raise _ManifestError("non-finite JSON value")


def _parse_json(raw: bytes) -> dict[str, object]:
    if len(raw) > _MANIFEST_MAX_BYTES:
        raise _ManifestError("manifest too large")
    try:
        value = json.loads(
            raw.decode("utf-8"),
            object_pairs_hook=_reject_duplicate_json_keys,
            parse_constant=_reject_json_constant,
        )
    except (RecursionError, UnicodeDecodeError, TypeError, ValueError) as error:
        if isinstance(error, _ManifestError):
            raise
        raise _ManifestError("malformed manifest") from None
    if not isinstance(value, dict):
        raise _ManifestError("manifest must be an object")
    return value


def _lstat(path: Path, *, missing_ok: bool) -> os.stat_result | None:
    try:
        metadata = os.lstat(path)
    except FileNotFoundError:
        if missing_ok:
            return None
        raise _ManifestError("path missing") from None
    except OSError:
        raise _ManifestError("path unavailable") from None
    if stat.S_ISLNK(metadata.st_mode):
        raise _ManifestError("symbolic link")
    return metadata


def _ensure_directory(path: Path, *, create: bool) -> os.stat_result | None:
    metadata = _lstat(path, missing_ok=True)
    if metadata is None:
        if not create:
            return None
        try:
            path.mkdir(mode=_DIRECTORY_MODE, exist_ok=False)
            os.chmod(path, _DIRECTORY_MODE)
        except FileExistsError:
            pass
        except OSError:
            _fail("credentials directory is unavailable")
        metadata = _lstat(path, missing_ok=False)
    if metadata is None or not stat.S_ISDIR(metadata.st_mode):
        _fail("credentials directory is not a regular directory")
    if metadata.st_uid != _current_uid() or _mode(metadata) != _DIRECTORY_MODE:
        _fail("credentials directory has unsafe ownership or permissions")
    return metadata


def _private_directory(home: str | Path | None, *, create: bool) -> Path | None:
    selected = Path.home() if home is None else _safe_path(home)
    private = selected / _CREDENTIALS_DIRECTORY_NAME
    try:
        private_metadata = os.lstat(private)
    except FileNotFoundError:
        private_metadata = None
    except OSError:
        if not create:
            raise _ManifestError("credentials directory unavailable") from None
        private_metadata = None
    if private_metadata is None and not create:
        return None
    if private_metadata is not None and (
        stat.S_ISLNK(private_metadata.st_mode) or not stat.S_ISDIR(private_metadata.st_mode)
    ):
        if not create:
            raise _ManifestError("credentials directory is not a regular directory")
    return private


def _root(home: str | Path | None, *, create: bool) -> Path | None:
    private = _private_directory(home, create=create)
    if private is None:
        return None
    try:
        _secure_directory(private, create=create)
    except ConfigurationError:
        if create:
            raise
        raise _ManifestError("credentials directory has unsafe ownership or permissions") from None
    root = private / _RUNTIME_DIRECTORY_NAME
    try:
        if _ensure_directory(root, create=create) is None:
            return None
    except _ManifestError:
        if create:
            _fail("credentials directory is not a regular directory")
        raise
    return root


def cloak_runtime_root(home: str | Path | None = None) -> Path:
    root = _root(home, create=True)
    if root is None:  # pragma: no cover - create=True either returns or raises.
        _fail("credentials directory is unavailable")
    return root


def _manifest_file_metadata(path: Path) -> os.stat_result:
    metadata = _lstat(path, missing_ok=False)
    if metadata is None or not stat.S_ISREG(metadata.st_mode):
        raise _ManifestError("manifest is not a regular file")
    if (
        metadata.st_uid != _current_uid()
        or _mode(metadata) != _FILE_MODE
        or metadata.st_nlink != 1
        or metadata.st_size > _MANIFEST_MAX_BYTES
    ):
        raise _ManifestError("manifest permissions or size are unsafe")
    return metadata


def _read_manifest_file(path: Path) -> bytes:
    metadata = _manifest_file_metadata(path)
    flags = os.O_RDONLY
    for name in ("O_CLOEXEC", "O_NOFOLLOW", "O_BINARY"):
        value = getattr(os, name, 0)
        if isinstance(value, int):
            flags |= value
    try:
        descriptor = os.open(path, flags)
    except OSError:
        raise _ManifestError("manifest unavailable") from None
    try:
        opened = os.fstat(descriptor)
        if not _same_identity(metadata, opened):
            raise _ManifestError("manifest replaced")
        result = bytearray()
        while len(result) <= _MANIFEST_MAX_BYTES:
            try:
                chunk = os.read(
                    descriptor,
                    min(65_536, _MANIFEST_MAX_BYTES + 1 - len(result)),
                )
            except OSError:
                raise _ManifestError("manifest unavailable") from None
            if not chunk:
                break
            result.extend(chunk)
        after = os.fstat(descriptor)
        named = _lstat(path, missing_ok=False)
        if (
            len(result) > _MANIFEST_MAX_BYTES
            or not _same_metadata(opened, after)
            or named is None
            or not _same_identity(named, after)
            or len(result) != after.st_size
        ):
            raise _ManifestError("manifest replaced")
        return bytes(result)
    finally:
        os.close(descriptor)


def _safe_string(value: object) -> str:
    if (
        type(value) is not str
        or not value
        or any(ord(char) < 0x20 or ord(char) == 0x7F for char in value)
    ):
        raise _ManifestError("invalid manifest string")
    return value


def _safe_version(value: object) -> str:
    version = _safe_string(value)
    if _VERSION_RE.fullmatch(version) is None:
        raise _ManifestError("invalid version")
    return version


def _digest_file(path: Path) -> str:
    digest = hashlib.sha256()
    flags = os.O_RDONLY
    for name in ("O_CLOEXEC", "O_NOFOLLOW", "O_BINARY"):
        value = getattr(os, name, 0)
        if isinstance(value, int):
            flags |= value
    try:
        descriptor = os.open(path, flags)
    except OSError:
        raise _ManifestError("bundle file unavailable") from None
    try:
        before = os.fstat(descriptor)
        if (
            not stat.S_ISREG(before.st_mode)
            or before.st_uid != _current_uid()
            or before.st_nlink != 1
            or before.st_size > _MAX_BUNDLE_FILE_BYTES
        ):
            raise _ManifestError("bundle file is unsafe")
        while True:
            try:
                chunk = os.read(descriptor, 1024 * 1024)
            except OSError:
                raise _ManifestError("bundle file unavailable") from None
            if not chunk:
                break
            digest.update(chunk)
        after = os.fstat(descriptor)
        named = _lstat(path, missing_ok=False)
        if named is None or not _same_metadata(before, after) or not _same_identity(named, after):
            raise _ManifestError("bundle file changed")
        return digest.hexdigest()
    finally:
        os.close(descriptor)


def _bundle_entries(  # noqa: C901
    bundle: Path,
    *,
    strict_modes: bool = True,
) -> tuple[tuple[Path, os.stat_result], ...]:  # noqa: C901
    total = 0
    entries: list[tuple[Path, os.stat_result]] = []
    root_metadata = _lstat(bundle, missing_ok=False)
    if root_metadata is None or not stat.S_ISDIR(root_metadata.st_mode):
        raise _ManifestError("bundle root is unsafe")
    if root_metadata.st_uid != _current_uid() or (
        strict_modes and _mode(root_metadata) != _DIRECTORY_MODE
    ):
        raise _ManifestError("bundle root ownership is unsafe")
    pending = [bundle]
    while pending:
        current = pending.pop()
        try:
            children = tuple(os.scandir(current))
        except OSError:
            raise _ManifestError("bundle unavailable") from None
        for entry in children:
            path = Path(entry.path)
            metadata = _lstat(path, missing_ok=False)
            if metadata is None:
                raise _ManifestError("bundle entry missing")
            if stat.S_ISDIR(metadata.st_mode):
                if metadata.st_uid != _current_uid() or (
                    strict_modes and _mode(metadata) != _DIRECTORY_MODE
                ):
                    raise _ManifestError("bundle directory ownership is unsafe")
                pending.append(path)
                continue
            if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != _current_uid():
                raise _ManifestError("bundle entry is unsafe")
            if metadata.st_nlink != 1 or (strict_modes and _mode(metadata) & 0o077):
                raise _ManifestError("bundle file ownership is unsafe")
            if metadata.st_size > _MAX_BUNDLE_FILE_BYTES:
                raise _ManifestError("bundle file is too large")
            if path == bundle / _VERSION_MANIFEST_NAME:
                continue
            total += metadata.st_size
            if total > _MAX_BUNDLE_BYTES:
                raise _ManifestError("bundle is too large")
            entries.append((path, metadata))
    return tuple(sorted(entries, key=lambda item: item[0].relative_to(bundle).as_posix()))


def _bundle_digest(bundle: Path, entries: tuple[tuple[Path, os.stat_result], ...]) -> str:
    digest = hashlib.sha256()
    for path, metadata in entries:
        relative = path.relative_to(bundle).as_posix().encode("utf-8")
        digest.update(len(relative).to_bytes(4, "big"))
        digest.update(relative)
        # Executable classification is part of the authenticated published
        # bundle.  Chromium launches helper programs such as
        # ``chrome_crashpad_handler`` with ``posix_spawn``; losing that bit
        # makes an otherwise byte-identical installation unusable.  Binding
        # the owner-only normalized mode also makes a later chmod visible to
        # the local readiness check.
        digest.update(stat.S_IMODE(metadata.st_mode).to_bytes(2, "big"))
        _update_digest_from_file(path, digest)
    return digest.hexdigest()


def _update_digest_from_file(path: Path, digest: "hashlib._Hash") -> None:
    flags = os.O_RDONLY
    for name in ("O_CLOEXEC", "O_NOFOLLOW", "O_BINARY"):
        value = getattr(os, name, 0)
        if isinstance(value, int):
            flags |= value
    try:
        descriptor = os.open(path, flags)
    except OSError:
        raise _ManifestError("bundle file unavailable") from None
    try:
        before = os.fstat(descriptor)
        if (
            not stat.S_ISREG(before.st_mode)
            or before.st_uid != _current_uid()
            or before.st_nlink != 1
            or before.st_size > _MAX_BUNDLE_FILE_BYTES
        ):
            raise _ManifestError("bundle file is unsafe")
        while True:
            try:
                chunk = os.read(descriptor, 1024 * 1024)
            except OSError:
                raise _ManifestError("bundle file unavailable") from None
            if not chunk:
                break
            digest.update(chunk)
        after = os.fstat(descriptor)
        named = _lstat(path, missing_ok=False)
        if named is None or not _same_metadata(before, after) or not _same_identity(named, after):
            raise _ManifestError("bundle file changed")
    finally:
        os.close(descriptor)


def _validate_bundle(bundle: Path) -> tuple[str, str, str]:
    entries = _bundle_entries(bundle)
    executable = bundle / _BINARY_NAME
    metadata = next((item[1] for item in entries if item[0] == executable), None)
    if metadata is None or not metadata.st_mode & stat.S_IXUSR:
        raise _ManifestError("bundle executable missing")
    return _digest_file(executable), _bundle_digest(bundle, entries), executable.name


def _harden_bundle(bundle: Path) -> None:
    # Validate before changing modes: symlinks, hardlinks and special files
    # must fail closed rather than be silently normalized.
    _bundle_entries(bundle, strict_modes=False)
    try:
        for current, directories, files in os.walk(bundle, topdown=False, followlinks=False):
            for name in files:
                path = Path(current) / name
                metadata = _lstat(path, missing_ok=False)
                if metadata is None or not stat.S_ISREG(metadata.st_mode):
                    raise _ManifestError("bundle entry is unsafe")
                # Preserve the vendor archive's executable classification for
                # Chromium helper programs while removing every group/other
                # permission.  The primary chrome binary remains executable
                # even in injected fixtures whose writer omitted its mode.
                executable = bool(metadata.st_mode & 0o111) or (
                    name == _BINARY_NAME and Path(current) == bundle
                )
                os.chmod(path, _EXECUTABLE_MODE if executable else _FILE_MODE)
            for name in directories:
                path = Path(current) / name
                metadata = _lstat(path, missing_ok=False)
                if metadata is None or not stat.S_ISDIR(metadata.st_mode):
                    raise _ManifestError("bundle directory is unsafe")
                os.chmod(path, _DIRECTORY_MODE)
        os.chmod(bundle, _DIRECTORY_MODE)
    except _ManifestError:
        _fail("credentials publication failed")
    except OSError:
        _fail("credentials publication failed")


def _version_manifest_payload(
    spec: CloakBinarySpec,
    executable_digest: str,
    bundle_digest: str,
) -> bytes:
    return json.dumps(
        {
            "archive_sha256": spec.archive_sha256,
            "binary_version": spec.version,
            "bundle_sha256": bundle_digest,
            "compatible_playwright": spec.compatible_playwright,
            "executable_sha256": executable_digest,
            "origin": spec.origin,
            "platform": spec.platform,
            "playwright_version": spec.playwright_version,
            "signature_algorithm": spec.signature_algorithm,
            "signature_verified": True,
            "verified_at": datetime.now(timezone.utc).isoformat(),
            "wrapper_version": spec.wrapper_version,
        },
        ensure_ascii=True,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")


def _root_manifest_payload(current: str, previous: str | None) -> bytes:
    return json.dumps(
        {"current_version": current, "previous_version": previous, "schema_version": 1},
        ensure_ascii=True,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")


def _parse_version_manifest(value: dict[str, object]) -> dict[str, object]:
    expected = {
        "archive_sha256",
        "binary_version",
        "bundle_sha256",
        "compatible_playwright",
        "executable_sha256",
        "origin",
        "platform",
        "playwright_version",
        "signature_algorithm",
        "signature_verified",
        "verified_at",
        "wrapper_version",
    }
    if set(value) != expected:
        raise _ManifestError("unknown version manifest field")
    version = _safe_version(value["binary_version"])
    digests = {
        key: _safe_string(value[key])
        for key in ("archive_sha256", "bundle_sha256", "executable_sha256")
    }
    if any(_SHA256_RE.fullmatch(digest) is None for digest in digests.values()):
        raise _ManifestError("invalid digest")
    if (
        _safe_string(value["compatible_playwright"]) != "==1.55.0"
        or _safe_string(value["origin"]) != CLOAKBROWSER_ORIGIN
        or _safe_string(value["platform"]) != CLOAKBROWSER_PLATFORM
        or _safe_string(value["playwright_version"]) != CLOAKBROWSER_PLAYWRIGHT_VERSION
        or _safe_string(value["signature_algorithm"]) != "ed25519"
        or _safe_string(value["wrapper_version"]) != CLOAKBROWSER_WRAPPER_VERSION
        or type(value["signature_verified"]) is not bool
        or not value["signature_verified"]
    ):
        raise _ManifestError("version manifest mismatch")
    _safe_string(value["verified_at"])
    return {"version": version, **digests, "signature_verified": True}


def _parse_root_manifest(value: dict[str, object]) -> tuple[str, str | None]:
    if set(value) != {"current_version", "previous_version", "schema_version"}:
        raise _ManifestError("unknown root manifest field")
    if value["schema_version"] != 1:
        raise _ManifestError("root manifest version mismatch")
    current = _safe_version(value["current_version"])
    previous_raw = value["previous_version"]
    previous = None if previous_raw is None else _safe_version(previous_raw)
    if current == previous:
        raise _ManifestError("root manifest versions are equal")
    return current, previous


def _write_all(descriptor: int, payload: bytes) -> None:
    offset = 0
    while offset < len(payload):
        try:
            count = os.write(descriptor, payload[offset:])
        except OSError:
            _fail("credentials publication failed")
        if count <= 0:
            _fail("credentials publication failed")
        offset += count


def _failpoint(failpoint: object | None, stage: str) -> None:
    if failpoint is None:
        return
    callback = getattr(failpoint, "__call__", None)
    if not callable(callback):
        _fail("configuration value is invalid")
    try:
        callback(stage)
    except ConfigurationError:
        raise
    except BaseException:
        _fail("credentials publication was interrupted")


def _write_manifest(  # noqa: C901
    path: Path,
    payload: bytes,
    *,
    expected: os.stat_result | None,
    failpoint: object | None,
) -> None:
    if len(payload) > _MANIFEST_MAX_BYTES:
        _fail("configuration input is too large")
    parent = path.parent
    _ensure_directory(parent, create=False)
    descriptor: int | None = None
    staging: Path | None = None
    try:
        descriptor_raw, path_raw = tempfile.mkstemp(
            prefix=f".{path.stem}-", suffix=".staging", dir=parent
        )
        descriptor = descriptor_raw
        staging = Path(path_raw)
        os.fchmod(descriptor, _FILE_MODE)
        _failpoint(failpoint, "staging-created")
        _write_all(descriptor, payload)
        _failpoint(failpoint, "staging-written")
        os.fsync(descriptor)
        _failpoint(failpoint, "staging-fsynced")
        os.close(descriptor)
        descriptor = None
        _parse_json(_read_manifest_file(staging))
        _failpoint(failpoint, "staging-validated")
        current = _lstat(path, missing_ok=True)
        if expected is None:
            if current is not None:
                _fail("credentials file changed during read")
        elif current is None or not _same_metadata(expected, current):
            _fail("credentials file changed during read")
        _failpoint(failpoint, "before-replace")
        # The caller holds the runtime lock.  The expected identity check plus
        # renameat2(RENAME_NOREPLACE) below ensures an externally created
        # manifest cannot be clobbered.
        if expected is None:
            _rename_noreplace(staging, path)
        else:
            os.replace(staging, path)
        staging = None
        try:
            directory_fd = os.open(parent, os.O_RDONLY)
        except OSError:
            return
        try:
            try:
                os.fsync(directory_fd)
            except OSError:
                pass
        finally:
            os.close(directory_fd)
    except ConfigurationError:
        raise
    except (OSError, RecursionError, TypeError, ValueError):
        _fail("credentials publication failed")
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


def _rename_noreplace(source: Path, target: Path) -> None:
    """Atomically rename a directory/file without replacing ``target``."""

    # Linux provides the only portable no-clobber primitive for directories.
    # Keep a conservative fallback for platforms without renameat2; all
    # Configuration writers still hold the same owner-only lock there.
    if os.name == "posix":
        try:
            libc = ctypes.CDLL(None, use_errno=True)
            renameat2 = getattr(libc, "renameat2")
            renameat2.argtypes = [
                ctypes.c_int,
                ctypes.c_char_p,
                ctypes.c_int,
                ctypes.c_char_p,
                ctypes.c_uint,
            ]
            renameat2.restype = ctypes.c_int
            result = renameat2(
                -100,
                os.fsencode(source),
                -100,
                os.fsencode(target),
                1,
            )
            if result == 0:
                return
            error = ctypes.get_errno()
            if error == errno.EEXIST:
                raise FileExistsError(error, os.strerror(error), target)
            if error not in (errno.ENOSYS, errno.EINVAL):
                raise OSError(error, os.strerror(error), target)
        except AttributeError:
            pass
        except OSError:
            raise
    if _lstat(target, missing_ok=True) is not None:
        raise FileExistsError(errno.EEXIST, "target exists", target)
    os.rename(source, target)


def _lock_descriptor(descriptor: int, *, shared: bool) -> None:
    try:
        if os.name == "nt":  # pragma: no cover - Windows CI only.
            import msvcrt

            if os.fstat(descriptor).st_size == 0:
                os.write(descriptor, b"0")
            os.lseek(descriptor, 0, os.SEEK_SET)
            lock_mode = msvcrt.LK_RLCK if shared and hasattr(msvcrt, "LK_RLCK") else msvcrt.LK_LOCK
            msvcrt.locking(descriptor, lock_mode, 1)
        else:
            import fcntl

            fcntl.flock(descriptor, fcntl.LOCK_SH if shared else fcntl.LOCK_EX)
    except (ImportError, OSError, ValueError):
        _fail("credentials directory is unavailable")


def _unlock_descriptor(descriptor: int) -> None:
    try:
        if os.name == "nt":  # pragma: no cover - Windows CI only.
            import msvcrt

            os.lseek(descriptor, 0, os.SEEK_SET)
            msvcrt.locking(descriptor, msvcrt.LK_UNLCK, 1)
        else:
            import fcntl

            fcntl.flock(descriptor, fcntl.LOCK_UN)
    except (ImportError, OSError, ValueError):
        return


def _open_lock(root: Path, *, shared: bool) -> int:
    flags = os.O_RDWR | os.O_CREAT
    for name in ("O_CLOEXEC", "O_NOFOLLOW", "O_BINARY"):
        value = getattr(os, name, 0)
        if isinstance(value, int):
            flags |= value
    path = root / _LOCK_NAME
    descriptor: int | None = None
    try:
        descriptor = os.open(path, flags, _FILE_MODE)
        os.fchmod(descriptor, _FILE_MODE)
        metadata = os.fstat(descriptor)
        if (
            not stat.S_ISREG(metadata.st_mode)
            or metadata.st_uid != _current_uid()
            or _mode(metadata) != _FILE_MODE
            or metadata.st_nlink != 1
        ):
            _fail("credentials directory has unsafe ownership or permissions")
        _lock_descriptor(descriptor, shared=shared)
        return descriptor
    except ConfigurationError:
        if descriptor is not None:
            try:
                os.close(descriptor)
            except OSError:
                pass
        raise
    except OSError:
        _fail("credentials directory is unavailable")


@contextmanager
def _exclusive_lock(root: Path) -> Iterator[None]:
    descriptor = _open_lock(root, shared=False)
    try:
        yield
    finally:
        _unlock_descriptor(descriptor)
        os.close(descriptor)


@contextmanager
def _vendor_environment(cache_directory: Path) -> Iterator[None]:
    """Run the official vendor entry point in a sterile child configuration."""

    if not isinstance(cache_directory, Path):
        _fail("configuration value is invalid")
    with _VENDOR_ENV_LOCK:
        removed: dict[str, str] = {}
        for key in tuple(os.environ):
            if key.upper().startswith("CLOAKBROWSER_") or key in _PROXY_ENV_NAMES:
                value = os.environ.pop(key, None)
                if value is not None:
                    removed[key] = value
        os.environ["CLOAKBROWSER_CACHE_DIR"] = os.fspath(cache_directory)
        os.environ["CLOAKBROWSER_AUTO_UPDATE"] = "false"
        try:
            yield
        finally:
            os.environ.pop("CLOAKBROWSER_CACHE_DIR", None)
            os.environ.pop("CLOAKBROWSER_AUTO_UPDATE", None)
            os.environ.update(removed)


def _copy_bundle(source: Path, destination: Path) -> None:  # noqa: C901
    source_meta = _lstat(source, missing_ok=False)
    if source_meta is None or not stat.S_ISDIR(source_meta.st_mode):
        _fail("configuration operation failed")
    if source_meta.st_uid != _current_uid():
        _fail("configuration operation failed")
    destination_meta = _lstat(destination, missing_ok=True)
    if destination_meta is None:
        try:
            os.mkdir(destination, _DIRECTORY_MODE)
        except OSError:
            _fail("credentials publication failed")
    elif (
        not stat.S_ISDIR(destination_meta.st_mode)
        or destination_meta.st_uid != _current_uid()
        or _mode(destination_meta) != _DIRECTORY_MODE
    ):
        _fail("credentials publication failed")
    pending: list[tuple[Path, Path]] = [(source, destination)]
    while pending:
        current_source, current_destination = pending.pop()
        try:
            children = tuple(os.scandir(current_source))
        except OSError:
            _fail("configuration operation failed")
        for entry in children:
            src = Path(entry.path)
            dst = current_destination / entry.name
            metadata = _lstat(src, missing_ok=False)
            if metadata is None:
                _fail("configuration operation failed")
            if stat.S_ISDIR(metadata.st_mode):
                if metadata.st_uid != _current_uid():
                    _fail("configuration operation failed")
                try:
                    os.mkdir(dst, _DIRECTORY_MODE)
                except OSError:
                    _fail("credentials publication failed")
                pending.append((src, dst))
                continue
            if (
                not stat.S_ISREG(metadata.st_mode)
                or metadata.st_uid != _current_uid()
                or metadata.st_nlink != 1
            ):
                _fail("configuration operation failed")
            flags = os.O_RDONLY
            for name in ("O_CLOEXEC", "O_NOFOLLOW", "O_BINARY"):
                value = getattr(os, name, 0)
                if isinstance(value, int):
                    flags |= value
            source_fd: int | None = None
            target_fd: int | None = None
            try:
                source_fd = os.open(src, flags)
                target_fd = os.open(
                    dst,
                    os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0),
                    _FILE_MODE,
                )
            except OSError:
                if source_fd is not None:
                    os.close(source_fd)
                _fail("credentials publication failed")
            try:
                if source_fd is None or target_fd is None:  # pragma: no cover - guarded above.
                    _fail("credentials publication failed")
                while True:
                    chunk = os.read(source_fd, 1024 * 1024)
                    if not chunk:
                        break
                    _write_all(target_fd, chunk)
                after = os.fstat(source_fd)
                named = _lstat(src, missing_ok=False)
                if (
                    named is None
                    or not _same_metadata(metadata, after)
                    or not _same_identity(named, after)
                ):
                    _fail("configuration operation failed")
                executable = bool(metadata.st_mode & 0o111) or src == source / _BINARY_NAME
                os.fchmod(target_fd, _EXECUTABLE_MODE if executable else _FILE_MODE)
            except OSError:
                _fail("configuration operation failed")
            finally:
                if source_fd is not None:
                    os.close(source_fd)
                if target_fd is not None:
                    os.close(target_fd)


def _vendor_callable(module: object, name: str) -> Callable[..., object]:
    candidate = getattr(module, name, None)
    if not callable(candidate):
        _fail("configuration operation failed")
    return candidate


def _create_private_download(path: Path) -> None:
    descriptor: int | None = None
    try:
        descriptor = os.open(
            path,
            os.O_WRONLY
            | os.O_CREAT
            | os.O_EXCL
            | getattr(os, "O_CLOEXEC", 0)
            | getattr(os, "O_NOFOLLOW", 0)
            | getattr(os, "O_BINARY", 0),
            _FILE_MODE,
        )
        os.fchmod(descriptor, _FILE_MODE)
    except OSError:
        _fail("credentials publication failed")
    finally:
        if descriptor is not None:
            os.close(descriptor)


def _download_first_available(
    download_file: Callable[..., object],
    urls: tuple[str, ...],
    destination: Path,
) -> None:
    for url in urls:
        try:
            result = download_file(url, destination)
            if result is not None:
                _fail("configuration operation failed")
            return
        except ConfigurationError:
            raise
        except Exception:
            continue
    _fail("configuration operation failed")


def _download_signed_manifest(
    download_file: Callable[..., object],
    bases: tuple[str, ...],
    manifest_path: Path,
    signature_path: Path,
) -> None:
    for base in bases:
        try:
            manifest_result = download_file(
                f"{base}/{_SIGNED_MANIFEST_NAME}",
                manifest_path,
            )
            signature_result = download_file(
                f"{base}/{_SIGNED_MANIFEST_SIGNATURE_NAME}",
                signature_path,
            )
            if manifest_result is not None or signature_result is not None:
                _fail("configuration operation failed")
            return
        except ConfigurationError:
            raise
        except Exception:
            # Both files must come from the same fixed release base. Truncate
            # partial bytes before trying the signed GitHub release mirror.
            try:
                manifest_path.write_bytes(b"")
                signature_path.write_bytes(b"")
                os.chmod(manifest_path, _FILE_MODE)
                os.chmod(signature_path, _FILE_MODE)
            except OSError:
                _fail("credentials publication failed")
    _fail("configuration operation failed")


def _authenticated_manifest_digest(raw: bytes, spec: CloakBinarySpec) -> str:
    if len(raw) > _MANIFEST_MAX_BYTES:
        _fail("configuration operation failed")
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        _fail("configuration operation failed")
    versions: list[str] = []
    archive_digests: list[str] = []
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if line.startswith("version="):
            versions.append(line.removeprefix("version=").strip())
            continue
        parts = line.split(None, 1)
        if len(parts) != 2:
            continue
        digest, filename = parts
        if filename.lstrip("*") != _ARCHIVE_NAME:
            continue
        normalized = digest.lower()
        if _SHA256_RE.fullmatch(normalized) is None:
            _fail("configuration operation failed")
        archive_digests.append(normalized)
    if versions != [spec.version] or archive_digests != [spec.archive_sha256]:
        _fail("configuration operation failed")
    return archive_digests[0]


class OfficialCloakBinaryInstaller:
    """Download and authenticate one exact vendor archive before extraction."""

    def install(
        self,
        destination: Path,
        spec: CloakBinarySpec,
        license_key: str | None = None,
    ) -> object | None:
        # v146 is the reviewed free build.  Passing a key can route the vendor
        # to Pro/latest and would invalidate the fixed-version contract.
        if license_key is not None:
            _fail("configuration operation failed")
        vendor_cache = destination / ".vendor-cache"
        try:
            vendor_cache.mkdir(mode=_DIRECTORY_MODE)
            os.chmod(vendor_cache, _DIRECTORY_MODE)
        except OSError:
            _fail("credentials publication failed")
        try:
            archive = vendor_cache / f".{_ARCHIVE_NAME}"
            signed_manifest = vendor_cache / f".{_SIGNED_MANIFEST_NAME}"
            signed_manifest_signature = vendor_cache / f".{_SIGNED_MANIFEST_SIGNATURE_NAME}"
            for path in (archive, signed_manifest, signed_manifest_signature):
                _create_private_download(path)
            with _vendor_environment(vendor_cache):
                try:
                    download = importlib.import_module("cloakbrowser.download")
                    download_file = _vendor_callable(download, "_download_file")
                    verify_signature = _vendor_callable(download, "_verify_signature")
                    extract_archive = _vendor_callable(download, "_extract_archive")
                    release_bases = (
                        f"{_PRIMARY_RELEASE_BASE}/chromium-v{spec.version}",
                        f"{_FALLBACK_RELEASE_BASE}/chromium-v{spec.version}",
                    )
                    _download_first_available(
                        download_file,
                        tuple(f"{base}/{_ARCHIVE_NAME}" for base in release_bases),
                        archive,
                    )
                    _download_signed_manifest(
                        download_file,
                        release_bases,
                        signed_manifest,
                        signed_manifest_signature,
                    )
                    manifest_bytes = _read_manifest_file(signed_manifest)
                    signature_bytes = _read_manifest_file(signed_manifest_signature)
                    if verify_signature(manifest_bytes, signature_bytes) is not None:
                        _fail("configuration operation failed")
                    authenticated_digest = _authenticated_manifest_digest(
                        manifest_bytes,
                        spec,
                    )
                    if _digest_file(archive) != authenticated_digest:
                        _fail("configuration operation failed")
                    bundle = vendor_cache / f"chromium-{spec.version}"
                    extraction_result = extract_archive(
                        archive,
                        bundle,
                        bundle / _BINARY_NAME,
                    )
                    if extraction_result is not None:
                        _fail("configuration operation failed")
                except ConfigurationError:
                    raise
                except BaseException:
                    _fail("configuration operation failed")
            # The official extractor normally marks ``chrome`` executable;
            # validating the complete tree here must still accept a fake
            # vendor fixture whose final mode is normalized by the staging
            # hardener below.  Symlinks, hardlinks and special files remain
            # rejected by ``_bundle_entries``.
            _bundle_entries(bundle, strict_modes=False)
            _copy_bundle(bundle, destination)
            return _CloakBinaryReleaseEvidence(
                version=spec.version,
                platform=spec.platform,
                archive_sha256=authenticated_digest,
                signature_algorithm="ed25519",
                signature_verified=True,
            )
        finally:
            _remove_tree(vendor_cache)


class OfficialCloakBinaryVerifier:
    """Validate the complete extracted bundle after vendor verification."""

    def verify(
        self,
        bundle: Path,
        spec: CloakBinarySpec,
        release_evidence: object | None = None,
    ) -> CloakBinaryVerification:
        if not isinstance(release_evidence, _CloakBinaryReleaseEvidence):
            _fail("configuration operation failed")
        if (
            release_evidence.version != spec.version
            or release_evidence.platform != spec.platform
            or release_evidence.archive_sha256 != spec.archive_sha256
            or release_evidence.signature_algorithm != "ed25519"
            or release_evidence.signature_verified is not True
        ):
            _fail("configuration operation failed")
        executable_digest, bundle_digest, _ = _validate_bundle(bundle)
        return CloakBinaryVerification(
            version=release_evidence.version,
            platform=release_evidence.platform,
            archive_sha256=release_evidence.archive_sha256,
            signature_algorithm="ed25519",
            signature_verified=release_evidence.signature_verified,
            executable_sha256=executable_digest,
            bundle_sha256=bundle_digest,
        )


# Descriptive aliases used by callers that do not need to know the vendor
# implementation class name.
ProductionCloakBinaryInstaller = OfficialCloakBinaryInstaller
ProductionCloakBinaryVerifier = OfficialCloakBinaryVerifier


def _verification_matches(
    evidence: object,
    spec: CloakBinarySpec,
    executable_digest: str,
    bundle_digest: str,
) -> bool:
    if not isinstance(evidence, CloakBinaryVerification):
        return False
    if (
        any(
            type(value) is not str
            for value in (
                evidence.version,
                evidence.platform,
                evidence.archive_sha256,
                evidence.signature_algorithm,
                evidence.executable_sha256,
                evidence.bundle_sha256,
            )
        )
        or type(evidence.signature_verified) is not bool
    ):
        return False
    return (
        evidence.version == spec.version
        and evidence.platform == spec.platform
        and evidence.archive_sha256 == spec.archive_sha256
        and evidence.signature_algorithm == "ed25519"
        and evidence.signature_verified
        and evidence.executable_sha256 == executable_digest
        and evidence.bundle_sha256 == bundle_digest
    )


def _remove_tree(path: Path) -> None:
    """Recursively remove a staging tree without following links."""

    try:
        metadata = os.lstat(path)
    except FileNotFoundError:
        return
    except OSError:
        return
    try:
        if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(metadata.st_mode):
            path.unlink()
            return
        try:
            children = tuple(os.scandir(path))
        except OSError:
            return
        for entry in children:
            _remove_tree(Path(entry.path))
        try:
            path.rmdir()
        except OSError:
            pass
    except OSError:
        pass


def _create_sterile_launch_cache(root: Path, version: str) -> Path:
    """Expose only one verified bundle to the vendor for one runtime lease.

    CloakBrowser treats its cache root as a credential and update-state store.
    The durable SciRetriever runtime root may therefore never be passed to the
    wrapper directly: a stray ``license.key`` or Pro marker there could change
    the selected binary or trigger network access during ordinary Completion.
    """

    target = root / f"chromium-{version}"
    try:
        target_metadata = _lstat(target, missing_ok=False)
        if target_metadata is None or not stat.S_ISDIR(target_metadata.st_mode):
            _fail("configuration operation failed")
        launch_cache = Path(tempfile.mkdtemp(prefix="sciretriever-cloak-runtime-"))
        os.chmod(launch_cache, _DIRECTORY_MODE)
    except ConfigurationError:
        raise
    except (OSError, _ManifestError):
        _fail("configuration operation failed")
    try:
        os.symlink(
            os.path.abspath(target),
            launch_cache / target.name,
            target_is_directory=True,
        )
        return launch_cache
    except OSError:
        _remove_tree(launch_cache)
        _fail("configuration operation failed")


class CloakRuntimeLease:
    """Shared-lock lease held for the complete Browser context lifetime."""

    __slots__ = (
        "_browser_version",
        "_cache_directory",
        "_cleanup_directory",
        "_closed",
        "_descriptor",
    )

    def __init__(
        self,
        descriptor: int,
        cache_directory: Path,
        browser_version: str,
        *,
        cleanup_directory: Path | None = None,
    ) -> None:
        self._descriptor = descriptor
        self._cache_directory = cache_directory
        self._browser_version = browser_version
        self._cleanup_directory = cleanup_directory
        self._closed = False

    @property
    def cache_directory(self) -> Path:
        if self._closed:
            _fail("configuration operation failed")
        return self._cache_directory

    @property
    def browser_version(self) -> str:
        if self._closed:
            _fail("configuration operation failed")
        return self._browser_version

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        descriptor = self._descriptor
        self._descriptor = -1
        cleanup = self._cleanup_directory
        self._cleanup_directory = None
        if cleanup is not None:
            _remove_tree(cleanup)
        _unlock_descriptor(descriptor)
        try:
            os.close(descriptor)
        except OSError:
            pass

    def __enter__(self) -> CloakRuntimeLease:
        return self

    def __exit__(self, *unused: object) -> None:
        self.close()

    def __repr__(self) -> str:
        return "CloakRuntimeLease(locked=True)"

    def __reduce__(self) -> str | tuple[object, ...]:
        raise TypeError("Cloak runtime lease is not serializable")


class CloakRuntimeManager:
    """Explicit install/update/rollback service for one fixed cache root."""

    __slots__ = ("_home", "_installer", "_verifier", "_specs", "_production")

    def __init__(
        self,
        *,
        home: str | Path | None = None,
        installer: CloakBinaryInstaller | object | None = None,
        verifier: CloakBinaryVerifier | object | None = None,
        specs: tuple[CloakBinarySpec, ...] = (),
    ) -> None:
        if installer is not None and not callable(getattr(installer, "install", None)):
            _fail("configuration value is invalid")
        if verifier is not None and not callable(getattr(verifier, "verify", None)):
            _fail("configuration value is invalid")
        if type(specs) is not tuple or any(not isinstance(spec, CloakBinarySpec) for spec in specs):
            _fail("configuration value is invalid")
        if installer is None and verifier is None and specs:
            # The production route is deliberately the reviewed free v146
            # candidate only.  Alternate specs remain available solely to
            # offline installer/verifier fixtures.
            _fail("configuration value is invalid")
        self._home = None if home is None else _safe_path(home)
        self._production = installer is None and verifier is None
        self._installer = OfficialCloakBinaryInstaller() if installer is None else installer
        self._verifier = OfficialCloakBinaryVerifier() if verifier is None else verifier
        self._specs = {spec.version: spec for spec in (DEFAULT_CLOAK_BINARY_SPEC, *specs)}

    @property
    def runtime_root(self) -> Path:
        return cloak_runtime_root(self._home)

    @property
    def cache_directory(self) -> Path:
        """Opaque integration seam for Network to set vendor cache explicitly."""

        return self.runtime_root

    def _spec(self, version: str | None) -> CloakBinarySpec:
        selected = CLOAKBROWSER_BROWSER_VERSION if version is None else version
        if type(selected) is not str or selected not in self._specs:
            _fail("configuration value is invalid")
        return self._specs[selected]

    def _require_production_gate(self) -> None:
        """Reject production lifecycle actions outside the reviewed tuple."""

        if self._production and _production_gate_reason() is not None:
            _fail("configuration operation failed")

    def _root_manifest(self, root: Path) -> tuple[str, str | None]:
        try:
            return _parse_root_manifest(
                _parse_json(_read_manifest_file(root / _ROOT_MANIFEST_NAME))
            )
        except _ManifestError:
            _fail("configuration input is malformed")

    def _version_verified(self, root: Path, spec: CloakBinarySpec) -> bool:
        directory = root / f"chromium-{spec.version}"
        try:
            _ensure_directory(directory, create=False)
            executable_digest, bundle_digest, _ = _validate_bundle(directory)
            manifest = _parse_version_manifest(
                _parse_json(_read_manifest_file(directory / _VERSION_MANIFEST_NAME))
            )
        except (_ManifestError, ConfigurationError):
            return False
        return (
            manifest["version"] == spec.version
            and manifest["archive_sha256"] == spec.archive_sha256
            and manifest["executable_sha256"] == executable_digest
            and manifest["bundle_sha256"] == bundle_digest
            and manifest["signature_verified"] is True
        )

    def _status_unlocked(self, root: Path) -> CloakRuntimeStatus:
        try:
            current, previous = self._root_manifest(root)
            spec = self._specs.get(current)
            if spec is None or not self._version_verified(root, spec):
                return CloakRuntimeStatus(
                    presence="attention",
                    ready=False,
                    version=current,
                    previous_version=previous,
                    reason="manifest-mismatch",
                )
            rollback = False
            if previous is not None:
                previous_spec = self._specs.get(previous)
                if previous_spec is None or not self._version_verified(root, previous_spec):
                    return CloakRuntimeStatus(
                        presence="attention",
                        ready=False,
                        version=current,
                        previous_version=previous,
                        reason="manifest-mismatch",
                    )
                rollback = True
            return CloakRuntimeStatus(
                presence="configured",
                ready=True,
                version=current,
                previous_version=previous,
                signature_verified=True,
                rollback_available=rollback,
            )
        except (ConfigurationError, OSError, RecursionError, _ManifestError):
            return CloakRuntimeStatus(presence="attention", ready=False, reason="invalid-runtime")

    def status(self) -> CloakRuntimeStatus:
        """Pure local presence/readiness; never imports the vendor package."""

        if self._production:
            reason = _production_gate_reason()
            if reason is not None:
                return CloakRuntimeStatus(
                    presence="attention",
                    ready=False,
                    reason=reason,
                )

        try:
            root = _root(self._home, create=False)
        except (ConfigurationError, _ManifestError, OSError, RecursionError):
            return CloakRuntimeStatus(
                presence="attention",
                ready=False,
                reason="invalid-runtime",
            )
        if root is None:
            return CloakRuntimeStatus(presence="missing", ready=False)
        return self._status_unlocked(root)

    def acquire_runtime(self) -> CloakRuntimeLease:
        """Acquire a shared lock and revalidate root/bundle under that lock."""

        self._require_production_gate()
        root = _root(self._home, create=False)
        if root is None:
            _fail("configuration operation failed")
        descriptor = _open_lock(root, shared=True)
        launch_cache: Path | None = None
        try:
            current, _previous = self._root_manifest(root)
            spec = self._specs.get(current)
            if spec is None or not self._version_verified(root, spec):
                _fail("configuration operation failed")
            cache_directory = root
            if self._production:
                launch_cache = _create_sterile_launch_cache(root, current)
                cache_directory = launch_cache
            return CloakRuntimeLease(
                descriptor,
                cache_directory,
                current,
                cleanup_directory=launch_cache,
            )
        except BaseException:
            if launch_cache is not None:
                _remove_tree(launch_cache)
            _unlock_descriptor(descriptor)
            os.close(descriptor)
            raise

    def _call_installer(
        self,
        destination: Path,
        spec: CloakBinarySpec,
        license_key: str | None,
    ) -> object | None:
        installer = self._installer
        if installer is None:
            _fail("configuration operation failed")
        if license_key is not None and (type(license_key) is not str or not license_key):
            _fail("configuration value is invalid")
        if self._production and license_key is not None:
            _fail("configuration operation failed")
        method = getattr(installer, "install", None)
        if not callable(method):
            _fail("configuration value is invalid")
        try:
            result = method(destination, spec, license_key)
        except ConfigurationError:
            raise
        except BaseException:
            _fail("credentials publication failed")
        if self._production:
            if not isinstance(result, _CloakBinaryReleaseEvidence):
                _fail("configuration operation failed")
            return result
        if result is not None:
            _fail("configuration operation failed")
        return None

    def _call_verifier(
        self,
        bundle: Path,
        spec: CloakBinarySpec,
        executable_digest: str,
        bundle_digest: str,
        release_evidence: object | None,
    ) -> None:
        verifier = self._verifier
        if verifier is None:
            _fail("configuration operation failed")
        method = getattr(verifier, "verify", None)
        if not callable(method):
            _fail("configuration value is invalid")
        try:
            if self._production:
                evidence = method(bundle, spec, release_evidence)
            else:
                evidence = method(bundle, spec)
        except ConfigurationError:
            raise
        except BaseException:
            _fail("configuration operation failed")
        if not _verification_matches(evidence, spec, executable_digest, bundle_digest):
            _fail("configuration operation failed")

    def _stage_bundle(
        self,
        root: Path,
        spec: CloakBinarySpec,
        *,
        license_key: str | None,
        failpoint: object | None,
    ) -> None:
        final = root / f"chromium-{spec.version}"
        existing = _lstat(final, missing_ok=True)
        if existing is not None:
            if self._version_verified(root, spec):
                return
            _fail("credentials publication failed")
        try:
            stage = Path(
                tempfile.mkdtemp(
                    prefix=f".chromium-{spec.version}-",
                    suffix=".staging",
                    dir=root,
                )
            )
            os.chmod(stage, _DIRECTORY_MODE)
        except OSError:
            _fail("credentials publication failed")
        keep_stage = True
        try:
            release_evidence = self._call_installer(stage, spec, license_key)
            try:
                _harden_bundle(stage)
                executable_digest, bundle_digest, _ = _validate_bundle(stage)
            except _ManifestError:
                _fail("configuration operation failed")
            _failpoint(failpoint, "staging-created")
            self._call_verifier(
                stage,
                spec,
                executable_digest,
                bundle_digest,
                release_evidence,
            )
            _failpoint(failpoint, "staging-verified")
            _write_manifest(
                stage / _VERSION_MANIFEST_NAME,
                _version_manifest_payload(spec, executable_digest, bundle_digest),
                expected=None,
                failpoint=failpoint,
            )
            _failpoint(failpoint, "staging-validated")
            try:
                _rename_noreplace(stage, final)
                keep_stage = False
            except FileExistsError:
                if not self._version_verified(root, spec):
                    _fail("credentials publication failed")
                return
            _failpoint(failpoint, "bundle-published")
        finally:
            if keep_stage:
                _remove_tree(stage)

    def _publish_root(
        self,
        root: Path,
        current: str,
        previous: str | None,
        *,
        expected: os.stat_result | None,
        failpoint: object | None,
    ) -> None:
        _write_manifest(
            root / _ROOT_MANIFEST_NAME,
            _root_manifest_payload(current, previous),
            expected=expected,
            failpoint=failpoint,
        )

    def install(
        self,
        version: str | None = None,
        *,
        license_key: str | None = None,
        failpoint: object | None = None,
    ) -> CloakRuntimeStatus:
        self._require_production_gate()
        spec = self._spec(version)
        root = _root(self._home, create=True)
        if root is None:  # pragma: no cover
            _fail("credentials directory is unavailable")
        with _exclusive_lock(root):
            current = self._status_unlocked(root)
            if current.ready:
                if current.version == spec.version:
                    return current
                _fail("configuration operation failed")
            self._stage_bundle(root, spec, license_key=license_key, failpoint=failpoint)
            self._publish_root(root, spec.version, None, expected=None, failpoint=failpoint)
            return self._status_unlocked(root)

    def update(
        self,
        version: str,
        *,
        license_key: str | None = None,
        failpoint: object | None = None,
    ) -> CloakRuntimeStatus:
        self._require_production_gate()
        spec = self._spec(version)
        root = _root(self._home, create=True)
        if root is None:  # pragma: no cover
            _fail("credentials directory is unavailable")
        with _exclusive_lock(root):
            current = self._status_unlocked(root)
            if not current.ready or current.version is None:
                self._stage_bundle(root, spec, license_key=license_key, failpoint=failpoint)
                self._publish_root(root, spec.version, None, expected=None, failpoint=failpoint)
                return self._status_unlocked(root)
            if current.version == spec.version:
                return current
            expected = _lstat(root / _ROOT_MANIFEST_NAME, missing_ok=False)
            self._stage_bundle(root, spec, license_key=license_key, failpoint=failpoint)
            self._publish_root(
                root,
                spec.version,
                current.version,
                expected=expected,
                failpoint=failpoint,
            )
            return self._status_unlocked(root)

    def rollback(
        self,
        version: str | None = None,
        *,
        failpoint: object | None = None,
    ) -> CloakRuntimeStatus:
        self._require_production_gate()
        root = _root(self._home, create=True)
        if root is None:  # pragma: no cover
            _fail("credentials directory is unavailable")
        with _exclusive_lock(root):
            current = self._status_unlocked(root)
            if not current.ready or current.version is None:
                _fail("configuration operation failed")
            target = current.previous_version if version is None else version
            if target is None or target == current.version:
                _fail("configuration operation failed")
            spec = self._spec(target)
            if not self._version_verified(root, spec):
                _fail("configuration operation failed")
            expected = _lstat(root / _ROOT_MANIFEST_NAME, missing_ok=False)
            self._publish_root(
                root,
                target,
                current.version,
                expected=expected,
                failpoint=failpoint,
            )
            return self._status_unlocked(root)


__all__ = (
    "CLOAKBROWSER_ARCHIVE_SHA256",
    "CLOAKBROWSER_BROWSER_VERSION",
    "CLOAKBROWSER_ORIGIN",
    "CLOAKBROWSER_PLATFORM",
    "CLOAKBROWSER_PLAYWRIGHT_VERSION",
    "CLOAKBROWSER_WRAPPER_VERSION",
    "CloakBinaryInstaller",
    "CloakBinarySpec",
    "CloakBinaryVerification",
    "CloakBinaryVerifier",
    "CloakRuntimeLease",
    "CloakRuntimeManager",
    "CloakRuntimeStatus",
    "DEFAULT_CLOAK_BINARY_SPEC",
    "OfficialCloakBinaryInstaller",
    "OfficialCloakBinaryVerifier",
    "ProductionCloakBinaryInstaller",
    "ProductionCloakBinaryVerifier",
    "cloak_runtime_root",
)
