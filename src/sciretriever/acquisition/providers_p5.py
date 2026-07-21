"""Native P5 OA and credential-gated publisher providers."""

from __future__ import annotations

from typing import Mapping
from urllib.parse import quote, urlencode, urlsplit
import xml.etree.ElementTree as ET

from sciretriever.acquisition.models import AcquisitionTarget, AcquisitionTransport, HttpResponse, ProviderContent
from sciretriever.acquisition.profiles import PublisherProfile, profile_for_provider
from sciretriever.acquisition.providers import ProviderAcquisitionError, _BaseProvider, _identifier
from sciretriever.acquisition.url_policy import UrlPolicy
from sciretriever.core.enums import AssetRole
from sciretriever.errors import AcquisitionError
from sciretriever.integrations import (
    ElsevierClient, IntegrationError, OpenAlexClient, SemanticScholarClient,
    SpringerClient,
)


def _pdf_only(target: AcquisitionTarget, provider: str) -> None:
    if target.role is not AssetRole.PRIMARY_PDF:
        raise AcquisitionError(f"{provider} supports primary PDF acquisition only")


class OpenAlexProvider(_BaseProvider):
    name = "openalex"

    def __init__(self, transport: AcquisitionTransport, policy: UrlPolicy | None = None) -> None:
        super().__init__(transport, policy)
        self._client = OpenAlexClient(transport)

    def initial_url(self, target: AcquisitionTarget) -> str:
        return self._client.work_url(_identifier(target, "doi"))

    def acquire(self, target: AcquisitionTarget, *, timeout: float) -> ProviderContent:
        _pdf_only(target, self.name)
        try:
            url, resolver_url = self._client.resolve_pdf_doi(
                _identifier(target, "doi"), timeout=timeout
            )
        except IntegrationError as error:
            if error.status is not None:
                raise ProviderAcquisitionError.for_status(self.name, error.status) from error
            raise ProviderAcquisitionError.invalid_response(self.name, str(error)) from error
        return self._content(self._get(url, timeout), target, provenance={"resolver_url": resolver_url})


class SemanticScholarProvider(_BaseProvider):
    name = "semantic-scholar"

    def __init__(self, transport: AcquisitionTransport, api_key: str | None = None, policy: UrlPolicy | None = None) -> None:
        super().__init__(transport, policy)
        self._client = SemanticScholarClient(transport, api_key=api_key)

    def initial_url(self, target: AcquisitionTarget) -> str:
        return self._client.paper_url(_identifier(target, "doi")) + "?fields=openAccessPdf"

    def acquire(self, target: AcquisitionTarget, *, timeout: float) -> ProviderContent:
        _pdf_only(target, self.name)
        try:
            url, resolver_url = self._client.resolve_pdf_doi(
                _identifier(target, "doi"), timeout=timeout
            )
        except IntegrationError as error:
            if error.status is not None:
                raise ProviderAcquisitionError.for_status(self.name, error.status) from error
            raise ProviderAcquisitionError.invalid_response(self.name, str(error)) from error
        return self._content(self._get(url, timeout), target, provenance={"resolver_url": resolver_url})


class _CredentialedProvider(_BaseProvider):
    header_name = "x-api-key"

    def __init__(
        self,
        transport: AcquisitionTransport,
        api_key: str | None,
        policy: UrlPolicy | None = None,
        *,
        profile: PublisherProfile | None = None,
    ) -> None:
        super().__init__(transport, policy)
        if api_key is None or not api_key.strip():
            raise AcquisitionError(f"{self.name} requires configured credentials")
        selected = profile if profile is not None else profile_for_provider(self.name)
        if selected is None:
            raise AcquisitionError(f"{self.name} has no publisher profile")
        if selected.provider != self.name:
            raise ValueError("publisher profile does not match provider")
        self.profile = selected
        self._headers: Mapping[str, str] = {self.header_name: api_key.strip()}

    def _require_role(self, target: AcquisitionTarget) -> None:
        if target.role not in self.profile.supported_roles:
            raise AcquisitionError(
                f"{self.name} profile does not support {target.role.value} acquisition"
            )

    def _endpoint(self, index: int, **values: str) -> str:
        try:
            endpoint = self.profile.endpoint_templates[index].format(**values)
        except (IndexError, KeyError, ValueError) as error:
            raise AcquisitionError(f"{self.name} profile has an invalid endpoint contract") from error
        if "{" in endpoint or "}" in endpoint:
            raise AcquisitionError(f"{self.name} profile endpoint is not fully resolved")
        host = urlsplit(endpoint).hostname
        if host not in self.profile.hosts:
            raise AcquisitionError(f"{self.name} profile endpoint host is not declared")
        return endpoint

    def _profile_content(
        self,
        response: HttpResponse,
        target: AcquisitionTarget,
        *,
        provenance: dict[str, object] | None = None,
    ) -> ProviderContent:
        content = self._content(response, target, provenance=provenance)
        media_type = content.media_type.split(";", 1)[0].strip().lower()
        if media_type not in self.profile.media_types:
            raise ProviderAcquisitionError.invalid_response(
                self.name,
                f"publisher profile rejects media type {media_type!r}",
            )
        return content


class WileyProvider(_CredentialedProvider):
    name = "wiley"
    header_name = "Wiley-TDM-Client-Token"

    def initial_url(self, target: AcquisitionTarget) -> str:
        self._require_role(target)
        return self._endpoint(0, doi=quote(_identifier(target, "doi"), safe=""))

    def acquire(self, target: AcquisitionTarget, *, timeout: float) -> ProviderContent:
        return self._profile_content(
            self._get(self.initial_url(target), timeout, self._headers),
            target,
        )


class ElsevierProvider(_CredentialedProvider):
    name = "elsevier"
    header_name = "X-ELS-APIKey"

    def __init__(self, transport: AcquisitionTransport, api_key: str | None,
                 policy: UrlPolicy | None = None, *,
                 profile: PublisherProfile | None = None) -> None:
        super().__init__(transport, api_key, policy, profile=profile)
        self._client = ElsevierClient(
            transport,
            api_key=next(iter(self._headers.values())),
            article_endpoint=self.profile.endpoint_templates[0],
            object_endpoint=self.profile.endpoint_templates[1],
        )

    def initial_url(self, target: AcquisitionTarget) -> str:
        self._require_role(target)
        return self._endpoint(0, doi=quote(_identifier(target, "doi"), safe=""))

    @staticmethod
    def _local_name(value: object) -> str:
        return str(value).rsplit("}", 1)[-1].split(":", 1)[-1].lower()

    @staticmethod
    def _text(element: ET.Element) -> str:
        return " ".join(" ".join(element.itertext()).split())

    @staticmethod
    def _pdf_eid(value: str) -> str | None:
        candidate = value.strip()
        lowered = candidate.lower()
        if ".pdf" in lowered:
            return candidate
        if lowered.startswith("eid:"):
            candidate = candidate.split(":", 1)[1].strip()
        if candidate.startswith("1-s2.0-"):
            return f"{candidate}-main.pdf"
        return None

    @classmethod
    def _metadata(cls, element: ET.Element) -> str:
        parts: list[str] = []
        for node in element.iter():
            text = cls._text(node)
            if text:
                parts.append(f"{cls._local_name(node.tag)}:{text}")
            parts.extend(
                f"{cls._local_name(name)}:{value}"
                for name, value in node.attrib.items()
                if value
            )
        return " ".join(parts).lower()

    @staticmethod
    def _score(eid: str, metadata: str, role: AssetRole) -> int:
        haystack = f"{eid} {metadata}".lower()
        score = (20 if eid.lower().endswith(".pdf") else 0) + (10 if "pdf" in haystack else 0)
        score += 5 if "page-count" in haystack or "pages" in haystack else 0
        score += 5 if any(marker in haystack for marker in ("attachment-size", "filesize", "file-size")) else 0
        main = any(marker in haystack for marker in ("main", "full-text", "fulltext"))
        supplementary = any(marker in haystack for marker in ("supplement", "supplementary", "mmc", "appendix", "graphical"))
        if role is AssetRole.SUPPLEMENTARY_PDF:
            return score + (100 if supplementary else 0) - (100 if main else 0)
        return score + (100 if main else 0) - (100 if supplementary else 0)

    @classmethod
    def _attachment_eid(cls, data: bytes, role: AssetRole) -> str | None:
        try:
            root = ET.fromstring(data)
        except ET.ParseError as error:
            raise ProviderAcquisitionError.invalid_response("elsevier", "invalid Elsevier XML") from error
        parents = {child: parent for parent in root.iter() for child in parent}
        candidates: list[tuple[int, int, str]] = []
        seen: set[str] = set()
        for element in root.iter():
            local = cls._local_name(element.tag)
            found: list[str] = []
            if local in {"attachment-eid", "object-eid"}:
                candidate = cls._pdf_eid(cls._text(element))
                if candidate is not None and ".pdf" in candidate.lower():
                    found.append(candidate)
            elif local in {"eid", "identifier"}:
                candidate = cls._pdf_eid(cls._text(element))
                if candidate is not None:
                    found.append(candidate)
            for name, value in element.attrib.items():
                if cls._local_name(name) in {"attachment-eid", "object-eid", "eid"}:
                    candidate = cls._pdf_eid(str(value))
                    if candidate is not None:
                        found.append(candidate)
            container = element
            while container in parents and not any(
                marker in cls._local_name(container.tag) for marker in ("attachment", "object", "web-pdf")
            ):
                container = parents[container]
            metadata = cls._metadata(container)
            for eid in found:
                if eid not in seen:
                    seen.add(eid)
                    candidates.append((cls._score(eid, metadata, role), len(candidates), eid))
        candidates.sort(key=lambda item: (-item[0], item[1]))
        return None if not candidates else candidates[0][2]

    def acquire(self, target: AcquisitionTarget, *, timeout: float) -> ProviderContent:
        self._require_role(target)
        article = self._client.retrieve_article(
            _identifier(target, "doi"), accept="application/xml", timeout=timeout
        )
        if article.status != 200:
            raise ProviderAcquisitionError.for_status(self.name, article.status)
        if target.role is AssetRole.XML:
            return self._profile_content(article, target)
        eid = self._attachment_eid(article.body, target.role)
        if eid is None:
            raise ProviderAcquisitionError.invalid_response(self.name, "Elsevier supplied no matching attachment EID")
        response = self._client.retrieve_object(
            eid, accept="application/pdf", timeout=timeout
        )
        if response.status != 200:
            raise ProviderAcquisitionError.for_status(self.name, response.status)
        return self._profile_content(response, target, provenance={"resolver_url": article.url, "attachment_eid": eid})


class SpringerProvider(_CredentialedProvider):
    name = "springer"

    def __init__(
        self,
        transport: AcquisitionTransport,
        api_key: str | None,
        policy: UrlPolicy | None = None,
        *,
        profile: PublisherProfile | None = None,
    ) -> None:
        super().__init__(transport, api_key, policy, profile=profile)
        self._client = SpringerClient(
            transport, api_key=next(iter(self._headers.values()))
        )

    def initial_url(self, target: AcquisitionTarget) -> str:
        self._require_role(target)
        doi = _identifier(target, "doi")
        values = {
            "doi": quote(doi, safe=""),
            "query": urlencode({"q": "doi:" + doi}),
        }
        if target.role is AssetRole.XML:
            return self._endpoint(1, **values)
        return self._endpoint(0, **values)

    def acquire(self, target: AcquisitionTarget, *, timeout: float) -> ProviderContent:
        if target.role is AssetRole.XML:
            clean_url = self.initial_url(target)
            response = self._client.authenticated_get(
                clean_url,
                accept="application/jats+xml, application/xml;q=0.9, text/xml;q=0.8",
                timeout=timeout,
            )
            if response.status != 200:
                raise ProviderAcquisitionError.for_status(self.name, response.status)
            return self._profile_content(response, target)
        try:
            work, clean_url = self._client.lookup_doi(
                _identifier(target, "doi"),
                clean_url=self.initial_url(target),
                timeout=timeout,
            )
        except IntegrationError as error:
            if error.status is not None:
                raise ProviderAcquisitionError.for_status(self.name, error.status) from error
            raise ProviderAcquisitionError.invalid_response(self.name, str(error)) from error
        url = work.canonical_url
        if url is None or not url.startswith("https://"):
            raise ProviderAcquisitionError.invalid_response(self.name, "Springer supplied no HTML URL")
        return self._profile_content(self._get(url, timeout), target, provenance={"resolver_url": clean_url})


__all__ = ("ElsevierProvider", "OpenAlexProvider", "SemanticScholarProvider", "SpringerProvider", "WileyProvider")
