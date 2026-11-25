"""Offline tests of the PDF-only import program against a fake library on
loopback; synthetic files only.

Run through apps/server/test/skill-upload-files.test.ts, or directly with:
python3 -I -B -m unittest discover -s skills/sciretriever/tests -p 'test_*.py'
"""
import importlib.util
import io
import json
import secrets
import tempfile
import threading
import unittest
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

SPEC = importlib.util.spec_from_file_location(
    "import_pdfs", Path(__file__).resolve().parents[1] / "scripts" / "import_pdfs.py"
)
ip = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ip)
PDF = b"%PDF-1.7\nSynthetic scan\n%%EOF\n"
BATCH = "87654321-4321-4321-4321-cba987654321"


class Library:
    """The file-item routes; recognition outcomes come from the file name."""

    def __init__(self, root):
        self.secret = secrets.token_urlsafe(32)
        self.created, self.items, self.confirmed, self.running_previews = [], [], False, 0
        self.state = "none"
        library = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                return

            def do_POST(self):
                data = self.rfile.read(int(self.headers.get("Content-Length", 0)))
                if self.headers.get("Authorization") != "Bearer " + library.secret:
                    return self.send_json(401, {"code": "device-token-invalid"})
                base = "/api/v1/intake/batches/" + BATCH
                if self.path == "/api/v1/intake/batches":
                    library.created.append(json.loads(data)["request"])
                    library.state = "collecting"
                    return self.ok({"batch": {"batch_id": BATCH, "state": library.state}})
                if self.path == base + "/status":
                    return self.ok({"batch": {"batch_id": BATCH, "state": library.state}})
                if self.path == base + "/file-items":
                    name = urllib.parse.unquote(self.headers["X-Sciretriever-File-Name"])
                    relative = self.headers.get("X-Sciretriever-Relative-Path")
                    item = {"item_id": f"{len(library.items):08d}-0000-4000-8000-000000000000",
                            "origin": "file", "file_name": name, "possible_duplicates": [],
                            "needs_decision": False, "unpaired": False,
                            "disposition": None if data.startswith(b"%PDF") else "rejected",
                            "recognition": None,
                            "relative": urllib.parse.unquote(relative) if relative else None}
                    if item["disposition"] == "rejected":
                        item["reason"] = "pdf-invalid"
                    library.items.append(item)
                    library.state = "awaiting-confirmation"
                    return self.ok({"item": item})
                if self.path == base + "/items":
                    return self.ok({"items": [{k: v for k, v in i.items() if k != "relative"}
                                              for i in library.items], "next_cursor": None})
                if self.path == base + "/preview":
                    if library.running_previews:
                        library.running_previews -= 1
                        return self.ok({"recognition": {"state": "running", "recognized": 0, "total": 1},
                                        "summary": {"records": {}}})
                    for i in library.items:
                        if i["disposition"] == "rejected":
                            continue
                        name = i["file_name"]
                        i["recognition"] = {"state": "candidates" if "twin" in name else
                                            "unrecognized" if "scan" in name else "recognized",
                                            "candidates": []}
                        i["needs_decision"] = "twin" in name
                    return self.ok({"recognition": {"state": "done", "recognized": 1, "total": 1},
                                    "summary": {"records": {"matched": 1, "restored": 0}}})
                if self.path == base + "/confirm":
                    library.confirmed, library.state = True, "running"
                    return self.ok({"batch": {"batch_id": BATCH, "state": "running"}})
                return self.send_json(404, {"code": "route-missing"})

            def ok(self, result):
                self.send_json(200, {"protocol_version": 1, "result": result})

            def send_json(self, status, value):
                data = json.dumps(value).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.config = Path(root) / "connection"
        self.config.mkdir(mode=0o700)
        (self.config / "address").write_text("http://127.0.0.1:" + str(self.server.server_port))
        (self.config / "curl.conf").write_text('header = "Authorization: Bearer ' + self.secret + '"\n')
        (self.config / "curl.conf").chmod(0o600)

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()


class ImportPdfsTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="sciretriever-skill-pdfs-")
        self.root = Path(self.temporary.name)
        self.library = Library(self.root)
        self.folder = self.root / "papers"
        (self.folder / "sub").mkdir(parents=True)
        for name in ("sub/paper one.pdf", "sub/twin.pdf", "scan.PDF", "paper two.pdf"):
            (self.folder / name).write_bytes(PDF)
        (self.folder / "broken.pdf").write_bytes(b"not a pdf")
        (self.folder / "notes.txt").write_text("not collected")
        (self.folder / "linked.pdf").symlink_to(self.folder / "paper two.pdf")
        outside = self.root / "outside"
        outside.mkdir()
        (outside / "hidden.pdf").write_bytes(PDF)
        (self.folder / "linked-folder").symlink_to(outside)

    def tearDown(self):
        self.library.close()
        self.temporary.cleanup()

    def main(self, *argv):
        output = io.StringIO()
        code = ip.main(["--config-dir", str(self.library.config), *argv], output=output)
        text = output.getvalue()
        self.assertNotIn(self.library.secret, text)
        self.assertNotIn(str(self.root), text)
        return code, text

    def test_sends_pdfs_with_relative_paths_summarizes_and_stops_before_confirming(self):
        code, text = self.main(str(self.folder))
        self.assertEqual(code, 0, text)
        self.assertEqual(self.library.created[0]["format"], "file")
        self.assertIsNone(self.library.created[0]["source"])
        self.assertEqual(sorted(i["relative"] for i in self.library.items),
                         ["broken.pdf", "paper two.pdf", "scan.PDF", "sub/paper one.pdf", "sub/twin.pdf"])
        self.assertFalse(self.library.confirmed)
        self.assertIn("认出 2 个；已在库 1 篇；没认出 1 个", text)
        self.assertIn("可能是这一篇 1 个", text)
        self.assertIn("被拒绝：pdf-invalid 1", text)
        self.assertIn("  broken.pdf", text)
        self.assertIn(BATCH, text)
        state = json.loads((self.library.config / ip.STATE_FILE).read_text())
        self.assertEqual(sorted(state), ["batch_id", "paths"])
        self.assertNotIn(self.library.secret, json.dumps(state))

    def test_rerun_continues_the_same_batch_without_resending(self):
        client = ip.upload.Client(self.library.config)
        original, count = client.post, [0]

        def interrupt(path, *args, **kwargs):
            if path.endswith("/file-items"):
                count[0] += 1
                if count[0] == 3:
                    raise KeyboardInterrupt()
            return original(path, *args, **kwargs)

        client.post = interrupt
        with self.assertRaises(KeyboardInterrupt):
            ip.run(client, self.library.config, [str(self.folder)], output=io.StringIO())
        self.assertEqual(len(self.library.items), 2)
        code, text = self.main(str(self.folder))
        self.assertEqual(code, 0, text)
        self.assertEqual(len(self.library.created), 1)
        self.assertEqual(len(self.library.items), 5)
        self.assertEqual(len({i["relative"] for i in self.library.items}), 5)
        code, text = self.main(str(self.folder))
        self.assertIn("本次交了 0 个文件", text)
        self.assertEqual(len(self.library.items), 5)

    def test_confirm_waits_for_decisions_and_confirms_without_them(self):
        code, text = self.main("--confirm", str(self.folder))
        self.assertEqual(code, 1)
        self.assertFalse(self.library.confirmed)
        self.assertIn("没有确认", text)
        (self.folder / "sub" / "twin.pdf").unlink()
        self.library.items = [i for i in self.library.items if i["file_name"] != "twin.pdf"]
        code, text = self.main("--confirm", str(self.folder))
        self.assertEqual(code, 0, text)
        self.assertTrue(self.library.confirmed)

    def test_too_many_files_are_refused_before_any_batch(self):
        limit = ip.MAX_FILES
        ip.MAX_FILES = 3
        try:
            code, text = self.main(str(self.folder))
        finally:
            ip.MAX_FILES = limit
        self.assertEqual(code, 2)
        self.assertIn("上限", text)
        self.assertEqual(self.library.created, [])

    def test_recognition_still_running_stops_with_how_to_continue(self):
        self.library.running_previews = 1000
        code, text = self.main("--wait", "0", str(self.folder / "paper two.pdf"))
        self.assertEqual(code, 1)
        self.assertIn("重跑同一条命令", text)
        self.assertIsNone(self.library.items[0]["relative"])


if __name__ == "__main__":
    unittest.main()
