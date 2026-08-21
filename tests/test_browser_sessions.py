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
    BrowserSessionLease,
    BrowserSessionTimeout,
)

_EVENT_NAMES = (
    "page",
    "download",
    "response",
    "requestfinished",
    "requestfailed",
)


class _ArticleContext:
    def __init__(
        self,
        owner: _SharedContext,
        *,
        lane_key: str,
        downloads_path: str,
        connection_binding: object,
        binding_acknowledges: bool,
        end_acknowledges: bool,
    ) -> None:
        self.owner = owner
        self.lane_key = lane_key
        self.downloads_path = downloads_path
        self.connection_binding = connection_binding
        self.binding_acknowledges = binding_acknowledges
        self.end_acknowledges = end_acknowledges
        self.bindings: list[object] = []
        self.route_handler: Callable[[object], object] | None = None
        self.handlers: dict[str, Callable[[object], object]] = {}
        self.active = True
        self.end_calls = 0

    def bind_connection(self, binding: object) -> object:
        self.bindings.append(binding)
        return binding if self.binding_acknowledges else object()

    def route(self, pattern: str, handler: Callable[[object], object]) -> None:
        if pattern != "**/*" or self.route_handler is not None:
            raise AssertionError("article route must be installed exactly once")
        self.route_handler = handler

    def on(self, event: str, handler: Callable[[object], object]) -> None:
        if event not in _EVENT_NAMES or event in self.handlers:
            raise AssertionError("article handler set is closed and unique")
        self.handlers[event] = handler

    def emit_route(self, value: object) -> None:
        if self.route_handler is None:
            raise AssertionError("route handler is missing")
        self.route_handler(value)

    def emit(self, event: str, value: object) -> None:
        self.handlers[event](value)

    def end_article(self) -> bool:
        self.end_calls += 1
        if not self.active:
            return False
        self.active = False
        self.owner.active_lanes.discard(self.lane_key)
        return self.end_acknowledges


class _SharedContext:
    def __init__(
        self,
        *,
        binding_acknowledges: bool,
        article_binding_acknowledges: bool,
        end_acknowledges: bool,
        begin_returns_none: bool,
        close_error: bool,
    ) -> None:
        self.binding_acknowledges = binding_acknowledges
        self.article_binding_acknowledges = article_binding_acknowledges
        self.end_acknowledges = end_acknowledges
        self.begin_returns_none = begin_returns_none
        self.close_error = close_error
        self.bindings: list[object] = []
        self.articles: list[_ArticleContext] = []
        self.active_lanes: set[str] = set()
        self.close_calls = 0
        self.closed = False

    def bind_connection(self, binding: object) -> object:
        self.bindings.append(binding)
        return binding if self.binding_acknowledges else object()

    def begin_article(
        self,
        *,
        lane_key: str,
        downloads_path: str,
        connection_binding: object,
    ) -> _ArticleContext | None:
        if self.begin_returns_none:
            return None
        if lane_key in self.active_lanes:
            raise AssertionError("same Publisher lane overlapped")
        article = _ArticleContext(
            self,
            lane_key=lane_key,
            downloads_path=downloads_path,
            connection_binding=connection_binding,
            binding_acknowledges=self.article_binding_acknowledges,
            end_acknowledges=self.end_acknowledges,
        )
        self.active_lanes.add(lane_key)
        self.articles.append(article)
        return article

    def close(self) -> None:
        self.close_calls += 1
        self.closed = True
        if self.close_error:
            raise RuntimeError("shared context close sentinel")


class _Runtime:
    def __init__(
        self,
        *,
        runtime_acknowledges: bool,
        context_acknowledges: bool,
        article_acknowledges: bool,
        end_acknowledges: bool,
        begin_returns_none: bool,
        context_close_error: bool,
        process_close_error: bool,
    ) -> None:
        self.runtime_acknowledges = runtime_acknowledges
        self.context_acknowledges = context_acknowledges
        self.article_acknowledges = article_acknowledges
        self.end_acknowledges = end_acknowledges
        self.begin_returns_none = begin_returns_none
        self.context_close_error = context_close_error
        self.process_close_error = process_close_error
        self.context: _SharedContext | None = None
        self.bindings: list[object] = []
        self.session_path: str | None = None
        self.entered = False
        self.close_calls = 0
        self.closed = False

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
        downloads_path: str,
        accept_downloads: bool,
        connection_binding: object,
    ) -> _SharedContext:
        del connection_binding
        if not accept_downloads or self.context is not None:
            raise AssertionError("one shared context must be created exactly once")
        self.session_path = downloads_path
        self.context = _SharedContext(
            binding_acknowledges=self.context_acknowledges,
            article_binding_acknowledges=self.article_acknowledges,
            end_acknowledges=self.end_acknowledges,
            begin_returns_none=self.begin_returns_none,
            close_error=self.context_close_error,
        )
        return self.context

    def close(self) -> None:
        self.close_calls += 1
        self.closed = True
        if self.process_close_error:
            raise RuntimeError("process close sentinel")


class _Factory:
    def __init__(
        self,
        *,
        runtime_acknowledges: bool = True,
        context_acknowledges: bool = True,
        article_acknowledges: bool = True,
        end_acknowledges: bool = True,
        begin_returns_none: bool = False,
        context_close_error: bool = False,
        process_close_error: bool = False,
    ) -> None:
        self.runtime_acknowledges = runtime_acknowledges
        self.context_acknowledges = context_acknowledges
        self.article_acknowledges = article_acknowledges
        self.end_acknowledges = end_acknowledges
        self.begin_returns_none = begin_returns_none
        self.context_close_error = context_close_error
        self.process_close_error = process_close_error
        self.processes: list[_Runtime] = []
        self.session_paths: list[str] = []

    def __call__(
        self,
        *,
        downloads_path: str,
        connection_binding: object,
    ) -> _Runtime:
        del connection_binding
        runtime = _Runtime(
            runtime_acknowledges=self.runtime_acknowledges,
            context_acknowledges=self.context_acknowledges,
            article_acknowledges=self.article_acknowledges,
            end_acknowledges=self.end_acknowledges,
            begin_returns_none=self.begin_returns_none,
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
    return routes.append


class BrowserSessionBrokerTests(unittest.TestCase):
    def setUp(self) -> None:
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
        binding: object | None = None,
        routes: list[object] | None = None,
        events: list[tuple[str, object]] | None = None,
        timeout: float = 1.0,
        cancel_event: threading.Event | None = None,
        downloads_path: str | None = None,
    ) -> BrowserSessionLease:
        route_values = [] if routes is None else routes
        event_values = [] if events is None else events
        return self.broker.acquire(
            session_key,
            factory=self.factory if factory is None else factory,
            downloads_path=self.temporary.name if downloads_path is None else downloads_path,
            connection_binding=self.binding if binding is None else binding,
            route_handler=_route_handler(route_values),
            event_handlers=_event_handlers(event_values),
            cancel_event=cancel_event,
            timeout=timeout,
        )

    @staticmethod
    def _context(factory: _Factory) -> _SharedContext:
        runtime = factory.processes[0]
        if runtime.context is None:
            raise AssertionError("shared context is missing")
        return runtime.context

    def test_distinct_publishers_share_one_process_and_isolate_article_handlers(self) -> None:
        first_routes: list[object] = []
        first_events: list[tuple[str, object]] = []
        second_routes: list[object] = []
        second_events: list[tuple[str, object]] = []
        first_directory = tempfile.TemporaryDirectory(prefix="sciretriever-browser-article-")
        second_directory = tempfile.TemporaryDirectory(prefix="sciretriever-browser-article-")
        self.addCleanup(first_directory.cleanup)
        self.addCleanup(second_directory.cleanup)

        first = self._acquire(
            "publisher-one",
            routes=first_routes,
            events=first_events,
            downloads_path=first_directory.name,
        )
        second_binding = object()
        second = self._acquire(
            "publisher-two",
            binding=second_binding,
            routes=second_routes,
            events=second_events,
            downloads_path=second_directory.name,
        )

        self.assertEqual(len(self.factory.processes), 1)
        self.assertIs(first.process_runtime, second.process_runtime)
        self.assertIsNot(first.context, second.context)
        shared = self._context(self.factory)
        self.assertEqual(shared.active_lanes, {"publisher-one", "publisher-two"})
        self.assertEqual(
            [article.downloads_path for article in shared.articles],
            [first_directory.name, second_directory.name],
        )
        self.assertEqual(
            [article.connection_binding for article in shared.articles],
            [self.binding, second_binding],
        )

        first_article = shared.articles[0]
        second_article = shared.articles[1]
        first_route, second_route = object(), object()
        first_page, second_page = object(), object()
        first_article.emit_route(first_route)
        second_article.emit_route(second_route)
        first_article.emit("page", first_page)
        second_article.emit("page", second_page)
        self.assertEqual(first_routes, [first_route])
        self.assertEqual(second_routes, [second_route])
        self.assertEqual(first_events, [("page", first_page)])
        self.assertEqual(second_events, [("page", second_page)])

        first.release()
        self.assertFalse(first_article.active)
        self.assertTrue(second_article.active)
        self.assertFalse(self.factory.processes[0].closed)
        second.release()
        self.assertFalse(second_article.active)

        runtime_path = Path(self.factory.session_paths[0])
        self.assertTrue(runtime_path.is_dir())
        self.assertEqual(stat.S_IMODE(runtime_path.stat().st_mode), stat.S_IRWXU)
        self.broker.close()
        self.assertFalse(runtime_path.exists())
        self.assertEqual(shared.close_calls, 1)
        self.assertEqual(self.factory.processes[0].close_calls, 1)

    def test_same_publisher_waits_while_different_publishers_do_not(self) -> None:
        first = self._acquire("publisher-one")
        second = self._acquire("publisher-two")
        acquired = threading.Event()
        failures: list[BaseException] = []
        leases: list[BrowserSessionLease] = []

        def acquire_same() -> None:
            try:
                leases.append(self._acquire("publisher-one"))
                acquired.set()
            except BaseException as error:
                failures.append(error)

        worker = threading.Thread(target=acquire_same, daemon=True)
        worker.start()
        self.assertFalse(acquired.wait(0.05))
        second.release()
        self.assertFalse(acquired.wait(0.05))
        first.release()
        self.assertTrue(acquired.wait(1.0))
        worker.join(1.0)
        self.assertEqual(failures, [])
        self.assertEqual(len(self.factory.processes), 1)
        leases[0].release()

    def test_lane_timeout_and_cancellation_have_no_runtime_side_effect(self) -> None:
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
        first.release()

    def test_invalidation_waits_for_other_publisher_before_retiring_shared_runtime(self) -> None:
        first = self._acquire("publisher-one")
        second = self._acquire("publisher-two")
        runtime = self.factory.processes[0]

        first.invalidate()
        first.release()
        self.assertFalse(runtime.closed)
        self.assertTrue(cast_article(second.context).active)

        second.release()
        self.assertTrue(runtime.closed)
        self.assertEqual(runtime.close_calls, 1)

        third = self._acquire("publisher-three")
        self.assertEqual(len(self.factory.processes), 2)
        third.release()

    def test_factory_identity_change_fails_closed_then_accepts_reassembled_factory(self) -> None:
        first = self._acquire()
        runtime = self.factory.processes[0]
        first.release()
        replacement = _Factory()

        with self.assertRaises(BrowserSessionError):
            self._acquire(factory=replacement)
        self.assertTrue(runtime.closed)

        second = self._acquire(factory=replacement)
        self.assertEqual(len(replacement.processes), 1)
        second.release()

    def test_runtime_context_and_article_binding_acknowledgements_are_mandatory(self) -> None:
        factories = (
            _Factory(runtime_acknowledges=False),
            _Factory(context_acknowledges=False),
            _Factory(article_acknowledges=False),
            _Factory(begin_returns_none=True),
        )
        for factory in factories:
            with self.subTest(factory=factory), self.assertRaises(BrowserSessionError):
                self._acquire(factory=factory)
            self.assertEqual(len(factory.processes), 1)
            self.assertTrue(factory.processes[0].closed)

    def test_article_drain_failure_retires_runtime(self) -> None:
        failing = _Factory(end_acknowledges=False)
        lease = self._acquire(factory=failing)

        with self.assertRaisesRegex(BrowserSessionError, "cleanup failed"):
            lease.release()
        self.assertTrue(failing.processes[0].closed)
        self.assertEqual(self._context(failing).articles[0].end_calls, 1)

    def test_explicit_drain_is_idempotent_before_release(self) -> None:
        lease = self._acquire()
        article = cast_article(lease.context)

        lease.drain_article()
        lease.drain_article()
        lease.release()

        self.assertEqual(article.end_calls, 1)

    def test_close_waits_for_active_lanes_and_is_idempotent(self) -> None:
        first = self._acquire("publisher-one")
        second = self._acquire("publisher-two")
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
        first.release()
        self.assertFalse(closed.wait(0.05))
        second.release()
        self.assertTrue(closed.wait(1.0))
        worker.join(1.0)
        self.assertEqual(failures, [])
        self.broker.close()
        self.assertEqual(self.factory.processes[0].close_calls, 1)

    def test_cleanup_failures_are_stable_path_free_and_idempotent(self) -> None:
        failing = _Factory(context_close_error=True, process_close_error=True)
        lease = self._acquire(factory=failing)
        lease.invalidate()
        with self.assertRaisesRegex(BrowserSessionError, "cleanup failed") as caught:
            lease.release()
        self.assertNotIn(self.temporary.name, str(caught.exception))
        self.assertNotIn(self.temporary.name, repr(lease))
        context = self._context(failing)
        self.assertEqual(context.close_calls, 1)
        self.assertEqual(failing.processes[0].close_calls, 1)
        with self.assertRaisesRegex(BrowserSessionError, "cleanup failed"):
            lease.release()
        self.assertEqual(context.close_calls, 1)
        self.assertEqual(failing.processes[0].close_calls, 1)
        with self.assertRaisesRegex(BrowserSessionError, "cleanup failed"):
            self.broker.close()

    def test_debug_logging_reports_shared_reuse_and_lane_lifecycle_without_paths(self) -> None:
        with self.assertLogs("sciretriever.network.browser_sessions", level="DEBUG") as captured:
            first = self._acquire("publisher-one")
            first.release()
            second = self._acquire("publisher-two")
            second.release()
            self.broker.close()

        output = "\n".join(captured.output)
        self.assertIn("event=browser-session-acquire-started", output)
        self.assertIn("session_key=publisher-one", output)
        self.assertIn("session_reused=false disposition=acquired", output)
        self.assertIn("session_reused=true disposition=acquired", output)
        self.assertIn("event=browser-session-released", output)
        self.assertIn("event=browser-session-broker-cleanup-finished", output)
        self.assertNotIn(self.temporary.name, output)

    def test_key_and_input_validation_precedes_runtime_creation(self) -> None:
        for value in ("publisher-token", "https://publisher.test", "", "random_secret"):
            with self.subTest(value=value), self.assertRaises((TypeError, ValueError)):
                BrowserSessionBroker.validate_session_key(value)
        with self.assertRaises(TypeError):
            self.broker.acquire(
                "publisher-one",
                factory=self.factory,
                downloads_path=self.temporary.name,
                connection_binding=self.binding,
                route_handler=lambda _value: None,
                event_handlers={},
                timeout=1.0,
            )
        self.assertEqual(self.factory.processes, [])


def cast_article(value: object) -> _ArticleContext:
    if not isinstance(value, _ArticleContext):
        raise AssertionError("article context has the wrong fixture type")
    return value


if __name__ == "__main__":
    unittest.main()
