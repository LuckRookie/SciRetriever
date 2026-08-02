from __future__ import annotations

import os
import sqlite3
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from sciretriever.bibliography.model import (
    CurationScope,
    IdentifierMove,
    MembershipMove,
    ObservationMove,
    ReferenceRetarget,
    RelationRetarget,
    ValidatedCurationPlan,
)
from sciretriever.literature_store.sqlite import (
    SqliteBibliographyRepository,
    SqliteCurationTransaction,
    create_or_open_catalog,
)
from sciretriever.model.primitives import (
    CurationPlanId,
    MembershipId,
    ObservationId,
    ReferenceFactId,
    StableIdentifierId,
    VersionRelationId,
    WorkId,
    WorkVersionId,
)

UUIDS = tuple(f"20000000-0000-4000-8000-{value:012d}" for value in range(1, 50))


class TargetStorePortSecondRepairTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = TemporaryDirectory(prefix="sciretriever-task8-second-repair-")
        self.root = Path(self.temporary.name)
        os.chmod(self.root, 0o700)
        self.catalog = self.root / "catalog.sqlite"
        with create_or_open_catalog(self.catalog):
            pass

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def seed_source_matrix(self) -> CurationScope:
        works = tuple(WorkId(UUIDS[index]) for index in range(4))
        versions = tuple(WorkVersionId(UUIDS[index]) for index in range(4, 8))
        with create_or_open_catalog(self.catalog) as connection:
            connection.executemany(
                "INSERT INTO works(id) VALUES(?)", ((str(value),) for value in works)
            )
            connection.executemany(
                "INSERT INTO work_versions(id,work_id,version_role) VALUES(?,?,'formal')",
                ((str(version), str(work)) for version, work in zip(versions, works, strict=True)),
            )
            connection.execute(
                "INSERT INTO metadata_observations("
                "id,work_version_id,provider,provider_record_id,payload_sha256,payload_json,"
                "observed_at) VALUES(?,?,'p','r',?,'{}','2026-01-01T00:00:00Z')",
                (UUIDS[8], str(versions[2]), "0" * 64),
            )
            connection.execute(
                "INSERT INTO stable_identifiers(id,work_version_id,namespace,value) "
                "VALUES(?,?,'doi','10.1/out')",
                (UUIDS[9], str(versions[2])),
            )
            connection.execute("INSERT INTO collections(id,name) VALUES(?,'outside')", (UUIDS[10],))
            connection.execute(
                "INSERT INTO collection_runs(id,collection_id,mode,topic_conditions_json,"
                "requested_advance_to,status) "
                "VALUES(?,?,'topic','{}','completed','completed')",
                (UUIDS[11], UUIDS[10]),
            )
            connection.execute(
                "INSERT INTO collection_memberships("
                "id,collection_id,work_id,first_collection_run_id) VALUES(?,?,?,?)",
                (UUIDS[12], UUIDS[10], str(works[2]), UUIDS[11]),
            )
            connection.execute(
                "INSERT INTO reference_sets(id,work_version_id,revision,complete) VALUES(?,?,1,1)",
                (UUIDS[13], str(versions[2])),
            )
            connection.execute(
                "INSERT INTO reference_members(id,reference_set_id,ordinal,reference_json) "
                "VALUES(?,?,0,'{}')",
                (UUIDS[14], UUIDS[13]),
            )
            connection.execute(
                "INSERT INTO work_version_relations("
                "id,left_version_id,right_version_id,relation) VALUES(?,?,?,'related')",
                (UUIDS[15], str(versions[2]), str(versions[3])),
            )
            connection.commit()
        self.works, self.versions = works, versions
        return CurationScope(works[:2], versions[:2])

    def plan(self, scope: CurationScope, **changes) -> ValidatedCurationPlan:
        token = SqliteBibliographyRepository(self.catalog).load_curation_snapshot(scope).token
        return ValidatedCurationPlan(CurationPlanId(UUIDS[20]), scope, token, **changes)

    def test_each_unscoped_source_family_rejects_without_owner_change(self) -> None:
        scope = self.seed_source_matrix()
        plans = (
            self.plan(
                scope,
                observation_moves=(ObservationMove(ObservationId(UUIDS[8]), self.versions[0]),),
            ),
            self.plan(
                scope,
                identifier_moves=(IdentifierMove(StableIdentifierId(UUIDS[9]), self.versions[0]),),
            ),
            self.plan(
                scope,
                membership_moves=(MembershipMove(MembershipId(UUIDS[12]), self.works[0], None),),
            ),
            self.plan(
                scope,
                reference_retargets=(
                    ReferenceRetarget(
                        ReferenceFactId(UUIDS[14]), self.works[0], self.versions[0], None, None
                    ),
                ),
            ),
            self.plan(
                scope,
                relation_retargets=(
                    RelationRetarget(
                        VersionRelationId(UUIDS[15]), self.versions[0], self.versions[1]
                    ),
                ),
            ),
        )
        for plan in plans:
            with self.subTest(plan=plan.plan_id), self.assertRaises(sqlite3.IntegrityError):
                SqliteCurationTransaction(self.catalog).apply(plan)
        with create_or_open_catalog(self.catalog) as connection:
            owners = (
                connection.execute(
                    "SELECT work_version_id FROM metadata_observations WHERE id=?", (UUIDS[8],)
                ).fetchone()[0],
                connection.execute(
                    "SELECT work_version_id FROM stable_identifiers WHERE id=?", (UUIDS[9],)
                ).fetchone()[0],
                connection.execute(
                    "SELECT work_id FROM collection_memberships WHERE id=?", (UUIDS[12],)
                ).fetchone()[0],
            )
        self.assertEqual(owners, (str(self.versions[2]), str(self.versions[2]), str(self.works[2])))

    def seed_accepted_asset(self) -> CurationScope:
        work, version = WorkId(UUIDS[0]), WorkVersionId(UUIDS[1])
        with create_or_open_catalog(self.catalog) as connection:
            connection.execute("INSERT INTO works(id) VALUES(?)", (str(work),))
            connection.execute(
                "INSERT INTO work_versions(id,work_id,version_role) VALUES(?,?,'formal')",
                (str(version), str(work)),
            )
            connection.execute(
                "INSERT INTO artifacts(id,kind,sha256,storage_path,byte_size,media_type) "
                "VALUES(?,'raw',?,'raw/a.pdf',3,'application/pdf')",
                (UUIDS[2], "1" * 64),
            )
            connection.execute(
                "INSERT INTO raw_assets(artifact_id,asset_role,source_json) "
                "VALUES(?,'primary-pdf','{}')",
                (UUIDS[2],),
            )
            connection.execute(
                "INSERT INTO work_version_assets(id,work_version_id,artifact_id,role) "
                "VALUES(?,?,?,'primary-pdf')",
                (UUIDS[3], str(version), UUIDS[2]),
            )
            connection.execute(
                "INSERT INTO accepted_primary_assets(work_version_id,work_version_asset_id) "
                "VALUES(?,?)",
                (str(version), UUIDS[3]),
            )
            connection.commit()
        return CurationScope((work,), (version,))

    def test_artifact_and_raw_asset_mutations_each_stale_snapshot(self) -> None:
        scope = self.seed_accepted_asset()
        repository = SqliteBibliographyRepository(self.catalog)
        original = repository.load_curation_snapshot(scope).token
        with create_or_open_catalog(self.catalog) as connection:
            connection.execute(
                "UPDATE artifacts SET media_type='application/octet-stream' WHERE id=?", (UUIDS[2],)
            )
            connection.commit()
        artifact_changed = repository.load_curation_snapshot(scope).token
        with create_or_open_catalog(self.catalog) as connection:
            connection.execute(
                "UPDATE raw_assets SET source_json='{\"changed\":true}' WHERE artifact_id=?",
                (UUIDS[2],),
            )
            connection.commit()
        self.assertNotEqual(original, artifact_changed)
        self.assertNotEqual(artifact_changed, repository.load_curation_snapshot(scope).token)

    def test_reference_pair_mismatch_rolls_back_and_matching_pair_commits(self) -> None:
        scope = self.seed_source_matrix()
        with create_or_open_catalog(self.catalog) as connection:
            connection.execute("DELETE FROM reference_members WHERE id=?", (UUIDS[14],))
            connection.execute("DELETE FROM reference_sets WHERE id=?", (UUIDS[13],))
            connection.execute(
                "INSERT INTO reference_sets(id,work_version_id,revision,complete) VALUES(?,?,1,1)",
                (UUIDS[13], str(self.versions[0])),
            )
            connection.execute(
                "INSERT INTO reference_members(id,reference_set_id,ordinal,reference_json) "
                "VALUES(?,?,0,'{}')",
                (UUIDS[14], UUIDS[13]),
            )
            connection.commit()
        mismatch = self.plan(
            scope,
            reference_retargets=(
                ReferenceRetarget(
                    ReferenceFactId(UUIDS[14]),
                    self.works[0],
                    self.versions[1],
                    None,
                    None,
                ),
            ),
        )
        with self.assertRaises(sqlite3.IntegrityError):
            SqliteCurationTransaction(self.catalog).apply(mismatch)
        valid = self.plan(
            scope,
            reference_retargets=(
                ReferenceRetarget(
                    ReferenceFactId(UUIDS[14]),
                    self.works[1],
                    self.versions[1],
                    None,
                    None,
                ),
            ),
        )
        SqliteCurationTransaction(self.catalog).apply(valid)
        with create_or_open_catalog(self.catalog) as connection:
            target = connection.execute(
                "SELECT target_work_id,target_work_version_id FROM reference_members WHERE id=?",
                (UUIDS[14],),
            ).fetchone()
        self.assertEqual(target, (str(self.works[1]), str(self.versions[1])))


if __name__ == "__main__":
    unittest.main()
