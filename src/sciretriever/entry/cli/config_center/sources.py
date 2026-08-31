"""Search and Download Literature Source configuration pages."""

from __future__ import annotations

from typing import Literal

from pydantic import ValidationError

from sciretriever.acquisition.api import BUILTIN_SCI_HUB_MIRROR_URLS
from sciretriever.bootstrap import build_production_configuration_probe_session
from sciretriever.configuration import (
    acquisition_source_providers,
    configurable_credential_providers,
    load_editable_user_configuration,
    load_user_configuration,
    metadata_source_providers,
    update_configuration_sections,
)
from sciretriever.entry.cli.config_center.common import (
    ask_text,
    confirm,
    confirm_changes,
    option,
    select_value,
)
from sciretriever.entry.cli.config_center.source_credentials import (
    credential_state,
    manage_source_key,
)
from sciretriever.entry.cli.config_ui import (
    ConfigActionKind,
    ConfigConsole,
    ConfigOption,
    ConfigStatusPresenter,
)
from sciretriever.model.configuration import (
    AcquisitionSourcesConfig,
    Configuration,
    CrossrefAccessMode,
    CrossrefMetadataConfig,
    MetadataSourcesConfig,
    ProviderName,
    SciHubAcquisitionConfig,
    SourceMode,
    SourcesConfig,
    UnpaywallAcquisitionConfig,
    WebOfScienceMetadataConfig,
    WebOfScienceProduct,
)

_METADATA_SOURCES = (
    ProviderName.WEB_OF_SCIENCE,
    ProviderName.CROSSREF,
    ProviderName.SEMANTIC_SCHOLAR,
    ProviderName.ARXIV,
    ProviderName.OPENALEX,
    ProviderName.EUROPE_PMC,
    ProviderName.ELSEVIER,
    ProviderName.SPRINGER,
    ProviderName.DATACITE,
    ProviderName.CORE,
    ProviderName.OPENCITATIONS,
)
_ACQUISITION_SOURCES = (
    ProviderName.ARXIV,
    ProviderName.CROSSREF,
    ProviderName.SEMANTIC_SCHOLAR,
    ProviderName.OPENALEX,
    ProviderName.EUROPE_PMC,
    ProviderName.UNPAYWALL,
    ProviderName.ELSEVIER,
    ProviderName.SPRINGER,
    ProviderName.WILEY,
    ProviderName.DATACITE,
    ProviderName.CORE,
    ProviderName.SCI_HUB,
)

_SOURCE_PURPOSES: dict[ProviderName, str] = {
    ProviderName.WEB_OF_SCIENCE: "Clarivate metadata search and citation records.",
    ProviderName.CROSSREF: "DOI metadata discovery through the public or polite pool.",
    ProviderName.SEMANTIC_SCHOLAR: "Paper metadata, citations and open-PDF locators.",
    ProviderName.ARXIV: "Public preprint metadata and primary PDF files.",
    ProviderName.OPENALEX: "Open scholarly metadata and content locators.",
    ProviderName.EUROPE_PMC: "Life-science metadata and public full-text files.",
    ProviderName.ELSEVIER: "Scopus metadata and entitlement-bound Elsevier PDF access.",
    ProviderName.SPRINGER: "Springer Nature metadata; direct primary-PDF API is unavailable.",
    ProviderName.WILEY: "Entitlement-bound Wiley TDM primary-PDF access.",
    ProviderName.DATACITE: "DOI metadata and saved landing/direct-file hints.",
    ProviderName.CORE: "Open metadata and credentialed full-text PDF access.",
    ProviderName.OPENCITATIONS: "Identifier lookup and citation relations.",
    ProviderName.UNPAYWALL: "OA location discovery using an operator contact email.",
    ProviderName.SCI_HUB: "Operator-enabled mirror lookup outside the default-safe catalog.",
}


def _configure_web_of_science(
    current: WebOfScienceMetadataConfig | None,
    console: ConfigConsole,
) -> WebOfScienceMetadataConfig | None:
    product_value = select_value(
        "Product",
        [
            option(WebOfScienceProduct.STARTER.value, "Starter"),
            option(WebOfScienceProduct.EXPANDED.value, "Expanded"),
        ],
        console=console,
        default=(WebOfScienceProduct.STARTER.value if current is None else current.product.value),
    )
    if product_value is None:
        return None
    database = ask_text("Database", default="WOS" if current is None else current.database)
    if database is None:
        return None
    edition = ask_text("Edition", default=None if current is None else current.edition)
    if edition == "":
        edition = None
    try:
        return WebOfScienceMetadataConfig(
            product=WebOfScienceProduct(product_value),
            database=database,
            edition=edition,
        )
    except (ValidationError, TypeError, ValueError):
        console.message("Web of Science settings are invalid.", kind="warning")
        return None


def _configure_crossref(
    current: CrossrefMetadataConfig | None,
    console: ConfigConsole,
) -> CrossrefMetadataConfig | None:
    mode_value = select_value(
        "Pool",
        [
            option(CrossrefAccessMode.ANONYMOUS.value, "Public"),
            option(CrossrefAccessMode.POLITE.value, "Polite"),
        ],
        console=console,
        default=(CrossrefAccessMode.ANONYMOUS.value if current is None else current.mode.value),
    )
    if mode_value is None:
        return None
    mode = CrossrefAccessMode(mode_value)
    mailto = None
    if mode is CrossrefAccessMode.POLITE:
        mailto = ask_text("Email", default=None if current is None else current.mailto)
        if mailto is None:
            return None
    try:
        return CrossrefMetadataConfig(mode=mode, mailto=mailto)
    except (ValidationError, TypeError, ValueError):
        console.message("Crossref settings are invalid.", kind="warning")
        return None


def _metadata_with(
    configuration: Configuration,
    *,
    web_of_science: WebOfScienceMetadataConfig | None = None,
    crossref: CrossrefMetadataConfig | None = None,
    replace_web_of_science: bool = False,
    replace_crossref: bool = False,
) -> SourcesConfig:
    current = configuration.sources.metadata
    metadata = MetadataSourcesConfig.model_validate(
        {
            "mode": current.mode,
            "providers": current.providers,
            "limit": current.limit,
            "web-of-science": (
                web_of_science if replace_web_of_science else current.web_of_science
            ),
            "crossref": crossref if replace_crossref else current.crossref,
        }
    )
    return SourcesConfig(metadata=metadata, acquisition=configuration.sources.acquisition)


def _configure_source_settings(
    capability: Literal["search", "download"],
    provider: ProviderName,
    console: ConfigConsole,
) -> None:
    before = load_editable_user_configuration()
    if capability == "search" and provider is ProviderName.WEB_OF_SCIENCE:
        settings = _configure_web_of_science(before.sources.metadata.web_of_science, console)
        if settings is None:
            return
        sources = _metadata_with(
            before,
            web_of_science=settings,
            replace_web_of_science=True,
        )
    elif capability == "search" and provider is ProviderName.CROSSREF:
        settings = _configure_crossref(before.sources.metadata.crossref, console)
        if settings is None:
            return
        sources = _metadata_with(before, crossref=settings, replace_crossref=True)
    elif capability == "download" and provider is ProviderName.UNPAYWALL:
        email = ask_text(
            "Email",
            default=(
                None
                if before.sources.acquisition.unpaywall is None
                else before.sources.acquisition.unpaywall.contact_email
            ),
        )
        if email is None:
            return
        try:
            unpaywall = UnpaywallAcquisitionConfig(contact_email=email)
            current = before.sources.acquisition
            acquisition = AcquisitionSourcesConfig.model_validate(
                {
                    "mode": current.mode,
                    "providers": current.providers,
                    "unpaywall": unpaywall,
                    "sci-hub": current.sci_hub,
                }
            )
            sources = SourcesConfig(metadata=before.sources.metadata, acquisition=acquisition)
        except (ValidationError, TypeError, ValueError):
            console.message("Unpaywall contact email is invalid.", kind="warning")
            return
    else:
        console.message("This Source has no ordinary settings.", kind="muted")
        return
    after = Configuration.model_validate({**before.model_dump(mode="python"), "sources": sources})
    if confirm_changes(console, before, after, section="sources"):
        update_configuration_sections(sources=sources)
        console.message("Source settings were saved.", kind="success")


def _toggle_metadata_source(provider: ProviderName, console: ConfigConsole) -> None:
    before = load_editable_user_configuration()
    current = before.sources.metadata
    if current.mode is not SourceMode.CUSTOM:
        console.message("Choose Custom before changing individual Search Sources.", kind="warning")
        return
    enabled = provider in current.providers
    providers = tuple(item for item in current.providers if item is not provider)
    web_of_science = current.web_of_science
    crossref = current.crossref
    if not enabled:
        providers = (*providers, provider)
        if provider is ProviderName.WEB_OF_SCIENCE and web_of_science is None:
            web_of_science = _configure_web_of_science(None, console)
            if web_of_science is None:
                return
        elif provider is ProviderName.CROSSREF and crossref is None:
            crossref = _configure_crossref(None, console)
            if crossref is None:
                return
    metadata = MetadataSourcesConfig.model_validate(
        {
            "mode": current.mode,
            "providers": providers,
            "limit": current.limit,
            "web-of-science": web_of_science,
            "crossref": crossref,
        }
    )
    sources = SourcesConfig(metadata=metadata, acquisition=before.sources.acquisition)
    Configuration.model_validate({**before.model_dump(mode="python"), "sources": sources})
    verb = "Disable" if enabled else "Enable"
    if not confirm(f"{verb} {provider.value} for Search? [y/N] "):
        return
    update_configuration_sections(sources=sources)
    console.message(f"{provider.value} was {'disabled' if enabled else 'enabled'}.", kind="success")


def _sci_hub_sources(
    configuration: Configuration,
    *,
    settings: SciHubAcquisitionConfig | None,
    enabled: bool,
) -> SourcesConfig:
    current = configuration.sources.acquisition
    providers = tuple(item for item in current.providers if item is not ProviderName.SCI_HUB)
    if enabled:
        providers = (*providers, ProviderName.SCI_HUB)
    acquisition = AcquisitionSourcesConfig.model_validate(
        {
            "mode": current.mode,
            "providers": providers,
            "unpaywall": current.unpaywall,
            "sci-hub": settings,
        }
    )
    sources = SourcesConfig(metadata=configuration.sources.metadata, acquisition=acquisition)
    Configuration.model_validate({**configuration.model_dump(mode="python"), "sources": sources})
    return sources


def _add_sci_hub_url(draft: list[str], console: ConfigConsole) -> list[str]:
    if len(draft) >= 8:
        console.message("At most eight Sci-Hub mirrors may be configured.", kind="warning")
        return draft
    value = ask_text("URL")
    if value is None:
        return draft
    try:
        candidate = SciHubAcquisitionConfig(urls=(*draft, value))
    except (ValidationError, TypeError, ValueError):
        console.message(
            "The URL is invalid or already configured. Use a hostname-based HTTPS URL.",
            kind="warning",
        )
        return draft
    return list(candidate.urls)


def _remove_sci_hub_url(draft: list[str], console: ConfigConsole) -> None:
    if not draft:
        console.message("No Sci-Hub mirror can be removed.", kind="muted")
        return
    selected = select_value(
        "Remove",
        [option(str(index), url, kind=ConfigActionKind.DANGER) for index, url in enumerate(draft)],
        console=console,
    )
    if selected is not None:
        draft.pop(int(selected))


def _edit_sci_hub_urls(
    current: SciHubAcquisitionConfig | None,
    console: ConfigConsole,
) -> tuple[str, ...] | Literal["reset"] | None:
    draft = list(BUILTIN_SCI_HUB_MIRROR_URLS if current is None else current.urls)
    while True:
        console.page(
            "Source · sci-hub · Mirrors",
            "Mirror Base URLs are tried in order. The built-in list is used unless a custom "
            "list is saved.",
            facts=(
                ("Mode", "builtin" if current is None else "custom"),
                ("Mirrors", "\n".join(draft) if draft else "none"),
            ),
            notes=(
                "Changing Mirrors does not enable Sci-Hub.",
                "Endpoints are not probed automatically.",
                "No Cookie, login, proxy or session configuration is stored.",
            ),
        )
        action = select_value(
            "Mirrors",
            [
                option("add", "Add"),
                option("remove", "Remove", kind=ConfigActionKind.DANGER),
                option("save", "Save"),
                option("reset", "Reset", kind=ConfigActionKind.DANGER),
                option("back", "Back", kind=ConfigActionKind.NAVIGATE),
            ],
            console=console,
            default="back",
        )
        if action in {None, "back"}:
            return None
        if action == "add":
            draft = _add_sci_hub_url(draft, console)
        elif action == "remove":
            _remove_sci_hub_url(draft, console)
        elif action == "reset":
            return "reset"
        elif not draft:
            console.message("Add at least one Sci-Hub mirror before saving.", kind="warning")
        else:
            try:
                return SciHubAcquisitionConfig(urls=tuple(draft)).urls
            except (ValidationError, TypeError, ValueError):
                console.message("The Sci-Hub mirror list is invalid.", kind="warning")


def _manage_sci_hub_source(console: ConfigConsole) -> None:
    while True:
        before = load_editable_user_configuration()
        current = before.sources.acquisition
        enabled = ProviderName.SCI_HUB in current.providers
        settings = current.sci_hub
        console.page(
            "Download · sci-hub",
            _SOURCE_PURPOSES[ProviderName.SCI_HUB],
            facts=(
                ("State", "enabled" if enabled else "disabled"),
                ("Selection", current.mode.value),
                ("Mirrors", "builtin" if settings is None else "custom"),
                ("Key", "not used"),
            ),
            notes=("Sci-Hub is never enabled by Auto or by editing Mirrors.",),
        )
        action = select_value(
            "Source",
            [
                option(
                    "disable" if enabled else "enable",
                    "Disable" if enabled else "Enable",
                    kind=(ConfigActionKind.DANGER if enabled else ConfigActionKind.CONFIGURE),
                ),
                option("mirrors", "Mirrors"),
                option("back", "Back", kind=ConfigActionKind.NAVIGATE),
            ],
            console=console,
            default="back",
        )
        if action in {None, "back"}:
            return
        if action in {"enable", "disable"}:
            desired = action == "enable"
            if not confirm(f"{action.title()} sci-hub for Download? [y/N] "):
                continue
            update_configuration_sections(
                sources=_sci_hub_sources(before, settings=settings, enabled=desired)
            )
            console.message(
                f"sci-hub was {action}d" + ("; its Mirrors were kept." if not desired else "."),
                kind="success",
            )
            continue
        result = _edit_sci_hub_urls(settings, console)
        if result is None:
            continue
        replacement = None if result == "reset" else SciHubAcquisitionConfig(urls=result)
        update_configuration_sections(
            sources=_sci_hub_sources(before, settings=replacement, enabled=enabled)
        )
        console.message(
            "Sci-Hub Mirrors were reset to builtin."
            if result == "reset"
            else "Sci-Hub Mirrors were saved as custom.",
            kind="success",
        )


def _toggle_acquisition_source(provider: ProviderName, console: ConfigConsole) -> None:
    before = load_editable_user_configuration()
    current = before.sources.acquisition
    if current.mode is not SourceMode.CUSTOM:
        console.message(
            "Choose Custom before changing individual Download Sources.",
            kind="warning",
        )
        return
    if provider is ProviderName.SCI_HUB:
        _manage_sci_hub_source(console)
        return
    enabled = provider in current.providers
    providers = tuple(item for item in current.providers if item is not provider)
    unpaywall = current.unpaywall
    if not enabled:
        providers = (*providers, provider)
        if provider is ProviderName.UNPAYWALL and unpaywall is None:
            email = ask_text("Email")
            if email is None:
                return
            try:
                unpaywall = UnpaywallAcquisitionConfig(contact_email=email)
            except (ValidationError, TypeError, ValueError):
                console.message("Unpaywall contact email is invalid.", kind="warning")
                return
    acquisition = AcquisitionSourcesConfig.model_validate(
        {
            "mode": current.mode,
            "providers": providers,
            "unpaywall": unpaywall,
            "sci-hub": current.sci_hub,
        }
    )
    sources = SourcesConfig(metadata=before.sources.metadata, acquisition=acquisition)
    Configuration.model_validate({**before.model_dump(mode="python"), "sources": sources})
    verb = "Disable" if enabled else "Enable"
    if not confirm(f"{verb} {provider.value} for Download? [y/N] "):
        return
    update_configuration_sections(sources=sources)
    console.message(f"{provider.value} was {'disabled' if enabled else 'enabled'}.", kind="success")


def _set_source_mode(
    capability: Literal["search", "download"],
    mode: SourceMode,
    console: ConfigConsole,
) -> None:
    before = load_editable_user_configuration()
    if capability == "search":
        current = before.sources.metadata
        if current.mode is mode:
            return
        providers = metadata_source_providers(before) if mode is SourceMode.CUSTOM else ()
        metadata = MetadataSourcesConfig.model_validate(
            {
                "mode": mode,
                "providers": providers,
                "limit": current.limit,
                "web-of-science": current.web_of_science,
                "crossref": current.crossref,
            }
        )
        sources = SourcesConfig(metadata=metadata, acquisition=before.sources.acquisition)
    else:
        current = before.sources.acquisition
        if current.mode is mode:
            return
        providers = acquisition_source_providers(before) if mode is SourceMode.CUSTOM else ()
        acquisition = AcquisitionSourcesConfig.model_validate(
            {
                "mode": mode,
                "providers": providers,
                "unpaywall": current.unpaywall,
                "sci-hub": current.sci_hub,
            }
        )
        sources = SourcesConfig(metadata=before.sources.metadata, acquisition=acquisition)
    after = Configuration.model_validate({**before.model_dump(mode="python"), "sources": sources})
    console.message(
        "Custom freezes the current effective Source list and order."
        if mode is SourceMode.CUSTOM
        else "Auto follows the version-maintained default-safe Source catalog.",
        kind="muted",
    )
    if confirm_changes(console, before, after, section="sources"):
        update_configuration_sections(sources=sources)
        console.message(f"{capability.title()} Sources now use {mode.value}.", kind="success")


def _run_source_test(provider: ProviderName, console: ConfigConsole) -> None:
    if not confirm(
        f"Run one read-only {provider.value} metadata probe? It may consume quota. [y/N] "
    ):
        return
    configuration = load_user_configuration()
    session = build_production_configuration_probe_session(configuration)
    try:
        result = session.run(provider=provider)
    finally:
        session.close()
    ConfigStatusPresenter(console.palette.name).probes(result.model_dump(mode="json"))


def _source_has_settings(capability: str, provider: ProviderName) -> bool:
    return (capability, provider) in {
        ("search", ProviderName.WEB_OF_SCIENCE),
        ("search", ProviderName.CROSSREF),
        ("download", ProviderName.UNPAYWALL),
    }


def _source_actions(
    capability: Literal["search", "download"],
    provider: ProviderName,
    *,
    configurable_keys: frozenset[ProviderName],
    enabled: bool,
    mode: SourceMode,
) -> list[ConfigOption[str]]:
    actions: list[ConfigOption[str]] = []
    if _source_has_settings(capability, provider):
        actions.append(option("setup", "Setup"))
    if provider in configurable_keys:
        actions.append(option("key", "Key"))
    if capability == "search" and enabled:
        actions.append(option("test", "Test", kind=ConfigActionKind.TEST))
    if mode is SourceMode.CUSTOM:
        actions.append(
            option(
                "disable" if enabled else "enable",
                "Disable" if enabled else "Enable",
                kind=(ConfigActionKind.DANGER if enabled else ConfigActionKind.CONFIGURE),
            )
        )
    actions.append(option("back", "Back", kind=ConfigActionKind.NAVIGATE))
    return actions


def _perform_source_action(
    action: str,
    capability: Literal["search", "download"],
    provider: ProviderName,
    console: ConfigConsole,
) -> None:
    if action == "setup":
        _configure_source_settings(capability, provider, console)
    elif action == "key":
        manage_source_key(provider, console)
    elif action == "test":
        _run_source_test(provider, console)
    elif capability == "search":
        _toggle_metadata_source(provider, console)
    else:
        _toggle_acquisition_source(provider, console)


def _manage_source(
    capability: Literal["search", "download"],
    provider: ProviderName,
    console: ConfigConsole,
) -> None:
    if capability == "download" and provider is ProviderName.SCI_HUB:
        _manage_sci_hub_source(console)
        return
    configurable_keys = frozenset(configurable_credential_providers())
    while True:
        configuration = load_editable_user_configuration()
        current = (
            configuration.sources.metadata
            if capability == "search"
            else configuration.sources.acquisition
        )
        effective = (
            metadata_source_providers(configuration)
            if capability == "search"
            else acquisition_source_providers(configuration)
        )
        enabled = provider in effective
        key = credential_state(provider) if provider in configurable_keys else "not used"
        console.page(
            f"{capability.title()} · {provider.value}",
            _SOURCE_PURPOSES[provider],
            facts=(
                ("State", "enabled" if enabled else "disabled"),
                ("Selection", current.mode.value),
                ("Key", key),
            ),
            notes=(
                "Test performs an external read-only metadata request and may consume quota."
                if capability == "search" and enabled
                else "Keys and ordinary settings never enable this Source by themselves.",
            ),
        )
        actions = _source_actions(
            capability,
            provider,
            configurable_keys=configurable_keys,
            enabled=enabled,
            mode=current.mode,
        )
        action = select_value("Source", actions, console=console, default="back")
        if action is None or action == "back":
            return
        _perform_source_action(action, capability, provider, console)


def _manage_sources(
    capability: Literal["search", "download"],
    console: ConfigConsole,
) -> None:
    while True:
        configuration = load_editable_user_configuration()
        current = (
            configuration.sources.metadata
            if capability == "search"
            else configuration.sources.acquisition
        )
        effective = (
            metadata_source_providers(configuration)
            if capability == "search"
            else acquisition_source_providers(configuration)
        )
        candidates = _METADATA_SOURCES if capability == "search" else _ACQUISITION_SOURCES
        visible = effective if current.mode is SourceMode.AUTO else candidates
        console.page(
            f"{capability.title()} · Sources",
            "Auto follows the version-maintained default-safe catalog. Custom freezes an exact "
            "ordered list. Open a Source to manage its settings, key and available test.",
            facts=(
                ("Mode", current.mode.value),
                ("Active", ", ".join(item.value for item in effective) or "none"),
                *(
                    (("Limit", f"{configuration.sources.metadata.limit} / Source"),)
                    if capability == "search"
                    else ()
                ),
            ),
            notes=("No Source is probed automatically while this page is open.",),
        )
        actions = [
            option(
                "custom" if current.mode is SourceMode.AUTO else "auto",
                "Custom" if current.mode is SourceMode.AUTO else "Auto",
            ),
            *(option(f"source:{provider.value}", provider.value) for provider in visible),
            option("back", "Back", kind=ConfigActionKind.NAVIGATE),
        ]
        selected = select_value(
            "Sources",
            actions,
            console=console,
            default="back",
            searchable=True,
        )
        if selected in {None, "back"}:
            return
        if selected == "auto":
            _set_source_mode(capability, SourceMode.AUTO, console)
        elif selected == "custom":
            _set_source_mode(capability, SourceMode.CUSTOM, console)
        elif selected.startswith("source:"):
            _manage_source(
                capability,
                ProviderName(selected.removeprefix("source:")),
                console,
            )


def _set_metadata_source_limit(console: ConfigConsole) -> None:
    before = load_editable_user_configuration()
    current = before.sources.metadata
    answer = ask_text("Limit", default=str(current.limit))
    if answer is None:
        return
    try:
        limit = int(answer, 10)
        if str(limit) != answer.strip():
            raise ValueError
        metadata = MetadataSourcesConfig.model_validate(
            {
                "mode": current.mode,
                "providers": current.providers,
                "limit": limit,
                "web-of-science": current.web_of_science,
                "crossref": current.crossref,
            }
        )
    except (ValidationError, TypeError, ValueError):
        console.message("Limit must be a positive integer.", kind="warning")
        return
    sources = SourcesConfig(metadata=metadata, acquisition=before.sources.acquisition)
    after = Configuration.model_validate({**before.model_dump(mode="python"), "sources": sources})
    topic_sources = sum(
        provider is not ProviderName.OPENCITATIONS for provider in metadata_source_providers(after)
    )
    console.message(
        f"Each Search Source may scan {limit} raw items; the current topic-search ceiling is "
        f"{limit * topic_sources} across {topic_sources} Sources.",
        kind="muted",
    )
    if confirm_changes(console, before, after, section="sources"):
        update_configuration_sections(sources=sources)
        console.message("Search Limit was saved.", kind="success")


def manage_search(console: ConfigConsole) -> None:
    while True:
        configuration = load_editable_user_configuration()
        effective = metadata_source_providers(configuration)
        console.page(
            "Search",
            "Configure metadata discovery. Each Source owns its ordinary settings, key and "
            "explicit probe; Limit applies independently to every active Source.",
            facts=(
                ("Mode", configuration.sources.metadata.mode.value),
                ("Sources", len(effective)),
                ("Limit", f"{configuration.sources.metadata.limit} / Source"),
            ),
            notes=("Opening Search is local and performs no Provider request.",),
        )
        action = select_value(
            "Search",
            [
                option("sources", "Sources"),
                option("limit", "Limit"),
                option("back", "Back", kind=ConfigActionKind.NAVIGATE),
            ],
            console=console,
            default="back",
        )
        if action in {None, "back"}:
            return
        if action == "sources":
            _manage_sources("search", console)
        elif action == "limit":
            _set_metadata_source_limit(console)


def manage_download(console: ConfigConsole) -> None:
    while True:
        configuration = load_editable_user_configuration()
        effective = acquisition_source_providers(configuration)
        console.page(
            "Download",
            "Configure named PDF acquisition Sources. Each Source owns its ordinary settings "
            "and key; controlled Browser configuration lives in the separate Browser area.",
            facts=(
                ("Mode", configuration.sources.acquisition.mode.value),
                ("Sources", len(effective)),
            ),
            notes=(
                "Acquisition still consumes safe saved asset hints before named Sources.",
                "Opening Download performs no external request and starts no Browser.",
            ),
        )
        action = select_value(
            "Download",
            [
                option("sources", "Sources"),
                option("back", "Back", kind=ConfigActionKind.NAVIGATE),
            ],
            console=console,
            default="back",
        )
        if action in {None, "back"}:
            return
        _manage_sources("download", console)


__all__ = ("manage_download", "manage_search")
