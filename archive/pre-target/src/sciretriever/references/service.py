"""Deterministic resolution of stored and provider citation edges."""

from __future__ import annotations

from dataclasses import dataclass
from importlib import import_module
import re
from typing import Protocol

from sqlalchemy import func, insert, select, update

from sciretriever.catalog.engine import CatalogEngine
from sciretriever.catalog.models import (
    identifiers,
    version_references,
    work_version_identifiers,
    work_versions,
    works,
)
from sciretriever.core.contracts import Identifier
from sciretriever.core.ids import new_uuid4, validate_uuid
from sciretriever.core.timestamps import utc_now_rfc3339
from sciretriever.discovery.search_contracts import ExactMetadataOutput, ExactMetadataRequest
from sciretriever.errors import CatalogError
from sciretriever.integrations.graph import CitationEdge, GraphIdentifier, GraphIdentifierNamespace


_DOI_IN_TEXT = re.compile(r"10\.\d{4,9}/[-._;()/:a-z0-9]+", re.IGNORECASE)
_diagnostics_api = import_module(f"{__package__}.diagnostics")
ReferenceDiagnosticOwner = getattr(_diagnostics_api, "ReferenceDiagnosticOwner")


class ExactMetadataTargetResolver(Protocol):
    def resolve(self, request: ExactMetadataRequest) -> ExactMetadataOutput: ...


@dataclass(frozen=True, slots=True)
class ReferenceResolutionPolicy:
    providers: tuple[str, ...]
    precedence: tuple[str, ...]
    provider_timeout_seconds: float = 30.0
    max_concurrency: int = 4

    def request(self, doi: str) -> ExactMetadataRequest:
        return ExactMetadataRequest(
            doi,
            self.providers,
            self.precedence,
            self.provider_timeout_seconds,
            self.max_concurrency,
        )


@dataclass(frozen=True, slots=True)
class ReferenceResolutionResult:
    resolved: int = 0
    unresolved: int = 0
    conflicts: int = 0
    duplicates: int = 0
    local_cited_by: tuple[str, ...] = ()


class ReferenceResolutionService:
    """Resolve citation targets without replacing their original evidence."""

    def __init__(
        self,
        catalog: CatalogEngine,
        metadata: ExactMetadataTargetResolver,
        policy: ReferenceResolutionPolicy,
    ) -> None:
        if catalog.read_only:
            raise CatalogError("Reference resolution requires a writable catalog")
        self._catalog = catalog
        self._metadata = metadata
        self._policy = policy
        self._diagnostics = ReferenceDiagnosticOwner(catalog)

    def resolve_stored(self, work_version_id: str) -> ReferenceResolutionResult:
        work_version_id = validate_uuid(work_version_id, "work_version_id")
        with self._catalog.connect() as connection:
            rows = connection.execute(
                select(version_references).where(
                    version_references.c.citing_work_version_id == work_version_id,
                    version_references.c.cited_work_id.is_(None),
                ).order_by(version_references.c.reference_order, version_references.c.id)
            ).mappings().all()
        resolved = unresolved = conflicts = 0
        for row in rows:
            namespace = row["cited_namespace"]
            value = row["cited_value"]
            if not isinstance(namespace, str) or not isinstance(value, str):
                unresolved += 1
                self._diagnostics.append(work_version_id, False)
                continue
            identifier = Identifier(namespace, value)
            if self._has_identifier_conflict(identifier, row["raw_reference"]):
                conflicts += 1
                self._diagnostics.append(work_version_id, True)
                continue
            work_id = self._local_work(identifier)
            if work_id is None and identifier.namespace == "doi":
                work_id = self._remote_doi(identifier.value)
            if work_id is None:
                unresolved += 1
                self._diagnostics.append(work_version_id, False)
                continue
            with self._catalog.critical_transaction() as connection:
                connection.execute(
                    update(version_references).where(
                        version_references.c.id == row["id"],
                        version_references.c.cited_work_id.is_(None),
                    ).values(cited_work_id=work_id)
                )
            resolved += 1
        return ReferenceResolutionResult(resolved, unresolved, conflicts)

    def resolve_graph(
        self,
        seed_work_version_id: str,
        edges: tuple[CitationEdge, ...],
    ) -> ReferenceResolutionResult:
        seed_work_version_id = validate_uuid(seed_work_version_id, "seed_work_version_id")
        seed_work_id, seed_identifiers = self._seed(seed_work_version_id)
        local = self.local_cited_by(seed_work_id)
        unique_edges = tuple(sorted(set(edges)))
        duplicates = len(edges) - len(unique_edges)
        resolved = unresolved = conflicts = 0
        for edge in unique_edges:
            if edge.target in seed_identifiers:
                citing_version_id, conflict = self._graph_endpoint(edge.source)
                cited_work_id = seed_work_id
                identifier = edge.target
            elif edge.source in seed_identifiers:
                target_version_id, conflict = self._graph_endpoint(edge.target)
                citing_version_id = seed_work_version_id
                cited_work_id = self._work_id(target_version_id)
                identifier = edge.target
            else:
                unresolved += 1
                self._diagnostics.append(seed_work_version_id, False)
                continue
            if conflict:
                conflicts += 1
                self._diagnostics.append(seed_work_version_id, True)
                continue
            if citing_version_id is None or cited_work_id is None:
                unresolved += 1
                self._diagnostics.append(seed_work_version_id, False)
                continue
            if self._edge_exists(citing_version_id, cited_work_id):
                duplicates += 1
                continue
            self._insert_graph_edge(citing_version_id, cited_work_id, identifier)
            resolved += 1
        return ReferenceResolutionResult(resolved, unresolved, conflicts, duplicates, local)

    def local_cited_by(self, work_id: str) -> tuple[str, ...]:
        work_id = validate_uuid(work_id, "work_id")
        with self._catalog.connect() as connection:
            rows = connection.execute(
                select(work_versions.c.work_id)
                .join(
                    version_references,
                    version_references.c.citing_work_version_id == work_versions.c.id,
                )
                .where(version_references.c.cited_work_id == work_id)
                .distinct()
                .order_by(work_versions.c.work_id)
            ).scalars().all()
        return tuple(rows)

    def _local_work(self, identifier: Identifier) -> str | None:
        with self._catalog.connect() as connection:
            return connection.execute(
                select(identifiers.c.work_id).where(
                    identifiers.c.namespace == identifier.namespace,
                    identifiers.c.value == identifier.value,
                )
            ).scalar_one_or_none()

    def _remote_doi(self, doi: str) -> str | None:
        output = self._metadata.resolve(self._policy.request(doi))
        if output.result is None:
            return None
        exact = Identifier("doi", output.doi)
        if exact not in output.result.identifiers:
            return None
        return output.result.work_version.work_id

    @staticmethod
    def _has_identifier_conflict(identifier: Identifier, raw_reference: str) -> bool:
        if identifier.namespace != "doi":
            return False
        values = {Identifier("doi", match.group()).value for match in _DOI_IN_TEXT.finditer(raw_reference)}
        return bool(values and values != {identifier.value})

    def _seed(self, work_version_id: str) -> tuple[str, frozenset[GraphIdentifier]]:
        with self._catalog.connect() as connection:
            work_id = connection.execute(
                select(work_versions.c.work_id).where(work_versions.c.id == work_version_id)
            ).scalar_one()
            rows = connection.execute(
                select(work_version_identifiers.c.namespace, work_version_identifiers.c.value).where(
                    work_version_identifiers.c.work_version_id == work_version_id
                )
            ).tuples().all()
        graph_identifiers = frozenset(
            GraphIdentifier(GraphIdentifierNamespace(namespace), value)
            for namespace, value in rows
            if namespace in {item.value for item in GraphIdentifierNamespace}
        )
        return work_id, graph_identifiers

    def _graph_endpoint(self, endpoint: GraphIdentifier) -> tuple[str | None, bool]:
        local = self._local_work(Identifier(endpoint.namespace.value, endpoint.value))
        if local is not None:
            return self._preferred_version(local), False
        if endpoint.namespace is not GraphIdentifierNamespace.DOI:
            return None, False
        output = self._metadata.resolve(self._policy.request(endpoint.value))
        if output.result is None:
            return None, False
        exact = Identifier("doi", endpoint.value)
        if exact not in output.result.identifiers:
            return None, True
        return output.result.work_version.id, False

    def _preferred_version(self, work_id: str) -> str | None:
        with self._catalog.connect() as connection:
            return connection.execute(
                select(works.c.preferred_work_version_id).where(works.c.id == work_id)
            ).scalar_one()

    def _work_id(self, work_version_id: str | None) -> str | None:
        if work_version_id is None:
            return None
        with self._catalog.connect() as connection:
            return connection.execute(
                select(work_versions.c.work_id).where(work_versions.c.id == work_version_id)
            ).scalar_one()

    def _edge_exists(self, citing_version_id: str, cited_work_id: str) -> bool:
        with self._catalog.connect() as connection:
            return connection.execute(
                select(version_references.c.id).where(
                    version_references.c.citing_work_version_id == citing_version_id,
                    version_references.c.cited_work_id == cited_work_id,
                ).limit(1)
            ).scalar_one_or_none() is not None

    def _insert_graph_edge(
        self,
        citing_version_id: str,
        cited_work_id: str,
        identifier: GraphIdentifier,
    ) -> None:
        with self._catalog.critical_transaction() as connection:
            reference_order = connection.execute(
                select(func.coalesce(func.max(version_references.c.reference_order), -1) + 1).where(
                    version_references.c.citing_work_version_id == citing_version_id
                )
            ).scalar_one()
            connection.execute(insert(version_references).values(
                id=new_uuid4(), citing_work_version_id=citing_version_id,
                cited_work_id=cited_work_id, reference_order=reference_order,
                raw_reference="", cited_namespace=identifier.namespace.value,
                cited_value=identifier.value, source_artifact_id=None,
                locator_json=None, created_at=utc_now_rfc3339(),
            ))

__all__ = (
    "ExactMetadataTargetResolver",
    "ReferenceResolutionPolicy",
    "ReferenceResolutionResult",
    "ReferenceResolutionService",
)
