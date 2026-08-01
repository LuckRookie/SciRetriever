"""Strict declarative publisher profiles; no executable selectors or secrets."""

from __future__ import annotations

from dataclasses import dataclass
import re
from urllib.parse import urlsplit

from sciretriever.acquisition.controls import HostBudget
from sciretriever.acquisition.models import validate_provider_name
from sciretriever.core.enums import AssetRole


_HOST = re.compile(r"^[a-z0-9.-]+$")


@dataclass(frozen=True, slots=True)
class PublisherProfile:
    name: str
    provider: str
    hosts: tuple[str, ...]
    doi_prefixes: tuple[str, ...]
    supported_roles: tuple[AssetRole, ...]
    endpoint_templates: tuple[str, ...]
    media_types: tuple[str, ...]
    budget: HostBudget
    credential_env: str | None = None
    browser_required: bool = False

    def __post_init__(self) -> None:
        object.__setattr__(self, "provider", validate_provider_name(self.provider))
        if not self.name or not self.name.isascii():
            raise ValueError("profile name must be nonblank ASCII")
        if not self.hosts or any(not _HOST.fullmatch(host) for host in self.hosts):
            raise ValueError("profile hosts must be neutral DNS names")
        if not self.supported_roles or len(set(self.supported_roles)) != len(self.supported_roles):
            raise ValueError("profile roles must be nonempty and unique")
        if not self.endpoint_templates or any("{" not in template or not template.startswith("https://") for template in self.endpoint_templates):
            raise ValueError("endpoint templates must be declarative HTTPS templates")
        if any(urlsplit(template).hostname not in self.hosts for template in self.endpoint_templates):
            raise ValueError("endpoint template hosts must be declared by the profile")
        if not self.media_types or any(
            not isinstance(media_type, str)
            or not media_type
            or media_type != media_type.strip().lower()
            or "/" not in media_type
            for media_type in self.media_types
        ):
            raise ValueError("profile media types must be normalized nonempty values")
        if self.credential_env is not None:
            if not self.credential_env.startswith("SCIRETRIEVER_") or not self.credential_env.endswith("_API_KEY"):
                raise ValueError("credential_env must name a SciRetriever environment variable")
        if not isinstance(self.browser_required, bool):
            raise TypeError("browser_required must be boolean")

    def matches(self, *, host: str | None = None, doi: str | None = None) -> bool:
        host_match = host is not None and any(host == item or host.endswith("." + item) for item in self.hosts)
        doi_match = doi is not None and any(doi.lower().startswith(prefix) for prefix in self.doi_prefixes)
        return host_match or doi_match


PUBLISHER_PROFILES = (
    PublisherProfile(
        name="Elsevier APIs",
        provider="elsevier",
        hosts=("api.elsevier.com",),
        doi_prefixes=("10.1016/",),
        supported_roles=(AssetRole.PRIMARY_PDF, AssetRole.SUPPLEMENTARY_PDF, AssetRole.XML),
        endpoint_templates=(
            "https://api.elsevier.com/content/article/doi/{doi}?view=FULL",
            "https://api.elsevier.com/content/object/eid/{eid}",
        ),
        media_types=("application/pdf", "application/xml", "text/xml"),
        budget=HostBudget(concurrency=2, min_interval=0.25),
        credential_env="SCIRETRIEVER_ELSEVIER_API_KEY",
    ),
    PublisherProfile(
        name="Wiley TDM",
        provider="wiley",
        hosts=("api.wiley.com",),
        doi_prefixes=("10.1002/", "10.1111/"),
        supported_roles=(AssetRole.PRIMARY_PDF,),
        endpoint_templates=("https://api.wiley.com/onlinelibrary/tdm/v1/articles/{doi}",),
        media_types=("application/pdf",),
        budget=HostBudget(concurrency=1, min_interval=1.0),
        credential_env="SCIRETRIEVER_WILEY_API_KEY",
    ),
    PublisherProfile(
        name="Springer Nature APIs",
        provider="springer",
        hosts=("api.springernature.com",),
        doi_prefixes=("10.1007/",),
        supported_roles=(AssetRole.XML, AssetRole.HTML),
        endpoint_templates=(
            "https://api.springernature.com/meta/v2/json?{query}",
            "https://api.springernature.com/xmldata/jats?{query}",
        ),
        media_types=("application/xml", "application/jats+xml", "text/xml", "text/html"),
        budget=HostBudget(concurrency=1, min_interval=1.0),
        credential_env="SCIRETRIEVER_SPRINGER_API_KEY",
    ),
)


def profile_for_provider(provider: str) -> PublisherProfile | None:
    return next((profile for profile in PUBLISHER_PROFILES if profile.provider == provider), None)


__all__ = ("PUBLISHER_PROFILES", "PublisherProfile", "profile_for_provider")
