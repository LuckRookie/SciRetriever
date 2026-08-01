from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass
import json
from typing import Any
from urllib.parse import urlsplit

import requests


MAX_PROBE_BYTES = 65_536


@dataclass(frozen=True, slots=True)
class ProbeIdentity:
    identity: str
    capabilities: frozenset[str] = frozenset()
    detail: str = ""


SchemaParser = Callable[[Mapping[str, Any]], ProbeIdentity]


def _explicit_marker(payload: Mapping[str, Any]) -> ProbeIdentity | None:
    service = payload.get("service")
    capabilities = payload.get("capabilities")
    if not isinstance(service, str) or not isinstance(capabilities, list):
        return None
    if not all(isinstance(capability, str) for capability in capabilities):
        raise RuntimeError("read-only readiness capability marker is invalid")
    return ProbeIdentity(service, frozenset(capabilities))


def parse_crossref(payload: Mapping[str, Any]) -> ProbeIdentity:
    marker = _explicit_marker(payload)
    if marker is not None:
        return marker
    if payload.get("status") != "ok" or payload.get("message-type") != "work-list":
        raise RuntimeError("read-only readiness response has an unknown service schema")
    return ProbeIdentity("crossref", frozenset({"acquisition"}))


def parse_openalex(payload: Mapping[str, Any]) -> ProbeIdentity:
    marker = _explicit_marker(payload)
    if marker is not None:
        return marker
    identifier = payload.get("id")
    if not isinstance(identifier, str) or not identifier.startswith("https://openalex.org/"):
        raise RuntimeError("read-only readiness response has an unknown service schema")
    capabilities = {"acquisition"}
    if isinstance(payload.get("referenced_works"), list):
        capabilities.add("graph:references")
    if isinstance(payload.get("cited_by_api_url"), str):
        capabilities.add("graph:cited-by")
    return ProbeIdentity("openalex", frozenset(capabilities))


def parse_semantic_scholar(payload: Mapping[str, Any]) -> ProbeIdentity:
    marker = _explicit_marker(payload)
    if marker is not None:
        return marker
    if not isinstance(payload.get("paperId"), str):
        raise RuntimeError("read-only readiness response has an unknown service schema")
    capabilities = {"acquisition"}
    if isinstance(payload.get("references"), list):
        capabilities.add("graph:references")
    if isinstance(payload.get("citations"), list):
        capabilities.add("graph:cited-by")
    return ProbeIdentity("semantic-scholar", frozenset(capabilities))


@dataclass(frozen=True, slots=True)
class HttpJsonProbe:
    endpoint: str
    parser: SchemaParser

    def probe(self, timeout: float) -> ProbeIdentity:
        with requests.get(
            self.endpoint,
            timeout=timeout,
            allow_redirects=False,
            headers={"Accept": "application/json"},
            stream=True,
        ) as response:
            if not 200 <= response.status_code < 300:
                raise RuntimeError("read-only readiness request returned a non-success status")
            if urlsplit(response.url).hostname != urlsplit(self.endpoint).hostname:
                raise RuntimeError("read-only readiness response changed endpoint identity")
            declared = response.headers.get("Content-Length")
            if declared is not None:
                try:
                    declared_size = int(declared)
                except ValueError:
                    raise RuntimeError("read-only readiness response size is invalid") from None
                if declared_size < 0 or declared_size > MAX_PROBE_BYTES:
                    raise RuntimeError("read-only readiness response exceeds size bound")
            content = bytearray()
            for chunk in response.iter_content(chunk_size=8_192):
                content.extend(chunk)
                if len(content) > MAX_PROBE_BYTES:
                    raise RuntimeError("read-only readiness response exceeds size bound")
        try:
            payload = json.loads(content)
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise RuntimeError("read-only readiness response is not valid JSON") from None
        if not isinstance(payload, dict):
            raise RuntimeError("read-only readiness response is not a JSON object")
        return self.parser(payload)


__all__ = (
    "HttpJsonProbe", "MAX_PROBE_BYTES", "ProbeIdentity", "parse_crossref",
    "parse_openalex", "parse_semantic_scholar",
)
