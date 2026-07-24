"""Direct and open-access candidate resolvers."""

from __future__ import annotations

import hashlib
import json
from typing import Mapping
from urllib.parse import quote, urlencode, urlsplit

from sciretriever.acquisition.candidates import RuntimeDownloadCandidate, make_download_candidate_id
from sciretriever.acquisition.models import AcquisitionTarget, AcquisitionTransport
from sciretriever.core.enums import AssetRole
from sciretriever.errors import AcquisitionError, ProviderErrorCategory, classify_provider_http_status
from sciretriever.integrations import ArxivClient, CrossrefClient, EuropePmcClient, IntegrationError
from sciretriever.integrations import OpenAlexClient, SemanticScholarClient


def _identifier(target: AcquisitionTarget, namespace: str) -> str:
    value = next((item.value for item in target.identifiers if item.namespace == namespace), None)
    if value is None:
        raise AcquisitionError(f"provider requires a {namespace} identifier")
    return value


def _pdf_only(role: AssetRole, provider: str) -> None:
    if role is not AssetRole.PRIMARY_PDF:
        raise AcquisitionError(f"{provider} does not support {role.value}")


def _identity(provider: str, url: str) -> str:
    host = urlsplit(url).hostname or "unknown"
    digest = hashlib.sha256(url.encode()).hexdigest()[:16]
    return f"host:{provider}-{host.replace('.', '-')}-{digest}"[:223]


def _candidate(
    provider: str,
    resolver_id: str,
    role: AssetRole,
    url: str,
    priority: int,
    *,
    headers: Mapping[str, str] | None = None,
    params: Mapping[str, str] | None = None,
    media_type: str | None = None,
) -> RuntimeDownloadCandidate:
    cursor = f"rc1:item-{priority}"
    return RuntimeDownloadCandidate(
        make_download_candidate_id(provider, resolver_id, role, cursor),
        provider,
        resolver_id,
        provider,
        cursor,
        url,
        role,
        priority,
        "https",
        "resolver",
        _identity(provider, url),
        {"provider": provider, "candidate_index": priority},
        request_headers=headers or {},
        request_params=params or {},
        media_type_hint=media_type,
    )


class ProviderAcquisitionError(AcquisitionError):
    def __init__(self, provider: str, category: ProviderErrorCategory, message: str, retryable: bool, status: int | None = None, retry_after: int | None = None) -> None:
        super().__init__(message)
        self.provider = provider
        self.category = category
        self.retryable = retryable
        self.status = status
        self.retry_after = retry_after if retryable else None

    @classmethod
    def for_status(cls, provider: str, status: int) -> "ProviderAcquisitionError":
        category, retryable = classify_provider_http_status(status)
        return cls(provider, category, f"{provider} returned HTTP {status}", retryable, status)

    @classmethod
    def for_response(cls, provider: str, response) -> "ProviderAcquisitionError":
        category, retryable = classify_provider_http_status(response.status)
        retry_after = None
        if retryable:
            value = response.headers.get("retry-after")
            if isinstance(value, str):
                candidate = value.strip()
                if candidate.isascii() and candidate.isdecimal() and len(candidate) <= 10:
                    parsed = int(candidate)
                    retry_after = parsed if parsed <= 2_147_483_647 else None
        return cls(
            provider, category, f"{provider} returned HTTP {response.status}",
            retryable, response.status, retry_after,
        )

    @classmethod
    def invalid_response(cls, provider: str, message: str) -> "ProviderAcquisitionError":
        return cls(provider, ProviderErrorCategory.INVALID_RESPONSE, message, False)


class DirectHttpsResolver:
    provider = resolver_id = "direct"

    def resolve(self, target: AcquisitionTarget, role: AssetRole, *, timeout: float) -> tuple[RuntimeDownloadCandidate, ...]:
        del timeout
        if target.direct_url is None:
            raise AcquisitionError("direct provider requires a persisted HTTPS locator")
        return (_candidate(self.provider, self.resolver_id, role, target.direct_url, 0),)


class ArxivResolver:
    provider = resolver_id = "arxiv"

    def resolve(self, target: AcquisitionTarget, role: AssetRole, *, timeout: float) -> tuple[RuntimeDownloadCandidate, ...]:
        del timeout
        _pdf_only(role, self.provider)
        url = ArxivClient.pdf_url(_identifier(target, "arxiv"))
        return (_candidate(self.provider, self.resolver_id, role, url, 0, media_type="application/pdf"),)


class _DoiLookupResolver:
    provider = "base"
    resolver_id = "base"

    def _resolve_url(self, doi: str, timeout: float) -> str:
        raise NotImplementedError

    def resolve(self, target: AcquisitionTarget, role: AssetRole, *, timeout: float) -> tuple[RuntimeDownloadCandidate, ...]:
        _pdf_only(role, self.provider)
        try:
            url = self._resolve_url(_identifier(target, "doi"), timeout)
        except IntegrationError as error:
            if error.status is not None:
                raise ProviderAcquisitionError.for_status(self.provider, error.status) from error
            raise ProviderAcquisitionError.invalid_response(self.provider, str(error)) from error
        return (_candidate(self.provider, self.resolver_id, role, url, 0, media_type="application/pdf"),)


class CrossrefResolver(_DoiLookupResolver):
    provider = resolver_id = "crossref"

    def __init__(self, transport: AcquisitionTransport) -> None:
        self._client = CrossrefClient(transport, user_agent=None)

    def _resolve_url(self, doi: str, timeout: float) -> str:
        return self._client.resolve_pdf_doi(doi, timeout=timeout)[0]


class EuropePmcResolver:
    provider = resolver_id = "europe-pmc"

    def __init__(self, transport: AcquisitionTransport) -> None:
        self._client = EuropePmcClient(transport, user_agent=None)

    def resolve(self, target: AcquisitionTarget, role: AssetRole, *, timeout: float) -> tuple[RuntimeDownloadCandidate, ...]:
        _pdf_only(role, self.provider)
        pmid = next((item.value for item in target.identifiers if item.namespace == "pmid"), None)
        doi = None if pmid is not None else _identifier(target, "doi")
        try:
            url = self._client.resolve_pdf_route(doi=doi, pmid=pmid, timeout=timeout)[0]
        except IntegrationError as error:
            if error.status is not None:
                raise ProviderAcquisitionError.for_status(self.provider, error.status) from error
            raise ProviderAcquisitionError.invalid_response(self.provider, str(error)) from error
        return (_candidate(self.provider, self.resolver_id, role, url, 0, media_type="application/pdf"),)


class OpenAlexResolver(_DoiLookupResolver):
    provider = resolver_id = "openalex"

    def __init__(self, transport: AcquisitionTransport) -> None:
        self._client = OpenAlexClient(transport)

    def _resolve_url(self, doi: str, timeout: float) -> str:
        return self._client.resolve_pdf_doi(doi, timeout=timeout)[0]


class SemanticScholarResolver(_DoiLookupResolver):
    provider = resolver_id = "semantic-scholar"

    def __init__(self, transport: AcquisitionTransport, api_key: str | None = None) -> None:
        self._client = SemanticScholarClient(transport, api_key=api_key)

    def _resolve_url(self, doi: str, timeout: float) -> str:
        return self._client.resolve_pdf_doi(doi, timeout=timeout)[0]


class UnpaywallResolver:
    provider = resolver_id = "unpaywall"

    def __init__(self, transport: AcquisitionTransport, email: str) -> None:
        if not isinstance(email, str) or not email.strip():
            raise ValueError("Unpaywall email must not be blank")
        self._transport = transport
        self._email = email.strip()

    def resolve(self, target: AcquisitionTarget, role: AssetRole, *, timeout: float) -> tuple[RuntimeDownloadCandidate, ...]:
        _pdf_only(role, self.provider)
        doi = _identifier(target, "doi")
        clean = f"https://api.unpaywall.org/v2/{quote(doi, safe='')}"
        response = self._transport.get(
            f"{clean}?{urlencode({'email': self._email})}", timeout=timeout
        )
        if response.status != 200:
            raise ProviderAcquisitionError.for_response(self.provider, response)
        try:
            payload = json.loads(response.body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ProviderAcquisitionError.invalid_response(self.provider, "invalid Unpaywall response") from error
        if not isinstance(payload, dict):
            raise ProviderAcquisitionError.invalid_response(self.provider, "invalid Unpaywall response")
        best = payload.get("best_oa_location")
        others = payload.get("oa_locations", [])
        if best is not None and not isinstance(best, dict):
            raise ProviderAcquisitionError.invalid_response(self.provider, "invalid Unpaywall best location")
        if not isinstance(others, list) or any(not isinstance(item, dict) for item in others):
            raise ProviderAcquisitionError.invalid_response(self.provider, "invalid Unpaywall locations")
        urls: list[str] = []
        for location in (best, *others):
            url = location.get("url_for_pdf") if isinstance(location, dict) else None
            if isinstance(url, str) and url.startswith("https://") and url not in urls:
                urls.append(url)
        if not urls:
            raise ProviderAcquisitionError.invalid_response(self.provider, "Unpaywall supplied no PDF location")
        return tuple(
            _candidate(self.provider, self.resolver_id, role, url, index, media_type="application/pdf")
            for index, url in enumerate(urls[:8])
        )


__all__ = (
    "ArxivResolver", "CrossrefResolver", "DirectHttpsResolver", "EuropePmcResolver",
    "OpenAlexResolver", "ProviderAcquisitionError", "SemanticScholarResolver",
    "UnpaywallResolver", "_candidate", "_identifier",
)
