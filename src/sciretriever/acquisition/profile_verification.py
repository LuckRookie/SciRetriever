"""Fail-closed verification for publisher access profiles.

Publisher profiles retain routing, origin and pacing evidence for public/API
planning and explicit Browser reachability probes. They no longer reference or
install an executable Publisher click rule; page strategy belongs exclusively
to the generic Browser Agent.
"""

from __future__ import annotations

from dataclasses import dataclass

from sciretriever.acquisition.access_profiles import (
    ProfileProductionStatus,
    PublisherAccessProfileCatalog,
)


class PublisherProfileVerificationError(ValueError):
    """The publisher evidence package is internally inconsistent."""


@dataclass(frozen=True, slots=True)
class PublisherAccessVerificationMatrix:
    """A complete three-state publisher profile matrix without page programs."""

    profiles: PublisherAccessProfileCatalog

    def __post_init__(self) -> None:
        if not isinstance(self.profiles, PublisherAccessProfileCatalog):
            raise TypeError("profiles must be a PublisherAccessProfileCatalog")
        fixture_references = tuple(profile.evidence.fixture_reference for profile in self.profiles)
        if len(fixture_references) != len(set(fixture_references)):
            raise PublisherProfileVerificationError("profile-fixture-reference-duplicate")
        for profile in self.profiles:
            if not profile.browser_probe_enabled:
                continue
            if not profile.landing_origins:
                raise PublisherProfileVerificationError("profile-browser-landing-origin-missing")

    @property
    def production_profiles(self) -> PublisherAccessProfileCatalog:
        """Return only independently production-ready profiles."""

        return PublisherAccessProfileCatalog(
            tuple(
                profile
                for profile in self.profiles
                if profile.production_status is ProfileProductionStatus.PRODUCTION_READY
            )
        )


__all__ = (
    "PublisherAccessVerificationMatrix",
    "PublisherProfileVerificationError",
)
