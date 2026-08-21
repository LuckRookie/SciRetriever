"""Explicit visible-Chrome boundary for operator-managed profile setup.

This is deliberately separate from automatic Acquisition. It opens one blank
visible Chrome window backed by the selected persistent profile and leaves all
navigation, institution selection, login, MFA and verification to the user.
SciRetriever never inspects a page, reads storage, fills credentials, handles
CAPTCHA, or treats closing the window as proof of article entitlement.
"""

from __future__ import annotations

import os
import threading
from collections.abc import Callable
from contextlib import AbstractContextManager
from typing import Protocol, TypeAlias, cast

from sciretriever.configuration import (
    BrowserProfileHandle,
    ConfigurationError,
)


class VisibleBrowserLoginError(RuntimeError):
    """Stable, path-free failure from the visible profile-setup boundary."""

    _CODES = frozenset(
        {
            "runtime-unavailable",
            "profile-in-use",
            "launch-failed",
            "session-failed",
            "cleanup-failed",
        }
    )

    def __init__(self, code: str) -> None:
        self.code = code if code in self._CODES else "session-failed"
        super().__init__(self.code)

    def __repr__(self) -> str:
        return f"VisibleBrowserLoginError(code={self.code!r})"


class _LoginPage(Protocol):
    def wait_for_timeout(self, timeout: float) -> None: ...


class _LoginContext(Protocol):
    @property
    def pages(self) -> list[_LoginPage]: ...

    def new_page(self) -> _LoginPage: ...

    def on(self, event: str, handler: Callable[..., object]) -> object: ...

    def close(self) -> object: ...


class _LoginChromium(Protocol):
    def launch_persistent_context(
        self,
        user_data_dir: str,
        **options: object,
    ) -> _LoginContext: ...


class _LoginRuntime(Protocol):
    @property
    def chromium(self) -> _LoginChromium: ...


_RuntimeManager: TypeAlias = AbstractContextManager[_LoginRuntime]
_RuntimeFactory: TypeAlias = Callable[[], _RuntimeManager]


def _production_runtime_manager() -> _RuntimeManager:
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        raise VisibleBrowserLoginError("runtime-unavailable") from None
    return cast(_RuntimeManager, sync_playwright())


def _launch_visible_context(
    runtime: _LoginRuntime,
    profile_directory: str,
) -> _LoginContext:
    options: dict[str, object] = {
        "headless": False,
        "accept_downloads": False,
        "no_viewport": True,
        "args": ("--no-first-run", "--disable-pdf-extension"),
    }
    try:
        return runtime.chromium.launch_persistent_context(
            profile_directory,
            channel="chrome",
            **options,
        )
    except Exception:
        try:
            return runtime.chromium.launch_persistent_context(
                profile_directory,
                **options,
            )
        except Exception:
            raise VisibleBrowserLoginError("launch-failed") from None


def _remaining_pages(context: _LoginContext) -> tuple[_LoginPage, ...]:
    try:
        return tuple(context.pages)
    except Exception:
        return ()


def _wait_for_operator_close(
    context: _LoginContext,
    closed: threading.Event,
    poll_milliseconds: int,
) -> None:
    context.on("close", lambda *_arguments: closed.set())
    if not context.pages:
        context.new_page()
    while not closed.is_set():
        pages = _remaining_pages(context)
        if not pages:
            return
        try:
            pages[0].wait_for_timeout(float(poll_milliseconds))
        except Exception:
            if closed.is_set() or not _remaining_pages(context):
                return
            raise VisibleBrowserLoginError("session-failed") from None


def _close_visible_context(context: _LoginContext, closed: threading.Event) -> None:
    try:
        context.close()
    except Exception:
        if not closed.is_set():
            raise VisibleBrowserLoginError("cleanup-failed") from None


def _run_visible_runtime(
    manager: _RuntimeManager,
    profile_directory: str,
    poll_milliseconds: int,
) -> None:
    closed = threading.Event()
    try:
        with manager as runtime:
            context = _launch_visible_context(runtime, profile_directory)
            try:
                _wait_for_operator_close(context, closed, poll_milliseconds)
            finally:
                _close_visible_context(context, closed)
    except KeyboardInterrupt:
        raise
    except VisibleBrowserLoginError:
        raise
    except Exception:
        raise VisibleBrowserLoginError("session-failed") from None


def open_visible_browser_login(
    profile: BrowserProfileHandle,
    *,
    runtime_factory: _RuntimeFactory | None = None,
    poll_milliseconds: int = 250,
) -> None:
    """Open a blank visible persistent Chrome window until the user closes it."""

    if not isinstance(profile, BrowserProfileHandle):
        raise TypeError("profile must be a BrowserProfileHandle")
    if runtime_factory is not None and not callable(runtime_factory):
        raise TypeError("runtime_factory must be callable")
    if type(poll_milliseconds) is not int or poll_milliseconds < 1:
        raise ValueError("poll_milliseconds must be a positive integer")
    try:
        profile_lease = profile.acquire_runtime()
    except ConfigurationError as error:
        if str(error) == "browser profile is already in use":
            raise VisibleBrowserLoginError("profile-in-use") from None
        raise VisibleBrowserLoginError("launch-failed") from None
    factory = _production_runtime_manager if runtime_factory is None else runtime_factory
    try:
        try:
            manager = factory()
        except VisibleBrowserLoginError:
            raise
        except Exception:
            raise VisibleBrowserLoginError("launch-failed") from None
        _run_visible_runtime(
            manager,
            os.fspath(profile_lease.directory),
            poll_milliseconds,
        )
    finally:
        profile_lease.close()


__all__ = (
    "VisibleBrowserLoginError",
    "open_visible_browser_login",
)
