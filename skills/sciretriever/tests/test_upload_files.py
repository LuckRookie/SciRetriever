"""Offline regression tests; a loopback server never logs credentials.

Run through apps/server/test/skill-upload-files.test.ts, or directly with:
python3 -I -B -m unittest discover -s skills/sciretriever/tests -p 'test_*.py'
"""
import hashlib
import importlib.util
import io
import json
import secrets
import socket
import tempfile
import threading
import unittest
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

SPEC = importlib.util.spec_from_file_location(
    "upload_files", Path(__file__).resolve().parents[1] / "scripts" / "upload_files.py"
)
upload = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(upload)
BATCH = "12345678-1234-1234-1234-123456789abc"
BASE = "/api/v1/intake/batches/" + BATCH
PDF = b"%PDF-1.7\nSynthetic attachment\n%%EOF\n"


class Library:
    def __init__(self, directory):
        self.secret = secrets.token_urlsafe(32)
        self.files, self.calls, self.errors, self.uploads = {}, [], {}, {}
        self.phase = "files"
        self.on_request = None
        library = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                # No request/credential logging, including on errors.
                return

            def do_POST(self):
                data = self.rfile.read(int(self.headers.get("Content-Length", 0)))
                if self.headers.get("Authorization") != "Bearer " + library.secret:
                    self.send_json(401, {"code": "device-token-invalid"})
                    return
                library.calls.append((self.path, data))
                if library.on_request:
                    library.on_request(self.path)
                queue = library.errors.get(self.path, [])
                if queue:
                    status, code, headers = queue.pop(0)
                    if status == 0:
                        # The server accepted the write, but its reply was lost.
                        library.settle(self.path, data)
                        self.connection.shutdown(socket.SHUT_RDWR)
                        self.connection.close()
                    else:
                        self.send_json(status, {"code": code}, headers)
                    return
                if self.path == BASE + "/status":
                    pending = any(f["status"] == "pending" for f in library.files.values())
                    result = {"batch": {
                        "state": "running" if pending or library.phase == "metadata" else "finished",
                        "progress": {"phase": library.phase},
                    }}
                elif self.path == BASE + "/files":
                    request = json.loads(data)["request"]
                    cursor = request.get("cursor") or ""
                    items = [dict(f) for k, f in sorted(library.files.items())
                             if k > cursor and f["status"] == "pending"]
                    # Small pages exercise cursor traversal while files settle.
                    result = {"items": items[:2],
                              "next_cursor": items[1]["file_id"] if len(items) > 2 else None}
                elif self.path.startswith(BASE + "/files/"):
                    result = {"file": library.settle(self.path, data)}
                else:
                    self.send_json(404, {"code": "route-missing"})
                    return
                self.send_json(200, {"protocol_version": 1, "result": result})

            def send_json(self, status, value, headers=None):
                data = json.dumps(value).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                for name, value in (headers or {}).items():
                    self.send_header(name, value)
                self.end_headers()
                self.wfile.write(data)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.config = directory / "connection"
        self.config.mkdir(mode=0o700)
        address = "http://127.0.0.1:" + str(self.server.server_port)
        (self.config / "address").write_text(address)
        (self.config / "curl.conf").write_text('header = "Authorization: Bearer ' + self.secret + '"\n')
        (self.config / "curl.conf").chmod(0o600)
        self.sleeps = []
        self.client = upload.Client(self.config, sleep=self.sleeps.append)

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def add(self, key, name, **fields):
        self.files[key] = {"file_id": key, "file_name": name, "external_id": "files/" + name,
                           "size_bytes": len(PDF), "action": "upload", "status": "pending", **fields}

    def route(self, key):
        return BASE + "/files/" + key + "/" + ("hash" if self.files[key]["action"] == "hash" else "bytes")

    def settle(self, path, data):
        key = path.split("/")[-2]
        self.uploads.setdefault(key, []).append(data)
        item = self.files[key]
        item["status"] = item.get("settled_status", "existing" if item["action"] == "hash" else "uploaded")
        return dict(item)


class UploadTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="sciretriever-skill-upload-")
        self.root = Path(self.temporary.name)
        self.folder = self.root / "export"
        (self.folder / "files").mkdir(parents=True)
        self.library = Library(self.root)

    def tearDown(self):
        self.library.close()
        self.temporary.cleanup()

    def file(self, name, data=PDF):
        path = self.folder / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        return path

    def run_upload(self):
        output = io.StringIO()
        result = upload.run(self.library.client, BATCH, [self.folder], output=output,
                            sleep=self.library.sleeps.append)
        text = output.getvalue()
        self.assertFalse(self.library.secret in text, "Credential appeared in output")
        return result, text

    def test_one_file_failure_does_not_block_later_files_or_pages(self):
        for key in ("a", "b", "c", "d"):
            self.library.add(key, key + ".pdf")
            self.file("files/" + key + ".pdf")
        self.library.errors[self.library.route("a")] = [(422, "asset-not-pdf", {})]
        result, output = self.run_upload()
        self.assertEqual(result, 1)
        self.assertIn("asset-not-pdf", output)
        self.assertEqual(set(self.library.uploads), {"b", "c", "d"})
        self.assertEqual(sum(p == self.library.route("a") for p, _ in self.library.calls), 1)

    def test_ambiguous_basename_is_skipped_even_if_only_one_size_matches(self):
        self.library.add("a", "same.pdf", external_id="local-file:1:same.pdf")
        self.file("one/same.pdf")
        self.file("two/same.pdf", b"different-size")
        result, output = self.run_upload()
        self.assertEqual(result, 1)
        self.assertIn("ambiguous-file-name", output)
        self.assertFalse(self.library.uploads)

    def test_basename_requires_known_equal_size(self):
        self.file("only.pdf")
        self.library.add("a", "only.pdf", external_id="only.pdf", size_bytes=None)
        self.assertIn("file-name-needs-size", self.run_upload()[1])
        self.library.files["a"]["size_bytes"] = 1
        self.assertIn("size-mismatch", self.run_upload()[1])
        self.assertFalse(self.library.uploads)
        self.library.files["a"]["size_bytes"] = len(PDF)
        self.assertEqual(self.run_upload()[0], 0)

    def test_relative_path_disambiguates_same_names_with_unknown_size(self):
        self.library.add("a", "same.pdf", external_id="one/same.pdf", size_bytes=None)
        self.file("one/same.pdf")
        self.file("two/same.pdf", b"different")
        self.assertEqual(self.run_upload()[0], 0)
        self.assertEqual(self.library.uploads["a"], [PDF])

    def test_multiple_roots_do_not_overwrite_ambiguous_relative_paths(self):
        self.file("files/a.pdf")
        other = self.root / "other"
        (other / "files").mkdir(parents=True)
        (other / "files/a.pdf").write_bytes(b"different")
        item = {"file_name": "a.pdf", "external_id": "files/a.pdf", "size_bytes": None}
        self.assertEqual(upload.find(item, upload.index([self.folder, other]))[1],
                         "ambiguous-relative-path")
        self.assertEqual(upload.find(item, upload.index([self.folder, self.folder]))[1], None)

    def test_symlink_files_and_directories_are_not_candidates(self):
        target = self.root / "outside.pdf"
        target.write_bytes(PDF)
        (self.folder / "linked.pdf").symlink_to(target)
        (self.folder / "linked-dir").symlink_to(self.root, target_is_directory=True)
        self.assertEqual(upload.index([self.folder]), ({}, {}, {}))

    def test_408_and_429_obey_retry_after_and_rewind_file(self):
        self.library.add("a", "a.pdf")
        self.file("files/a.pdf")
        route = self.library.route("a")
        self.library.errors[route] = [
            (408, "request-idle-timeout", {}),
            (429, "device-rate-limited", {"Retry-After": "2"}),
        ]
        self.assertEqual(self.run_upload()[0], 0)
        self.assertEqual(self.library.sleeps, [1, 2])
        self.assertEqual([body for path, body in self.library.calls if path == route], [PDF] * 3)

    def test_retry_limit_reports_failure_and_continues(self):
        for key in ("a", "b"):
            self.library.add(key, key + ".pdf")
            self.file("files/" + key + ".pdf")
        self.library.errors[self.library.route("a")] = [(429, "device-rate-limited", {})] * 4
        self.assertEqual(self.run_upload()[0], 1)
        self.assertEqual(self.library.sleeps, [1, 2, 4])
        self.assertEqual(set(self.library.uploads), {"b"})

    def test_long_retry_after_is_deferred_without_early_retry(self):
        self.library.add("a", "a.pdf")
        self.file("files/a.pdf")
        self.library.errors[self.library.route("a")] = [(429, "device-rate-limited", {"Retry-After": "301"})]
        result, output = self.run_upload()
        self.assertEqual(result, 1)
        self.assertIn("retry-deferred", output)
        self.assertFalse(self.library.sleeps)
        self.assertEqual(sum(p == self.library.route("a") for p, _ in self.library.calls), 1)

    def test_retry_after_http_date(self):
        instant = datetime(2026, 11, 15, tzinfo=timezone.utc)
        self.assertEqual(upload.retry_delay("Sun, 15 Nov 2026 00:00:04 GMT", 0, instant), 4)
        self.assertEqual(upload.retry_delay("invalid", 2, instant), 4)

    def test_rerun_after_lost_reply_does_not_repeat_an_accepted_file(self):
        for key in ("a", "b"):
            self.library.add(key, key + ".pdf")
            self.file("files/" + key + ".pdf")
        self.library.errors[self.library.route("a")] = [(0, "", {})]
        output = self.run_upload()[1]
        self.assertIn("connection-interrupted", output)
        self.assertIn("待交：0", output)
        self.assertEqual(self.run_upload()[0], 0)
        self.assertEqual(self.library.uploads, {"a": [PDF], "b": [PDF]})

    def test_rerun_after_keyboard_interrupt_uses_pending_list(self):
        for key in ("a", "b"):
            self.library.add(key, key + ".pdf")
            self.file("files/" + key + ".pdf")
        original = self.library.client.post

        def interrupt(path, *args, **kwargs):
            if path == self.library.route("b"):
                raise KeyboardInterrupt()
            return original(path, *args, **kwargs)

        self.library.client.post = interrupt
        self.assertEqual(self.run_upload()[0], 130)
        self.library.client.post = original
        self.assertEqual(self.run_upload()[0], 0)
        self.assertEqual(self.library.uploads, {"a": [PDF], "b": [PDF]})

    def test_device_revoked_stops_immediately_without_more_requests(self):
        for key in ("a", "b"):
            self.library.add(key, key + ".pdf")
            self.file("files/" + key + ".pdf")
        route = self.library.route("a")
        self.library.errors[route] = [(401, "device-revoked", {})]
        result, output = self.run_upload()
        self.assertEqual(result, 2)
        self.assertIn("device-revoked", output)
        self.assertIn("重新连接", output)
        self.assertEqual(self.library.calls[-1][0], route)
        self.assertFalse(self.library.uploads)

    def test_hash_action_sends_digest_only_and_conflicts_are_reported(self):
        self.library.add("a", "a.pdf", action="hash", settled_status="conflict")
        self.file("files/a.pdf")
        result, output = self.run_upload()
        self.assertEqual(result, 1)
        self.assertIn("intake-file-conflict", output)
        self.assertEqual(json.loads(self.library.uploads["a"][0])["request"],
                         {"sha256": hashlib.sha256(PDF).hexdigest()})

    def test_expected_hash_mismatch_does_not_upload(self):
        self.library.add("a", "a.pdf", expected_sha256="0" * 64)
        self.file("files/a.pdf")
        self.assertIn("sha256-mismatch", self.run_upload()[1])
        self.assertFalse(self.library.uploads)

    def test_metadata_progress_can_add_more_pending_files(self):
        self.library.phase = "metadata"
        self.library.add("a", "a.pdf")
        self.file("files/a.pdf")
        self.file("files/b.pdf")
        polls = 0

        def update(path):
            nonlocal polls
            if path == BASE + "/status":
                polls += 1
                if polls == 3:
                    self.library.add("b", "b.pdf")
                    self.library.phase = "files"

        self.library.on_request = update
        self.assertEqual(self.run_upload()[0], 0)
        self.assertEqual(set(self.library.uploads), {"a", "b"})
        self.assertEqual(self.library.sleeps, [2])

    def test_final_metadata_checkpoint_during_scan_is_not_missed(self):
        self.library.phase = "metadata"
        self.file("files/last.pdf")
        polls = 0

        def update(path):
            nonlocal polls
            if path == BASE + "/status":
                polls += 1
                if polls == 2:
                    self.library.add("last", "last.pdf")
                    self.library.phase = "files"

        self.library.on_request = update
        # Initially no files; completion can race with the final status read.
        result, output = self.run_upload()
        self.assertEqual(result, 0)
        self.assertEqual(set(self.library.uploads), {"last"})
        self.assertIn("待交：0", output)

    def test_redirect_does_not_forward_device_credential(self):
        self.library.add("a", "a.pdf")
        self.file("files/a.pdf")
        self.library.errors[self.library.route("a")] = [
            (302, "redirect", {"Location": self.library.client.address + "/redirect-target"}),
        ]
        result, output = self.run_upload()
        self.assertEqual(result, 1)
        self.assertIn("redirect-refused", output)
        self.assertFalse(any(path == "/redirect-target" for path, _ in self.library.calls))


if __name__ == "__main__":
    unittest.main()
