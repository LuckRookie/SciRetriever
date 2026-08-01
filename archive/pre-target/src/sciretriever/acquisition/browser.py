"""Restricted persistent-profile browser fallback for authenticated PDF retrieval."""

from __future__ import annotations

import hashlib
import ipaddress
import os
from pathlib import Path
import shutil
import socket
import stat
import sys
from tempfile import TemporaryDirectory
import time
from typing import Any, Callable, Protocol, cast
from urllib.parse import parse_qsl, quote, urljoin, urlsplit

from bs4 import BeautifulSoup
from bs4.element import Tag

from sciretriever.acquisition.candidates import RuntimeDownloadCandidate, make_download_candidate_id
from sciretriever.acquisition.identity_validation import (
    ContentIdentityValidator, IdentityDisposition, IdentityValidator,
)
from sciretriever.acquisition.models import AcquisitionTarget, ProviderContent
from sciretriever.acquisition.providers import ProviderAcquisitionError, _identifier
from sciretriever.acquisition.validation import validate_primary_pdf
from sciretriever.config import BrowserConfig, BrowserRuleConfig
from sciretriever.core.enums import AssetRole
from sciretriever.errors import ConfigError, ValidationError

_CHALLENGE_MARKERS = (
    "captcha", "verify you are human", "checking your browser", "just a moment",
    "enable javascript", "login required", "sign in", "log in", "password required",
    "access denied", "security check", "challenge-platform",
)
_REJECTED_MARKERS = ("supplement", "supporting", "preview", "cover", "thumbnail", "graphical-abstract")
_QUERY_PDF_VALUES = {("format", "pdf"), ("type", "pdf"), ("mimetype", "pdf"), ("action", "download"), ("download", "pdf"), ("download", "1")}
_OPEN_SUPPORTS_DIR_FD = os.open in os.supports_dir_fd
_MAX_OBSERVED_PDF_RESPONSES = 8
_MAX_RENDERED_HTML_CHARACTERS = 2_000_000


class PlaywrightFactory(Protocol):
    def __call__(self) -> Any: ...


def validate_browser_profile(config: BrowserConfig, storage_root: Path) -> None:
    """Validate the configured source profile without disclosing its location."""
    if not config.enabled:
        return
    profile = config.profile_dir
    try:
        if profile is None:
            raise OSError
        metadata = profile.lstat()
        storage = storage_root.resolve(strict=True)
        canonical = profile.resolve(strict=True)
        if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(metadata.st_mode):
            raise OSError
        if os.name == "posix" and (
            metadata.st_uid != os.getuid()
            or metadata.st_mode & 0o077
            or metadata.st_mode & 0o700 != 0o700
        ):
            raise OSError
        if canonical == storage or storage in canonical.parents or canonical in storage.parents:
            raise OSError
    except OSError as error:
        raise ConfigError("browser profile is invalid") from error


def _copy_profile(
    source: Path,
    destination: Path,
    max_files: int,
    max_bytes: int,
    check_deadline: Callable[[], object] = lambda: None,
) -> None:
    if (
        os.name != "posix"
        or not getattr(os, "O_DIRECTORY", 0)
        or not getattr(os, "O_NOFOLLOW", 0)
        or not _OPEN_SUPPORTS_DIR_FD
    ):
        raise ConfigError("browser profile snapshot is unsupported")
    files = 0
    total = 0
    destination.mkdir(mode=0o700)
    os.chmod(destination, 0o700)

    def copy_dir(source_fd: int, dst: Path) -> None:
        nonlocal files, total
        check_deadline()
        with os.scandir(source_fd) as entries:
            for entry in entries:
                check_deadline()
                metadata = entry.stat(follow_symlinks=False)
                target = dst / entry.name
                if entry.is_symlink():
                    raise ConfigError("browser profile contains an unsupported entry")
                if stat.S_ISDIR(metadata.st_mode):
                    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | getattr(os, "O_CLOEXEC", 0)
                    try:
                        child_fd = os.open(entry.name, flags, dir_fd=source_fd)
                    except OSError as error:
                        raise ConfigError("browser profile changed during snapshot") from error
                    try:
                        current = os.fstat(child_fd)
                        if not stat.S_ISDIR(current.st_mode) or (current.st_dev, current.st_ino) != (metadata.st_dev, metadata.st_ino):
                            raise ConfigError("browser profile changed during snapshot")
                        target.mkdir(mode=0o700)
                        os.chmod(target, 0o700)
                        copy_dir(child_fd, target)
                    finally:
                        os.close(child_fd)
                    continue
                if not stat.S_ISREG(metadata.st_mode):
                    raise ConfigError("browser profile contains an unsupported entry")
                files += 1
                total += metadata.st_size
                if files > max_files or total > max_bytes:
                    raise ConfigError("browser profile exceeds configured limits")
                flags = os.O_RDONLY | os.O_NOFOLLOW | getattr(os, "O_CLOEXEC", 0)
                try:
                    descriptor = os.open(entry.name, flags, dir_fd=source_fd)
                except OSError as error:
                    raise ConfigError("browser profile changed during snapshot") from error
                try:
                    current = os.fstat(descriptor)
                    if not stat.S_ISREG(current.st_mode) or (current.st_dev, current.st_ino) != (metadata.st_dev, metadata.st_ino):
                        raise ConfigError("browser profile changed during snapshot")
                    with os.fdopen(descriptor, "rb", closefd=True) as input_stream, open(target, "xb") as output_stream:
                        descriptor = -1
                        copied = 0
                        while chunk := input_stream.read(1024 * 1024):
                            check_deadline()
                            copied += len(chunk)
                            if total - metadata.st_size + copied > max_bytes:
                                raise ConfigError("browser profile exceeds configured limits")
                            output_stream.write(chunk)
                    os.chmod(target, stat.S_IMODE(metadata.st_mode) & 0o700 or 0o600)
                finally:
                    if descriptor >= 0:
                        os.close(descriptor)
    check_deadline()
    source_metadata = source.lstat()
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | getattr(os, "O_CLOEXEC", 0)
    try:
        source_fd = os.open(source, flags)
    except OSError as error:
        raise ConfigError("browser profile changed during snapshot") from error
    try:
        current = os.fstat(source_fd)
        if not stat.S_ISDIR(current.st_mode) or (current.st_dev, current.st_ino) != (source_metadata.st_dev, source_metadata.st_ino):
            raise ConfigError("browser profile changed during snapshot")
        copy_dir(source_fd, destination)
    finally:
        os.close(source_fd)


class BrowserRuleResolver:
    def __init__(self, rule: BrowserRuleConfig) -> None:
        self.provider = f"browser-{rule.name}"
        self.resolver_id = self.provider
        self._rule = rule

    def resolve(self, target: AcquisitionTarget, role: AssetRole, *, timeout: float) -> tuple[RuntimeDownloadCandidate, ...]:
        if role is not AssetRole.PRIMARY_PDF:
            return ()
        doi = _identifier(target, "doi")
        placeholder = "{doi_path}" if "{doi_path}" in self._rule.landing_url_template else "{doi}"
        url = self._rule.landing_url_template.replace(placeholder, quote(doi, safe="/" if placeholder == "{doi_path}" else ""))
        cursor = "rc1:landing"
        identity = "host:browser-" + hashlib.sha256(self.provider.encode()).hexdigest()[:16]
        return (RuntimeDownloadCandidate(
            make_download_candidate_id(self.provider, self.resolver_id, role, cursor),
            self.provider, self.resolver_id, self.provider, cursor, url, role, 0,
            "browser", "browser", identity, {"provider": self.provider},
            page_url=url, auth_context_ref=self._rule.name, media_type_hint="application/pdf",
        ),)


class PlaywrightBrowserRunner:
    def __init__(
        self, config: BrowserConfig, *, max_asset_bytes: int,
        playwright_factory: PlaywrightFactory | None = None,
        resolve_host: Callable[[str], tuple[str, ...]] | None = None,
        monotonic: Callable[[], float] = time.monotonic,
        identity_validator: IdentityValidator | None = None,
    ) -> None:
        self._config = config
        self._rules = {f"browser-{rule.name}": rule for rule in config.rules}
        self._max_asset_bytes = max_asset_bytes
        self._factory = playwright_factory
        self._resolve_host = resolve_host or self._system_resolve
        self._clock = monotonic
        self._identity_validator = identity_validator or ContentIdentityValidator()

    @staticmethod
    def _system_resolve(host: str) -> tuple[str, ...]:
        return tuple(sorted({str(item[4][0]) for item in socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)}))

    @staticmethod
    def _safe_url(url: str, hosts: frozenset[str]) -> bool:
        try:
            parsed = urlsplit(url)
            port = parsed.port
        except ValueError:
            return False
        return parsed.scheme == "https" and parsed.hostname in hosts and parsed.username is None and parsed.password is None and not parsed.fragment and port in (None, 443)

    @staticmethod
    def _timeout_error() -> TimeoutError:
        return TimeoutError("browser execution timed out")

    def _remaining_ms(self, deadline: float) -> int:
        remaining = deadline - self._clock()
        if remaining <= 0:
            raise self._timeout_error()
        return max(1, min(int(remaining * 1000), 120_000))

    def _check_dns(self, hosts: frozenset[str], deadline: float) -> None:
        for host in hosts:
            self._remaining_ms(deadline)
            try:
                addresses = self._resolve_host(host)
                if not addresses or any(not ipaddress.ip_address(value).is_global for value in addresses):
                    raise ValueError
            except (OSError, ValueError) as error:
                raise ProviderAcquisitionError.invalid_response("browser", "browser network boundary rejected") from error
            self._remaining_ms(deadline)

    def _body_allowed(self, response) -> bool:
        declared = response.headers.get("content-length")
        if declared is None:
            return True
        if (
            not isinstance(declared, str)
            or len(declared) > 20
            or not declared.isascii()
            or not declared.isdigit()
        ):
            return False
        return int(declared) <= self._max_asset_bytes

    def run(
        self,
        candidate: RuntimeDownloadCandidate,
        timeout: float,
        target: AcquisitionTarget | None = None,
    ) -> ProviderContent:
        deadline = self._clock() + timeout
        rule = self._rules.get(candidate.provider)
        if rule is None or candidate.auth_context_ref != rule.name:
            raise ProviderAcquisitionError.invalid_response(candidate.provider, "browser rule is unavailable")
        if self._config.profile_dir is None:
            raise ProviderAcquisitionError.invalid_response(candidate.provider, "browser profile is unavailable")
        network_hosts = frozenset(rule.allowed_network_hosts)
        landing_hosts = frozenset(rule.allowed_landing_hosts)
        pdf_hosts = frozenset(rule.allowed_pdf_hosts)
        self._check_dns(network_hosts, deadline)
        factory = self._factory
        if factory is None:
            try:
                from playwright.sync_api import sync_playwright
            except ImportError as error:
                raise ProviderAcquisitionError.invalid_response(candidate.provider, "browser runtime is unavailable") from error
            factory = cast(PlaywrightFactory, sync_playwright)
        assert factory is not None
        self._remaining_ms(deadline)
        with TemporaryDirectory(prefix="sciretriever-browser-") as temporary:
            base = Path(temporary)
            os.chmod(base, 0o700)
            profile = base / "profile"
            downloads = base / "downloads"
            _copy_profile(
                self._config.profile_dir, profile,
                self._config.max_profile_files, self._config.max_profile_bytes,
                lambda: self._remaining_ms(deadline),
            )
            downloads.mkdir(mode=0o700)
            context = None
            try:
                self._remaining_ms(deadline)
                with factory() as playwright:
                    launch_timeout = self._remaining_ms(deadline)
                    context = playwright.chromium.launch_persistent_context(
                        user_data_dir=str(profile), headless=True, accept_downloads=True,
                        downloads_path=str(downloads), timeout=launch_timeout,
                    )
                    operation_timeout = self._remaining_ms(deadline)
                    context.set_default_timeout(operation_timeout)
                    context.set_default_navigation_timeout(operation_timeout)
                    def route_request(route) -> None:
                        if self._safe_url(route.request.url, network_hosts):
                            route.continue_()
                        else:
                            route.abort()
                    context.route("**/*", route_request)
                    observed: dict[str, bytes] = {}
                    observed_urls: set[str] = set()
                    def observe(response) -> None:
                        media = response.headers.get("content-type", "").split(";", 1)[0].strip().lower()
                        if (
                            media != "application/pdf"
                            or not self._safe_url(response.url, pdf_hosts)
                            or response.url in observed_urls
                            or len(observed_urls) >= _MAX_OBSERVED_PDF_RESPONSES
                        ):
                            return
                        observed_urls.add(response.url)
                        if not self._body_allowed(response):
                            return
                        try:
                            self._remaining_ms(deadline)
                            body = response.body()
                            self._remaining_ms(deadline)
                        except Exception:
                            return
                        if len(body) <= self._max_asset_bytes:
                            observed[response.url] = body
                    context.on("response", observe)
                    page = context.pages[0] if context.pages else context.new_page()
                    landing = page.goto(
                        candidate.execution_url, wait_until="domcontentloaded",
                        timeout=self._remaining_ms(deadline),
                    )
                    self._remaining_ms(deadline)
                    landing_media = "" if landing is None else landing.headers.get("content-type", "").split(";", 1)[0].strip().lower()
                    valid_final = self._safe_url(page.url, landing_hosts) or (
                        landing_media == "application/pdf" and self._safe_url(page.url, pdf_hosts)
                    )
                    if landing is None or not valid_final:
                        raise ProviderAcquisitionError.invalid_response(candidate.provider, "browser landing was rejected")
                    html = ""
                    if landing_media == "application/pdf":
                        bodies = (() if landing is None else (observed.get(landing.url, b""),))
                    else:
                        title, html = self._read_page_state(page, deadline)
                        self._reject_challenge(page.url, title, html, deadline)
                        bodies = tuple(observed.values())
                    for body in bodies:
                        content = self._content(candidate, body)
                        if self._selectable(content, target, deadline):
                            return content
                    if landing_media == "application/pdf":
                        raise ProviderAcquisitionError.invalid_response(candidate.provider, "browser supplied no valid PDF")
                    static_candidates = self._static_candidates(html, page.url, pdf_hosts)
                    self._remaining_ms(deadline)
                    for url in static_candidates:
                        response = page.goto(
                            url, wait_until="domcontentloaded",
                            timeout=self._remaining_ms(deadline),
                        )
                        self._remaining_ms(deadline)
                        response_media = "" if response is None else response.headers.get("content-type", "").split(";", 1)[0].strip().lower()
                        if response_media != "application/pdf":
                            title, candidate_html = self._read_page_state(page, deadline)
                            self._reject_challenge(page.url, title, candidate_html, deadline)
                            continue
                        body = b""
                        if response is not None and self._safe_url(response.url, pdf_hosts):
                            body = observed.get(response.url, b"")
                            if not body and response.url not in observed_urls and self._body_allowed(response):
                                self._remaining_ms(deadline)
                                candidate_body = response.body()
                                self._remaining_ms(deadline)
                                if len(candidate_body) <= self._max_asset_bytes:
                                    body = candidate_body
                        if body:
                            content = self._content(candidate, body)
                            if self._selectable(content, target, deadline):
                                return content
                    raise ProviderAcquisitionError.invalid_response(candidate.provider, "browser supplied no valid PDF")
            except ProviderAcquisitionError:
                raise
            except TimeoutError:
                raise
            except Exception as error:
                raise ProviderAcquisitionError.invalid_response(candidate.provider, "browser execution failed") from error
            finally:
                if context is not None:
                    active_error = sys.exc_info()[0] is not None
                    try:
                        context.close()
                    except Exception:
                        if not active_error:
                            raise ProviderAcquisitionError.invalid_response(
                                candidate.provider, "browser cleanup failed"
                            ) from None

    @staticmethod
    def _content(candidate: RuntimeDownloadCandidate, data: bytes) -> ProviderContent:
        return ProviderContent(AssetRole.PRIMARY_PDF, "application/pdf", "pdf", "candidate://browser", candidate.provider, data, {"provider": candidate.provider})

    def _selectable(
        self,
        content: ProviderContent,
        target: AcquisitionTarget | None,
        deadline: float,
    ) -> bool:
        self._remaining_ms(deadline)
        try:
            validate_primary_pdf(content)
        except ValidationError:
            return False
        self._remaining_ms(deadline)
        if target is None:
            return True
        try:
            identity = self._identity_validator.validate(content, target)
        except TimeoutError:
            raise
        except Exception:
            return False
        self._remaining_ms(deadline)
        return identity.disposition is IdentityDisposition.PASS

    def _read_page_state(self, page, deadline: float) -> tuple[str, str]:
        self._remaining_ms(deadline)
        title = page.title()
        self._remaining_ms(deadline)
        html = page.content()
        self._remaining_ms(deadline)
        if len(html) > _MAX_RENDERED_HTML_CHARACTERS:
            raise ProviderAcquisitionError.invalid_response("browser", "browser rendered content is too large")
        return title, html

    def _reject_challenge(self, page_url: str, title: str, html: str, deadline: float) -> None:
        text = " ".join((page_url, title, html)).casefold()
        soup = BeautifulSoup(html, "html.parser")
        self._remaining_ms(deadline)
        password = soup.find("input", attrs={"type": lambda value: isinstance(value, str) and value.casefold() == "password"})
        if password is not None or any(marker in text for marker in _CHALLENGE_MARKERS):
            raise ProviderAcquisitionError.invalid_response("browser", "browser authentication challenge unsupported")

    @classmethod
    def _static_candidates(cls, html: str, base_url: str, hosts: frozenset[str]) -> tuple[str, ...]:
        soup = BeautifulSoup(html, "html.parser")
        raw: list[str] = []
        for tag in soup.find_all("meta"):
            if isinstance(tag, Tag) and str(tag.get("name") or tag.get("property")).casefold() == "citation_pdf_url" and isinstance(tag.get("content"), str):
                raw.append(str(tag.get("content")))
        for name, attribute in (("link", "href"), ("iframe", "src"), ("embed", "src"), ("object", "data"), ("a", "href")):
            raw.extend(str(value) for tag in soup.find_all(name) if isinstance(tag, Tag) and isinstance((value := tag.get(attribute)), str))
        accepted: list[str] = []
        for value in raw:
            url = urljoin(base_url, value.strip())
            parsed = urlsplit(url)
            evidence = parsed.path.casefold().endswith(".pdf") or "/pdf/" in parsed.path.casefold() or any(
                (name.casefold(), item.casefold()) in _QUERY_PDF_VALUES for name, item in parse_qsl(parsed.query, keep_blank_values=True)
            )
            if evidence and cls._safe_url(url, hosts) and not any(marker in url.casefold() for marker in _REJECTED_MARKERS) and url not in accepted:
                accepted.append(url)
            if len(accepted) == 8:
                break
        return tuple(accepted)


def build_browser_resolvers(rules: tuple[BrowserRuleConfig, ...]) -> tuple[BrowserRuleResolver, ...]:
    return tuple(BrowserRuleResolver(rule) for rule in rules)


__all__ = ("BrowserRuleResolver", "PlaywrightBrowserRunner", "build_browser_resolvers", "validate_browser_profile")
