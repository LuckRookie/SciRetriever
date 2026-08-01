"""Private validation and transport helpers for discovery providers."""

from __future__ import annotations

from collections.abc import Callable
from typing import TypeVar
from urllib.error import HTTPError, URLError

from sciretriever.core.contracts import SearchSpec
from sciretriever.errors import ProviderSearchError
from sciretriever.integrations import IntegrationError

from .http import ResponseTooLargeError

_T = TypeVar("_T")


def validated_year_filters(
    spec: SearchSpec,
    provider: str,
) -> tuple[int | None, int | None]:
    values = dict(spec.filters)
    unknown = values.keys() - {"year_from", "year_to"}
    if unknown:
        names = ", ".join(sorted(unknown))
        raise ProviderSearchError.for_configuration(
            provider, f"unsupported {provider} search filters: {names}"
        )

    years: dict[str, int] = {}
    for name, value in values.items():
        if not value.isascii() or not value.isdecimal():
            raise ProviderSearchError.for_configuration(
                provider, f"{name} must be a year from 1 through 9999"
            )
        year = int(value)
        if not 1 <= year <= 9999:
            raise ProviderSearchError.for_configuration(
                provider, f"{name} must be a year from 1 through 9999"
            )
        years[name] = year

    year_from = years.get("year_from")
    year_to = years.get("year_to")
    if year_from is not None and year_to is not None and year_from > year_to:
        raise ProviderSearchError.for_configuration(
            provider, "year_from must not be later than year_to"
        )
    return year_from, year_to


def run_integration_search(provider: str, operation: Callable[[], _T]) -> _T:
    try:
        return operation()
    except IntegrationError as error:
        if error.status is not None and 300 <= error.status < 600:
            raise ProviderSearchError.for_http_status(provider, error.status) from error
        raise ProviderSearchError.for_invalid_response(provider, str(error)) from error
    except ResponseTooLargeError as error:
        raise ProviderSearchError.for_invalid_response(
            provider, f"{provider} returned an oversized HTTP response"
        ) from error
    except (HTTPError, URLError, OSError) as error:
        raise ProviderSearchError.for_exception(provider, error) from error


__all__: tuple[str, ...] = ()
