from __future__ import annotations

from contextlib import ExitStack, contextmanager
from dataclasses import dataclass, field
from typing import Iterator
from unittest.mock import patch
from uuid import UUID, uuid5


IDENTITY_NAMESPACE = UUID("8b4ec360-925d-5de7-bb62-7249d4f73d3b")
STRING_ID_MODULES = (
    "sciretriever.core.ids",
    "sciretriever.references.service",
    "sciretriever.storage.coordinator",
    "sciretriever.storage.derived",
    "sciretriever.storage.manager",
    "sciretriever.catalog.library",
    "sciretriever.catalog.diagnostics",
    "sciretriever.catalog.parser_attempts",
    "sciretriever.catalog.assets",
    "sciretriever.catalog.domain_runs",
    "sciretriever.catalog.repository",
    "sciretriever.catalog.analysis",
    "sciretriever.catalog.identity",
    "wp6_acceptance_curation",
)
UUID_ID_MODULES = (
    "sciretriever.core.export_publication",
    "sciretriever.normalization.mineru_client",
    "sciretriever.catalog.preferred_curation",
    "sciretriever.catalog.author_curation",
    "sciretriever.catalog.manual_metadata_curation",
    "sciretriever.catalog.review_curation",
    "sciretriever.catalog.manual_tag_curation",
    "sciretriever.catalog.work_curation",
    "sciretriever.catalog.curation",
)


@dataclass(slots=True)
class DeterministicIdentitySource:
    counter: int = 0
    issued: set[UUID] = field(default_factory=set)

    def next_uuid(self) -> UUID:
        self.counter += 1
        value = uuid5(IDENTITY_NAMESPACE, str(self.counter))
        if value in self.issued:
            raise AssertionError("deterministic identity collision")
        self.issued.add(value)
        return value

    def next_string(self) -> str:
        return str(self.next_uuid())


@contextmanager
def fixed_identities() -> Iterator[DeterministicIdentitySource]:
    from wp6_acceptance_runtime import (
        AssetAcceptanceCoordinator, DerivedArtifactStore, RawAssetStore,
    )

    source = DeterministicIdentitySource()
    with ExitStack() as stack:
        for module in STRING_ID_MODULES:
            stack.enter_context(patch(f"{module}.new_uuid4", side_effect=source.next_string))
        for module in UUID_ID_MODULES:
            stack.enter_context(patch(f"{module}.uuid4", side_effect=source.next_uuid))
        captured_namespaces = {
            id(namespace): namespace for namespace in (
                AssetAcceptanceCoordinator.accept.__globals__,
                DerivedArtifactStore.publish_bytes.__globals__,
                RawAssetStore.stage.__globals__,
            )
        }
        for namespace in captured_namespaces.values():
            stack.enter_context(patch.dict(namespace, new_uuid4=source.next_string))
        yield source


__all__ = ("DeterministicIdentitySource", "fixed_identities")
