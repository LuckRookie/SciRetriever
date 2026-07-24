"""Public WorkVersion acquisition API."""

from .controls import CircuitBreaker, CircuitState, HostBudget, HostBudgetManager, ProviderHealth
from .manifest import read_manifest
from .models import AcquisitionResult, AcquisitionTarget, HttpResponse, ProviderContent
from .service import WorkVersionAcquisitionService
from .profiles import PUBLISHER_PROFILES, PublisherProfile, profile_for_provider
from .providers import (
    ArxivResolver, CrossrefResolver, DirectHttpsResolver, EuropePmcResolver,
    OpenAlexResolver, ProviderAcquisitionError, SemanticScholarResolver,
    UnpaywallResolver,
)
from .providers_p5 import ElsevierResolver, SpringerResolver, WileyResolver
from .transport import UrllibAcquisitionTransport
from .url_policy import UrlPolicy
from .validation import validate_content, validate_html, validate_primary_pdf, validate_xml

__all__ = (
    "AcquisitionResult", "AcquisitionTarget", "ArxivResolver", "CircuitBreaker",
    "CircuitState", "CrossrefResolver", "DirectHttpsResolver", "ElsevierResolver",
    "EuropePmcResolver", "HostBudget", "HostBudgetManager", "HttpResponse",
    "OpenAlexResolver", "PUBLISHER_PROFILES", "ProviderAcquisitionError", "ProviderContent",
    "ProviderHealth", "PublisherProfile", "SemanticScholarResolver", "SpringerResolver",
    "UnpaywallResolver", "UrllibAcquisitionTransport", "UrlPolicy", "WileyResolver",
    "WorkVersionAcquisitionService", "profile_for_provider", "read_manifest", "validate_content",
    "validate_html", "validate_primary_pdf", "validate_xml",
)
