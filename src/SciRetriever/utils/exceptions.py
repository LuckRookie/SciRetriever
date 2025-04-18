"""
Custom exceptions for SciRetriever.
"""


class SciRetrieverError(Exception):
    """Base exception for all SciRetriever errors."""
    pass


class SearchError(SciRetrieverError):
    """Raised when there is an error searching for papers."""
    pass


class DownloadError(SciRetrieverError):
    """Raised when there is an error downloading a paper."""
    pass


class DatabaseError(SciRetrieverError):
    """Raised when there is a database-related error."""
    pass


class RateLimitError(SciRetrieverError):
    """Raised when a rate limit is exceeded."""
    pass


class AuthenticationError(SciRetrieverError):
    """Raised when there is an authentication error."""
    pass


class ParseError(SciRetrieverError):
    """Raised when there is an error parsing a response."""
    pass


class TaggingError(SciRetrieverError):
    """Raised when there is an error tagging papers."""
    pass


class ExportError(SciRetrieverError):
    """Raised when there is an error exporting data."""
    pass


class ConfigError(SciRetrieverError):
    """Raised when there is a configuration error."""
    pass