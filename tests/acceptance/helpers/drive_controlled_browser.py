"""Exercise installed BrowserClient and controlled Browser PDF Source together.

The Browser runtime and controlled site are test-owned in-memory components.
Network destination policy, DNS/admission handling, Browser lifecycle, rule
execution, routing evidence, and Source delivery all come from the installed
wheel.  This is component protocol QA, not production Browser wiring.
"""

from __future__ import annotations

import io
import json
import os
from collections.abc import Callable, Iterable
from contextlib import AbstractContextManager
from pathlib import Path

from PyPDF2 import PdfWriter

import sciretriever.acquisition.sources.browser as source_module
import sciretriever.network.browser as browser_module
from sciretriever.acquisition.planning import RouteReadiness
from sciretriever.acquisition.ports import AcquisitionExpectedFacts, CandidateKeyTracker
from sciretriever.acquisition.routing import AcquisitionRequest, build_acquisition_evidence
from sciretriever.acquisition.sources.browser import (
    CONTROLLED_BROWSER_PRODUCTION_STATUS,
    ControlledBrowserPdfSource,
)
from sciretriever.acquisition.sources.browser_rules import (
    PRODUCTION_BROWSER_RULE_CATALOG,
    BrowserActionKind,
    BrowserPageMarker,
    BrowserPageMarkerKind,
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

_TIME = UtcTimestamp("2026-08-12T18:30:00Z")
_LANDING = "https://publisher.test/article"
_DOWNLOAD = "https://downloads.publisher.test/article.pdf?view=full"
_PDF_SHA256 = sha256_digest(b"controlled-browser-pdf-placeholder")


def _id(namespace: int, number: int) -> str:
    return f"{namespace:08x}-e89b-42d3-a456-{number:012x}"


def _pdf() -> bytes:
    output = io.BytesIO()
    writer = PdfWriter()
    writer.add_blank_page(width=72, height=72)
    writer.write(output)
    return output.getvalue()


class _Resolver:
    def __init__(self) -> None:
        self.calls: list[str] = []

    def resolve(self, hostname: str) -> Iterable[str]:
        self.calls.append(hostname)
        return {
            "publisher.test": ("93.184.216.34",),
            "downloads.publisher.test": ("93.184.216.35",),
        }[hostname]


class _Request:
    def __init__(self, url: str, page: _Page, *, navigation: bool) -> None:
        self.url = url
        self.page = page
        self.resource_type = "document" if navigation else "other"
        self._navigation = navigation

    def is_navigation_request(self) -> bool:
        return self._navigation


class _Route:
    def __init__(self, request: _Request) -> None:
        self.request = request
        self.continued = False
        self.aborted = False
        self.binding_addresses: tuple[str, ...] = ()

    def bind_connection(self, binding: object) -> object:
        self.binding_addresses = tuple(getattr(binding, "verified_addresses"))
        return binding

    def continue_(self) -> None:
        self.continued = True

    def abort(self) -> None:
        self.aborted = True


class _Download:
    def __init__(self, body: bytes) -> None:
        self.url = _DOWNLOAD
        self.media_type = "application/pdf"
        self.size = len(body)
        self.request: _Request | None = None
        self._body = body
        self.deleted = False

    def content(self) -> bytes:
        return self._body

    def delete(self) -> None:
        self.deleted = True


class _Page:
    def __init__(self, context: _Context) -> None:
        self.context = context
        self.url = ""
        self.closed = False
        self.clicked: list[str] = []
        self.control_generation = 0

    def goto(self, url: str, *, timeout: int) -> None:
        del timeout
        route = self.context.request(url, self, navigation=True)
        if route.aborted or not route.continued:
            raise RuntimeError("controlled navigation was not admitted")
        self.url = url
        self.context.finish(route.request)

    def title(self) -> str:
        return "Controlled publisher fixture"

    def content(self) -> str:
        return "<html><body><a data-action='pdf'>PDF</a></body></html>"

    def discover_pdf_locators(self) -> tuple[str, ...]:
        return ()

    def has_selector(self, selector: str, *, timeout: int) -> bool:
        del timeout
        return selector == "a[data-action='pdf']"

    def text_content(self, selector: str, *, timeout: int) -> str:
        del selector, timeout
        return ""

    def click(self, selector: str, *, timeout: int) -> None:
        del timeout
        self.clicked.append(selector)
        self.context.emit_download(self)

    def control_snapshot(
        self,
        *,
        timeout: int,
        include_screenshot: bool,
        static_selector: str | None = None,
    ) -> dict[str, object]:
        if timeout <= 0:
            raise RuntimeError("controlled snapshot timeout must be positive")
        title = f"Controlled publisher fixture {self.control_generation}"
        return {
            "width": 1280,
            "height": 720,
            "title": title,
            "surfaces": ((0, None, "page", self.url, title, 0, 0, 1280, 720, 0, 0, 0, 720, None),),
            "elements": ((1, 0, "link", "PDF", True, True, 20, 20, 180, 40),),
            "static_element_key": (1 if static_selector == "a[data-action='pdf']" else None),
            "screenshot": (
                f"controlled-screenshot-{self.control_generation}".encode()
                if include_screenshot
                else None
            ),
            "screenshot_media_type": "image/png" if include_screenshot else None,
        }

    def control_click_element(
        self,
        element_key: int,
        *,
        expected_role: str,
        expected_name: str,
        expected_enabled: bool,
        expected_surface_key: int,
        timeout: int,
    ) -> bool:
        if (
            element_key != 1
            or expected_role != "link"
            or expected_name != "PDF"
            or not expected_enabled
            or expected_surface_key != 0
            or timeout <= 0
        ):
            raise RuntimeError("controlled element binding changed")
        self.clicked.append("a[data-action='pdf']")
        self.control_generation += 1
        self.context.emit_download(self)
        return True

    def close(self) -> None:
        self.closed = True
        self.context.events.append("page-close")


class _Context:
    def __init__(self, body: bytes, events: list[str]) -> None:
        self.body = body
        self.events = events
        self.pages: list[_Page] = []
        self.handlers: dict[str, list[Callable[[object], object]]] = {}
        self.route_handler: Callable[[_Route], object] | None = None
        self.closed = False
        self.binding_addresses: tuple[str, ...] = ()
        self.routes: list[_Route] = []
        self.download = _Download(body)

    def bind_connection(self, binding: object) -> object:
        self.binding_addresses = tuple(getattr(binding, "verified_addresses"))
        return binding

    def route(self, pattern: str, handler: Callable[[_Route], object]) -> None:
        self.events.append(f"route:{pattern}")
        self.route_handler = handler

    def on(self, event: str, handler: Callable[[object], object]) -> None:
        self.handlers.setdefault(event, []).append(handler)

    def new_page(self) -> _Page:
        page = _Page(self)
        self.pages.append(page)
        return page

    def request(self, url: str, page: _Page, *, navigation: bool) -> _Route:
        if self.route_handler is None:
            raise RuntimeError("Browser route handler was not installed")
        route = _Route(_Request(url, page, navigation=navigation))
        self.routes.append(route)
        self.route_handler(route)
        return route

    def finish(self, request: _Request) -> None:
        for handler in self.handlers.get("requestfinished", ()):
            handler(request)

    def emit_download(self, page: _Page) -> None:
        # A user-initiated attachment download is exposed by Playwright as a
        # top-level document navigation even though it also emits a download
        # event.  Keep the component fixture faithful to that runtime contract
        # so navigation-only mode rejects page subresources without rejecting
        # the reviewed PDF action itself.
        route = self.request(_DOWNLOAD, page, navigation=True)
        if route.aborted or not route.continued:
            raise RuntimeError("controlled download was not admitted")
        self.download.request = route.request
        for handler in self.handlers.get("download", ()):
            handler(self.download)
        self.finish(route.request)

    def close(self) -> None:
        self.closed = True
        self.events.append("context-close")


class _Process:
    def __init__(self, body: bytes, events: list[str]) -> None:
        self.body = body
        self.events = events
        self.context: _Context | None = None
        self.closed = False
        self.binding_addresses: tuple[str, ...] = ()
        self.downloads_path: str | None = None

    def __enter__(self) -> _Process:
        self.events.append("process-enter")
        return self

    def __exit__(self, exc_type: object, exc_value: object, traceback: object) -> bool:
        del exc_type, exc_value, traceback
        self.close()
        self.events.append("process-exit")
        return False

    def bind_connection(self, binding: object) -> object:
        self.binding_addresses = tuple(getattr(binding, "verified_addresses"))
        return binding

    def new_context(
        self,
        *,
        downloads_path: str,
        accept_downloads: bool,
        connection_binding: object,
    ) -> _Context:
        if not accept_downloads:
            raise RuntimeError("controlled runtime requires downloads")
        self.downloads_path = downloads_path
        self.events.append("context-create")
        self.context = _Context(self.body, self.events)
        self.context.bind_connection(connection_binding)
        return self.context

    def close(self) -> None:
        if self.closed:
            return
        self.closed = True
        self.events.append("process-close")


class _Factory:
    def __init__(self, body: bytes) -> None:
        self.events: list[str] = []
        self.process = _Process(body, self.events)
        self.downloads_path: str | None = None
        self.binding_addresses: tuple[str, ...] = ()

    def __call__(
        self,
        *,
        downloads_path: str,
        connection_binding: object,
    ) -> _Process:
        self.downloads_path = downloads_path
        self.binding_addresses = tuple(getattr(connection_binding, "verified_addresses"))
        return self.process


pdf = _pdf()
resolver = _Resolver()
factory = _Factory(pdf)
client = BrowserClient(
    factory=factory,
    resolver=resolver,
    coordinator=AccessCoordinator(),
    destination_policy=DestinationPolicy(allowed_classes=frozenset({AddressClass.PUBLIC})),
)
rule = BrowserSiteRule(
    rule_id="controlled-publisher",
    revision=1,
    landing_origin="https://publisher.test",
    allowed_origins=(
        "https://publisher.test",
        "https://downloads.publisher.test",
    ),
    web_scope_provider_name="publisher.test",
    actions=(
        BrowserRuleAction(
            kind=BrowserActionKind.CLICK,
            selector="a[data-action='pdf']",
        ),
    ),
    capture_url_prefixes=("https://downloads.publisher.test/article.pdf",),
    page_markers=(
        BrowserPageMarker(
            marker_id="login-required",
            kind=BrowserPageMarkerKind.LOGIN_REQUIRED,
            css_selectors=("#login-required",),
        ),
        BrowserPageMarker(
            marker_id="mfa-required",
            kind=BrowserPageMarkerKind.MFA_REQUIRED,
            css_selectors=("#mfa-required",),
        ),
    ),
)
source = ControlledBrowserPdfSource(
    runner=client,
    rule_catalog=BrowserRuleCatalog((rule,)),
    provenance_id_factory=lambda: ProvenanceId(_id(10, 1)),
    clock=lambda: _TIME,
)
metadata = LiteratureMetadata(title="Controlled Browser acceptance")
literature = Literature(
    literature_id=LiteratureId(_id(11, 1)),
    meta_literature_id=MetaLiteratureId(_id(12, 1)),
    version_role=VersionRole.PUBLISHED,
    metadata=metadata,
    status=LiteratureStatus.UNREVIEWED,
)
observation = MetadataObservation(
    observation_id=ObservationId(_id(13, 1)),
    provenance=Provenance(
        provenance_id=ProvenanceId(_id(14, 1)),
        source_kind=SourceKind.METADATA_PROVIDER,
        source_name="controlled-metadata",
        source_record_id="controlled-record",
        observed_at=_TIME,
        input_sha256=_PDF_SHA256,
        parameters_sha256=None,
    ),
    metadata=metadata,
    asset_hints=(
        AssetHint(
            url=_LANDING,
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
evidence = build_acquisition_evidence(request)
tracker = CandidateKeyTracker()
deliveries = list(source._deliveries(request, evidence, tracker))
if len(deliveries) != 1:
    raise RuntimeError("controlled Browser did not produce exactly one delivery")
delivery = deliveries[0]
context = delivery.content.open()
if not isinstance(context, AbstractContextManager):
    raise RuntimeError("controlled Browser delivery did not expose a context manager")
with context as stream:
    delivered_pdf = stream.read()
delivery.content.discard()

runtime_context = factory.process.context
if runtime_context is None:
    raise RuntimeError("controlled Browser runtime never created a context")
page = runtime_context.pages[0]
downloads_path = factory.downloads_path
payload = {
    "candidate": {
        "acquisition_path": delivery.candidate.acquisition_path.value,
        "candidate_key": delivery.candidate.candidate_key,
        "declared_media_type": delivery.candidate.declared_media_type,
        "safe_source_url": delivery.safe_source_url,
        "source_name": delivery.candidate.source_name,
    },
    "evidence": {
        "applicable": bool(source._actions(evidence)),
        "priority": [item.value for item in evidence.priority],
        "tried_candidate_keys": sorted(tracker.tried_candidate_keys),
    },
    "product_module_files": {
        "browser": browser_module.__file__,
        "source": source_module.__file__,
    },
    "production_boundary": {
        "catalog_rule_count": len(PRODUCTION_BROWSER_RULE_CATALOG.rules),
        "readiness_code": None
        if CONTROLLED_BROWSER_PRODUCTION_STATUS.failure is None
        else CONTROLLED_BROWSER_PRODUCTION_STATUS.failure.code,
        "ready": CONTROLLED_BROWSER_PRODUCTION_STATUS.readiness is RouteReadiness.READY,
    },
    "provenance": delivery.provenance.model_dump(mode="json"),
    "runtime": {
        "context_closed": runtime_context.closed,
        "download_deleted": runtime_context.download.deleted,
        "downloads_path_absolute": downloads_path is not None
        and Path(downloads_path).is_absolute(),
        "downloads_path_exists_after_run": downloads_path is not None
        and Path(downloads_path).exists(),
        "events": factory.events,
        "factory_binding_addresses": factory.binding_addresses,
        "page_closed": page.closed,
        "page_clicks": page.clicked,
        "process_closed": factory.process.closed,
        "resolver_calls": resolver.calls,
        "route_bindings": [list(route.binding_addresses) for route in runtime_context.routes],
        "route_urls": [route.request.url for route in runtime_context.routes],
    },
    "verification": {
        "delivered_pdf_sha256": sha256_digest(delivered_pdf).root,
        "expected_pdf_sha256": sha256_digest(pdf).root,
    },
    "temporary_root_name": Path(os.environ["SCIRETRIEVER_ACCEPTANCE_ROOT"]).name,
}
print(json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")))
