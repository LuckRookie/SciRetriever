import json
import sys
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import cast
from unittest import TestCase

from sqlalchemy import insert


REPOSITORY = Path(__file__).resolve().parents[1]
SRC = REPOSITORY / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from sciretriever.catalog import (
    AuthorRepository,
    LibraryFilters,
    LibraryReadRepository,
    ReferenceRepository,
    RegistryRepository,
    TagRepository,
    WorkRepository,
    create_catalog_engine,
    initialize_catalog,
    open_read_only_catalog_engine,
)
from sciretriever.catalog.models import metadata_observations, work_version_identifiers
from sciretriever.catalog.repository import canonical_json
from sciretriever.core.contracts import Identifier
from sciretriever.core.ids import new_uuid4
from sciretriever.core.timestamps import utc_now_rfc3339


class LibraryWp2Fixture(TestCase):
    def setUp(self) -> None:
        self.temporary_directory = TemporaryDirectory()
        self.addCleanup(self.temporary_directory.cleanup)
        self.path = Path(self.temporary_directory.name) / "catalog.sqlite"
        writable = create_catalog_engine(self.path, allow_repository_write=True)
        initialize_catalog(writable)
        works = WorkRepository(writable)
        registries = RegistryRepository(writable)
        publisher = registries.add("publisher", "Science Press", ("Sci Press",))
        venue = registries.add("venue", "Journal of Energy", ("J Energy",))

        self.target = works.ingest_version(
            provider="secret-provider", provider_record_id="provider-target",
            title="Solid Electrolyte Interfaces", doi="https://doi.org/10.1000/TARGET",
            version_class="formal_publication", publisher_id=publisher.id, venue_id=venue.id,
            metadata={"abstract": "A canonical solid electrolyte abstract", "publication_year": 2024,
                      "language": "en", "work_type": "article", "volume": "7", "issue": "2",
                      "pages": "1-9", "article_number": "A7", "open_access_status": "open"},
        )
        AuthorRepository(writable).add_authorship(self.target.id, "Ada Lovelace", 0)
        tag = TagRepository(writable).add("battery materials", aliases=("Battery",))
        from manual_curation_fixture import add_manual_tag
        add_manual_tag(writable, self.target.work_id, tag.id)

        self.preprint = works.ingest_version(
            provider="secret-provider", provider_record_id="provider-preprint",
            title="Earlier Interface Draft", doi="10.1000/preprint", version_class="preprint",
        )
        self.formal = works.ingest_version(
            provider="secret-provider", provider_record_id="provider-formal",
            title="Interface Reference Source", doi="10.1000/formal",
            version_class="formal_publication", related_work_version_id=self.preprint.id,
            relation_evidence={"source": "backend-only"}, metadata={"publication_year": 2023},
        )
        self.ambiguous_one = works.ingest_version(
            provider="p", provider_record_id="amb-1", title="Ambiguous_Title", doi="10.1000/amb-1",
        )
        self.ambiguous_two = works.ingest_version(
            provider="p", provider_record_id="amb-2", title="Ambiguous Title", doi="10.1000/amb-2",
        )
        self.literal = works.ingest_version(
            provider="p", provider_record_id="literal", title=r"Percent 100% Under_score Back\slash",
            doi="10.1000/literal", metadata={"publication_year": 2022},
        )
        self.citing_preprint = works.ingest_version(
            provider="p", provider_record_id="citing-preprint",
            title="Nonpreferred Citing Draft", doi="10.1000/citing-preprint",
            version_class="preprint",
        )
        self.citing_formal = works.ingest_version(
            provider="p", provider_record_id="citing-formal",
            title="Preferred Citing Publication", doi="10.1000/citing-formal",
            version_class="formal_publication", related_work_version_id=self.citing_preprint.id,
            relation_evidence={"source": "version-link"},
        )

        ReferenceRepository(writable).add(
            self.formal.id, 0, "target raw secret", cited_work_id=self.target.work_id,
            identifier=Identifier("doi", "10.1000/target"),
        )
        ReferenceRepository(writable).add(
            self.target.id, 0, "ambiguous one raw", cited_work_id=self.ambiguous_one.work_id,
        )
        ReferenceRepository(writable).add(
            self.target.id, 1, "ambiguous two raw", cited_work_id=self.ambiguous_two.work_id,
        )
        ReferenceRepository(writable).add(
            self.citing_preprint.id, 0, "target from nonpreferred version",
            cited_work_id=self.target.work_id,
        )
        with writable.critical_transaction() as connection:
            for namespace, value in (
                ("arxiv", "2401.00001"),
                ("pmid", "12345678"),
                ("openalex", "SECRET-OPENALEX-ID"),
            ):
                connection.execute(insert(work_version_identifiers).values(
                    id=new_uuid4(), work_version_id=self.target.id,
                    namespace=namespace, value=value, created_at=utc_now_rfc3339(),
                ))
            connection.execute(insert(metadata_observations).values(
                id=new_uuid4(), work_version_id=self.target.id, provider="leaking-provider",
                provider_record_id="SECRET-RECORD", field_name="private_backend_key",
                value_json=canonical_json("solid electrolyte hidden observation"),
                provenance_json=canonical_json({"raw_path": "/secret/path", "hash": "SECRET-HASH"}),
                observed_at=utc_now_rfc3339(),
            ))
        writable.dispose()
        self.catalog = open_read_only_catalog_engine(self.path)
        self.addCleanup(self.catalog.dispose)
        self.library = LibraryReadRepository(self.catalog)

    def counts(self) -> dict[str, int]:
        names = (
            "works", "work_versions", "work_version_identifiers", "metadata_observations",
            "authors", "authorships", "publishers", "venues", "tags", "manual_work_tags",
            "version_references", "raw_assets", "normalized_artifacts",
        )
        with self.catalog.connect() as connection:
            return {name: connection.exec_driver_sql(f'SELECT count(*) FROM "{name}"').scalar_one()
                    for name in names}
