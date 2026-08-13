"""Public boundary for the SciRetriever logging foundation."""

from __future__ import annotations

import logging
import re

from .setup import configure_logging as _configure_logging

_MODULE_NAME = re.compile(r"sciretriever(?:\.[A-Za-z_][A-Za-z0-9_]*)*")

__all__ = ("configure_logging", "get_logger")


def get_logger(module_name: str) -> logging.Logger:
    """Return a standard-library logger in the SciRetriever namespace.

    Logger lookup is deliberately inert: it does not configure the project
    logger, install handlers, or alter a logger's level.  Whitespace at the
    boundary is accepted so callers can pass names obtained from a small
    amount of user-facing plumbing, while malformed module names fail closed.
    """

    if not isinstance(module_name, str):
        raise TypeError("module_name must be a string")
    normalized = module_name.strip()
    if not _MODULE_NAME.fullmatch(normalized):
        raise ValueError("module_name must be a sciretriever module name")
    return logging.getLogger(normalized)


def configure_logging(*, level: int) -> None:
    """Configure the process-local SciRetriever logger exactly once per handler.

    The implementation lives behind this API so all production modules share
    one explicit entry point.  Calling this function is an opt-in operation;
    importing the package and obtaining a logger never calls it implicitly.
    """

    if isinstance(level, bool) or not isinstance(level, int):
        raise TypeError("level must be an integer logging level")
    _configure_logging(level=level)
