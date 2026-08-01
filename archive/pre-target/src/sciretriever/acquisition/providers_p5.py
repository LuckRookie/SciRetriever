"""Credential-gated publisher candidate resolvers."""

from __future__ import annotations

from urllib.parse import quote, urlencode
import xml.etree.ElementTree as ET

from sciretriever.acquisition.models import AcquisitionTarget, AcquisitionTransport
from sciretriever.acquisition.profiles import profile_for_provider
from sciretriever.acquisition.providers import ProviderAcquisitionError, _candidate, _identifier
from sciretriever.core.enums import AssetRole
from sciretriever.errors import AcquisitionError
from sciretriever.integrations import ElsevierClient, IntegrationError, SpringerClient


class WileyResolver:
    provider = resolver_id = "wiley"

    def __init__(self, api_key: str | None) -> None:
        if api_key is None or not api_key.strip():
            raise AcquisitionError("wiley requires configured credentials")
        self._key = api_key.strip()

    def resolve(self, target: AcquisitionTarget, role: AssetRole, *, timeout: float):
        del timeout
        if role is not AssetRole.PRIMARY_PDF:
            raise AcquisitionError(f"wiley does not support {role.value}")
        profile = profile_for_provider(self.provider)
        assert profile is not None
        url = profile.endpoint_templates[0].format(doi=quote(_identifier(target, "doi"), safe=""))
        return (_candidate(self.provider, self.resolver_id, role, url, 0, headers={"Wiley-TDM-Client-Token": self._key}, media_type="application/pdf"),)


class ElsevierResolver:
    provider = resolver_id = "elsevier"

    def __init__(self, transport: AcquisitionTransport, api_key: str | None) -> None:
        if api_key is None or not api_key.strip():
            raise AcquisitionError("elsevier requires configured credentials")
        self._key = api_key.strip()
        self._client = ElsevierClient(transport, api_key=self._key)

    @staticmethod
    def _attachment_eids(data: bytes) -> tuple[str, ...]:
        try:
            root = ET.fromstring(data)
        except ET.ParseError as error:
            raise ProviderAcquisitionError.invalid_response("elsevier", "invalid Elsevier XML") from error
        result: list[str] = []
        for node in root.iter():
            name = str(node.tag).rsplit("}", 1)[-1].split(":", 1)[-1].lower()
            values = [" ".join(node.itertext()).strip(), *map(str, node.attrib.values())]
            if name not in {"attachment-eid", "object-eid", "eid", "identifier"}:
                continue
            for value in values:
                candidate = value.split(":", 1)[1].strip() if value.lower().startswith("eid:") else value.strip()
                if candidate.startswith("1-s2.0-") and ".pdf" not in candidate.lower():
                    candidate += "-main.pdf"
                if ".pdf" in candidate.lower() and candidate not in result:
                    result.append(candidate)
        return tuple(result[:8])

    def resolve(self, target: AcquisitionTarget, role: AssetRole, *, timeout: float):
        doi = _identifier(target, "doi")
        article_url = self._client.article_endpoint.format(doi=quote(doi, safe=""))
        headers = {"X-ELS-APIKey": self._key}
        if role is AssetRole.XML:
            return (_candidate(self.provider, self.resolver_id, role, article_url, 0, headers={**headers, "Accept": "application/xml"}, media_type="application/xml"),)
        if role is not AssetRole.PRIMARY_PDF:
            raise AcquisitionError(f"elsevier does not support {role.value}")
        response = self._client.retrieve_article(doi, accept="application/xml", timeout=timeout)
        if response.status != 200:
            raise ProviderAcquisitionError.for_response(self.provider, response)
        eids = self._attachment_eids(response.body)
        if not eids:
            raise ProviderAcquisitionError.invalid_response(self.provider, "Elsevier supplied no PDF attachment")
        return tuple(
            _candidate(
                self.provider, self.resolver_id, role,
                self._client.object_endpoint.format(eid=quote(eid, safe="")),
                index, headers={**headers, "Accept": "application/pdf"}, media_type="application/pdf",
            )
            for index, eid in enumerate(eids)
        )


class SpringerResolver:
    provider = resolver_id = "springer"

    def __init__(self, transport: AcquisitionTransport, api_key: str | None) -> None:
        if api_key is None or not api_key.strip():
            raise AcquisitionError("springer requires configured credentials")
        self._key = api_key.strip()
        self._client = SpringerClient(transport, api_key=self._key)

    def resolve(self, target: AcquisitionTarget, role: AssetRole, *, timeout: float):
        doi = _identifier(target, "doi")
        query = urlencode({"q": "doi:" + doi})
        if role is AssetRole.XML:
            url = f"https://api.springernature.com/xmldata/jats?{query}"
            return (_candidate(
                self.provider, self.resolver_id, role, url, 0,
                params={"api_key": self._key}, media_type="application/jats+xml",
            ),)
        if role is not AssetRole.HTML:
            raise AcquisitionError(f"springer does not support {role.value}")
        clean = f"https://api.springernature.com/meta/v2/json?{query}"
        try:
            work, _ = self._client.lookup_doi(doi, clean_url=clean, timeout=timeout)
        except IntegrationError as error:
            if error.status is not None:
                raise ProviderAcquisitionError.for_status(self.provider, error.status) from error
            raise ProviderAcquisitionError.invalid_response(self.provider, str(error)) from error
        if work.canonical_url is None or not work.canonical_url.startswith("https://"):
            raise ProviderAcquisitionError.invalid_response(self.provider, "Springer supplied no HTML URL")
        return (_candidate(self.provider, self.resolver_id, role, work.canonical_url, 0, media_type="text/html"),)


__all__ = ("ElsevierResolver", "SpringerResolver", "WileyResolver")
