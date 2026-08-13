"""ArtifactStore adapter for Analysis-owned Markdown publication.

Canonical Analysis Markdown is published as a private content-addressed file
only.  This module deliberately does not create a Catalog row or a
``LiteratureContent`` fact.
"""

from __future__ import annotations

from typing import NoReturn

from pydantic import ValidationError

from sciretriever.analysis.ports import StagedContentMarkdown
from sciretriever.model.analysis import ArtifactRef
from sciretriever.model.primitives import Sha256, sha256_digest
from sciretriever.storage.files.paths import StoragePathError, content_addressed_reference
from sciretriever.storage.files.store import (
    ArtifactReference,
    ArtifactStore,
    ArtifactStoreError,
)


class AnalysisArtifactPublicationError(RuntimeError):
    """Stable failure for Analysis Markdown byte publication."""

    _MESSAGE = "analysis artifact publication failed"

    def __init__(self, _message: object | None = None) -> None:
        super().__init__(self._MESSAGE)

    def __repr__(self) -> str:
        return "<AnalysisArtifactPublicationError>"


def _publication_failure() -> NoReturn:
    raise AnalysisArtifactPublicationError() from None


def _runtime_object(value: object) -> object:
    """Erase trusted static types before validating an external boundary."""

    return value


def _validated_staged(
    value: object,
    *,
    max_artifact_bytes: int,
) -> tuple[ArtifactRef, bytes]:
    if not isinstance(value, StagedContentMarkdown):
        _publication_failure()
    artifact_value = _runtime_object(value.artifact)
    payload_value = _runtime_object(value.content)
    if not isinstance(artifact_value, ArtifactRef) or type(payload_value) is not bytes:
        _publication_failure()
    artifact = artifact_value
    payload = payload_value
    digest = _runtime_object(artifact.sha256)
    if (
        not payload
        or len(payload) > max_artifact_bytes
        or artifact.media_type != "text/markdown"
        or type(artifact.byte_size) is not int
        or artifact.byte_size != len(payload)
        or not isinstance(digest, Sha256)
        or artifact.sha256 != sha256_digest(payload)
    ):
        _publication_failure()
    try:
        checked = ArtifactRef.model_validate(artifact.model_dump())
    except (ValidationError, TypeError, ValueError):
        _publication_failure()
    if checked != artifact:
        _publication_failure()
    return checked, payload


class AnalysisArtifactPublisher:
    """Create or reuse one private immutable Analysis Markdown object."""

    __slots__ = ("_store",)

    def __init__(self, store: ArtifactStore) -> None:
        store_value = _runtime_object(store)
        if not isinstance(store_value, ArtifactStore):
            raise TypeError("store must be an ArtifactStore")
        self._store = store_value

    def __repr__(self) -> str:
        return "<AnalysisArtifactPublisher>"

    def publish_markdown(self, staged: StagedContentMarkdown) -> ArtifactRef:
        """Publish bytes create-if-absent without registering a Catalog fact."""

        try:
            expected, payload = _validated_staged(
                staged,
                max_artifact_bytes=self._store.max_artifact_bytes,
            )
            published_value = _runtime_object(
                self._store.publish(
                    payload,
                    sha256=expected.sha256,
                    byte_size=expected.byte_size,
                    media_type=expected.media_type,
                )
            )
            if not isinstance(published_value, ArtifactReference):
                _publication_failure()
            published = published_value
            if (
                published.sha256 != expected.sha256
                or published.byte_size != expected.byte_size
                or published.media_type != expected.media_type
                or published.path
                != content_addressed_reference(expected.sha256, expected.byte_size)
            ):
                _publication_failure()
            result = ArtifactRef(
                sha256=published.sha256,
                media_type=published.media_type,
                byte_size=published.byte_size,
            )
            if result != expected:
                _publication_failure()
            return result
        except AnalysisArtifactPublicationError:
            raise
        except (
            ArtifactStoreError,
            StoragePathError,
            ValidationError,
            TypeError,
            ValueError,
        ):
            _publication_failure()
        except Exception:
            _publication_failure()


__all__ = ("AnalysisArtifactPublicationError", "AnalysisArtifactPublisher")
