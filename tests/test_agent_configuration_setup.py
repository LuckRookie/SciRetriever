from __future__ import annotations

import unittest

from sciretriever.configuration import (
    build_model_configuration,
    build_model_provider_configuration,
    remove_model,
    remove_model_provider,
    resolve_task_model,
    select_analysis_model,
    select_browser_model,
    upsert_model,
)
from sciretriever.model.configuration import (
    AgentProtocol,
    AgentReasoningEffort,
    AnalysisConfig,
    Configuration,
    ModelProvidersConfig,
    ModelsConfig,
)


def _provider(name: str = "openai"):
    return build_model_provider_configuration(
        name=name,
        api=AgentProtocol.OPENAI_RESPONSES,
        base_url="https://api.openai.com/v1",
    )


def _analysis_model(
    *,
    model: str = "gpt-fixture",
    reasoning: AgentReasoningEffort = AgentReasoningEffort.MAX,
):
    return build_model_configuration(
        provider="openai",
        model=model,
        reasoning=reasoning,
        image=False,
    )


def _browser_model(*, model: str = "gpt-browser-fixture"):
    return build_model_configuration(
        provider="openai",
        model=model,
        reasoning=AgentReasoningEffort.HIGH,
        image=True,
    )


def _with_models(*models) -> Configuration:
    return Configuration(
        providers=ModelProvidersConfig(values=(_provider(),)),
        models=ModelsConfig(values=models),
    )


class ModelRegistrySetupTests(unittest.TestCase):
    def test_analysis_selects_one_model_and_creates_product_limits(self) -> None:
        current = _with_models(_analysis_model())

        selected = select_analysis_model(current, reference="openai/gpt-fixture")
        configured = Configuration(
            providers=current.providers,
            models=current.models,
            analyze=selected.analysis,
        )
        provider, model = resolve_task_model(configured, task="analyze")

        self.assertEqual(selected.analysis.model, "openai/gpt-fixture")
        self.assertEqual(selected.analysis_limits, "created")
        self.assertEqual(provider.name, "openai")
        self.assertEqual(model.model, "gpt-fixture")
        self.assertIs(model.reasoning, AgentReasoningEffort.MAX)
        self.assertEqual(selected.analysis.max_chunk_bytes, 1_048_576)
        self.assertEqual(selected.analysis.max_total_llm_requests, 8)

    def test_browser_only_selects_an_existing_image_model(self) -> None:
        current = _with_models(_analysis_model(), _browser_model())
        analysis = select_analysis_model(
            current,
            reference="openai/gpt-fixture",
        ).analysis
        with_analysis = Configuration(
            providers=current.providers,
            models=current.models,
            analyze=analysis,
        )

        browser = select_browser_model(
            with_analysis,
            reference="openai/gpt-browser-fixture",
        )
        configured = Configuration(
            providers=current.providers,
            models=current.models,
            analyze=analysis,
            browser=browser,
        )
        _provider_value, model = resolve_task_model(configured, task="browser")

        self.assertEqual(configured.analysis.model, "openai/gpt-fixture")
        self.assertEqual(browser.model, "openai/gpt-browser-fixture")
        self.assertEqual(model.model, "gpt-browser-fixture")
        self.assertIs(model.reasoning, AgentReasoningEffort.HIGH)
        self.assertTrue(model.image)

    def test_task_selection_has_no_reasoning_override(self) -> None:
        shared = _browser_model(model="shared")
        current = _with_models(shared)
        analysis = select_analysis_model(current, reference=shared.reference).analysis
        with_analysis = Configuration(
            providers=current.providers,
            models=current.models,
            analyze=analysis,
        )
        browser = select_browser_model(with_analysis, reference=shared.reference)
        configured = Configuration(
            providers=current.providers,
            models=current.models,
            analyze=analysis,
            browser=browser,
        )

        self.assertEqual(
            set(AnalysisConfig.model_fields),
            {
                "model",
                "metadata_max_output_tokens",
                "content_max_output_tokens",
                "reference_max_output_tokens",
                "max_input_bytes",
                "max_chunk_bytes",
                "max_chunk_count",
                "max_total_llm_requests",
                "max_total_output_tokens",
            },
        )
        self.assertEqual(configured.analysis.model, configured.browser.model)
        self.assertIs(
            resolve_task_model(configured, task="analyze")[1].reasoning,
            AgentReasoningEffort.HIGH,
        )
        self.assertIs(
            resolve_task_model(configured, task="browser")[1].reasoning,
            AgentReasoningEffort.HIGH,
        )

    def test_only_image_support_gates_browser_selection(self) -> None:
        text_only = _analysis_model(model="text-only")
        image = _browser_model(model="image")
        current = _with_models(text_only, image)

        with self.assertRaisesRegex(ValueError, "image model"):
            select_browser_model(current, reference=text_only.reference)
        selected = select_analysis_model(current, reference=image.reference)
        self.assertEqual(selected.analysis.model, image.reference)

    def test_registry_edits_guard_selected_models_and_used_providers(self) -> None:
        analysis_model = _analysis_model()
        browser_model = _browser_model()
        current = _with_models(analysis_model, browser_model)
        analysis = select_analysis_model(current, reference=analysis_model.reference).analysis
        with_analysis = Configuration(
            providers=current.providers,
            models=current.models,
            analyze=analysis,
        )
        browser = select_browser_model(with_analysis, reference=browser_model.reference)
        selected = Configuration(
            providers=current.providers,
            models=current.models,
            analyze=analysis,
            browser=browser,
        )

        with self.assertRaisesRegex(ValueError, "selected by a module"):
            remove_model(selected, reference=analysis_model.reference)
        with self.assertRaisesRegex(ValueError, "used by a model"):
            remove_model_provider(selected, name="openai")

        unselected = Configuration(
            providers=current.providers,
            models=current.models,
        )
        remaining = remove_model(unselected, reference=analysis_model.reference)
        self.assertIsNone(remaining.get(analysis_model.reference))

    def test_upsert_revalidates_provider_model_consistency(self) -> None:
        current = Configuration()
        provider = _provider()
        model = _analysis_model()

        registry = upsert_model(current, provider=provider, model=model)

        self.assertEqual(registry.providers.get("openai"), provider)
        self.assertEqual(registry.models.get(model.reference), model)
        with self.assertRaisesRegex(ValueError, "inconsistent"):
            upsert_model(
                current,
                provider=provider,
                model=model.model_copy(update={"reference": "different/gpt-fixture"}),
            )


if __name__ == "__main__":
    unittest.main()
