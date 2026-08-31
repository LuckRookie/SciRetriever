"""Markdown literature Analyze configuration page."""

from __future__ import annotations

from pydantic import ValidationError

from sciretriever.configuration import (
    load_editable_user_configuration,
    update_configuration_sections,
)
from sciretriever.entry.cli.config_center.common import (
    ask_positive_integer,
    confirm,
    confirm_changes,
    option,
    select_value,
)
from sciretriever.entry.cli.config_center.models import choose_model
from sciretriever.entry.cli.config_center.probes import run_core_test
from sciretriever.entry.cli.config_ui import ConfigActionKind, ConfigConsole
from sciretriever.model.configuration import AnalysisConfig, Configuration

_DEFAULT_BUDGETS: dict[str, int] = {
    "metadata_max_output_tokens": 2_048,
    "content_max_output_tokens": 8_192,
    "reference_max_output_tokens": 2_048,
    "max_input_bytes": 4_194_304,
    "max_chunk_bytes": 1_048_576,
    "max_chunk_count": 4,
    "max_total_llm_requests": 8,
    "max_total_output_tokens": 32_768,
}

_BUDGET_PRESETS: dict[str, dict[str, int]] = {
    "conservative": {
        **_DEFAULT_BUDGETS,
        "content_max_output_tokens": 4_096,
        "max_input_bytes": 2_097_152,
        "max_chunk_bytes": 524_288,
        "max_chunk_count": 2,
        "max_total_llm_requests": 5,
        "max_total_output_tokens": 16_384,
    },
    "balanced": dict(_DEFAULT_BUDGETS),
    "large": {
        **_DEFAULT_BUDGETS,
        "metadata_max_output_tokens": 4_096,
        "content_max_output_tokens": 16_384,
        "reference_max_output_tokens": 4_096,
        "max_input_bytes": 8_388_608,
        "max_chunk_bytes": 2_097_152,
        "max_chunk_count": 8,
        "max_total_llm_requests": 14,
        "max_total_output_tokens": 65_536,
    },
}


def _custom_budgets() -> dict[str, int] | None:
    labels = {
        "metadata_max_output_tokens": "Metadata output reserve (tokens)",
        "content_max_output_tokens": "Content output reserve (tokens)",
        "reference_max_output_tokens": "Reference output reserve (tokens)",
        "max_input_bytes": "Maximum Analyze input (bytes)",
        "max_chunk_bytes": "Maximum content chunk (bytes)",
        "max_chunk_count": "Maximum content chunks",
        "max_total_llm_requests": "Maximum Model calls per operation",
        "max_total_output_tokens": "Maximum output tokens per operation",
    }
    values: dict[str, int] = {}
    for name, default in _DEFAULT_BUDGETS.items():
        value = ask_positive_integer(labels[name], default=default)
        if value is None:
            return None
        values[name] = value
    return values


def _choose_budgets(console: ConfigConsole) -> dict[str, int] | None:
    preset = select_value(
        "Limits",
        [
            option("conservative", "Conservative"),
            option("balanced", "Balanced"),
            option("large", "Large"),
            option("custom", "Custom"),
        ],
        console=console,
        default="balanced",
    )
    if preset is None:
        return None
    return _custom_budgets() if preset == "custom" else dict(_BUDGET_PRESETS[preset])


def _setup(console: ConfigConsole) -> None:
    before = load_editable_user_configuration()
    selected = choose_model(before, console)
    if selected is None:
        return
    budgets = _choose_budgets(console)
    if budgets is None:
        return
    try:
        analysis = AnalysisConfig(model=selected.reference, **budgets)
        after = Configuration.model_validate(
            {**before.model_dump(mode="python"), "analysis": analysis}
        )
    except (ValidationError, TypeError, ValueError):
        console.message("Those Analyze settings are invalid for this Model.", kind="warning")
        return
    console.page(
        "Analyze · Review",
        "Analyze consumes parsed Markdown and produces the product-defined, domain-neutral "
        "literature analysis result. Reasoning remains an attribute of the selected Model.",
        facts=(
            ("Model", selected.reference),
            ("Reasoning", selected.reasoning.value),
            ("Requests", budgets["max_total_llm_requests"]),
            ("Output", budgets["max_total_output_tokens"]),
        ),
    )
    if confirm_changes(console, before, after, section="analyze"):
        update_configuration_sections(analysis=analysis)
        console.message(f"Analyze now uses {selected.reference!r}.", kind="success")


def _reset(console: ConfigConsole) -> None:
    before = load_editable_user_configuration()
    if before.analysis == AnalysisConfig():
        console.message("Analyze is not configured.", kind="muted")
        return
    if not confirm("Reset the Analyze Model selection and Limits? [y/N] "):
        return
    update_configuration_sections(analysis=AnalysisConfig())
    console.message("Analyze configuration was reset.", kind="success")


def _limits_state(analysis: AnalysisConfig) -> str:
    values = (
        analysis.metadata_max_output_tokens,
        analysis.content_max_output_tokens,
        analysis.reference_max_output_tokens,
        analysis.max_input_bytes,
        analysis.max_chunk_bytes,
        analysis.max_chunk_count,
        analysis.max_total_llm_requests,
        analysis.max_total_output_tokens,
    )
    return "configured" if all(value is not None for value in values) else "not configured"


def manage_analyze(console: ConfigConsole) -> None:
    while True:
        configuration = load_editable_user_configuration()
        analysis = configuration.analysis
        model = configuration.models.get(analysis.model)
        console.page(
            "Analyze",
            "Select one reusable Model and the business Limits used to analyze parsed Markdown. "
            "Provider connection, key, reasoning and image capability remain owned by Models.",
            facts=(
                ("Model", "not selected" if model is None else model.reference),
                ("Reasoning", "not available" if model is None else model.reasoning.value),
                ("Limits", _limits_state(analysis)),
            ),
            notes=(
                "Test sends one minimal strict-schema request and may consume a small amount "
                "of quota.",
                "No Literature content is sent by Test.",
            ),
        )
        action = select_value(
            "Analyze",
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
            run_core_test("llm")
        elif action == "reset":
            _reset(console)


__all__ = ("manage_analyze",)
