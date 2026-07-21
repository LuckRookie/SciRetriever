import hashlib
import os
from typing import BinaryIO


DEFAULT_CHUNK_SIZE = 1024 * 1024


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_stream(
    fileobj: BinaryIO,
    *,
    chunk_size: int = DEFAULT_CHUNK_SIZE,
) -> str:
    if chunk_size <= 0:
        raise ValueError("chunk_size must be greater than zero")

    digest = hashlib.sha256()
    while chunk := fileobj.read(chunk_size):
        digest.update(chunk)
    return digest.hexdigest()


def sha256_file(
    path: str | os.PathLike[str],
    *,
    chunk_size: int = DEFAULT_CHUNK_SIZE,
) -> str:
    if chunk_size <= 0:
        raise ValueError("chunk_size must be greater than zero")

    with open(path, "rb") as fileobj:
        return sha256_stream(fileobj, chunk_size=chunk_size)
