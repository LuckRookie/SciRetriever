from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest import mock

from pydantic import ValidationError

import sciretriever.configuration as configuration_boundary
from sciretriever.configuration import (
    ConfigurationError,
    configuration_runtime_status,
    configuration_status,
    load_credentials,
    parse_configuration,
    run_configuration_probes,
    set_core_credentials,
)
from sciretriever.model.configuration import (
    Configuration,
    ConfigurationCapabilityStatus,
    ConfigurationProbeResult,
    ConfigurationStatus,
    CredentialStatus,
    ProbeOutcome,
    ProviderCapability,
    ProviderName,
)

_SENTINEL = "CONFIGURATION-PROBE-SECRET-SENTINEL"


def _configuration(
    *,
    metadata: tuple[str, ...] = (),
    acquisition: tuple[str, ...] = (),
    unpaywall: bool = False,
) -> Configuration:
    lines = [
        "[discovery]",
        "metadata_scan_limit = 10",
        "[sources.metadata]",
        "providers = [" + ", ".join(f'"{item}"' for item in metadata) + "]",
        "[sources.metadata.crossref]",
        'mode = "anonymous"',
        "[sources.acquisition]",
        "providers = [" + ", ".join(f'"{item}"' for item in acquisition) + "]",
    ]
    if unpaywall:
        lines.extend(
            (
                "[sources.acquisition.unpaywall]",
                'contact_email = "reader@example.invalid"',
            )
        )
    return parse_configuration("\n".join(lines) + "\n")


def _passed(provider: ProviderName) -> ConfigurationProbeResult:
    return ConfigurationProbeResult(
        provider=provider,
        capability=ProviderCapability.METADATA,
        outcome=ProbeOutcome.PASSED,
        local_ready=True,
        network_reachable=True,
        authentication_accepted=True,
        api_product_usable=True,
        minimal_response_parseable=True,
    )


class _FakeProbe:
    def __init__(
        self,
        supported: frozenset[tuple[ProviderName, ProviderCapability]],
        results: dict[tuple[ProviderName, ProviderCapability], object],
    ) -> None:
        self._supported = supported
        self._results = dict(results)
        self.calls: list[tuple[ProviderName, ProviderCapability]] = []

    @property
    def supported_capabilities(
        self,
    ) -> frozenset[tuple[ProviderName, ProviderCapability]]:
        return self._supported

    def probe(
        self,
        provider: ProviderName,
        capability: ProviderCapability,
    ) -> ConfigurationProbeResult:
        key = (provider, capability)
        self.calls.append(key)
        result = self._results[key]
        if isinstance(result, BaseException):
            raise result
        if not isinstance(result, ConfigurationProbeResult):
            raise TypeError("fixture result is invalid")
        return result


class _ConfiguredResolver:
    def resolve(
        self,
        identifiers: object,
        *,
        cancel_event: object | None = None,
    ) -> tuple[str, ...]:
        del identifiers, cancel_event
        return ()


class AcquisitionConfigurationStatusTests(unittest.TestCase):
    def test_runtime_readiness_is_independent_from_probe_availability(self) -> None:
        providers = (
            "arxiv",
            "crossref",
            "semantic-scholar",
            "openalex",
            "europe-pmc",
            "unpaywall",
            "elsevier",
            "springer",
            "wiley",
            "datacite",
            "core",
            "sci-hub",
        )
        with tempfile.TemporaryDirectory() as temporary:
            credentials = load_credentials(home=Path(temporary))
            status = configuration_status(
                _configuration(acquisition=providers),  # type: ignore[arg-type]
                credentials=credentials,
            )

        acquisition = {
            item.provider: item
            for item in status.capabilities
            if item.capability is ProviderCapability.ACQUISITION
        }
        ready = {
            ProviderName.ARXIV,
            ProviderName.CROSSREF,
            ProviderName.SEMANTIC_SCHOLAR,
            ProviderName.OPENALEX,
            ProviderName.EUROPE_PMC,
            ProviderName.DATACITE,
        }
        for provider in ready:
            with self.subTest(provider=provider.value):
                item = acquisition[provider]
                self.assertTrue(item.production_available)
                self.assertTrue(item.local_ready)
                self.assertTrue(item.access_policy_ready)
                self.assertIs(item.credential.status, CredentialStatus.NOT_REQUIRED)
                self.assertFalse(item.probe_available)
                self.assertIsNone(item.failure_code)

        for provider in (ProviderName.ELSEVIER, ProviderName.SPRINGER):
            with self.subTest(provider=provider.value):
                item = acquisition[provider]
                # The shared public AssetHint path is executable, so the
                # Provider can still be locally ready.  Its distinct
                # authorized primary-PDF API remains unsupported.
                self.assertTrue(item.production_available)
                self.assertTrue(item.local_ready)
                self.assertTrue(item.access_policy_ready)
                self.assertIs(item.credential.status, CredentialStatus.UNSUPPORTED)
                self.assertFalse(item.probe_available)
                self.assertIsNone(item.failure_code)

        core = acquisition[ProviderName.CORE]
        self.assertTrue(core.production_available)
        self.assertFalse(core.local_ready)
        self.assertTrue(core.access_policy_ready)
        self.assertIs(core.credential.status, CredentialStatus.MISSING)
        self.assertEqual(tuple(field.name for field in core.credential.fields), ("api_key",))
        self.assertEqual(core.failure_code, "missing-required-credential")

        unpaywall = acquisition[ProviderName.UNPAYWALL]
        self.assertTrue(unpaywall.production_available)
        self.assertFalse(unpaywall.ordinary_parameters_ready)
        self.assertFalse(unpaywall.local_ready)
        self.assertIs(unpaywall.credential.status, CredentialStatus.NOT_REQUIRED)
        self.assertEqual(unpaywall.failure_code, "missing-ordinary-parameter")

        sci_hub = acquisition[ProviderName.SCI_HUB]
        self.assertTrue(sci_hub.production_available)
        self.assertTrue(sci_hub.ordinary_parameters_ready)
        self.assertFalse(sci_hub.local_ready)
        self.assertIs(sci_hub.credential.status, CredentialStatus.NOT_REQUIRED)
        self.assertEqual(sci_hub.failure_code, "missing-configured-resolver")

        wiley = acquisition[ProviderName.WILEY]
        self.assertTrue(wiley.production_available)
        self.assertFalse(wiley.local_ready)
        self.assertTrue(wiley.access_policy_ready)
        self.assertIs(wiley.credential.status, CredentialStatus.MISSING)
        self.assertEqual(
            tuple(field.name for field in wiley.credential.fields),
            ("tdm_api_token",),
        )
        self.assertEqual(wiley.failure_code, "missing-required-credential")

    def test_unpaywall_and_configured_locator_can_be_locally_ready_without_a_probe(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            credentials = load_credentials(home=Path(temporary))
            status = configuration_status(
                _configuration(
                    acquisition=("unpaywall", "sci-hub"),
                    unpaywall=True,
                ),  # type: ignore[arg-type]
                credentials=credentials,
                configured_sci_hub_resolver=_ConfiguredResolver(),
            )
        selected = {
            item.provider: item
            for item in status.capabilities
            if item.capability is ProviderCapability.ACQUISITION
            and item.provider in {ProviderName.UNPAYWALL, ProviderName.SCI_HUB}
        }
        self.assertTrue(all(item.local_ready for item in selected.values()))
        self.assertTrue(all(not item.probe_available for item in selected.values()))


class RuntimeConfigurationStatusTests(unittest.TestCase):
    def test_reports_storage_parser_analysis_and_secret_presence_without_values(self) -> None:
        configuration = parse_configuration(
            """
            [paths]
            catalog_path = "/private/catalog.sqlite3"
            artifact_root = "/private/artifacts"

            [parsing]
            base_url = "https://mineru.example.invalid"
            connection_mode = "remote"
            model_identity = "mineru-vlm"
            remote_upload_authorized = true

            [analysis]
            provider = "openai"
            protocol = "openai-responses"
            base_url = "https://api.openai.com/v1"
            model = "analysis-model"
            context_window_tokens = 128000
            authentication = "api-key"
            metadata_max_output_tokens = 100
            content_max_output_tokens = 200
            reference_max_output_tokens = 50
            max_input_bytes = 1000
            max_chunk_bytes = 500
            max_chunk_count = 2
            max_total_llm_requests = 4
            max_total_output_tokens = 500
            """
        )
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            set_core_credentials(
                "mineru",
                secret=_SENTINEL,
                origin="https://mineru.example.invalid",
                home=home,
            )
            credentials = set_core_credentials(
                "llm",
                secret=_SENTINEL,
                origin="https://api.openai.com",
                home=home,
            )
            status = configuration_runtime_status(
                configuration,
                credentials=credentials,
            )
        self.assertTrue(status.storage_configuration_complete)
        self.assertTrue(status.parsing.configuration_complete)
        self.assertTrue(status.parsing.bearer_token_required)
        self.assertTrue(status.parsing.bearer_token_configured)
        self.assertTrue(status.analysis.reference_configuration_complete)
        self.assertTrue(status.analysis.content_configuration_complete)
        self.assertTrue(status.analysis.api_key_required)
        self.assertTrue(status.analysis.api_key_configured)
        self.assertTrue(status.analysis.credential_origin_matches)
        self.assertNotIn(_SENTINEL, status.model_dump_json())

    def test_incomplete_local_configuration_lists_exact_missing_fields(self) -> None:
        with mock.patch.object(
            configuration_boundary,
            "load_credentials",
            side_effect=AssertionError("empty local status must not read credentials"),
        ) as load:
            status = configuration_runtime_status(Configuration())
        load.assert_not_called()
        self.assertEqual(
            status.storage_missing_fields,
            ("catalog_path", "artifact_root"),
        )
        self.assertEqual(
            status.parsing.missing_fields,
            ("base_url", "connection_mode", "model_identity"),
        )
        self.assertEqual(
            status.analysis.reference_missing_fields,
            (
                "provider",
                "protocol",
                "base_url",
                "model",
                "context_window_tokens",
                "authentication",
                "reference_max_output_tokens",
            ),
        )
        self.assertIn("max_total_llm_requests", status.analysis.content_missing_fields)
        self.assertIsNone(status.analysis.api_key_configured)


class ConfigurationProbeSessionTests(unittest.TestCase):
    def _snapshot(
        self,
        *,
        metadata: tuple[str, ...] = (),
    ) -> tuple[Configuration, ConfigurationStatus]:
        ordinary = _configuration(metadata=metadata)
        with tempfile.TemporaryDirectory() as temporary:
            credentials = load_credentials(home=Path(temporary))
            snapshot = configuration_status(ordinary, credentials=credentials)  # type: ignore[arg-type]
        return ordinary, snapshot

    def test_explicit_snapshot_is_authoritative_and_never_rereads_credentials(self) -> None:
        ordinary, snapshot = self._snapshot(metadata=("crossref",))
        key = (ProviderName.CROSSREF, ProviderCapability.METADATA)
        probe = _FakeProbe(frozenset({key}), {key: _passed(ProviderName.CROSSREF)})
        with mock.patch.object(
            configuration_boundary,
            "load_credentials",
            side_effect=AssertionError("snapshot execution must not reload credentials"),
        ):
            summary = run_configuration_probes(
                ordinary,  # type: ignore[arg-type]
                probe,
                test_all=True,
                status_snapshot=snapshot,  # type: ignore[arg-type]
            )
        self.assertEqual(tuple(item.outcome for item in summary.results), (ProbeOutcome.PASSED,))
        self.assertEqual(probe.calls, [key])

    def test_named_disabled_is_testable_while_all_selects_enabled_only(self) -> None:
        ordinary, snapshot = self._snapshot()
        key = (ProviderName.CROSSREF, ProviderCapability.METADATA)
        named_probe = _FakeProbe(frozenset({key}), {key: _passed(ProviderName.CROSSREF)})
        named = run_configuration_probes(
            ordinary,  # type: ignore[arg-type]
            named_probe,
            provider=ProviderName.CROSSREF,
            status_snapshot=snapshot,  # type: ignore[arg-type]
        )
        self.assertEqual(tuple(item.outcome for item in named.results), (ProbeOutcome.PASSED,))
        self.assertEqual(named_probe.calls, [key])

        all_probe = _FakeProbe(frozenset({key}), {key: _passed(ProviderName.CROSSREF)})
        all_summary = run_configuration_probes(
            ordinary,  # type: ignore[arg-type]
            all_probe,
            test_all=True,
            status_snapshot=snapshot,  # type: ignore[arg-type]
        )
        self.assertEqual(all_summary.results, ())
        self.assertEqual(all_probe.calls, [])

    def test_supported_but_unready_registration_is_skipped_without_calling_probe(self) -> None:
        ordinary, snapshot = self._snapshot(metadata=("web-of-science",))
        key = (ProviderName.WEB_OF_SCIENCE, ProviderCapability.METADATA)
        probe = _FakeProbe(frozenset({key}), {})
        summary = run_configuration_probes(
            ordinary,  # type: ignore[arg-type]
            probe,
            test_all=True,
            status_snapshot=snapshot,  # type: ignore[arg-type]
        )
        self.assertEqual(tuple(item.outcome for item in summary.results), (ProbeOutcome.SKIPPED,))
        self.assertEqual(probe.calls, [])

    def test_acquisition_is_not_selected_even_if_a_bad_port_claims_support(self) -> None:
        ordinary = _configuration(acquisition=("crossref",))
        with tempfile.TemporaryDirectory() as temporary:
            credentials = load_credentials(home=Path(temporary))
            snapshot = configuration_status(ordinary, credentials=credentials)  # type: ignore[arg-type]
        key = (ProviderName.CROSSREF, ProviderCapability.ACQUISITION)
        probe = _FakeProbe(frozenset({key}), {})
        summary = run_configuration_probes(
            ordinary,  # type: ignore[arg-type]
            probe,
            test_all=True,
            status_snapshot=snapshot,
        )
        self.assertEqual(summary.results, ())
        self.assertEqual(probe.calls, [])

    def test_one_failure_does_not_short_circuit_later_probes(self) -> None:
        ordinary, snapshot = self._snapshot(metadata=("crossref", "arxiv"))
        crossref = (ProviderName.CROSSREF, ProviderCapability.METADATA)
        arxiv = (ProviderName.ARXIV, ProviderCapability.METADATA)
        probe = _FakeProbe(
            frozenset({crossref, arxiv}),
            {
                crossref: RuntimeError("secret response"),
                arxiv: _passed(ProviderName.ARXIV),
            },
        )
        summary = run_configuration_probes(
            ordinary,  # type: ignore[arg-type]
            probe,
            test_all=True,
            status_snapshot=snapshot,  # type: ignore[arg-type]
        )
        self.assertEqual(
            tuple(item.outcome for item in summary.results),
            (ProbeOutcome.FAILED, ProbeOutcome.PASSED),
        )
        self.assertEqual(probe.calls, [crossref, arxiv])
        self.assertNotIn("secret response", repr(summary))

    def test_snapshot_rejects_credentials_inputs_that_would_be_silently_ignored(self) -> None:
        ordinary, snapshot = self._snapshot(metadata=("crossref",))
        key = (ProviderName.CROSSREF, ProviderCapability.METADATA)
        probe = _FakeProbe(frozenset({key}), {key: _passed(ProviderName.CROSSREF)})
        with self.assertRaises(ConfigurationError):
            run_configuration_probes(
                ordinary,  # type: ignore[arg-type]
                probe,
                test_all=True,
                status_snapshot=snapshot,  # type: ignore[arg-type]
                credentials_home=Path("ignored"),
            )

    def test_snapshot_rejects_duplicate_keys_and_inconsistent_credential_identity(self) -> None:
        ordinary, snapshot = self._snapshot(metadata=("crossref",))
        crossref = next(
            item
            for item in snapshot.capabilities  # type: ignore[union-attr]
            if item.provider is ProviderName.CROSSREF
            and item.capability is ProviderCapability.METADATA
        )
        with self.assertRaises(ValidationError):
            ConfigurationStatus(
                configuration_fingerprint=snapshot.configuration_fingerprint,
                capabilities=(crossref, crossref),
            )
        with self.assertRaises(ValidationError):
            ConfigurationCapabilityStatus(
                **{
                    **crossref.model_dump(),
                    "credential": crossref.credential.model_copy(
                        update={"provider": ProviderName.ARXIV}
                    ),
                }
            )
        del ordinary

    def test_snapshot_is_bound_to_configuration_and_exact_complete_ordered_matrix(self) -> None:
        ordinary, snapshot = self._snapshot(metadata=("crossref",))
        crossref = (ProviderName.CROSSREF, ProviderCapability.METADATA)
        probe = _FakeProbe(
            frozenset({crossref}),
            {crossref: _passed(ProviderName.CROSSREF)},
        )
        changed_enabled = _configuration(metadata=("arxiv",))
        changed_ordinary = parse_configuration(
            """
            [discovery]
            metadata_scan_limit = 11
            [sources.metadata]
            providers = ["crossref"]
            [sources.metadata.crossref]
            mode = "anonymous"
            """
        )
        candidates = (
            (changed_enabled, snapshot),
            (changed_ordinary, snapshot),
            (
                ordinary,
                snapshot.model_copy(update={"configuration_fingerprint": "sha256:" + "0" * 64}),
            ),
            (
                ordinary,
                snapshot.model_copy(update={"capabilities": snapshot.capabilities[:-1]}),
            ),
            (
                ordinary,
                snapshot.model_copy(
                    update={"capabilities": tuple(reversed(snapshot.capabilities))}
                ),
            ),
            (
                ordinary,
                snapshot.model_copy(
                    update={
                        "capabilities": snapshot.capabilities[:-1] + (snapshot.capabilities[0],)
                    }
                ),
            ),
        )
        for current, candidate in candidates:
            with self.subTest(candidate=repr(candidate)[:80]):
                with self.assertRaises(ConfigurationError):
                    run_configuration_probes(
                        current,  # type: ignore[arg-type]
                        probe,
                        test_all=True,
                        status_snapshot=candidate,
                    )
        self.assertEqual(probe.calls, [])

    def test_probe_failure_code_is_a_stable_token_and_bypass_is_stabilized(self) -> None:
        invalid_codes = (
            "",
            "contains spaces",
            "https://provider.invalid/private",
            _SENTINEL,
            "line\nbreak",
        )
        for code in invalid_codes:
            with self.subTest(code=repr(code)):
                with self.assertRaises(ValidationError) as caught:
                    ConfigurationProbeResult(
                        provider=ProviderName.CROSSREF,
                        capability=ProviderCapability.METADATA,
                        outcome=ProbeOutcome.FAILED,
                        local_ready=True,
                        network_reachable=False,
                        failure_code=code,
                    )
                self.assertNotIn(_SENTINEL, str(caught.exception))
                self.assertNotIn("provider.invalid", str(caught.exception))

        ordinary, snapshot = self._snapshot(metadata=("crossref",))
        key = (ProviderName.CROSSREF, ProviderCapability.METADATA)
        malicious = ConfigurationProbeResult.model_construct(
            provider=ProviderName.CROSSREF,
            capability=ProviderCapability.METADATA,
            outcome=ProbeOutcome.FAILED,
            local_ready=True,
            network_reachable=False,
            failure_code=_SENTINEL,
            acquisition_entitlement="not-proven",
        )
        probe = _FakeProbe(frozenset({key}), {key: malicious})
        summary = run_configuration_probes(
            ordinary,  # type: ignore[arg-type]
            probe,
            test_all=True,
            status_snapshot=snapshot,  # type: ignore[arg-type]
        )
        self.assertEqual(summary.results[0].failure_code, "probe-failed")
        self.assertNotIn(_SENTINEL, repr(summary))
        self.assertNotIn(_SENTINEL, summary.model_dump_json())

    def test_untrusted_typed_values_that_fail_serialization_are_fail_closed(self) -> None:
        ordinary, snapshot = self._snapshot(metadata=("crossref",))
        key = (ProviderName.CROSSREF, ProviderCapability.METADATA)
        probe = _FakeProbe(
            frozenset({key}),
            {key: _passed(ProviderName.CROSSREF)},
        )

        with mock.patch.object(
            ConfigurationProbeResult,
            "model_dump",
            side_effect=RuntimeError(_SENTINEL),
        ):
            summary = run_configuration_probes(
                ordinary,
                probe,
                test_all=True,
                status_snapshot=snapshot,
            )
        self.assertEqual(summary.results[0].failure_code, "probe-failed")
        self.assertNotIn(_SENTINEL, repr(summary))

        with mock.patch.object(
            ConfigurationStatus,
            "model_dump",
            side_effect=RuntimeError(_SENTINEL),
        ):
            with self.assertRaises(ConfigurationError) as caught:
                run_configuration_probes(
                    ordinary,
                    probe,
                    test_all=True,
                    status_snapshot=snapshot,
                )
        self.assertNotIn(_SENTINEL, str(caught.exception))
        self.assertEqual(probe.calls, [key])


if __name__ == "__main__":
    unittest.main()
