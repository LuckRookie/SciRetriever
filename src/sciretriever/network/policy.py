"""Pure URL, destination, redirect, budget, and redaction policy.

This module deliberately has no DNS, socket, HTTP, browser, provider, or
logging dependency.  Callers provide a resolver and invoke the same pure
checks before each connection, redirect, navigation, popup, or download.
"""

from __future__ import annotations

import ipaddress
import re
import unicodedata
from dataclasses import dataclass
from enum import Enum
from typing import Callable, Iterable, Mapping, NoReturn, Protocol, Sequence
from urllib.parse import parse_qsl, quote, unquote_to_bytes, urljoin, urlsplit, urlunsplit

from sciretriever.model.access import has_sensitive_query_parameter

_DEFAULT_SCHEMES = frozenset({"https"})
_DEFAULT_PORTS = {"http": 80, "https": 443}
_DNS_LABEL = re.compile(r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?", re.ASCII)
_HEX = frozenset("0123456789abcdefABCDEF")
_LEGACY_IPV4_SHAPE = re.compile(r"[0-9A-Fa-fxX.]+", re.ASCII)
_CONTROL = re.compile(r"[\x00-\x1f\x7f-\x9f]")
_OPAQUE_PATH_PARAMETER_SAFE = "-._~!$&'()*+,;=:@"
_OPAQUE_PATH_SUFFIX = re.compile(r"[A-Za-z0-9._~-]+", re.ASCII)
_RESERVED_NETWORKS: tuple[ipaddress.IPv4Network | ipaddress.IPv6Network, ...] = (
    ipaddress.ip_network("100.64.0.0/10"),
    ipaddress.ip_network("192.0.0.0/24"),
    ipaddress.ip_network("192.0.2.0/24"),
    ipaddress.ip_network("198.18.0.0/15"),
    ipaddress.ip_network("198.51.100.0/24"),
    ipaddress.ip_network("203.0.113.0/24"),
    ipaddress.ip_network("2001:db8::/32"),
)


class PolicyError(ValueError):
    """Stable, secret-free error at the Network policy boundary."""

    _MESSAGES = frozenset(
        {
            "network policy rejected input",
            "network destination is not allowed",
            "network DNS resolution failed",
            "network destination changed during recheck",
            "network budget exceeded",
        }
    )

    def __init__(self, message: str = "network policy rejected input") -> None:
        super().__init__(message if message in self._MESSAGES else "network policy rejected input")


def _fail(message: str = "network policy rejected input") -> NoReturn:
    raise PolicyError(message)


def _default_port_pairs(schemes: frozenset[str]) -> frozenset[tuple[str, int]]:
    return frozenset((scheme, _DEFAULT_PORTS[scheme]) for scheme in schemes)


def _normalise_port_pair(
    value: object,
    *,
    allowed_schemes: frozenset[str],
) -> tuple[str, int]:
    if type(value) is not tuple or len(value) != 2:
        _fail()
    scheme, port = value
    if type(scheme) is not str or type(port) is not int:
        _fail()
    canonical_scheme = scheme.casefold()
    if canonical_scheme not in allowed_schemes or not 1 <= port <= 65535:
        _fail()
    return canonical_scheme, port


def _normalise_ports(
    value: Iterable[tuple[str, int]] | None,
    *,
    allowed_schemes: frozenset[str],
    empty_means_default: bool = False,
) -> frozenset[tuple[str, int]]:
    if not allowed_schemes or not allowed_schemes <= frozenset(_DEFAULT_PORTS):
        _fail()
    if value is None:
        return _default_port_pairs(allowed_schemes)
    try:
        pairs = tuple(value)
    except TypeError:
        _fail()
    if not pairs:
        if empty_means_default:
            return _default_port_pairs(allowed_schemes)
        _fail()
    result = {_normalise_port_pair(pair, allowed_schemes=allowed_schemes) for pair in pairs}
    if not result:
        _fail()
    return frozenset(result)


def _render_authority(scheme: str, hostname: str, port: int) -> str:
    host = f"[{hostname}]" if ":" in hostname else hostname
    default_port = _DEFAULT_PORTS.get(scheme)
    suffix = "" if default_port == port else f":{port}"
    return host + suffix


class AddressClass(str, Enum):
    PUBLIC = "public"
    PRIVATE = "private"
    LOOPBACK = "loopback"
    LINK_LOCAL = "link-local"
    MULTICAST = "multicast"
    UNSPECIFIED = "unspecified"
    RESERVED = "reserved"


@dataclass(frozen=True, slots=True)
class Origin:
    scheme: str
    hostname: str
    port: int

    @property
    def text(self) -> str:
        return f"{self.scheme}://{_render_authority(self.scheme, self.hostname, self.port)}"


@dataclass(frozen=True, slots=True)
class NormalizedURL:
    url: str
    scheme: str
    hostname: str
    port: int
    path: str
    query: str

    @property
    def host(self) -> str:
        return self.hostname

    @property
    def origin(self) -> Origin:
        return Origin(self.scheme, self.hostname, self.port)


@dataclass(frozen=True, slots=True)
class DestinationPolicy:
    """Explicit destination constraints supplied by an operator/adapter.

    The URL itself cannot widen any of these sets.  The default only permits
    HTTPS destinations resolving exclusively to public addresses.
    """

    allowed_schemes: frozenset[str] = _DEFAULT_SCHEMES
    allowed_classes: frozenset[AddressClass] = frozenset({AddressClass.PUBLIC})
    allowed_addresses: frozenset[str] = frozenset()
    allowed_origins: frozenset[Origin] = frozenset()
    allowed_ports: frozenset[tuple[str, int]] = frozenset()

    def __post_init__(self) -> None:
        try:
            schemes = frozenset(
                value.casefold() for value in self.allowed_schemes if type(value) is str
            )
            classes = frozenset(
                value if isinstance(value, AddressClass) else AddressClass(value)
                for value in self.allowed_classes
            )
            addresses = frozenset(_canonical_address(value) for value in self.allowed_addresses)
            origins = frozenset(self.allowed_origins)
            ports = _normalise_ports(
                self.allowed_ports,
                allowed_schemes=schemes,
                empty_means_default=True,
            )
        except (TypeError, ValueError):
            _fail()
        if not schemes or not schemes <= frozenset(_DEFAULT_PORTS):
            _fail()
        if not classes:
            _fail()
        if any(value is not AddressClass.PUBLIC for value in classes) and not addresses:
            _fail()
        if any(not isinstance(value, Origin) for value in origins):
            _fail()
        for origin in origins:
            try:
                canonical_origin = normalize_url(
                    origin.text,
                    allowed_schemes=schemes,
                    allowed_ports=ports,
                ).origin
            except (PolicyError, TypeError, ValueError):
                _fail()
            if canonical_origin != origin:
                _fail()
        object.__setattr__(self, "allowed_schemes", schemes)
        object.__setattr__(self, "allowed_classes", classes)
        object.__setattr__(self, "allowed_addresses", addresses)
        object.__setattr__(self, "allowed_origins", origins)
        object.__setattr__(self, "allowed_ports", ports)


@dataclass(frozen=True, slots=True)
class ResolvedDestination:
    url: NormalizedURL
    addresses: tuple[str, ...]
    classes: tuple[AddressClass, ...]

    @property
    def origin(self) -> Origin:
        return self.url.origin

    @property
    def hostname(self) -> str:
        return self.url.hostname


@dataclass(frozen=True, slots=True)
class RedirectDecision:
    source: ResolvedDestination
    destination: ResolvedDestination
    same_origin: bool
    forward_credentials: bool


@dataclass(frozen=True, slots=True)
class BudgetUsage:
    response_bytes: int = 0
    navigations: int = 0
    downloads: int = 0
    elapsed_seconds: float = 0.0

    def __post_init__(self) -> None:
        if type(self.response_bytes) is not int or self.response_bytes < 0:
            _fail()
        if type(self.navigations) is not int or self.navigations < 0:
            _fail()
        if type(self.downloads) is not int or self.downloads < 0:
            _fail()
        if type(self.elapsed_seconds) is not float or self.elapsed_seconds < 0:
            _fail()


@dataclass(frozen=True, slots=True)
class ResourceBudget:
    """Protocol-neutral response/navigation/download/time limits."""

    max_response_bytes: int | None = None
    max_navigations: int | None = None
    max_downloads: int | None = None
    max_total_seconds: float | None = None

    def __post_init__(self) -> None:
        for value in (
            self.max_response_bytes,
            self.max_navigations,
            self.max_downloads,
        ):
            if value is not None and (type(value) is not int or value <= 0):
                _fail()
        if self.max_total_seconds is not None and (
            type(self.max_total_seconds) is not float or self.max_total_seconds <= 0
        ):
            _fail()

    def consume(
        self,
        *,
        response_bytes: int = 0,
        navigations: int = 0,
        downloads: int = 0,
        elapsed_seconds: float = 0.0,
        usage: BudgetUsage | None = None,
    ) -> BudgetUsage:
        prior = BudgetUsage() if usage is None else usage
        if not isinstance(prior, BudgetUsage):
            _fail()
        if type(response_bytes) is not int or response_bytes < 0:
            _fail()
        if type(navigations) is not int or navigations < 0:
            _fail()
        if type(downloads) is not int or downloads < 0:
            _fail()
        if type(elapsed_seconds) is not float or elapsed_seconds < 0:
            _fail()
        result = BudgetUsage(
            response_bytes=prior.response_bytes + response_bytes,
            navigations=prior.navigations + navigations,
            downloads=prior.downloads + downloads,
            elapsed_seconds=prior.elapsed_seconds + elapsed_seconds,
        )
        if self.max_response_bytes is not None and result.response_bytes > self.max_response_bytes:
            _fail("network budget exceeded")
        if self.max_navigations is not None and result.navigations > self.max_navigations:
            _fail("network budget exceeded")
        if self.max_downloads is not None and result.downloads > self.max_downloads:
            _fail("network budget exceeded")
        if self.max_total_seconds is not None and result.elapsed_seconds > self.max_total_seconds:
            _fail("network budget exceeded")
        return result


class Resolver(Protocol):
    def resolve(self, hostname: str) -> Iterable[str]:
        """Return every current A/AAAA answer for ``hostname``."""

        ...


ResolverLike = Callable[[str], Iterable[str]] | Resolver


def _unsafe_text(value: str) -> bool:
    return any(
        character.isspace()
        or _CONTROL.search(character)
        or unicodedata.category(character) in {"Cc", "Cf"}
        for character in value
    )


def _unsafe_query_text(value: str) -> bool:
    """Reject query controls and whitespace other than encoded U+0020."""

    return any(
        (character.isspace() and character != " ")
        or _CONTROL.search(character)
        or unicodedata.category(character) in {"Cc", "Cf"}
        for character in value
    )


def _validate_percent_escapes(value: str) -> None:
    index = 0
    while index < len(value):
        if value[index] == "%":
            if (
                index + 2 >= len(value)
                or value[index + 1] not in _HEX
                or value[index + 2] not in _HEX
            ):
                _fail()
            index += 3
        else:
            index += 1


def _decoded(value: str) -> str:
    try:
        decoded = unquote_to_bytes(value).decode("utf-8", "strict")
    except UnicodeDecodeError:
        _fail()
    if _CONTROL.search(decoded):
        _fail()
    return decoded


def _is_legacy_ipv4(value: str) -> bool:
    if _LEGACY_IPV4_SHAPE.fullmatch(value) is None:
        return False
    try:
        ipaddress.ip_address(value)
    except ValueError:
        return True
    return False


def _canonical_ip_literal(
    value: str,
) -> tuple[str, ipaddress.IPv4Address | ipaddress.IPv6Address] | None:
    if "%" in value:
        _fail()
    try:
        address = ipaddress.ip_address(value)
    except ValueError:
        if _is_legacy_ipv4(value):
            _fail()
        return None
    canonical = str(address)
    if canonical.casefold() != value.casefold():
        _fail()
    return canonical, address


def _canonical_hostname(
    value: str,
) -> tuple[str, ipaddress.IPv4Address | ipaddress.IPv6Address | None]:
    if not value or value.endswith(".") or "%" in value or _unsafe_text(value):
        _fail()
    literal = _canonical_ip_literal(value)
    if literal is not None:
        return literal
    try:
        ascii_hostname = value.encode("idna").decode("ascii").casefold()
        labels = ascii_hostname.split(".")
        for label in labels:
            if not label or len(label) > 63 or _DNS_LABEL.fullmatch(label) is None:
                _fail()
            decoded_label = label.encode("ascii").decode("idna")
            round_trip = decoded_label.encode("idna").decode("ascii")
            if round_trip.casefold() != label.casefold():
                _fail()
    except (UnicodeError, ValueError):
        _fail()
    if len(ascii_hostname) > 253:
        _fail()
    return ascii_hostname, None


def _normalise_schemes(value: Iterable[str] | None) -> frozenset[str]:
    if value is None:
        return _DEFAULT_SCHEMES
    try:
        schemes = frozenset(item.casefold() for item in value if type(item) is str)
    except (AttributeError, TypeError):
        _fail()
    if not schemes or not schemes <= frozenset(_DEFAULT_PORTS):
        _fail()
    return schemes


def _normalise_query(query: str) -> str:
    _validate_percent_escapes(query)
    _decoded(query.replace("+", " "))
    try:
        sensitive_query = has_sensitive_query_parameter(query)
    except (TypeError, ValueError):
        _fail()
    if sensitive_query:
        _fail()
    try:
        values = parse_qsl(query, keep_blank_values=True, strict_parsing=False)
    except ValueError:
        _fail()
    for key, value in values:
        if _unsafe_query_text(key) or _unsafe_query_text(value):
            _fail()
    return query


def _normalise_path(path: str, *, allow_encoded_separator: bool = False) -> str:
    path = path or "/"
    _validate_percent_escapes(path)
    if (
        "\\" in path
        or re.search(r"%5c", path, re.IGNORECASE)
        or (not allow_encoded_separator and re.search(r"%2f", path, re.IGNORECASE))
    ):
        _fail()
    decoded = _decoded(path)
    normalized = decoded.replace("\\", "/")
    if "//" in normalized or any(segment in {".", ".."} for segment in normalized.split("/")):
        _fail()
    # Reject traversal hidden behind more than one percent-decoding layer.
    for _ in range(2):
        if "%" not in decoded:
            break
        _validate_percent_escapes(decoded)
        if re.search(r"%(?:2f|5c)", decoded, re.IGNORECASE):
            _fail()
        decoded = _decoded(decoded)
        normalized = decoded.replace("\\", "/")
        if "//" in normalized or any(segment in {".", ".."} for segment in normalized.split("/")):
            _fail()
    return path


def _validate_opaque_path_parameter_semantics(value: str) -> None:
    if (
        not value
        or not value.strip()
        or "\\" in value
        or any(unicodedata.category(character) in {"Cc", "Cf"} for character in value)
    ):
        _fail()
    segments = value.split("/")
    if any(not segment.strip() or segment in {".", ".."} for segment in segments):
        _fail()


def _encode_opaque_path_parameter(value: str) -> str:
    if type(value) is not str:
        _fail()
    try:
        value.encode("utf-8", "strict")
    except UnicodeError:
        _fail()

    candidate = value
    # Validate the raw spelling and up to three decoding layers so encoded
    # separators, dot segments, controls, and backslashes cannot become
    # traversal after a downstream decoder handles the request target.
    for _ in range(4):
        _validate_opaque_path_parameter_semantics(candidate)
        if "%" not in candidate:
            break
        _validate_percent_escapes(candidate)
        decoded = _decoded(candidate)
        if decoded == candidate:
            break
        candidate = decoded
    return quote(value, safe=_OPAQUE_PATH_PARAMETER_SAFE, encoding="utf-8", errors="strict")


def _normalise_opaque_path_suffix(value: str | None) -> str | None:
    if value is None:
        return None
    if type(value) is not str or value in {".", ".."}:
        _fail()
    if _OPAQUE_PATH_SUFFIX.fullmatch(value) is None:
        _fail()
    return value


def append_opaque_path_parameter(
    base: NormalizedURL,
    value: str,
    *,
    suffix: str | None = None,
) -> NormalizedURL:
    """Append one Network-encoded path parameter to a strict ordinary base URL.

    ``normalize_url`` intentionally continues to reject caller-authored
    percent-encoded separators.  This narrower constructor accepts only a
    canonical ``NormalizedURL`` base, validates the raw parameter's decoded
    semantics, and owns the quoting that turns an internal slash into
    ``%2F``.  An optional trailing suffix is one separately validated ASCII
    unreserved literal segment; it cannot carry another opaque value.
    """

    if type(base) is not NormalizedURL:
        _fail()
    canonical = normalize_url(
        base.url,
        allowed_schemes=(base.scheme,),
        allowed_ports=((base.scheme, base.port),),
    )
    if canonical != base:
        _fail()
    encoded = _encode_opaque_path_parameter(value)
    normalized_suffix = _normalise_opaque_path_suffix(suffix)
    base_path = canonical.path.rstrip("/")
    path = f"{base_path}/{encoded}"
    if normalized_suffix is not None:
        path = f"{path}/{normalized_suffix}"
    authority = _render_authority(canonical.scheme, canonical.hostname, canonical.port)
    url = urlunsplit((canonical.scheme, authority, path, canonical.query, ""))
    return NormalizedURL(
        url=url,
        scheme=canonical.scheme,
        hostname=canonical.hostname,
        port=canonical.port,
        path=path,
        query=canonical.query,
    )


def _validate_port_text(netloc: str, port: int) -> None:
    authority = netloc.rsplit("@", 1)[-1]
    if authority.startswith("["):
        closing = authority.find("]")
        if closing < 0:
            _fail()
        suffix = authority[closing + 1 :]
        if not suffix:
            return
        if not suffix.startswith(":") or suffix[1:] != str(port):
            _fail()
        return
    if ":" not in authority:
        return
    raw_port = authority.rsplit(":", 1)[1]
    if raw_port != str(port):
        _fail()


def normalize_url(
    value: str,
    *,
    allowed_schemes: Iterable[str] | None = None,
    allowed_ports: Iterable[tuple[str, int]] | None = None,
) -> NormalizedURL:
    """Parse and canonically render one safe URL without resolving DNS."""

    if type(value) is not str or not value or _unsafe_text(value) or "\\" in value:
        _fail()
    schemes = _normalise_schemes(allowed_schemes)
    ports = _normalise_ports(allowed_ports, allowed_schemes=schemes)
    try:
        parsed = urlsplit(value)
        hostname = parsed.hostname
        port = parsed.port
    except (UnicodeError, ValueError):
        _fail()
    if parsed.scheme.casefold() not in schemes or hostname is None:
        _fail()
    if parsed.username is not None or parsed.password is not None or parsed.fragment:
        _fail()
    _validate_port_text(
        parsed.netloc, port if port is not None else _DEFAULT_PORTS[parsed.scheme.casefold()]
    )
    canonical_host, _literal = _canonical_hostname(hostname)
    expected_port = _DEFAULT_PORTS[parsed.scheme.casefold()]
    if port is None:
        port = expected_port
    if (parsed.scheme.casefold(), port) not in ports:
        _fail()
    path = _normalise_path(parsed.path)
    query = _normalise_query(parsed.query)
    authority = _render_authority(parsed.scheme.casefold(), canonical_host, port)
    normalized = urlunsplit(
        (
            parsed.scheme.casefold(),
            authority,
            path,
            query,
            "",
        )
    )
    return NormalizedURL(normalized, parsed.scheme.casefold(), canonical_host, port, path, query)


def normalize_url_with_configured_port(
    value: str,
    *,
    allowed_schemes: Iterable[str] | None = None,
) -> NormalizedURL:
    """Normalize an operator URL while opting into only its configured port.

    Ordinary callers must use ``normalize_url`` and therefore remain limited
    to the scheme defaults unless they already hold an exact port allowlist.
    Configuration adapters use this constructor once, then bind the returned
    ``(scheme, port)`` pair into their ``DestinationPolicy``.
    """

    if type(value) is not str or not value or _unsafe_text(value) or "\\" in value:
        _fail()
    schemes = _normalise_schemes(allowed_schemes)
    try:
        parsed = urlsplit(value)
        scheme = parsed.scheme.casefold()
        port = parsed.port
    except (UnicodeError, ValueError):
        _fail()
    if scheme not in schemes:
        _fail()
    configured_port = _DEFAULT_PORTS[scheme] if port is None else port
    return normalize_url(
        value,
        allowed_schemes=schemes,
        allowed_ports=((scheme, configured_port),),
    )


def _validated_normalized_url(
    value: NormalizedURL,
    *,
    allowed_schemes: frozenset[str],
    allowed_ports: frozenset[tuple[str, int]],
) -> NormalizedURL:
    """Recheck a structured URL, including Network-owned opaque path values."""

    if (
        type(value) is not NormalizedURL
        or type(value.url) is not str
        or type(value.scheme) is not str
        or type(value.hostname) is not str
        or type(value.port) is not int
        or type(value.path) is not str
        or type(value.query) is not str
    ):
        _fail()
    if value.scheme not in allowed_schemes or (value.scheme, value.port) not in allowed_ports:
        _fail()
    canonical_host, _literal = _canonical_hostname(value.hostname)
    if canonical_host != value.hostname:
        _fail()
    path = _normalise_path(value.path, allow_encoded_separator=True)
    query = _normalise_query(value.query)
    authority = _render_authority(value.scheme, value.hostname, value.port)
    expected = urlunsplit((value.scheme, authority, path, query, ""))
    if expected != value.url:
        _fail()
    return value


def _canonical_address(value: str) -> str:
    if type(value) is not str:
        _fail()
    literal = _canonical_ip_literal(value)
    if literal is None:
        _fail()
    return literal[0]


def classify_address(value: str | ipaddress.IPv4Address | ipaddress.IPv6Address) -> AddressClass:
    address = _coerce_address(value)
    if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped is not None:
        return classify_address(address.ipv4_mapped)
    for attribute, category in (
        ("is_unspecified", AddressClass.UNSPECIFIED),
        ("is_loopback", AddressClass.LOOPBACK),
        ("is_link_local", AddressClass.LINK_LOCAL),
        ("is_multicast", AddressClass.MULTICAST),
    ):
        if getattr(address, attribute):
            return category
    if any(address in network for network in _RESERVED_NETWORKS) or address.is_reserved:
        return AddressClass.RESERVED
    if address.is_private:
        return AddressClass.PRIVATE
    if not address.is_global:
        return AddressClass.RESERVED
    return AddressClass.PUBLIC


def _coerce_address(
    value: str | ipaddress.IPv4Address | ipaddress.IPv6Address,
) -> ipaddress.IPv4Address | ipaddress.IPv6Address:
    if isinstance(value, (ipaddress.IPv4Address, ipaddress.IPv6Address)):
        return value
    if type(value) is not str:
        _fail()
    try:
        return ipaddress.ip_address(value)
    except ValueError:
        _fail()


def _resolver_values(resolver: ResolverLike, hostname: str) -> tuple[str, ...]:
    try:
        values = resolver(hostname) if callable(resolver) else resolver.resolve(hostname)
        result = tuple(_canonical_address(str(value)) for value in values)
    except PolicyError:
        raise
    except Exception:
        _fail("network DNS resolution failed")
    if not result:
        _fail("network DNS resolution failed")
    return tuple(sorted(set(result)))


def resolve_destination(
    value: str | NormalizedURL,
    resolver: ResolverLike,
    *,
    policy: DestinationPolicy | None = None,
    previous: ResolvedDestination | None = None,
) -> ResolvedDestination:
    """Resolve and classify every address, optionally rebinding-rechecking it."""

    destination_policy = DestinationPolicy() if policy is None else policy
    if not isinstance(destination_policy, DestinationPolicy):
        _fail()
    url = (
        _validated_normalized_url(
            value,
            allowed_schemes=destination_policy.allowed_schemes,
            allowed_ports=destination_policy.allowed_ports,
        )
        if isinstance(value, NormalizedURL)
        else normalize_url(
            value,
            allowed_schemes=destination_policy.allowed_schemes,
            allowed_ports=destination_policy.allowed_ports,
        )
    )
    literal = _canonical_ip_literal(url.hostname)
    addresses = (literal[0],) if literal is not None else _resolver_values(resolver, url.hostname)
    classes = tuple(classify_address(address) for address in addresses)
    if any(
        address not in destination_policy.allowed_addresses
        if destination_policy.allowed_addresses
        else address_class not in destination_policy.allowed_classes
        for address, address_class in zip(addresses, classes, strict=True)
    ):
        _fail("network destination is not allowed")
    if destination_policy.allowed_addresses and any(
        address_class not in destination_policy.allowed_classes for address_class in classes
    ):
        _fail("network destination is not allowed")
    result = ResolvedDestination(url, addresses, classes)
    if previous is not None:
        if not isinstance(previous, ResolvedDestination):
            _fail()
        if previous.url.hostname == result.url.hostname and previous.addresses != result.addresses:
            _fail("network destination changed during recheck")
    return result


def _as_destination(
    value: str | NormalizedURL | ResolvedDestination,
    resolver: ResolverLike,
    policy: DestinationPolicy,
) -> ResolvedDestination:
    if isinstance(value, ResolvedDestination):
        return value
    return resolve_destination(value, resolver, policy=policy)


def evaluate_redirect(
    current: str | NormalizedURL | ResolvedDestination,
    location: str,
    resolver: ResolverLike,
    *,
    policy: DestinationPolicy | None = None,
    target_guard: Callable[[str], None] | None = None,
) -> RedirectDecision:
    """Evaluate one redirect, optionally guarding its absolute text before DNS.

    ``target_guard`` is protocol-neutral: it receives only the absolute target
    text and must not retain or return policy data.  It runs before either the
    source or target is resolved.  Callers still receive a canonical, resolved
    destination after the normal URL and address policy checks.
    """

    destination_policy = DestinationPolicy() if policy is None else policy
    if not isinstance(destination_policy, DestinationPolicy):
        _fail()
    if target_guard is not None and not callable(target_guard):
        _fail()
    source_url = current.url if isinstance(current, ResolvedDestination) else current
    if isinstance(source_url, NormalizedURL):
        source_url = _validated_normalized_url(
            source_url,
            allowed_schemes=destination_policy.allowed_schemes,
            allowed_ports=destination_policy.allowed_ports,
        )
    else:
        source_url = normalize_url(
            source_url,
            allowed_schemes=destination_policy.allowed_schemes,
            allowed_ports=destination_policy.allowed_ports,
        )
    if type(location) is not str or not location or _unsafe_text(location) or "\\" in location:
        _fail()
    relative_path = location.split("?", 1)[0].split("#", 1)[0]
    if not re.match(r"^[A-Za-z][A-Za-z0-9+.-]*://", location):
        _normalise_path(relative_path or "/")
    try:
        target_text = urljoin(source_url.url, location)
    except (TypeError, ValueError):
        _fail()
    if target_guard is not None:
        try:
            target_guard(target_text)
        except Exception:
            _fail()
    source = _as_destination(current, resolver, destination_policy)
    target = resolve_destination(target_text, resolver, policy=destination_policy)
    if source.hostname == target.hostname and source.addresses != target.addresses:
        _fail("network destination changed during recheck")
    same_origin = source.origin == target.origin
    forward_credentials = same_origin or target.origin in destination_policy.allowed_origins
    return RedirectDecision(source, target, same_origin, forward_credentials)


def redact_query(value: object) -> str:
    """Return a fixed query placeholder; query keys can also be sensitive."""

    del value
    return "<redacted-query>"


def redact_url(value: object) -> str:
    """Return a URL-safe diagnostic without query values or malformed input."""

    if type(value) is not str:
        return "<redacted-url>"
    try:
        parsed = urlsplit(value)
        if parsed.query:
            return "<redacted-url>"
        normalized = normalize_url(value)
    except (PolicyError, TypeError, ValueError):
        return "<redacted-url>"
    suffix = "" if normalized.path == "/" else "/<redacted-path>"
    return normalized.origin.text + suffix


def redact_headers(
    value: Mapping[object, object] | Sequence[tuple[object, object]] | object,
) -> tuple[tuple[str, str], ...]:
    """Keep only safe field names and replace every field value."""

    if isinstance(value, Mapping):
        items = value.items()
    elif isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        items = value
    else:
        return (("<redacted-header>", "<redacted>"),)
    result: list[tuple[str, str]] = []
    for name, _item in items:
        if type(name) is str and re.fullmatch(r"[!#$%&'*+\-.^_`|~0-9A-Za-z]+", name):
            safe_name = name
        else:
            safe_name = "<redacted-header>"
        result.append((safe_name, "<redacted>"))
    return tuple(result) or (("<redacted-header>", "<redacted>"),)


def redact_cookie(value: object) -> str:
    del value
    return "<redacted-cookie>"


def redact_exception(value: BaseException | object) -> str:
    del value
    return "<redacted-error>"


__all__ = (
    "AddressClass",
    "BudgetUsage",
    "DestinationPolicy",
    "NormalizedURL",
    "Origin",
    "PolicyError",
    "RedirectDecision",
    "ResolvedDestination",
    "Resolver",
    "ResourceBudget",
    "append_opaque_path_parameter",
    "classify_address",
    "evaluate_redirect",
    "normalize_url",
    "normalize_url_with_configured_port",
    "redact_cookie",
    "redact_exception",
    "redact_headers",
    "redact_query",
    "redact_url",
    "resolve_destination",
)
