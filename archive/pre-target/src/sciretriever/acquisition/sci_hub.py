"""Explicitly configured Sci-Hub landing-page candidate resolution."""

from __future__ import annotations

import hashlib
from urllib.parse import parse_qsl, quote, urljoin, urlsplit

from bs4 import BeautifulSoup
from bs4.element import Tag

from sciretriever.acquisition.candidates import RuntimeDownloadCandidate, make_download_candidate_id
from sciretriever.acquisition.models import AcquisitionTarget, AcquisitionTransport
from sciretriever.acquisition.providers import ProviderAcquisitionError, _identifier
from sciretriever.config import SciHubConfig
from sciretriever.core.enums import AssetRole


_CHALLENGE_MARKERS = (
    "captcha", "verify you are human", "verify-human", "cf-chl-", "challenge-platform",
    "checking your browser", "just a moment...", "enable javascript and cookies",
    "login required", "sign in to continue",
)
_NOT_FOUND_MARKERS = (
    "404 not found", "article not found", "document not found", "paper not found", "doi not found",
)
_QUERY_PDF_VALUES = {
    ("format", "pdf"), ("type", "pdf"),
    ("mimetype", "pdf"), ("action", "download"),
}


class SciHubResolver:
    provider = resolver_id = "sci-hub"

    def __init__(self, transport: AcquisitionTransport, config: SciHubConfig) -> None:
        if not config.enabled or config.base_url is None:
            raise ValueError("Sci-Hub resolver requires enabled configuration")
        self._transport = transport
        self._base_url = config.base_url
        base_host = urlsplit(config.base_url).hostname
        assert base_host is not None
        self._allowed_hosts = frozenset((base_host, *config.allowed_pdf_hosts))

    def resolve(
        self,
        target: AcquisitionTarget,
        role: AssetRole,
        *,
        timeout: float,
    ) -> tuple[RuntimeDownloadCandidate, ...]:
        if role is not AssetRole.PRIMARY_PDF:
            raise ProviderAcquisitionError.invalid_response(
                self.provider, "Sci-Hub supports only primary PDF acquisition"
            )
        doi = _identifier(target, "doi")
        landing_url = self._base_url.rstrip("/") + "/" + quote(doi, safe="/")
        response = self._transport.get(landing_url, timeout=timeout)
        if not 200 <= response.status < 300:
            raise ProviderAcquisitionError.for_response(self.provider, response)

        media_type = response.headers.get("content-type", "").split(";", 1)[0].strip().lower()
        if media_type == "application/pdf":
            if not self._valid_url(response.url, require_pdf_evidence=False):
                raise ProviderAcquisitionError.invalid_response(
                    self.provider, "Sci-Hub direct PDF location rejected"
                )
            return (self._make_candidate(response.url, 0),)
        if media_type not in {"text/html", "application/xhtml+xml"}:
            raise ProviderAcquisitionError.invalid_response(
                self.provider, "Sci-Hub landing response was not HTML"
            )

        soup = BeautifulSoup(response.body, "html.parser")
        text = soup.get_text(" ", strip=True).casefold()
        serialized_markers = " ".join(
            str(value).casefold()
            for tag in soup.find_all(True)
            if isinstance(tag, Tag)
            for value in (tag.get("id"), tag.get("class"), tag.get("action"))
            if value is not None
        )
        if (
            any(marker in text or marker in serialized_markers for marker in _CHALLENGE_MARKERS)
            or "login" in serialized_markers
            or soup.find("input", attrs={"type": lambda value: isinstance(value, str) and value.casefold() == "password"})
        ):
            raise ProviderAcquisitionError.invalid_response(
                self.provider, "Sci-Hub challenge unsupported"
            )
        if any(marker in text for marker in _NOT_FOUND_MARKERS):
            raise ProviderAcquisitionError.invalid_response(
                self.provider, "Sci-Hub article not found"
            )

        raw_urls: list[str] = []
        for tag in soup.find_all("meta"):
            if not isinstance(tag, Tag):
                continue
            marker = tag.get("name") or tag.get("property")
            content = tag.get("content")
            if isinstance(marker, str) and marker.casefold() == "citation_pdf_url" and isinstance(content, str):
                raw_urls.append(content)
        for tag_name, attribute in (("iframe", "src"), ("embed", "src"), ("a", "href")):
            raw_urls.extend(
                value for tag in soup.find_all(tag_name)
                if isinstance(tag, Tag)
                if isinstance((value := tag.get(attribute)), str)
            )

        accepted: list[str] = []
        for raw_url in raw_urls:
            candidate_url = urljoin(response.url, raw_url.strip())
            if candidate_url not in accepted and self._valid_url(candidate_url, require_pdf_evidence=True):
                accepted.append(candidate_url)
            if len(accepted) == 8:
                break
        if not accepted:
            raise ProviderAcquisitionError.invalid_response(
                self.provider, "Sci-Hub supplied no acceptable PDF location"
            )
        return tuple(self._make_candidate(url, index) for index, url in enumerate(accepted))

    def _valid_url(self, url: str, *, require_pdf_evidence: bool) -> bool:
        try:
            parsed = urlsplit(url)
            port = parsed.port
        except ValueError:
            return False
        if (
            parsed.scheme != "https"
            or parsed.hostname not in self._allowed_hosts
            or parsed.username is not None
            or parsed.password is not None
            or parsed.fragment
            or port not in (None, 443)
        ):
            return False
        if not require_pdf_evidence:
            return True
        path = parsed.path.casefold()
        if path.endswith(".pdf") or "/pdf/" in path:
            return True
        query = ((name.casefold(), value.casefold()) for name, value in parse_qsl(parsed.query, keep_blank_values=True))
        return any(name == "download" or (name, value) in _QUERY_PDF_VALUES for name, value in query)

    def _make_candidate(self, url: str, priority: int) -> RuntimeDownloadCandidate:
        cursor = f"rc1:item-{priority}"
        identity = "host:scihub-" + hashlib.sha256(url.encode()).hexdigest()[:16]
        return RuntimeDownloadCandidate(
            make_download_candidate_id(
                self.provider, self.resolver_id, AssetRole.PRIMARY_PDF, cursor
            ),
            self.provider,
            self.resolver_id,
            self.provider,
            cursor,
            url,
            AssetRole.PRIMARY_PDF,
            priority,
            "https",
            "resolver",
            identity,
            {"provider": self.provider, "candidate_index": priority},
            media_type_hint="application/pdf",
        )


__all__ = ("SciHubResolver",)
