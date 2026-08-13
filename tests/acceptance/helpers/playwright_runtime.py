"""Test-owned Playwright runtime for one fully local Browser acceptance flow.

The SciRetriever Browser boundary is synchronous but deliberately invokes each
vendor operation from cancellable worker threads.  Playwright's synchronous
API is greenlet/thread-affine, so this adapter owns one engine thread and
marshals every vendor call and event callback through it.  It is acceptance
infrastructure, not a production runtime or wheel dependency.
"""

from __future__ import annotations

import hashlib
import http.client
import io
import json
import os
import queue
import socket
import ssl
import subprocess
import sys
import tempfile
import threading
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, TypeVar, cast
from urllib.parse import urlsplit

_T = TypeVar("_T")
_HOSTNAME = "publisher.sciretriever.test"


def _load_fresh_product() -> dict[str, str]:
    root = Path(os.environ["SCIRETRIEVER_FRESH_SITE_PACKAGES"]).resolve(strict=True)
    sys.path.insert(0, os.fspath(root))
    import sciretriever.acquisition.sources.browser as source_module
    import sciretriever.network.browser as browser_module

    modules = {
        "acquisition_browser": source_module,
        "network_browser": browser_module,
    }
    files: dict[str, str] = {}
    prefix = os.fspath(root) + os.sep
    for name, module in modules.items():
        module_file = Path(cast(str, module.__file__)).resolve(strict=True)
        rendered = os.fspath(module_file)
        if not rendered.startswith(prefix):
            raise RuntimeError("product module did not come from the fresh wheel")
        files[name] = rendered
    return files


class _Resolver:
    def __init__(self) -> None:
        self.calls: list[str] = []

    def resolve(self, hostname: str) -> Iterable[str]:
        self.calls.append(hostname)
        if hostname != _HOSTNAME:
            raise RuntimeError("unexpected hostname")
        return ("127.0.0.1",)


class _HttpsState:
    def __init__(self, page: bytes, pdf: bytes) -> None:
        self.page = page
        self.pdf = pdf
        self.authorities: list[str] = []
        self.paths: list[str] = []
        self.lock = threading.Lock()


def _handler(state: _HttpsState) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.0"

        def do_GET(self) -> None:  # noqa: N802
            with state.lock:
                state.authorities.append(self.headers.get("Host", ""))
                state.paths.append(self.path)
            if self.path == "/article":
                self._body(state.page, "text/html; charset=utf-8")
                return
            if self.path == "/article.pdf":
                self.send_response(200)
                self.send_header("Content-Type", "application/pdf")
                self.send_header(
                    "Content-Disposition",
                    'attachment; filename="controlled.pdf"',
                )
                self.send_header("Content-Length", str(len(state.pdf)))
                self.end_headers()
                self.wfile.write(state.pdf)
                return
            self.send_error(404)

        def _body(self, body: bytes, content_type: str) -> None:
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, format: str, *args: object) -> None:
            del format, args

    return Handler


def _generate_certificate(root: Path) -> tuple[Path, Path]:
    key = root / "fixture-key.pem"
    certificate = root / "fixture-cert.pem"
    config = root / "openssl.cnf"
    config.write_text(
        "\n".join(
            (
                "[req]",
                "distinguished_name = subject",
                "x509_extensions = extensions",
                "prompt = no",
                "[subject]",
                f"CN = {_HOSTNAME}",
                "[extensions]",
                f"subjectAltName = DNS:{_HOSTNAME}",
                "basicConstraints = critical,CA:FALSE",
                "keyUsage = critical,digitalSignature,keyEncipherment",
                "extendedKeyUsage = serverAuth",
                "",
            )
        ),
        encoding="utf-8",
    )
    completed = subprocess.run(
        (
            "openssl",
            "req",
            "-x509",
            "-newkey",
            "rsa:2048",
            "-nodes",
            "-sha256",
            "-days",
            "1",
            "-keyout",
            os.fspath(key),
            "-out",
            os.fspath(certificate),
            "-config",
            os.fspath(config),
        ),
        cwd=root,
        check=False,
        capture_output=True,
        text=False,
        timeout=30,
    )
    if completed.returncode != 0:
        raise RuntimeError("local certificate generation failed")
    key.chmod(0o600)
    certificate.chmod(0o600)
    return certificate, key


class _BoundHttpsConnection(http.client.HTTPSConnection):
    def __init__(
        self,
        *,
        address: str,
        port: int,
        server_name: str,
        context: ssl.SSLContext,
    ) -> None:
        super().__init__(server_name, port, context=context, timeout=15)
        self._address = address
        self._server_name = server_name
        self._tls_context = context
        self.peer_certificate: object | None = None

    def connect(self) -> None:
        raw = socket.create_connection((self._address, self.port), self.timeout)
        self.sock = self._tls_context.wrap_socket(raw, server_hostname=self._server_name)
        peer = self.sock.getpeercert()
        if not isinstance(peer, dict):
            raise ssl.SSLError("TLS peer certificate is unavailable")
        self.peer_certificate = peer


@dataclass(frozen=True, slots=True)
class _Response:
    status: int
    headers: tuple[tuple[str, str], ...]
    body: bytes


@dataclass(frozen=True, slots=True)
class _NavigationResponse:
    url: str
    status: int


@dataclass(slots=True)
class _Evidence:
    binding_acknowledged: list[bool]
    connected_addresses: list[str]
    tls_server_names: list[str]
    authorities: list[str]
    page_clicks: list[str]
    download_events: int = 0
    download_request_was_live: bool = False
    download_deleted: bool = False
    page_closed: bool = False
    context_closed: bool = False
    process_closed: bool = False
    downloads_path: str | None = None
    events: list[str] | None = None
    javascript_result: str | None = None
    process_binding_acknowledged: bool = False
    context_binding_acknowledged: bool = False
    page_goto_returned: bool = False
    certificate_san_matches: list[bool] | None = None


@dataclass(slots=True)
class _Command:
    operation: Callable[[], object]
    completed: threading.Event
    result: list[object]
    failure: list[BaseException]


class _Engine:
    def __init__(self, evidence: _Evidence, certificate: Path) -> None:
        self.evidence = evidence
        self.certificate = certificate
        self.commands: queue.Queue[_Command | None] = queue.Queue()
        self.ready = threading.Event()
        self.thread = threading.Thread(target=self._main, daemon=True)
        self.failure: BaseException | None = None
        self.playwright: object | None = None
        self.browser: object | None = None
        self.context: object | None = None
        self.pages: list[object] = []
        self.page_wrappers: dict[int, _Page] = {}
        self.handlers: dict[str, list[Callable[[object], object]]] = {}
        self.route_handler: Callable[[object], object] | None = None
        self.request_wrappers: dict[int, _Request] = {}
        self.pending_attachment_ids: set[int] = set()
        self.responses: dict[str, _Response] = {}
        self.download: _Download | None = None
        self.version = ""
        self.executable_path = ""
        self.launch_downloads_path: str | None = None

    def start(self, downloads_path: str) -> None:
        assert self.evidence.events is not None
        self.evidence.events.append("engine-start-requested")
        self.launch_downloads_path = downloads_path
        self.thread.start()
        if not self.ready.wait(30):
            raise RuntimeError("Playwright engine did not start")
        if self.failure is not None:
            raise RuntimeError("Playwright engine failed to start") from self.failure
        self.evidence.events.append("engine-started")

    def call(self, operation: Callable[[], _T]) -> _T:
        if threading.current_thread() is self.thread:
            return operation()
        command = _Command(operation, threading.Event(), [], [])
        self.commands.put(command)
        if not command.completed.wait(30):
            raise TimeoutError("Playwright engine command timed out")
        if command.failure:
            raise command.failure[0]
        if not command.result:
            raise RuntimeError("Playwright engine command returned no result")
        return cast(_T, command.result[0])

    def _main(self) -> None:
        try:
            from playwright.sync_api import sync_playwright

            self.playwright = sync_playwright().start()
            chromium = cast(Any, self.playwright).chromium
            self.executable_path = os.fspath(chromium.executable_path)
            self.browser = chromium.launch(
                headless=True,
                downloads_path=self.launch_downloads_path,
            )
            self.version = cast(Any, self.browser).version
        except BaseException as error:
            self.failure = error
            self.ready.set()
            return
        self.ready.set()
        while True:
            command = self.commands.get()
            if command is None:
                break
            try:
                value = command.operation()
            except BaseException as error:
                command.failure.append(error)
            else:
                command.result.append(value)
            finally:
                command.completed.set()
        try:
            if self.browser is not None:
                cast(Any, self.browser).close()
            if self.playwright is not None:
                cast(Any, self.playwright).stop()
        except BaseException as error:
            self.failure = error

    def stop(self) -> None:
        self.commands.put(None)
        self.thread.join(30)
        if self.thread.is_alive():
            raise RuntimeError("Playwright engine did not stop")
        if self.failure is not None:
            raise RuntimeError("Playwright engine cleanup failed") from self.failure

    def new_context(self, downloads_path: str) -> None:
        def create() -> None:
            assert self.evidence.events is not None
            self.evidence.events.append("context-create")
            self.evidence.downloads_path = downloads_path
            self.context = cast(Any, self.browser).new_context(
                accept_downloads=True,
            )
            cast(Any, self.context).route("**/*", self._route)
            cast(Any, self.context).on("page", lambda page: self._emit("page", self.page(page)))
            cast(Any, self.context).on("requestfinished", self._request_finished)
            cast(Any, self.context).on("requestfailed", self._request_finished)
            self.evidence.events.append("context-created")

        self.call(create)

    def page(self, raw: object) -> _Page:
        key = id(raw)
        wrapper = self.page_wrappers.get(key)
        if wrapper is None:
            wrapper = _Page(self, raw)
            self.page_wrappers[key] = wrapper
        return wrapper

    def request(self, raw: object, page: _Page | None) -> _Request:
        key = id(raw)
        wrapper = self.request_wrappers.get(key)
        if wrapper is None:
            wrapper = _Request(self, raw, page)
            self.request_wrappers[key] = wrapper
        elif wrapper.page is None and page is not None:
            wrapper.page = page
        return wrapper

    def _route(self, raw_route: object) -> None:
        assert self.evidence.events is not None
        self.evidence.events.append("playwright-route")
        if self.route_handler is None:
            cast(Any, raw_route).abort()
            return
        raw_request = cast(Any, raw_route).request
        raw_page = self._request_page(raw_request)
        page = self.page(raw_page) if raw_page is not None else None
        request = self.request(raw_request, page)
        route = _Route(self, raw_route, request)
        self.evidence.events.append(f"product-route:{request.url}")
        self.route_handler(route)

    @staticmethod
    def _request_page(raw_request: object) -> object | None:
        try:
            frame = cast(Any, raw_request).frame
            return frame.page
        except Exception:
            return None

    def _emit(self, event: str, value: object) -> None:
        for handler in tuple(self.handlers.get(event, ())):
            handler(value)

    def _request_finished(self, raw_request: object) -> None:
        wrapper = self.request_wrappers.get(id(raw_request))
        if wrapper is None:
            return
        if id(raw_request) in self.pending_attachment_ids:
            return
        self._emit("requestfinished", wrapper)

    def route_response(self, route: object, request: _Request, binding: object) -> None:
        assert self.evidence.events is not None
        self.evidence.events.append(f"socket-connect:{request.url}")
        parsed = urlsplit(request.url)
        address = cast(str, getattr(binding, "address"))
        server_name = cast(str, getattr(binding, "tls_server_name"))
        authority = cast(str, getattr(binding, "authority"))
        port = cast(int, getattr(binding, "port"))
        context = ssl.create_default_context(cafile=os.fspath(self.certificate))
        connection = _BoundHttpsConnection(
            address=address,
            port=port,
            server_name=server_name,
            context=context,
        )
        connection.request("GET", parsed.path or "/", headers={"Host": f"{authority}:{port}"})
        response = connection.getresponse()
        peer = connection.peer_certificate
        if not isinstance(peer, dict):
            raise RuntimeError("controlled HTTPS connection did not expose its peer certificate")
        raw_subject_alt_names = peer.get("subjectAltName", ())
        subject_alt_names = (
            tuple(raw_subject_alt_names) if isinstance(raw_subject_alt_names, (list, tuple)) else ()
        )
        assert self.evidence.certificate_san_matches is not None
        self.evidence.certificate_san_matches.append(("DNS", server_name) in subject_alt_names)
        body = response.read()
        headers = tuple((name, value) for name, value in response.getheaders())
        connection.close()
        self.evidence.connected_addresses.append(address)
        self.evidence.tls_server_names.append(server_name)
        self.evidence.authorities.append(f"{authority}:{port}")
        self.responses[request.url] = _Response(response.status, headers, body)
        if parsed.path == "/article.pdf":
            # The page fetch is the admitted network request that obtains the
            # bytes later materialized as a Blob download by real JavaScript.
            # Keep its lease live until that Chromium download event arrives.
            self.pending_attachment_ids.add(id(request.raw))
        self.evidence.binding_acknowledged.append(True)
        self.evidence.events.append(f"route-fulfill:{request.url}")
        cast(Any, route).fulfill(
            status=response.status,
            headers={name: value for name, value in headers},
            body=body,
        )

    def on_download(self, raw_download: object) -> None:
        assert self.evidence.events is not None
        self.evidence.events.append("playwright-download")
        request = next(
            (
                wrapper
                for wrapper in self.request_wrappers.values()
                if id(wrapper.raw) in self.pending_attachment_ids
            ),
            None,
        )
        if request is None:
            raise RuntimeError("download request was not intercepted while admitted")
        response = self.responses[request.url]
        self.download = _Download(self, raw_download, request, response.body)
        self.evidence.download_events += 1
        self.evidence.download_request_was_live = True
        self._emit("download", self.download)
        self.pending_attachment_ids.discard(id(request.raw))
        self._emit("requestfinished", request)


class _Request:
    def __init__(self, engine: _Engine, raw: object, page: _Page | None) -> None:
        self.engine = engine
        self.raw = raw
        self.page = page

    @property
    def url(self) -> str:
        return cast(str, cast(Any, self.raw).url)

    @property
    def resource_type(self) -> str:
        return cast(str, cast(Any, self.raw).resource_type)

    def is_navigation_request(self) -> bool:
        return bool(cast(Any, self.raw).is_navigation_request())


class _Route:
    def __init__(self, engine: _Engine, raw: object, request: _Request) -> None:
        self.engine = engine
        self.raw = raw
        self.request = request
        self.binding: object | None = None
        self.continued = False

    def bind_connection(self, binding: object) -> object:
        assert self.engine.evidence.events is not None
        self.engine.evidence.events.append(f"route-bound:{self.request.url}")
        self.binding = binding
        return binding

    def continue_(self) -> None:
        assert self.engine.evidence.events is not None
        self.engine.evidence.events.append(f"route-continue:{self.request.url}")
        if self.binding is None:
            raise RuntimeError("route continued without connection binding")
        if self.continued:
            return
        self.continued = True
        self.engine.route_response(self.raw, self.request, self.binding)

    def abort(self) -> None:
        assert self.engine.evidence.events is not None
        self.engine.evidence.events.append(f"route-abort:{self.request.url}")
        self.engine.call(lambda: cast(Any, self.raw).abort())


class _Download:
    def __init__(
        self,
        engine: _Engine,
        raw: object,
        request: _Request,
        body: bytes,
    ) -> None:
        self.engine = engine
        self.raw = raw
        self.request = request
        self._body = body
        self.url = request.url
        self.media_type = "application/pdf"
        self.size = len(body)

    def content(self) -> bytes:
        return self._body

    def delete(self) -> None:
        self.engine.call(lambda: cast(Any, self.raw).delete())
        self.engine.evidence.download_deleted = True


class _Page:
    def __init__(self, engine: _Engine, raw: object) -> None:
        self.engine = engine
        self.raw = raw

    @property
    def url(self) -> str:
        return self.engine.call(lambda: cast(str, cast(Any, self.raw).url))

    def goto(self, url: str, *, timeout: int) -> object:
        assert self.engine.evidence.events is not None
        self.engine.evidence.events.append(f"page-goto:{url}")

        def navigate() -> object:
            response = cast(Any, self.raw).goto(
                url,
                timeout=timeout,
                wait_until="commit",
            )
            self.engine.evidence.page_goto_returned = True
            assert self.engine.evidence.events is not None
            self.engine.evidence.events.append("page-goto-returned")
            if response is None:
                return _NavigationResponse(url=url, status=200)
            return _NavigationResponse(
                url=cast(str, response.url),
                status=cast(int, response.status),
            )

        return self.engine.call(navigate)

    def title(self) -> str:
        return self.engine.call(lambda: cast(str, cast(Any, self.raw).title()))

    def content(self) -> str:
        return self.engine.call(lambda: cast(str, cast(Any, self.raw).content()))

    def text_content(self, selector: str, *, timeout: int) -> str | None:
        return self.engine.call(lambda: cast(Any, self.raw).text_content(selector, timeout=timeout))

    def click(self, selector: str, *, timeout: int) -> None:
        self.engine.evidence.page_clicks.append(selector)

        def click() -> None:
            cast(Any, self.raw).wait_for_selector(
                selector,
                state="visible",
                timeout=timeout,
            )
            value = cast(Any, self.raw).evaluate("document.documentElement.dataset.engine")
            self.engine.evidence.javascript_result = value if type(value) is str else None
            with cast(Any, self.raw).expect_download(timeout=timeout):
                cast(Any, self.raw).click(selector, timeout=timeout)

        self.engine.call(click)

    def close(self) -> None:
        self.engine.call(lambda: cast(Any, self.raw).close())
        self.engine.evidence.page_closed = True


class _Context:
    def __init__(self, engine: _Engine) -> None:
        self.engine = engine

    def bind_connection(self, binding: object) -> object:
        self.engine.evidence.context_binding_acknowledged = True
        return binding

    @property
    def pages(self) -> tuple[_Page, ...]:
        return self.engine.call(
            lambda: tuple(self.engine.page(page) for page in cast(Any, self.engine.context).pages)
        )

    def route(self, pattern: str, handler: Callable[[object], object]) -> None:
        if pattern != "**/*":
            raise RuntimeError("unexpected route pattern")
        self.engine.route_handler = handler

    def on(self, event: str, handler: Callable[[object], object]) -> None:
        self.engine.handlers.setdefault(event, []).append(handler)

    def new_page(self) -> _Page:
        def create() -> _Page:
            raw = cast(Any, self.engine.context).new_page()
            raw.on("download", self.engine.on_download)
            page = self.engine.page(raw)
            self.engine.pages.append(page)
            return page

        return self.engine.call(create)

    def close(self) -> None:
        self.engine.call(lambda: cast(Any, self.engine.context).close())
        self.engine.evidence.context_closed = True


class _Process:
    def __init__(self, engine: _Engine) -> None:
        self.engine = engine

    def bind_connection(self, binding: object) -> object:
        self.engine.evidence.process_binding_acknowledged = True
        return binding

    def new_context(
        self,
        *,
        profile: object | None,
        downloads_path: str,
        accept_downloads: bool,
        connection_binding: object,
    ) -> _Context:
        del profile, connection_binding
        if not accept_downloads:
            raise RuntimeError("downloads must be enabled")
        self.engine.new_context(downloads_path)
        return _Context(self.engine)

    def close(self) -> None:
        self.engine.stop()
        self.engine.evidence.process_closed = True


class _Factory:
    def __init__(self, engine: _Engine) -> None:
        self.engine = engine
        self.process = _Process(engine)

    def __call__(
        self,
        *,
        profile: object | None,
        downloads_path: str,
        connection_binding: object,
    ) -> _Process:
        del profile, connection_binding
        self.engine.start(downloads_path)
        return self.process


def _pdf() -> bytes:
    from PyPDF2 import PdfWriter

    output = io.BytesIO()
    writer = PdfWriter()
    writer.add_blank_page(width=72, height=72)
    writer.write(output)
    return output.getvalue()


def run_acceptance() -> None:  # noqa: C901
    product_module_files = _load_fresh_product()
    from playwright import __file__ as playwright_file

    from sciretriever.acquisition.ports import AcquisitionExpectedFacts, CandidateKeyTracker
    from sciretriever.acquisition.routing import AcquisitionRequest, build_acquisition_evidence
    from sciretriever.acquisition.sources.browser import (
        CONTROLLED_BROWSER_PRODUCTION_READINESS,
        ControlledBrowserPdfSource,
    )
    from sciretriever.acquisition.sources.browser_rules import (
        PRODUCTION_BROWSER_RULE_CATALOG,
        BrowserRuleAction,
        BrowserRuleCatalog,
        BrowserSiteRule,
    )
    from sciretriever.literature.content import metadata_sha256
    from sciretriever.model.acquisition import AssetHint, AssetHintKind, AssetRole
    from sciretriever.model.literature import Literature, LiteratureStatus, VersionRole
    from sciretriever.model.metadata import LiteratureMetadata, MetadataObservation
    from sciretriever.model.primitives import (
        LiteratureId,
        MetaLiteratureId,
        ObservationId,
        ProvenanceId,
        SourceKind,
        UtcTimestamp,
        sha256_digest,
    )
    from sciretriever.model.provenance import Provenance
    from sciretriever.network.admission import AccessCoordinator
    from sciretriever.network.browser import BrowserClient
    from sciretriever.network.policy import AddressClass, DestinationPolicy

    pdf = _pdf()
    page = (
        "<!doctype html><html><body>"
        "<button data-action='pdf' type='button'>PDF</button>"
        "<script>"
        "document.documentElement.dataset.engine='javascript-ran';"
        "document.querySelector(\"button[data-action='pdf']\").addEventListener('click',async()=>{"
        "const response=await fetch('/article.pdf');"
        "const blob=await response.blob();"
        "const link=document.createElement('a');"
        "link.href=URL.createObjectURL(blob);link.download='controlled.pdf';"
        "document.body.append(link);link.click();"
        "setTimeout(()=>{URL.revokeObjectURL(link.href);link.remove();},0);"
        "});"
        "</script>"
        "</body></html>"
    ).encode()
    temporary = tempfile.TemporaryDirectory(prefix="sciretriever-playwright-fixture-")
    temporary_root = Path(temporary.name).resolve(strict=True)
    state = _HttpsState(page, pdf)
    server: ThreadingHTTPServer | None = None
    server_thread: threading.Thread | None = None
    evidence = _Evidence([], [], [], [], [], events=[], certificate_san_matches=[])
    engine: _Engine | None = None
    payload: dict[str, object]
    try:
        certificate, key = _generate_certificate(temporary_root)
        server = ThreadingHTTPServer(("127.0.0.1", 0), _handler(state))
        tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        tls.load_cert_chain(certificate, key)
        server.socket = tls.wrap_socket(server.socket, server_side=True)
        port = server.server_port
        server_thread = threading.Thread(target=server.serve_forever, daemon=True)
        server_thread.start()
        engine = _Engine(evidence, certificate)
        resolver = _Resolver()
        client = BrowserClient(
            factory=_Factory(engine),
            resolver=resolver,
            coordinator=AccessCoordinator(),
            destination_policy=DestinationPolicy(
                allowed_classes=frozenset({AddressClass.LOOPBACK}),
                allowed_addresses=frozenset({"127.0.0.1"}),
                allowed_ports=frozenset({("https", port)}),
            ),
        )
        origin = f"https://{_HOSTNAME}:{port}"
        rule = BrowserSiteRule(
            rule_id="playwright-local",
            revision=1,
            landing_origin=origin,
            allowed_origins=(origin,),
            web_scope_provider_name=_HOSTNAME,
            action=BrowserRuleAction.EXPLICIT_CLICK,
            click_selector="button[data-action='pdf']",
        )
        source = ControlledBrowserPdfSource(
            runner=client,
            rule_catalog=BrowserRuleCatalog((rule,)),
            provenance_id_factory=lambda: ProvenanceId("20000001-e89b-42d3-a456-426614174000"),
            clock=lambda: UtcTimestamp("2026-08-12T20:00:00Z"),
        )
        metadata = LiteratureMetadata(title="Real Chromium acceptance")
        literature = Literature(
            literature_id=LiteratureId("20000002-e89b-42d3-a456-426614174000"),
            meta_literature_id=MetaLiteratureId("20000003-e89b-42d3-a456-426614174000"),
            version_role=VersionRole.PUBLISHED,
            metadata=metadata,
            status=LiteratureStatus.UNREVIEWED,
        )
        observation = MetadataObservation(
            observation_id=ObservationId("20000004-e89b-42d3-a456-426614174000"),
            provenance=Provenance(
                provenance_id=ProvenanceId("20000005-e89b-42d3-a456-426614174000"),
                source_kind=SourceKind.METADATA_PROVIDER,
                source_name="local-fixture",
                source_record_id="real-chromium",
                observed_at=UtcTimestamp("2026-08-12T20:00:00Z"),
                input_sha256=sha256_digest(b"real-chromium-metadata-fixture"),
                parameters_sha256=None,
            ),
            metadata=metadata,
            asset_hints=(
                AssetHint(
                    url=f"{origin}/article",
                    kind=AssetHintKind.LANDING_PAGE,
                    asset_role=AssetRole.PRIMARY_PDF,
                ),
            ),
        )
        request = AcquisitionRequest(
            literature=literature,
            expected_facts=AcquisitionExpectedFacts(
                literature_id=literature.literature_id,
                meta_literature_id=literature.meta_literature_id,
                metadata_revision=1,
                metadata_sha256=metadata_sha256(metadata),
                expected_no_primary_pdf=True,
            ),
            observations=(observation,),
        )
        try:
            deliveries = list(
                source.acquire(
                    request,
                    build_acquisition_evidence(request),
                    CandidateKeyTracker(),
                )
            )
        except Exception as error:
            failure = getattr(error, "failure", None)
            code = getattr(failure, "code", type(error).__name__)
            raise RuntimeError(
                "real Browser flow failed: "
                f"{code}; bindings={len(evidence.binding_acknowledged)}; "
                f"downloads={evidence.download_events}; paths={state.paths!r}; "
                f"events={evidence.events!r}; engine_failure={engine.failure!r}"
            ) from error
        if len(deliveries) != 1:
            raise RuntimeError(
                "real Browser flow did not deliver one PDF: "
                f"count={len(deliveries)}; downloads={evidence.download_events}; "
                f"paths={state.paths!r}; events={evidence.events!r}; "
                f"engine_failure={engine.failure!r}"
            )
        delivery = deliveries[0]
        with delivery.content.open() as stream:
            delivered = stream.read()
        delivery.content.discard()
        payload = {
            "product_module_files": product_module_files,
            "playwright_module_file": os.fspath(Path(cast(str, playwright_file)).resolve()),
            "engine": {
                "name": "chromium",
                "version": engine.version,
                "executable_path": engine.executable_path,
                "javascript_result": evidence.javascript_result,
                "page_clicks": evidence.page_clicks,
                "download_events": evidence.download_events,
            },
            "network": {
                "hostname": _HOSTNAME,
                "authority": f"{_HOSTNAME}:{port}",
                "resolver_addresses": sorted(
                    set(value for _ in resolver.calls for value in ("127.0.0.1",))
                ),
                "connected_addresses": evidence.connected_addresses,
                "tls_server_names": evidence.tls_server_names,
                "authorities": state.authorities,
                "paths": state.paths,
                "certificate_san_matches_hostname": bool(evidence.certificate_san_matches)
                and all(evidence.certificate_san_matches),
                "all_bindings_acknowledged_before_continue": (
                    evidence.process_binding_acknowledged
                    and evidence.context_binding_acknowledged
                    and all(evidence.binding_acknowledged)
                    and len(evidence.binding_acknowledged) == 2
                ),
                "download_request_was_live": evidence.download_request_was_live,
            },
            "verification": {
                "expected_pdf_sha256": hashlib.sha256(pdf).hexdigest(),
                "delivered_pdf_sha256": hashlib.sha256(delivered).hexdigest(),
            },
            "candidate": {
                "acquisition_path": delivery.candidate.acquisition_path.value,
                "source_name": delivery.candidate.source_name,
            },
            "production_boundary": {
                "catalog_rule_count": len(PRODUCTION_BROWSER_RULE_CATALOG.rules),
                "ready": CONTROLLED_BROWSER_PRODUCTION_READINESS.is_ready,
                "readiness_code": CONTROLLED_BROWSER_PRODUCTION_READINESS.failure.code,
            },
        }
    finally:
        if engine is not None and engine.thread.is_alive():
            try:
                engine.stop()
            except Exception:
                pass
        if server is not None:
            server.shutdown()
            server.server_close()
        if server_thread is not None:
            server_thread.join(10)
        downloads_path = evidence.downloads_path
        temporary.cleanup()

    payload["cleanup"] = {
        "page_closed": evidence.page_closed,
        "context_closed": evidence.context_closed,
        "process_closed": evidence.process_closed,
        "download_deleted": evidence.download_deleted,
        "browser_downloads_path_exists": bool(downloads_path and Path(downloads_path).exists()),
        "fixture_temporary_root_exists": temporary_root.exists(),
        "server_thread_alive": bool(server_thread and server_thread.is_alive()),
    }
    print(json.dumps(payload, separators=(",", ":"), sort_keys=True))
