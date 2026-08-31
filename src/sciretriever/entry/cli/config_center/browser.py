"""Controlled Browser Agent, Profile and runtime configuration pages."""

from __future__ import annotations

import getpass
from typing import Literal, cast

from pydantic import ValidationError

from sciretriever.acquisition.api import CONTROLLED_BROWSER_PRODUCTION_AVAILABLE
from sciretriever.bootstrap import (
    PRODUCTION_BROWSER_CONFIGURATION_PROBE_ACCESS_KEYS,
    build_production_configuration_probe_session,
)
from sciretriever.configuration import (
    CLOAKBROWSER_BROWSER_VERSION,
    CLOAKBROWSER_ORIGIN,
    CloakRuntimeManager,
    ConfigurationError,
    browser_access_status,
    browser_profile_status,
    configure_browser_access_profile,
    load_credentials,
    load_editable_user_configuration,
    load_user_configuration,
    remove_browser_profile,
    remove_core_credentials,
    set_core_credentials,
    update_configuration_sections,
)
from sciretriever.entry.cli.config_center.common import (
    ask_positive_integer,
    ask_text,
    confirm,
    confirm_changes,
    option,
    select_value,
)
from sciretriever.entry.cli.config_center.models import choose_model
from sciretriever.entry.cli.config_center.probes import run_core_test
from sciretriever.entry.cli.config_ui import (
    ConfigActionKind,
    ConfigConsole,
    ConfigStatusPresenter,
)
from sciretriever.model.configuration import (
    AccessConfig,
    BrowserController,
    BrowserProfilePresence,
    Configuration,
    CoreCredentialService,
)


def _ask_concurrency(current: int, console: ConfigConsole) -> int | None:
    while True:
        value = ask_positive_integer("Concurrency", default=current)
        if value is None:
            return None
        if value > 1:
            return value
        console.message("Browser Concurrency must be greater than 1.", kind="warning")


def _disable(console: ConfigConsole) -> None:
    before = load_editable_user_configuration()
    if not before.access.browser_enabled:
        console.message("Browser is already Off; nothing changed.", kind="muted")
        return
    candidate = before.access.model_copy(update={"browser_enabled": False})
    after = before.model_copy(update={"access": candidate})
    console.page(
        "Browser · Off",
        "Turning Browser Off stops automatic Browser admission. The selected private Profile, "
        "Model and Runtime are retained for a later Setup.",
        facts=(("Profile", candidate.browser_profile or "not selected"),),
    )
    if confirm_changes(console, before, after, section="download") and confirm(
        "Turn controlled Browser access Off and retain the local Profile? [y/N] "
    ):
        update_configuration_sections(access=candidate)
        console.message("Browser was turned Off; the local Profile was retained.", kind="success")


def _setup_candidate(
    before: Configuration,
    console: ConfigConsole,
) -> tuple[AccessConfig, BrowserProfilePresence, Configuration] | None:
    current = before.access
    console.page(
        "Browser · Setup",
        "Choose one mutually exclusive controller. Rules executes reviewed deterministic flows; "
        "Agent uses one image-capable reusable Model to control the same bounded page actions.",
        facts=(
            ("State", "enabled" if current.browser_enabled else "off"),
            ("Controller", current.browser_controller.value),
            ("Model", current.model or "not selected"),
            ("Profile", current.browser_profile or "not selected"),
            ("Concurrency", current.browser_max_concurrency),
        ),
        notes=("Rules and Agent never fall back to each other during a job.",),
    )
    mode = select_value(
        "Mode",
        [
            option("off", "Off", kind=ConfigActionKind.DANGER),
            option(BrowserController.RULES.value, "Rules"),
            option(BrowserController.AGENT.value, "Agent"),
        ],
        console=console,
        default=(current.browser_controller.value if current.browser_enabled else "off"),
    )
    if mode is None:
        return None
    if mode == "off":
        _disable(console)
        return None
    controller = BrowserController(mode)
    model_reference = current.model
    if controller is BrowserController.AGENT:
        eligible = tuple(model for model in before.models.values if model.image)
        selected = choose_model(before, console, candidates=eligible)
        if selected is None:
            console.message(
                "Add an image-capable Model in Models before selecting Agent.",
                kind="warning",
            )
            return None
        model_reference = selected.reference
    profile = ask_text("Profile", default=current.browser_profile or "institutional-access")
    if profile is None:
        return None
    concurrency = _ask_concurrency(current.browser_max_concurrency, console)
    if concurrency is None:
        return None
    try:
        candidate = AccessConfig(
            model=model_reference,
            browser_enabled=True,
            browser_profile=profile,
            browser_controller=controller,
            browser_max_concurrency=concurrency,
            browser_policy_overrides=current.browser_policy_overrides,
        )
        after = Configuration.model_validate(
            {**before.model_dump(mode="python"), "access": candidate}
        )
    except (ValidationError, TypeError, ValueError):
        console.message(
            "Browser Setup is invalid. Use an opaque Profile name rather than a path, URL, "
            "account, token or Cookie label.",
            kind="warning",
        )
        return None
    assert candidate.browser_profile is not None
    presence = browser_profile_status(candidate.browser_profile, home=None).presence
    if presence is BrowserProfilePresence.ATTENTION:
        console.message(
            "The selected Profile requires operator inspection; ownership, permissions or "
            "filesystem type is unsafe. Nothing was changed.",
            kind="warning",
        )
        return None
    return candidate, presence, after


def _setup(console: ConfigConsole) -> None:
    before = load_editable_user_configuration()
    draft = _setup_candidate(before, console)
    if draft is None:
        return
    candidate, presence, after = draft
    controller = candidate.browser_controller
    model_reference = candidate.model
    console.page(
        "Browser · Review",
        "Setup saves the controller settings and initializes the selected fixed-identity "
        "Profile if it does not exist. It does not launch a Browser or visit a Publisher.",
        facts=(
            ("Controller", controller.value),
            ("Model", model_reference or "not used"),
            ("Profile", candidate.browser_profile),
            ("Profile state", presence.value),
            ("Concurrency", candidate.browser_max_concurrency),
        ),
        notes=(
            "The private Profile may later contain Chromium-managed login state.",
            "Profile presence never proves login or article entitlement.",
        ),
    )
    if not CONTROLLED_BROWSER_PRODUCTION_AVAILABLE:
        console.message(
            "No production Browser route is registered; Setup will not enable automatic "
            "Completion yet.",
            kind="warning",
        )
    if not confirm_changes(console, before, after, section="download"):
        return
    if not confirm("Initialize this Profile and save Browser Setup? [y/N] "):
        return
    configure_browser_access_profile(candidate, home=None)
    console.message("Browser Setup and the local Profile were saved.", kind="success")


def _select_profile(console: ConfigConsole) -> None:
    before = load_editable_user_configuration()
    identity = ask_text(
        "Profile",
        default=before.access.browser_profile or "institutional-access",
    )
    if identity is None:
        return
    try:
        candidate = before.access.model_copy(
            update={"browser_enabled": True, "browser_profile": identity}
        )
        after = Configuration.model_validate(
            {**before.model_dump(mode="python"), "access": candidate}
        )
    except (ValidationError, TypeError, ValueError):
        console.message("The Profile identity is invalid.", kind="warning")
        return
    assert candidate.browser_profile is not None
    presence = browser_profile_status(candidate.browser_profile, home=None).presence
    if presence is BrowserProfilePresence.ATTENTION:
        console.message(
            "The selected Profile requires manual filesystem inspection.", kind="warning"
        )
        return
    console.page(
        "Browser · Profiles · Select",
        "Selecting initializes the fixed-identity Profile when missing and enables the current "
        "Browser controller. It never launches Chromium.",
        facts=(("Profile", identity), ("State", presence.value)),
        notes=("Use Setup first when changing controller, Model or Concurrency.",),
    )
    if not confirm_changes(console, before, after, section="download"):
        return
    if not confirm("Select and initialize this Browser Profile? [y/N] "):
        return
    configure_browser_access_profile(candidate, home=None)
    console.message("Browser Profile was selected and initialized.", kind="success")


def _remove_profile(console: ConfigConsole) -> None:
    configuration = load_editable_user_configuration()
    identity = configuration.access.browser_profile
    if identity is None:
        console.message("No Browser Profile is selected.", kind="muted")
        return
    presence = browser_profile_status(identity, home=None).presence
    if presence is BrowserProfilePresence.MISSING:
        console.message("The selected local Profile is already missing.", kind="muted")
        return
    if presence is BrowserProfilePresence.ATTENTION:
        console.message(
            "The Profile requires manual filesystem inspection and was not removed.", kind="warning"
        )
        return
    console.page(
        "Browser · Profiles · Remove",
        "Removal permanently deletes the selected local Chromium Profile, including any login "
        "state. The ordinary Profile identity remains selected and will require initialization.",
        facts=(("Profile", identity),),
        notes=("This operation cannot be recovered and does not remove Provider API keys.",),
    )
    if not confirm("Permanently remove this local Browser Profile? [y/N] "):
        return
    if not remove_browser_profile(identity, home=None):
        console.message("The selected local Profile was already missing.", kind="muted")
        return
    console.message("The local Browser Profile was permanently removed.", kind="success")


def _manage_profiles(console: ConfigConsole) -> None:
    while True:
        configuration = load_editable_user_configuration()
        identity = configuration.access.browser_profile
        presence = browser_profile_status(identity, home=None).presence
        console.page(
            "Browser · Profiles",
            "A Profile is an opaque fixed identity backed by an owner-only Chromium data "
            "directory. SciRetriever does not expose Cookie, login, institution or proxy fields.",
            facts=(
                ("Selected", identity or "none"),
                ("State", presence.value),
            ),
        )
        action = select_value(
            "Profiles",
            [
                option("select", "Select"),
                option("remove", "Remove", kind=ConfigActionKind.DANGER),
                option("back", "Back", kind=ConfigActionKind.NAVIGATE),
            ],
            console=console,
            default="back",
        )
        if action in {None, "back"}:
            return
        if action == "select":
            _select_profile(console)
        elif action == "remove":
            _remove_profile(console)


def _runtime_status_text(status: object) -> str:
    presence = getattr(status, "presence", "missing")
    version = getattr(status, "version", None) or "not installed"
    reason = getattr(status, "reason", None)
    verified = "verified" if getattr(status, "verified", False) else "not verified"
    return f"{presence} · version {version} · {verified}" + (
        f" · reason: {reason}" if reason else ""
    )


def _confirm_runtime_network_action(action: str) -> bool:
    if not confirm(
        f"{action} downloads the pinned CloakBrowser binary from the vendor and verifies its "
        "signature and digest. Continue? [y/N] "
    ):
        return False
    return confirm("Confirm this explicit network and disk operation now? [y/N] ")


def _install_or_update(action: Literal["install", "update"], console: ConfigConsole) -> None:
    manager = CloakRuntimeManager()
    current = manager.status()
    if action == "install" and current.ready:
        console.message("The pinned CloakBrowser Runtime is already installed.", kind="muted")
        return
    if action == "update" and current.ready and current.version == CLOAKBROWSER_BROWSER_VERSION:
        console.message("The pinned CloakBrowser Runtime is already current.", kind="muted")
        return
    if not _confirm_runtime_network_action(action.title()):
        return
    try:
        result = (
            manager.install(CLOAKBROWSER_BROWSER_VERSION)
            if action == "install"
            else manager.update(CLOAKBROWSER_BROWSER_VERSION)
        )
    except ConfigurationError:
        console.message(
            "CloakBrowser installation was not completed; the current verified Runtime was "
            "retained.",
            kind="warning",
        )
        return
    console.message(f"CloakBrowser {result.version} is installed and verified.", kind="success")


def _rollback(console: ConfigConsole) -> None:
    manager = CloakRuntimeManager()
    current = manager.status()
    if not current.rollback_available:
        console.message("No verified previous CloakBrowser Runtime is available.", kind="muted")
        return
    if not _confirm_runtime_network_action("Rollback"):
        return
    try:
        result = manager.rollback()
    except ConfigurationError:
        console.message("Rollback failed safely; the current Runtime was retained.", kind="warning")
        return
    console.message(f"CloakBrowser was rolled back to {result.version}.", kind="success")


def _set_license(console: ConfigConsole) -> None:
    console.page(
        "Browser · Runtime · License",
        "The pinned free v146 installer rejects Pro credentials. This optional value is stored "
        "only as an origin-bound future entitlement and is not used by current Completion.",
        notes=("Saving it does not install, unlock or change the current Runtime.",),
    )
    if not confirm("Save an optional CloakBrowser Pro key for future use? [y/N] "):
        return
    try:
        secret = getpass.getpass("CloakBrowser key (hidden): ").strip()
    except EOFError:
        secret = ""
    if not secret:
        console.message("No key was entered; nothing was changed.", kind="muted")
        return
    set_core_credentials(
        CoreCredentialService.CLOAKBROWSER,
        secret=secret,
        origin=CLOAKBROWSER_ORIGIN,
        home=None,
    )
    console.message("Optional CloakBrowser Pro key was saved.", kind="success")


def _remove_license(console: ConfigConsole) -> None:
    credentials = load_credentials(home=None)
    if not credentials.has_core_service(CoreCredentialService.CLOAKBROWSER):
        console.message("No optional CloakBrowser Pro key is configured.", kind="muted")
        return
    if not confirm("Remove the optional CloakBrowser Pro key? [y/N] "):
        return
    remove_core_credentials(CoreCredentialService.CLOAKBROWSER, home=None)
    console.message("Optional CloakBrowser Pro key was removed.", kind="success")


def _manage_runtime(console: ConfigConsole) -> None:
    while True:
        status = CloakRuntimeManager().status()
        credentials = load_credentials(home=None)
        console.page(
            "Browser · Runtime",
            "CloakBrowser is a pinned, explicit-install headed Runtime. Opening this page never "
            "downloads or launches it; Install, Update and Rollback are explicit network actions.",
            facts=(
                ("Runtime", _runtime_status_text(status)),
                ("Wrapper", "cloakbrowser 0.5.8"),
                ("Playwright", "1.55.0"),
                (
                    "License",
                    "saved"
                    if credentials.has_core_service(CoreCredentialService.CLOAKBROWSER)
                    else "not set",
                ),
            ),
            notes=("The patched Chromium binary is never bundled in the SciRetriever wheel.",),
        )
        action = select_value(
            "Runtime",
            [
                option("install", "Install"),
                option("update", "Update"),
                option("rollback", "Rollback", kind=ConfigActionKind.DANGER),
                option("license", "License"),
                option("remove", "Remove", kind=ConfigActionKind.DANGER),
                option("back", "Back", kind=ConfigActionKind.NAVIGATE),
            ],
            console=console,
            default="back",
        )
        if action in {None, "back"}:
            return
        if action in {"install", "update"}:
            _install_or_update(cast(Literal["install", "update"], action), console)
        elif action == "rollback":
            _rollback(console)
        elif action == "license":
            _set_license(console)
        elif action == "remove":
            _remove_license(console)


def _run_browser_test(console: ConfigConsole) -> None:
    keys = tuple(PRODUCTION_BROWSER_CONFIGURATION_PROBE_ACCESS_KEYS)
    if not keys:
        console.message("No production Browser probe target is available.", kind="muted")
        return
    selected = select_value(
        "Target",
        [option(key, key, kind=ConfigActionKind.TEST) for key in keys],
        console=console,
        searchable=True,
    )
    if selected is None:
        return
    if not confirm(
        "This launches one headed controlled Browser and visits the selected approved minimal "
        "target. Continue? [y/N] "
    ):
        return
    configuration = load_user_configuration()
    session = build_production_configuration_probe_session(configuration)
    try:
        result = session.run_browser(selected)
    finally:
        session.close()
    ConfigStatusPresenter(console.palette.name).probes(result.model_dump(mode="json"))


def _manage_tests(console: ConfigConsole) -> None:
    console.page(
        "Browser · Test",
        "Model verifies the selected Agent Model with a synthetic 1×1 image and closed tool. "
        "Browser launches the headed Runtime and visits one explicitly selected approved target.",
        notes=(
            "Model may consume quota but sends no Literature or real screenshot.",
            "Browser may create ordinary site state in the selected persistent Profile.",
        ),
    )
    action = select_value(
        "Test",
        [
            option("model", "Model", kind=ConfigActionKind.TEST),
            option("browser", "Browser", kind=ConfigActionKind.TEST),
            option("back", "Back", kind=ConfigActionKind.NAVIGATE),
        ],
        console=console,
        default="back",
    )
    if action == "model":
        run_core_test("browser-agent")
    elif action == "browser":
        _run_browser_test(console)


def _reset(console: ConfigConsole) -> None:
    before = load_editable_user_configuration()
    current = before.access
    candidate = AccessConfig(browser_profile=current.browser_profile)
    if candidate == current:
        console.message("Browser settings already use their defaults.", kind="muted")
        return
    after = before.model_copy(update={"access": candidate})
    console.page(
        "Browser · Reset",
        "Reset clears the Model, controller choice, concurrency override and policy overrides, "
        "and turns Browser Off. The selected Profile identity, local Profile bytes, Runtime and "
        "optional Runtime key are retained.",
        facts=(("Profile retained", current.browser_profile or "none"),),
    )
    if confirm_changes(console, before, after, section="download") and confirm(
        "Reset Browser settings while retaining the selected local Profile? [y/N] "
    ):
        update_configuration_sections(access=candidate)
        console.message(
            "Browser settings were reset; the local Profile was retained.", kind="success"
        )


def manage_browser(console: ConfigConsole) -> None:
    while True:
        configuration = load_editable_user_configuration()
        access = configuration.access
        model = configuration.models.get(access.model)
        local = browser_access_status(configuration)
        runtime = CloakRuntimeManager().status()
        console.page(
            "Browser",
            "Configure the controlled headed Browser used only after safer Download routes are "
            "exhausted. Browser owns its controller Model, fixed Profile and Runtime lifecycle.",
            facts=(
                ("State", "enabled" if access.browser_enabled else "off"),
                ("Controller", access.browser_controller.value),
                ("Model", "not selected" if model is None else model.reference),
                ("Profile", access.browser_profile or "not selected"),
                ("Profile state", local.profile.presence.value),
                ("Runtime", "ready" if runtime.verified else "not ready"),
            ),
            notes=(
                "Opening Browser is local: it does not launch Chromium or visit a Publisher.",
                "Article entitlement is checked per article and is never inferred from Profile "
                "presence.",
            ),
        )
        action = select_value(
            "Browser",
            [
                option("setup", "Setup"),
                option("profiles", "Profiles"),
                option("runtime", "Runtime"),
                option("test", "Test", kind=ConfigActionKind.TEST),
                option("reset", "Reset", kind=ConfigActionKind.DANGER),
                option("back", "Back", kind=ConfigActionKind.NAVIGATE),
            ],
            console=console,
            default="back",
        )
        if action in {None, "back"}:
            return
        if action == "setup":
            _setup(console)
        elif action == "profiles":
            _manage_profiles(console)
        elif action == "runtime":
            _manage_runtime(console)
        elif action == "test":
            _manage_tests(console)
        elif action == "reset":
            _reset(console)


__all__ = ("manage_browser",)
