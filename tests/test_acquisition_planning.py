from __future__ import annotations

import pickle
import unittest

from sciretriever.acquisition.access_profiles import (
    BrowserRuleSet,
    PolicyEvidence,
    ProfileProductionStatus,
    PublisherAccessProfile,
    PublisherAccessProfileCatalog,
)
from sciretriever.acquisition.outcomes import RouteExecutionResult, RouteOutcome
from sciretriever.acquisition.planning import (
    AccessRouteHint,
    AccessRouteHintKind,
    AcquisitionPlanBuilder,
    DoiLandingResolution,
    DoiResolutionState,
    ProgressiveAcquisitionPlanner,
    PublisherAccessResolver,
    ResolutionEvidence,
    ResolutionEvidenceKind,
    RouteCapability,
    RouteReadiness,
    RouteSpec,
    build_resolution_evidence,
)
from sciretriever.acquisition.ports import (
    AcquisitionExpectedFacts,
    AcquisitionRequest,
)
from sciretriever.acquisition.routing import build_acquisition_evidence
from sciretriever.literature.content import metadata_sha256
from sciretriever.model.acquisition import AcquisitionPath, AssetHint, AssetHintKind
from sciretriever.model.literature import (
    Identifier,
    Literature,
    LiteratureStatus,
    VersionRole,
)
from sciretriever.model.metadata import LiteratureMetadata, MetadataObservation
from sciretriever.model.primitives import (
    LiteratureId,
    MetaLiteratureId,
    ObservationId,
    ProvenanceId,
    Sha256,
    SourceKind,
    UtcTimestamp,
)
from sciretriever.model.provenance import Provenance
from sciretriever.model.report import StableFailure
from sciretriever.network.browser_scheduler import BrowserGroupPolicy


def _id(index: int) -> str:
    return f"{index:08x}-e89b-12d3-a456-426614174000"


def _profile(
    access_key: str,
    origin: str,
    *,
    doi_prefix: str,
    provider_name: str,
) -> PublisherAccessProfile:
    return PublisherAccessProfile(
        access_key=access_key,
        platform_key=access_key,
        landing_origins=(origin,),
        asset_origins=(origin,),
        stable_locator_namespaces=(f"{provider_name}-id",),
        provider_record_names=(provider_name,),
        weak_doi_prefixes=(doi_prefix,),
        weak_publisher_names=(provider_name,),
        public_route_keys=(f"public:{provider_name}",),
        api_route_keys=(f"api:{provider_name}",),
        browser_route_key=f"browser:{provider_name}",
        browser_allowed_origins=(origin,),
        browser_rate_limit_group=access_key,
        browser_session_key=access_key,
        policy_evidence=PolicyEvidence.PROJECT_CONSERVATIVE,
        policy_revision="2026-08-15",
        notes_reference=f"docs/notes/providers/{provider_name}.md",
        production_status=ProfileProductionStatus.FIXTURE_VERIFIED,
        browser_policy=BrowserGroupPolicy(
            rate_limit_group=access_key,
            policy_revision="2026-08-15",
            minimum_start_interval=10.0,
            rate_limit_cooldown=60.0,
            runtime_failure_threshold=3,
        ),
        browser_rules=BrowserRuleSet(primary_pdf_url_markers=("/pdf/",)),
    )


def _catalog() -> PublisherAccessProfileCatalog:
    return PublisherAccessProfileCatalog(
        (
            _profile(
                "wiley-online-library",
                "https://onlinelibrary.wiley.com",
                doi_prefix="10.1002",
                provider_name="wiley",
            ),
            _profile(
                "elsevier-sciencedirect",
                "https://www.sciencedirect.com",
                doi_prefix="10.1016",
                provider_name="elsevier",
            ),
        )
    )


def _request(
    *,
    doi: str = "10.1002/example",
    publisher: str = "Wiley",
    resolved_origin: str | None = None,
    observations: tuple[MetadataObservation, ...] = (),
) -> AcquisitionRequest:
    literature = Literature(
        literature_id=LiteratureId(_id(1)),
        meta_literature_id=MetaLiteratureId(_id(2)),
        version_role=VersionRole.PUBLISHED,
        metadata=LiteratureMetadata(
            title="A paper",
            publisher=publisher,
            identifiers=(Identifier(namespace="doi", value=doi),),
        ),
        status=LiteratureStatus.UNREVIEWED,
    )
    return AcquisitionRequest(
        literature=literature,
        expected_facts=AcquisitionExpectedFacts(
            literature_id=literature.literature_id,
            meta_literature_id=literature.meta_literature_id,
            metadata_revision=1,
            metadata_sha256=metadata_sha256(literature.metadata),
            expected_no_primary_pdf=True,
        ),
        observations=observations,
        resolved_landing_origin=resolved_origin,
    )


def _observation(
    *,
    provider_name: str,
    asset_url: str | None = None,
) -> MetadataObservation:
    return MetadataObservation(
        observation_id=ObservationId(_id(3)),
        provenance=Provenance(
            provenance_id=ProvenanceId(_id(4)),
            source_kind=SourceKind.METADATA_PROVIDER,
            source_name=provider_name,
            source_record_id="record-1",
            observed_at=UtcTimestamp("2026-08-15T00:00:00Z"),
            input_sha256=Sha256("a" * 64),
            parameters_sha256=None,
        ),
        metadata=LiteratureMetadata(title="Observed paper"),
        asset_hints=(
            ()
            if asset_url is None
            else (AssetHint(url=asset_url, kind=AssetHintKind.LANDING_PAGE),)
        ),
    )


class _DoiResolver:
    def __init__(self, result: DoiLandingResolution | None) -> None:
        self.result = result
        self.calls: list[Identifier] = []

    def resolve(self, doi: Identifier) -> DoiLandingResolution | None:
        self.calls.append(doi)
        return self.result


class PublisherResolutionTests(unittest.TestCase):
    def test_actual_landing_wins_over_lower_priority_conflicting_asset_origin(self) -> None:
        request = _request(
            resolved_origin="https://onlinelibrary.wiley.com",
            observations=(
                _observation(
                    provider_name="scopus",
                    asset_url="https://www.sciencedirect.com/science/article/pii/example",
                ),
            ),
        )
        evidence = build_resolution_evidence(build_acquisition_evidence(request))
        resolution = PublisherAccessResolver(_catalog()).resolve(evidence)

        self.assertEqual(evidence[0].kind, ResolutionEvidenceKind.LANDING_ORIGIN)
        self.assertEqual(resolution.access_key, "wiley-online-library")
        self.assertEqual(
            resolution.selected_evidence_kind,
            ResolutionEvidenceKind.LANDING_ORIGIN,
        )

    def test_metadata_aggregator_identity_and_weak_text_do_not_prove_access_provider(
        self,
    ) -> None:
        request = _request(observations=(_observation(provider_name="scopus"),))
        resolution = PublisherAccessResolver(_catalog()).resolve(
            build_resolution_evidence(build_acquisition_evidence(request))
        )

        self.assertIsNone(resolution.access_key)
        self.assertEqual(resolution.weak_candidate_keys, ("wiley-online-library",))

    def test_equal_priority_conflict_is_unresolved_instead_of_catalog_order(self) -> None:
        resolver = PublisherAccessResolver(_catalog())
        resolution = resolver.resolve(
            (
                ResolutionEvidence(
                    kind=ResolutionEvidenceKind.ASSET_ORIGIN,
                    value="https://onlinelibrary.wiley.com",
                    source="asset-hint",
                ),
                ResolutionEvidence(
                    kind=ResolutionEvidenceKind.ASSET_ORIGIN,
                    value="https://www.sciencedirect.com",
                    source="asset-hint",
                ),
            )
        )

        self.assertIsNone(resolution.access_key)
        self.assertTrue(resolution.conflicted)
        self.assertEqual(
            resolution.conflict_keys,
            ("elsevier-sciencedirect", "wiley-online-library"),
        )


class ProgressivePlanningTests(unittest.TestCase):
    def _route_specs(self) -> tuple[RouteSpec, ...]:
        return (
            RouteSpec(
                route_key="public:direct",
                tier=AcquisitionPath.PUBLIC,
                capability=RouteCapability.DIRECT_PDF,
                readiness=RouteReadiness.READY,
            ),
            RouteSpec(
                route_key="api:wiley",
                tier=AcquisitionPath.AUTHORIZED_PROVIDER_API,
                capability=RouteCapability.DIRECT_PDF,
                readiness=RouteReadiness.READY,
                profile_access_key="wiley-online-library",
                quota_group="wiley-tdm",
            ),
            RouteSpec(
                route_key="browser:wiley",
                tier=AcquisitionPath.CONTROLLED_BROWSER,
                capability=RouteCapability.BROWSER_PDF,
                readiness=RouteReadiness.READY,
                profile_access_key="wiley-online-library",
                risk_group="wiley-online-library",
            ),
        )

    def test_doi_resolution_is_explicit_once_and_replans_all_later_tiers(self) -> None:
        catalog = _catalog()
        doi = _DoiResolver(
            DoiLandingResolution("https://onlinelibrary.wiley.com/doi/10.1002/example")
        )
        planner = ProgressiveAcquisitionPlanner(
            resolver=PublisherAccessResolver(catalog),
            builder=AcquisitionPlanBuilder(catalog),
            route_specs=self._route_specs(),
            doi_landing_resolver=doi,
        )

        initial = planner.start(_request())
        resolved = planner.resolve_doi_landing(initial)
        repeated = planner.resolve_doi_landing(resolved)

        self.assertEqual(initial.doi_resolution_state, DoiResolutionState.ELIGIBLE)
        self.assertEqual(
            tuple(route.route_key for route in initial.plan.routes), ("public:direct",)
        )
        self.assertEqual(resolved.doi_resolution_state, DoiResolutionState.COMPLETED)
        self.assertEqual(resolved.resolution.access_key, "wiley-online-library")
        self.assertEqual(
            tuple(route.route_key for route in resolved.plan.routes),
            ("public:direct", "api:wiley", "browser:wiley"),
        )
        self.assertIs(repeated, resolved)
        self.assertEqual(len(doi.calls), 1)

    def test_strong_local_evidence_and_no_provider_routes_skip_doi_io(self) -> None:
        catalog = _catalog()
        doi = _DoiResolver(None)
        local = ProgressiveAcquisitionPlanner(
            resolver=PublisherAccessResolver(catalog),
            builder=AcquisitionPlanBuilder(catalog),
            route_specs=self._route_specs(),
            doi_landing_resolver=doi,
        ).start(_request(resolved_origin="https://onlinelibrary.wiley.com"))
        public_only = ProgressiveAcquisitionPlanner(
            resolver=PublisherAccessResolver(catalog),
            builder=AcquisitionPlanBuilder(catalog),
            route_specs=self._route_specs()[:1],
            doi_landing_resolver=doi,
        ).start(_request())

        self.assertEqual(local.doi_resolution_state, DoiResolutionState.NOT_NEEDED)
        self.assertEqual(public_only.doi_resolution_state, DoiResolutionState.NOT_NEEDED)
        self.assertEqual(doi.calls, [])


class RuntimeOutcomeSafetyTests(unittest.TestCase):
    def test_hints_are_closed_redacted_and_not_serializable(self) -> None:
        hint = AccessRouteHint(
            kind=AccessRouteHintKind.CANONICAL_LANDING,
            value="https://onlinelibrary.wiley.com/doi/10.1002/example",
            source_route_key="api:wiley",
            profile_access_key="wiley-online-library",
        )
        result = RouteExecutionResult.hints_only(hint)

        self.assertEqual(result.outcome, RouteOutcome.HINTS)
        self.assertNotIn("10.1002/example", repr(hint))
        with self.assertRaises(TypeError):
            pickle.dumps(hint)
        with self.assertRaises(TypeError):
            pickle.dumps(result)
        with self.assertRaises(ValueError):
            AccessRouteHint(
                kind=AccessRouteHintKind.PDF_OBJECT_LOCATOR,
                value="https://download.example.test/file.pdf?signature=private",
                source_route_key="api:wiley",
                profile_access_key="wiley-online-library",
            )

    def test_outcomes_cannot_mix_normal_exhaustion_with_failures_or_hints(self) -> None:
        failure = StableFailure(
            code="provider-temporarily-unavailable",
            reason="The Provider is temporarily unavailable.",
            action="Retry later.",
            retryable=True,
        )
        self.assertEqual(RouteExecutionResult.normal_miss().outcome, RouteOutcome.NORMAL_MISS)
        self.assertEqual(RouteExecutionResult.deferred(failure).outcome, RouteOutcome.DEFERRED)
        with self.assertRaises(ValueError):
            RouteExecutionResult(outcome=RouteOutcome.NORMAL_MISS, failure=failure)
        with self.assertRaises(ValueError):
            RouteExecutionResult(outcome=RouteOutcome.HINTS)


if __name__ == "__main__":
    unittest.main()
