"""Owner-only fixed Browser identity manifest boundary.

This internal Configuration helper owns only the fixed Linux persona and its
strict JSON manifest.  Profile directory traversal and lease ownership remain
in :mod:`browser_profiles`; the launch identity value reaches Network only via
that lease.
"""

from __future__ import annotations

import hashlib
import json
import os
import secrets
import stat
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Final, Literal

from .errors import ConfigurationError
from .errors import fail as _fail
from .filesystem import current_uid as _current_uid
from .filesystem import mode as _mode
from .filesystem import same_identity as _same_identity
from .filesystem import same_metadata as _same_metadata

MANIFEST_NAME: Final[str] = "identity-manifest.json"
MANIFEST_MAX_BYTES: Final[int] = 64 * 1024
IDENTITY_SCHEMA: Final[str] = "sciretriever.browser-identity.v1"
_DIGEST_HEX_LENGTH: Final[int] = 64
IDENTITY_SCHEMA_VERSION: Final[int] = 1
PERSONA: Final[str] = "linux"
LOCALE: Final[str] = "en-US"
LANGUAGES: Final[tuple[str, ...]] = ("en-US", "en", "zh-CN", "zh", "ja", "ko")
TIMEZONE: Final[str] = "UTC"
SCREEN: Final[tuple[int, int]] = (1920, 1080)
BROWSER_VERSION: Final[str] = "146.0.7680.177.5"
DIRECTORY_MODE: Final[int] = 0o700
FILE_MODE: Final[int] = 0o600


@dataclass(frozen=True, slots=True, repr=False)
class BrowserProfileLaunchIdentity:
    fingerprint_seed: int = field(repr=False)
    persona: Literal["linux"] = PERSONA
    locale: str = LOCALE
    languages: tuple[str, ...] = LANGUAGES
    timezone: str = TIMEZONE
    screen: tuple[int, int] = SCREEN
    browser_version: str = BROWSER_VERSION

    def __post_init__(self) -> None:
        if type(self.fingerprint_seed) is not int or not 10_000 <= self.fingerprint_seed <= 99_999:
            raise ValueError("fingerprint seed is invalid")
        if (
            type(self.persona) is not str
            or self.persona != PERSONA
            or type(self.locale) is not str
            or self.locale != LOCALE
        ):
            raise ValueError("profile persona/locale is invalid")
        if type(self.languages) is not tuple or tuple(self.languages) != LANGUAGES:
            raise ValueError("profile languages are invalid")
        if type(self.timezone) is not str or self.timezone != TIMEZONE:
            raise ValueError("profile timezone is invalid")
        if (
            self.screen != SCREEN
            or type(self.browser_version) is not str
            or self.browser_version != BROWSER_VERSION
        ):
            raise ValueError("profile screen/version is invalid")

    def __repr__(self) -> str:
        return (
            "BrowserProfileLaunchIdentity("
            f"persona={self.persona!r}, locale={self.locale!r}, languages={self.languages!r}, "
            f"timezone={self.timezone!r}, screen={self.screen!r}, "
            f"browser_version={self.browser_version!r})"
        )

    def __reduce__(self) -> str | tuple[object, ...]:
        raise TypeError("Browser profile launch identity is not serializable")


@dataclass(frozen=True, slots=True, repr=False)
class BrowserProfileIdentityStatus:
    presence: Literal["missing", "configured", "attention", "needs-new-runtime-profile"]
    manifest_present: bool
    manifest_ready: bool
    identity_schema: str | None = None
    browser_version_policy: str | None = None
    persona: str | None = None

    @property
    def ready(self) -> bool:
        return self.manifest_ready

    def __repr__(self) -> str:
        return (
            "BrowserProfileIdentityStatus("
            f"presence={self.presence!r}, manifest_present={self.manifest_present!r}, "
            f"manifest_ready={self.manifest_ready!r}, identity_schema={self.identity_schema!r}, "
            f"browser_version_policy={self.browser_version_policy!r}, persona={self.persona!r})"
        )


class BrowserProfileTransitionError(ConfigurationError):
    code: Final[str] = "needs-new-runtime-profile"

    def __init__(self) -> None:
        super().__init__()


def manifest_path(profile: Path) -> Path:
    return profile / MANIFEST_NAME


def _reject_duplicate(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            _fail("configuration input is malformed")
        result[key] = value
    return result


def _reject_constant(value: str) -> object:
    del value
    _fail("configuration input is malformed")


def parse_manifest_bytes(raw: bytes) -> dict[str, object]:
    if len(raw) > MANIFEST_MAX_BYTES:
        _fail("configuration input is too large")
    try:
        value = json.loads(
            raw.decode("utf-8"),
            object_pairs_hook=_reject_duplicate,
            parse_constant=_reject_constant,
        )
    except ConfigurationError:
        raise
    except (RecursionError, UnicodeDecodeError, TypeError, ValueError):
        _fail("configuration input is malformed")
    if not isinstance(value, dict):
        _fail("configuration input is malformed")
    return value


def _lstat(path: Path, *, missing_ok: bool) -> os.stat_result | None:
    try:
        metadata = os.lstat(path)
    except FileNotFoundError:
        if missing_ok:
            return None
        _fail("browser profile is unavailable")
    except OSError:
        _fail("browser profile storage is unavailable")
    if stat.S_ISLNK(metadata.st_mode):
        _fail("browser profile contains an unsafe filesystem entry")
    return metadata


def _validate_file(metadata: os.stat_result) -> None:
    if (
        not stat.S_ISREG(metadata.st_mode)
        or metadata.st_uid != _current_uid()
        or _mode(metadata) != FILE_MODE
        or metadata.st_nlink != 1
    ):
        _fail("browser profile has unsafe ownership or permissions")


def read_manifest(path: Path) -> dict[str, object]:  # noqa: C901
    named = _lstat(path, missing_ok=False)
    if named is None:
        _fail("browser profile is unavailable")
    _validate_file(named)
    if named.st_size > MANIFEST_MAX_BYTES:
        _fail("configuration input is too large")
    flags = os.O_RDONLY
    for name in ("O_CLOEXEC", "O_NOFOLLOW", "O_BINARY"):
        value = getattr(os, name, 0)
        if isinstance(value, int):
            flags |= value
    try:
        descriptor = os.open(path, flags)
    except OSError:
        _fail("browser profile storage is unavailable")
    try:
        opened = os.fstat(descriptor)
        _validate_file(opened)
        if not _same_identity(named, opened):
            _fail("browser profile changed during validation")
        payload = bytearray()
        while len(payload) <= MANIFEST_MAX_BYTES:
            try:
                chunk = os.read(descriptor, min(65_536, MANIFEST_MAX_BYTES + 1 - len(payload)))
            except OSError:
                _fail("browser profile storage is unavailable")
            if not chunk:
                break
            payload.extend(chunk)
        after = os.fstat(descriptor)
        current = _lstat(path, missing_ok=False)
        if (
            len(payload) > MANIFEST_MAX_BYTES
            or not _same_metadata(opened, after)
            or current is None
            or not _same_identity(current, after)
            or len(payload) != after.st_size
        ):
            _fail("browser profile changed during validation")
        return parse_manifest_bytes(bytes(payload))
    finally:
        os.close(descriptor)


def _string(value: object) -> str:
    if (
        type(value) is not str
        or not value
        or any(ord(char) < 0x20 or ord(char) == 0x7F for char in value)
    ):
        _fail("configuration input is malformed")
    return value


def _integer(value: object) -> int:
    if type(value) is not int:
        _fail("configuration input is malformed")
    return value


def parse_identity_manifest(  # noqa: C901
    value: dict[str, object],
) -> BrowserProfileLaunchIdentity:
    expected = {
        "schema_version",
        "identity_schema",
        "fingerprint_seed",
        "persona",
        "locale",
        "languages",
        "timezone",
        "screen",
        "browser_version_policy",
        "identity_digest",
    }
    if set(value) != expected:
        _fail("configuration key is unknown")
    if _integer(value["schema_version"]) != IDENTITY_SCHEMA_VERSION:
        _fail("configuration value is invalid")
    if _string(value["identity_schema"]) != IDENTITY_SCHEMA:
        _fail("configuration value is invalid")
    if _string(value["persona"]) != PERSONA:
        _fail("configuration value is invalid")
    languages = value["languages"]
    if type(languages) is not list or tuple(languages) != LANGUAGES:
        _fail("configuration value is invalid")
    screen = value["screen"]
    if type(screen) is not dict or set(screen) != {"width", "height"}:
        _fail("configuration value is invalid")
    policy = value["browser_version_policy"]
    if type(policy) is not dict or set(policy) != {"mode", "version"}:
        _fail("configuration value is invalid")
    if _string(policy["mode"]) != "exact":
        _fail("configuration value is invalid")
    digest = _string(value["identity_digest"])
    if len(digest) != _DIGEST_HEX_LENGTH or any(
        character not in "0123456789abcdef" for character in digest
    ):
        _fail("configuration value is invalid")
    try:
        identity = BrowserProfileLaunchIdentity(
            fingerprint_seed=_integer(value["fingerprint_seed"]),
            persona=PERSONA,
            locale=_string(value["locale"]),
            languages=LANGUAGES,
            timezone=_string(value["timezone"]),
            screen=(_integer(screen["width"]), _integer(screen["height"])),
            browser_version=_string(policy["version"]),
        )
    except (TypeError, ValueError):
        _fail("configuration value is invalid")
    if not _identity_digest(identity) == digest:
        _fail("configuration value is invalid")
    return identity


def _identity_payload(identity: BrowserProfileLaunchIdentity) -> dict[str, object]:
    """Return the canonical, owner-only identity payload.

    The digest covers every identity-bearing value, including the seed.  It is
    an integrity/identity binding value, not an exposed fingerprint and is
    intentionally never copied into the launch object or status model.
    """

    return {
        "browser_version_policy": {"mode": "exact", "version": identity.browser_version},
        "fingerprint_seed": identity.fingerprint_seed,
        "identity_schema": IDENTITY_SCHEMA,
        "languages": list(identity.languages),
        "locale": identity.locale,
        "persona": identity.persona,
        "schema_version": IDENTITY_SCHEMA_VERSION,
        "screen": {"height": identity.screen[1], "width": identity.screen[0]},
        "timezone": identity.timezone,
    }


def _canonical_identity_payload(identity: BrowserProfileLaunchIdentity) -> bytes:
    return json.dumps(
        _identity_payload(identity),
        ensure_ascii=True,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")


def _identity_digest(identity: BrowserProfileLaunchIdentity) -> str:
    return hashlib.sha256(_canonical_identity_payload(identity)).hexdigest()


def manifest_bytes(identity: BrowserProfileLaunchIdentity) -> bytes:
    payload = _identity_payload(identity)
    payload["identity_digest"] = _identity_digest(identity)
    return json.dumps(payload, ensure_ascii=True, separators=(",", ":"), sort_keys=True).encode(
        "utf-8"
    )


def _write_all(descriptor: int, payload: bytes) -> None:
    offset = 0
    while offset < len(payload):
        try:
            count = os.write(descriptor, payload[offset:])
        except OSError:
            _fail("browser profile storage is unavailable")
        if count <= 0:
            _fail("browser profile storage is unavailable")
        offset += count


def publish_manifest(  # noqa: C901
    path: Path,
    identity: BrowserProfileLaunchIdentity,
    *,
    failpoint: object | None = None,
) -> BrowserProfileLaunchIdentity:  # noqa: C901
    parent = path.parent
    parent_metadata = _lstat(parent, missing_ok=False)
    if (
        parent_metadata is None
        or not stat.S_ISDIR(parent_metadata.st_mode)
        or parent_metadata.st_uid != _current_uid()
        or _mode(parent_metadata) != DIRECTORY_MODE
    ):
        _fail("browser profile storage is unavailable")
    existing = _lstat(path, missing_ok=True)
    if existing is not None:
        return parse_identity_manifest(read_manifest(path))
    staging: Path | None = None
    descriptor: int | None = None
    try:
        descriptor_raw, path_raw = tempfile.mkstemp(
            prefix=".identity-manifest-", suffix=".staging", dir=parent
        )
        descriptor, staging = descriptor_raw, Path(path_raw)
        os.fchmod(descriptor, FILE_MODE)
        callback = getattr(failpoint, "__call__", None)
        if failpoint is not None and not callable(callback):
            _fail("configuration value is invalid")
        if callback is not None:
            callback("staging-created")
        payload = manifest_bytes(identity)
        _write_all(descriptor, payload)
        if callback is not None:
            callback("staging-written")
        os.fsync(descriptor)
        if callback is not None:
            callback("staging-fsynced")
        os.close(descriptor)
        descriptor = None
        parse_identity_manifest(read_manifest(staging))
        if callback is not None:
            callback("staging-validated")
            callback("before-replace")
        try:
            os.link(staging, path)
        except FileExistsError:
            return parse_identity_manifest(read_manifest(path))
        os.unlink(staging)
        staging = None
        return identity
    except ConfigurationError:
        raise
    except BaseException:
        _fail("browser profile storage is unavailable")
    finally:
        if descriptor is not None:
            os.close(descriptor)
        if staging is not None:
            try:
                staging.unlink()
            except OSError:
                pass


def new_identity(storage: Path) -> BrowserProfileLaunchIdentity:
    seeds: set[int] = set()
    try:
        entries = tuple(os.scandir(storage))
    except OSError:
        entries = ()
    for entry in entries:
        if not entry.is_dir(follow_symlinks=False):
            continue
        path = manifest_path(Path(entry.path))
        if _lstat(path, missing_ok=True) is None:
            continue
        try:
            seeds.add(parse_identity_manifest(read_manifest(path)).fingerprint_seed)
        except ConfigurationError:
            continue
    for _attempt in range(32):
        seed = secrets.randbelow(90_000) + 10_000
        if seed not in seeds:
            return BrowserProfileLaunchIdentity(seed)
    _fail("browser profile storage is unavailable")


__all__ = (
    "BROWSER_VERSION",
    "DIRECTORY_MODE",
    "FILE_MODE",
    "IDENTITY_SCHEMA",
    "LANGUAGES",
    "LOCALE",
    "MANIFEST_NAME",
    "MANIFEST_MAX_BYTES",
    "PERSONA",
    "SCREEN",
    "TIMEZONE",
    "BrowserProfileIdentityStatus",
    "BrowserProfileLaunchIdentity",
    "BrowserProfileTransitionError",
    "manifest_bytes",
    "manifest_path",
    "new_identity",
    "parse_identity_manifest",
    "parse_manifest_bytes",
    "publish_manifest",
    "read_manifest",
)
