"""Explicit visible-Browser boundary for operator-managed login sessions.

This module is deliberately separate from automatic Acquisition.  It opens an
empty visible Chromium window backed by an already validated local profile,
then gives all navigation and authentication decisions to the operator.  The
program does not navigate, inspect pages, enumerate storage, fill fields, or
claim that closing the window proved authentication or article entitlement.
"""

from __future__ import annotations

import os
import threading
from collections.abc import Callable
from contextlib import AbstractContextManager
from typing import Protocol, TypeAlias, cast

from sciretriever.configuration import BrowserProfileHandle


class VisibleBrowserLoginError(RuntimeError):
    """Stable, path-free failure from the explicit Browser login boundary."""

    _CODES = frozenset(
        {
            "runtime-unavailable",
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
        *,
        headless: bool,
        accept_downloads: bool,
        no_viewport: bool,
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
    try:
        return runtime.chromium.launch_persistent_context(
            profile_directory,
            headless=False,
            accept_downloads=False,
            no_viewport=True,
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
    """Open one visible persistent context until the operator closes it.

    The Browser starts at its own blank page.  No URL, credentials, Cookie,
    storage state, or page object crosses this boundary.  ``runtime_factory``
    is an offline-test seam; production always uses the locked Playwright
    dependency.
    """

    if not isinstance(profile, BrowserProfileHandle):
        raise TypeError("profile must be a BrowserProfileHandle")
    if runtime_factory is not None and not callable(runtime_factory):
        raise TypeError("runtime_factory must be callable")
    if type(poll_milliseconds) is not int or poll_milliseconds < 1:
        raise ValueError("poll_milliseconds must be a positive integer")
    profile_directory = os.fspath(profile.runtime_directory())
    factory = _production_runtime_manager if runtime_factory is None else runtime_factory
    try:
        manager = factory()
    except VisibleBrowserLoginError:
        raise
    except Exception:
        raise VisibleBrowserLoginError("launch-failed") from None
    _run_visible_runtime(manager, profile_directory, poll_milliseconds)


__all__ = (
    "VisibleBrowserLoginError",
    "open_visible_browser_login",
)
