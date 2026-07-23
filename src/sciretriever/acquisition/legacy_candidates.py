"""Internal single-candidate boundary for the public legacy provider protocol."""

from __future__ import annotations

from dataclasses import dataclass

from sciretriever.acquisition.candidates import RuntimeDownloadCandidate, make_download_candidate_id
from sciretriever.acquisition.models import AcquisitionProvider, AcquisitionTarget, ProviderContent
from sciretriever.acquisition.plan import SourceEntry
from sciretriever.core.enums import AssetRole


_RESOLVER_ID = "legacy_single"
_CURSOR = "rc1:legacy-0"


@dataclass(frozen=True, slots=True)
class LegacyCandidateOperation:
    """Opaque runtime operation; provider credentials and transport remain provider-owned."""

    provider: AcquisitionProvider
    target: AcquisitionTarget

    def run(self, timeout: float) -> ProviderContent:
        return self.provider.acquire(self.target, timeout=timeout)


class LegacySingleCandidateResolver:
    resolver_id = _RESOLVER_ID

    def __init__(self, provider: AcquisitionProvider) -> None:
        self._provider = provider

    def resolve(
        self,
        target: AcquisitionTarget,
        source: SourceEntry,
        role: AssetRole,
    ) -> tuple[RuntimeDownloadCandidate, ...]:
        initial_url = self._provider.initial_url(target)
        candidate = RuntimeDownloadCandidate(
            download_candidate_id=make_download_candidate_id(
                source.candidate_id, self.resolver_id, role, _CURSOR
            ),
            source_candidate_id=source.candidate_id,
            resolver_id=self.resolver_id,
            provider=source.provider,
            resolver_cursor=_CURSOR,
            execution_url=initial_url,
            role=role,
            priority=0,
            transport="legacy_opaque",
            access_method="provider",
            redacted_url_identity=f"provider:{source.provider}",
            sanitized_provenance={"resolver": self.resolver_id},
        )
        return (candidate,)

    def operation_for(
        self,
        candidate: RuntimeDownloadCandidate,
        target: AcquisitionTarget,
    ) -> LegacyCandidateOperation:
        if candidate.resolver_id != self.resolver_id or candidate.provider != self._provider.name:
            raise ValueError("candidate does not belong to this legacy resolver")
        return LegacyCandidateOperation(self._provider, target)


__all__ = ()
