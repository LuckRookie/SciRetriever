"""Opt-in, payload-local diagnostics for Agent image inputs.

The Browser controller deliberately keeps screenshots in the request-local
``AgentImagePart`` value and does not put them in the catalog or the normal
diagnostic stream.  When a foreground command is explicitly run with
``--debug``, this recorder makes an exact copy of those bytes at the last
boundary before a Provider adapter is called.  It is intentionally small and
best-effort: a diagnostics disk failure must never turn a successful Agent
call into a business failure.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import tempfile
import threading
from pathlib import Path
from typing import TYPE_CHECKING, Final

from sciretriever.logging.api import get_logger

if TYPE_CHECKING:
    from .ports import AgentProviderCall


_LOGGER = get_logger("sciretriever.agents")
_ROLE_TOKEN: Final[re.Pattern[str]] = re.compile(r"^[a-z][a-z0-9_-]{0,63}$", re.ASCII)
_MEDIA_EXTENSIONS: Final[dict[str, str]] = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
}


class AgentDebugImageRecorder:
    """Persist exact image parts for one process-local debug run.

    The directory is created lazily, only when a call actually contains an
    image.  A caller may provide an existing temporary directory in tests;
    production uses a fresh ``sciretriever-agent-debug-*`` directory under the
    operating system temporary root.  No prompt, model response, URL, cookie,
    credential, or image content is written to the manifest or log.
    """

    __slots__ = (
        "_directory",
        "_directory_announced",
        "_lock",
        "_manifest",
        "_next_sequence",
    )

    def __init__(self, directory: str | Path | None = None) -> None:
        if directory is not None:
            try:
                candidate = Path(directory)
            except TypeError:
                raise TypeError("directory must be a path or None") from None
            if not candidate.is_absolute():
                raise ValueError("debug image directory must be absolute")
            self._directory: Path | None = candidate
        else:
            self._directory = None
        self._directory_announced = False
        self._lock = threading.RLock()
        self._manifest: Path | None = None
        self._next_sequence = 1

    @property
    def directory(self) -> Path | None:
        """Return the materialized directory, or ``None`` before first image."""

        with self._lock:
            return self._directory

    @property
    def manifest(self) -> Path | None:
        """Return the manifest path after the first image has been recorded."""

        with self._lock:
            return self._manifest

    def record(self, call: AgentProviderCall) -> None:
        """Best-effort record of every image in one provider-bound call.

        ``call.image_parts`` is read before the adapter is invoked, so the
        bytes written here are the exact bytes crossing the Agents boundary.
        Every exception raised by filesystem or serialization work is reduced
        to a safe warning and is never propagated to the caller.
        """

        try:
            image_parts = call.image_parts
            with self._lock:
                sequence = self._next_sequence
                self._next_sequence += 1
                if not image_parts:
                    return
                directory = self._ensure_directory()
                manifest = self._ensure_manifest(directory)
                self._manifest = manifest
                role = _safe_role(call.role.value)
                input_sha256 = call.input_sha256.root
                for image_index, part in enumerate(image_parts, start=1):
                    self._record_part(
                        directory,
                        manifest,
                        sequence=sequence,
                        role=role,
                        input_sha256=input_sha256,
                        image_index=image_index,
                        part=part,
                    )
        except Exception as error:
            # Do not include ``str(error)``: a provider/runtime implementation
            # could accidentally put a local path or another sensitive value
            # in it.  The exception class is bounded and non-payload data.
            _LOGGER.warning(
                "event=agent-debug-image-recording-failed outcome=warning exception_type=%s",
                type(error).__name__,
            )

    def _ensure_directory(self) -> Path:
        directory = self._directory
        if directory is None:
            directory = Path(tempfile.mkdtemp(prefix="sciretriever-agent-debug-"))
            self._directory = directory
        if directory.is_symlink() or not directory.is_dir():
            raise OSError("debug image directory is not a directory")
        os.chmod(directory, 0o700)
        if not self._directory_announced:
            _LOGGER.debug(
                "event=agent-debug-image-directory-created directory_name=%s mode=0700",
                directory.name,
            )
            self._directory_announced = True
        return directory

    @staticmethod
    def _ensure_manifest(directory: Path) -> Path:
        manifest = directory / "manifest.ndjson"
        if manifest.exists():
            if manifest.is_symlink() or not manifest.is_file():
                raise OSError("debug image manifest is not a regular file")
            os.chmod(manifest, 0o600)
            return manifest
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
        descriptor = os.open(manifest, flags, 0o600)
        os.close(descriptor)
        return manifest

    def _record_part(
        self,
        directory: Path,
        manifest: Path,
        *,
        sequence: int,
        role: str,
        input_sha256: str,
        image_index: int,
        part: object,
    ) -> None:
        data = getattr(part, "data", None)
        media_type = getattr(part, "media_type", None)
        width = getattr(part, "width", None)
        height = getattr(part, "height", None)
        if type(data) is not bytes or not data:
            raise ValueError("Agent image bytes are invalid")
        if type(media_type) is not str or media_type not in _MEDIA_EXTENSIONS:
            raise ValueError("Agent image media type is invalid")
        if type(width) is not int or type(height) is not int:
            raise ValueError("Agent image dimensions are invalid")
        image_sha256 = hashlib.sha256(data).hexdigest()
        extension = _MEDIA_EXTENSIONS[media_type]
        filename = f"{sequence:06d}-{role}-{image_index:02d}-{image_sha256}{extension}"
        target = directory / filename
        _atomic_write(target, data)
        entry = {
            "sequence": sequence,
            "role": role,
            "image_index": image_index,
            "media_type": media_type,
            "width": width,
            "height": height,
            "bytes": len(data),
            "image_sha256": image_sha256,
            "input_sha256": input_sha256,
            "filename": filename,
        }
        _append_manifest(manifest, entry)
        _LOGGER.debug(
            "event=agent-debug-image-recorded sequence=%d role=%s image_index=%d "
            "media_type=%s bytes=%d image_sha256=%s input_sha256=%s filename=%s "
            "directory_name=%s",
            sequence,
            role,
            image_index,
            media_type,
            len(data),
            image_sha256,
            input_sha256,
            filename,
            directory.name,
        )


def _safe_role(value: object) -> str:
    if type(value) is not str or _ROLE_TOKEN.fullmatch(value) is None:
        raise ValueError("Agent role is not a safe token")
    return value


def _atomic_write(target: Path, data: bytes) -> None:
    temporary: Path | None = None
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{target.name}.",
        suffix=".tmp",
        dir=target.parent,
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, 0o600)
        os.replace(temporary, target)
        temporary = None
    finally:
        if temporary is not None:
            try:
                temporary.unlink(missing_ok=True)
            except OSError:
                pass


def _append_manifest(manifest: Path, entry: dict[str, object]) -> None:
    serialized = json.dumps(
        entry,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    line = (serialized + "\n").encode("utf-8")
    descriptor = os.open(manifest, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
    try:
        offset = 0
        while offset < len(line):
            offset += os.write(descriptor, line[offset:])
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    os.chmod(manifest, 0o600)


__all__ = ("AgentDebugImageRecorder",)
