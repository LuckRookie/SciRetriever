from __future__ import annotations

import os
import tempfile
import unittest
from collections.abc import Callable
from contextlib import AbstractContextManager
from pathlib import Path
from types import TracebackType
from typing import Any, cast

from sciretriever.configuration import credential_path, initialize_browser_profile
from sciretriever.entry.cli.browser_login import (
    VisibleBrowserLoginError,
    open_visible_browser_login,
)


class _Context:
    def __init__(self, *, failure: BaseException | None = None) -> None:
        self._handler: Callable[..., object] | None = None
        self._pages: list[_Page] = []
        self.close_calls = 0
        self.closed = False
        self.failure = failure
        self.new_page_calls = 0

    @property
    def pages(self) -> list[_Page]:
        return list(self._pages)

    def new_page(self) -> _Page:
        self.new_page_calls += 1
        page = _Page(self)
        self._pages.append(page)
        return page

    def on(self, event: str, handler: Callable[..., object]) -> object:
        if event != "close":
            raise AssertionError("only the close event is permitted")
        self._handler = handler
        return None

    def operator_close(self) -> None:
        self.closed = True
        self._pages.clear()
        if self._handler is not None:
            self._handler(self)

    def close(self) -> object:
        self.close_calls += 1
        if not self.closed:
            self.operator_close()
        return None


class _Page:
    def __init__(self, context: _Context) -> None:
        self.context = context
        self.waits: list[float] = []

    def wait_for_timeout(self, timeout: float) -> None:
        self.waits.append(timeout)
        failure = self.context.failure
        if failure is not None:
            raise failure
        self.context.operator_close()


class _Chromium:
    def __init__(self, context: _Context, *, launch_failure: bool = False) -> None:
        self.context = context
        self.launch_failure = launch_failure
        self.calls: list[tuple[str, dict[str, object]]] = []

    def launch_persistent_context(
        self,
        user_data_dir: str,
        *,
        headless: bool,
        accept_downloads: bool,
        no_viewport: bool,
    ) -> _Context:
        self.calls.append(
            (
                user_data_dir,
                {
                    "headless": headless,
                    "accept_downloads": accept_downloads,
                    "no_viewport": no_viewport,
                },
            )
        )
        if self.launch_failure:
            raise RuntimeError("private launch detail")
        return self.context


class _Runtime:
    def __init__(self, chromium: _Chromium) -> None:
        self.chromium = chromium


class _Manager(AbstractContextManager[_Runtime]):
    def __init__(self, runtime: _Runtime) -> None:
        self.runtime = runtime
        self.entered = False
        self.exited = False

    def __enter__(self) -> _Runtime:
        self.entered = True
        return self.runtime

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc_value: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        del exc_type, exc_value, traceback
        self.exited = True


class VisibleBrowserLoginTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="sciretriever-login-test-")
        self.addCleanup(self.temporary.cleanup)
        self.home = Path(self.temporary.name)
        self.handle = initialize_browser_profile("institutional-access", home=self.home)

    def _runtime(
        self,
        *,
        failure: BaseException | None = None,
        launch_failure: bool = False,
    ) -> tuple[_Context, _Chromium, _Manager, Callable[[], Any]]:
        context = _Context(failure=failure)
        chromium = _Chromium(context, launch_failure=launch_failure)
        manager = _Manager(_Runtime(chromium))
        factory = cast(Callable[[], Any], lambda: manager)
        return context, chromium, manager, factory

    def test_visible_session_is_blank_operator_controlled_and_profile_backed(self) -> None:
        context, chromium, manager, factory = self._runtime()

        open_visible_browser_login(
            self.handle,
            runtime_factory=factory,
            poll_milliseconds=1,
        )

        self.assertTrue(manager.entered)
        self.assertTrue(manager.exited)
        self.assertEqual(context.new_page_calls, 1)
        self.assertEqual(context.close_calls, 1)
        self.assertTrue(context.closed)
        self.assertEqual(len(chromium.calls), 1)
        profile_path, options = chromium.calls[0]
        self.assertEqual(profile_path, os.fspath(self.handle.runtime_directory()))
        self.assertEqual(
            options,
            {"headless": False, "accept_downloads": False, "no_viewport": True},
        )
        self.assertFalse(credential_path(home=self.home).exists())

    def test_launch_and_session_failures_are_stable_and_path_free(self) -> None:
        cases = (
            (self._runtime(launch_failure=True), "launch-failed"),
            (self._runtime(failure=RuntimeError("private page detail")), "session-failed"),
        )
        for (context, _chromium, manager, factory), code in cases:
            with self.subTest(code=code), self.assertRaises(VisibleBrowserLoginError) as caught:
                open_visible_browser_login(
                    self.handle,
                    runtime_factory=factory,
                    poll_milliseconds=1,
                )
            self.assertEqual(caught.exception.code, code)
            rendered = repr(caught.exception)
            self.assertNotIn(os.fspath(self.home), rendered)
            self.assertNotIn("institutional-access", rendered)
            self.assertTrue(manager.exited)
            if code == "session-failed":
                self.assertEqual(context.close_calls, 1)

    def test_keyboard_cancellation_closes_runtime_and_propagates(self) -> None:
        context, _chromium, manager, factory = self._runtime(failure=KeyboardInterrupt())

        with self.assertRaises(KeyboardInterrupt):
            open_visible_browser_login(
                self.handle,
                runtime_factory=factory,
                poll_milliseconds=1,
            )

        self.assertEqual(context.close_calls, 1)
        self.assertTrue(manager.exited)

    def test_invalid_dependencies_are_rejected_before_runtime_launch(self) -> None:
        with self.assertRaises(TypeError):
            open_visible_browser_login(cast(Any, object()))
        with self.assertRaises(TypeError):
            open_visible_browser_login(
                self.handle,
                runtime_factory=cast(Any, object()),
            )
        with self.assertRaises(ValueError):
            open_visible_browser_login(self.handle, poll_milliseconds=0)


if __name__ == "__main__":
    unittest.main()
