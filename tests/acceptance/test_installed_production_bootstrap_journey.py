from __future__ import annotations

import base64
import hashlib
import io
import json
import os
import sqlite3
import stat
import unittest
import zipfile
from pathlib import Path
from typing import Any

from PyPDF2 import PdfWriter

from tests.acceptance.helpers.installed_wheel import InstalledWheel


class InstalledProductionBootstrapJourneyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.fixture = InstalledWheel()
        cls.install = cls.fixture.__enter__()
        helper = Path(__file__).parent / "helpers"
        cls.install.install_sitecustomize(helper / "sitecustomize_production_fixture.py")
        cls.install.install_startup_fixture(
            helper / "sciretriever_acceptance_transport.py",
        )

    @classmethod
    def tearDownClass(cls) -> None:
        cls.fixture.__exit__(None, None, None)

    def test_installed_asset_completion_uses_the_shared_acquisition_runtime(self) -> None:
        assert self.install.root is not None
        root = self.install.root / "production-acquisition-graph"
        root.mkdir(mode=0o700)
        script = """
import json
import os
from pathlib import Path
from unittest import mock

from sciretriever.bootstrap import (
    DatabaseCompletionObjectGraph,
    ProductionEntryScope,
    build_production_object_graph,
)
from sciretriever.configuration import parse_configuration
from sciretriever.network.browser_scheduler import BrowserGroupScheduler
from sciretriever.network.browser_sessions import BrowserSessionBroker
from sciretriever.network.http import SecureHttpTransport, SystemResolver

root = Path(os.environ["SCIRETRIEVER_P76_ROOT"])
configuration = parse_configuration(
    "[paths]\\n"
    + f"catalog_path = {str(root / 'catalog.sqlite3')!r}\\n"
    + f"artifact_root = {str(root / 'artifacts')!r}\\n"
    + "[execution]\\nmax_concurrency = 5\\n"
    + "[access]\\nbrowser_enabled = true\\n"
    + 'browser_profile = "research"\\n'
    + "browser_max_concurrency = 3\\n"
)
forbidden = AssertionError("installed production assembly performed external I/O")
with (
    mock.patch.object(SystemResolver, "resolve", side_effect=forbidden),
    mock.patch.object(SecureHttpTransport, "send", side_effect=forbidden),
    mock.patch.object(BrowserSessionBroker, "acquire", side_effect=forbidden),
    mock.patch.object(BrowserGroupScheduler, "execute", side_effect=forbidden),
):
    graph = build_production_object_graph(
        configuration,
        scope=ProductionEntryScope.ASSET_COMPLETION,
        credentials_home=root / "home",
        configure_process_logging=False,
    )

runtime = graph.acquisition_runtime
registry = graph.acquisition_registry
service = graph.acquisition_api._service
evidence = {
    "graph_type": isinstance(graph, DatabaseCompletionObjectGraph),
    "coordinator": graph.http_client._coordinator is graph.access_coordinator,
    "catalog": registry.profile_catalog is registry.route_registry.profile_catalog,
    "planner_catalog": registry.planner.profile_catalog is registry.profile_catalog,
    "service_registry": service._route_registry is registry.route_registry,
    "service_planner": service._planner is registry.planner,
    "service_executor": service._cohort_executor is runtime.cohort_executor,
    "executor_admission": (
        runtime.cohort_executor._browser_admission is runtime.browser_admission
    ),
    "executor_scheduler": (
        runtime.cohort_executor._browser_scheduler is runtime.browser_scheduler
    ),
    "cohort_concurrency": runtime.cohort_executor._max_concurrency == 5,
    "browser_concurrency": runtime.browser_scheduler._max_concurrency == 3,
    "broker_unused": runtime.browser_session_broker._entries == {},
    "scheduler_unused": runtime.browser_scheduler._policies == {},
    "browser_unavailable": graph.browser_client is None,
    "browser_switch": runtime.browser_admission._configuration.explicitly_enabled,
    "browser_unconfirmed": (
        not runtime.browser_admission._configuration.execution_confirmed
        and not runtime.browser_admission._configuration.runtime_ready
    ),
    "browser_routes": not any(
        binding.spec.tier.value == "controlled-browser"
        for binding in registry.route_registry.bindings
    ),
}
runtime.browser_session_broker.close()
print(json.dumps(evidence, sort_keys=True))
"""
        result = self.install.run_python(
            ("-I", "-c", script),
            environment={"SCIRETRIEVER_P76_ROOT": os.fspath(root)},
            cwd=root,
        )

        self.assertEqual(result.returncode, 0, result.stderr_text)
        self.assertEqual(result.stderr, b"")
        evidence = json.loads(result.stdout)
        self.assertTrue(all(evidence.values()), evidence)
        self.assertFalse((root / "production-wire.ndjson").exists())

    def test_real_console_uses_production_bootstrap_for_discovery_and_completion(self) -> None:
        assert self.install.root is not None
        root = self.install.root / "production-bootstrap"
        root.mkdir(mode=0o700)
        catalog = root / "catalog.sqlite3"
        artifacts = root / "artifacts"
        pdf = _pdf()
        (self.install.root / "input.pdf").write_bytes(pdf)
        configuration = root / "config.toml"
        configuration.write_text(
            _configuration(catalog, artifacts),
            encoding="utf-8",
        )
        self._write_llm_credentials()
        environment = {
            "SCIRETRIEVER_CONFIG": os.fspath(configuration),
            "SCIRETRIEVER_TEST_MINERU_ARCHIVE": base64.b64encode(_mineru_archive()).decode("ascii"),
            "SCIRETRIEVER_TEST_PRODUCTION_FIXTURE": "1",
        }

        topic = self._json(
            ("discover", "topic", "production bootstrap", "--json"),
            environment,
            root,
            expected_log_events=(
                "discovery-started",
                "metadata-provider-failed",
                "discovery-finished",
            ),
        )
        self.assertEqual(
            topic["run_status"],
            "PARTIAL",
            json.dumps(topic, ensure_ascii=False, sort_keys=True),
        )
        self.assertEqual(topic["discovery_result_count"], 1)
        self.assertEqual(topic["new_metadata_observation_count"], 3)
        self.assertEqual(
            [
                (
                    item["provider_name"],
                    item["raw_item_count"],
                    item["accepted_observation_count"],
                    item["outcome"],
                )
                for item in topic["providers"]
            ],
            [
                ("crossref", 1, 1, "FAILED"),
                ("semantic-scholar", 2, 2, "SCAN_LIMIT_REACHED"),
            ],
        )
        search = self._json(("literature", "search", "--json"), environment, root)
        self.assertEqual(search["total_count"], 1)
        seed = search["items"][0]["literature"]["literature_id"]
        topic_detail = self._json(("literature", "show", seed, "--json"), environment, root)
        self.assertCountEqual(
            [
                observation["provenance"]["source_name"]
                for observation in topic_detail["metadata_observations"]
            ],
            ["crossref", "semantic-scholar", "semantic-scholar"],
        )

        citation = self._json(
            (
                "discover",
                "citations",
                "--seed-literature-id",
                seed,
                "--direction",
                "references",
                "--max-depth",
                "1",
                "--result-limit",
                "1",
                "--json",
            ),
            environment,
            root,
        )
        self.assertEqual(citation["run_status"], "COMPLETED")
        self.assertEqual(
            citation["discovery_result_count"],
            1,
            json.dumps(citation, ensure_ascii=False, sort_keys=True),
        )

        completion = self._json(
            ("complete", "content", "--literature-id", seed, "--json"),
            environment,
            root,
            timeout=60,
            expected_log_events=(
                "completion-started",
                "completion-target-finished",
                "completion-finished",
            ),
        )
        self.assertEqual(completion["end"], {"kind": "finished"})
        self.assertEqual(len(completion["goal_reached"]), 1)
        detail = self._json(("literature", "show", seed, "--json"), environment, root)
        self.assertEqual(detail["literature"]["status"], "CONTENT_READY")
        self.assertIsNotNone(detail["primary_pdf"])
        self.assertIsNotNone(detail["parser_result"])
        self.assertIsNotNone(detail["content"])

        wire_before_local_reads = self._wire_request_count()
        references = self._json(
            ("literature", "references", seed, "--json"),
            environment,
            root,
        )
        self.assertEqual(references["total_count"], 1)
        citation_target = references["items"][0]["reference"]["target_literature_id"]
        cited_by = self._json(
            ("literature", "cited-by", citation_target, "--json"),
            environment,
            root,
        )
        self.assertEqual(cited_by["total_count"], 1)
        self.assertEqual(
            cited_by["items"][0]["reference"]["source_literature_id"],
            seed,
        )

        pdf_target = root / "exported.pdf"
        content_target = root / "exported.md"
        self.assertIs(
            self._json(
                ("export", "pdf", seed, os.fspath(pdf_target), "--json"),
                environment,
                root,
            ),
            True,
        )
        self.assertIs(
            self._json(
                ("export", "content", seed, os.fspath(content_target), "--json"),
                environment,
                root,
            ),
            True,
        )
        self.assertEqual(pdf_target.read_bytes(), pdf)
        self.assertEqual(
            hashlib.sha256(pdf_target.read_bytes()).hexdigest(),
            detail["primary_pdf"]["asset"]["sha256"],
        )
        content_bytes = content_target.read_bytes()
        self.assertEqual(
            hashlib.sha256(content_bytes).hexdigest(),
            detail["content"]["markdown"]["sha256"],
        )
        self.assertIn("# 研究背景与目标".encode(), content_bytes)
        self.assertEqual(self._wire_request_count(), wire_before_local_reads)

        requests = [
            json.loads(line)
            for line in (self.install.root / "production-wire.ndjson")
            .read_text(encoding="utf-8")
            .splitlines()
        ]
        request_hosts = [item["host"] for item in requests if item["kind"] == "request"]
        self.assertIn("api.semanticscholar.org", request_hosts)
        self.assertIn("api.crossref.org", request_hosts)
        self.assertIn("assets.example.org", request_hosts)
        self.assertIn("127.0.0.1", request_hosts)
        self.assertIn("api.openai.com", request_hosts)

    def test_write_admission_integrity_failure_is_stable_and_redacted(self) -> None:
        assert self.install.root is not None
        root = self.install.root / "write-admission-failure"
        root.mkdir(mode=0o700)
        catalog = root / "catalog.sqlite3"
        artifacts = root / "artifacts"
        configuration = root / "config.toml"
        configuration.write_text(
            _local_configuration(catalog, artifacts),
            encoding="utf-8",
        )
        environment = {"SCIRETRIEVER_CONFIG": os.fspath(configuration)}

        initialized = self.install.run_console(
            ("literature", "search", "--json"),
            environment=environment,
            cwd=root,
        )
        self.assertEqual(initialized.returncode, 0, initialized.stderr_text)
        self.assertEqual(initialized.stderr, b"")

        malformed = artifacts / ".objects" / "zz"
        malformed.mkdir(parents=True, mode=0o700)
        result = self.install.run_console(
            ("complete", "pdf", "--all-pending", "--json"),
            environment=environment,
            cwd=root,
        )

        self.assertEqual(result.returncode, 3, result.stderr_text)
        self.assertIn("event=completion-failed", result.stderr_text)
        self.assertIn("code=write-admission-failed", result.stderr_text)
        self.assertIn("reason=", result.stderr_text)
        self.assertIn("action=", result.stderr_text)
        report = json.loads(result.stdout)
        self.assertEqual(report["kind"], "database-completion")
        self.assertEqual(report["end"]["kind"], "failed")
        self.assertEqual(report["end"]["failure"]["code"], "write-admission-failed")
        rendered = result.stdout_text + result.stderr_text
        for unsafe in (
            "Traceback",
            "ArtifactReconciliation",
            os.fspath(root),
            os.fspath(malformed),
        ):
            self.assertNotIn(unsafe, rendered)
        with sqlite3.connect(catalog) as connection:
            self.assertEqual(
                connection.execute("SELECT count(*) FROM discovery_runs").fetchone(),
                (0,),
            )

    def test_real_console_persists_exhaustion_then_admits_a_manual_pdf(self) -> None:
        assert self.install.root is not None
        root = self.install.root / "production-manual-pdf"
        root.mkdir(mode=0o700)
        catalog = root / "catalog.sqlite3"
        artifacts = root / "artifacts"
        configuration = root / "config.toml"
        configuration.write_text(
            _local_configuration(catalog, artifacts),
            encoding="utf-8",
        )
        environment = {
            "SCIRETRIEVER_CONFIG": os.fspath(configuration),
            "SCIRETRIEVER_TEST_PRODUCTION_FIXTURE": "1",
        }
        bibliography = root / "input.csl-json"
        bibliography.write_text(
            json.dumps(
                [
                    {
                        "title": "Production manual PDF study",
                        "type": "article-journal",
                        "DOI": "10.5555/production.manual-pdf",
                    }
                ]
            ),
            encoding="utf-8",
        )
        imported = self._json(
            (
                "import",
                "metadata",
                "csl-json",
                os.fspath(bibliography),
                "--json",
            ),
            environment,
            root,
        )
        meta_id = imported["accepted_meta_literature_ids"][0]
        search = self._json(("literature", "search", "--json"), environment, root)
        literature_id = search["items"][0]["literature"]["literature_id"]

        exhausted = self._json(
            ("complete", "pdf", "--meta-literature-id", meta_id, "--json"),
            environment,
            root,
        )
        self.assertEqual(exhausted["end"], {"kind": "finished"})
        self.assertEqual(exhausted["goal_reached"], [])
        self.assertEqual(len(exhausted["needs_manual_pdf"]), 1)
        self.assertEqual(
            exhausted["needs_manual_pdf"][0]["literature_ids"],
            [literature_id],
        )
        exhausted_detail = self._json(
            ("literature", "show", literature_id, "--json"),
            environment,
            root,
        )
        self.assertTrue(exhausted_detail["needs_manual_pdf"])
        self.assertEqual(exhausted_detail["missing_step"], "primary-pdf")
        self.assertIsNone(exhausted_detail["primary_pdf"])

        source = root / "caller-owned.pdf"
        pdf = _pdf()
        source.write_bytes(pdf)
        source.chmod(0o640)
        source_before = source.stat()
        source_hash = hashlib.sha256(pdf).hexdigest()
        manual = self._json(
            ("import", "pdf", literature_id, os.fspath(source), "--json"),
            environment,
            root,
        )
        self.assertEqual(manual["end"], {"kind": "finished"})
        self.assertEqual(manual["result"]["kind"], "accepted")
        self.assertEqual(manual["result"]["accepted"]["asset"]["sha256"], source_hash)

        source_after = source.stat()
        self.assertEqual(source.read_bytes(), pdf)
        self.assertTrue(os.path.samestat(source_before, source_after))
        self.assertEqual(source_before.st_ino, source_after.st_ino)
        self.assertEqual(stat.S_IMODE(source_before.st_mode), stat.S_IMODE(source_after.st_mode))
        detail = self._json(
            ("literature", "show", literature_id, "--json"),
            environment,
            root,
        )
        self.assertFalse(detail["needs_manual_pdf"])
        self.assertEqual(detail["literature"]["status"], "ASSET_READY")
        self.assertEqual(detail["missing_step"], "parser-result")
        self.assertEqual(detail["primary_pdf"]["asset"]["sha256"], source_hash)
        self.assertEqual(
            detail["primary_pdf"]["literature_asset"]["provenance"]["source_kind"],
            "user",
        )
        internal = artifacts / detail["primary_pdf"]["asset"]["path"]
        self.assertTrue(internal.is_file())
        self.assertEqual(internal.read_bytes(), pdf)
        self.assertFalse(os.path.samestat(source.stat(), internal.stat()))

        rendered = json.dumps(
            {"detail": detail, "exhausted": exhausted, "manual": manual},
            ensure_ascii=False,
            sort_keys=True,
        )
        self.assertNotIn(os.fspath(source), rendered)
        self.assertNotIn(source.name, rendered)

    def test_real_console_replaces_no_usable_content_and_reclaims_bytes(self) -> None:
        assert self.install.root is not None
        root = self.install.root / "production-no-usable-content"
        root.mkdir(mode=0o700)
        catalog = root / "catalog.sqlite3"
        artifacts = root / "artifacts"
        rejected_pdf = _pdf("Rejected candidate")
        accepted_pdf = _pdf("Accepted candidate")
        (root / "candidate-crossref.pdf").write_bytes(rejected_pdf)
        (root / "candidate-semantic.pdf").write_bytes(accepted_pdf)
        (root / "mineru-1.zip").write_bytes(
            _mineru_archive(
                markdown=(
                    "# Rejected candidate\n\nOnly an access notice is available.\n\n"
                    "![rejected](images/rejected.png)\n"
                ).encode(),
                resource_name="images/rejected.png",
                resource_bytes=_PNG + b"rejected",
            )
        )
        (root / "mineru-2.zip").write_bytes(
            _mineru_archive(
                markdown=(
                    "# Accepted candidate\n\nThe full controlled study is available.\n\n"
                    "![accepted](images/accepted.png)\n\n"
                    "# References\n\nControlled accepted reference.\n"
                ).encode(),
                resource_name="images/accepted.png",
                resource_bytes=_PNG + b"accepted",
            )
        )
        configuration = root / "config.toml"
        configuration.write_text(
            _configuration(catalog, artifacts),
            encoding="utf-8",
        )
        self._write_llm_credentials()
        environment = {
            "SCIRETRIEVER_ACCEPTANCE_CASE_ROOT": os.fspath(root),
            "SCIRETRIEVER_ACCEPTANCE_SCENARIO": "no-usable-content",
            "SCIRETRIEVER_CONFIG": os.fspath(configuration),
            "SCIRETRIEVER_TEST_PRODUCTION_FIXTURE": "1",
        }
        topic = self._json(
            ("discover", "topic", "candidate replacement", "--json"),
            environment,
            root,
        )
        self.assertEqual(topic["run_status"], "COMPLETED")
        self.assertEqual(topic["discovery_result_count"], 1)
        search = self._json(("literature", "search", "--json"), environment, root)
        literature_id = search["items"][0]["literature"]["literature_id"]

        completed = self._json(
            ("complete", "content", "--literature-id", literature_id, "--json"),
            environment,
            root,
            timeout=60,
        )
        self.assertEqual(completed["end"], {"kind": "finished"})
        self.assertEqual(
            len(completed["goal_reached"]),
            1,
            json.dumps(completed, ensure_ascii=False, sort_keys=True),
        )
        self.assertEqual(
            completed["no_usable_content_literature_ids"],
            [literature_id],
        )
        self.assertEqual(completed["failed"], [])

        detail = self._json(
            ("literature", "show", literature_id, "--json"),
            environment,
            root,
        )
        self.assertEqual(detail["literature"]["status"], "CONTENT_READY")
        self.assertEqual(
            detail["primary_pdf"]["asset"]["sha256"],
            hashlib.sha256(accepted_pdf).hexdigest(),
        )
        self.assertNotEqual(
            detail["primary_pdf"]["asset"]["sha256"],
            hashlib.sha256(rejected_pdf).hexdigest(),
        )

        rejected_payloads = (
            rejected_pdf,
            (
                "# Rejected candidate\n\nOnly an access notice is available.\n\n"
                "![rejected](images/rejected.png)\n"
            ).encode(),
            _PNG + b"rejected",
        )
        for payload in rejected_payloads:
            rejected_path = _object_path(artifacts, payload)
            self.assertFalse(rejected_path.exists(), rejected_path.name)
        with sqlite3.connect(catalog) as connection:
            rejected_hash = hashlib.sha256(rejected_pdf).hexdigest()
            for table, column in (
                ("artifact_objects", "sha256"),
                ("assets", "sha256"),
                ("parser_results", "source_sha256"),
            ):
                self.assertEqual(
                    connection.execute(
                        f"SELECT count(*) FROM {table} WHERE {column}=?",  # noqa: S608
                        (rejected_hash,),
                    ).fetchone()[0],
                    0,
                )
            self.assertEqual(
                connection.execute("SELECT count(*) FROM literature_assets").fetchone()[0],
                1,
            )
            self.assertEqual(
                connection.execute("SELECT count(*) FROM parser_results").fetchone()[0],
                1,
            )
            self.assertEqual(
                connection.execute("SELECT count(*) FROM parser_result_resources").fetchone()[0],
                1,
            )
            self.assertEqual(
                connection.execute("SELECT count(*) FROM literature_contents").fetchone()[0],
                1,
            )

    def test_real_console_completion_selectors_preserve_partial_success_and_rerun(self) -> None:
        assert self.install.root is not None
        root = self.install.root / "production-r8"
        root.mkdir(mode=0o700)
        catalog = root / "catalog.sqlite3"
        artifacts = root / "artifacts"
        (root / "r8-success.pdf").write_bytes(_pdf("R8 success"))
        (root / "r8-retry.pdf").write_bytes(_pdf("R8 retry"))
        configuration = root / "config.toml"
        configuration.write_text(
            _r8_configuration(catalog, artifacts),
            encoding="utf-8",
        )
        environment = {
            "SCIRETRIEVER_ACCEPTANCE_CASE_ROOT": os.fspath(root),
            "SCIRETRIEVER_ACCEPTANCE_SCENARIO": "r8-batch",
            "SCIRETRIEVER_CONFIG": os.fspath(configuration),
            "SCIRETRIEVER_TEST_PRODUCTION_FIXTURE": "1",
        }
        discovery = self._json(
            ("discover", "topic", "R8 production batch", "--json"),
            environment,
            root,
        )
        self.assertEqual(discovery["run_status"], "COMPLETED")
        self.assertEqual(discovery["discovery_result_count"], 2)
        run_id = discovery["discovery_run_id"]

        first = self._json(
            ("complete", "pdf", "--discovery-run-id", run_id, "--json"),
            environment,
            root,
            expected_log_events=(
                "completion-target-failed",
                "completion-finished",
            ),
        )
        self.assertEqual(first["end"], {"kind": "finished"})
        self.assertEqual(len(first["goal_reached"]), 1)
        self.assertEqual(len(first["failed"]), 1)
        self.assertEqual(first["failed"][0]["stage"], "acquisition")
        self.assertEqual(first["needs_manual_pdf"], [])
        self.assertEqual(first["interrupted"], [])
        self.assertEqual(first["not_started"], [])
        successful_id = first["goal_reached"][0]["literature_id"]
        retry_id = first["failed"][0]["literature_id"]

        second = self._json(
            ("--debug", "complete", "pdf", "--discovery-run-id", run_id, "--json"),
            environment,
            root,
            expected_log_events=(
                "completion-target-started",
                "completion-current-facts-read",
                "completion-stage-started",
                "completion-finished",
            ),
        )
        self.assertEqual(second["end"], {"kind": "finished"})
        self.assertEqual(
            [item["literature_id"] for item in second["goal_reached"]],
            [retry_id],
        )
        for partition in ("needs_manual_pdf", "failed", "interrupted", "not_started"):
            self.assertEqual(second[partition], [])
        third = self._json(
            ("complete", "pdf", "--discovery-run-id", run_id, "--json"),
            environment,
            root,
        )
        for partition in (
            "goal_reached",
            "needs_manual_pdf",
            "failed",
            "interrupted",
            "not_started",
        ):
            self.assertEqual(third[partition], [])

        search = self._json(("literature", "search", "--json"), environment, root)
        status_by_id = {
            item["literature"]["literature_id"]: item["literature"]["status"]
            for item in search["items"]
        }
        self.assertEqual(status_by_id[successful_id], "ASSET_READY")
        self.assertEqual(status_by_id[retry_id], "ASSET_READY")
        r8_requests = self._wire_requests("r8-batch")
        self.assertEqual(
            sum(item["host"] == "r8-success.example.org" for item in r8_requests),
            1,
        )
        self.assertEqual(
            sum(item["host"] == "r8-retry.example.net" for item in r8_requests),
            2,
        )

        imported_source = root / "selectors.csl-json"
        selector_titles = (
            "R8 import selector pending",
            "R8 query selector pending",
            "R8 meta selector pending",
            "R8 literature selector pending",
            "R8 all pending selector",
        )
        imported_source.write_text(
            json.dumps(
                [
                    {
                        "title": title,
                        "type": "article-journal",
                        "DOI": f"10.5555/{index}.r8.selector",
                    }
                    for index, title in enumerate(selector_titles, start=1)
                ]
            ),
            encoding="utf-8",
        )
        imported = self._json(
            (
                "import",
                "metadata",
                "csl-json",
                os.fspath(imported_source),
                "--json",
            ),
            environment,
            root,
        )
        self.assertEqual(len(imported["accepted_meta_literature_ids"]), 5)
        selector_search = self._json(
            ("literature", "search", "--limit", "20", "--json"),
            environment,
            root,
        )
        selector_items = {
            item["literature"]["metadata"]["title"]: item["literature"]
            for item in selector_search["items"]
            if item["literature"]["metadata"]["title"] in selector_titles
        }
        self.assertEqual(set(selector_items), set(selector_titles))
        wire_before_local_selectors = self._wire_request_count()

        selector_reports = (
            self._json(
                (
                    "complete",
                    "pdf",
                    "--import-meta-literature-id",
                    selector_items[selector_titles[0]]["meta_literature_id"],
                    "--json",
                ),
                environment,
                root,
            ),
            self._json(
                ("complete", "pdf", "--query", selector_titles[1], "--json"),
                environment,
                root,
            ),
            self._json(
                (
                    "complete",
                    "pdf",
                    "--meta-literature-id",
                    selector_items[selector_titles[2]]["meta_literature_id"],
                    "--json",
                ),
                environment,
                root,
            ),
            self._json(
                (
                    "complete",
                    "pdf",
                    "--literature-id",
                    selector_items[selector_titles[3]]["literature_id"],
                    "--json",
                ),
                environment,
                root,
            ),
            self._json(
                ("complete", "pdf", "--all-pending", "--json"),
                environment,
                root,
            ),
        )
        for report in selector_reports:
            self.assertEqual(report["end"], {"kind": "finished"})
            self.assertEqual(report["goal_reached"], [])
            self.assertEqual(len(report["needs_manual_pdf"]), 1)
            self.assertEqual(report["failed"], [])
            self.assertEqual(report["interrupted"], [])
            self.assertEqual(report["not_started"], [])
        selected_ids = {
            literature_id
            for report in selector_reports
            for target in report["needs_manual_pdf"]
            for literature_id in target["literature_ids"]
        }
        self.assertEqual(
            selected_ids,
            {item["literature_id"] for item in selector_items.values()},
        )
        self.assertEqual(self._wire_request_count(), wire_before_local_selectors)

    def _wire_request_count(self) -> int:
        assert self.install.root is not None
        path = self.install.root / "production-wire.ndjson"
        if not path.exists():
            return 0
        return sum(
            json.loads(line)["kind"] == "request"
            for line in path.read_text(encoding="utf-8").splitlines()
        )

    def _write_llm_credentials(self) -> None:
        assert self.install.home is not None
        directory = self.install.home / ".sciretriever"
        directory.mkdir(mode=0o700, exist_ok=True)
        directory.chmod(0o700)
        credentials = directory / "credentials.toml"
        credentials.write_text(
            '[llm]\napi_key = "offline-analysis-key"\norigin = "https://api.openai.com"\n',
            encoding="utf-8",
        )
        credentials.chmod(0o600)

    def _wire_requests(self, scenario: str) -> list[dict[str, Any]]:
        assert self.install.root is not None
        path = self.install.root / "production-wire.ndjson"
        return [
            item
            for line in path.read_text(encoding="utf-8").splitlines()
            if (item := json.loads(line))["kind"] == "request" and item["scenario"] == scenario
        ]

    def _json(
        self,
        arguments: tuple[str, ...],
        environment: dict[str, str],
        root: Path,
        *,
        timeout: float = 30,
        expected_log_events: tuple[str, ...] = (),
    ) -> dict[str, Any]:
        result = self.install.run_console(
            arguments,
            environment=environment,
            cwd=root,
            timeout=timeout,
        )
        self.assertEqual(result.returncode, 0, result.stderr_text)
        diagnostics = result.stderr_text
        for event in expected_log_events:
            self.assertIn(f"event={event}", diagnostics)
        for unsafe in (
            "Traceback",
            "Authorization",
            "Cookie",
            "://",
            os.fspath(root),
        ):
            self.assertNotIn(unsafe, diagnostics)
        if "--debug" not in arguments:
            self.assertNotIn(" DEBUG ", diagnostics)
            self.assertNotIn("event=completion-current-facts-read", diagnostics)
        return json.loads(result.stdout)


def _pdf(title: str | None = None) -> bytes:
    buffer = io.BytesIO()
    writer = PdfWriter()
    writer.add_blank_page(width=612, height=792)
    if title is not None:
        writer.add_metadata({"/Title": title})
    writer.write(buffer)
    return buffer.getvalue()


_PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
)


def _mineru_archive(
    *,
    markdown: bytes | None = None,
    resource_name: str | None = None,
    resource_bytes: bytes | None = None,
) -> bytes:
    markdown = markdown or (
        b"# Production Bootstrap study\n\n"
        b"The controlled production Bootstrap study evaluates retrieval.\n\n"
        b"# References\n\nControlled production reference.\n"
    )
    middle = (
        b'{"_backend":"vlm","pdf_info":[{"discarded_blocks":[],'
        b'"page_idx":0,"page_size":[612,792],"para_blocks":[]}]}'
    )
    model = b'{"model":"acceptance-vlm"}'
    content = b'[{"page_idx":0,"text":"Production Bootstrap study","type":"text"}]'
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_STORED) as archive:
        archive.writestr("document.md", markdown)
        archive.writestr("document_middle.json", middle)
        archive.writestr("document_model.json", model)
        archive.writestr("document_content_list.json", content)
        if resource_name is not None and resource_bytes is not None:
            archive.writestr(resource_name, resource_bytes)
    return buffer.getvalue()


def _object_path(root: Path, payload: bytes) -> Path:
    digest = hashlib.sha256(payload).hexdigest()
    return root / ".objects" / digest[:2] / f"{digest}-{len(payload)}"


def _configuration(catalog: Path, artifacts: Path) -> str:
    return f"""
[paths]
catalog_path = {json.dumps(os.fspath(catalog))}
artifact_root = {json.dumps(os.fspath(artifacts))}

[discovery]
metadata_scan_limit = 2

[sources.metadata]
providers = ["crossref", "semantic-scholar"]

[sources.metadata.crossref]
mode = "anonymous"

[sources.acquisition]
providers = ["semantic-scholar"]

[parsing]
base_url = "http://127.0.0.1:8000"
connection_mode = "loopback"
model_identity = "mineru-3.4.4-vlm"
remote_upload_authorized = false

[analysis]
provider = "openai"
protocol = "openai-responses"
base_url = "https://api.openai.com/v1"
model = "acceptance-model"
context_window_tokens = 1000000
authentication = "api-key"
metadata_max_output_tokens = 2048
content_max_output_tokens = 4096
reference_max_output_tokens = 2048
max_input_bytes = 1048576
max_chunk_bytes = 1048576
max_chunk_count = 1
max_total_llm_requests = 3
max_total_output_tokens = 8192

[execution]
max_concurrency = 1
"""


def _local_configuration(catalog: Path, artifacts: Path) -> str:
    return f"""
[paths]
catalog_path = {json.dumps(os.fspath(catalog))}
artifact_root = {json.dumps(os.fspath(artifacts))}

[sources.acquisition]
providers = []

[execution]
max_concurrency = 1
"""


def _r8_configuration(catalog: Path, artifacts: Path) -> str:
    return f"""
[paths]
catalog_path = {json.dumps(os.fspath(catalog))}
artifact_root = {json.dumps(os.fspath(artifacts))}

[discovery]
metadata_scan_limit = 5

[sources.metadata]
providers = ["semantic-scholar"]

[sources.acquisition]
providers = ["semantic-scholar"]

[execution]
max_concurrency = 1
"""


if __name__ == "__main__":
    unittest.main()
