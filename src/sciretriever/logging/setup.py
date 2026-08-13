"""Production-process logging setup for the SciRetriever namespace."""

from __future__ import annotations

import logging
import sys
from typing import TextIO, cast

from .redaction import RedactingFormatter, RedactionFilter

_PROJECT_LOGGER_NAME = "sciretriever"
_OWNED_HANDLER_ATTRIBUTE = "_sciretriever_owned_handler"


class _BestEffortStreamHandler(logging.StreamHandler):
    """A stderr handler whose own failures cannot cross the logging boundary."""

    def handle(self, record: logging.LogRecord) -> bool:
        self.acquire()
        try:
            try:
                if self.filter(record):
                    self.emit(record)
            except Exception:
                # Do not call ``handleError``: it can write a traceback to
                # stderr, leak an unsafe record, and make logging observable
                # as a business-side failure when a stream is broken.
                pass
            return True
        finally:
            self.release()

    def emit(self, record: logging.LogRecord) -> None:
        try:
            message = self.format(record)
            stream = self.stream
            if stream is None:
                return
            stream.write(message + self.terminator)
            self.flush()
        except Exception:
            return


def _owned_handlers(logger: logging.Logger) -> list[_BestEffortStreamHandler]:
    return [
        cast(_BestEffortStreamHandler, handler)
        for handler in logger.handlers
        if getattr(handler, _OWNED_HANDLER_ATTRIBUTE, False)
    ]


def _make_handler(stream: TextIO) -> _BestEffortStreamHandler:
    handler = _BestEffortStreamHandler(stream)
    setattr(handler, _OWNED_HANDLER_ATTRIBUTE, True)
    handler.setFormatter(RedactingFormatter("%(asctime)s %(levelname)s %(name)s %(message)s"))
    handler.addFilter(RedactionFilter())
    return handler


def configure_logging(*, level: int) -> None:
    """Install one project-owned stderr handler without touching root logging."""

    logger = logging.getLogger(_PROJECT_LOGGER_NAME)
    logger.setLevel(level)
    logger.propagate = False

    owned = _owned_handlers(logger)
    if owned:
        handler = owned[0]
        # Remove stale duplicates left by a partially repeated setup.  Only
        # handlers marked by this module are touched; host-owned handlers are
        # left intact as required for library embedding.
        for duplicate in owned[1:]:
            logger.removeHandler(duplicate)
            duplicate.close()
        try:
            handler.setStream(sys.stderr)
        except Exception:
            # A broken previous stream should not make reconfiguration fail.
            handler.stream = sys.stderr
        handler.setFormatter(RedactingFormatter("%(asctime)s %(levelname)s %(name)s %(message)s"))
        handler.filters[:] = [RedactionFilter()]
        return

    logger.addHandler(_make_handler(sys.stderr))
