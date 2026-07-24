from __future__ import annotations

from enum import Enum
from urllib.error import HTTPError, URLError


class SciRetrieverError(Exception):
    """Base exception for SciRetriever errors."""


class ConfigError(SciRetrieverError):
    """Raised when SciRetriever configuration is invalid."""


class SearchError(SciRetrieverError):
    """Raised when literature search fails."""


class ProviderErrorCategory(str, Enum):
    """Stable categories for provider discovery failures."""

    AUTHENTICATION = "authentication"
    CONFIGURATION = "configuration"
    RATE_LIMIT = "rate_limit"
    TRANSPORT = "transport"
    CLIENT = "client"
    SERVER = "server"
    INVALID_RESPONSE = "invalid_response"


class ProviderSearchError(SearchError):
    """A classified failure raised while searching one provider."""

    def __init__(
        self,
        provider: str,
        category: ProviderErrorCategory,
        message: str,
        *,
        retryable: bool,
        status: int | None = None,
    ) -> None:
        if not isinstance(provider, str) or not provider.strip():
            raise ValueError("provider must be a non-blank string")
        if not isinstance(category, ProviderErrorCategory):
            raise TypeError("category must be ProviderErrorCategory")
        if not isinstance(retryable, bool):
            raise TypeError("retryable must be a boolean")
        if status is not None and (not isinstance(status, int) or isinstance(status, bool)):
            raise TypeError("status must be an integer or None")
        super().__init__(message)
        self.provider = provider
        self.category = category
        self.retryable = retryable
        self.status = status

    @classmethod
    def for_http_status(
        cls,
        provider: str,
        status: int,
        message: str | None = None,
    ) -> ProviderSearchError:
        category, retryable = classify_provider_http_status(status)
        detail = message or f"{provider} search returned HTTP {status}"
        return cls(provider, category, detail, retryable=retryable, status=status)

    @classmethod
    def for_transport(cls, provider: str, message: str) -> ProviderSearchError:
        return cls(
            provider,
            ProviderErrorCategory.TRANSPORT,
            message,
            retryable=True,
        )

    @classmethod
    def for_configuration(cls, provider: str, message: str) -> ProviderSearchError:
        return cls(
            provider,
            ProviderErrorCategory.CONFIGURATION,
            message,
            retryable=False,
        )

    @classmethod
    def for_exception(cls, provider: str, cause: BaseException) -> ProviderSearchError:
        """Map a urllib or operating-system transport failure."""

        if isinstance(cause, HTTPError):
            return cls.for_http_status(provider, cause.code, str(cause))
        if isinstance(cause, (URLError, OSError)):
            return cls.for_transport(provider, f"{provider} search transport failed: {cause}")
        raise TypeError(f"unsupported provider search cause: {type(cause).__name__}")

    @classmethod
    def for_invalid_response(cls, provider: str, message: str) -> ProviderSearchError:
        return cls(
            provider,
            ProviderErrorCategory.INVALID_RESPONSE,
            message,
            retryable=False,
        )


def classify_provider_http_status(status: int) -> tuple[ProviderErrorCategory, bool]:
    """Return the stable category and retry policy for an HTTP failure."""

    if not isinstance(status, int) or isinstance(status, bool):
        raise TypeError("HTTP status must be an integer")
    if status in {401, 403}:
        return ProviderErrorCategory.AUTHENTICATION, False
    if status == 429:
        return ProviderErrorCategory.RATE_LIMIT, True
    if status in {408, 425}:
        return ProviderErrorCategory.TRANSPORT, True
    if 300 <= status < 500:
        return ProviderErrorCategory.CLIENT, False
    if 500 <= status < 600:
        return ProviderErrorCategory.SERVER, True
    raise ValueError(f"HTTP status is not an error response: {status}")


class DownloadError(SciRetrieverError):
    """Raised when an asset download fails."""


class RetryError(SciRetrieverError):
    """Raised when retry handling fails."""


class RateLimitError(SciRetrieverError):
    """Raised when a provider rate limit prevents an operation."""


class AuthenticationError(SciRetrieverError):
    """Raised when provider authentication fails."""


class ParseError(SciRetrieverError):
    """Raised when content cannot be parsed."""


class ValidationError(SciRetrieverError):
    """Raised when neutral data validation fails."""


class AcquisitionError(SciRetrieverError):
    """Raised when literature acquisition fails."""


class NormalizationError(SciRetrieverError):
    """Raised when content normalization fails."""


class AnalysisError(SciRetrieverError):
    """Raised when full-text analysis cannot be validated or completed."""


class MinerUErrorCategory(str, Enum):
    CONFIGURATION = "configuration"
    AUTHENTICATION = "authentication"
    TRANSPORT = "transport"
    PROTOCOL = "protocol"
    REMOTE_FAILED = "remote_failed"
    TIMEOUT = "timeout"
    ARCHIVE_REJECTED = "archive_rejected"
    INTERRUPTED = "interrupted"


class MinerUError(NormalizationError):
    """Stable, redacted MinerU connector failure."""

    def __init__(self, category: MinerUErrorCategory, message: str, *, retryable: bool = False) -> None:
        super().__init__(message)
        self.category = category
        self.retryable = retryable


class PackagingError(SciRetrieverError):
    """Raised when package creation or validation fails."""


class CatalogError(SciRetrieverError):
    """Raised when a catalog operation fails."""


class StorageError(SciRetrieverError):
    """Raised when immutable filesystem storage cannot complete an operation."""


class DurabilityError(StorageError):
    """Raised when storage durability cannot be confirmed."""


class StoragePathError(StorageError):
    """Raised when a storage path is unsafe or outside the managed layout."""


class StorageConflictError(StorageError):
    """Raised when a managed path conflicts with an existing entry."""


class StorageCorruptionError(StorageError):
    """Raised when stored bytes do not match their immutable record."""


class CrossDeviceStorageError(StorageError):
    """Raised when hard-link publication would cross filesystems."""
