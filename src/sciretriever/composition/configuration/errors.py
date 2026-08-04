from __future__ import annotations

from typing import NoReturn

from pydantic import ValidationError
from pydantic_core import PydanticCustomError
from typing_extensions import LiteralString


def raise_configuration_error(
    location: tuple[str, ...],
    message: LiteralString,
    *,
    code: LiteralString = "configuration_error",
) -> NoReturn:
    error = PydanticCustomError(code, message)
    raise ValidationError.from_exception_data(
        "TargetConfig", [{"type": error, "loc": location, "input": None}]
    )


__all__ = ("raise_configuration_error",)
