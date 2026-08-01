from __future__ import annotations

import contextlib
import io
import json
from dataclasses import dataclass
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any
from unittest import TestCase
from uuid import NAMESPACE_URL, uuid5

from sciretriever.cli.main import main
from sciretriever.catalog import WorkRepository, create_catalog_engine, initialize_catalog


@dataclass(frozen=True, slots=True)
class SeededTargetFacts:
    work_id: str
    version_id: str
    rejected_version_id: str
    light_version_id: str
    analysis_version_id: str
    collection_id: str
    batch_id: str
    light_query: str
    analysis_query: str


@dataclass(frozen=True, slots=True)
class MaterializedVersion:
    work_id: str
    work_version_id: str
    asset_outcome: str
    light_text: str | None
    analysis_text: str | None


class InMemoryTargetAdapter:
    def __init__(self, facts: SeededTargetFacts) -> None:
        self.facts = facts
        self.versions = {
            facts.version_id: MaterializedVersion(
                facts.work_id, facts.version_id, "accepted", None, None
            ),
            facts.rejected_version_id: MaterializedVersion(
                facts.work_id, facts.rejected_version_id, "rejected", None, None
            ),
            facts.light_version_id: MaterializedVersion(
                facts.work_id, facts.light_version_id, "accepted", facts.light_query, None
            ),
            facts.analysis_version_id: MaterializedVersion(
                facts.work_id,
                facts.analysis_version_id,
                "accepted",
                "complete light document without analysis token",
                facts.analysis_query,
            ),
        }
        self.collection_ids = {facts.collection_id}
        self.batch_ids = {facts.batch_id}
        self.provider_results = (
            ("provider-a", "succeeded"),
            ("provider-b", "succeeded"),
            ("provider-failed", "failed"),
        )

    def lookup_work(self, work_id: str) -> tuple[MaterializedVersion, ...]:
        return tuple(item for item in self.versions.values() if item.work_id == work_id)

    def search(self, query: str) -> tuple[MaterializedVersion, ...]:
        return tuple(
            item
            for item in self.versions.values()
            if query in (item.light_text, item.analysis_text)
        )

    def validate_dispatch(self, arguments: tuple[str, ...]) -> None:
        pairs = dict(zip(arguments, arguments[1:]))
        work_id = pairs.get("--work-id")
        version_id = pairs.get("--work-version-id")
        collection_id = pairs.get("--collection-id")
        batch_id = pairs.get("--batch-run-id")
        query = pairs.get("--query")
        if work_id is not None:
            assert self.lookup_work(work_id), f"unseeded Work selector: {work_id}"
        if version_id is not None:
            assert version_id in self.versions, f"unseeded WorkVersion selector: {version_id}"
        if collection_id is not None:
            assert collection_id in self.collection_ids, f"unseeded Collection selector: {collection_id}"
        if batch_id is not None:
            assert batch_id in self.batch_ids, f"unseeded Batch selector: {batch_id}"
        if query in (self.facts.light_query, self.facts.analysis_query):
            assert self.search(query), f"unsearchable seeded query: {query}"


@dataclass(frozen=True, slots=True)
class Invocation:
    code: int
    stdout: str
    stderr: str

    def json(self) -> dict[str, Any]:
        try:
            value = json.loads(self.stdout)
        except json.JSONDecodeError as error:
            raise AssertionError(
                f"target command emitted no canonical JSON: {self.stderr.strip()}"
            ) from error
        if not isinstance(value, dict):
            raise AssertionError("target command output is not one JSON object")
        return value


class TargetRequirementsFixture(TestCase):
    def setUp(self) -> None:
        self.temporary = TemporaryDirectory(prefix="sciretriever-target-requirements-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.catalog = self.root / "catalog.sqlite"
        self.storage = self.root / "storage"
        self.storage.mkdir()
        self.facts = self.seed_target_facts()
        self.target = InMemoryTargetAdapter(self.facts)
        engine = create_catalog_engine(self.catalog, allow_repository_write=True)
        initialize_catalog(engine)
        seeded = WorkRepository(engine).ingest_version(
            provider="fixture",
            provider_record_id="seed",
            title="Metadata-only Seed",
            doi="10.1000/old-json",
        )
        self.old_work_id = seeded.work_id
        engine.dispose()

    def invoke(self, *arguments: str) -> Invocation:
        self.target.validate_dispatch(arguments)
        return self._dispatch(arguments)

    def invoke_legacy(self, *arguments: str) -> Invocation:
        return self._dispatch(arguments)

    def _dispatch(self, arguments: tuple[str, ...]) -> Invocation:
        stdout = io.StringIO()
        stderr = io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            try:
                code = main(["--no-config", *arguments])
            except SystemExit as error:
                code = error.code if isinstance(error.code, int) else 1
        return Invocation(code, stdout.getvalue(), stderr.getvalue())

    def assert_succeeded(self, result: Invocation, operation: str) -> dict[str, Any]:
        payload = result.json()
        self.assertEqual(result.code, 0)
        self.assertEqual(payload.get("operation"), operation)
        self.assertEqual(payload.get("status"), "succeeded")
        return payload

    def write_bibtex(self) -> Path:
        source = self.root / "seed.bib"
        source.write_text(
            "@article{seed, title={Deterministic Seed}, author={Lovelace, Ada}, "
            "year={2024}, doi={10.1000/seed}}\n",
            encoding="utf-8",
        )
        return source

    def seed_target_facts(self) -> SeededTargetFacts:
        identifier = lambda name: str(uuid5(NAMESPACE_URL, f"urn:sciretriever:test:{name}"))
        facts = SeededTargetFacts(
            work_id=identifier("work"),
            version_id=identifier("accepted-version"),
            rejected_version_id=identifier("rejected-version"),
            light_version_id=identifier("light-version"),
            analysis_version_id=identifier("analysis-version"),
            collection_id=identifier("collection"),
            batch_id=identifier("batch"),
            light_query="needle-only-in-light-document",
            analysis_query="needle-only-in-analysis-proposal",
        )
        return facts

    def assert_closed_keys(self, value: dict[str, Any], expected: set[str]) -> None:
        self.assertEqual(set(value), expected)

    def show_version(self, version_id: str) -> dict[str, Any]:
        payload = self.assert_succeeded(
            self.invoke("library", "show", "--work-version-id", version_id),
            "library.show",
        )
        self.assertEqual(len(payload["items"]), 1)
        return payload["items"][0]
