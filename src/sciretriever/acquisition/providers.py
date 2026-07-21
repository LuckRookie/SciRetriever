"""Native synchronous P4 acquisition providers."""

from __future__ import annotations

import json
from typing import Mapping
from urllib.parse import quote, urlencode

from sciretriever.acquisition.models import (
    AcquisitionTarget,
    AcquisitionTransport,
    HttpResponse,
    ProviderContent,
)
from sciretriever.acquisition.url_policy import UrlPolicy
from sciretriever.core.enums import AssetRole
from sciretriever.errors import (
    AcquisitionError,
    ProviderErrorCategory,
    classify_provider_http_status,
)
from sciretriever.integrations import (
    ArxivClient,
    CrossrefClient,
    EuropePmcClient,
    IntegrationError,
)


def _identifier(target: AcquisitionTarget, namespace: str) -> str:
    for item in target.identifiers:
        if item.namespace == namespace:
            return item.value
    raise AcquisitionError(f"provider requires a {namespace} identifier")


def _primary_pdf_only(target: AcquisitionTarget, provider: str) -> None:
    if target.role is not AssetRole.PRIMARY_PDF:
        raise AcquisitionError(f"{provider} supports primary PDF acquisition only")


def _json(response: HttpResponse, provider: str) -> object:
    if response.status != 200:
        raise ProviderAcquisitionError.for_status(provider, response.status)
    try:
        return json.loads(response.body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ProviderAcquisitionError(
            provider,
            ProviderErrorCategory.INVALID_RESPONSE,
            "invalid JSON response",
            False,
        ) from error


class ProviderAcquisitionError(AcquisitionError):
    def __init__(self, provider: str, category: ProviderErrorCategory, message: str, retryable: bool, status: int | None = None) -> None:
        super().__init__(message)
        self.provider = provider
        self.category = category
        self.retryable = retryable
        self.status = status

    @classmethod
    def for_status(cls, provider: str, status: int) -> "ProviderAcquisitionError":
        category, retryable = classify_provider_http_status(status)
        return cls(provider, category, f"{provider} returned HTTP {status}", retryable, status)

    @classmethod
    def invalid_response(cls, provider: str, message: str) -> "ProviderAcquisitionError":
        return cls(provider, ProviderErrorCategory.INVALID_RESPONSE, message, False)


class _BaseProvider:
    name = "base"

    def __init__(self, transport: AcquisitionTransport, policy: UrlPolicy | None = None) -> None:
        self.transport = transport
        self.policy = policy or UrlPolicy()

    def _get(
        self,
        url: str,
        timeout: float,
        headers: Mapping[str, str] | None = None,
    ) -> HttpResponse:
        response = (
            self.transport.get(url, timeout=timeout)
            if headers is None
            else self.transport.get(url, timeout=timeout, headers=headers)
        )
        if response.status != 200:
            raise ProviderAcquisitionError.for_status(self.name, response.status)
        return response

    def _content(
        self,
        response: HttpResponse,
        target: AcquisitionTarget,
        *,
        provenance: dict[str, object] | None = None,
    ) -> ProviderContent:
        format_by_role = {
            AssetRole.PRIMARY_PDF: "pdf",
            AssetRole.SUPPLEMENTARY_PDF: "pdf",
            AssetRole.XML: "xml",
            AssetRole.HTML: "html",
        }
        return ProviderContent(
            target.role,
            response.headers.get("content-type", "application/octet-stream"),
            format_by_role[target.role],
            response.url,
            self.name,
            response.body,
            provenance or {},
        )


class DirectHttpsProvider(_BaseProvider):
    name = "direct"

    def initial_url(self, target: AcquisitionTarget) -> str:
        if target.direct_url is None:
            raise AcquisitionError("direct provider requires a URL")
        return target.direct_url

    def acquire(self, target: AcquisitionTarget, *, timeout: float) -> ProviderContent:
        return self._content(self._get(self.initial_url(target), timeout), target)


class ArxivProvider(_BaseProvider):
    name = "arxiv"

    def __init__(
        self, transport: AcquisitionTransport, policy: UrlPolicy | None = None
    ) -> None:
        super().__init__(transport, policy)
        self._client = ArxivClient(transport, user_agent=None)

    def initial_url(self, target: AcquisitionTarget) -> str:
        return self._client.pdf_url(_identifier(target, "arxiv"))

    def acquire(self, target: AcquisitionTarget, *, timeout: float) -> ProviderContent:
        _primary_pdf_only(target, "arXiv")
        return self._content(self._get(self.initial_url(target), timeout), target)


class CrossrefProvider(_BaseProvider):
    name = "crossref"

    def __init__(
        self, transport: AcquisitionTransport, policy: UrlPolicy | None = None
    ) -> None:
        super().__init__(transport, policy)
        self._client = CrossrefClient(transport, user_agent=None)

    def initial_url(self, target: AcquisitionTarget) -> str:
        return self._client.work_url(_identifier(target, "doi"))

    def acquire(self, target: AcquisitionTarget, *, timeout: float) -> ProviderContent:
        _primary_pdf_only(target, "Crossref")
        try:
            url, resolver_url = self._client.resolve_pdf_doi(
                _identifier(target, "doi"), timeout=timeout
            )
        except IntegrationError as error:
            raise _integration_acquisition_error(self.name, error) from error
        return self._content(
            self._get(url, timeout),
            target,
            provenance={"resolver_url": resolver_url},
        )


class UnpaywallProvider(_BaseProvider):
    name = "unpaywall"

    def __init__(self, transport: AcquisitionTransport, email: str, policy: UrlPolicy | None = None) -> None:
        super().__init__(transport, policy)
        if not email.strip():
            raise ValueError("Unpaywall email must not be blank")
        self.email = email.strip()

    def initial_url(self, target: AcquisitionTarget) -> str:
        doi = _identifier(target, "doi")
        return f"https://api.unpaywall.org/v2/{quote(doi, safe='')}"

    def acquire(self, target: AcquisitionTarget, *, timeout: float) -> ProviderContent:
        _primary_pdf_only(target, "Unpaywall")
        clean_url = self.initial_url(target)
        request_url = f"{clean_url}?{urlencode({'email': self.email})}"
        response = self._get(request_url, timeout)
        api = HttpResponse(
            response.status,
            clean_url,
            response.headers,
            response.body,
        )
        payload = _json(api, self.name)
        if not isinstance(payload, dict):
            raise ProviderAcquisitionError.invalid_response(self.name, "invalid Unpaywall response")
        best = payload.get("best_oa_location")
        others = payload.get("oa_locations")
        if best is not None and not isinstance(best, dict):
            raise ProviderAcquisitionError.invalid_response(self.name, "invalid Unpaywall best location")
        if not isinstance(others, list):
            raise ProviderAcquisitionError.invalid_response(self.name, "invalid Unpaywall location list")
        if any(not isinstance(item, dict) for item in others):
            raise ProviderAcquisitionError.invalid_response(self.name, "invalid Unpaywall location entry")
        locations = [best, *others]
        for location in locations:
            if isinstance(location, dict) and isinstance(location.get("url_for_pdf"), str):
                return self._content(self._get(location["url_for_pdf"], timeout), target, provenance={"resolver_url": api.url})
        raise ProviderAcquisitionError.invalid_response(self.name, "Unpaywall supplied no PDF location")


class EuropePmcProvider(_BaseProvider):
    name = "europe-pmc"

    def __init__(
        self, transport: AcquisitionTransport, policy: UrlPolicy | None = None
    ) -> None:
        super().__init__(transport, policy)
        self._client = EuropePmcClient(transport, user_agent=None)

    def initial_url(self, target: AcquisitionTarget) -> str:
        namespace = "pmid" if any(item.namespace == "pmid" for item in target.identifiers) else "doi"
        value = _identifier(target, namespace)
        return self._client.lookup_url(
            pmid=value if namespace == "pmid" else None,
            doi=value if namespace == "doi" else None,
        )

    def acquire(self, target: AcquisitionTarget, *, timeout: float) -> ProviderContent:
        _primary_pdf_only(target, "Europe PMC")
        pmid = next(
            (item.value for item in target.identifiers if item.namespace == "pmid"),
            None,
        )
        doi = None if pmid is not None else _identifier(target, "doi")
        try:
            pdf_url, resolver_url = self._client.resolve_pdf_route(
                doi=doi, pmid=pmid, timeout=timeout
            )
        except IntegrationError as error:
            raise _integration_acquisition_error(self.name, error) from error
        return self._content(
            self._get(pdf_url, timeout),
            target,
            provenance={"resolver_url": resolver_url},
        )


def _integration_acquisition_error(
    provider: str, error: IntegrationError
) -> ProviderAcquisitionError:
    if error.status is not None:
        return ProviderAcquisitionError.for_status(provider, error.status)
    return ProviderAcquisitionError.invalid_response(provider, str(error))


__all__ = ("ArxivProvider", "CrossrefProvider", "DirectHttpsProvider", "EuropePmcProvider", "ProviderAcquisitionError", "UnpaywallProvider")
