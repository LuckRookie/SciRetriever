"""Provider-specific declarations for controlled Browser acquisition."""

from .acs import ACS_BROWSER_RULE
from .aip import AIP_BROWSER_RULE
from .elsevier import ELSEVIER_BROWSER_RULE
from .iop import IOPSCIENCE_BROWSER_RULE
from .oxford import OXFORD_ACADEMIC_BROWSER_RULE
from .rsc import RSC_BROWSER_RULE
from .science import SCIENCE_BROWSER_RULE
from .springer import SPRINGERLINK_BROWSER_RULE
from .wiley import WILEY_BROWSER_RULE

__all__ = (
    "ACS_BROWSER_RULE",
    "AIP_BROWSER_RULE",
    "ELSEVIER_BROWSER_RULE",
    "IOPSCIENCE_BROWSER_RULE",
    "OXFORD_ACADEMIC_BROWSER_RULE",
    "RSC_BROWSER_RULE",
    "SCIENCE_BROWSER_RULE",
    "SPRINGERLINK_BROWSER_RULE",
    "WILEY_BROWSER_RULE",
)
