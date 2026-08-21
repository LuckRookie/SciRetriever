"""Process-local broker for one persistent Browser profile and Publisher lanes.

One broker owns at most one Chrome process and one persistent BrowserContext.
The selected profile is therefore opened only once.  A ``session_key`` names
an independent Publisher scheduling lane, not a process or a profile: one
article may hold a lane at a time, while distinct Publisher lanes may execute
concurrently inside the shared context.

Vendor objects never leave Network.  The public ``BrowserClient`` consumes one
private article-scoped context per lease; the shared context and profile path
are never exposed through results, representations, or logs.
"""

from __future__ import annotations

import os
import re
import stat
import tempfile
import threading
import time
from collections.abc import Callable, Mapping
from pathlib import Path
from typing import Final, Protocol, runtime_checkable

from sciretriever.logging.api import get_logger

_SESSION_KEY: Final[re.Pattern[str]] = re.compile(
    r"^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
    re.ASCII,
)
_SENSITIVE_MARKERS: Final[frozenset[str]] = frozenset(
    {"cookie", "credential", "password", "secret", "signature", "token"}
)
_EVENT_NAMES: Final[tuple[str, ...]] = (
    "page",
    "download",
    "response",
    "requestfinished",
    "requestfailed",
)

BrowserFactory = Callable[..., object]
RouteHandler = Callable[[object], object]
EventHandler = Callable[[object], object]
Clock = Callable[[], float]
_LOGGER = get_logger(__name__)


def _elapsed_ms(started_ns: int) -> int:
    return max(0, (time.monotonic_ns() - started_ns) // 1_000_000)


@runtime_checkable
class BrowserSessionCancellation(Protocol):
    def is_set(self) -> bool: ...


class BrowserSessionError(RuntimeError):
    """The shared Browser process or one Publisher lane failed safely."""


class BrowserSessionCancelled(BrowserSessionError):
    """A Publisher lane was cancelled before its article flow started."""


class BrowserSessionTimeout(BrowserSessionError):
    """A Publisher lane could not start before its bounded deadline."""


def _session_key(value: object) -> str:
    if type(value) is not str:
        raise TypeError("session_key must be a string")
    candidate = value.strip().casefold()
    if _SESSION_KEY.fullmatch(candidate) is None or any(
        marker in candidate.split("-") for marker in _SENSITIVE_MARKERS
    ):
        raise ValueError("session_key must be a stable non-sensitive identity")
    return candidate


def _positive_timeout(value: object) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise TypeError("timeout must be a number")
    candidate = float(value)
    if candidate <= 0.0 or candidate == float("inf") or candidate != candidate:
        raise ValueError("timeout must be finite and positive")
    return candidate


def _check_cancel(cancel_event: BrowserSessionCancellation | None) -> None:
    if cancel_event is None:
        return
    try:
        cancelled = cancel_event.is_set()
    except Exception:
        raise BrowserSessionCancelled("Browser session acquisition was interrupted") from None
    if type(cancelled) is not bool or cancelled:
        raise BrowserSessionCancelled("Browser session acquisition was interrupted")


def _callable(value: object, name: str) -> Callable[..., object]:
    candidate = getattr(value, name, None)
    if not callable(candidate):
        raise BrowserSessionError("Browser session runtime contract is unavailable")
    return candidate


def _acknowledge_binding(value: object, connection_binding: object) -> None:
    binder = _callable(value, "bind_connection")
    try:
        acknowledged = binder(connection_binding)
    except Exception:
        raise BrowserSessionError("Browser session connection binding was rejected") from None
    if acknowledged is not connection_binding:
        raise BrowserSessionError("Browser session connection binding was not acknowledged")


def _close_object(value: object | None) -> bool:
    if value is None:
        return True
    close = getattr(value, "close", None)
    if not callable(close):
        return True
    try:
        close()
    except Exception:
        return False
    return True


class _PublisherLane:
    __slots__ = ("session_key", "lease_lock", "article_context", "shared")

    def __init__(self, session_key: str) -> None:
        self.session_key = session_key
        self.lease_lock = threading.Lock()
        self.article_context: object | None = None
        self.shared: _SharedBrowser | None = None

    def acquire(
        self,
        *,
        deadline: float,
        clock: Clock,
        cancel_event: BrowserSessionCancellation | None,
    ) -> None:
        while True:
            _check_cancel(cancel_event)
            remaining = deadline - clock()
            if remaining <= 0.0:
                raise BrowserSessionTimeout("Browser session acquisition timed out")
            if self.lease_lock.acquire(timeout=min(remaining, 0.05)):
                try:
                    _check_cancel(cancel_event)
                except BaseException:
                    self.lease_lock.release()
                    raise
                return


class _SharedBrowser:
    """Exactly one process/context opening exactly one persistent profile."""

    __slots__ = (
        "factory",
        "process_manager",
        "process_runtime",
        "context",
        "entered_process",
        "runtime_directory",
        "active_leases",
        "retire_requested",
        "closed",
        "cleanup_failed",
    )

    def __init__(self, factory: BrowserFactory) -> None:
        self.factory = factory
        self.process_manager: object | None = None
        self.process_runtime: object | None = None
        self.context: object | None = None
        self.entered_process = False
        self.runtime_directory: tempfile.TemporaryDirectory[str] | None = None
        self.active_leases = 0
        self.retire_requested = False
        self.closed = False
        self.cleanup_failed = False

    def start(self, connection_binding: object) -> None:
        if self.closed or self.context is not None:
            raise BrowserSessionError("Browser session is not reusable")
        try:
            temporary = tempfile.TemporaryDirectory(prefix="sciretriever-browser-runtime-")
            self.runtime_directory = temporary
            runtime_path = Path(temporary.name)
            os.chmod(runtime_path, stat.S_IRWXU)
            manager = self.factory(
                downloads_path=os.fspath(runtime_path),
                connection_binding=connection_binding,
            )
            self.process_manager = manager
            runtime = manager
            enter = getattr(manager, "__enter__", None)
            if callable(enter):
                entered = enter()
                self.entered_process = True
                if entered is not None:
                    runtime = entered
            if runtime is None:
                raise BrowserSessionError("Browser session runtime is unavailable")
            self.process_runtime = runtime
            _acknowledge_binding(runtime, connection_binding)
            new_context = _callable(runtime, "new_context")
            context = new_context(
                downloads_path=os.fspath(runtime_path),
                accept_downloads=True,
                connection_binding=connection_binding,
            )
            if context is None:
                raise BrowserSessionError("Browser session context is unavailable")
            self.context = context
            _acknowledge_binding(context, connection_binding)
        except BrowserSessionError:
            self.retire_requested = True
            raise
        except Exception:
            self.retire_requested = True
            raise BrowserSessionError("Browser session could not be started") from None

    def close(self) -> bool:
        if self.closed:
            return not self.cleanup_failed
        self.closed = True
        failed = self.cleanup_failed
        context = self.context
        manager = self.process_manager
        runtime = self.process_runtime
        entered_process = self.entered_process
        temporary = self.runtime_directory
        self.context = None
        self.process_manager = None
        self.process_runtime = None
        self.entered_process = False
        self.runtime_directory = None
        if not _close_object(context):
            failed = True
        if manager is not None and entered_process:
            exit_method = getattr(manager, "__exit__", None)
            if callable(exit_method):
                try:
                    exit_method(None, None, None)
                except Exception:
                    failed = True
            elif not _close_object(runtime or manager):
                failed = True
        elif not _close_object(runtime or manager):
            failed = True
        if temporary is not None:
            try:
                temporary.cleanup()
            except Exception:
                failed = True
        self.cleanup_failed = failed
        return not failed


class BrowserSessionLease:
    """One article-scoped lease inside a Publisher lane."""

    __slots__ = (
        "_broker",
        "_lane",
        "_shared",
        "_drain_attempted",
        "_drain_failed",
        "_released",
        "_release_failed",
        "_invalidate",
    )

    def __init__(
        self,
        broker: BrowserSessionBroker,
        lane: _PublisherLane,
        shared: _SharedBrowser,
    ) -> None:
        self._broker = broker
        self._lane = lane
        self._shared = shared
        self._drain_attempted = False
        self._drain_failed = False
        self._released = False
        self._release_failed = False
        self._invalidate = False

    @property
    def process_runtime(self) -> object:
        value = self._shared.process_runtime
        if value is None:
            raise BrowserSessionError("Browser session runtime is unavailable")
        return value

    @property
    def context(self) -> object:
        value = self._lane.article_context
        if value is None:
            raise BrowserSessionError("Browser article context is unavailable")
        return value

    def invalidate(self) -> None:
        self._invalidate = True
        _LOGGER.debug(
            "event=browser-session-invalidated session_key=%s disposition=marked next=release",
            self._lane.session_key,
        )

    def drain_article(self) -> None:
        """Drain only this lane while keeping other Publisher lanes active."""

        if self._released:
            raise BrowserSessionError("Browser session lease is already released")
        if self._drain_attempted:
            if self._drain_failed:
                raise BrowserSessionError("Browser article session could not be drained")
            return
        started_ns = time.monotonic_ns()
        self._drain_attempted = True
        try:
            self._broker._drain_lane(self._lane, self._shared)
        except BrowserSessionError:
            self._invalidate = True
            self._drain_failed = True
            _LOGGER.debug(
                "event=browser-session-article-drain-failed session_key=%s "
                "outcome=failure elapsed_ms=%d code=browser-session-drain-failed "
                "retryable=true reason=The Browser article lane could not be drained. "
                "action=Retire the shared runtime after active Publisher lanes finish.",
                self._lane.session_key,
                _elapsed_ms(started_ns),
            )
            raise
        _LOGGER.debug(
            "event=browser-session-article-drained session_key=%s outcome=success elapsed_ms=%d",
            self._lane.session_key,
            _elapsed_ms(started_ns),
        )

    def release(self) -> None:
        if self._released:
            if self._release_failed:
                raise BrowserSessionError("Browser session cleanup failed")
            return
        try:
            self._broker._release(
                self._lane,
                self._shared,
                invalidate=self._invalidate,
                article_drain_attempted=self._drain_attempted,
            )
        except BrowserSessionError:
            self._release_failed = True
            raise
        finally:
            self._released = True

    def __enter__(self) -> BrowserSessionLease:
        return self

    def __exit__(self, exc_type: object, exc_value: object, traceback: object) -> bool:
        del exc_type, exc_value, traceback
        self.release()
        return False


class BrowserSessionBroker:
    """Own one persistent-profile runtime and isolated Publisher lane locks."""

    __slots__ = (
        "_clock",
        "_state_lock",
        "_start_lock",
        "_lanes",
        "_shared",
        "_closed",
        "_cleanup_failed",
    )

    def __init__(self, *, clock: Clock = time.monotonic) -> None:
        if not callable(clock):
            raise TypeError("clock must be callable")
        self._clock = clock
        self._state_lock = threading.Lock()
        self._start_lock = threading.Lock()
        self._lanes: dict[str, _PublisherLane] = {}
        self._shared: _SharedBrowser | None = None
        self._closed = False
        self._cleanup_failed = False

    @staticmethod
    def validate_session_key(session_key: object) -> str:
        """Validate one stable, non-sensitive Publisher lane identity."""

        return _session_key(session_key)

    def acquire(
        self,
        session_key: str,
        *,
        factory: BrowserFactory,
        downloads_path: str,
        connection_binding: object,
        route_handler: RouteHandler,
        event_handlers: Mapping[str, EventHandler],
        cancel_event: BrowserSessionCancellation | None = None,
        timeout: float,
    ) -> BrowserSessionLease:
        key, deadline = self._acquire_inputs(
            session_key,
            factory=factory,
            downloads_path=downloads_path,
            route_handler=route_handler,
            event_handlers=event_handlers,
            cancel_event=cancel_event,
            timeout=timeout,
        )
        started_ns = time.monotonic_ns()
        _LOGGER.debug(
            "event=browser-session-acquire-started session_key=%s disposition=eligible",
            key,
        )
        try:
            lease, reused = self._acquire_lease(
                key,
                deadline=deadline,
                factory=factory,
                downloads_path=downloads_path,
                connection_binding=connection_binding,
                route_handler=route_handler,
                event_handlers=event_handlers,
                cancel_event=cancel_event,
            )
        except BrowserSessionCancelled:
            self._log_acquire_failure(
                key,
                disposition="cancelled",
                code="browser-session-acquire-cancelled",
                reason="The Browser Publisher lane was cancelled before article start.",
                action="Retry the completion operation when appropriate.",
                started_ns=started_ns,
            )
            raise
        except BrowserSessionTimeout:
            self._log_acquire_failure(
                key,
                disposition="deferred",
                code="browser-session-acquire-timeout",
                reason="The Browser Publisher lane did not become available in time.",
                action="Retry after the Publisher lane becomes available.",
                started_ns=started_ns,
            )
            raise
        except BrowserSessionError:
            self._log_acquire_failure(
                key,
                disposition="failure",
                code="browser-session-acquire-failed",
                reason="The shared Browser could not start an article lane.",
                action="Review Browser runtime cleanup diagnostics before retrying.",
                started_ns=started_ns,
            )
            raise
        _LOGGER.debug(
            "event=browser-session-acquired session_key=%s session_reused=%s "
            "disposition=acquired elapsed_ms=%d",
            key,
            str(reused).lower(),
            _elapsed_ms(started_ns),
        )
        return lease

    def _acquire_lease(
        self,
        key: str,
        *,
        deadline: float,
        factory: BrowserFactory,
        downloads_path: str,
        connection_binding: object,
        route_handler: RouteHandler,
        event_handlers: Mapping[str, EventHandler],
        cancel_event: BrowserSessionCancellation | None,
    ) -> tuple[BrowserSessionLease, bool]:
        lane = self._lane(key)
        lane.acquire(deadline=deadline, clock=self._clock, cancel_event=cancel_event)
        shared: _SharedBrowser | None = None
        reserved = False
        try:
            shared, reused = self._shared_runtime(factory, connection_binding)
            with self._state_lock:
                if self._closed or self._shared is not shared or shared.retire_requested:
                    raise BrowserSessionError("Browser session broker is not reusable")
                shared.active_leases += 1
                reserved = True
                lane.shared = shared
            begin = _callable(shared.context, "begin_article")
            article_context = begin(
                lane_key=key,
                downloads_path=downloads_path,
                connection_binding=connection_binding,
            )
            if article_context is None:
                raise BrowserSessionError("Browser article context is unavailable")
            _acknowledge_binding(article_context, connection_binding)
            lane.article_context = article_context
            route = _callable(article_context, "route")
            on = _callable(article_context, "on")
            route("**/*", route_handler)
            for event in _EVENT_NAMES:
                on(event, event_handlers[event])
            return BrowserSessionLease(self, lane, shared), reused
        except (BrowserSessionCancelled, BrowserSessionTimeout):
            raise
        except Exception:
            if shared is not None:
                self._failed_lane_start(lane, shared, reserved=reserved)
            raise BrowserSessionError("Browser session acquisition failed") from None
        finally:
            if lane.article_context is None:
                lane.shared = None
                lane.lease_lock.release()

    def _shared_runtime(
        self,
        factory: BrowserFactory,
        connection_binding: object,
    ) -> tuple[_SharedBrowser, bool]:
        with self._start_lock:
            with self._state_lock:
                if self._closed:
                    raise BrowserSessionError("Browser session broker is closed")
                shared = self._shared
            if shared is not None:
                if shared.factory is factory and not shared.retire_requested and not shared.closed:
                    return shared, True
                with self._state_lock:
                    active = shared.active_leases
                    if shared.factory is not factory:
                        shared.retire_requested = True
                if active:
                    raise BrowserSessionError("Browser session identity changed after assembly")
                self._detach_and_close(shared)
                if shared.factory is not factory:
                    raise BrowserSessionError("Browser session identity changed after assembly")
            candidate = _SharedBrowser(factory)
            try:
                candidate.start(connection_binding)
            except BrowserSessionError:
                candidate.close()
                raise
            with self._state_lock:
                if self._closed:
                    candidate.retire_requested = True
                else:
                    self._shared = candidate
                    return candidate, False
            candidate.close()
            raise BrowserSessionError("Browser session broker is closed")

    def _failed_lane_start(
        self,
        lane: _PublisherLane,
        shared: _SharedBrowser,
        *,
        reserved: bool,
    ) -> None:
        article = lane.article_context
        lane.article_context = None
        if article is not None:
            end = getattr(article, "end_article", None)
            if callable(end):
                try:
                    end()
                except Exception:
                    pass
        with self._state_lock:
            shared.retire_requested = True
            if reserved:
                shared.active_leases -= 1
            retire = shared.active_leases == 0 and self._shared is shared
        if retire:
            with self._start_lock:
                self._detach_and_close(shared)

    @staticmethod
    def _log_acquire_failure(
        session_key: str,
        *,
        disposition: str,
        code: str,
        reason: str,
        action: str,
        started_ns: int,
    ) -> None:
        _LOGGER.debug(
            "event=browser-session-acquire-failed session_key=%s disposition=%s "
            "elapsed_ms=%d code=%s retryable=true reason=%s action=%s",
            session_key,
            disposition,
            _elapsed_ms(started_ns),
            code,
            reason,
            action,
        )

    def _acquire_inputs(
        self,
        session_key: str,
        *,
        factory: BrowserFactory,
        downloads_path: str,
        route_handler: RouteHandler,
        event_handlers: Mapping[str, EventHandler],
        cancel_event: BrowserSessionCancellation | None,
        timeout: float,
    ) -> tuple[str, float]:
        key = _session_key(session_key)
        if not callable(factory):
            raise TypeError("factory must be callable")
        if type(downloads_path) is not str or not downloads_path:
            raise ValueError("downloads_path must be a nonblank string")
        if not callable(route_handler):
            raise TypeError("route_handler must be callable")
        if set(event_handlers) != set(_EVENT_NAMES) or any(
            not callable(handler) for handler in event_handlers.values()
        ):
            raise TypeError("event_handlers must provide the closed Browser event set")
        if cancel_event is not None and not isinstance(cancel_event, BrowserSessionCancellation):
            raise TypeError("cancel_event must expose is_set() or be None")
        return key, self._clock() + _positive_timeout(timeout)

    def _lane(self, key: str) -> _PublisherLane:
        with self._state_lock:
            if self._closed:
                raise BrowserSessionError("Browser session broker is closed")
            lane = self._lanes.get(key)
            if lane is None:
                lane = _PublisherLane(key)
                self._lanes[key] = lane
            return lane

    def _drain_lane(self, lane: _PublisherLane, shared: _SharedBrowser) -> None:
        article = lane.article_context
        if article is None or lane.shared is not shared:
            raise BrowserSessionError("Browser article context is unavailable")
        try:
            acknowledged = _callable(article, "end_article")()
        except Exception:
            acknowledged = False
        lane.article_context = None
        if acknowledged is not True:
            with self._state_lock:
                shared.retire_requested = True
            raise BrowserSessionError("Browser article session could not be drained")

    def _release(
        self,
        lane: _PublisherLane,
        shared: _SharedBrowser,
        *,
        invalidate: bool,
        article_drain_attempted: bool,
    ) -> None:
        started_ns = time.monotonic_ns()
        failed = False
        try:
            if not article_drain_attempted:
                try:
                    self._drain_lane(lane, shared)
                except BrowserSessionError:
                    failed = True
                    invalidate = True
            with self._state_lock:
                if invalidate:
                    shared.retire_requested = True
                if shared.active_leases <= 0:
                    failed = True
                else:
                    shared.active_leases -= 1
                retire = shared.retire_requested and shared.active_leases == 0
                lane.shared = None
            if retire:
                with self._start_lock:
                    if not self._detach_and_close(shared):
                        failed = True
        finally:
            lane.article_context = None
            lane.lease_lock.release()
        _LOGGER.debug(
            "event=browser-session-released session_key=%s invalidated=%s outcome=%s elapsed_ms=%d",
            lane.session_key,
            str(invalidate).lower(),
            "failure" if failed else "retired" if retire else "reusable",
            _elapsed_ms(started_ns),
        )
        if failed:
            self._cleanup_failed = True
            raise BrowserSessionError("Browser session cleanup failed")

    def _detach_and_close(self, shared: _SharedBrowser) -> bool:
        with self._state_lock:
            if self._shared is shared:
                if shared.active_leases:
                    return True
                self._shared = None
        cleaned = shared.close()
        if not cleaned:
            self._cleanup_failed = True
        return cleaned

    def invalidate(self, session_key: str) -> None:
        key = _session_key(session_key)
        started_ns = time.monotonic_ns()
        with self._state_lock:
            lane = self._lanes.get(key)
        if lane is None:
            _LOGGER.debug(
                "event=browser-session-invalidate-finished session_key=%s "
                "outcome=absent elapsed_ms=%d",
                key,
                _elapsed_ms(started_ns),
            )
            return
        lane.lease_lock.acquire()
        failed = False
        try:
            with self._state_lock:
                shared = self._shared
                if shared is not None:
                    shared.retire_requested = True
                    retire = shared.active_leases == 0
                else:
                    retire = False
            if shared is not None and retire:
                with self._start_lock:
                    failed = not self._detach_and_close(shared)
        finally:
            lane.lease_lock.release()
        if failed:
            raise BrowserSessionError("Browser session cleanup failed")
        _LOGGER.debug(
            "event=browser-session-invalidate-finished session_key=%s outcome=retired "
            "elapsed_ms=%d",
            key,
            _elapsed_ms(started_ns),
        )

    def close(self) -> None:
        started_ns = time.monotonic_ns()
        with self._state_lock:
            if self._closed:
                if self._cleanup_failed:
                    raise BrowserSessionError("Browser session broker cleanup failed")
                return
            self._closed = True
            lanes = tuple(self._lanes.values())
        for lane in lanes:
            lane.lease_lock.acquire()
        failed = self._cleanup_failed
        try:
            with self._start_lock:
                with self._state_lock:
                    shared = self._shared
                    self._shared = None
                    self._lanes.clear()
                if shared is not None:
                    shared.retire_requested = True
                    if shared.active_leases or not shared.close():
                        failed = True
        finally:
            for lane in reversed(lanes):
                lane.lease_lock.release()
        if failed:
            self._cleanup_failed = True
            _LOGGER.debug(
                "event=browser-session-broker-cleanup-failed lane_count=%d "
                "outcome=failure elapsed_ms=%d code=browser-session-cleanup-failed "
                "retryable=true reason=The shared Browser runtime could not be cleaned. "
                "action=Restart the Browser runtime before retrying.",
                len(lanes),
                _elapsed_ms(started_ns),
            )
            raise BrowserSessionError("Browser session broker cleanup failed")
        _LOGGER.debug(
            "event=browser-session-broker-cleanup-finished lane_count=%d process_count=%d "
            "outcome=cleaned elapsed_ms=%d",
            len(lanes),
            1 if shared is not None else 0,
            _elapsed_ms(started_ns),
        )

    def __enter__(self) -> BrowserSessionBroker:
        return self

    def __exit__(self, exc_type: object, exc_value: object, traceback: object) -> bool:
        del exc_type, exc_value, traceback
        self.close()
        return False


__all__ = (
    "BrowserSessionBroker",
    "BrowserSessionCancelled",
    "BrowserSessionError",
    "BrowserSessionTimeout",
)
