"""Acquisition-only Work creation and idempotent request admission."""

from __future__ import annotations

import hashlib
import json

from sciretriever.acquisition.models import AdmissionResult, validate_provider_name
from sciretriever.catalog.assets import AssetRepository
from sciretriever.catalog.identity import IdentityResolver
from sciretriever.catalog.jobs import JobRepository
from sciretriever.core.contracts import CandidateMetadata, Identifier
from sciretriever.core.enums import AssetRole
from sciretriever.errors import AcquisitionError
from sciretriever.acquisition.plan import RoutingMode, SourceEntry, SourcePlan


def request_key_for(
    identifiers: tuple[Identifier, ...],
    provider: str,
    direct_url: str | None = None,
    asset_role: AssetRole = AssetRole.PRIMARY_PDF,
    source_plan_json: str | None = None,
) -> str:
    payload = {
        "identifiers": [item.to_dict() for item in sorted(identifiers, key=lambda item: (item.namespace, item.value))],
        "url": direct_url,
        "provider": provider,
        "role": asset_role.value,
        "source_plan": source_plan_json,
    }
    digest = hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()
    return f"acquire:{digest}"


class AdmissionService:
    def __init__(self, identity: IdentityResolver, jobs: JobRepository, assets: AssetRepository) -> None:
        self.identity = identity
        self.jobs = jobs
        self.assets = assets

    def admit(
        self,
        identifiers: tuple[Identifier, ...],
        metadata: CandidateMetadata | None = None,
        *,
        provider: str,
        asset_role: AssetRole = AssetRole.PRIMARY_PDF,
        source_plan: SourcePlan | None = None,
        direct_url: str | None = None,
        provenance: object | None = None,
    ) -> AdmissionResult:
        resolution = self.identity.create_or_reuse_work(identifiers, metadata)
        if resolution.work is None:
            raise AcquisitionError("identity resolution requires review")
        provider = validate_provider_name(provider)
        if not isinstance(asset_role, AssetRole):
            raise TypeError("asset_role must be an AssetRole")
        if source_plan is not None and source_plan.role is not asset_role:
            raise ValueError("source plan role does not match admission role")
        plan_json = None if source_plan is None else source_plan.to_json()
        key = request_key_for(identifiers, provider, direct_url, asset_role, plan_json)
        for link in self.assets.get_work_assets(resolution.work.id):
            if link.asset_role is asset_role:
                self.jobs.succeed_nonterminal_jobs_for_work(
                    resolution.work.id,
                    asset_role,
                )
                return AdmissionResult(
                    resolution.work.id,
                    None,
                    key,
                    provider,
                    asset_role,
                    link.raw_asset_id,
                )
        job = self.jobs.attach_or_create_job(
            resolution.work.id,
            asset_role,
            key,
            source_plan=(
                SourcePlan(
                    role=asset_role,
                    mode=RoutingMode.SERIAL,
                    entries=(SourceEntry("p4", provider, 0),),
                ).to_dict()
                if source_plan is None
                else source_plan.to_dict()
            ),
            request_provenance=provenance,
        )
        return AdmissionResult(resolution.work.id, job.id, key, provider, asset_role)


__all__ = ("AdmissionService", "request_key_for")
