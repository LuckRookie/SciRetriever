"""Offline wire fixture for installed-console production-Bootstrap acceptance.

This module is copied into the fresh venv after wheel installation.  It is not
part of the SciRetriever distribution and replaces only the resolver and HTTP
transport constructors.  All request preparation, policy, admission, Provider
conversion, Bootstrap, Entry, SQLite and ArtifactStore code remains production
code from the installed wheel.
"""

from __future__ import annotations

import base64
import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol
from urllib.parse import parse_qs, urlsplit

_MINERU_SUBMISSION_COUNT = 0
_NO_USABLE_PDF_REQUEST_COUNT = 0


@dataclass(slots=True)
class _Response:
    status: int
    headers: tuple[tuple[str, str], ...]
    body: bytes
    closed: bool = False

    def close(self) -> None:
        self.closed = True


class _Resolver:
    def resolve(self, hostname: str) -> tuple[str, ...]:
        _record({"kind": "resolve", "hostname": hostname})
        return ("93.184.216.34",)


class _RequestTargetRenderer(Protocol):
    def render(self, request: object, destination: object) -> str: ...


class _Transport:
    def __init__(self, *args: object, **kwargs: object) -> None:
        del args, kwargs

    def send(
        self,
        request: object,
        destination: object,
        *,
        headers: tuple[tuple[str, str], ...],
        request_target_renderer: _RequestTargetRenderer,
        connect_timeout_seconds: float,
        read_timeout_seconds: float,
        tls_server_hostname: str | None,
        cancel_event: object,
    ) -> _Response:
        del connect_timeout_seconds, read_timeout_seconds, cancel_event
        url = getattr(request, "url")
        method = getattr(request, "method")
        body = getattr(request, "body")
        wire_target = request_target_renderer.render(request, destination)
        parsed = urlsplit(url)
        wire = urlsplit(wire_target)
        _record(
            {
                "kind": "request",
                "method": method,
                "host": parsed.hostname,
                "path": wire.path,
                "query_keys": sorted(parse_qs(wire.query)),
                "credential_header_names": sorted(
                    name.casefold()
                    for name, _value in headers
                    if name.casefold() in {"authorization", "x-api-key"}
                ),
                "tls_server_hostname": tls_server_hostname,
            }
        )
        return _route(method, parsed.hostname or "", wire.path, wire.query, body)

    def close(self) -> None:
        return None


def _root() -> Path:
    value = os.environ.get("SCIRETRIEVER_ACCEPTANCE_ROOT")
    if value is None:
        raise RuntimeError("acceptance root is unavailable")
    return Path(value)


def _record(payload: dict[str, object]) -> None:
    payload = {"scenario": _scenario(), **payload}
    path = _root() / "production-wire.ndjson"
    with path.open("a", encoding="utf-8") as stream:
        stream.write(json.dumps(payload, ensure_ascii=True, separators=(",", ":")) + "\n")


def _scenario() -> str:
    return os.environ.get("SCIRETRIEVER_ACCEPTANCE_SCENARIO", "bootstrap")


def _case_root() -> Path:
    value = os.environ.get("SCIRETRIEVER_ACCEPTANCE_CASE_ROOT")
    return _root() if value is None else Path(value)


def _json_response(payload: object, *, status: int = 200) -> _Response:
    return _Response(
        status=status,
        headers=(("Content-Type", "application/json"),),
        body=json.dumps(payload, ensure_ascii=True, separators=(",", ":")).encode("utf-8"),
    )


def _responses_sse_response(payload: dict[str, object]) -> _Response:
    terminal = json.loads(json.dumps(payload))
    output = terminal.get("output")
    if not isinstance(output, list):
        raise RuntimeError("Responses fixture output is invalid")
    blocks: list[bytes] = []
    for index, item in enumerate(output):
        event = {
            "type": "response.output_item.done",
            "output_index": index,
            "item": item,
        }
        blocks.append(
            b"event: response.output_item.done\ndata: "
            + json.dumps(event, ensure_ascii=True, separators=(",", ":")).encode("utf-8")
            + b"\n\n"
        )
    terminal["output"] = []
    completed = {"type": "response.completed", "response": terminal}
    blocks.append(
        b"event: response.completed\ndata: "
        + json.dumps(completed, ensure_ascii=True, separators=(",", ":")).encode("utf-8")
        + b"\n\n"
    )
    return _Response(
        status=200,
        headers=(("Content-Type", "text/event-stream"),),
        body=b"".join(blocks),
    )


def _semantic_paper(
    paper_id: str,
    *,
    title: str,
    doi: str,
    pdf_url: str | None = None,
) -> dict[str, object]:
    return {
        "paperId": paper_id,
        "externalIds": {"DOI": doi},
        "title": title,
        "abstract": "Controlled production-Bootstrap acceptance abstract.",
        "url": f"https://www.semanticscholar.org/paper/{paper_id}",
        "venue": "Acceptance Journal",
        "publicationVenue": None,
        "journal": {"name": "Acceptance Journal", "pages": "1-2", "volume": "1"},
        "year": 2026,
        "publicationDate": "2026-08-13",
        "publicationTypes": ["JournalArticle"],
        "authors": [{"name": "Acceptance Author"}],
        "referenceCount": 1,
        "citationCount": 1,
        "isOpenAccess": pdf_url is not None,
        "openAccessPdf": None
        if pdf_url is None
        else {"url": pdf_url, "status": "OPEN", "license": "CC-BY"},
    }


def _semantic_route(path: str, query: str) -> _Response:
    parameters = parse_qs(query)
    if path == "/graph/v1/paper/search":
        if _scenario() == "r8-batch":
            papers = (
                _semantic_paper(
                    "6666666666666666666666666666666666666666",
                    title="R8 production batch success",
                    doi="10.5555/r8.production.success",
                    pdf_url="https://r8-success.example.org/success.pdf",
                ),
                _semantic_paper(
                    "7777777777777777777777777777777777777777",
                    title="R8 production batch retry",
                    doi="10.5555/r8.production.retry",
                    pdf_url="https://r8-retry.example.net/retry.pdf",
                ),
            )
            return _json_response({"total": 2, "offset": 0, "data": papers})
        if _scenario() == "no-usable-content":
            paper = _semantic_paper(
                "5555555555555555555555555555555555555555",
                title="Production candidate replacement study",
                doi="10.5555/production.candidate-replacement",
                pdf_url="https://assets.example.org/candidate-semantic.pdf",
            )
            return _json_response({"total": 1, "offset": 0, "data": [paper]})
        papers = tuple(
            _semantic_paper(
                str(index) * 40,
                title="Production Bootstrap study",
                doi="10.5555/production.bootstrap",
                pdf_url="https://assets.example.org/production-bootstrap.pdf",
            )
            for index in (1, 3, 4)
        )
        return _json_response({"total": 4, "offset": 0, "next": 3, "data": papers})
    if path.endswith("/references"):
        anchor = path.removesuffix("/references").rsplit("/", 1)[-1]
        if anchor != "1111111111111111111111111111111111111111":
            return _json_response({"offset": 0, "data": []})
        target = _semantic_paper(
            "2222222222222222222222222222222222222222",
            title="Production citation target",
            doi="10.5555/production.citation",
        )
        return _json_response({"offset": 0, "data": [{"citedPaper": target}]})
    if path.endswith("/citations"):
        return _json_response({"offset": 0, "data": []})
    if path.startswith("/graph/v1/paper/"):
        selected = path.rsplit("/", 1)[-1]
        return _json_response(
            _semantic_paper(
                selected,
                title="Production citation target",
                doi="10.5555/production.citation",
            )
        )
    raise RuntimeError(f"unexpected Semantic Scholar path: {path} {parameters!r}")


def _crossref_route(path: str, query: str) -> _Response:
    if path != "/works":
        raise RuntimeError(f"unexpected Crossref path: {path}")
    parameters = parse_qs(query)
    cursor = parameters.get("cursor")
    if cursor == ["*"]:
        if _scenario() == "no-usable-content":
            return _json_response(
                {
                    "status": "ok",
                    "message-type": "work-list",
                    "message-version": "1.0.0",
                    "message": {
                        "total-results": 1,
                        "items": [
                            {
                                "DOI": "10.5555/PRODUCTION.CANDIDATE-REPLACEMENT",
                                "URL": "https://doi.org/10.5555/production.candidate-replacement",
                                "title": ["Production candidate replacement study"],
                                "type": "journal-article",
                                "published": {"date-parts": [[2026, 8, 13]]},
                                "link": [
                                    {
                                        "URL": "https://assets.example.org/candidate-crossref.pdf",
                                        "content-type": "application/pdf",
                                        "content-version": "vor",
                                    }
                                ],
                            }
                        ],
                    },
                }
            )
        return _json_response(
            {
                "status": "ok",
                "message-type": "work-list",
                "message-version": "1.0.0",
                "message": {
                    "total-results": 2,
                    "next-cursor": "acceptance-next",
                    "items": [
                        {
                            "DOI": "10.5555/PRODUCTION.BOOTSTRAP",
                            "URL": "https://doi.org/10.5555/production.bootstrap",
                            "title": ["Production Bootstrap study"],
                            "abstract": "Controlled production-Bootstrap acceptance abstract.",
                            "author": [{"given": "Acceptance", "family": "Author"}],
                            "type": "journal-article",
                            "container-title": ["Acceptance Journal"],
                            "published": {"date-parts": [[2026, 8, 13]]},
                            "reference-count": 1,
                            "is-referenced-by-count": 1,
                        }
                    ],
                },
            }
        )
    if cursor == ["acceptance-next"]:
        return _json_response({"message": "controlled failure"}, status=503)
    raise RuntimeError(f"unexpected Crossref query: {parameters!r}")


def _openai_response(body: bytes | None) -> _Response:
    if body is None:
        raise RuntimeError("OpenAI fixture received no request body")
    request = json.loads(body)
    if request.get("stream") is not True:
        raise RuntimeError("OpenAI Responses acceptance request must enable streaming")
    model = request["model"]
    structured_input = json.loads(request["input"][1]["content"][0]["text"])
    if structured_input == {"probe": "sciretriever-configuration"}:
        result = {"ok": True}
    elif "initial_metadata" in structured_input:
        parser_markdown = structured_input.get("parser_markdown", "")
        if _scenario() == "no-usable-content" and "Rejected candidate" in parser_markdown:
            result = {"outcome": "no_usable_content", "metadata": None}
        else:
            result = {
                "outcome": "usable",
                "metadata": structured_input["initial_metadata"],
            }
    elif "parser_markdown" in structured_input:
        accepted_replacement = "Accepted candidate" in structured_input["parser_markdown"]
        background = (
            "The full controlled study is available."
            if accepted_replacement
            else "The controlled production Bootstrap study evaluates retrieval."
        )
        reference = (
            "Controlled accepted reference."
            if accepted_replacement
            else "Controlled production reference."
        )
        result = {
            "markdown": (
                "# 研究背景与目标\n\n"
                f"{background}\n\n"
                "# 研究方法\n\n未提供\n\n"
                "# 数据\n\n未提供\n\n"
                "# 结论与局限性\n\n未提供\n\n"
                f"# 参考文献\n\n1. {reference}"
            )
        }
    elif "references" in structured_input:
        result = {
            "lookups": [
                {
                    "reference_index": item["reference_index"],
                    "identifiers": [],
                    "title": item["raw_text"],
                    "authors": [],
                    "publication_year": None,
                }
                for item in structured_input["references"]
            ]
        }
    else:
        raise RuntimeError("unexpected Analysis structured input")
    return _responses_sse_response(
        {
            "id": "resp_acceptance",
            "object": "response",
            "status": "completed",
            "model": model,
            "usage": {"input_tokens": 1, "output_tokens": 1},
            "output": [
                {
                    "id": "msg_acceptance",
                    "type": "message",
                    "status": "completed",
                    "role": "assistant",
                    "content": [
                        {
                            "type": "output_text",
                            "text": json.dumps(
                                result,
                                ensure_ascii=False,
                                separators=(",", ":"),
                            ),
                            "annotations": [],
                        }
                    ],
                }
            ],
        }
    )


def _mineru_route(method: str, path: str) -> _Response:
    global _MINERU_SUBMISSION_COUNT

    if method == "GET" and path == "/health":
        return _json_response({"status": "healthy", "version": "3.4.4", "protocol_version": 2})
    if method == "POST" and path == "/tasks":
        _MINERU_SUBMISSION_COUNT += 1
        task_id = f"acceptance-task-{_MINERU_SUBMISSION_COUNT}"
        return _json_response({"task_id": task_id, "status": "completed"}, status=202)
    if method == "GET" and path.startswith("/tasks/acceptance-task-") and path.endswith("/result"):
        task_id = path.removeprefix("/tasks/acceptance-task-").removesuffix("/result")
        if _scenario() == "no-usable-content":
            payload = _case_root().joinpath(f"mineru-{task_id}.zip").read_bytes()
        else:
            payload = base64.b64decode(os.environ["SCIRETRIEVER_TEST_MINERU_ARCHIVE"])
        return _Response(200, (("Content-Type", "application/zip"),), payload)
    raise RuntimeError(f"unexpected MinerU request: {method} {path}")


def _route(
    method: str,
    hostname: str,
    path: str,
    query: str,
    body: bytes | None,
) -> _Response:
    global _NO_USABLE_PDF_REQUEST_COUNT

    if hostname == "api.semanticscholar.org":
        return _semantic_route(path, query)
    if hostname == "api.crossref.org":
        return _crossref_route(path, query)
    if _scenario() == "r8-batch" and hostname == "r8-retry.example.net" and path == "/retry.pdf":
        marker = _case_root() / "r8-retry-seen"
        if not marker.exists():
            marker.write_text("seen\n", encoding="utf-8")
            return _json_response({"message": "controlled retry"}, status=503)
        payload = _case_root().joinpath("r8-retry.pdf").read_bytes()
        return _Response(200, (("Content-Type", "application/pdf"),), payload)
    if (
        _scenario() == "r8-batch"
        and hostname == "r8-success.example.org"
        and path == "/success.pdf"
    ):
        payload = _case_root().joinpath("r8-success.pdf").read_bytes()
        return _Response(200, (("Content-Type", "application/pdf"),), payload)
    asset_files = {
        "/production-bootstrap.pdf": "input.pdf",
        "/candidate-crossref.pdf": "candidate-crossref.pdf",
        "/candidate-semantic.pdf": "candidate-semantic.pdf",
    }
    if hostname == "assets.example.org" and path in asset_files:
        if _scenario() == "no-usable-content":
            _NO_USABLE_PDF_REQUEST_COUNT += 1
            selected = (
                "candidate-crossref.pdf"
                if _NO_USABLE_PDF_REQUEST_COUNT == 1
                else "candidate-semantic.pdf"
            )
        else:
            selected = asset_files[path]
        payload = _case_root().joinpath(selected).read_bytes()
        return _Response(200, (("Content-Type", "application/pdf"),), payload)
    if hostname == "api.openai.com" and path == "/v1/responses":
        return _openai_response(body)
    if hostname == "127.0.0.1":
        return _mineru_route(method, path)
    raise RuntimeError(f"unexpected acceptance destination: {hostname}{path}")


def install() -> None:
    import sciretriever.network.http as network_http

    network_http.SystemResolver = _Resolver
    network_http.SecureHttpTransport = _Transport
