"""Reusable Model and Model Provider configuration pages."""

from __future__ import annotations

import getpass
import ipaddress
from collections.abc import Sequence
from typing import Literal, cast
from urllib.parse import urlsplit

from pydantic import ValidationError

from sciretriever.agents.api import AgentFailure, AgentModelSummary
from sciretriever.bootstrap import BootstrapError, fetch_agent_models
from sciretriever.configuration import (
    ConfigurationError,
    build_model_configuration,
    build_model_provider_configuration,
    configuration_service_origin,
    load_credentials,
    load_editable_user_configuration,
    model_provider_credential_section_exists,
    remove_model,
    remove_model_provider,
    remove_model_provider_credentials,
    set_model_provider_credentials,
    update_configuration_sections,
    update_model_provider_configuration,
    upsert_model,
    upsert_model_provider,
)
from sciretriever.entry.cli.config_center.common import (
    ask_boolean,
    ask_text,
    confirm,
    confirm_changes,
    option,
    select_value,
)
from sciretriever.entry.cli.config_center.probes import (
    ConfigurationTestRequest,
    run_interactive_test,
)
from sciretriever.entry.cli.config_ui import ConfigActionKind, ConfigConsole
from sciretriever.model.configuration import (
    AgentProtocol,
    AgentReasoningEffort,
    Configuration,
    ModelConfig,
    ModelProviderConfig,
    ModelProvidersConfig,
    ModelsConfig,
)

_REASONING_EFFORTS = tuple(AgentReasoningEffort)


def _read_api_key(console: ConfigConsole) -> str | None:
    try:
        secret = getpass.getpass("Key (hidden): ").strip()
    except EOFError:
        secret = ""
    if not secret:
        console.message("No key was entered; nothing was saved.", kind="warning")
        return None
    return secret


def _catalog_failure_message(code: str) -> str:
    return {
        "agent-authentication": "The Provider did not accept this key.",
        "agent-timeout": "The Provider did not answer before the safe timeout.",
        "agent-access": "SciRetriever could not reach the Provider safely.",
        "agent-http-status": "The Provider does not expose a usable model list here.",
        "agent-protocol": "The model list is not compatible with this API.",
        "agent-response-budget": "The Provider returned a model list that was too large.",
    }.get(code, "The model list could not be read safely.")


def _provider_identity_from_url(base_url: str) -> str:
    hostname = urlsplit(base_url.strip()).hostname
    if hostname is None:
        raise ValueError("Provider URL has no hostname")
    try:
        address = ipaddress.ip_address(hostname)
    except ValueError:
        address = None
    if hostname.casefold() == "localhost" or (address is not None and address.is_loopback):
        return "local"
    labels = hostname.casefold().split(".")
    candidate = labels[0]
    if candidate in {"api", "gateway", "llm", "models", "www"} and len(labels) > 1:
        candidate = labels[1]
    return candidate.replace("_", "-")


def _select_provider_api(
    console: ConfigConsole,
    *,
    default: AgentProtocol,
) -> AgentProtocol | None:
    selected = select_value(
        "API",
        [
            option(AgentProtocol.OPENAI_RESPONSES.value, "Responses"),
            option(AgentProtocol.OPENAI_CHAT_COMPLETIONS.value, "Chat"),
            option(AgentProtocol.ANTHROPIC_MESSAGES.value, "Messages"),
        ],
        console=console,
        default=default.value,
    )
    return None if selected is None else AgentProtocol(selected)


def _create_provider(
    console: ConfigConsole,
    *,
    current: ModelProviderConfig | None = None,
) -> ModelProviderConfig | None:
    if current is None:
        kind = select_value(
            "Provider",
            [
                option("openai", "OpenAI"),
                option("anthropic", "Anthropic"),
                option("deepseek", "DeepSeek"),
                option("custom", "Custom"),
            ],
            console=console,
            default="openai",
        )
        if kind is None:
            return None
        defaults = {
            "openai": (
                "openai",
                "https://api.openai.com/v1",
                AgentProtocol.OPENAI_RESPONSES,
            ),
            "anthropic": (
                "anthropic",
                "https://api.anthropic.com/v1",
                AgentProtocol.ANTHROPIC_MESSAGES,
            ),
            "deepseek": (
                "deepseek",
                "https://api.deepseek.com/v1",
                AgentProtocol.OPENAI_CHAT_COMPLETIONS,
            ),
        }
        if kind in defaults:
            name, base_url, default_api = defaults[kind]
            console.message(f"URL {base_url}", kind="muted")
        else:
            base_url = ask_text("URL")
            if base_url is None:
                return None
            try:
                name = _provider_identity_from_url(base_url)
            except ValueError:
                console.message("The Provider URL is invalid.", kind="warning")
                return None
            default_api = AgentProtocol.OPENAI_RESPONSES
        api = _select_provider_api(console, default=default_api)
    else:
        name = current.name
        base_url = ask_text("URL", default=current.base_url)
        if base_url is None:
            return None
        api = _select_provider_api(console, default=current.api)
    if api is None:
        return None
    try:
        return build_model_provider_configuration(name=name, api=api, base_url=base_url)
    except (ValidationError, TypeError, ValueError):
        console.message("Those Provider settings are invalid.", kind="warning")
        return None


def _choose_provider(
    configuration: Configuration,
    console: ConfigConsole,
    *,
    include_new: bool = False,
) -> ModelProviderConfig | Literal["new"] | None:
    values = [option(item.name, item.name) for item in configuration.providers.values]
    if include_new:
        values.append(option("new", "New"))
    if not values:
        return "new" if include_new else None
    selected = select_value(
        "Provider",
        values,
        console=console,
        default="new" if include_new and not configuration.providers.values else None,
        searchable=True,
    )
    if selected in {None, "new"}:
        return cast(ModelProviderConfig | Literal["new"] | None, selected)
    return configuration.providers.get(selected)


def _provider_key(
    provider: ModelProviderConfig,
    console: ConfigConsole,
    *,
    prompt_missing: bool,
) -> tuple[str | None, bool, bool]:
    if not provider.requires_api_key:
        return None, True, False
    try:
        origin = configuration_service_origin(provider.base_url)
        secret = load_credentials(home=None).model_secret_for_origin(provider.name, origin)
    except ConfigurationError:
        console.message("The Provider key status could not be read safely.", kind="warning")
        return None, False, False
    if secret is not None:
        return secret, True, False
    if not prompt_missing:
        console.message("This Provider needs a matching key.", kind="warning")
        return None, False, False
    secret = _read_api_key(console)
    return secret, secret is not None, secret is not None


def _fetch_model(
    provider: ModelProviderConfig,
    *,
    api_key: str | None,
    console: ConfigConsole,
) -> AgentModelSummary | None:
    console.message("Reading the Provider model list…", kind="muted")
    try:
        catalog = fetch_agent_models(
            provider_name=provider.name,
            api=provider.api,
            base_url=provider.base_url,
            api_key=api_key,
        )
    except AgentFailure as error:
        console.message(
            _catalog_failure_message(error.failure.code) + " Using Manual instead.",
            kind="warning",
        )
    except (BootstrapError, ConfigurationError, OSError, TypeError, ValueError):
        console.message(
            "The model list could not be read safely. Using Manual instead.",
            kind="warning",
        )
    else:
        if catalog.models:
            selected = select_value(
                "Model",
                [option(item.model, item.model) for item in catalog.models],
                console=console,
                searchable=True,
            )
            if selected is None:
                return None
            return next(item for item in catalog.models if item.model == selected)
        console.message("The Provider returned no models. Using Manual instead.", kind="warning")
    model = ask_text("Manual")
    if model is None:
        return None
    try:
        return AgentModelSummary(model=model)
    except (TypeError, ValueError):
        console.message("That Model identity is invalid.", kind="warning")
        return None


def _select_reasoning(
    console: ConfigConsole,
    *,
    current: AgentReasoningEffort,
) -> AgentReasoningEffort | None:
    selected = select_value(
        "Reasoning",
        [
            option(
                effort.value,
                "Default"
                if effort is AgentReasoningEffort.PROVIDER_DEFAULT
                else effort.value.title(),
            )
            for effort in _REASONING_EFFORTS
        ],
        console=console,
        default=current.value,
    )
    return None if selected is None else AgentReasoningEffort(selected)


def _with_registry(
    before: Configuration,
    *,
    providers: ModelProvidersConfig,
    models: ModelsConfig,
) -> Configuration:
    payload = before.model_dump(mode="python")
    payload.update({"providers": providers, "models": models})
    return Configuration.model_validate(payload)


def _add_model(console: ConfigConsole) -> None:  # noqa: C901
    before = load_editable_user_configuration()
    selected_provider = _choose_provider(before, console, include_new=True)
    if selected_provider is None:
        return
    provider_is_new = selected_provider == "new"
    provider = (
        _create_provider(console)
        if provider_is_new
        else cast(ModelProviderConfig, selected_provider)
    )
    if provider is None:
        return
    if provider_is_new and before.providers.get(provider.name) is not None:
        console.message("That Provider already exists; select it from Provider.", kind="warning")
        return
    api_key, key_ready, key_entered = _provider_key(
        provider,
        console,
        prompt_missing=True,
    )
    if not key_ready:
        return
    summary = _fetch_model(provider, api_key=api_key, console=console)
    if summary is None:
        return
    reasoning = _select_reasoning(console, current=AgentReasoningEffort.PROVIDER_DEFAULT)
    if reasoning is None:
        return
    image = ask_boolean("Image", console=console, default=False)
    if image is None:
        return
    stream = ask_boolean("Stream", console=console, default=True)
    if stream is None:
        return
    try:
        model = build_model_configuration(
            provider=provider.name,
            model=summary.model,
            reasoning=reasoning,
            image=image,
            stream=stream,
        )
        if before.models.get(model.reference) is not None:
            console.message("That Model already exists; use Edit.", kind="warning")
            return
        registry = upsert_model(before, provider=provider, model=model)
        after = _with_registry(
            before,
            providers=registry.providers,
            models=registry.models,
        )
    except (ValidationError, TypeError, ValueError):
        console.message("Those Model settings are invalid.", kind="warning")
        return
    console.page(
        f"Models · {model.reference}",
        "Review the reusable Model before it is added. No Analyze or Browser selection is "
        "changed by this operation.",
        facts=(
            ("API", provider.api.value),
            ("URL", provider.base_url),
            ("Reasoning", model.reasoning.value),
            ("Images", "yes" if model.image else "no"),
            ("Stream", "on" if model.stream else "off"),
        ),
    )
    if not confirm_changes(
        console,
        before,
        after,
        section=("providers", "models"),
    ):
        return
    if provider_is_new or key_entered:
        update_model_provider_configuration(
            provider=provider.name,
            providers=registry.providers,
            models=registry.models,
            secret=api_key if provider.requires_api_key else None,
            origin=(
                configuration_service_origin(provider.base_url)
                if provider.requires_api_key
                else None
            ),
        )
    else:
        update_configuration_sections(providers=registry.providers, models=registry.models)
    console.message(f"Model {model.reference!r} was saved.", kind="success")


def choose_model(
    configuration: Configuration,
    console: ConfigConsole,
    *,
    candidates: Sequence[ModelConfig] | None = None,
) -> ModelConfig | None:
    values = tuple(configuration.models.values if candidates is None else candidates)
    if not values:
        console.message("No matching Model is configured.", kind="warning")
        return None
    selected = select_value(
        "Model",
        [option(model.reference, model.reference) for model in values],
        console=console,
        searchable=True,
    )
    return None if selected is None else configuration.models.get(selected)


def _edit_model(reference: str, console: ConfigConsole) -> None:
    before = load_editable_user_configuration()
    selected = before.models.get(reference)
    if selected is None:
        console.message("The Model no longer exists.", kind="warning")
        return
    reasoning = _select_reasoning(console, current=selected.reasoning)
    if reasoning is None:
        return
    image = ask_boolean("Image", console=console, default=selected.image)
    if image is None:
        return
    stream = ask_boolean("Stream", console=console, default=selected.stream)
    if stream is None:
        return
    provider = before.providers.get(selected.provider)
    if provider is None:
        console.message("The Model Provider is missing.", kind="warning")
        return
    replacement = selected.model_copy(
        update={"reasoning": reasoning, "image": image, "stream": stream}
    )
    try:
        registry = upsert_model(before, provider=provider, model=replacement)
        after = _with_registry(
            before,
            providers=registry.providers,
            models=registry.models,
        )
    except (ValidationError, TypeError, ValueError):
        console.message(
            "This edit would invalidate the Model selected by Browser.",
            kind="warning",
        )
        return
    if confirm_changes(console, before, after, section="models"):
        update_configuration_sections(models=registry.models)
        console.message(f"Model {replacement.reference!r} was updated.", kind="success")


def _remove_model(reference: str, console: ConfigConsole) -> None:
    before = load_editable_user_configuration()
    selected = before.models.get(reference)
    if selected is None or not confirm(f"Remove Model {reference!r}? [y/N] "):
        return
    try:
        models = remove_model(before, reference=selected.reference)
        update_configuration_sections(models=models)
    except (ConfigurationError, TypeError, ValueError):
        console.message(
            "The Model is selected by Analyze or Browser. Select another Model first.",
            kind="warning",
        )
        return
    console.message(f"Model {selected.reference!r} was removed.", kind="success")


def _add_provider(console: ConfigConsole) -> None:
    before = load_editable_user_configuration()
    provider = _create_provider(console)
    if provider is None:
        return
    if before.providers.get(provider.name) is not None:
        console.message("That Provider already exists; use Edit.", kind="warning")
        return
    api_key, key_ready, _entered = _provider_key(provider, console, prompt_missing=True)
    if not key_ready:
        return
    try:
        providers = upsert_model_provider(before, provider=provider)
        after = _with_registry(before, providers=providers, models=before.models)
    except (ValidationError, TypeError, ValueError):
        console.message("The Provider could not be added.", kind="warning")
        return
    if not confirm_changes(console, before, after, section="providers"):
        return
    update_model_provider_configuration(
        provider=provider.name,
        providers=providers,
        models=before.models,
        secret=api_key if provider.requires_api_key else None,
        origin=(
            configuration_service_origin(provider.base_url) if provider.requires_api_key else None
        ),
    )
    console.message(f"Provider {provider.name!r} was added.", kind="success")


def _edit_provider(name: str, console: ConfigConsole) -> None:
    before = load_editable_user_configuration()
    selected = before.providers.get(name)
    if selected is None:
        console.message("The Provider no longer exists.", kind="warning")
        return
    replacement = _create_provider(console, current=selected)
    if replacement is None:
        return
    api_key, key_ready, _entered = _provider_key(replacement, console, prompt_missing=True)
    if not key_ready:
        return
    try:
        providers = upsert_model_provider(before, provider=replacement)
        after = _with_registry(before, providers=providers, models=before.models)
    except (ValidationError, TypeError, ValueError):
        console.message("The Provider edit is invalid.", kind="warning")
        return
    if not confirm_changes(console, before, after, section="providers"):
        return
    update_model_provider_configuration(
        provider=replacement.name,
        providers=providers,
        models=before.models,
        secret=api_key if replacement.requires_api_key else None,
        origin=(
            configuration_service_origin(replacement.base_url)
            if replacement.requires_api_key
            else None
        ),
    )
    console.message(f"Provider {replacement.name!r} was updated.", kind="success")


def _manage_provider_key(name: str, console: ConfigConsole) -> None:
    configuration = load_editable_user_configuration()
    provider = configuration.providers.get(name)
    if provider is None:
        console.message("The Provider no longer exists.", kind="warning")
        return
    if not provider.requires_api_key:
        console.message("This loopback Provider does not use a key.", kind="muted")
        return
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
    if action == "remove":
        if not model_provider_credential_section_exists(provider.name):
            console.message("No key is saved for this Provider.", kind="muted")
            return
        if confirm(f"Remove the key for {provider.name!r}? [y/N] "):
            remove_model_provider_credentials(provider.name)
            console.message("Provider key removed.", kind="success")
        return
    secret = _read_api_key(console)
    if secret is None:
        return
    set_model_provider_credentials(
        provider.name,
        secret=secret,
        origin=configuration_service_origin(provider.base_url),
    )
    console.message("Provider key saved.", kind="success")


def _test_provider(name: str, console: ConfigConsole) -> None:
    configuration = load_editable_user_configuration()
    if configuration.providers.get(name) is None:
        console.message("The Provider no longer exists.", kind="warning")
        return
    run_interactive_test(
        ConfigurationTestRequest(owner="provider", target=name),
        console,
    )


def _test_model(reference: str, *, image: bool, console: ConfigConsole) -> None:
    options = [option("text", "Text", kind=ConfigActionKind.TEST)]
    if image:
        options.append(option("image", "Image", kind=ConfigActionKind.TEST))
    options.append(option("back", "Back", kind=ConfigActionKind.NAVIGATE))
    action = select_value("Test", options, console=console, default="back")
    if action in {None, "back"}:
        return
    run_interactive_test(
        ConfigurationTestRequest(
            owner="model",
            target=reference,
            image_input=action == "image",
        ),
        console,
    )


def _remove_provider(name: str, console: ConfigConsole) -> None:
    before = load_editable_user_configuration()
    provider = before.providers.get(name)
    if provider is None or not confirm(f"Remove Provider {name!r} and its key? [y/N] "):
        return
    try:
        providers = remove_model_provider(before, name=provider.name)
        update_configuration_sections(providers=providers)
        remove_model_provider_credentials(provider.name)
    except (ConfigurationError, TypeError, ValueError):
        console.message("Remove every Model using this Provider first.", kind="warning")
        return
    console.message(f"Provider {provider.name!r} and its key were removed.", kind="success")


def _manage_provider(name: str, console: ConfigConsole) -> None:
    while True:
        configuration = load_editable_user_configuration()
        provider = configuration.providers.get(name)
        if provider is None:
            console.message("The Provider no longer exists.", kind="warning")
            return
        if provider.requires_api_key:
            origin = configuration_service_origin(provider.base_url)
            key_state = (
                "ready"
                if load_credentials(home=None).model_secret_for_origin(provider.name, origin)
                is not None
                else "missing"
            )
        else:
            key_state = "not required"
        model_count = sum(model.provider == provider.name for model in configuration.models.values)
        console.page(
            f"Providers · {provider.name}",
            "Connection settings and the credential lifecycle belong to this Provider. "
            "Changing it affects every Model that references it.",
            facts=(
                ("API", provider.api.value),
                ("URL", provider.base_url),
                ("Key", key_state),
                ("Models", model_count),
            ),
            notes=(
                "Test performs a bounded external model-catalog request and may consume quota.",
            ),
        )
        action = select_value(
            "Provider",
            [
                option("edit", "Edit"),
                option("key", "Key"),
                option("test", "Test", kind=ConfigActionKind.TEST),
                option("remove", "Remove", kind=ConfigActionKind.DANGER),
                option("back", "Back", kind=ConfigActionKind.NAVIGATE),
            ],
            console=console,
            default="back",
        )
        if action in {None, "back"}:
            return
        if action == "edit":
            _edit_provider(name, console)
        elif action == "key":
            _manage_provider_key(name, console)
        elif action == "test":
            _test_provider(name, console)
        elif action == "remove":
            _remove_provider(name, console)


def _manage_providers(console: ConfigConsole) -> None:
    while True:
        configuration = load_editable_user_configuration()
        console.page(
            "Models · Providers",
            "A Provider owns one API protocol, Base URL and exact-origin key. Models reuse that "
            "connection; Analyze and Browser never configure Provider credentials themselves.",
            facts=(("Providers", len(configuration.providers.values)),),
            notes=("Opening this page is local; only a selected Provider's Test contacts it.",),
        )
        action = select_value(
            "Providers",
            [
                option("add", "Add"),
                *(
                    option(f"provider:{provider.name}", provider.name)
                    for provider in configuration.providers.values
                ),
                option("back", "Back", kind=ConfigActionKind.NAVIGATE),
            ],
            console=console,
            default="back",
            searchable=bool(configuration.providers.values),
        )
        if action in {None, "back"}:
            return
        if action == "add":
            _add_provider(console)
        elif action.startswith("provider:"):
            _manage_provider(action.removeprefix("provider:"), console)


def _manage_model(reference: str, console: ConfigConsole) -> None:
    while True:
        configuration = load_editable_user_configuration()
        model = configuration.models.get(reference)
        if model is None:
            console.message("The Model no longer exists.", kind="warning")
            return
        selected_by = tuple(
            owner
            for owner, selected in (
                ("Analyze", configuration.analysis.model),
                ("Browser", configuration.access.model),
            )
            if selected == model.reference
        )
        console.page(
            f"Models · {model.reference}",
            "This Model owns reasoning, image capability and streaming used by every consumer. "
            "Test verifies this exact Model and reasoning without changing Analyze or Browser. "
            "Role-specific contracts remain in their owner pages.",
            facts=(
                ("Provider", model.provider),
                ("Reasoning", model.reasoning.value),
                ("Images", "yes" if model.image else "no"),
                ("Stream", "on" if model.stream else "off"),
                ("Used by", ", ".join(selected_by) or "none"),
            ),
        )
        action = select_value(
            "Model",
            [
                option("edit", "Edit"),
                option("test", "Test", kind=ConfigActionKind.TEST),
                option("remove", "Remove", kind=ConfigActionKind.DANGER),
                option("back", "Back", kind=ConfigActionKind.NAVIGATE),
            ],
            console=console,
            default="back",
        )
        if action in {None, "back"}:
            return
        if action == "edit":
            _edit_model(reference, console)
        elif action == "test":
            _test_model(reference, image=model.image, console=console)
        elif action == "remove":
            _remove_model(reference, console)


def manage_models(console: ConfigConsole) -> None:
    while True:
        configuration = load_editable_user_configuration()
        console.page(
            "Models",
            "Define a reusable Model once, including its Provider, reasoning, image and stream "
            "settings. Analyze and Browser select the Model reference without overriding it.",
            facts=(
                ("Models", len(configuration.models.values)),
                ("Providers", len(configuration.providers.values)),
            ),
            notes=("Opening this page never contacts a Provider or reads its model catalog.",),
        )
        action = select_value(
            "Models",
            [
                option("add", "Add"),
                *(
                    option(f"model:{model.reference}", model.reference)
                    for model in configuration.models.values
                ),
                option("providers", "Providers"),
                option("back", "Back", kind=ConfigActionKind.NAVIGATE),
            ],
            console=console,
            default="back",
            searchable=bool(configuration.models.values),
        )
        if action in {None, "back"}:
            return
        if action == "add":
            _add_model(console)
        elif action == "providers":
            _manage_providers(console)
        elif action.startswith("model:"):
            _manage_model(action.removeprefix("model:"), console)


__all__ = ("choose_model", "manage_models")
