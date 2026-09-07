"""Production CloakBrowser adapter for the controlled Browser boundary.

The adapter deliberately keeps CloakBrowser and Playwright vendor objects on a
private, dedicated engine thread.  ``cloakbrowser.launch_persistent_context``
starts its own Playwright manager and wraps ``BrowserContext.close`` so that the
manager is stopped exactly once.  SciRetriever therefore does not call
``sync_playwright().start()`` (or ``stop()``) in this module.  The object
returned by :class:`CloakBrowserFactory` is the same opaque process/context
shape consumed by ``network.browser`` and ``network.browser_sessions``.
"""

from __future__ import annotations

import ctypes
import errno
import importlib.util
import os
import queue
import re
import stat
import sys
import threading
import time
from collections.abc import Callable, Mapping
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Final, Generic, TypeVar, cast

from sciretriever.logging.api import get_logger

from .browser_connect import (
    BrowserConnectProxy,
    HeadedDisplayLease,
    acquire_headed_display,
    xvfb_executable_available,
)
from .browser_control import BrowserObservationUnavailable
from .browser_runtime import (
    configure_pdf_download_preference as _configure_pdf_download_preference,
)
from .browser_runtime import (
    runtime_profile_directory as _runtime_profile_directory,
)
from .playwright import (
    PlaywrightRuntimeError,
    _Context,
)

_T = TypeVar("_T")
# BrowserClient's default flow deadline is 60 seconds.  Engine command waits
# must stay below that budget so a dead/blocked vendor command cannot outlive
# the caller's overall operation and keep a lane alive indefinitely.
_COMMAND_TIMEOUT_SECONDS: Final[float] = 55.0
_LAUNCH_TIMEOUT_MILLISECONDS: Final[int] = 30_000
_EVENT_PUMP_INTERVAL_SECONDS: Final[float] = 0.01
_MAX_ARTICLE_BYTES: Final[int] = 128 * 1024 * 1024
_CLOAK_VERSION_RE: Final[re.Pattern[str]] = re.compile(r"^[0-9]+(?:\.[0-9]+){3,4}$")
_DEFAULT_BROWSER_VERSION: Final[str] = "146.0.7680.177.5"
_DEFAULT_SCREEN: Final[tuple[int, int]] = (1920, 1080)
# Linux clone ABI value. Python 3.10 does not expose ``os.CLONE_FS``.
_CLONE_FS: Final[int] = 0x00000200
_PRIVATE_RUNTIME_UMASK: Final[int] = 0o077
_VENDOR_WELCOME_MARKER: Final[str] = ".welcome_shown"
_DEFAULT_LANGUAGES: Final[tuple[str, ...]] = (
    "en-US",
    "en",
    "zh-CN",
    "zh",
    "ja",
    "ko",
)
_LOGGER = get_logger(__name__)

# ``cloakbrowser`` reads these itself when resolving a binary/license.  A
# regular Completion must not allow environment values to select a binary,
# license, proxy, or proxy rotation policy.  We pass an explicit cleaned env to
# the child and temporarily hide the values from the wrapper while it builds
# its launch options.  The lock makes that tiny process-global mutation
# deterministic even if another runtime launch is requested concurrently.
_ENV_LOCK = threading.RLock()
_PROXY_ENV_NAMES: Final[frozenset[str]] = frozenset(
    {
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "http_proxy",
        "https_proxy",
        "all_proxy",
    }
)
_CHILD_ENV_ALLOWLIST: Final[frozenset[str]] = frozenset(
    {
        "PATH",
        "HOME",
        "LANG",
        "LC_ALL",
        "LC_CTYPE",
        "XDG_RUNTIME_DIR",
        "DISPLAY",
        "USER",
        "LOGNAME",
        "TZ",
    }
)


class CloakBrowserRuntimeError(PlaywrightRuntimeError):
    """Payload-free failure from the private CloakBrowser adapter."""


def _runtime_error() -> CloakBrowserRuntimeError:
    return CloakBrowserRuntimeError("controlled CloakBrowser runtime failed")


def _isolate_runtime_filesystem_context() -> None:
    """Give the engine thread a private fs context and owner-only umask.

    Chromium inherits this thread's umask when the wrapper starts its child
    process. ``CLONE_FS`` isolation keeps the change away from Acquisition,
    Storage, and user-output threads in the same Python process.
    """

    if not sys.platform.startswith("linux"):
        raise _runtime_error()
    try:
        libc = ctypes.CDLL(None, use_errno=True)
        function = libc.unshare
        function.argtypes = [ctypes.c_int]
        function.restype = ctypes.c_int
        if function(_CLONE_FS) != 0:
            error_number = ctypes.get_errno() or errno.EIO
            raise OSError(error_number, os.strerror(error_number))
        os.umask(_PRIVATE_RUNTIME_UMASK)
    except (AttributeError, OSError):
        raise _runtime_error() from None


def _required_callable(value: object, name: str) -> Callable[..., object]:
    candidate = getattr(value, name, None)
    if not callable(candidate):
        raise _runtime_error()
    return candidate


def _clean_environment(source: Mapping[str, str]) -> dict[str, str]:
    """Return a child environment with proxy and Cloak controls removed."""

    return {
        key: value
        for key, value in source.items()
        if key in _CHILD_ENV_ALLOWLIST
        and key not in _PROXY_ENV_NAMES
        and not key.startswith("CLOAKBROWSER_")
    }


def _safe_vendor_marker(metadata: os.stat_result) -> bool:
    return (
        stat.S_ISREG(metadata.st_mode)
        and metadata.st_uid == os.geteuid()
        and metadata.st_nlink == 1
    )


def _open_vendor_welcome_marker(marker: Path) -> int:
    try:
        try:
            prior = os.lstat(marker)
        except FileNotFoundError:
            prior = None
        if prior is not None and not _safe_vendor_marker(prior):
            raise _runtime_error()
        flags = os.O_WRONLY | os.O_CREAT
        if prior is None:
            flags |= os.O_EXCL
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        descriptor = os.open(marker, flags, 0o600)
        current = os.fstat(descriptor)
        same_file = prior is None or (current.st_dev, current.st_ino) == (
            prior.st_dev,
            prior.st_ino,
        )
        if not _safe_vendor_marker(current) or not same_file:
            os.close(descriptor)
            raise _runtime_error()
        return descriptor
    except CloakBrowserRuntimeError:
        raise
    except (OSError, OverflowError, ValueError):
        raise _runtime_error() from None


def _prime_vendor_welcome_marker(cache_directory: Path) -> None:
    """Suppress the pinned wrapper's banner inside its sterile launch cache.

    CloakBrowser 0.5.8 writes a welcome advertisement directly to process
    stderr whenever this private marker is absent or stale.  Each production
    lease intentionally receives a new cache, so letting the wrapper create
    the marker would expose the banner on every process launch.  The marker is
    non-authoritative vendor state: it lives only in Configuration's temporary
    cache and does not contain or select a license, binary, Profile or update.
    """

    marker = cache_directory / _VENDOR_WELCOME_MARKER
    payload = str(int(time.time())).encode("ascii")
    descriptor = -1
    try:
        descriptor = _open_vendor_welcome_marker(marker)
        os.fchmod(descriptor, 0o600)
        os.ftruncate(descriptor, 0)
        if os.write(descriptor, payload) != len(payload):
            raise _runtime_error()
    except CloakBrowserRuntimeError:
        raise
    except (OSError, OverflowError, ValueError):
        raise _runtime_error() from None
    finally:
        if descriptor >= 0:
            try:
                os.close(descriptor)
            except OSError:
                pass


@contextmanager
def _vendor_environment(cache_directory: Path) -> Any:
    """Hide forbidden environment controls while a vendor launch is built.

    CloakBrowser 0.5.8 resolves cache, license and version overrides from
    ``os.environ`` before it sees the explicit launch arguments.  Temporarily
    removing all vendor/proxy controls and injecting only the Configuration-
    supplied sterile per-lease cache view lets the adapter preserve the
    vendor's normal launch implementation without exposing the durable runtime
    root or accepting an operator's ambient controls. The original values are
    restored even when launch fails.
    """

    if not isinstance(cache_directory, Path):
        raise _runtime_error()
    with _ENV_LOCK:
        _prime_vendor_welcome_marker(cache_directory)
        removed: dict[str, str] = {}
        for key in tuple(os.environ):
            if key in _PROXY_ENV_NAMES or key.startswith("CLOAKBROWSER_"):
                value = os.environ.pop(key, None)
                if value is not None:
                    removed[key] = value
        try:
            os.environ["CLOAKBROWSER_CACHE_DIR"] = os.fspath(cache_directory)
            os.environ["CLOAKBROWSER_AUTO_UPDATE"] = "false"
            yield
        finally:
            os.environ.pop("CLOAKBROWSER_CACHE_DIR", None)
            os.environ.pop("CLOAKBROWSER_AUTO_UPDATE", None)
            os.environ.update(removed)


def _default_launcher(user_data_dir: str, **options: object) -> object:
    """Invoke the pinned wrapper lazily, keeping it optional for offline tests."""

    try:
        import cloakbrowser
    except (ImportError, ModuleNotFoundError):
        raise _runtime_error() from None
    launch = getattr(cloakbrowser, "launch_persistent_context", None)
    if not callable(launch):
        raise _runtime_error()
    try:
        # The wrapper starts/stops its own sync Playwright manager.  Do not
        # replace this with ``playwright.sync_api.sync_playwright`` here.
        return launch(user_data_dir, **options)
    except CloakBrowserRuntimeError:
        raise
    except BaseException:
        raise _runtime_error() from None


@dataclass(frozen=True, slots=True, repr=False)
class CloakBrowserIdentity:
    """Private launch identity copied from a Configuration Profile lease."""

    fingerprint_seed: int = field(repr=False)
    persona: str
    locale: str
    languages: tuple[str, ...]
    timezone: str
    screen: tuple[int, int]
    browser_version: str

    def __post_init__(self) -> None:
        if type(self.fingerprint_seed) is not int or self.fingerprint_seed <= 0:
            raise ValueError("fingerprint_seed must be a positive integer")
        if type(self.persona) is not str or self.persona != "linux":
            raise ValueError("persona must be the native linux persona")
        for name in ("locale", "timezone"):
            value = getattr(self, name)
            if (
                type(value) is not str
                or not value.strip()
                or any(ord(char) < 0x20 or ord(char) == 0x7F for char in value)
            ):
                raise ValueError(f"{name} must be a nonblank safe string")
        if (
            type(self.languages) is not tuple
            or self.languages != _DEFAULT_LANGUAGES
            or any(
                type(value) is not str
                or not value.strip()
                or any(ord(char) < 0x20 or ord(char) == 0x7F for char in value)
                for value in self.languages
            )
        ):
            raise ValueError("languages must be a nonempty tuple of safe strings")
        if self.languages[0] != self.locale:
            raise ValueError("the first language must match the locale")
        if (
            type(self.screen) is not tuple
            or len(self.screen) != 2
            or any(type(value) is not int or value <= 0 for value in self.screen)
        ):
            raise ValueError("screen must contain two positive integers")
        # The first Linux persona is intentionally tied to the shared Xvfb
        # geometry.  A future geometry is a new identity policy, not a hidden
        # per-launch override.
        if self.screen != _DEFAULT_SCREEN:
            raise ValueError("screen must be 1920x1080 for the linux persona")
        if type(self.browser_version) is not str or not _CLOAK_VERSION_RE.fullmatch(
            self.browser_version
        ):
            raise ValueError("browser_version must be a full numeric version")

    def __repr__(self) -> str:
        return "CloakBrowserIdentity(redacted)"

    def __reduce__(self) -> str | tuple[object, ...]:
        raise TypeError("CloakBrowser identity cannot be serialized")


def _copy_launch_identity(lease: object) -> CloakBrowserIdentity:
    """Copy the Configuration identity through a structural, private seam.

    Network deliberately does not import Configuration's identity model.  The
    lease is the ownership boundary: it holds the profile directory lock and
    exposes ``launch_identity`` only while that lock is active.  Copying every
    field also prevents a vendor object or mutable mapping from crossing into
    the engine state.
    """

    try:
        source = getattr(lease, "launch_identity")
        values = {
            name: getattr(source, name)
            for name in (
                "fingerprint_seed",
                "persona",
                "locale",
                "languages",
                "timezone",
                "screen",
                "browser_version",
            )
        }
    except BaseException:
        raise _runtime_error() from None
    try:
        return CloakBrowserIdentity(**values)
    except (TypeError, ValueError):
        raise _runtime_error() from None


def _copy_binary_runtime(lease: object) -> tuple[Path, str]:
    """Copy the verified binary lease's sterile cache view and exact version.

    The lease is deliberately not asked for an executable path.  CloakBrowser
    resolves the native Linux layout itself, so accepting an arbitrary path or
    URL here would re-enable the wrapper's local-binary/download escape hatches.
    Configuration owns installation, revalidates the durable bundle, and then
    creates an owner-only per-lease view containing only that version. Network
    repeats the cheap expected-path check immediately before invoking vendor
    code; license/Pro/update state from the durable root is never visible here.
    """

    try:
        cache_directory = getattr(lease, "cache_directory")
        browser_version = getattr(lease, "browser_version")
    except BaseException:
        raise _runtime_error() from None
    if not isinstance(cache_directory, Path):
        raise _runtime_error()
    if type(browser_version) is not str or not _CLOAK_VERSION_RE.fullmatch(browser_version):
        raise _runtime_error()
    return cache_directory, browser_version


def _expected_binary_path(cache_directory: Path, browser_version: str) -> Path:
    """Derive the only binary layout accepted by the pinned vendor wrapper."""

    return cache_directory / f"chromium-{browser_version}" / "chrome"


def _verify_binary_path(cache_directory: Path, browser_version: str) -> None:
    path = _expected_binary_path(cache_directory, browser_version)
    try:
        if (
            path.is_symlink()
            or not path.is_file()
            or (os.name != "nt" and not os.access(path, os.X_OK))
        ):
            raise _runtime_error()
    except CloakBrowserRuntimeError:
        raise
    except OSError:
        raise _runtime_error() from None


@dataclass(frozen=True, slots=True)
class CloakBrowserRuntimeAvailability:
    """Static presence check; it never starts Playwright or downloads a binary."""

    cloak_wrapper_available: bool
    playwright_api_available: bool
    binary_executable_available: bool
    headed_display_available: bool
    browser_version: str | None = None

    def __post_init__(self) -> None:
        for name in (
            "cloak_wrapper_available",
            "playwright_api_available",
            "binary_executable_available",
            "headed_display_available",
        ):
            if type(getattr(self, name)) is not bool:
                raise TypeError(f"{name} must be a bool")
        if self.binary_executable_available and not (
            self.cloak_wrapper_available and self.playwright_api_available
        ):
            raise ValueError("a Cloak binary requires the wrapper and Playwright API")
        if self.browser_version is not None and not _CLOAK_VERSION_RE.fullmatch(
            self.browser_version
        ):
            raise ValueError("browser_version must be a full numeric version")


def _cloak_package_available() -> bool:
    try:
        specification = importlib.util.find_spec("cloakbrowser")
    except (ImportError, ModuleNotFoundError, ValueError):
        return False
    return specification is not None


def _playwright_package_available() -> bool:
    try:
        specification = importlib.util.find_spec("playwright")
    except (ImportError, ModuleNotFoundError, ValueError):
        return False
    return specification is not None


def _controlled_binary_available(
    cache_directory: str | os.PathLike[str] | None,
    browser_version: str,
) -> bool:
    """Inspect the Configuration-owned vendor cache layout, never env/path overrides."""

    if cache_directory is None:
        return False
    if not isinstance(cache_directory, (str, os.PathLike)):
        raise TypeError("cache_directory must be a path or None")
    path = Path(cache_directory)
    try:
        if path.is_symlink() or not path.is_dir():
            return False
        binary = _expected_binary_path(path, browser_version)
        return (
            not binary.is_symlink()
            and binary.is_file()
            and (os.name == "nt" or os.access(binary, os.X_OK))
        )
    except OSError:
        return False


def cloakbrowser_runtime_availability(
    *,
    browser_version: str = _DEFAULT_BROWSER_VERSION,
    cache_directory: str | os.PathLike[str] | None = None,
) -> CloakBrowserRuntimeAvailability:
    """Assess wrapper, controlled vendor cache layout and Xvfb without launching.

    The caller must supply the cache root resolved by Configuration's verified
    Cloak runtime lease.  Deliberately returning ``False`` when it is omitted
    avoids consulting the vendor cache (which is environment-derived in
    CloakBrowser 0.5.8) or triggering an install/update operation.  The only
    accepted executable is the pinned vendor layout under that root.
    """

    if type(browser_version) is not str or not _CLOAK_VERSION_RE.fullmatch(browser_version):
        raise ValueError("browser_version must be a full numeric version")
    wrapper = _cloak_package_available()
    playwright_api = _playwright_package_available()
    binary = (
        wrapper
        and playwright_api
        and _controlled_binary_available(cache_directory, browser_version)
    )
    return CloakBrowserRuntimeAvailability(
        cloak_wrapper_available=wrapper,
        playwright_api_available=playwright_api,
        binary_executable_available=binary,
        headed_display_available=xvfb_executable_available(),
        browser_version=browser_version,
    )


@dataclass(slots=True)
class _Command(Generic[_T]):
    operation: Callable[[], _T]
    completed: threading.Event
    result: list[_T]
    failure: list[BaseException]


class _CloakEngine:
    """One thread owning a wrapper-created manager and persistent context."""

    __slots__ = (
        "_commands",
        "_ready",
        "_thread",
        "_state_lock",
        "_failure",
        "_context",
        "_proxy",
        "_display",
        "_profile_handle",
        "_runtime_handle",
        "_ignore_https_errors",
        "_launcher",
        "_runtime_lease",
        "_profile_lease",
        "_closed",
    )

    def __init__(
        self,
        profile_handle: object,
        runtime_handle: object,
        *,
        ignore_https_errors: bool,
        launcher: Callable[..., object],
    ) -> None:
        if not callable(getattr(profile_handle, "acquire_runtime", None)):
            raise TypeError("profile_handle must expose acquire_runtime()")
        if not callable(getattr(runtime_handle, "acquire_runtime", None)):
            raise TypeError("runtime_handle must expose acquire_runtime()")
        if type(ignore_https_errors) is not bool:
            raise TypeError("ignore_https_errors must be a bool")
        if not callable(launcher):
            raise TypeError("launcher must be callable")
        self._commands: queue.Queue[_Command[object] | None] = queue.Queue()
        self._ready = threading.Event()
        self._thread = threading.Thread(
            target=self._main,
            name="sciretriever-cloakbrowser-engine",
            daemon=True,
        )
        # Coordinates state checks with queue insertion and pending-command
        # rejection.  Without this small lock a vendor thread can fail in the
        # gap between ``is_alive()`` and ``Queue.put()``, leaving a command
        # that waits for the full engine timeout with no owner to complete it.
        self._state_lock = threading.Lock()
        self._failure: BaseException | None = None
        self._context: _Context | None = None
        self._proxy: BrowserConnectProxy | None = None
        self._display: HeadedDisplayLease | None = None
        self._profile_handle = profile_handle
        self._runtime_handle = runtime_handle
        self._ignore_https_errors = ignore_https_errors
        self._launcher = launcher
        self._runtime_lease: object | None = None
        self._profile_lease: object | None = None
        self._closed = False

    def start(self) -> None:
        self._thread.start()
        if not self._ready.wait(_COMMAND_TIMEOUT_SECONDS) or self._failure is not None:
            raise _runtime_error()

    def call(self, operation: Callable[[], _T]) -> _T:  # noqa: C901
        if threading.current_thread() is self._thread:
            if self._closed:
                raise _runtime_error()
            try:
                return operation()
            except BrowserObservationUnavailable:
                raise
            except CloakBrowserRuntimeError:
                raise
            except TimeoutError:
                raise
            except BaseException:
                raise _runtime_error() from None
        command: _Command[_T] = _Command(operation, threading.Event(), [], [])
        # Check failure and liveness before enqueueing, while holding the same
        # lock used by the engine's pending-command drain.  This keeps the
        # dead-engine path deterministic and prevents a race from orphaning a
        # command after the engine has already stopped.
        with self._state_lock:
            if self._closed or self._failure is not None or not self._thread.is_alive():
                raise _runtime_error()
            self._commands.put(cast(_Command[object], command))
            if not self._thread.is_alive() and not command.completed.is_set():
                command.failure.append(self._failure or _runtime_error())
                command.completed.set()
        if not command.completed.wait(_COMMAND_TIMEOUT_SECONDS):
            self.interrupt()
            raise _runtime_error()
        if command.failure:
            failure = command.failure[0]
            if isinstance(failure, BrowserObservationUnavailable):
                raise failure
            if isinstance(failure, TimeoutError):
                raise TimeoutError from None
            if isinstance(failure, CloakBrowserRuntimeError):
                raise failure
            raise _runtime_error()
        if not command.result:
            raise _runtime_error()
        return command.result[0]

    def launch_context(self, downloads_path: str) -> _Context:
        if type(downloads_path) is not str or not downloads_path:
            raise _runtime_error()
        return self.call(lambda: self._launch_context(downloads_path))

    def _launch_context(self, downloads_path: str) -> _Context:
        if self._context is not None:
            raise _runtime_error()
        profile_lease: object | None = None
        runtime_lease: object | None = None
        proxy: BrowserConnectProxy | None = None
        display: HeadedDisplayLease | None = None
        raw_context: object | None = None
        try:
            runtime_lease = _required_callable(self._runtime_handle, "acquire_runtime")()
            cache_directory, runtime_version = _copy_binary_runtime(runtime_lease)
            _verify_binary_path(cache_directory, runtime_version)
            profile_lease = _required_callable(self._profile_handle, "acquire_runtime")()
            identity = _copy_launch_identity(profile_lease)
            if identity.browser_version != runtime_version:
                raise _runtime_error()
            directory = _runtime_profile_directory(profile_lease)
            _configure_pdf_download_preference(directory)
            proxy = BrowserConnectProxy(maximum_article_bytes=_MAX_ARTICLE_BYTES)
            display = acquire_headed_display()
            options = self._launch_options(downloads_path, proxy, display, identity)
            with _vendor_environment(cache_directory):
                raw_context = self._launcher(os.fspath(directory), **options)
            if raw_context is None:
                raise _runtime_error()
            context = _Context(
                self,
                raw_context,
                proxy,
                Path(downloads_path),
                external_pdf_downloads=True,
            )
            self._profile_lease = profile_lease
            self._runtime_lease = runtime_lease
            self._proxy = proxy
            self._display = display
            self._context = context
            _LOGGER.debug(
                "event=browser-cloak-runtime-ready stage=launch adapter=cloakbrowser "
                "runtime_version=%s runtime_ready=true identity_stable=true "
                "process_reused=false context_reused=false outcome=ready reason=%s action=%s",
                runtime_version,
                "The pinned Browser runtime and fixed identity are ready.",
                "Continue with the reviewed Browser flow.",
            )
            return context
        except CloakBrowserRuntimeError:
            self._close_failed_launch(
                raw_context=raw_context,
                profile_lease=profile_lease,
                runtime_lease=runtime_lease,
                proxy=proxy,
                display=display,
            )
            raise
        except BaseException:
            self._close_failed_launch(
                raw_context=raw_context,
                profile_lease=profile_lease,
                runtime_lease=runtime_lease,
                proxy=proxy,
                display=display,
            )
            raise _runtime_error() from None

    def _launch_options(
        self,
        downloads_path: str,
        proxy: BrowserConnectProxy,
        display: HeadedDisplayLease,
        identity: CloakBrowserIdentity,
    ) -> dict[str, object]:
        # Build only an allowlisted child environment.  In particular, do not
        # call ``HeadedDisplayLease.environment()`` here: that helper clones
        # the full process environment, which would unnecessarily read and
        # forward unrelated API credentials and proxy controls.
        env_source = {
            name: value
            for name in _CHILD_ENV_ALLOWLIST
            if (value := os.environ.get(name)) is not None
        }
        if display.display is not None:
            env_source["DISPLAY"] = display.display
        env = _clean_environment(env_source)
        args = (
            f"--fingerprint={identity.fingerprint_seed}",
            "--fingerprint-platform=linux",
            f"--lang={identity.locale}",
            "--disable-component-update",
            "--disable-default-apps",
            "--disable-sync",
            "--no-first-run",
        )
        return {
            "headless": False,
            "humanize": True,
            "human_preset": "default",
            "stealth_args": False,
            "args": list(args),
            "browser_version": identity.browser_version,
            "timezone": identity.timezone,
            "viewport": None,
            "accept_downloads": True,
            "downloads_path": downloads_path,
            # Playwright cannot route requests taken over by a Service Worker.
            # The CONNECT tunnel can still constrain such traffic to a
            # pre-authorized origin, but it cannot prove the reviewed path,
            # resource type, frame ancestry, or article ownership inside TLS.
            # Blocking workers therefore preserves the complete Network guard;
            # ordinary page scripts, fetches and challenge iframes remain
            # available through the routed page network stack.
            "service_workers": "block",
            "timeout": _LAUNCH_TIMEOUT_MILLISECONDS,
            "ignore_https_errors": self._ignore_https_errors,
            "proxy": {"server": proxy.server_url},
            "env": env,
            "geoip": False,
        }

    @staticmethod
    def _close_failed_launch(
        *,
        raw_context: object | None,
        profile_lease: object | None,
        runtime_lease: object | None,
        proxy: BrowserConnectProxy | None,
        display: HeadedDisplayLease | None,
    ) -> None:
        if raw_context is not None:
            close = getattr(raw_context, "close", None)
            if callable(close):
                try:
                    close()
                except BaseException:
                    pass
        for value in (proxy, display, profile_lease, runtime_lease):
            if value is None:
                continue
            close = getattr(value, "close", None)
            if callable(close):
                try:
                    close()
                except BaseException:
                    pass

    def interrupt(self) -> None:
        context = self._context
        if context is not None:
            context.interrupt_transport()

    abort = interrupt
    cancel = interrupt
    stop = interrupt

    def close(self) -> None:
        self.interrupt()
        with self._state_lock:
            if self._closed:
                if self._failure is not None:
                    raise _runtime_error()
                return
            self._closed = True
            self._commands.put(None)
        self._thread.join(_COMMAND_TIMEOUT_SECONDS)
        if self._thread.is_alive() or self._failure is not None:
            raise _runtime_error()

    def _main(self) -> None:
        # This thread does not start a second Playwright manager. The wrapper
        # call owns manager start and context.close owns manager stop.
        try:
            _isolate_runtime_filesystem_context()
            self._ready.set()
            while True:
                try:
                    command = self._commands.get(timeout=_EVENT_PUMP_INTERVAL_SECONDS)
                except queue.Empty:
                    context = self._context
                    if context is not None:
                        context.pump_events_from_engine()
                    continue
                if command is None:
                    break
                try:
                    result = command.operation()
                except BaseException as error:
                    self._complete_failure(command, error)
                else:
                    self._complete_success(command, result)
        except BaseException as error:
            with self._state_lock:
                self._failure = error
            self._fail_pending(error)
        finally:
            # Wake ``start`` promptly when filesystem isolation failed before
            # the ordinary ready point.
            self._ready.set()
            self._stop_runtime()

    def _fail_pending(self, error: BaseException) -> None:
        # Hold the state lock across the drain so a caller cannot enqueue a
        # command between the liveness check and this rejection pass.
        with self._state_lock:
            while True:
                try:
                    command = self._commands.get_nowait()
                except queue.Empty:
                    return
                if command is None or command.completed.is_set():
                    continue
                command.failure.append(error)
                command.completed.set()

    def _complete_success(self, command: _Command[object], result: object) -> None:
        with self._state_lock:
            if command.completed.is_set():
                return
            command.result.append(result)
            command.completed.set()

    def _complete_failure(self, command: _Command[object], error: BaseException) -> None:
        with self._state_lock:
            if command.completed.is_set():
                return
            command.failure.append(error)
            command.completed.set()

    def _stop_runtime(self) -> None:
        cleanup_started_ns = time.monotonic_ns()
        failure: BaseException | None = None
        context = self._context
        self._context = None
        if context is not None:
            try:
                context.close_from_engine()
            except BaseException as error:
                failure = error
        # The wrapper's context.close() has already stopped its manager.  These
        # three resources are ours and are therefore closed exactly once here.
        for name in ("_proxy", "_display", "_profile_lease", "_runtime_lease"):
            value = getattr(self, name)
            setattr(self, name, None)
            if value is None:
                continue
            close = getattr(value, "close", None)
            if not callable(close):
                failure = failure or _runtime_error()
                continue
            try:
                close()
            except BaseException as error:
                failure = failure or error
        if failure is not None:
            with self._state_lock:
                if self._failure is None:
                    self._failure = failure
        _LOGGER.debug(
            "event=browser-cloak-cleanup stage=cleanup adapter=cloakbrowser "
            "outcome=%s cleanup=%s elapsed_ms=%d reason=%s action=%s",
            "failure" if failure is not None else "success",
            "failed" if failure is not None else "completed",
            max((time.monotonic_ns() - cleanup_started_ns) // 1_000_000, 0),
            "The Browser runtime cleanup completed."
            if failure is None
            else "The Browser runtime cleanup failed.",
            "Retry after checking the Browser runtime."
            if failure is not None
            else "Continue with the next Browser flow.",
        )


class _CloakProcess:
    """Opaque process runtime matching the existing Browser factory contract."""

    __slots__ = ("_engine", "_closed")

    def __init__(self, engine: _CloakEngine) -> None:
        self._engine = engine
        self._closed = False

    def bind_connection(self, binding: object) -> object:
        if self._closed:
            raise _runtime_error()
        return binding

    def new_context(
        self,
        *,
        downloads_path: str,
        accept_downloads: bool,
        connection_binding: object,
    ) -> _Context:
        del connection_binding
        if self._closed or not accept_downloads:
            raise _runtime_error()
        return self._engine.launch_context(downloads_path)

    def abort(self) -> None:
        self._engine.interrupt()

    cancel = abort
    stop = abort

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        self._engine.close()

    def __enter__(self) -> _CloakProcess:
        if self._closed:
            raise _runtime_error()
        return self

    def __exit__(self, exc_type: object, exc_value: object, traceback: object) -> bool:
        del exc_type, exc_value, traceback
        self.close()
        return False


class CloakBrowserFactory:
    """Callable Network adapter for the pinned production CloakBrowser runtime.

    ``profile_handle`` and ``runtime_handle`` are opaque Configuration-owned
    handles.  The fixed launch identity is obtained only from the profile
    runtime lease, after the lease has acquired the exclusive profile lock;
    the binary cache is obtained only from the separately leased verified
    runtime.  Ordinary startup therefore cannot silently generate a new
    fingerprint, choose a binary, or consult vendor defaults.
    ``launcher`` is private test injection; production leaves it unset and the
    adapter lazily imports the pinned wrapper.
    """

    __slots__ = (
        "_profile_handle",
        "_runtime_handle",
        "_ignore_https_errors",
        "_launcher",
    )

    def __init__(
        self,
        profile_handle: object,
        runtime_handle: object,
        *,
        ignore_https_errors: bool = False,
        launcher: Callable[..., object] | None = None,
    ) -> None:
        if not callable(getattr(profile_handle, "acquire_runtime", None)):
            raise TypeError("profile_handle must expose acquire_runtime()")
        if not callable(getattr(runtime_handle, "acquire_runtime", None)):
            raise TypeError("runtime_handle must expose acquire_runtime()")
        self._profile_handle = profile_handle
        self._runtime_handle = runtime_handle
        if type(ignore_https_errors) is not bool:
            raise TypeError("ignore_https_errors must be a bool")
        self._ignore_https_errors = ignore_https_errors
        self._launcher = _default_launcher if launcher is None else launcher

    def __call__(
        self,
        *,
        downloads_path: str,
        connection_binding: object,
    ) -> object:
        del connection_binding
        if type(downloads_path) is not str or not downloads_path:
            raise ValueError("downloads_path must be a nonblank string")
        engine = _CloakEngine(
            self._profile_handle,
            self._runtime_handle,
            ignore_https_errors=self._ignore_https_errors,
            launcher=self._launcher,
        )
        try:
            engine.start()
            return _CloakProcess(engine)
        except BaseException:
            try:
                engine.close()
            except BaseException:
                pass
            raise _runtime_error() from None


__all__ = (
    "CloakBrowserFactory",
    "CloakBrowserRuntimeAvailability",
    "CloakBrowserRuntimeError",
    "cloakbrowser_runtime_availability",
)
