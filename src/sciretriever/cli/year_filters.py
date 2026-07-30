from __future__ import annotations

import argparse


FILTER_NAMES = frozenset({"year_from", "year_to"})


def parse_year_filter(value: str) -> tuple[str, str]:
    if value.count("=") != 1:
        raise argparse.ArgumentTypeError("filter must use NAME=VALUE syntax")
    name, filter_value = (part.strip() for part in value.split("=", 1))
    if not name or not filter_value:
        raise argparse.ArgumentTypeError("filter name and value must not be blank")
    if name not in FILTER_NAMES:
        raise argparse.ArgumentTypeError(
            f"unsupported filter {name!r}; choose year_from or year_to"
        )
    if not filter_value.isascii() or not filter_value.isdecimal():
        raise argparse.ArgumentTypeError(f"{name} must be a year from 1 through 9999")
    year = int(filter_value)
    if not 1 <= year <= 9999:
        raise argparse.ArgumentTypeError(f"{name} must be a year from 1 through 9999")
    return name, filter_value


def validate_year_filters(
    parser: argparse.ArgumentParser,
    filters: list[tuple[str, str]],
) -> None:
    names = [name for name, _ in filters]
    duplicate_names = sorted({name for name in names if names.count(name) > 1})
    if duplicate_names:
        parser.error(f"duplicate filter: {', '.join(duplicate_names)}")
    values = dict(filters)
    if (
        "year_from" in values
        and "year_to" in values
        and int(values["year_from"]) > int(values["year_to"])
    ):
        parser.error("year_from must not be later than year_to")


__all__ = ("parse_year_filter", "validate_year_filters")
