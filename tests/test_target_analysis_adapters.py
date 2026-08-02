from __future__ import annotations

import json
import unittest

from target_analysis_support import (
    AnthropicClient,
    OpenAIClient,
    adapter_settings,
    analysis_request,
    complete_document,
    openai_adapter,
    proposal_value,
)

from sciretriever.adapters.analysis import (
    AnalysisAdapterError,
    AnalysisAdapterSettings,
    AnthropicAnalysisAdapter,
    OpenAIAnalysisAdapter,
)
from sciretriever.content.analysis import analysis_bytes, analysis_json_schema
from sciretriever.kernel.json import CanonicalJsonInput


class TargetAnalysisAdapterTests(unittest.TestCase):
    def config(self) -> AnalysisAdapterSettings:
        return adapter_settings()

    def test_schema_is_closed_required_and_has_exact_nine_categories(self) -> None:
        schema = analysis_json_schema()
        additional = schema["additionalProperties"]
        assert isinstance(additional, bool)
        self.assertFalse(additional)
        required = schema["required"]
        assert isinstance(required, list)
        self.assertEqual(set(required), set(proposal_value()))
        self.assertEqual(len(required) - 1, 9)

    def test_openai_uses_exact_native_request_and_returns_neutral_proposal(self) -> None:
        message = type("Message", (), {"content": json.dumps(proposal_value()), "refusal": None})()
        choice = type("Choice", (), {"finish_reason": "stop", "message": message})()
        client = OpenAIClient(type("Response", (), {"model": "exact-model", "choices": [choice]})())
        created = {}

        def factory(
            *, api_key: str, base_url: str, timeout: float, max_retries: int
        ) -> OpenAIClient:
            created.update(
                api_key=api_key, base_url=base_url, timeout=timeout, max_retries=max_retries
            )
            return client

        proposal = OpenAIAnalysisAdapter(self.config(), "runtime-secret", factory).analyze(
            analysis_request(complete_document())
        )

        self.assertEqual(proposal.proposal.schema_version, "1")
        self.assertEqual(proposal.provenance.provider, "openai")
        self.assertEqual(proposal.provenance.model, "exact-model")
        self.assertEqual(
            created,
            {
                "api_key": "runtime-secret",
                "base_url": "https://llm.example/v1",
                "timeout": 17.0,
                "max_retries": 0,
            },
        )
        assert client.kwargs is not None
        self.assertEqual(client.kwargs["model"], "exact-model")
        self.assertEqual(client.kwargs["max_completion_tokens"], 321)
        self.assertEqual(client.kwargs["response_format"]["type"], "json_schema")
        self.assertTrue(client.kwargs["response_format"]["json_schema"]["strict"])

    def test_anthropic_uses_exact_native_request_and_matches_openai_bytes(self) -> None:
        openai_value = proposal_value()
        anthropic_value = proposal_value()
        openai_message = type(
            "Message", (), {"content": json.dumps(openai_value), "refusal": None}
        )()
        openai_choice = type("Choice", (), {"finish_reason": "stop", "message": openai_message})()
        openai_client = OpenAIClient(
            type("Response", (), {"model": "exact-model", "choices": [openai_choice]})()
        )
        text = type("Text", (), {"type": "text", "text": json.dumps(anthropic_value)})()
        anthropic_response = type(
            "Response", (), {"model": "exact-model", "stop_reason": "end_turn", "content": [text]}
        )()
        client = AnthropicClient(anthropic_response)
        created = {}

        def openai_factory(
            *, api_key: str, base_url: str, timeout: float, max_retries: int
        ) -> OpenAIClient:
            return openai_client

        def anthropic_factory(
            *, api_key: str, base_url: str, timeout: float, max_retries: int
        ) -> AnthropicClient:
            created.update(
                api_key=api_key, base_url=base_url, timeout=timeout, max_retries=max_retries
            )
            return client

        openai_proposal = OpenAIAnalysisAdapter(
            self.config(),
            "runtime-secret",
            openai_factory,
        ).analyze(analysis_request(complete_document()))
        anthropic_proposal = AnthropicAnalysisAdapter(
            self.config(),
            "runtime-secret",
            anthropic_factory,
        ).analyze(analysis_request(complete_document()))

        self.assertEqual(
            analysis_bytes(openai_proposal.proposal), analysis_bytes(anthropic_proposal.proposal)
        )
        self.assertEqual(created["max_retries"], 0)
        assert client.kwargs is not None
        self.assertEqual(client.kwargs["max_tokens"], 321)
        self.assertEqual(client.kwargs["output_config"]["format"]["type"], "json_schema")

    def test_oversized_input_rejects_before_client_construction(self) -> None:
        calls = 0

        def factory(
            *, api_key: str, base_url: str, timeout: float, max_retries: int
        ) -> OpenAIClient:
            nonlocal calls
            calls += 1
            return OpenAIClient(None)

        base = self.config()
        config = AnalysisAdapterSettings(
            base.base_url,
            base.model,
            base.timeout_seconds,
            base.max_output_tokens,
            1,
            base.max_source_units,
        )
        with self.assertRaisesRegex(AnalysisAdapterError, "analysis_input_too_large"):
            OpenAIAnalysisAdapter(config, "runtime-secret", factory).analyze(
                analysis_request(complete_document())
            )
        self.assertEqual(calls, 0)

    def test_response_and_proposal_failures_have_distinct_sanitized_codes(self) -> None:
        malformed = proposal_value()
        malformed["extra"] = "secret-value"
        cases = (
            ("analysis_model_mismatch", type("Response", (), {"model": "other", "choices": []})()),
            (
                "analysis_refused",
                type(
                    "Response",
                    (),
                    {
                        "model": "exact-model",
                        "choices": [
                            type(
                                "Choice",
                                (),
                                {
                                    "finish_reason": "stop",
                                    "message": type(
                                        "Message", (), {"content": "{}", "refusal": "secret"}
                                    )(),
                                },
                            )()
                        ],
                    },
                )(),
            ),
            (
                "analysis_truncated",
                type(
                    "Response",
                    (),
                    {
                        "model": "exact-model",
                        "choices": [
                            type(
                                "Choice",
                                (),
                                {
                                    "finish_reason": "length",
                                    "message": type(
                                        "Message", (), {"content": "{}", "refusal": None}
                                    )(),
                                },
                            )()
                        ],
                    },
                )(),
            ),
            (
                "analysis_invalid_output",
                type(
                    "Response",
                    (),
                    {
                        "model": "exact-model",
                        "choices": [
                            type(
                                "Choice",
                                (),
                                {
                                    "finish_reason": "stop",
                                    "message": type(
                                        "Message",
                                        (),
                                        {"content": json.dumps(malformed), "refusal": None},
                                    )(),
                                },
                            )()
                        ],
                    },
                )(),
            ),
        )
        for code, response in cases:

            def factory(
                *, api_key: str, base_url: str, timeout: float, max_retries: int
            ) -> OpenAIClient:
                return OpenAIClient(response)

            with self.subTest(code=code), self.assertRaises(AnalysisAdapterError) as raised:
                OpenAIAnalysisAdapter(self.config(), "runtime-secret", factory).analyze(
                    analysis_request(complete_document())
                )
            self.assertEqual(raised.exception.code, code)
            self.assertNotIn("secret", str(raised.exception))

    def test_invalid_evidence_missing_fields_nonfinite_and_blank_content_reject(self) -> None:
        bad_evidence = proposal_value()
        overview = bad_evidence["content_overview"]
        assert isinstance(overview, dict)
        summary = overview["summary"]
        assert isinstance(summary, dict)
        evidence = summary["evidence"]
        assert isinstance(evidence, list)
        locator = evidence[0]
        assert isinstance(locator, dict)
        locator["block_id"] = "not-current"
        missing = proposal_value()
        del missing["methods"]
        nonfinite = proposal_value()
        bibliography = nonfinite["final_bibliography"]
        assert isinstance(bibliography, dict)
        bibliography["publication_year"] = float("nan")
        for code, content in (
            ("analysis_invalid_evidence", json.dumps(bad_evidence)),
            ("analysis_invalid_output", json.dumps(missing)),
            ("analysis_invalid_output", json.dumps(nonfinite)),
            ("analysis_invalid_content", "  "),
            ("analysis_invalid_content", "[]"),
        ):
            message = type("Message", (), {"content": content, "refusal": None})()
            choice = type("Choice", (), {"finish_reason": "stop", "message": message})()
            response = type("Response", (), {"model": "exact-model", "choices": [choice]})()

            def factory(
                *, api_key: str, base_url: str, timeout: float, max_retries: int
            ) -> OpenAIClient:
                return OpenAIClient(response)

            with self.subTest(code=code), self.assertRaises(AnalysisAdapterError) as raised:
                OpenAIAnalysisAdapter(self.config(), "runtime-secret", factory).analyze(
                    analysis_request(complete_document())
                )
            self.assertEqual(raised.exception.code, code)

    def test_required_and_optional_nested_text_rejects_blank_without_trimming(self) -> None:
        cases = []
        text_cases: tuple[tuple[tuple[str, ...], CanonicalJsonInput], ...] = (
            (("final_bibliography", "title"), ""),
            (("final_bibliography", "abstract"), "   "),
            (("classification", "language"), ""),
            (("content_overview", "summary", "text"), "   "),
            (("keywords_and_tags", "keywords"), [" "]),
        )
        for path, blank in text_cases:
            value = proposal_value()
            target = value
            for key in path[:-1]:
                nested = target[key]
                assert isinstance(nested, dict)
                target = nested
            target[path[-1]] = blank
            cases.append(value)
        reference = proposal_value()
        reference["references"] = [
            {
                "reference_id": "00000000-0000-0000-0000-000000000301",
                "raw_text": " ",
                "title": None,
                "authors": [],
                "publication_year": None,
                "source": None,
                "identifiers": [],
                "resolved_work_id": None,
                "resolved_work_version_id": None,
                "evidence": [
                    {
                        "asset_id": "00000000-0000-0000-0000-000000000101",
                        "page_start": 1,
                        "page_end": 1,
                        "block_id": "b1",
                        "char_start": 0,
                        "char_end": 5,
                    }
                ],
            }
        ]
        cases.append(reference)
        blank_identifier = proposal_value()
        metadata = blank_identifier["final_bibliography"]
        assert isinstance(metadata, dict)
        metadata["identifiers"] = [{"namespace": " ", "value": "10.1/example"}]
        cases.append(blank_identifier)
        blank_block = proposal_value()
        overview = blank_block["content_overview"]
        assert isinstance(overview, dict)
        summary = overview["summary"]
        assert isinstance(summary, dict)
        evidence = summary["evidence"]
        assert isinstance(evidence, list)
        locator = evidence[0]
        assert isinstance(locator, dict)
        locator["block_id"] = " "
        cases.append(blank_block)
        for value in cases:
            with self.subTest(value=value), self.assertRaises(AnalysisAdapterError) as raised:
                openai_adapter(value).analyze(analysis_request(complete_document()))
            self.assertEqual(raised.exception.code, "analysis_invalid_output")

        preserved = proposal_value()
        metadata = preserved["final_bibliography"]
        assert isinstance(metadata, dict)
        metadata["abstract"] = "  retained  "
        proposal = openai_adapter(preserved).analyze(analysis_request(complete_document()))
        self.assertEqual(proposal.proposal.final_bibliography.abstract, "  retained  ")

    def test_client_constructor_failures_are_stable_for_both_providers(self) -> None:
        def openai_factory(
            *, api_key: str, base_url: str, timeout: float, max_retries: int
        ) -> OpenAIClient:
            raise OSError(f"secret {base_url} {api_key}")

        def anthropic_factory(
            *, api_key: str, base_url: str, timeout: float, max_retries: int
        ) -> AnthropicClient:
            raise OSError(f"secret {base_url} {api_key}")

        adapters = (
            OpenAIAnalysisAdapter(self.config(), "runtime-secret", openai_factory),
            AnthropicAnalysisAdapter(self.config(), "runtime-secret", anthropic_factory),
        )
        for adapter in adapters:
            with (
                self.subTest(adapter=type(adapter).__name__),
                self.assertRaises(AnalysisAdapterError) as raised,
            ):
                adapter.analyze(analysis_request(complete_document()))
            self.assertEqual(str(raised.exception), "analysis_provider_error")
            self.assertNotIn("runtime-secret", str(raised.exception))

    def test_sdk_capability_and_transport_errors_are_stable_and_redacted(self) -> None:
        def unavailable(
            *, api_key: str, base_url: str, timeout: float, max_retries: int
        ) -> OpenAIClient:
            return OpenAIClient(type("Response", (), {})())

        client = unavailable(api_key="x", base_url="x", timeout=1, max_retries=0)

        def capability(**kwargs):
            raise NotImplementedError("secret native schema detail")

        client.create = capability

        def capability_factory(
            *, api_key: str, base_url: str, timeout: float, max_retries: int
        ) -> OpenAIClient:
            return client

        with self.assertRaises(AnalysisAdapterError) as raised:
            OpenAIAnalysisAdapter(self.config(), "runtime-secret", capability_factory).analyze(
                analysis_request(complete_document())
            )
        self.assertEqual(str(raised.exception), "capability_unavailable")

        client.create = lambda **kwargs: (_ for _ in ()).throw(OSError("secret endpoint"))
        with self.assertRaises(AnalysisAdapterError) as raised:
            OpenAIAnalysisAdapter(self.config(), "runtime-secret", capability_factory).analyze(
                analysis_request(complete_document())
            )
        self.assertEqual(str(raised.exception), "analysis_provider_error")

        anthropic_client = AnthropicClient(type("Response", (), {})())
        anthropic_client.create = lambda **kwargs: (_ for _ in ()).throw(OSError("secret endpoint"))

        def anthropic_factory(
            *, api_key: str, base_url: str, timeout: float, max_retries: int
        ) -> AnthropicClient:
            return anthropic_client

        with self.assertRaises(AnalysisAdapterError) as raised:
            AnthropicAnalysisAdapter(
                self.config(),
                "runtime-secret",
                anthropic_factory,
            ).analyze(analysis_request(complete_document()))
        self.assertEqual(str(raised.exception), "analysis_provider_error")

    def test_anthropic_rejects_truncation_refusal_tool_and_multiple_blocks(self) -> None:
        text = type("Text", (), {"type": "text", "text": json.dumps(proposal_value())})()
        cases = (
            ("analysis_truncated", "max_tokens", [text]),
            ("analysis_unknown_status", "pause_turn", [text]),
            (
                "analysis_refused",
                "end_turn",
                [type("Block", (), {"type": "refusal", "text": "secret"})()],
            ),
            (
                "analysis_unknown_block",
                "end_turn",
                [type("Block", (), {"type": "tool_use", "text": "secret"})()],
            ),
            ("analysis_unknown_response", "end_turn", [text, text]),
        )
        for code, stop_reason, blocks in cases:
            response = type(
                "Response",
                (),
                {"model": "exact-model", "stop_reason": stop_reason, "content": blocks},
            )()

            def factory(
                *, api_key: str, base_url: str, timeout: float, max_retries: int
            ) -> AnthropicClient:
                return AnthropicClient(response)

            with self.subTest(code=code), self.assertRaises(AnalysisAdapterError) as raised:
                AnthropicAnalysisAdapter(self.config(), "runtime-secret", factory).analyze(
                    analysis_request(complete_document())
                )
            self.assertEqual(raised.exception.code, code)
            self.assertNotIn("secret", str(raised.exception))

    def test_anthropic_official_refusal_stop_reason_maps_to_refused(self) -> None:
        response = type(
            "Response",
            (),
            {
                "model": "exact-model",
                "stop_reason": "refusal",
                "content": [],
            },
        )()

        def factory(
            *, api_key: str, base_url: str, timeout: float, max_retries: int
        ) -> AnthropicClient:
            return AnthropicClient(response)

        with self.assertRaises(AnalysisAdapterError) as raised:
            AnthropicAnalysisAdapter(
                self.config(),
                "runtime-secret",
                factory,
            ).analyze(analysis_request(complete_document()))
        self.assertEqual(raised.exception.code, "analysis_refused")


if __name__ == "__main__":
    unittest.main()
