"""Credential lifecycle owned by one Literature Source page."""

from __future__ import annotations

import getpass
import sys
from dataclasses import dataclass

from sciretriever.configuration import (
    CredentialLookup,
    credential_field_specs,
    credential_section_exists,
    load_credentials,
    remove_credentials,
    set_credentials,
)
from sciretriever.entry.cli.config_center.common import confirm, option, select_value
from sciretriever.entry.cli.config_ui import ConfigActionKind, ConfigConsole
from sciretriever.model.configuration import ProviderName


@dataclass(frozen=True, slots=True)
class _CredentialGuide:
    display_name: str
    purpose: str
    credential_help: str
    application_url: str
    probe_available: bool = True


_GUIDES: dict[ProviderName, _CredentialGuide] = {
    ProviderName.WEB_OF_SCIENCE: _CredentialGuide(
        "Web of Science",
        "Metadata search and citation data",
        "Clarivate API key (X-ApiKey)",
        "https://developer.clarivate.com/",
    ),
    ProviderName.SEMANTIC_SCHOLAR: _CredentialGuide(
        "Semantic Scholar",
        "Metadata, citations, and open-PDF locators",
        "Optional Semantic Scholar API key (x-api-key)",
        "https://www.semanticscholar.org/product/api",
    ),
    ProviderName.OPENALEX: _CredentialGuide(
        "OpenAlex",
        "Metadata, citations, and open-content locators",
        "Optional OpenAlex API key for a larger usage budget",
        "https://developers.openalex.org/guides/authentication",
    ),
    ProviderName.ELSEVIER: _CredentialGuide(
        "Elsevier / Scopus",
        "Scopus metadata and authorized primary-PDF object retrieval",
        "Elsevier API key; institution token is optional",
        "https://dev.elsevier.com/",
    ),
    ProviderName.SPRINGER: _CredentialGuide(
        "Springer Nature",
        "Springer Nature metadata; authorized primary-PDF API unavailable",
        "Springer Nature API key",
        "https://dev.springernature.com/",
    ),
    ProviderName.CORE: _CredentialGuide(
        "CORE",
        "Metadata and authorized full-text PDF download",
        "CORE API key; required for the authorized PDF route",
        "https://core.ac.uk/services/api",
    ),
    ProviderName.OPENCITATIONS: _CredentialGuide(
        "OpenCitations",
        "Identifier lookup and citation relations",
        "Optional OpenCitations access token",
        "https://opencitations.net/accesstoken",
    ),
    ProviderName.WILEY: _CredentialGuide(
        "Wiley Online Library",
        "IP-authorized Wiley TDM PDF download",
        "Wiley-issued TDM token",
        "https://static.wiley.com/tdm/",
        probe_available=False,
    ),
}

_FIELD_LABELS: dict[tuple[ProviderName, str], str] = {
    (ProviderName.WEB_OF_SCIENCE, "api_key"): "Clarivate API key",
    (ProviderName.SEMANTIC_SCHOLAR, "api_key"): "Semantic Scholar API key",
    (ProviderName.OPENALEX, "api_key"): "OpenAlex API key",
    (ProviderName.ELSEVIER, "api_key"): "Elsevier API key",
    (ProviderName.ELSEVIER, "institution_token"): "Elsevier institution token",
    (ProviderName.SPRINGER, "api_key"): "Springer Nature API key",
    (ProviderName.CORE, "api_key"): "CORE API key",
    (ProviderName.OPENCITATIONS, "access_token"): "OpenCitations access token",
    (ProviderName.WILEY, "tdm_api_token"): "Wiley TDM API token",
}


def _guide(provider: ProviderName) -> _CredentialGuide:
    try:
        return _GUIDES[provider]
    except KeyError:
        raise ValueError("Source has no configurable credential") from None


def credential_state(
    provider: ProviderName,
    credentials: CredentialLookup | None = None,
) -> str:
    bundle = load_credentials(home=None) if credentials is None else credentials
    if not bundle.has_provider(provider):
        return "not configured"
    present = frozenset(bundle.field_names(provider))
    missing = tuple(
        field.name
        for field in credential_field_specs(provider)
        if field.required and field.name not in present
    )
    if missing:
        return "incomplete: missing " + ", ".join(missing)
    optional_missing = tuple(
        field.name
        for field in credential_field_specs(provider)
        if not field.required and field.name not in present
    )
    if optional_missing:
        return "configured; optional missing: " + ", ".join(optional_missing)
    return "configured"


def _format_fields(provider: ProviderName) -> str:
    return ", ".join(
        f"{field.name} ({'required' if field.required else 'optional'})"
        for field in credential_field_specs(provider)
    )


def _read_field(provider: ProviderName, *, name: str, required: bool) -> str | None:
    suffix = "required" if required else "optional; blank to omit"
    label = _FIELD_LABELS.get((provider, name), name)
    while True:
        try:
            value = getpass.getpass(f"{label} [{name}] ({suffix}): ").strip()
        except EOFError:
            return None
        if value or not required:
            return value
        sys.stderr.write("This credential is required; enter a value or press Ctrl+C to cancel.\n")


def _set(provider: ProviderName, console: ConfigConsole) -> None:
    specs = credential_field_specs(provider)
    if not specs:
        console.message("This Source has no configurable secret fields.", kind="muted")
        return
    guide = _guide(provider)
    existed = credential_section_exists(provider, home=None)
    console.page(
        f"Source · {provider.value} · Key",
        "The key belongs to this Source and is stored only in the owner-only credentials file.",
        facts=(
            ("Purpose", guide.purpose),
            ("Credential", guide.credential_help),
            ("Manage", guide.application_url),
            ("Fields", _format_fields(provider)),
        ),
        notes=("Input is hidden; cancelling before Save leaves the existing key unchanged.",),
    )
    if existed and not confirm(f"Replace credentials for {provider.value}? [y/N] "):
        return
    values: dict[str, str] = {}
    for spec in specs:
        value = _read_field(provider, name=spec.name, required=spec.required)
        if value is None:
            console.message("Credential input ended; nothing was changed.", kind="muted")
            return
        if value:
            values[spec.name] = value
    if not values:
        console.message("No credential value was entered; nothing was changed.", kind="muted")
        return
    set_credentials(provider.value, values, home=None)
    console.message(
        f"Credentials for {guide.display_name} were {'updated' if existed else 'saved'}.",
        kind="success",
    )


def _remove(provider: ProviderName, console: ConfigConsole) -> None:
    if not credential_section_exists(provider, home=None):
        console.message("No credential is saved for this Source.", kind="muted")
        return
    if not confirm(f"Remove credentials for {provider.value}? [y/N] "):
        return
    remove_credentials(provider, home=None)
    console.message("Source credentials were removed.", kind="success")


def manage_source_key(provider: ProviderName, console: ConfigConsole) -> None:
    while True:
        console.page(
            f"Source · {provider.value} · Key",
            "Credentials are configured in the context of the Source that consumes them. "
            "Saving a key never enables the Source.",
            facts=(("State", credential_state(provider)),),
        )
        action = select_value(
            "Key",
            [
                option("set", "Set"),
                option("remove", "Remove", kind=ConfigActionKind.DANGER),
                option("back", "Back", kind=ConfigActionKind.NAVIGATE),
            ],
            console=console,
            default="back",
        )
        if action in {None, "back"}:
            return
        if action == "set":
            _set(provider, console)
        elif action == "remove":
            _remove(provider, console)


__all__ = ("credential_state", "manage_source_key")
