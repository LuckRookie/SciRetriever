from __future__ import annotations

from io import BytesIO
import hashlib
import json
from pathlib import Path
import stat
import struct
import sys
from tempfile import TemporaryDirectory
from unittest import TestCase
from uuid import uuid4
import zipfile
import zlib

REPOSITORY = Path(__file__).resolve().parents[1]
SRC = REPOSITORY / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from sciretriever.catalog import IdentityResolver, create_catalog_engine, initialize_catalog
from sciretriever.config import MinerUConfig
from sciretriever.errors import MinerUError, MinerUErrorCategory
from sciretriever.normalization import (
    MinerUClient, MinerUHttpResponse, MinerUParsingService, MinerUResult, MinerUResultState, MinerUTask, MinerUTaskStatus,
    admit_mineru_archive,
)
from sciretriever.storage import DerivedArtifactStore


TASK_ONE = "11111111-1111-4111-8111-111111111111"
TASK_TWO = "22222222-2222-4222-8222-222222222222"


def png_bytes() -> bytes:
    def chunk(kind: bytes, payload: bytes) -> bytes:
        return (
            struct.pack(">I", len(payload)) + kind + payload
            + struct.pack(">I", zlib.crc32(kind + payload) & 0xFFFFFFFF)
        )

    header = struct.pack(">IIBBBBB", 1, 1, 8, 6, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(b"\x00\x00\x00\x00\x00")) + chunk(b"IEND", b"")


def middle_bytes(*, page_idx: int = 0, page_size: list[int] | None = None, bbox: list[float] | None = None) -> bytes:
    box = [10, 10, 100, 30] if bbox is None else bbox
    value = {
        "pdf_info": [{
            "page_idx": page_idx,
            "page_size": [612, 792] if page_size is None else page_size,
            "para_blocks": [{
                "bbox": box,
                "type": "text",
                "lines": [{
                    "bbox": box,
                    "spans": [{"bbox": box, "type": "text", "content": "alpha"}],
                }],
            }, {
                "bbox": [110, 10, 160, 60],
                "type": "image",
                "lines": [{
                    "bbox": [110, 10, 160, 60],
                    "spans": [{
                        "bbox": [110, 10, 160, 60],
                        "type": "image",
                        "image_path": "images/figure.png",
                    }],
                }],
            }],
            "discarded_blocks": [],
        }],
        "_backend": "vlm",
        "_version_name": "3.4.4",
    }
    return json.dumps(value, separators=(",", ":")).encode()


def archive_bytes(extra: list[tuple[zipfile.ZipInfo | str, bytes]] | None = None) -> bytes:
    stream = BytesIO()
    with zipfile.ZipFile(stream, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("document/auto/document_middle.json", middle_bytes())
        archive.writestr("document/auto/document_model.json", b'{"model":"raw"}')
        archive.writestr("document/auto/document_content_list.json", b'[{"page_idx":0,"text":"alpha"}]')
        archive.writestr("document/auto/images/figure.png", png_bytes())
        for name, payload in extra or []:
            archive.writestr(name, payload)
    return stream.getvalue()


class FakeTransport:
    def __init__(self, responses: list[MinerUHttpResponse]) -> None:
        self.responses = responses
        self.calls = []

    def request(self, method, url, *, headers, timeout, max_bytes, fields=None, file=None, address=None):
        self.calls.append((method, url, dict(headers), timeout, max_bytes, fields, file, address))
        return self.responses.pop(0)


def response(status: int, url: str, value: object = None, *, body: bytes | None = None) -> MinerUHttpResponse:
    payload = body if body is not None else json.dumps(value).encode()
    return MinerUHttpResponse(status, url, {}, payload)


class MinerUClientTests(TestCase):
    def config(self, mode="loopback", endpoint="http://127.0.0.1:8000", **values):
        return MinerUConfig(mode=mode, endpoint=endpoint, model="fixture-model", **values)

    def test_loopback_protocol_fields_paths_and_pending_to_result(self) -> None:
        origin = "http://127.0.0.1:8000"
        transport = FakeTransport([
            response(200, origin + "/health", {"status": "healthy", "version": "3.4.4", "protocol_version": 2}),
            response(202, origin + "/tasks", {"task_id": TASK_ONE, "status": "pending"}),
            response(200, origin + f"/tasks/{TASK_ONE}", {"task_id": TASK_ONE, "status": "completed"}),
            response(200, origin + f"/tasks/{TASK_ONE}/result", body=b"zip"),
        ])
        client = MinerUClient(self.config(), transport=transport)
        client.health(5)
        task = client.submit("private/source-name.pdf", b"%PDF-x", 5)
        self.assertEqual(client.status(task.task_id, 5).status, MinerUTaskStatus.COMPLETED)
        self.assertEqual(client.result(task.task_id, 5), MinerUResult(MinerUResultState.COMPLETED, b"zip"))
        submit = transport.calls[1]
        self.assertEqual(set(submit[5]), {
            "backend", "parse_method", "formula_enable", "table_enable", "image_analysis",
            "return_md", "return_middle_json", "return_model_output", "return_content_list",
            "return_images", "response_format_zip", "return_original_file",
            "client_side_output_generation",
        })
        self.assertNotIn("server_url", submit[5])
        self.assertEqual(tuple(submit[5].values()).count("true"), 8)
        self.assertEqual(submit[6][0], "document.pdf")
        self.assertEqual(submit[7], "127.0.0.1")

    def test_remote_requires_runtime_auth_and_global_dns(self) -> None:
        config = self.config(mode="remote", endpoint="https://mineru.example", auth_env="MINERU_TOKEN", remote_upload=True)
        client = MinerUClient(config, transport=FakeTransport([]), resolver=lambda _: ("8.8.8.8",), env={})
        with self.assertRaisesRegex(MinerUError, "authentication") as raised:
            client.health(1)
        self.assertEqual(raised.exception.category, MinerUErrorCategory.AUTHENTICATION)
        forbidden = MinerUClient(config, transport=FakeTransport([]), resolver=lambda _: ("127.0.0.1",), env={"MINERU_TOKEN": "secret"})
        with self.assertRaisesRegex(MinerUError, "forbidden address"):
            forbidden.health(1)

    def test_direct_remote_config_requires_upload_opt_in_and_upload_is_bounded(self) -> None:
        with self.assertRaisesRegex(MinerUError, "not authorized"):
            MinerUClient(MinerUConfig(
                mode="remote", endpoint="https://mineru.example", auth_env="TOKEN",
                remote_upload=False, model="fixture",
            ))
        with self.assertRaisesRegex(MinerUError, "authentication is not configured"):
            MinerUClient(MinerUConfig(
                mode="remote", endpoint="https://mineru.example", auth_env=None,
                remote_upload=True, model="fixture",
            ))
        client = MinerUClient(
            self.config(max_upload_bytes=5), transport=FakeTransport([]),
            resolver=lambda _: ("127.0.0.1",),
        )
        with self.assertRaisesRegex(MinerUError, "upload byte bound"):
            client.submit("document.pdf", b"%PDF-x", 1)

    def test_health_redirect_final_url_and_status_payload_fail_closed(self) -> None:
        origin = "http://127.0.0.1:8000"
        fixtures = [
            response(302, origin + "/health", {}),
            response(200, origin + "/other", {"status": "healthy", "version": "3.4.4", "protocol_version": 2}),
            response(200, origin + "/health", {"status": "healthy", "version": "4.0.0", "protocol_version": 2}),
        ]
        for fixture in fixtures:
            with self.subTest(status=fixture.status, url=fixture.final_url):
                client = MinerUClient(self.config(), transport=FakeTransport([fixture]))
                with self.assertRaises(MinerUError):
                    client.health(1)

    def test_noncanonical_task_id_and_unknown_status_are_rejected_before_paths(self) -> None:
        origin = "http://127.0.0.1:8000"
        for payload in (
            {"task_id": "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA", "status": "pending"},
            {"task_id": TASK_ONE, "status": "cancelled"},
        ):
            client = MinerUClient(self.config(), transport=FakeTransport([response(202, origin + "/tasks", payload)]))
            with self.assertRaises(MinerUError):
                client.submit("document.pdf", b"%PDF-x", 1)


class MinerUArchiveTests(TestCase):
    def setUp(self) -> None:
        self.config = MinerUConfig()

    def test_valid_archive_preserves_raw_json_and_images(self) -> None:
        admitted = admit_mineru_archive(archive_bytes(), self.config)
        self.assertEqual(admitted.middle.payload, middle_bytes())
        self.assertEqual(len(admitted.supporting), 1)
        self.assertTrue(admitted.supporting[0].payload.startswith(b"\x89PNG"))

    def test_traversal_case_collision_symlink_unexpected_and_missing_fail(self) -> None:
        symlink = zipfile.ZipInfo("document/auto/images/link.png")
        symlink.external_attr = (stat.S_IFLNK | 0o777) << 16
        cases = (
            archive_bytes([("../escape.json", b"{}")]),
            archive_bytes([("DOCUMENT/AUTO/DOCUMENT_MIDDLE.JSON", b"{}")]),
            archive_bytes([(symlink, b"target")]),
            archive_bytes([("document/auto/output.md", b"untrusted")]),
        )
        for payload in cases:
            with self.subTest(size=len(payload)), self.assertRaises(MinerUError) as raised:
                admit_mineru_archive(payload, self.config)
            self.assertEqual(raised.exception.category, MinerUErrorCategory.ARCHIVE_REJECTED)
        empty = BytesIO()
        with zipfile.ZipFile(empty, "w") as archive:
            archive.writestr("x_middle.json", b"{}")
        with self.assertRaisesRegex(MinerUError, "exactly one"):
            admit_mineru_archive(empty.getvalue(), self.config)

    def test_primary_outputs_require_one_stem_root_and_exact_json_shapes(self) -> None:
        fixtures = []
        for names in (
            ("a/doc_middle.json", "a/other_model.json", "a/doc_content_list.json"),
            ("a/doc_middle.json", "b/doc_model.json", "a/doc_content_list.json"),
        ):
            stream = BytesIO()
            with zipfile.ZipFile(stream, "w", zipfile.ZIP_DEFLATED) as archive:
                archive.writestr(names[0], b"{}")
                archive.writestr(names[1], b"{}")
                archive.writestr(names[2], b"[]")
            fixtures.append(stream.getvalue())
        fixtures.extend((
            archive_bytes([("document/auto/document_content_list_v2.json", b"[]")]),
            archive_bytes([("other/images/figure.png", b"image")]),
        ))
        malformed = BytesIO()
        with zipfile.ZipFile(malformed, "w", zipfile.ZIP_DEFLATED) as archive:
            archive.writestr("doc_middle.json", b"[]")
            archive.writestr("doc_model.json", b"{}")
            archive.writestr("doc_content_list.json", b"{}")
        fixtures.append(malformed.getvalue())
        for payload in fixtures:
            with self.subTest(size=len(payload)), self.assertRaises(MinerUError) as raised:
                admit_mineru_archive(payload, self.config)
            self.assertEqual(raised.exception.category, MinerUErrorCategory.ARCHIVE_REJECTED)

    def test_ratio_json_depth_file_and_image_bounds_fail(self) -> None:
        ratio_config = MinerUConfig(max_compression_ratio=1)
        depth_config = MinerUConfig(max_json_depth=2)
        file_config = MinerUConfig(max_file_bytes=8)
        image_config = MinerUConfig(max_image_bytes=4)
        ratio_stream = BytesIO()
        with zipfile.ZipFile(ratio_stream, "w", zipfile.ZIP_DEFLATED) as archive:
            archive.writestr("x_middle.json", json.dumps({"text": "x" * 10_000}))
            archive.writestr("x_model.json", b"{}")
            archive.writestr("x_content_list.json", b"[]")
        fixtures = (
            (ratio_config, ratio_stream.getvalue()),
            (depth_config, archive_bytes()),
            (file_config, archive_bytes()),
            (image_config, archive_bytes()),
        )
        for config, payload in fixtures:
            with self.subTest(config=config), self.assertRaises(MinerUError):
                admit_mineru_archive(payload, config)

    def test_duplicate_keys_and_nonfinite_numbers_fail(self) -> None:
        for middle in (b'{"a":1,"a":2}', b'{"value":NaN}', b'{"value":1e9999}'):
            stream = BytesIO()
            with zipfile.ZipFile(stream, "w", zipfile.ZIP_DEFLATED) as archive:
                archive.writestr("x_middle.json", middle)
                archive.writestr("x_model.json", b"{}")
                archive.writestr("x_content_list.json", b"[]")
            with self.subTest(middle=middle), self.assertRaisesRegex(MinerUError, "invalid JSON"):
                admit_mineru_archive(stream.getvalue(), self.config)

        recursive = BytesIO()
        deeply_nested = b'{"value":' + (b"[" * 2000) + b"0" + (b"]" * 2000) + b"}"
        with zipfile.ZipFile(recursive, "w", zipfile.ZIP_DEFLATED) as archive:
            archive.writestr("x_middle.json", deeply_nested)
            archive.writestr("x_model.json", b"{}")
            archive.writestr("x_content_list.json", b"[]")
        with self.assertRaises(MinerUError) as raised:
            admit_mineru_archive(recursive.getvalue(), self.config)
        self.assertEqual(raised.exception.category, MinerUErrorCategory.ARCHIVE_REJECTED)

    def test_malformed_image_payload_is_rejected_before_publication(self) -> None:
        stream = BytesIO()
        with zipfile.ZipFile(stream, "w", zipfile.ZIP_DEFLATED) as archive:
            archive.writestr("document/auto/document_middle.json", middle_bytes())
            archive.writestr("document/auto/document_model.json", b"{}")
            archive.writestr("document/auto/document_content_list.json", b"[]")
            archive.writestr("document/auto/images/figure.png", png_bytes()[:-1])
        with self.assertRaisesRegex(MinerUError, "malformed PNG") as raised:
            admit_mineru_archive(stream.getvalue(), self.config)
        self.assertEqual(raised.exception.category, MinerUErrorCategory.ARCHIVE_REJECTED)

    def test_middle_page_geometry_and_image_references_fail_closed(self) -> None:
        fixtures = (
            middle_bytes(page_idx=1),
            middle_bytes(page_size=[0, 792]),
            middle_bytes(bbox=[10, 10, 700, 30]),
            middle_bytes(bbox=[100, 10, 10, 30]),
            middle_bytes(bbox=[10, 10, float("nan"), 30]),
            middle_bytes().replace(b"images/figure.png", b"images/missing.png"),
        )
        for middle in fixtures:
            stream = BytesIO()
            with zipfile.ZipFile(stream, "w", zipfile.ZIP_DEFLATED) as archive:
                archive.writestr("document/auto/document_middle.json", middle)
                archive.writestr("document/auto/document_model.json", b"{}")
                archive.writestr("document/auto/document_content_list.json", b"[]")
                archive.writestr("document/auto/images/figure.png", png_bytes())
            with self.subTest(middle=middle[:80]), self.assertRaises(MinerUError) as raised:
                admit_mineru_archive(stream.getvalue(), self.config)
            self.assertEqual(raised.exception.category, MinerUErrorCategory.ARCHIVE_REJECTED)


class ScriptedClient:
    def __init__(self, statuses, *, archive=archive_bytes(), interrupt=False, interrupt_status=False, results=None):
        self.statuses = list(statuses)
        self.archive = archive
        self.interrupt = interrupt
        self.interrupt_status = interrupt_status
        self.submissions = 0
        self.result_calls = 0
        self.results = list(results or [])

    def health(self, timeout):
        if self.interrupt:
            raise KeyboardInterrupt
        return None

    def submit(self, filename, pdf, timeout):
        self.submissions += 1
        task_id = TASK_ONE if self.submissions == 1 else TASK_TWO
        return MinerUTask(task_id, MinerUTaskStatus.PENDING)

    def status(self, task_id, timeout):
        if self.interrupt_status:
            raise KeyboardInterrupt
        value = self.statuses.pop(0)
        return None if value is None else MinerUTask(task_id, value)

    def result(self, task_id, timeout):
        self.result_calls += 1
        if self.results:
            return self.results.pop(0)
        return MinerUResult(MinerUResultState.COMPLETED, self.archive)


class AdvancingClock:
    def __init__(self, values):
        self.values = iter(values)

    def __call__(self):
        return next(self.values)


class MinerUServiceTests(TestCase):
    def setUp(self) -> None:
        self.temporary = TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        root = Path(self.temporary.name)
        self.catalog = create_catalog_engine(root / "catalog.sqlite")
        self.addCleanup(self.catalog.dispose)
        initialize_catalog(self.catalog)
        self.work_id = IdentityResolver(self.catalog).create_or_reuse_work({"doi": "10.1/mineru"}).work_version.id
        self.raw_id = str(uuid4())
        self.pdf = b"%PDF-x"
        sha = hashlib.sha256(self.pdf).hexdigest()
        with self.catalog.transaction() as connection:
            connection.exec_driver_sql(
                "INSERT INTO raw_assets (id, sha256, storage_path, media_type, format, byte_size, provenance_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (self.raw_id, sha, f"raw/{sha[:2]}/{sha}", "application/pdf", "pdf", 6, "{}"),
            )
            connection.exec_driver_sql(
                "INSERT INTO work_version_assets (work_version_id, raw_asset_id, asset_role) VALUES (?, ?, 'primary_pdf')",
                (self.work_id, self.raw_id),
            )
        storage = root / "storage"
        storage.mkdir()
        self.store = DerivedArtifactStore(storage, max_bytes=1024 * 1024)
        self.config = MinerUConfig(mode="loopback", endpoint="http://127.0.0.1:8000", model="fixture", poll_interval=0.01)

    def service(self, client, **kwargs):
        return MinerUParsingService(self.catalog, self.store, self.config, client, sleep=lambda _: None, **kwargs)

    def test_pending_completed_publishes_immutable_manifest_and_replays(self) -> None:
        client = ScriptedClient([MinerUTaskStatus.PENDING, MinerUTaskStatus.COMPLETED])
        service = self.service(client)
        first = service.run(self.work_id, self.raw_id, self.pdf)
        second = service.run(self.work_id, self.raw_id, self.pdf)
        self.assertEqual(first.parser_artifact.id, second.parser_artifact.id)
        self.assertEqual(client.submissions, 1)
        self.assertEqual(len(first.supporting_artifacts), 4)
        publication = self.store.find_published("mineru_parser", first.parser_artifact.id)
        self.assertIsNotNone(publication)
        if publication is None:
            self.fail("published manifest is missing")
        manifest = json.loads(self.store.read_verified(publication))
        self.assertEqual([item["sha256"] for item in manifest["entries"]], [entry.sha256 for entry in first.archive.entries])
        self.assertEqual(stat.S_IMODE((self.store.root / publication.storage_path).stat().st_mode), 0o400)

    def test_successful_replay_rejects_tampered_parser_provenance(self) -> None:
        client = ScriptedClient([MinerUTaskStatus.COMPLETED])
        service = self.service(client)
        result = service.run(self.work_id, self.raw_id, self.pdf)
        with self.catalog.transaction() as connection:
            connection.exec_driver_sql(
                "UPDATE normalized_artifacts SET provenance_json = '{}' WHERE id = ?",
                (result.parser_artifact.id,),
            )
        with self.assertRaisesRegex(MinerUError, "provenance") as raised:
            service.run(self.work_id, self.raw_id, self.pdf)
        self.assertEqual(raised.exception.category, MinerUErrorCategory.PROTOCOL)
        self.assertEqual(client.submissions, 1)

    def test_input_must_match_linked_primary_pdf(self) -> None:
        client = ScriptedClient([MinerUTaskStatus.COMPLETED])
        with self.assertRaisesRegex(MinerUError, "primary PDF asset"):
            self.service(client).run(self.work_id, self.raw_id, b"%PDF-other")
        self.assertEqual(client.submissions, 0)

    def test_404_expires_and_resubmits_under_same_run(self) -> None:
        client = ScriptedClient([None, MinerUTaskStatus.COMPLETED])
        result = self.service(client).run(self.work_id, self.raw_id, self.pdf)
        attempts = self.service(client).attempts.list_for_run(result.run.id)
        self.assertEqual(client.submissions, 2)
        self.assertEqual([item.state for item in attempts], ["expired", "succeeded"])

    def test_result_404_expires_and_resubmits_under_same_run(self) -> None:
        client = ScriptedClient(
            [MinerUTaskStatus.COMPLETED, MinerUTaskStatus.COMPLETED],
            results=[MinerUResult(MinerUResultState.EXPIRED), MinerUResult(MinerUResultState.COMPLETED, archive_bytes())],
        )
        result = self.service(client).run(self.work_id, self.raw_id, self.pdf)
        attempts = self.service(client).attempts.list_for_run(result.run.id)
        self.assertEqual(client.submissions, 2)
        self.assertEqual([item.state for item in attempts], ["expired", "succeeded"])

    def test_expired_tasks_stop_at_configured_attempt_limit(self) -> None:
        config = MinerUConfig(
            mode="loopback", endpoint="http://127.0.0.1:8000", model="bounded",
            max_attempts=2, poll_interval=0.01,
        )
        client = ScriptedClient([None, None])
        service = MinerUParsingService(
            self.catalog, self.store, config, client, sleep=lambda _: None,
        )
        with self.assertRaisesRegex(MinerUError, "attempt limit exhausted") as raised:
            service.run(self.work_id, self.raw_id, self.pdf)
        self.assertEqual(raised.exception.category, MinerUErrorCategory.REMOTE_FAILED)
        run = service.runs.claim_or_resume(
            self.work_id, "parsing", "mineru", config.service_version,
            service._parameters(), input_raw_asset_ids=(self.raw_id,),
        )
        self.assertEqual(client.submissions, 2)
        self.assertEqual(
            [attempt.state for attempt in service.attempts.list_for_run(run.id)],
            ["expired", "expired"],
        )

    def test_active_attempt_without_task_is_failed_and_resubmitted(self) -> None:
        client = ScriptedClient([MinerUTaskStatus.COMPLETED])
        service = self.service(client)
        run = service.runs.claim_or_resume(
            self.work_id, "parsing", "mineru", self.config.service_version,
            service._parameters(), input_raw_asset_ids=(self.raw_id,),
        )
        service.attempts.create(run.id, {"reason": "crash_before_task_attachment"})
        result = service.run(self.work_id, self.raw_id, self.pdf)
        attempts = service.attempts.list_for_run(result.run.id)
        self.assertEqual([item.state for item in attempts], ["failed", "succeeded"])
        self.assertEqual(client.submissions, 1)

    def test_remote_failed_timeout_and_interrupt_preserve_attached_task(self) -> None:
        failed = ScriptedClient([MinerUTaskStatus.FAILED])
        with self.assertRaises(MinerUError) as raised:
            self.service(failed).run(self.work_id, self.raw_id, self.pdf)
        self.assertEqual(raised.exception.category, MinerUErrorCategory.REMOTE_FAILED)

        timeout_config = MinerUConfig(mode="loopback", endpoint="http://127.0.0.1:8000", model="timeout", overall_deadline=1, poll_interval=0.5)
        timeout_client = ScriptedClient([MinerUTaskStatus.PENDING])
        clock = AdvancingClock([0, 0, 0, 0, 2])
        with self.assertRaises(MinerUError) as timeout:
            MinerUParsingService(self.catalog, self.store, timeout_config, timeout_client, clock=clock, sleep=lambda _: None).run(
                self.work_id, self.raw_id, self.pdf
            )
        self.assertEqual(timeout.exception.category, MinerUErrorCategory.TIMEOUT)

        interrupt_config = MinerUConfig(mode="loopback", endpoint="http://127.0.0.1:8000", model="interrupt")
        interrupted = ScriptedClient([], interrupt_status=True)
        service = MinerUParsingService(self.catalog, self.store, interrupt_config, interrupted)
        with self.assertRaises(KeyboardInterrupt):
            service.run(self.work_id, self.raw_id, self.pdf)
        with self.catalog.connect() as connection:
            row = connection.exec_driver_sql(
                "SELECT id, state FROM processing_runs WHERE stage = 'parsing' AND details_json LIKE '%interrupt%'"
            ).one()
        self.assertEqual(row[1], "active")
        attempts = service.attempts.list_for_run(row[0])
        self.assertEqual([item.state for item in attempts], ["active"])
        interrupted.interrupt_status = False
        interrupted.statuses.append(MinerUTaskStatus.COMPLETED)
        result = service.run(self.work_id, self.raw_id, self.pdf)
        self.assertEqual(result.run.id, row[0])
        self.assertEqual(interrupted.submissions, 1)
        self.assertEqual(
            [item.state for item in service.attempts.list_for_run(row[0])],
            ["succeeded"],
        )
        self.assertFalse(hasattr(interrupted, "cancel"))


if __name__ == "__main__":
    import unittest
    unittest.main()
