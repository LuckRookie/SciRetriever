"""MinerU Parse service configuration page."""

from __future__ import annotations

import getpass

from pydantic import ValidationError

from sciretriever.configuration import (
    ConfigurationError,
    configuration_service_origin,
    core_credential_section_exists,
    load_credentials,
    load_editable_user_configuration,
    update_core_service_configuration,
)
from sciretriever.entry.cli.config_center.common import (
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
    Configuration,
    CoreCredentialService,
    ParserConnectionMode,
    ParsingConfig,
)


def _read_token(console: ConfigConsole) -> str | None:
    try:
        token = getpass.getpass("MinerU token (hidden): ").strip()
    except EOFError:
        token = ""
    if not token:
        console.message("No token was entered; nothing was changed.", kind="warning")
        return None
    return token


def _remote_credentials(
    base_url: str,
    console: ConfigConsole,
) -> tuple[str, str] | None:
    console.page(
        "Parse · Remote",
        "A Remote MinerU service receives each source PDF outside this machine. The upload "
        "goes only to the exact URL being configured.",
        facts=(("URL", base_url),),
        notes=(
            "Setup does not upload a PDF or contact the service.",
            "Continue only if this deployment is authorized to receive your literature.",
        ),
    )
    if not confirm("Authorize PDF upload to this exact Remote MinerU service? [y/N] "):
        console.message("Remote Parse Setup was cancelled; nothing was changed.", kind="muted")
        return None
    try:
        origin = configuration_service_origin(base_url)
        existing = load_credentials(home=None).core_secret_for_origin(
            CoreCredentialService.MINERU,
            origin,
        )
    except (ConfigurationError, TypeError, ValueError):
        console.message("The Remote MinerU URL has an invalid credential origin.", kind="warning")
        return None
    if existing is not None:
        key_action = select_value(
            "Key",
            [option("keep", "Keep"), option("replace", "Replace")],
            console=console,
            default="keep",
        )
        if key_action is None:
            return None
        secret = existing if key_action == "keep" else _read_token(console)
    else:
        secret = _read_token(console)
    return None if secret is None else (secret, origin)


def _setup(console: ConfigConsole) -> None:
    before = load_editable_user_configuration()
    current = before.parsing
    console.page(
        "Parse · Setup",
        "Configure one operator-managed MinerU 3.4.4 service. Loopback uses local HTTP and no "
        "token; Remote requires hostname-based HTTPS, explicit PDF upload authorization and an "
        "exact-origin bearer token.",
        facts=(
            (
                "Mode",
                "not configured"
                if current.connection_mode is None
                else current.connection_mode.value,
            ),
            ("URL", current.base_url or "not configured"),
            ("Model", current.model_identity or "mineru-3.4.4-vlm"),
        ),
    )
    mode_value = select_value(
        "Mode",
        [option("loopback", "Loopback"), option("remote", "Remote")],
        console=console,
        default=(
            ParserConnectionMode.LOOPBACK.value
            if current.connection_mode is None
            else current.connection_mode.value
        ),
    )
    if mode_value is None:
        return
    mode = ParserConnectionMode(mode_value)
    base_url = ask_text(
        "URL",
        default=(
            current.base_url
            if current.base_url is not None and current.connection_mode is mode
            else "http://127.0.0.1:8000"
            if mode is ParserConnectionMode.LOOPBACK
            else None
        ),
    )
    if base_url is None:
        return
    model_identity = ask_text(
        "Model",
        default=current.model_identity or "mineru-3.4.4-vlm",
    )
    if model_identity is None:
        return

    secret: str | None = None
    origin: str | None = None
    upload_authorized = mode is ParserConnectionMode.REMOTE
    if upload_authorized:
        credentials = _remote_credentials(base_url, console)
        if credentials is None:
            return
        secret, origin = credentials

    try:
        parsing = ParsingConfig(
            base_url=base_url,
            connection_mode=mode,
            model_identity=model_identity,
            remote_upload_authorized=upload_authorized,
        )
        after = Configuration.model_validate(
            {**before.model_dump(mode="python"), "parsing": parsing}
        )
    except (ValidationError, TypeError, ValueError):
        console.message("The MinerU settings are invalid.", kind="warning")
        return
    if not confirm_changes(console, before, after, section="parsing"):
        return
    update_core_service_configuration(
        CoreCredentialService.MINERU,
        parsing=parsing,
        secret=secret,
        origin=origin,
    )
    console.message("Parse Setup was saved.", kind="success")


def _reset(console: ConfigConsole) -> None:
    before = load_editable_user_configuration()
    credential = core_credential_section_exists(CoreCredentialService.MINERU)
    if before.parsing == ParsingConfig() and not credential:
        console.message("Parse is not configured.", kind="muted")
        return
    if not confirm("Reset Parse settings and remove the MinerU token? [y/N] "):
        return
    update_core_service_configuration(
        CoreCredentialService.MINERU,
        parsing=ParsingConfig(),
        secret=None,
        origin=None,
    )
    console.message("Parse configuration was reset.", kind="success")


def _key_state(configuration: Configuration) -> str:
    parsing = configuration.parsing
    if parsing.connection_mode is not ParserConnectionMode.REMOTE or parsing.base_url is None:
        return "not required"
    try:
        origin = configuration_service_origin(parsing.base_url)
        secret = load_credentials(home=None).core_secret_for_origin(
            CoreCredentialService.MINERU,
            origin,
        )
    except (ConfigurationError, TypeError, ValueError):
        return "invalid origin"
    return "ready" if secret is not None else "missing"


def manage_parse(console: ConfigConsole) -> None:
    while True:
        configuration = load_editable_user_configuration()
        parsing = configuration.parsing
        console.page(
            "Parse",
            "Parse sends an accepted PDF to one operator-managed MinerU service and stores the "
            "returned light structured text through SciRetriever's normal lineage boundary.",
            facts=(
                (
                    "Mode",
                    "not configured"
                    if parsing.connection_mode is None
                    else parsing.connection_mode.value,
                ),
                ("URL", parsing.base_url or "not configured"),
                ("Upload", "authorized" if parsing.remote_upload_authorized else "local only"),
                ("Key", _key_state(configuration)),
            ),
            notes=("Test performs GET health only; it never uploads a PDF.",),
        )
        action = select_value(
            "Parse",
            [
                option("setup", "Setup"),
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
        elif action == "test":
            run_interactive_test(ConfigurationTestRequest(owner="parse"), console)
        elif action == "reset":
            _reset(console)


__all__ = ("manage_parse",)
