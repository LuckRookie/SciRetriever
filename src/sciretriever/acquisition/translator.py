"""Opt-in deterministic restricted landing-page candidate resolution."""

from __future__ import annotations

import hashlib
from urllib.parse import parse_qsl, quote, urljoin, urlsplit

from bs4 import BeautifulSoup
from bs4.element import Tag

from sciretriever.acquisition.candidates import RuntimeDownloadCandidate, make_download_candidate_id
from sciretriever.acquisition.models import AcquisitionTarget, AcquisitionTransport
from sciretriever.acquisition.providers import ProviderAcquisitionError, _identifier
from sciretriever.config import TranslatorRuleConfig
from sciretriever.core.enums import AssetRole


_CHALLENGE_MARKERS = (
    "captcha", "verify you are human", "checking your browser", "just a moment",
    "enable javascript", "login required", "sign in to continue", "password required",
)
_NOT_FOUND_MARKERS = (
    "404 not found", "article not found", "document not found", "paper not found", "doi not found",
)
_REJECTED_MARKERS = (
    "supplement", "supporting", "preview", "cover", "thumbnail", "graphical-abstract",
)
_QUERY_PDF_VALUES = {
    ("format", "pdf"), ("type", "pdf"), ("mimetype", "pdf"),
    ("action", "download"), ("download", "pdf"), ("download", "1"),
}


class TranslatorRuleResolver:
    def __init__(self, transport: AcquisitionTransport, rule: TranslatorRuleConfig) -> None:
        self.provider = f"translator-{rule.name}"
        self.resolver_id = self.provider
        self._transport = transport
        self._rule = rule
        template_host = urlsplit(rule.landing_url_template).hostname
        assert template_host is not None
        self._landing_hosts = frozenset((template_host, *rule.allowed_landing_hosts))
        self._pdf_hosts = frozenset(rule.allowed_pdf_hosts or tuple(self._landing_hosts))

    def resolve(
        self, target: AcquisitionTarget, role: AssetRole, *, timeout: float,
    ) -> tuple[RuntimeDownloadCandidate, ...]:
        if role is not AssetRole.PRIMARY_PDF:
            raise ProviderAcquisitionError.invalid_response(
                self.provider, "translator supports only primary PDF acquisition"
            )
        doi = _identifier(target, "doi")
        placeholder = "{doi_path}" if "{doi_path}" in self._rule.landing_url_template else "{doi}"
        encoded = quote(doi, safe="/" if placeholder == "{doi_path}" else "")
        landing_url = self._rule.landing_url_template.replace(placeholder, encoded)
        response = self._transport.get(landing_url, timeout=timeout)
        if not 200 <= response.status < 300:
            raise ProviderAcquisitionError.for_response(self.provider, response)
        if not self._valid_landing(response.url):
            raise ProviderAcquisitionError.invalid_response(
                self.provider, "translator landing location rejected"
            )
        media_type = response.headers.get("content-type", "").split(";", 1)[0].strip().lower()
        if media_type not in {"text/html", "application/xhtml+xml"}:
            raise ProviderAcquisitionError.invalid_response(
                self.provider, "translator landing response was not HTML"
            )
        soup = BeautifulSoup(response.body, "html.parser")
        text = soup.get_text(" ", strip=True).casefold()
        structural = " ".join(
            str(value).casefold() for tag in soup.find_all(True) if isinstance(tag, Tag)
            for value in (tag.get("id"), tag.get("class"), tag.get("action")) if value is not None
        )
        if (
            any(marker in text or marker in structural for marker in _CHALLENGE_MARKERS)
            or "login" in structural
            or soup.find("input", attrs={"type": lambda value: isinstance(value, str) and value.casefold() == "password"})
        ):
            raise ProviderAcquisitionError.invalid_response(
                self.provider, "translator challenge unsupported"
            )
        if any(marker in text for marker in _NOT_FOUND_MARKERS):
            raise ProviderAcquisitionError.invalid_response(
                self.provider, "translator article not found"
            )

        raw_urls: list[str] = []
        raw_urls.extend(self._meta_urls(soup))
        raw_urls.extend(self._link_urls(soup))
        for tag_name, attribute in (("iframe", "src"), ("embed", "src"), ("object", "data")):
            raw_urls.extend(self._tag_urls(soup, tag_name, attribute))
        raw_urls.extend(self._tag_urls(soup, "a", "href"))
        accepted: list[str] = []
        for raw_url in raw_urls:
            candidate_url = urljoin(response.url, raw_url.strip())
            if candidate_url not in accepted and self._valid_pdf(candidate_url):
                accepted.append(candidate_url)
            if len(accepted) == 8:
                break
        if not accepted:
            raise ProviderAcquisitionError.invalid_response(
                self.provider, "translator supplied no acceptable PDF location"
            )
        return tuple(self._candidate(url, response.url, index) for index, url in enumerate(accepted))

    @staticmethod
    def _tag_urls(soup: BeautifulSoup, tag_name: str, attribute: str) -> list[str]:
        return [
            value for tag in soup.find_all(tag_name) if isinstance(tag, Tag)
            if isinstance((value := tag.get(attribute)), str)
        ]

    @staticmethod
    def _meta_urls(soup: BeautifulSoup) -> list[str]:
        result: list[str] = []
        for tag in soup.find_all("meta"):
            if not isinstance(tag, Tag):
                continue
            marker = tag.get("name") or tag.get("property")
            value = tag.get("content")
            if isinstance(marker, str) and marker.casefold() == "citation_pdf_url" and isinstance(value, str):
                result.append(value)
        return result

    @staticmethod
    def _link_urls(soup: BeautifulSoup) -> list[str]:
        result: list[str] = []
        for tag in soup.find_all("link"):
            if not isinstance(tag, Tag):
                continue
            href = tag.get("href")
            rel = tag.get("rel")
            media_type = tag.get("type")
            rel_values = {str(value).casefold() for value in (rel if isinstance(rel, list) else [rel]) if value}
            if isinstance(href, str) and (
                isinstance(media_type, str) and media_type.casefold().split(";", 1)[0] == "application/pdf"
                or bool(rel_values & {"alternate", "enclosure", "download"}) and TranslatorRuleResolver._has_pdf_evidence(href)
            ):
                result.append(href)
        return result

    def _valid_landing(self, url: str) -> bool:
        return self._safe_url(url, self._landing_hosts)

    def _valid_pdf(self, url: str) -> bool:
        if not self._safe_url(url, self._pdf_hosts):
            return False
        lowered = url.casefold()
        return not any(marker in lowered for marker in _REJECTED_MARKERS) and self._has_pdf_evidence(url)

    @staticmethod
    def _safe_url(url: str, hosts: frozenset[str]) -> bool:
        try:
            parsed = urlsplit(url)
            port = parsed.port
        except ValueError:
            return False
        return (
            parsed.scheme == "https" and parsed.hostname in hosts
            and parsed.username is None and parsed.password is None
            and not parsed.fragment and port in (None, 443)
        )

    @staticmethod
    def _has_pdf_evidence(url: str) -> bool:
        parsed = urlsplit(url)
        path = parsed.path.casefold()
        if path.endswith(".pdf") or "/pdf/" in path:
            return True
        query = ((name.casefold(), value.casefold()) for name, value in parse_qsl(parsed.query, keep_blank_values=True))
        return any((name, value) in _QUERY_PDF_VALUES for name, value in query)

    def _candidate(self, url: str, page_url: str, priority: int) -> RuntimeDownloadCandidate:
        cursor = f"rc1:item-{priority}"
        identity = "host:translator-" + hashlib.sha256(url.encode()).hexdigest()[:16]
        return RuntimeDownloadCandidate(
            make_download_candidate_id(self.provider, self.resolver_id, AssetRole.PRIMARY_PDF, cursor),
            self.provider, self.resolver_id, self.provider, cursor, url,
            AssetRole.PRIMARY_PDF, priority, "https", "translator", identity,
            {"provider": self.provider, "candidate_index": priority},
            page_url=page_url, referrer=page_url, media_type_hint="application/pdf",
        )


def build_translator_resolvers(
    transport: AcquisitionTransport, rules: tuple[TranslatorRuleConfig, ...],
) -> tuple[TranslatorRuleResolver, ...]:
    return tuple(TranslatorRuleResolver(transport, rule) for rule in rules)


__all__ = ("TranslatorRuleResolver", "build_translator_resolvers")
