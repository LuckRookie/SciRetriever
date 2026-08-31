"""Public SciRetriever production object-graph assembly surface.

The package is split internally by change reason so Browser runtime assembly,
graph contracts, configuration probes, storage lifecycle, and production
orchestration can evolve independently.  Callers continue to import
:mod:`sciretriever.bootstrap`; the package layout is a code-governance detail,
not a separate product module.
"""

from sciretriever.bootstrap.assembly import (
    build_object_graph,
    build_production_object_graph,
)
from sciretriever.bootstrap.browser import (
    PRODUCTION_BROWSER_CONFIGURATION_PROBE_ACCESS_KEYS,
)
from sciretriever.bootstrap.errors import BootstrapError
from sciretriever.bootstrap.graphs import (
    ApplicationObjectGraph,
    BibliographyExchangeObjectGraph,
    BootstrapExternalDependencies,
    CitationDiscoveryObjectGraph,
    DatabaseCompletionObjectGraph,
    LocalLibraryObjectGraph,
    ManualPdfObjectGraph,
    ProductionEntryScope,
    TopicDiscoveryObjectGraph,
)
from sciretriever.bootstrap.probes import (
    ProductionConfigurationProbeSession,
    build_production_configuration_probe_session,
    fetch_agent_models,
)

__all__ = (
    "ApplicationObjectGraph",
    "BibliographyExchangeObjectGraph",
    "BootstrapError",
    "BootstrapExternalDependencies",
    "CitationDiscoveryObjectGraph",
    "DatabaseCompletionObjectGraph",
    "LocalLibraryObjectGraph",
    "ManualPdfObjectGraph",
    "ProductionConfigurationProbeSession",
    "PRODUCTION_BROWSER_CONFIGURATION_PROBE_ACCESS_KEYS",
    "ProductionEntryScope",
    "TopicDiscoveryObjectGraph",
    "build_object_graph",
    "build_production_configuration_probe_session",
    "build_production_object_graph",
    "fetch_agent_models",
)
