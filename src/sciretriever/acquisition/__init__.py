"""Public P4-P5 acquisition API."""

from .admission import AdmissionService, request_key_for
from .controls import CircuitBreaker, CircuitState, HostBudget, HostBudgetManager, ProviderHealth
from .manifest import read_manifest
from .models import AcquisitionProvider, AcquisitionResult, AcquisitionTarget, AdmissionResult, HttpResponse, ProviderContent
from .multi_orchestrator import MultiSourceOrchestrator
from .orchestrator import AcquisitionOrchestrator, AcquisitionRuntime
from .plan import RoutingMode, SourceEntry, SourcePlan
from .profiles import PUBLISHER_PROFILES, PublisherProfile, profile_for_provider
from .providers import ArxivProvider, CrossrefProvider, DirectHttpsProvider, EuropePmcProvider, ProviderAcquisitionError, UnpaywallProvider
from .providers_p5 import ElsevierProvider, OpenAlexProvider, SemanticScholarProvider, SpringerProvider, WileyProvider
from .routing import tiers
from .transport import UrllibAcquisitionTransport
from .url_policy import UrlPolicy
from .validation import validate_content, validate_html, validate_primary_pdf, validate_xml

__all__ = (
    "AcquisitionOrchestrator", "AcquisitionProvider", "AcquisitionResult", "AcquisitionRuntime", "AcquisitionTarget", "AdmissionResult",
    "AdmissionService", "ArxivProvider", "CircuitBreaker", "CircuitState", "CrossrefProvider", "DirectHttpsProvider",
    "ElsevierProvider", "EuropePmcProvider", "HostBudget", "HostBudgetManager", "HttpResponse", "MultiSourceOrchestrator",
    "OpenAlexProvider", "PUBLISHER_PROFILES", "ProviderAcquisitionError", "ProviderContent", "ProviderHealth",
    "PublisherProfile", "RoutingMode", "SemanticScholarProvider", "SourceEntry",
    "SourcePlan", "SpringerProvider", "UnpaywallProvider", "UrllibAcquisitionTransport", "UrlPolicy", "WileyProvider",
    "profile_for_provider", "read_manifest", "request_key_for", "tiers", "validate_content",
    "validate_html", "validate_primary_pdf", "validate_xml",
)
