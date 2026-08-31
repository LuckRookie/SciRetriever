"""Bounded text and image values for one Provider-neutral Agent call."""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, field

_CONTROL = re.compile(r"[\x00-\x1f\x7f-\x9f]")
_PART_CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]")
_MAX_MODEL_BYTES = 512
_MAX_PART_BYTES = 16 * 1024 * 1024
_MAX_IMAGE_BYTES = 16 * 1024 * 1024
MAX_TEXT_PARTS = 64
MAX_IMAGE_PARTS = 16


def utf8_size(value: str) -> int:
    """Return strict UTF-8 size without accepting lone surrogates."""

    if type(value) is not str:
        raise TypeError("value must be text")
    try:
        return len(value.encode("utf-8", errors="strict"))
    except UnicodeEncodeError:
        raise ValueError("value must be valid UTF-8") from None


def _bounded_text(value: object, *, field_name: str, maximum: int) -> str:
    if type(value) is not str:
        raise TypeError(f"{field_name} must be text")
    normalized = unicodedata.normalize("NFC", value)
    if not normalized.strip() or _CONTROL.search(normalized) is not None:
        raise ValueError(f"{field_name} must be stable text")
    if utf8_size(normalized) > maximum:
        raise ValueError(f"{field_name} exceeds its byte limit")
    return normalized


def _model_identity(value: object) -> str:
    """Apply the single model-identity contract used inside Agents."""

    return _bounded_text(value, field_name="model", maximum=_MAX_MODEL_BYTES)


@dataclass(frozen=True, slots=True)
class AgentTextPart:
    """One ordered, bounded text part; its body is excluded from repr."""

    media_type: str
    text: str = field(repr=False)

    def __post_init__(self) -> None:
        if self.media_type not in {"text/plain", "application/json"}:
            raise ValueError("unsupported Agent text media type")
        if type(self.text) is not str:
            raise TypeError("text must be text")
        normalized = unicodedata.normalize("NFC", self.text)
        if not normalized.strip() or _PART_CONTROL.search(normalized) is not None:
            raise ValueError("text must be stable text")
        if utf8_size(normalized) > _MAX_PART_BYTES:
            raise ValueError("text exceeds its byte limit")
        if self.media_type == "application/json":
            # Local import avoids a module cycle: tools uses the same bounded
            # text helper for declaration names and descriptions.
            from .tools import parse_strict_json

            parse_strict_json(normalized)
        object.__setattr__(self, "text", normalized)


@dataclass(frozen=True, slots=True, repr=False)
class AgentImagePart:
    """One in-memory image; raw bytes and dimensions never appear in repr."""

    media_type: str
    data: bytes = field(repr=False)
    width: int
    height: int

    def __post_init__(self) -> None:
        if self.media_type not in {"image/png", "image/jpeg", "image/webp"}:
            raise ValueError("unsupported Agent image media type")
        if type(self.data) is not bytes or not self.data or len(self.data) > _MAX_IMAGE_BYTES:
            raise ValueError("image bytes exceed the Agent boundary")
        if type(self.width) is not int or self.width < 1 or self.width > 32_768:
            raise ValueError("image width is invalid")
        if type(self.height) is not int or self.height < 1 or self.height > 32_768:
            raise ValueError("image height is invalid")


def _validate_message_parts(
    text_parts: object,
    image_parts: object,
) -> tuple[tuple[AgentTextPart, ...], tuple[AgentImagePart, ...]]:
    if not isinstance(text_parts, tuple) or any(
        not isinstance(part, AgentTextPart) for part in text_parts
    ):
        raise TypeError("text_parts must contain AgentTextPart values")
    if not isinstance(image_parts, tuple) or any(
        not isinstance(part, AgentImagePart) for part in image_parts
    ):
        raise TypeError("image_parts must contain AgentImagePart values")
    if not text_parts and not image_parts:
        raise ValueError("Agent call requires bounded text or image input")
    if len(text_parts) > MAX_TEXT_PARTS:
        raise ValueError("too many Agent text parts")
    if len(image_parts) > MAX_IMAGE_PARTS:
        raise ValueError("too many Agent image parts")
    return text_parts, image_parts


__all__ = ("AgentImagePart", "AgentTextPart")
