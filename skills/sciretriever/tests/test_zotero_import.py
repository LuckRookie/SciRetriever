"""Offline tests of the Zotero import program against a fake Zotero local API
and a fake library, both on loopback; synthetic data only (the same items as
apps/server/test/zotero-fixture.ts, trimmed).

Run through apps/server/test/skill-upload-files.test.ts, or directly with:
python3 -I -B -m unittest discover -s skills/sciretriever/tests -p 'test_*.py'
"""
import importlib.util
import io
import json
import secrets
import socket
import tempfile
import threading
import unittest
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

SPEC = importlib.util.spec_from_file_location(
    "zotero_import", Path(__file__).resolve().parents[1] / "scripts" / "zotero_import.py"
)
zi = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(zi)
PDF = b"%PDF-1.7\nSynthetic attachment\n%%EOF\n"
BATCH = "12345678-1234-1234-1234-123456789abc"
GROUP = 2000001
SECRET_WORDS = ["Synthetic tetrazole salt A", "Lin", "Okafor", "Lin 2024 synthetic.pdf", "untitled scan.pdf",
                "Energetic materials", "Tetrazoles", "tetrazole", "Crystal structure", "synthetic note",
                "synthetic-group", "2000001", "synthetic highlighted sentence"]


def item(key, data, parent=None, attachment=None, enclosure=None, csl=None, library=None):
    links = {"self": {"href": f"http://localhost:23119/api/users/0/items/{key}", "type": "application/json"}}
    if attachment:
        links["attachment"] = {"href": f"http://localhost:23119/api/users/0/items/{attachment}",
                               "type": "application/json", "attachmentType": "application/pdf",
                               "attachmentSize": len(PDF)}
    if enclosure:
        links["enclosure"] = {"type": "application/pdf", "href": "http://x.invalid", "length": len(PDF)}
    value = {"key": key, "version": 120, "library": library or {"type": "user", "id": 0, "name": "x"},
             "links": links, "meta": {},
             "data": {"key": key, "version": 120, "dateAdded": "2026-01-05T08:00:00Z", "tags": [],
                      "relations": {}, **({"parentItem": parent} if parent else {}), **data}}
    if csl is not None:
        value["csljson"] = csl
    return value


def user_items():
    a = item("AAAA0001", {"itemType": "journalArticle", "title": "Synthetic tetrazole salt A",
                          "creators": [{"creatorType": "author", "firstName": "Yue", "lastName": "Lin"},
                                       {"creatorType": "author", "firstName": "Ada", "lastName": "Okafor"}],
                          "DOI": "10.5555/synth.0001", "collections": ["COLL0002", "COLL0003"],
                          "tags": [{"tag": "tetrazole"}, {"tag": "Crystal structure", "type": 1}]},
             attachment="PDFA0001", csl={"id": "0/AAAA0001", "type": "article-journal",
                                         "title": "Synthetic tetrazole salt A"})
    return [
        a,
        item("PDFA0001", {"itemType": "attachment", "linkMode": "imported_file",
                          "contentType": "application/pdf", "filename": "Lin 2024 synthetic.pdf",
                          "md5": "0f343b0931126a20f133d67c2b018a3b"}, parent="AAAA0001", enclosure=True),
        item("PDFA0002", {"itemType": "attachment", "linkMode": "imported_url",
                          "contentType": "application/pdf", "filename": "si.pdf"}, parent="AAAA0001"),
        item("NOTEA003", {"itemType": "note", "note": "<p>synthetic note</p>"}, parent="AAAA0001"),
        item("ANNO0001", {"itemType": "annotation", "annotationType": "highlight",
                          "annotationText": "synthetic highlighted sentence",
                          "annotationPosition": json.dumps({"pageIndex": 2, "rects": [[1, 2, 3, 4]]})},
             parent="PDFA0001"),
        item("BBBB0002", {"itemType": "preprint", "title": "Synthetic furazan preprint B",
                          "extra": "arXiv: 2501.01234", "collections": ["COLL0001"]}),
        item("LINKB001", {"itemType": "attachment", "linkMode": "linked_file",
                          "contentType": "application/pdf", "path": "attachments:x.pdf"}, parent="BBBB0002"),
        item("EEEE0005", {"itemType": "report", "title": "Synthetic report without identifiers E",
                          "collections": []}),
        item("SOLO0001", {"itemType": "attachment", "linkMode": "imported_file",
                          "contentType": "application/pdf", "filename": "untitled scan.pdf"}),
        item("SOLO0002", {"itemType": "attachment", "linkMode": "imported_file",
                          "contentType": "application/pdf", "filename": "untitled scan.pdf"}),
    ]


def collections():
    def c(key, name, parent):
        return {"key": key, "version": 120, "library": {"type": "user", "id": 0, "name": "x"}, "meta": {},
                "data": {"key": key, "version": 120, "name": name, "parentCollection": parent, "relations": {}}}
    return [c("COLL0001", "Energetic materials", False), c("COLL0002", "Tetrazoles", "COLL0001"),
            c("COLL0003", "Reviews", False), c("COLL0004", "Unrelated", False)]


class Zotero:
    """Zotero's local API, GET only. file_mode: redirect | bytes | missing."""

    def __init__(self, root, items=None):
        self.items = items if items is not None else user_items()
        self.collections = collections()
        self.group_items = [item("GGGG0001", {"itemType": "journalArticle", "title": "Group article",
                                              "collections": []},
                                 library={"type": "group", "id": GROUP, "name": "synthetic-group"})]
        self.file_mode, self.files_dir, self.requests = "missing", Path(root) / "zotero-elsewhere", []
        self.files_dir.mkdir()
        zotero = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                return

            def do_POST(self):
                zotero.requests.append(("POST", self.path))
                self.send_error(405)

            do_PUT = do_PATCH = do_DELETE = do_POST

            def do_GET(self):
                zotero.requests.append(("GET", self.path))
                url = urllib.parse.urlsplit(self.path)
                query = dict(urllib.parse.parse_qsl(url.query))
                path = url.path
                for prefix, values, groups in (("/api/users/0", zotero.items, zotero.collections),
                                               (f"/api/groups/{GROUP}", zotero.group_items, [])):
                    if not path.startswith(prefix):
                        continue
                    rest = path[len(prefix):]
                    if rest.startswith("/items/") and rest.endswith("/file"):
                        return self.file(rest.split("/")[2])
                    listing = {"/items": values,
                               "/items/top": [v for v in values if not v["data"].get("parentItem")],
                               "/items/trash": [], "/collections": groups,
                               "/groups": [{"id": GROUP, "data": {"name": "synthetic-group"}}]}.get(rest)
                    if listing is None:
                        break
                    if "include" in query:
                        listing = listing
                    else:
                        listing = [{k: v for k, v in x.items() if k != "csljson"} for x in listing]
                    start, limit = int(query.get("start", 0)), int(query.get("limit", 25))
                    return self.send_json(listing[start:start + limit], len(listing))
                self.send_error(404)

            def file(self, key):
                target = zotero.files_dir / (key + ".pdf")
                if zotero.file_mode == "redirect-other":
                    other = zotero.files_dir / (key + ".txt")
                    other.write_bytes(b"not a pdf")
                    self.send_response(302)
                    self.send_header("Location", other.as_uri())
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                elif zotero.file_mode == "redirect":
                    target.write_bytes(PDF + key.encode())
                    self.send_response(302)
                    self.send_header("Location", target.as_uri())
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                elif zotero.file_mode == "bytes":
                    body = PDF + key.encode()
                    self.send_response(200)
                    self.send_header("Content-Type", "application/pdf")
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
                else:
                    self.send_error(404)

            def send_json(self, value, total):
                data = json.dumps(value).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.send_header("Total-Results", str(total))
                self.send_header("Last-Modified-Version", "120")
                self.end_headers()
                self.wfile.write(data)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.address = "http://127.0.0.1:" + str(self.server.server_port)

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()


class Library:
    """The intake routes the program uses; the test plays the user who confirms."""

    def __init__(self, root):
        self.secret = secrets.token_urlsafe(32)
        self.state, self.parts, self.file_items, self.pending, self.uploads = "none", {}, [], {}, {}
        self.created, self.calls = None, []
        library = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                return

            def do_POST(self):
                data = self.rfile.read(int(self.headers.get("Content-Length", 0)))
                if self.headers.get("Authorization") != "Bearer " + library.secret:
                    return self.send_json(401, {"code": "device-token-invalid"})
                library.calls.append(self.path)
                base = "/api/v1/intake/batches/" + BATCH
                request = json.loads(data)["request"] if self.headers.get("Content-Type") == "application/json" else None
                if self.path == "/api/v1/intake/batches":
                    library.created, library.state = request, "collecting"
                    return self.ok({"batch": {"batch_id": BATCH, "state": "collecting"}})
                if self.path == base + "/status":
                    return self.ok({"batch": {"batch_id": BATCH, "state": library.state,
                                              "progress": {"phase": "files"}}})
                if self.path == base + "/data":
                    library.parts[request["sequence"]] = request["data"]
                    library.state = "awaiting-confirmation"
                    return self.ok({"batch": {"batch_id": BATCH}})
                if self.path == base + "/file-items":
                    library.file_items.append({
                        "name": urllib.parse.unquote(self.headers["X-Sciretriever-File-Name"]),
                        "path": urllib.parse.unquote(self.headers["X-Sciretriever-Relative-Path"]),
                        "bytes": data})
                    return self.ok({"item": {"origin": "file"}})
                if self.path == base + "/items":
                    return self.ok({"items": [{"origin": "file", "file_name": f["name"]}
                                              for f in library.file_items], "next_cursor": None})
                if self.path == base + "/preview":
                    return self.ok({"batch": {}, "summary": {"records": {"created": 3},
                                                             "annotations": library.annotations(True)}})
                if self.path == base + "/report":
                    return self.ok({"batch": {}, "estimated": False, "items": [], "next_cursor": None,
                                    "summary": {"annotations": library.annotations(False)}})
                if self.path == base + "/files":
                    cursor = request.get("cursor") or ""
                    items = [dict(f) for k, f in sorted(library.pending.items())
                             if k > cursor and f["status"] == "pending"]
                    return self.ok({"items": items[:50],
                                    "next_cursor": items[49]["file_id"] if len(items) > 50 else None})
                if self.path.startswith(base + "/files/") and self.path.endswith("/bytes"):
                    key = self.path.split("/")[-2]
                    library.uploads.setdefault(key, []).append(data)
                    library.pending[key]["status"] = "uploaded"
                    if all(f["status"] != "pending" for f in library.pending.values()):
                        library.state = "finished"
                    return self.ok({"file": dict(library.pending[key])})
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

    def annotations(self, estimated):
        """summary.annotations as a zotero-api batch gives it (6.4.13)."""
        reasons = dict.fromkeys(zi.ANNOTATION_REASONS, 0)
        reasons.update({"unsupported-kind": 2, "comment-too-long": 1})
        if not estimated:
            reasons["position-invalid"] = 1
        return {"supported": 4, "unsupported": 2, "imported": 0 if estimated else 2,
                "deferred": 3 if estimated else 0, "importable": 3 if estimated else 2,
                "by_reason": reasons}

    def confirm(self, attachments):
        """What the server's adapter lists as pending after the user confirms."""
        self.state = "running"
        for n, (key, name) in enumerate(attachments):
            file_id = f"{n:08d}-0000-4000-8000-000000000000"
            self.pending[file_id] = {"file_id": file_id, "external_id": key, "file_name": name,
                                     "size_bytes": None, "action": "upload", "status": "pending"}

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()


class ZoteroImportTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="sciretriever-skill-zotero-")
        self.root = Path(self.temporary.name)
        self.zotero, self.library = Zotero(self.root), Library(self.root)
        self.data = self.root / "Zotero"
        (self.data / "storage").mkdir(parents=True)

    def tearDown(self):
        self.zotero.close()
        self.library.close()
        self.temporary.cleanup()

    def store(self, key, *names):
        folder = self.data / "storage" / key
        folder.mkdir(parents=True, exist_ok=True)
        for name in names:
            (folder / name).write_bytes(PDF + key.encode())

    def main(self, *argv):
        output = io.StringIO()
        code = zi.main(["--config-dir", str(self.library.config), "--zotero", self.zotero.address, *argv],
                       output=output)
        text = output.getvalue()
        # Never the token, a local path or anything outside the connection.
        self.assertNotIn(self.library.secret, text)
        self.assertNotIn(str(self.root), text)
        return code, text

    def state(self):
        text = (self.library.config / zi.STATE_FILE).read_text()
        self.assertNotIn(self.library.secret, text)
        self.assertEqual(sorted(json.loads(text)), ["batch_id", "data_dir", "library"])
        return json.loads(text)

    def test_libraries_and_collections_are_listed_read_only(self):
        code, text = self.main("libraries")
        self.assertEqual(code, 0)
        self.assertIn("user\t我的文库\t5 条", text)
        self.assertIn(f"group:{GROUP}\tsynthetic-group\t1 条", text)
        code, text = self.main("libraries", "--library", "user")
        self.assertIn("COLL0002\tEnergetic materials / Tetrazoles", text)
        self.assertTrue(all(method == "GET" for method, _ in self.zotero.requests))

    def test_unreachable_zotero_explains_how_to_enable_it(self):
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            port = probe.getsockname()[1]
        output = io.StringIO()
        code = zi.main(["--config-dir", str(self.library.config), "--zotero", f"http://127.0.0.1:{port}",
                        "libraries"], output=output)
        self.assertEqual(code, 3)
        self.assertIn("设置 → 高级", output.getvalue())
        self.assertEqual(self.zotero.requests, [])

    def test_import_sends_segments_standalone_pdfs_and_stops_at_preview(self):
        self.store("SOLO0001", "untitled scan.pdf")
        self.store("SOLO0002", "untitled scan.pdf")
        code, text = self.main("import", "--library", "user", "--data-dir", str(self.data))
        self.assertEqual(code, 0, text)
        self.assertEqual(self.library.created["format"], "zotero-api")
        self.assertEqual(self.library.created["source"]["system"], "zotero")
        sent = [i for part in self.library.parts.values() for i in part.get("items", [])]
        self.assertEqual(sorted(i["key"] for i in sent), sorted(i["key"] for i in user_items()))
        self.assertIn("csljson", next(i for i in sent if i["key"] == "AAAA0001"))
        # A parent and all its children travel together.
        for part in self.library.parts.values():
            keys = {i["key"] for i in part.get("items", [])}
            if "AAAA0001" in keys:
                self.assertTrue({"PDFA0001", "PDFA0002", "NOTEA003", "ANNO0001"} <= keys)
        self.assertEqual(len(self.library.parts[0]["collections"]), 4)
        self.assertEqual(sorted(f["path"] for f in self.library.file_items),
                         ["storage/SOLO0001/untitled scan.pdf", "storage/SOLO0002/untitled scan.pdf"])
        self.assertIn(BATCH, text)
        self.assertIn("?view=disc", text)
        self.assertTrue(self.library.calls[-1].endswith("/preview"))
        self.assertIn("批注：PDF 交来并与库里的主 PDF 相同时可导入 3 条；"
                      "不导入：评论超过 20,000 字 1，便签、文字框或手绘 2。", text)
        self.assertNotIn("只计数", text)
        self.assertEqual(self.state()["batch_id"], BATCH)
        # Running again resends the same data and no standalone PDF twice.
        code, text = self.main("import", "--library", "user", "--data-dir", str(self.data))
        self.assertEqual(code, 0, text)
        self.assertEqual(len(self.library.file_items), 2)
        self.assertTrue(all(method == "GET" for method, _ in self.zotero.requests))

    def test_annotations_travel_with_their_attachment_s_parent_across_segments(self):
        tops = [item(f"T{n:07d}", {"itemType": "journalArticle", "title": f"Synthetic {n}",
                                    "abstractNote": "x" * 200000}) for n in range(60)]
        pdfs = [item(f"P{n:07d}", {"itemType": "attachment", "linkMode": "imported_file",
                                    "contentType": "application/pdf", "filename": f"p{n}.pdf"},
                     parent=f"T{n:07d}") for n in range(60)]
        notes = [item(f"A{n:07d}", {"itemType": "annotation", "annotationType": "highlight",
                                     "annotationText": "synthetic",
                                     "annotationPosition": json.dumps({"pageIndex": 0, "rects": [[1, 2, 3, 4]]})},
                      parent=f"P{n:07d}") for n in range(60)]
        # Annotations first: the order Zotero lists them must not matter.
        parts, skipped = zi.segments(notes + pdfs + tops, [])
        self.assertEqual(skipped, 0)
        self.assertGreater(len(parts), 1)
        for part in parts:
            keys = {i["key"] for i in part["items"]}
            for n in range(60):
                if f"T{n:07d}" in keys:
                    self.assertTrue({f"P{n:07d}", f"A{n:07d}"} <= keys)

    def test_import_of_chosen_collections_sends_them_with_ancestors_only(self):
        code, text = self.main("import", "--library", "user", "--collection", "COLL0002",
                               "--data-dir", str(self.data))
        self.assertEqual(code, 0, text)
        sent = {i["key"] for part in self.library.parts.values() for i in part.get("items", [])}
        self.assertEqual(sent, {"AAAA0001", "PDFA0001", "PDFA0002", "NOTEA003", "ANNO0001"})
        # AAAA0001 is also in COLL0003, which was not chosen and is not sent.
        self.assertEqual(sorted(c["key"] for c in self.library.parts[0]["collections"]),
                         ["COLL0001", "COLL0002"])

    def test_files_follow_the_api_then_the_data_folder_and_count_reasons(self):
        self.main("import", "--library", "user", "--data-dir", str(self.data))
        self.library.confirm([("PDFA0001", "Lin 2024 synthetic.pdf"), ("BBBB9999", "absent.pdf"),
                              ("CCCC0003", "two.pdf"), ("DDDD0004", "named.pdf")])
        self.store("CCCC0003", "one.pdf", "other.pdf")
        self.store("DDDD0004", "named.pdf", "supplement.pdf")
        for mode in ("redirect", "bytes"):
            with self.subTest(mode=mode):
                self.zotero.file_mode = mode
                for f in self.library.pending.values():
                    f["status"] = "pending"
                self.library.state = "running"
                self.library.uploads.clear()
                code, text = self.main("files")
                self.assertEqual(code, 0, text)
                # The API gives every file, so the data folder is not needed.
                self.assertEqual(len(self.library.uploads), 4)
                self.assertTrue(all(v[0].startswith(b"%PDF") for v in self.library.uploads.values()))
        self.zotero.file_mode = "missing"
        for f in self.library.pending.values():
            f["status"] = "pending"
        self.library.state = "running"
        self.library.uploads.clear()
        self.store("PDFA0001", "Lin 2024 synthetic.pdf")
        code, text = self.main("files")
        self.assertEqual(code, 1)
        self.assertEqual(len(self.library.uploads), 2)  # PDFA0001 (only PDF) and DDDD0004 (by name)
        self.assertIn("未交（按原因）：storage-ambiguous 1，storage-folder-missing 1", text)
        # After the files: what the library imported, from the batch report.
        self.assertIn("批注：已导入 2 条，还在等文件的 0 条；"
                      "不导入：评论超过 20,000 字 1，位置换算不了 1，便签、文字框或手绘 2。", text)
        self.assertTrue(self.library.calls[-1].endswith("/report"))

    def test_a_file_url_that_is_not_a_pdf_falls_back_to_the_data_folder(self):
        self.main("import", "--library", "user", "--data-dir", str(self.data))
        self.library.confirm([("PDFA0001", "Lin 2024 synthetic.pdf")])
        self.store("PDFA0001", "Lin 2024 synthetic.pdf")
        self.zotero.file_mode = "redirect-other"
        code, text = self.main("files")
        self.assertEqual(code, 0, text)
        self.assertEqual([v[0] for v in self.library.uploads.values()], [PDF + b"PDFA0001"])
        self.assertTrue(any(path.endswith("/PDFA0001/file") for _, path in self.zotero.requests))

    def test_two_hundred_files_resume_after_an_interruption_without_repeats(self):
        many = [item(f"P{n:07d}", {"itemType": "attachment", "linkMode": "imported_file",
                                    "contentType": "application/pdf", "filename": f"paper {n}.pdf"},
                     parent=f"T{n:07d}") for n in range(200)]
        tops = [item(f"T{n:07d}", {"itemType": "journalArticle", "title": f"Synthetic {n}"}) for n in range(200)]
        self.zotero.items = tops + many
        code, text = self.main("import", "--library", "user", "--data-dir", str(self.data))
        self.assertEqual(code, 0, text)
        for n in range(200):
            self.store(f"P{n:07d}", f"paper {n}.pdf")
        self.library.confirm([(f"P{n:07d}", f"paper {n}.pdf") for n in range(200)])
        client = zi.upload.Client(self.library.config)
        original, count = client.post, [0]

        def interrupt(path, *args, **kwargs):
            if path.endswith("/bytes"):
                count[0] += 1
                if count[0] == 77:
                    raise KeyboardInterrupt()
            return original(path, *args, **kwargs)

        client.post = interrupt
        output = io.StringIO()
        self.assertEqual(zi.files(client, None, self.library.config, None, output), 130)
        self.assertEqual(len(self.library.uploads), 76)
        client.post = original
        output = io.StringIO()
        self.assertEqual(zi.files(client, None, self.library.config, None, output), 0, output.getvalue())
        self.assertEqual(len(self.library.uploads), 200)
        self.assertTrue(all(len(v) == 1 for v in self.library.uploads.values()))
        self.assertNotIn(str(self.root), output.getvalue())
        self.assertEqual(self.library.state, "finished")

    def test_probe_reports_structure_and_checks_without_content(self):
        code, text = self.main("probe")
        self.assertEqual(code, 0, text)
        report = json.loads(text)
        for word in SECRET_WORDS:
            self.assertNotIn(word, text)
        checks = {c["check"]: c["result"] for c in report["checks"]}
        self.assertEqual(set(checks), {"items-shape", "csljson", "attachment-link", "attachment-size",
                                       "trash-marker", "date-added-iso", "local-paths", "paging", "version",
                                       "file-endpoint"})
        self.assertTrue(set(checks.values()) <= {"confirmed", "differs", "unknown"})
        self.assertEqual(checks["attachment-link"], "confirmed")
        self.assertEqual(checks["trash-marker"], "unknown")
        self.assertEqual(checks["csljson"], "differs")  # Only one regular item carries csljson.
        self.assertEqual(report["items"]["item_types"]["attachment"], 5)
        self.assertEqual(report["attachments"]["link_modes"]["linked_file"], 1)
        self.assertEqual(report["file_endpoint"]["status"], 404)
        self.assertEqual(checks["file-endpoint"], "differs")
        self.zotero.file_mode = "redirect"
        report = json.loads(self.main("probe")[1])
        self.assertEqual(report["file_endpoint"]["location_scheme"], "file")
        self.assertEqual({c["check"]: c["result"] for c in report["checks"]}["file-endpoint"], "confirmed")
        self.assertTrue(all(method == "GET" for method, _ in self.zotero.requests))


if __name__ == "__main__":
    unittest.main()
