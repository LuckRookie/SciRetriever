"""Concrete authorized primary-PDF Provider clients."""

from .core import CORE_ACCESS_POLICY, CORE_ACCESS_SCOPE, CoreAuthorizedPdfClient
from .elsevier import (
    ELSEVIER_ARTICLE_ACCESS_POLICY,
    ELSEVIER_ARTICLE_ACCESS_SCOPE,
    ElsevierAuthorizedPdfClient,
)
from .wiley import WILEY_ACCESS_POLICY, WILEY_ACCESS_SCOPE, WileyAuthorizedPdfClient

__all__ = (
    "CORE_ACCESS_POLICY",
    "CORE_ACCESS_SCOPE",
    "CoreAuthorizedPdfClient",
    "ELSEVIER_ARTICLE_ACCESS_POLICY",
    "ELSEVIER_ARTICLE_ACCESS_SCOPE",
    "ElsevierAuthorizedPdfClient",
    "WILEY_ACCESS_POLICY",
    "WILEY_ACCESS_SCOPE",
    "WileyAuthorizedPdfClient",
)
