"""Concrete authorized primary-PDF Provider clients."""

from .core import CORE_ACCESS_POLICY, CORE_ACCESS_SCOPE, CoreAuthorizedPdfClient
from .wiley import WILEY_ACCESS_POLICY, WILEY_ACCESS_SCOPE, WileyAuthorizedPdfClient

__all__ = (
    "CORE_ACCESS_POLICY",
    "CORE_ACCESS_SCOPE",
    "CoreAuthorizedPdfClient",
    "WILEY_ACCESS_POLICY",
    "WILEY_ACCESS_SCOPE",
    "WileyAuthorizedPdfClient",
)
