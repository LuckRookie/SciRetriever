"""Exercise the installed MinerU adapter against a controlled loopback service.

The driver runs in the fresh wheel virtual environment.  It owns only the
loopback HTTP fixture and deterministic identifiers; MinerU protocol handling,
Network policy, archive conversion, and the parser-neutral adapter come from
the installed wheel.
"""

from __future__ import annotations

import base64
import io
import json
import tempfile
import threading
import zipfile
from contextlib import AbstractContextManager, closing
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import BinaryIO

from PyPDF2 import PdfWriter

import sciretriever.network.http as network_http_module
import sciretriever.parsing.adapters.mineru as mineru_module
import sciretriever.parsing.adapters.mineru_converter as converter_module
from sciretriever.model.parsing import ParserRequest
from sciretriever.model.primitives import (
    AssetId,
    ProvenanceId,
    UtcTimestamp,
    sha256_digest,
)
from sciretriever.network.admission import AccessCoordinator, AccessPolicy, AccessScope
from sciretriever.network.http import HttpClient, SecureHttpTransport, SystemResolver
from sciretriever.parsing.adapters.mineru import (
    MinerUProtocol2ServiceClient,
    OperatorManagedMinerUAdapter,
)

_TASK_ID = "acceptance-task-0001"
_TIME = UtcTimestamp("2026-08-12T18:00:00Z")
_PARSER_TEMPORARY_PREFIX = "sciretriever-parsing-"


def _parser_staging_entries() -> frozenset[str]:
    temporary_root = Path(tempfile.gettempdir()).resolve(strict=True)
    return frozenset(
        path.name
        for path in temporary_root.iterdir()
        if path.name.startswith(_PARSER_TEMPORARY_PREFIX)
    )


class _BytesContent:
    def __init__(self, payload: bytes) -> None:
        self._payload = payload
        self.open_count = 0

    def open(self) -> AbstractContextManager[BinaryIO]:
        self.open_count += 1
        return closing(io.BytesIO(self._payload))


def _pdf() -> bytes:
    output = io.BytesIO()
    writer = PdfWriter()
    writer.add_blank_page(width=612, height=792)
    writer.add_blank_page(width=612, height=792)
    writer.write(output)
    return output.getvalue()


def _archive() -> tuple[bytes, bytes, bytes]:
    markdown = (
        b"# Controlled MinerU work\n\n"
        b"The loopback service produced parser-neutral Markdown.\n\n"
        b"![Figure](images/figure.png)\n"
    )
    image = base64.b64decode(
        b"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
    )
    middle = {
        "_backend": "vlm",
        "pdf_info": [
            {
                "discarded_blocks": [],
                "page_idx": 0,
                "page_size": [612, 792],
                "para_blocks": [
                    {
                        "bbox": [10, 10, 200, 100],
                        "blocks": [],
                        "lines": [
                            {
                                "bbox": [10, 10, 200, 30],
                                "spans": [
                                    {
                                        "bbox": [10, 10, 50, 30],
                                        "image_path": "images/figure.png",
                                    }
                                ],
                            }
                        ],
                    }
                ],
            },
            {
                "discarded_blocks": [],
                "page_idx": 1,
                "page_size": [612, 792],
                "para_blocks": [],
            },
        ],
    }
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_STORED) as archive:
        archive.writestr("document.md", markdown)
        archive.writestr(
            "document_middle.json",
            json.dumps(middle, separators=(",", ":")),
        )
        archive.writestr(
            "document_model.json",
            '{"model":"controlled-vlm-output"}',
        )
        archive.writestr(
            "document_content_list.json",
            '[{"page_idx":0,"text":"Controlled MinerU work","type":"text"},'
            '{"page_idx":1,"text":"Second page","type":"text"}]',
        )
        archive.writestr("images/figure.png", image)
        archive.writestr("images/unreferenced.png", image)
        archive.writestr("private/debug.json", b"PRIVATE-MINERU-ARCHIVE-SENTINEL")
        archive.writestr("document_layout.pdf", b"%PDF-1.7\nprivate layout")
        archive.writestr("document_origin.pdf", b"%PDF-1.7\nprivate origin")
    return output.getvalue(), markdown, image


class _State:
    def __init__(self, archive: bytes, expected_pdf: bytes) -> None:
        self.archive = archive
        self.expected_pdf = expected_pdf
        self.paths: list[str] = []
        self.methods: list[str] = []
        self.submit_body: bytes | None = None
        self.poll_count = 0
        self.lock = threading.Lock()


def _handler(state: _State) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.0"

        def do_GET(self) -> None:  # noqa: N802
            with state.lock:
                state.methods.append("GET")
                state.paths.append(self.path)
            if self.path == "/health":
                self._json(
                    200,
                    {"protocol_version": 2, "status": "healthy", "version": "3.4.4"},
                )
                return
            if self.path == f"/tasks/{_TASK_ID}":
                with state.lock:
                    state.poll_count += 1
                    poll_count = state.poll_count
                status = "processing" if poll_count == 1 else "completed"
                self._json(200, {"task_id": _TASK_ID, "status": status})
                return
            if self.path == f"/tasks/{_TASK_ID}/result":
                self.send_response(200)
                self.send_header("Content-Type", "application/zip")
                self.send_header("Content-Length", str(len(state.archive)))
                self.end_headers()
                self.wfile.write(state.archive)
                return
            self.send_error(404)

        def do_POST(self) -> None:  # noqa: N802
            with state.lock:
                state.methods.append("POST")
                state.paths.append(self.path)
            if self.path != "/tasks":
                self.send_error(404)
                return
            length = int(self.headers.get("Content-Length", "0"))
            body = self.rfile.read(length)
            with state.lock:
                state.submit_body = body
            if state.expected_pdf not in body:
                self.send_error(400)
                return
            self._json(202, {"task_id": _TASK_ID, "status": "pending"})

        def _json(self, status: int, value: object) -> None:
            body = json.dumps(value, separators=(",", ":")).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, format: str, *args: object) -> None:
            del format, args

    return Handler


pdf = _pdf()
archive_bytes, expected_markdown, expected_image = _archive()
state = _State(archive_bytes, pdf)
server = ThreadingHTTPServer(("127.0.0.1", 0), _handler(state))
server_thread = threading.Thread(target=server.serve_forever, daemon=True)
server_thread.start()
parser_staging_before = _parser_staging_entries()
try:
    http = HttpClient(
        resolver=SystemResolver(),
        transport=SecureHttpTransport(),
        coordinator=AccessCoordinator(),
    )
    service = MinerUProtocol2ServiceClient(
        http_client=http,
        base_url=f"http://127.0.0.1:{server.server_port}",
        connection_mode="loopback",
        access_scope=AccessScope("mineru", "api", "protocol-2"),
        access_policy=AccessPolicy(max_concurrency=1),
    )
    adapter = OperatorManagedMinerUAdapter(
        service=service,
        profile="vlm-engine",
        model_identity="controlled-vlm-model@acceptance-revision",
        provenance_id_factory=lambda: ProvenanceId("10000002-e89b-42d3-a456-426614174000"),
        clock=lambda: _TIME,
    )
    content = _BytesContent(pdf)
    request = ParserRequest(
        source_asset_id=AssetId("10000001-e89b-42d3-a456-426614174000"),
        source_sha256=sha256_digest(pdf),
        media_type="application/pdf",
        content_ref=content,
    )
    output = adapter.parse(request)
    with output.markdown.content.open() as stream:
        markdown = stream.read()
    resources = []
    for resource in output.resources:
        with resource.artifact.content.open() as stream:
            payload = stream.read()
        resources.append(
            {
                "byte_size": resource.artifact.artifact.byte_size,
                "media_type": resource.artifact.artifact.media_type,
                "reference": resource.reference,
                "sha256": resource.artifact.artifact.sha256.root,
                "verified_sha256": sha256_digest(payload).root,
            }
        )
    parser_staging_after = _parser_staging_entries()
    submit_body = state.submit_body
    payload = {
        "artifact": {
            "markdown": markdown.decode(),
            "markdown_sha256": output.markdown.artifact.sha256.root,
            "markdown_verified_sha256": sha256_digest(markdown).root,
            "resources": resources,
        },
        "expected": {
            "image_sha256": sha256_digest(expected_image).root,
            "markdown_sha256": sha256_digest(expected_markdown).root,
        },
        "input": {
            "open_count": content.open_count,
            "pdf_sha256": sha256_digest(pdf).root,
            "source_sha256": output.source_sha256.root,
        },
        "product_module_files": {
            "converter": converter_module.__file__,
            "mineru": mineru_module.__file__,
            "network_http": network_http_module.__file__,
        },
        "protocol": {
            "archive_bytes": len(archive_bytes),
            "methods": state.methods,
            "paths": state.paths,
            "poll_count": state.poll_count,
            "port": server.server_port,
            "submit_contains_pdf": submit_body is not None and pdf in submit_body,
            "submit_contains_profile": submit_body is not None
            and b'Content-Disposition: form-data; name="backend"\r\n\r\nvlm-engine\r\n'
            in submit_body,
        },
        "provenance": output.provenance.model_dump(mode="json"),
        "result": {
            "page_count": output.page_count,
            "source_asset_id": output.source_asset_id.root,
        },
        "temporary_hygiene": {
            "new_parser_staging_entries": sorted(parser_staging_after - parser_staging_before),
            "server_thread_alive_after_join": None,
        },
    }
finally:
    server.shutdown()
    server.server_close()
    server_thread.join(timeout=5)

payload["temporary_hygiene"]["server_thread_alive_after_join"] = server_thread.is_alive()
print(json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")))
