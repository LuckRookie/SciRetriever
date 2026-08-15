from __future__ import annotations

import stat
import tempfile
import threading
import time
import unittest
from collections.abc import Callable, Mapping
from pathlib import Path

from sciretriever.network.browser_sessions import (
    BrowserSessionBroker,
    BrowserSessionCancelled,
    BrowserSessionError,
    BrowserSessionTimeout,
)

_EVENT_NAMES = (
    "page",
    "download",
    "response",
    "requestfinished",
    "requestfailed",
)


class _Route:
    def __init__(self) -> None:
        self.aborted = False

    def abort(self) -> None:
        self.aborted = True


class _Page:
    def __init__(self, *, close_error: bool = False) -> None:
        self.closed = False
        self.close_error = close_error
        self.close_calls = 0

    def close(self) -> None:
        self.close_calls += 1
        self.closed = True
        if self.close_error:
            raise RuntimeError("late page close sentinel")


class _Download:
    def __init__(self, *, delete_error: bool = False) -> None:
        self.deleted = False
        self.delete_error = delete_error
        self.delete_calls = 0

    def delete(self) -> None:
        self.delete_calls += 1
        self.deleted = True
        if self.delete_error:
            raise RuntimeError("late download delete sentinel")


class _Context:
    def __init__(
        self,
        *,
        begin_acknowledges: bool,
        end_acknowledges: bool,
        binding_acknowledges: bool,
        close_error: bool,
    ) -> None:
        self.begin_acknowledges = begin_acknowledges
        self.end_acknowledges = end_acknowledges
        self.binding_acknowledges = binding_acknowledges
        self.close_error = close_error
        self.route_handler: Callable[[object], object] | None = None
        self.handlers: dict[str, Callable[[object], object]] = {}
        self.bindings: list[object] = []
        self.article_paths: list[str] = []
        self.article_bindings: list[object] = []
        self.active = False
        self.closed = False
        self.close_calls = 0

    def bind_connection(self, binding: object) -> object:
        self.bindings.append(binding)
        return binding if self.binding_acknowledges else object()

    def route(self, pattern: str, handler: Callable[[object], object]) -> None:
        if pattern != "**/*" or self.route_handler is not None:
            raise AssertionError("session route dispatcher must be installed exactly once")
        self.route_handler = handler

    def on(self, event: str, handler: Callable[[object], object]) -> None:
        if event not in _EVENT_NAMES or event in self.handlers:
            raise AssertionError("session event dispatcher must be closed and unique")
        self.handlers[event] = handler

    def begin_article(self, *, downloads_path: str, connection_binding: object) -> object:
        if self.active:
            raise RuntimeError("overlapping article sentinel")
        self.active = True
        self.article_paths.append(downloads_path)
        self.article_bindings.append(connection_binding)
        return connection_binding if self.begin_acknowledges else object()

    def end_article(self) -> bool:
        if not self.active:
            raise RuntimeError("article was not active")
        self.active = False
        return self.end_acknowledges

    def close(self) -> None:
        self.close_calls += 1
        self.closed = True
        if self.close_error:
            raise RuntimeError("context close sentinel")


class _Runtime:
    def __init__(
        self,
        *,
        begin_acknowledges: bool,
        end_acknowledges: bool,
        runtime_acknowledges: bool,
        context_acknowledges: bool,
        context_close_error: bool,
        process_close_error: bool,
    ) -> None:
        self.begin_acknowledges = begin_acknowledges
        self.end_acknowledges = end_acknowledges
        self.runtime_acknowledges = runtime_acknowledges
        self.context_acknowledges = context_acknowledges
        self.context_close_error = context_close_error
        self.process_close_error = process_close_error
        self.context: _Context | None = None
        self.bindings: list[object] = []
        self.profile: object | None = None
        self.session_path: str | None = None
        self.entered = False
        self.closed = False
        self.close_calls = 0

    def __enter__(self) -> _Runtime:
        self.entered = True
        return self

    def __exit__(self, exc_type: object, exc: object, traceback: object) -> bool:
        del exc_type, exc, traceback
        self.close()
        return False

    def bind_connection(self, binding: object) -> object:
        self.bindings.append(binding)
        return binding if self.runtime_acknowledges else object()

    def new_context(
        self,
        *,
        profile: object | None,
        downloads_path: str,
        accept_downloads: bool,
        connection_binding: object,
    ) -> _Context:
        if not accept_downloads or self.context is not None:
            raise AssertionError("persistent context must be created exactly once")
        self.profile = profile
        self.session_path = downloads_path
        context = _Context(
            begin_acknowledges=self.begin_acknowledges,
            end_acknowledges=self.end_acknowledges,
            binding_acknowledges=self.context_acknowledges,
            close_error=self.context_close_error,
        )
        self.context = context
        del connection_binding
        return context

    def close(self) -> None:
        self.close_calls += 1
        self.closed = True
        if self.process_close_error:
            raise RuntimeError("process close sentinel")


class _Factory:
    def __init__(
        self,
        *,
        begin_acknowledges: bool = True,
        end_acknowledges: bool = True,
        runtime_acknowledges: bool = True,
        context_acknowledges: bool = True,
        context_close_error: bool = False,
        process_close_error: bool = False,
    ) -> None:
        self.begin_acknowledges = begin_acknowledges
        self.end_acknowledges = end_acknowledges
        self.runtime_acknowledges = runtime_acknowledges
        self.context_acknowledges = context_acknowledges
        self.context_close_error = context_close_error
        self.process_close_error = process_close_error
        self.processes: list[_Runtime] = []
        self.session_paths: list[str] = []

    def __call__(
        self,
        *,
        profile: object | None,
        downloads_path: str,
        connection_binding: object,
    ) -> _Runtime:
        del profile, connection_binding
        runtime = _Runtime(
            begin_acknowledges=self.begin_acknowledges,
            end_acknowledges=self.end_acknowledges,
            runtime_acknowledges=self.runtime_acknowledges,
            context_acknowledges=self.context_acknowledges,
            context_close_error=self.context_close_error,
            process_close_error=self.process_close_error,
        )
        self.processes.append(runtime)
        self.session_paths.append(downloads_path)
        return runtime


def _event_handlers(events: list[tuple[str, object]]) -> Mapping[str, Callable[[object], object]]:
    def handler(event: str) -> Callable[[object], object]:
        def record(value: object) -> None:
            events.append((event, value))

        return record

    return {event: handler(event) for event in _EVENT_NAMES}


def _route_handler(routes: list[object]) -> Callable[[object], object]:
    def record(value: object) -> None:
        routes.append(value)

    return record


class BrowserSessionBrokerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.profile = object()
        self.binding = object()
        self.factory = _Factory()
        self.broker = BrowserSessionBroker()
        self.temporary = tempfile.TemporaryDirectory(prefix="sciretriever-browser-test-")
        self.addCleanup(self.temporary.cleanup)
        self.addCleanup(self._close_broker)

    def _close_broker(self) -> None:
        try:
            self.broker.close()
        except BrowserSessionError:
            pass

    def _acquire(
        self,
        session_key: str = "fixture-publisher",
        *,
        factory: _Factory | None = None,
        profile: object | None = None,
        timeout: float = 1.0,
        cancel_event: threading.Event | None = None,
    ) -> object:
        return self.broker.acquire(
            session_key,
            factory=self.factory if factory is None else factory,
            profile=self.profile if profile is None else profile,
            downloads_path=self.temporary.name,
            connection_binding=self.binding,
            route_handler=_route_handler([]),
            event_handlers=_event_handlers([]),
            cancel_event=cancel_event,
            timeout=timeout,
        )

    def test_reuses_one_context_with_distinct_article_directories(self) -> None:
        first_directory = tempfile.TemporaryDirectory(prefix="sciretriever-browser-article-")
        second_directory = tempfile.TemporaryDirectory(prefix="sciretriever-browser-article-")
        self.addCleanup(first_directory.cleanup)
        self.addCleanup(second_directory.cleanup)
        first = self.broker.acquire(
            "fixture-publisher",
            factory=self.factory,
            profile=self.profile,
            downloads_path=first_directory.name,
            connection_binding=self.binding,
            route_handler=_route_handler([]),
            event_handlers=_event_handlers([]),
            timeout=1.0,
        )
        first_context = first.context
        first_runtime = first.process_runtime
        first.release()
        second_binding = object()
        second = self.broker.acquire(
            "fixture-publisher",
            factory=self.factory,
            profile=self.profile,
            downloads_path=second_directory.name,
            connection_binding=second_binding,
            route_handler=_route_handler([]),
            event_handlers=_event_handlers([]),
            timeout=1.0,
        )

        self.assertIs(second.context, first_context)
        self.assertIs(second.process_runtime, first_runtime)
        self.assertEqual(len(self.factory.processes), 1)
        context = self.factory.processes[0].context
        self.assertIsNotNone(context)
        assert context is not None
        self.assertEqual(
            context.article_paths,
            [first_directory.name, second_directory.name],
        )
        self.assertEqual(context.article_bindings, [self.binding, second_binding])
        self.assertTrue(context.active)
        second.release()
        self.assertFalse(context.active)

        session_path = Path(self.factory.session_paths[0])
        self.assertTrue(session_path.is_dir())
        self.assertEqual(stat.S_IMODE(session_path.stat().st_mode), stat.S_IRWXU)
        self.broker.close()
        self.assertFalse(session_path.exists())
        self.assertTrue(context.closed)
        self.assertTrue(self.factory.processes[0].closed)

    def test_same_key_waits_for_the_active_article_lease(self) -> None:
        first = self._acquire()
        acquired = threading.Event()
        failures: list[BaseException] = []
        second_leases: list[object] = []

        def acquire_second() -> None:
            try:
                second_leases.append(self._acquire())
                acquired.set()
            except BaseException as error:
                failures.append(error)

        worker = threading.Thread(target=acquire_second, daemon=True)
        worker.start()
        self.assertFalse(acquired.wait(0.05))
        getattr(first, "release")()
        self.assertTrue(acquired.wait(1.0))
        worker.join(1.0)
        self.assertFalse(worker.is_alive())
        self.assertEqual(failures, [])
        self.assertEqual(len(second_leases), 1)
        getattr(second_leases[0], "release")()
        self.assertEqual(len(self.factory.processes), 1)

    def test_different_session_keys_can_hold_leases_concurrently(self) -> None:
        first = self._acquire("publisher-one")
        second = self._acquire("publisher-two")

        self.assertEqual(len(self.factory.processes), 2)
        self.assertTrue(all(process.context is not None for process in self.factory.processes))
        getattr(second, "release")()
        getattr(first, "release")()

    def test_invalidation_closes_and_recreates_the_session(self) -> None:
        first = self._acquire()
        first_runtime = getattr(first, "process_runtime")
        getattr(first, "invalidate")()
        getattr(first, "release")()
        self.assertTrue(first_runtime.closed)

        second = self._acquire()
        self.assertIsNot(getattr(second, "process_runtime"), first_runtime)
        self.assertEqual(len(self.factory.processes), 2)
        getattr(second, "release")()

    def test_factory_or_profile_identity_change_fails_closed(self) -> None:
        first = self._acquire()
        first_runtime = getattr(first, "process_runtime")
        getattr(first, "release")()
        replacement = _Factory()

        with self.assertRaises(BrowserSessionError):
            self._acquire(factory=replacement)

        self.assertTrue(first_runtime.closed)
        second = self._acquire(factory=replacement)
        self.assertEqual(len(replacement.processes), 1)
        getattr(second, "release")()

        with self.assertRaises(BrowserSessionError):
            self._acquire(factory=replacement, profile=object())

    def test_connection_binding_acknowledgement_is_mandatory(self) -> None:
        for factory in (
            _Factory(runtime_acknowledges=False),
            _Factory(context_acknowledges=False),
        ):
            with self.subTest(factory=factory):
                with self.assertRaises(BrowserSessionError):
                    self._acquire(factory=factory)
                self.assertEqual(len(factory.processes), 1)
                self.assertTrue(factory.processes[0].closed)
                if factory.processes[0].context is not None:
                    self.assertTrue(factory.processes[0].context.closed)

    def test_article_begin_and_drain_acknowledgements_are_mandatory(self) -> None:
        begin_failure = _Factory(begin_acknowledges=False)
        with self.assertRaises(BrowserSessionError):
            self._acquire(factory=begin_failure)
        self.assertTrue(begin_failure.processes[0].closed)

        drain_failure = _Factory(end_acknowledges=False)
        lease = self._acquire(factory=drain_failure)
        with self.assertRaises(BrowserSessionError):
            getattr(lease, "release")()
        self.assertTrue(drain_failure.processes[0].closed)

    def test_inactive_dispatchers_reject_late_vendor_objects(self) -> None:
        routes: list[object] = []
        events: list[tuple[str, object]] = []
        lease = self.broker.acquire(
            "fixture-publisher",
            factory=self.factory,
            profile=self.profile,
            downloads_path=self.temporary.name,
            connection_binding=self.binding,
            route_handler=_route_handler(routes),
            event_handlers=_event_handlers(events),
            timeout=1.0,
        )
        context = self.factory.processes[0].context
        self.assertIsNotNone(context)
        assert context is not None
        route = _Route()
        assert context.route_handler is not None
        context.route_handler(route)
        page = _Page()
        context.handlers["page"](page)
        self.assertEqual(routes, [route])
        self.assertEqual(events, [("page", page)])
        lease.release()

        late_route = _Route()
        late_page = _Page()
        late_download = _Download()
        context.route_handler(late_route)
        context.handlers["page"](late_page)
        context.handlers["download"](late_download)
        context.handlers["response"](object())

        self.assertTrue(late_route.aborted)
        self.assertTrue(late_page.closed)
        self.assertTrue(late_download.deleted)
        self.assertEqual(events, [("page", page)])

    def test_late_cleanup_failure_retires_session_without_acquire_spin(self) -> None:
        lease = self._acquire()
        context = self.factory.processes[0].context
        self.assertIsNotNone(context)
        assert context is not None
        getattr(lease, "release")()
        late_page = _Page(close_error=True)
        late_download = _Download(delete_error=True)

        context.handlers["page"](late_page)
        context.handlers["download"](late_download)

        with self.assertRaisesRegex(BrowserSessionError, "cleanup failed"):
            self._acquire(timeout=0.2)
        self.assertEqual(late_page.close_calls, 1)
        self.assertEqual(late_download.delete_calls, 1)
        self.assertTrue(context.closed)
        self.assertTrue(self.factory.processes[0].closed)

    def test_close_waits_for_active_lease_and_is_idempotent(self) -> None:
        lease = self._acquire()
        closed = threading.Event()
        failures: list[BaseException] = []

        def close() -> None:
            try:
                self.broker.close()
                closed.set()
            except BaseException as error:
                failures.append(error)

        worker = threading.Thread(target=close, daemon=True)
        worker.start()
        self.assertFalse(closed.wait(0.05))
        getattr(lease, "release")()
        self.assertTrue(closed.wait(1.0))
        worker.join(1.0)
        self.assertEqual(failures, [])
        self.broker.close()

    def test_cancellation_timeout_and_key_validation_have_no_side_effects(self) -> None:
        cancelled = threading.Event()
        cancelled.set()
        with self.assertRaises(BrowserSessionCancelled):
            self._acquire(cancel_event=cancelled)
        self.assertEqual(self.factory.processes, [])

        first = self._acquire()
        started = time.monotonic()
        with self.assertRaises(BrowserSessionTimeout):
            self._acquire(timeout=0.02)
        self.assertGreaterEqual(time.monotonic() - started, 0.015)
        getattr(first, "release")()

        for value in ("publisher-token", "https://publisher.test", "", "random_secret"):
            with self.subTest(value=value):
                with self.assertRaises((TypeError, ValueError)):
                    BrowserSessionBroker.validate_session_key(value)

    def test_cleanup_failures_are_stable_and_do_not_expose_profile(self) -> None:
        marker = "runtime-secret-value"
        profile = type("Profile", (), {"__repr__": lambda self: marker})()
        failing = _Factory(context_close_error=True, process_close_error=True)
        lease = self._acquire(factory=failing, profile=profile)
        self.assertNotIn(marker, repr(self.broker))
        self.assertNotIn(marker, repr(lease))
        getattr(lease, "invalidate")()
        with self.assertRaisesRegex(BrowserSessionError, "cleanup failed") as caught:
            getattr(lease, "release")()
        self.assertNotIn(marker, str(caught.exception))
        self.assertTrue(failing.processes[0].closed)
        context = failing.processes[0].context
        self.assertIsNotNone(context)
        assert context is not None
        self.assertEqual(context.close_calls, 1)
        self.assertEqual(failing.processes[0].close_calls, 1)
        with self.assertRaisesRegex(BrowserSessionError, "cleanup failed"):
            getattr(lease, "release")()
        self.assertEqual(context.close_calls, 1)
        self.assertEqual(failing.processes[0].close_calls, 1)
        with self.assertRaisesRegex(BrowserSessionError, "cleanup failed"):
            self.broker.close()


if __name__ == "__main__":
    unittest.main()
