"""Process-local broker for opaque operator-managed Browser sessions.

The broker owns persistent process/context objects keyed by a stable session
identity.  One lease covers exactly one article flow.  Vendor objects never
leave Network: :mod:`network.browser` is the sole consumer of the private
lease surface.
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
    """A persistent Browser session could not be created, used, or cleaned."""


class BrowserSessionCancelled(BrowserSessionError):
    """A session lease was cancelled before its article flow started."""


class BrowserSessionTimeout(BrowserSessionError):
    """A session lease could not start before its bounded deadline."""


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


def _delete_object(value: object | None) -> bool:
    if value is None:
        return True
    delete = getattr(value, "delete", None)
    if not callable(delete):
        return True
    try:
        delete()
    except Exception:
        return False
    return True


class _SessionEntry:
    __slots__ = (
        "session_key",
        "lease_lock",
        "handler_lock",
        "factory",
        "profile",
        "process_manager",
        "process_runtime",
        "context",
        "entered_process",
        "session_directory",
        "active_route_handler",
        "active_event_handlers",
        "broken",
        "closed",
        "cleanup_failed",
    )

    def __init__(self, session_key: str) -> None:
        self.session_key = session_key
        self.lease_lock = threading.Lock()
        self.handler_lock = threading.Lock()
        self.factory: BrowserFactory | None = None
        self.profile: object | None = None
        self.process_manager: object | None = None
        self.process_runtime: object | None = None
        self.context: object | None = None
        self.entered_process = False
        self.session_directory: tempfile.TemporaryDirectory[str] | None = None
        self.active_route_handler: RouteHandler | None = None
        self.active_event_handlers: dict[str, EventHandler] = {}
        self.broken = False
        self.closed = False
        self.cleanup_failed = False

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

    def ensure_started(
        self,
        *,
        factory: BrowserFactory,
        profile: object | None,
        connection_binding: object,
    ) -> None:
        if self.closed or self.broken:
            raise BrowserSessionError("Browser session is not reusable")
        if self.context is not None:
            if self.factory is not factory or self.profile is not profile:
                raise BrowserSessionError("Browser session identity changed after assembly")
            return
        self.factory = factory
        self.profile = profile
        try:
            temporary = tempfile.TemporaryDirectory(prefix="sciretriever-browser-session-")
            self.session_directory = temporary
            session_path = Path(temporary.name)
            os.chmod(session_path, stat.S_IRWXU)
            manager = factory(
                profile=profile,
                downloads_path=os.fspath(session_path),
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
                profile=profile,
                downloads_path=os.fspath(session_path),
                accept_downloads=True,
                connection_binding=connection_binding,
            )
            if context is None:
                raise BrowserSessionError("Browser session context is unavailable")
            self.context = context
            _acknowledge_binding(context, connection_binding)
            self._install_dispatchers(context)
        except BrowserSessionError:
            self.broken = True
            raise
        except Exception:
            self.broken = True
            raise BrowserSessionError("Browser session could not be started") from None

    def _install_dispatchers(self, context: object) -> None:
        route = _callable(context, "route")
        on = _callable(context, "on")
        route("**/*", self._dispatch_route)
        for event in _EVENT_NAMES:
            on(event, lambda value, event=event: self._dispatch_event(event, value))

    def begin_article(
        self,
        *,
        downloads_path: str,
        connection_binding: object,
        route_handler: RouteHandler,
        event_handlers: Mapping[str, EventHandler],
    ) -> None:
        context = self.context
        if context is None or self.broken or self.closed:
            raise BrowserSessionError("Browser session context is unavailable")
        if not callable(route_handler):
            raise TypeError("route_handler must be callable")
        if set(event_handlers) != set(_EVENT_NAMES) or any(
            not callable(handler) for handler in event_handlers.values()
        ):
            raise TypeError("event_handlers must provide the closed Browser event set")
        with self.handler_lock:
            if self.active_route_handler is not None or self.active_event_handlers:
                raise BrowserSessionError("Browser session already owns an article flow")
            self.active_route_handler = route_handler
            self.active_event_handlers = dict(event_handlers)
        try:
            begin = _callable(context, "begin_article")
            acknowledged = begin(
                downloads_path=downloads_path,
                connection_binding=connection_binding,
            )
            if acknowledged is not connection_binding:
                raise BrowserSessionError("Browser article binding was not acknowledged")
        except BrowserSessionError:
            self._clear_handlers()
            self.broken = True
            raise
        except Exception:
            self._clear_handlers()
            self.broken = True
            raise BrowserSessionError("Browser article session could not start") from None

    def end_article(self) -> None:
        context = self.context
        failed = False
        try:
            if context is None:
                failed = True
            else:
                end = _callable(context, "end_article")
                acknowledged = end()
                if acknowledged is not True:
                    failed = True
        except Exception:
            failed = True
        finally:
            self._clear_handlers()
        if failed:
            self.broken = True
            raise BrowserSessionError("Browser article session could not be drained")

    def _clear_handlers(self) -> None:
        with self.handler_lock:
            self.active_route_handler = None
            self.active_event_handlers = {}

    def _dispatch_route(self, route: object) -> object | None:
        with self.handler_lock:
            handler = self.active_route_handler
        if handler is not None:
            return handler(route)
        abort = getattr(route, "abort", None)
        if callable(abort):
            try:
                abort()
            except Exception:
                self._mark_cleanup_failure()
        return None

    def _dispatch_event(self, event: str, value: object) -> object | None:
        with self.handler_lock:
            handler = self.active_event_handlers.get(event)
        if handler is not None:
            return handler(value)
        cleaned = True
        if event == "page":
            cleaned = _close_object(value)
        elif event == "download":
            cleaned = _delete_object(value)
        if not cleaned:
            self._mark_cleanup_failure()
        return None

    def _mark_cleanup_failure(self) -> None:
        with self.handler_lock:
            self.broken = True
            self.cleanup_failed = True

    def close(self) -> bool:
        if self.closed:
            return not self.cleanup_failed
        self.closed = True
        self._clear_handlers()
        failed = self.cleanup_failed
        context = self.context
        manager = self.process_manager
        runtime = self.process_runtime
        entered_process = self.entered_process
        temporary = self.session_directory
        # Transfer ownership before invoking vendor cleanup.  A repeated close
        # observes the sticky result without touching any resource twice.
        self.context = None
        self.process_runtime = None
        self.process_manager = None
        self.entered_process = False
        self.session_directory = None
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
    """Private one-article lease consumed only by ``BrowserClient``."""

    __slots__ = (
        "_broker",
        "_entry",
        "_drain_attempted",
        "_drain_failed",
        "_released",
        "_release_failed",
        "_invalidate",
    )

    def __init__(self, broker: BrowserSessionBroker, entry: _SessionEntry) -> None:
        self._broker = broker
        self._entry = entry
        self._drain_attempted = False
        self._drain_failed = False
        self._released = False
        self._release_failed = False
        self._invalidate = False

    @property
    def process_runtime(self) -> object:
        value = self._entry.process_runtime
        if value is None:
            raise BrowserSessionError("Browser session runtime is unavailable")
        return value

    @property
    def context(self) -> object:
        value = self._entry.context
        if value is None:
            raise BrowserSessionError("Browser session context is unavailable")
        return value

    def invalidate(self) -> None:
        self._invalidate = True
        _LOGGER.debug(
            "event=browser-session-invalidated session_key=%s disposition=marked next=release",
            self._entry.session_key,
        )

    def drain_article(self) -> None:
        """Drain late runtime events while this article's handlers are active."""

        if self._released:
            raise BrowserSessionError("Browser session lease is already released")
        if self._drain_attempted:
            if self._drain_failed:
                raise BrowserSessionError("Browser article session could not be drained")
            return
        started_ns = time.monotonic_ns()
        self._drain_attempted = True
        try:
            self._entry.end_article()
        except BrowserSessionError:
            self._invalidate = True
            self._drain_failed = True
            _LOGGER.debug(
                "event=browser-session-article-drain-failed session_key=%s "
                "outcome=failure elapsed_ms=%d code=browser-session-drain-failed "
                "retryable=true reason=The Browser article session could not be drained. "
                "action=Retire the session before the next article.",
                self._entry.session_key,
                _elapsed_ms(started_ns),
            )
            raise
        _LOGGER.debug(
            "event=browser-session-article-drained session_key=%s outcome=success elapsed_ms=%d",
            self._entry.session_key,
            _elapsed_ms(started_ns),
        )

    def release(self) -> None:
        if self._released:
            if self._release_failed:
                raise BrowserSessionError("Browser session cleanup failed")
            return
        try:
            self._broker._release(
                self._entry,
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

    def __exit__(
        self,
        exc_type: object,
        exc_value: object,
        traceback: object,
    ) -> bool:
        del exc_type, exc_value, traceback
        self.release()
        return False


class BrowserSessionBroker:
    """Own persistent Browser contexts without persisting dynamic health state."""

    __slots__ = ("_clock", "_state_lock", "_entries", "_closed", "_cleanup_failed")

    def __init__(self, *, clock: Clock = time.monotonic) -> None:
        if not callable(clock):
            raise TypeError("clock must be callable")
        self._clock = clock
        self._state_lock = threading.Lock()
        self._entries: dict[str, _SessionEntry] = {}
        self._closed = False
        self._cleanup_failed = False

    @staticmethod
    def validate_session_key(session_key: object) -> str:
        """Validate and normalize one stable, non-sensitive session identity."""

        return _session_key(session_key)

    def acquire(
        self,
        session_key: str,
        *,
        factory: BrowserFactory,
        profile: object | None,
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
                profile=profile,
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
                retryable=True,
                reason="The Browser session lease was cancelled before article start.",
                action="Retry the completion operation when appropriate.",
                started_ns=started_ns,
            )
            raise
        except BrowserSessionTimeout:
            self._log_acquire_failure(
                key,
                disposition="deferred",
                code="browser-session-acquire-timeout",
                retryable=True,
                reason="The Browser session lease did not become available in time.",
                action="Retry after the provider session becomes available.",
                started_ns=started_ns,
            )
            raise
        except BrowserSessionError:
            self._log_acquire_failure(
                key,
                disposition="failure",
                code="browser-session-acquire-failed",
                retryable=True,
                reason="The Browser session could not start an article flow.",
                action="Review session cleanup diagnostics before retrying.",
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
        profile: object | None,
        downloads_path: str,
        connection_binding: object,
        route_handler: RouteHandler,
        event_handlers: Mapping[str, EventHandler],
        cancel_event: BrowserSessionCancellation | None,
    ) -> tuple[BrowserSessionLease, bool]:
        while True:
            entry = self._entry(key)
            entry.acquire(deadline=deadline, clock=self._clock, cancel_event=cancel_event)
            with self._state_lock:
                current = self._entries.get(key)
                closed = self._closed
            if closed:
                if not self._discard_locked_entry(entry):
                    raise BrowserSessionError("Browser session cleanup failed")
                raise BrowserSessionError("Browser session broker is closed")
            if current is not entry or entry.broken or entry.closed:
                if not self._discard_locked_entry(entry):
                    raise BrowserSessionError("Browser session cleanup failed")
                continue
            reused = entry.context is not None
            try:
                entry.ensure_started(
                    factory=factory,
                    profile=profile,
                    connection_binding=connection_binding,
                )
                entry.begin_article(
                    downloads_path=downloads_path,
                    connection_binding=connection_binding,
                    route_handler=route_handler,
                    event_handlers=event_handlers,
                )
            except Exception:
                if not self._discard_locked_entry(entry):
                    raise BrowserSessionError("Browser session cleanup failed") from None
                raise BrowserSessionError("Browser session acquisition failed") from None
            return BrowserSessionLease(self, entry), reused

    @staticmethod
    def _log_acquire_failure(
        session_key: str,
        *,
        disposition: str,
        code: str,
        retryable: bool,
        reason: str,
        action: str,
        started_ns: int,
    ) -> None:
        _LOGGER.debug(
            "event=browser-session-acquire-failed session_key=%s disposition=%s "
            "elapsed_ms=%d code=%s retryable=%s reason=%s action=%s",
            session_key,
            disposition,
            _elapsed_ms(started_ns),
            code,
            str(retryable).lower(),
            reason,
            action,
        )

    def _acquire_inputs(
        self,
        session_key: str,
        *,
        factory: BrowserFactory,
        downloads_path: str,
        cancel_event: BrowserSessionCancellation | None,
        timeout: float,
    ) -> tuple[str, float]:
        key = _session_key(session_key)
        if not callable(factory):
            raise TypeError("factory must be callable")
        if type(downloads_path) is not str or not downloads_path:
            raise ValueError("downloads_path must be a nonblank string")
        if cancel_event is not None and not isinstance(
            cancel_event,
            BrowserSessionCancellation,
        ):
            raise TypeError("cancel_event must expose is_set() or be None")
        return key, self._clock() + _positive_timeout(timeout)

    def _discard_locked_entry(self, entry: _SessionEntry) -> bool:
        started_ns = time.monotonic_ns()
        cleaned = False
        try:
            cleaned = entry.close()
            self._retire(entry)
        finally:
            entry.lease_lock.release()
        if not cleaned:
            self._cleanup_failed = True
        _LOGGER.debug(
            "event=browser-session-cleanup session_key=%s resource=session "
            "outcome=%s elapsed_ms=%d",
            entry.session_key,
            "cleaned" if cleaned else "failed",
            _elapsed_ms(started_ns),
        )
        return cleaned

    def _entry(self, key: str) -> _SessionEntry:
        with self._state_lock:
            if self._closed:
                raise BrowserSessionError("Browser session broker is closed")
            entry = self._entries.get(key)
            if entry is None:
                entry = _SessionEntry(key)
                self._entries[key] = entry
            return entry

    def _release(
        self,
        entry: _SessionEntry,
        *,
        invalidate: bool,
        article_drain_attempted: bool,
    ) -> None:
        started_ns = time.monotonic_ns()
        failed = False
        try:
            if not article_drain_attempted:
                try:
                    entry.end_article()
                except BrowserSessionError:
                    failed = True
                    invalidate = True
            if invalidate:
                entry.broken = True
                if not entry.close():
                    failed = True
                self._retire(entry)
        finally:
            entry.lease_lock.release()
        _LOGGER.debug(
            "event=browser-session-released session_key=%s invalidated=%s outcome=%s elapsed_ms=%d",
            entry.session_key,
            str(invalidate).lower(),
            "failure" if failed else "retired" if invalidate else "reusable",
            _elapsed_ms(started_ns),
        )
        if failed:
            self._cleanup_failed = True
            raise BrowserSessionError("Browser session cleanup failed")

    def _retire(self, entry: _SessionEntry) -> None:
        with self._state_lock:
            if self._entries.get(entry.session_key) is entry:
                self._entries.pop(entry.session_key, None)

    def invalidate(self, session_key: str) -> None:
        key = _session_key(session_key)
        started_ns = time.monotonic_ns()
        with self._state_lock:
            entry = self._entries.get(key)
            if entry is not None:
                entry.broken = True
        if entry is None:
            _LOGGER.debug(
                "event=browser-session-invalidate-finished session_key=%s "
                "outcome=absent elapsed_ms=%d",
                key,
                _elapsed_ms(started_ns),
            )
            return
        entry.lease_lock.acquire()
        try:
            cleanup_failed = not entry.close()
            self._retire(entry)
        finally:
            entry.lease_lock.release()
        if cleanup_failed:
            self._cleanup_failed = True
            _LOGGER.debug(
                "event=browser-session-invalidate-failed session_key=%s outcome=failure "
                "elapsed_ms=%d code=browser-session-cleanup-failed retryable=true "
                "reason=The invalidated Browser session could not be cleaned. "
                "action=Restart the Browser runtime before retrying.",
                key,
                _elapsed_ms(started_ns),
            )
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
            entries = tuple(self._entries.values())
            self._entries.clear()
        failed = self._cleanup_failed
        for entry in entries:
            entry.lease_lock.acquire()
            try:
                entry.broken = True
                if not entry.close():
                    failed = True
            finally:
                entry.lease_lock.release()
        if failed:
            self._cleanup_failed = True
            _LOGGER.debug(
                "event=browser-session-broker-cleanup-failed session_count=%d "
                "outcome=failure elapsed_ms=%d code=browser-session-cleanup-failed "
                "retryable=true reason=One or more Browser sessions could not be cleaned. "
                "action=Restart the Browser runtime before retrying.",
                len(entries),
                _elapsed_ms(started_ns),
            )
            raise BrowserSessionError("Browser session broker cleanup failed")
        _LOGGER.debug(
            "event=browser-session-broker-cleanup-finished session_count=%d "
            "outcome=cleaned elapsed_ms=%d",
            len(entries),
            _elapsed_ms(started_ns),
        )

    def __enter__(self) -> BrowserSessionBroker:
        return self

    def __exit__(
        self,
        exc_type: object,
        exc_value: object,
        traceback: object,
    ) -> bool:
        del exc_type, exc_value, traceback
        self.close()
        return False


__all__ = (
    "BrowserSessionBroker",
    "BrowserSessionCancelled",
    "BrowserSessionError",
    "BrowserSessionTimeout",
)
