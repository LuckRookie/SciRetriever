from __future__ import annotations

import os

from sciretriever.literature_store.sqlite.engine import create_or_open_catalog
from sciretriever.literature_store.sqlite.literature_curation import (
    load_curation_snapshot,
    load_curation_topology,
)
from sciretriever.literature_store.sqlite.literature_facts import (
    get_version_facts,
    get_work_facts,
)
from sciretriever.literature_store.sqlite.literature_identity import (
    find_identity_candidates,
    list_identity_records,
    list_observations,
)
from sciretriever.model.library import (
    CurationScope,
    CurationSnapshot,
    CurationTopology,
    ValidatedVersionRelation,
)
from sciretriever.model.literature import (
    IdentityCandidateQuery,
    IdentityCandidateSet,
    IdentityRecord,
    StoredObservation,
    VersionFacts,
    WorkFacts,
)
from sciretriever.model.primitives import WorkId, WorkVersionId


class SqliteLiteratureRepository:
    def __init__(self, catalog_path: str | os.PathLike[str]) -> None:
        self._catalog_path = catalog_path

    def find_identity_candidates(self, query: IdentityCandidateQuery) -> IdentityCandidateSet:
        return find_identity_candidates(self._catalog_path, query)

    def get_work_facts(self, work_id: WorkId) -> WorkFacts | None:
        return get_work_facts(self._catalog_path, work_id)

    def get_version_facts(self, version_id: WorkVersionId) -> VersionFacts | None:
        return get_version_facts(self._catalog_path, version_id)

    def load_curation_snapshot(self, scope: CurationScope) -> CurationSnapshot:
        return load_curation_snapshot(self._catalog_path, scope)

    def load_curation_topology(self) -> CurationTopology:
        return load_curation_topology(self._catalog_path)

    def add_version_relation(self, relation: ValidatedVersionRelation) -> None:
        with create_or_open_catalog(self._catalog_path) as connection:
            connection.execute(
                "INSERT INTO work_version_relations(id,left_version_id,right_version_id,"
                "relation) VALUES(?,?,?,?)",
                (
                    str(relation.relation_id),
                    str(relation.left_version_id),
                    str(relation.right_version_id),
                    relation.relation,
                ),
            )
            connection.commit()

    def list_identity_records(self) -> tuple[IdentityRecord, ...]:
        return list_identity_records(self._catalog_path)

    def list_observations(self, version_id: WorkVersionId) -> tuple[StoredObservation, ...]:
        return list_observations(self._catalog_path, version_id)
