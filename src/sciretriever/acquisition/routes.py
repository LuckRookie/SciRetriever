"""Capability-scoped route adapter and registry contracts.

The registry declares installed static capabilities.  The Planner selects
which of those capabilities apply to one Literature; readiness is therefore
checked only for selected routes, never as a global preflight over unrelated
Providers.
"""

from __future__ import annotations

from collections.abc import Iterable, Iterator
from dataclasses import dataclass, field
from typing import Protocol, runtime_checkable

from sciretriever.acquisition.access_profiles import PublisherAccessProfileCatalog
from sciretriever.acquisition.outcomes import RouteExecutionResult
from sciretriever.acquisition.planning import AccessRouteHint, RouteReadiness, RouteSpec
from sciretriever.acquisition.ports import (
    AcquisitionRequest,
    CancellationEvent,
    CandidateKeyTracker,
    TemporaryPdf,
)
from sciretriever.acquisition.routing import AcquisitionEvidence
from sciretriever.model.acquisition import AcquisitionPath
from sciretriever.model.report import StableFailure


@dataclass(frozen=True, slots=True)
class RouteInstallationStatus:
    """Secret-free static availability for one installed route capability."""

    readiness: RouteReadiness
    failure: StableFailure | None = None

    def __post_init__(self) -> None:
        if not isinstance(self.readiness, RouteReadiness):
            raise TypeError("readiness must be RouteReadiness")
        if self.failure is not None and not isinstance(self.failure, StableFailure):
            raise TypeError("failure must be StableFailure or None")
        if (self.readiness is RouteReadiness.READY) != (self.failure is None):
            raise ValueError("only a ready route may omit an installation failure")


@dataclass(frozen=True, slots=True)
class RouteExecutionContext:
    """Neutral work-item-local inputs supplied to one selected route."""

    request: AcquisitionRequest
    evidence: AcquisitionEvidence
    route_hints: tuple[AccessRouteHint, ...]
    candidate_keys: CandidateKeyTracker = field(repr=False, compare=False)
    cancel_event: CancellationEvent | None = field(default=None, repr=False, compare=False)

    def __post_init__(self) -> None:
        if not isinstance(self.request, AcquisitionRequest):
            raise TypeError("request must be AcquisitionRequest")
        if not isinstance(self.evidence, AcquisitionEvidence):
            raise TypeError("evidence must be AcquisitionEvidence")
        if not isinstance(self.route_hints, tuple) or any(
            not isinstance(hint, AccessRouteHint) for hint in self.route_hints
        ):
            raise TypeError("route_hints must contain AccessRouteHint values")
        if not isinstance(self.candidate_keys, CandidateKeyTracker):
            raise TypeError("candidate_keys must be CandidateKeyTracker")
        if self.cancel_event is not None and not isinstance(
            self.cancel_event,
            CancellationEvent,
        ):
            raise TypeError("cancel_event must implement CancellationEvent")

    def __reduce__(self) -> str | tuple[object, ...]:
        raise TypeError("RouteExecutionContext cannot be serialized")


@runtime_checkable
class PdfRouteAdapter(Protocol):
    """One installed mechanism in one fixed risk tier."""

    @property
    def source_name(self) -> str: ...

    @property
    def acquisition_path(self) -> AcquisitionPath: ...

    @property
    def route_key(self) -> str: ...

    def execute(self, context: RouteExecutionContext) -> Iterable[RouteExecutionResult]: ...


@dataclass(frozen=True, slots=True)
class RouteAdapterBinding:
    """A static route declaration and its optional production implementation."""

    spec: RouteSpec
    adapter: PdfRouteAdapter | None = field(repr=False)

    def __post_init__(self) -> None:
        if not isinstance(self.spec, RouteSpec):
            raise TypeError("spec must be RouteSpec")
        if self.adapter is not None and not isinstance(self.adapter, PdfRouteAdapter):
            raise TypeError("adapter must implement PdfRouteAdapter or be None")
        if self.spec.readiness is RouteReadiness.READY and self.adapter is None:
            raise ValueError("a ready route requires an adapter")
        if self.adapter is not None and self.adapter.route_key != self.spec.route_key:
            raise ValueError("adapter route key must match its static spec")


class AcquisitionRouteRegistry:
    """Closed Profile/capability directory with exact route lookup."""

    __slots__ = ("_catalog", "_bindings", "_by_key")

    def __init__(
        self,
        *,
        profile_catalog: PublisherAccessProfileCatalog,
        bindings: tuple[RouteAdapterBinding, ...],
    ) -> None:
        if not isinstance(profile_catalog, PublisherAccessProfileCatalog):
            raise TypeError("profile_catalog must be PublisherAccessProfileCatalog")
        if not isinstance(bindings, tuple) or any(
            not isinstance(binding, RouteAdapterBinding) for binding in bindings
        ):
            raise TypeError("bindings must contain RouteAdapterBinding values")
        keys = tuple(binding.spec.route_key for binding in bindings)
        if len(keys) != len(set(keys)):
            raise ValueError("route bindings must have unique keys")
        self._catalog = profile_catalog
        self._bindings = bindings
        self._by_key = {binding.spec.route_key: binding for binding in bindings}

    @property
    def profile_catalog(self) -> PublisherAccessProfileCatalog:
        return self._catalog

    @property
    def bindings(self) -> tuple[RouteAdapterBinding, ...]:
        return self._bindings

    @property
    def route_specs(self) -> tuple[RouteSpec, ...]:
        return tuple(binding.spec for binding in self._bindings)

    def binding_for(self, route_key: str) -> RouteAdapterBinding:
        try:
            return self._by_key[route_key]
        except (KeyError, TypeError):
            raise KeyError("route is not installed") from None


def delivery_results(
    deliveries: Iterable[TemporaryPdf],
) -> Iterator[RouteExecutionResult]:
    """Convert one lazy candidate stream into an explicit route outcome stream."""

    if not isinstance(deliveries, Iterable):
        raise TypeError("deliveries must be iterable")
    delivered = False
    iterator = iter(deliveries)
    try:
        for temporary_pdf in iterator:
            if not isinstance(temporary_pdf, TemporaryPdf):
                raise TypeError("deliveries must contain TemporaryPdf values")
            delivered = True
            yield RouteExecutionResult.delivered(temporary_pdf)
        if not delivered:
            yield RouteExecutionResult.normal_miss()
    finally:
        close = getattr(iterator, "close", None)
        if close is not None:
            if not callable(close):
                raise TypeError("delivery iterator close attribute must be callable")
            close()


__all__ = (
    "AcquisitionRouteRegistry",
    "PdfRouteAdapter",
    "RouteAdapterBinding",
    "RouteExecutionContext",
    "RouteInstallationStatus",
    "delivery_results",
)
