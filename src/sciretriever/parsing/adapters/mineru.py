"""Operator-managed MinerU 3.4.4 adapter for Parsing.

This module defines the Parsing-private service Port and its strict protocol-2
client.  The concrete client translates MinerU paths, multipart fields, and
wire states while delegating all network access, destination checks, redirects,
admission, bounded reads, and credential forwarding to the shared Network.
"""

from __future__ import annotations

import io
import ipaddress
import json
import math
import re
import threading
import uuid
import zipfile
from collections.abc import Callable
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from typing import Final, NoReturn, Protocol, runtime_checkable

from PyPDF2 import PdfReader

from sciretriever.model.access import AccessFailure, Header, TransportResponse
from sciretriever.model.parsing import ParserProvenance, ParserRequest
from sciretriever.model.primitives import (
    ProvenanceId,
    Sha256,
    SourceKind,
    UtcTimestamp,
    sha256_digest,
)
from sciretriever.model.provenance import Provenance
from sciretriever.network.admission import AccessPolicy, AccessScope
from sciretriever.network.http import HttpClient
from sciretriever.network.policy import (
    AddressClass,
    DestinationPolicy,
    NormalizedURL,
    Origin,
    PolicyError,
    ResourceBudget,
    normalize_url_with_configured_port,
)
from sciretriever.parsing.adapters.mineru_converter import (
    MinerUConversionBounds,
    MinerUConversionError,
    convert_mineru_archive,
)
from sciretriever.parsing.ports import StagedParserOutput

_PARSER_NAME: Final[str] = "mineru"
_SUPPORTED_RELEASE: Final[str] = "3.4.4"
_SUPPORTED_PROTOCOL: Final[int] = 2
_SUPPORTED_PROFILE: Final[str] = "vlm-engine"
_SUPPORTED_ARCHIVE_BACKEND: Final[str] = "vlm"
_PARAMETERS_CONTRACT: Final[str] = "operator-managed-mineru-v1"
_MARKDOWN_CONVERSION_CONTRACT: Final[str] = "parser-neutral-markdown-v1"
_READ_CHUNK_BYTES: Final[int] = 1024 * 1024
_TASK_ID: Final[re.Pattern[str]] = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]*$")
_TASK_STATES: Final[frozenset[str]] = frozenset({"pending", "processing", "completed", "failed"})
_ARCHIVE_STATES: Final[frozenset[str]] = frozenset({"pending", "expired", "failed", "completed"})
_PROTOCOL2_JSON_MEDIA_TYPE: Final[str] = "application/json"
_PROTOCOL2_ARCHIVE_MEDIA_TYPE: Final[str] = "application/zip"
_PROTOCOL2_FIELDS: Final[tuple[tuple[str, str], ...]] = (
    ("backend", "vlm-engine"),
    ("parse_method", "auto"),
    ("formula_enable", "true"),
    ("table_enable", "true"),
    ("image_analysis", "true"),
    ("return_md", "false"),
    ("return_middle_json", "true"),
    ("return_model_output", "true"),
    ("return_content_list", "true"),
    ("return_images", "true"),
    ("response_format_zip", "true"),
    ("return_original_file", "false"),
    ("client_side_output_generation", "false"),
)


class MinerUAdapterError(RuntimeError):
    """Stable failure without task IDs, service details, paths, or PDF text."""

    _CODES = frozenset(
        {
            "input-invalid",
            "input-budget",
            "service-unavailable",
            "service-contract-invalid",
            "task-invalid",
            "task-failed",
            "task-missing",
            "poll-limit",
            "archive-unavailable",
            "output-invalid",
            "provenance-invalid",
        }
    )

    def __init__(self, code: str) -> None:
        if code not in self._CODES:
            raise ValueError("unknown MinerU adapter error code")
        self.code = code
        super().__init__(f"operator-managed MinerU parsing failed ({code})")

    def __repr__(self) -> str:
        return f"MinerUAdapterError(code={self.code!r})"


def _fail(code: str) -> NoReturn:
    raise MinerUAdapterError(code) from None


@dataclass(frozen=True, slots=True)
class MinerUHealth:
    """Transport-neutral service identity returned by a health probe."""

    status: str
    release: str
    api_protocol: int

    def __post_init__(self) -> None:
        if type(self.status) is not str or not self.status.strip():
            raise ValueError("MinerU health status must be a nonblank string")
        if type(self.release) is not str or not self.release.strip():
            raise ValueError("MinerU release must be a nonblank string")
        if type(self.api_protocol) is not int or self.api_protocol <= 0:
            raise ValueError("MinerU API protocol must be a positive integer")


@dataclass(frozen=True, slots=True)
class MinerUTask:
    """Transport-neutral state for one ephemeral operator-owned task."""

    task_id: str = field(repr=False)
    state: str

    def __post_init__(self) -> None:
        if type(self.task_id) is not str:
            raise TypeError("MinerU task ID must be a string")
        if type(self.state) is not str or self.state not in _TASK_STATES:
            raise ValueError("MinerU task state is unsupported")

    def __repr__(self) -> str:
        return f"MinerUTask(state={self.state!r}, task_id=<redacted>)"


@dataclass(frozen=True, slots=True)
class MinerUArchiveResult:
    """Transport-neutral availability result for one private ZIP archive."""

    state: str
    payload: bytes | None = field(default=None, repr=False)

    def __post_init__(self) -> None:
        if type(self.state) is not str or self.state not in _ARCHIVE_STATES:
            raise ValueError("MinerU archive state is unsupported")
        if self.payload is not None and type(self.payload) is not bytes:
            raise TypeError("MinerU archive payload must be bytes or None")


@runtime_checkable
class MinerUServicePort(Protocol):
    """Parsing-private lifecycle, deliberately independent of HTTP wire shape."""

    def health(
        self,
        *,
        timeout_seconds: float,
        cancel_event: threading.Event | None = None,
    ) -> MinerUHealth: ...

    def submit(
        self,
        pdf: bytes,
        *,
        profile: str,
        timeout_seconds: float,
        cancel_event: threading.Event | None = None,
    ) -> MinerUTask: ...

    def poll(
        self,
        task_id: str,
        *,
        timeout_seconds: float,
        cancel_event: threading.Event | None = None,
    ) -> MinerUTask | None: ...

    def archive(
        self,
        task_id: str,
        *,
        timeout_seconds: float,
        cancel_event: threading.Event | None = None,
    ) -> MinerUArchiveResult: ...


class MinerUProtocol2Error(RuntimeError):
    """Stable, redacted failure at the MinerU protocol-2 HTTP boundary."""

    _CODES = frozenset(
        {
            "configuration-invalid",
            "credential-invalid",
            "profile-invalid",
            "upload-invalid",
            "upload-budget",
            "timeout-invalid",
            "access-failed",
            "response-budget",
            "status-invalid",
            "protocol-invalid",
            "task-invalid",
            "archive-invalid",
        }
    )

    def __init__(self, code: str) -> None:
        if code not in self._CODES:
            raise ValueError("unknown MinerU protocol-2 error code")
        self.code = code
        super().__init__(f"MinerU protocol-2 request failed ({code})")

    def __repr__(self) -> str:
        return f"MinerUProtocol2Error(code={self.code!r})"


def _protocol2_fail(code: str) -> NoReturn:
    raise MinerUProtocol2Error(code) from None


@dataclass(frozen=True, slots=True)
class MinerUProtocol2Bounds:
    """Independent wire limits for one protocol-2 request or response."""

    max_upload_bytes: int = 256 * 1024 * 1024
    max_json_response_bytes: int = 64 * 1024
    max_archive_bytes: int = 64 * 1024 * 1024
    max_task_id_characters: int = 256

    def __post_init__(self) -> None:
        for value in (
            self.max_upload_bytes,
            self.max_json_response_bytes,
            self.max_archive_bytes,
            self.max_task_id_characters,
        ):
            if type(value) is not int or value <= 0:
                raise ValueError("MinerU protocol-2 bounds must be positive integers")


class _DuplicateProtocol2JsonKey(ValueError):
    pass


def _protocol2_json_object(response: TransportResponse) -> dict[str, object]:
    if _response_media_type(response) != _PROTOCOL2_JSON_MEDIA_TYPE:
        _protocol2_fail("protocol-invalid")

    def object_pairs(pairs: list[tuple[str, object]]) -> dict[str, object]:
        result: dict[str, object] = {}
        for key, value in pairs:
            if key in result:
                raise _DuplicateProtocol2JsonKey
            result[key] = value
        return result

    def reject_constant(_value: str) -> NoReturn:
        raise ValueError("non-finite JSON number")

    def finite_float(value: str) -> float:
        parsed = float(value)
        if not math.isfinite(parsed):
            raise ValueError("non-finite JSON number")
        return parsed

    try:
        decoded = response.body.decode("utf-8", errors="strict")
        value = json.loads(
            decoded,
            object_pairs_hook=object_pairs,
            parse_constant=reject_constant,
            parse_float=finite_float,
        )
    except (UnicodeDecodeError, ValueError, RecursionError):
        _protocol2_fail("protocol-invalid")
    if type(value) is not dict or any(type(key) is not str for key in value):
        _protocol2_fail("protocol-invalid")
    return value


def _response_media_type(response: TransportResponse) -> str:
    values = [
        header.value for header in response.headers if header.name.casefold() == "content-type"
    ]
    if len(values) != 1:
        _protocol2_fail("protocol-invalid")
    value = values[0]
    if type(value) is not str:
        _protocol2_fail("protocol-invalid")
    media_type = value.split(";", maxsplit=1)[0].strip().casefold()
    if not media_type:
        _protocol2_fail("protocol-invalid")
    return media_type


def _checked_protocol2_bounds(value: MinerUProtocol2Bounds | None) -> MinerUProtocol2Bounds:
    if value is None:
        return MinerUProtocol2Bounds()
    if not isinstance(value, MinerUProtocol2Bounds):
        raise TypeError("bounds must be MinerUProtocol2Bounds or None")
    return value


def _checked_protocol2_timeout(value: float) -> float:
    if type(value) not in {int, float} or not math.isfinite(value) or value <= 0:
        _protocol2_fail("timeout-invalid")
    return float(value)


def _checked_bearer_token(value: object) -> str:
    if type(value) is not str:
        _protocol2_fail("credential-invalid")
    if (
        not value
        or len(value) > 8192
        or value != value.strip()
        or any(character.isspace() or not 33 <= ord(character) <= 126 for character in value)
    ):
        _protocol2_fail("credential-invalid")
    return value


def _checked_protocol2_task_id(value: object, *, maximum: int) -> str:
    if (
        type(value) is not str
        or not value
        or len(value) > maximum
        or _TASK_ID.fullmatch(value) is None
    ):
        _protocol2_fail("task-invalid")
    return value


def _multipart_protocol2_pdf(pdf: bytes) -> tuple[bytes, str]:
    boundary = f"sciretriever-{uuid.uuid4().hex}"
    chunks: list[bytes] = []
    for name, value in _PROTOCOL2_FIELDS:
        chunks.append(
            (
                f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'
            ).encode("ascii")
        )
    chunks.append(
        (
            f'--{boundary}\r\nContent-Disposition: form-data; name="files"; '
            'filename="document.pdf"\r\nContent-Type: application/pdf\r\n\r\n'
        ).encode("ascii")
    )
    chunks.extend((pdf, f"\r\n--{boundary}--\r\n".encode("ascii")))
    return b"".join(chunks), boundary


@dataclass(frozen=True, slots=True, repr=False)
class _Protocol2Connection:
    base_url: str
    mode: str
    destination_policy: DestinationPolicy
    bearer_token: str | None = field(default=None, repr=False)
    credential_origin: Origin | None = None


def _checked_protocol2_connection(
    *,
    base_url: str,
    connection_mode: str,
    bearer_token: str | None,
    remote_upload_authorized: bool,
) -> _Protocol2Connection:
    if type(remote_upload_authorized) is not bool:
        raise TypeError("remote_upload_authorized must be a boolean")
    if connection_mode not in {"loopback", "remote"}:
        _protocol2_fail("configuration-invalid")
    allowed_scheme = "http" if connection_mode == "loopback" else "https"
    try:
        normalized = normalize_url_with_configured_port(
            base_url,
            allowed_schemes=(allowed_scheme,),
        )
    except (PolicyError, TypeError, ValueError):
        _protocol2_fail("configuration-invalid")
    if normalized.query:
        _protocol2_fail("configuration-invalid")
    try:
        address = ipaddress.ip_address(normalized.hostname)
    except ValueError:
        address = None
    if connection_mode == "loopback":
        return _loopback_protocol2_connection(
            normalized,
            address=address,
            bearer_token=bearer_token,
            remote_upload_authorized=remote_upload_authorized,
        )
    return _remote_protocol2_connection(
        normalized,
        address=address,
        bearer_token=bearer_token,
        remote_upload_authorized=remote_upload_authorized,
    )


def _loopback_protocol2_connection(
    normalized: NormalizedURL,
    *,
    address: ipaddress.IPv4Address | ipaddress.IPv6Address | None,
    bearer_token: str | None,
    remote_upload_authorized: bool,
) -> _Protocol2Connection:
    if bearer_token is not None or remote_upload_authorized:
        _protocol2_fail("configuration-invalid")
    if normalized.hostname == "localhost":
        allowed_addresses = frozenset({"127.0.0.1", "::1"})
    elif address is not None and address.is_loopback:
        allowed_addresses = frozenset({str(address)})
    else:
        _protocol2_fail("configuration-invalid")
    return _Protocol2Connection(
        base_url=normalized.url.rstrip("/"),
        mode="loopback",
        destination_policy=DestinationPolicy(
            allowed_schemes=frozenset({"http"}),
            allowed_classes=frozenset({AddressClass.LOOPBACK}),
            allowed_addresses=allowed_addresses,
            allowed_ports=frozenset({(normalized.scheme, normalized.port)}),
        ),
    )


def _remote_protocol2_connection(
    normalized: NormalizedURL,
    *,
    address: ipaddress.IPv4Address | ipaddress.IPv6Address | None,
    bearer_token: str | None,
    remote_upload_authorized: bool,
) -> _Protocol2Connection:
    if address is not None or normalized.hostname == "localhost":
        _protocol2_fail("configuration-invalid")
    if not remote_upload_authorized:
        _protocol2_fail("configuration-invalid")
    return _Protocol2Connection(
        base_url=normalized.url.rstrip("/"),
        mode="remote",
        bearer_token=_checked_bearer_token(bearer_token),
        credential_origin=normalized.origin,
        destination_policy=DestinationPolicy(
            allowed_schemes=frozenset({"https"}),
            allowed_classes=frozenset({AddressClass.PUBLIC}),
            allowed_ports=frozenset({(normalized.scheme, normalized.port)}),
        ),
    )


class MinerUProtocol2ServiceClient:
    """MinerU 3.4.4 protocol-2 client using the shared Network capability.

    The client owns only MinerU wire semantics.  URL/DNS/redirect/admission,
    response reads, and credential forwarding remain inside ``HttpClient``.
    """

    __slots__ = (
        "_access_policy",
        "_access_scope",
        "_base_url",
        "_bearer_token",
        "_bounds",
        "_credential_origin",
        "_destination_policy",
        "_http_client",
        "_mode",
    )

    def __init__(
        self,
        *,
        http_client: HttpClient,
        base_url: str,
        connection_mode: str,
        access_scope: AccessScope,
        access_policy: AccessPolicy,
        bearer_token: str | None = None,
        remote_upload_authorized: bool = False,
        bounds: MinerUProtocol2Bounds | None = None,
    ) -> None:
        if not isinstance(http_client, HttpClient):
            raise TypeError("http_client must be an HttpClient")
        if not isinstance(access_scope, AccessScope):
            raise TypeError("access_scope must be an AccessScope")
        if not isinstance(access_policy, AccessPolicy):
            raise TypeError("access_policy must be an AccessPolicy")
        connection = _checked_protocol2_connection(
            base_url=base_url,
            connection_mode=connection_mode,
            bearer_token=bearer_token,
            remote_upload_authorized=remote_upload_authorized,
        )

        self._http_client = http_client
        self._base_url = connection.base_url
        self._mode = connection.mode
        self._access_scope = access_scope
        self._access_policy = access_policy
        self._destination_policy = connection.destination_policy
        self._bearer_token = connection.bearer_token
        self._credential_origin = connection.credential_origin
        self._bounds = _checked_protocol2_bounds(bounds)

    def __repr__(self) -> str:
        return (
            f"<MinerUProtocol2ServiceClient mode={self._mode!r} "
            f"credentialed={self._bearer_token is not None}>"
        )

    def health(
        self,
        *,
        timeout_seconds: float,
        cancel_event: threading.Event | None = None,
    ) -> MinerUHealth:
        response = self._request(
            "health",
            timeout_seconds=timeout_seconds,
            max_response_bytes=self._bounds.max_json_response_bytes,
            cancel_event=cancel_event,
        )
        if response.status != 200:
            _protocol2_fail("status-invalid")
        value = _protocol2_json_object(response)
        if set(value) != {"status", "version", "protocol_version"}:
            _protocol2_fail("protocol-invalid")
        status = value["status"]
        release = value["version"]
        protocol = value["protocol_version"]
        if (
            type(status) is not str
            or type(release) is not str
            or type(protocol) is not int
            or status != "healthy"
            or release != _SUPPORTED_RELEASE
            or protocol != _SUPPORTED_PROTOCOL
        ):
            _protocol2_fail("protocol-invalid")
        return MinerUHealth(status=status, release=release, api_protocol=protocol)

    def probe_health(
        self,
        *,
        timeout_seconds: float = 10.0,
        cancel_event: threading.Event | None = None,
    ) -> MinerUHealth:
        """Run the bounded health-only contract used by ``config test mineru``."""

        return self.health(
            timeout_seconds=timeout_seconds,
            cancel_event=cancel_event,
        )

    def submit(
        self,
        pdf: bytes,
        *,
        profile: str,
        timeout_seconds: float,
        cancel_event: threading.Event | None = None,
    ) -> MinerUTask:
        if profile != _SUPPORTED_PROFILE:
            _protocol2_fail("profile-invalid")
        if type(pdf) is not bytes or not pdf:
            _protocol2_fail("upload-invalid")
        if len(pdf) > self._bounds.max_upload_bytes:
            _protocol2_fail("upload-budget")
        body, boundary = _multipart_protocol2_pdf(pdf)
        response = self._request(
            "tasks",
            method="POST",
            headers=(
                Header(
                    name="Content-Type",
                    value=f"multipart/form-data; boundary={boundary}",
                ),
            ),
            body=body,
            timeout_seconds=timeout_seconds,
            max_response_bytes=self._bounds.max_json_response_bytes,
            cancel_event=cancel_event,
        )
        if response.status != 202:
            _protocol2_fail("status-invalid")
        return self._task(response, expected_task_id=None)

    def poll(
        self,
        task_id: str,
        *,
        timeout_seconds: float,
        cancel_event: threading.Event | None = None,
    ) -> MinerUTask | None:
        checked_task_id = _checked_protocol2_task_id(
            task_id,
            maximum=self._bounds.max_task_id_characters,
        )
        response = self._request(
            "tasks",
            path_parameter=checked_task_id,
            timeout_seconds=timeout_seconds,
            max_response_bytes=self._bounds.max_json_response_bytes,
            cancel_event=cancel_event,
        )
        if response.status == 404:
            return None
        if response.status != 200:
            _protocol2_fail("status-invalid")
        return self._task(response, expected_task_id=checked_task_id)

    def archive(
        self,
        task_id: str,
        *,
        timeout_seconds: float,
        cancel_event: threading.Event | None = None,
    ) -> MinerUArchiveResult:
        checked_task_id = _checked_protocol2_task_id(
            task_id,
            maximum=self._bounds.max_task_id_characters,
        )
        response = self._request(
            "tasks",
            accept=_PROTOCOL2_ARCHIVE_MEDIA_TYPE,
            path_parameter=checked_task_id,
            path_parameter_suffix="result",
            timeout_seconds=timeout_seconds,
            max_response_bytes=self._bounds.max_archive_bytes,
            cancel_event=cancel_event,
        )
        if response.status == 202:
            return MinerUArchiveResult(state="pending")
        if response.status == 404:
            return MinerUArchiveResult(state="expired")
        if response.status == 409:
            return MinerUArchiveResult(state="failed")
        if response.status != 200:
            _protocol2_fail("status-invalid")
        if _response_media_type(response) != _PROTOCOL2_ARCHIVE_MEDIA_TYPE:
            _protocol2_fail("archive-invalid")
        payload = response.body
        if not payload or not zipfile.is_zipfile(io.BytesIO(payload)):
            _protocol2_fail("archive-invalid")
        return MinerUArchiveResult(state="completed", payload=payload)

    def _task(
        self,
        response: TransportResponse,
        *,
        expected_task_id: str | None,
    ) -> MinerUTask:
        value = _protocol2_json_object(response)
        if set(value) != {"task_id", "status"}:
            _protocol2_fail("protocol-invalid")
        task_id = _checked_protocol2_task_id(
            value["task_id"],
            maximum=self._bounds.max_task_id_characters,
        )
        state = value["status"]
        if type(state) is not str or state not in _TASK_STATES:
            _protocol2_fail("protocol-invalid")
        if expected_task_id is not None and task_id != expected_task_id:
            _protocol2_fail("task-invalid")
        return MinerUTask(task_id=task_id, state=state)

    def _request(
        self,
        relative_path: str,
        *,
        method: str = "GET",
        accept: str = _PROTOCOL2_JSON_MEDIA_TYPE,
        headers: tuple[Header, ...] = (),
        body: bytes | None = None,
        path_parameter: str | None = None,
        path_parameter_suffix: str | None = None,
        timeout_seconds: float,
        max_response_bytes: int,
        cancel_event: threading.Event | None = None,
    ) -> TransportResponse:
        timeout = _checked_protocol2_timeout(timeout_seconds)
        url = f"{self._base_url}/{relative_path}"
        safe_headers = (Header(name="Accept", value=accept), *headers)
        credential_headers: tuple[tuple[str, str], ...] = ()
        credential_origins: tuple[Origin, ...] = ()
        if self._bearer_token is not None:
            if self._credential_origin is None:
                _protocol2_fail("configuration-invalid")
            credential_headers = (("Authorization", f"Bearer {self._bearer_token}"),)
            credential_origins = (self._credential_origin,)
        try:
            result = self._http_client.request(
                self._access_scope,
                url,
                self._access_policy,
                method=method,
                headers=safe_headers,
                credential_headers=credential_headers,
                credential_allowed_origins=credential_origins,
                path_parameter=path_parameter,
                path_parameter_suffix=path_parameter_suffix,
                body=body,
                destination_policy=self._destination_policy,
                budget=ResourceBudget(
                    max_response_bytes=max_response_bytes,
                    max_navigations=1,
                    max_total_seconds=timeout,
                ),
                connect_timeout_seconds=timeout,
                read_timeout_seconds=timeout,
                overall_timeout_seconds=timeout,
                max_response_bytes=max_response_bytes,
                max_redirects=0,
                max_retries=0,
                cancel_event=cancel_event,
            )
        except Exception:
            _protocol2_fail("access-failed")
        if isinstance(result, AccessFailure):
            if result.code in {"oversize", "budget"}:
                _protocol2_fail("response-budget")
            _protocol2_fail("access-failed")
        if not isinstance(result, TransportResponse):
            _protocol2_fail("protocol-invalid")
        return result


@dataclass(frozen=True, slots=True)
class MinerUAdapterBounds:
    """Local input, lifecycle, and transport-call limits for one attempt."""

    max_input_bytes: int = 256 * 1024 * 1024
    max_pages: int = 10_000
    max_poll_attempts: int = 120
    max_task_id_characters: int = 256
    health_timeout_seconds: float = 10.0
    submit_timeout_seconds: float = 120.0
    poll_timeout_seconds: float = 30.0
    archive_timeout_seconds: float = 120.0

    def __post_init__(self) -> None:
        for value in (
            self.max_input_bytes,
            self.max_pages,
            self.max_poll_attempts,
            self.max_task_id_characters,
        ):
            if type(value) is not int or value <= 0:
                raise ValueError("MinerU adapter integer bounds must be positive integers")
        for value in (
            self.health_timeout_seconds,
            self.submit_timeout_seconds,
            self.poll_timeout_seconds,
            self.archive_timeout_seconds,
        ):
            if type(value) not in {int, float} or not math.isfinite(value) or value <= 0:
                raise ValueError("MinerU adapter timeouts must be finite positive numbers")


def _new_provenance_id() -> ProvenanceId:
    return ProvenanceId(str(uuid.uuid4()))


def _utc_now() -> UtcTimestamp:
    value = datetime.now(timezone.utc).isoformat(timespec="microseconds").replace("+00:00", "Z")
    return UtcTimestamp(value)


def _checked_bounds(value: MinerUAdapterBounds | None) -> MinerUAdapterBounds:
    if value is None:
        return MinerUAdapterBounds()
    if not isinstance(value, MinerUAdapterBounds):
        raise TypeError("bounds must be MinerUAdapterBounds")
    return value


def _checked_conversion_bounds(
    value: MinerUConversionBounds | None,
) -> MinerUConversionBounds:
    if value is None:
        return MinerUConversionBounds()
    if not isinstance(value, MinerUConversionBounds):
        raise TypeError("conversion_bounds must be MinerUConversionBounds")
    return value


def _checked_model_identity(value: str) -> str:
    if (
        type(value) is not str
        or not value.strip()
        or value != value.strip()
        or len(value) > 512
        or any(ord(character) < 32 or ord(character) == 127 for character in value)
    ):
        raise ValueError("model_identity must be a bounded nonblank string")
    return value


def _parameters_sha256(
    *,
    model_identity: str,
    bounds: MinerUAdapterBounds,
    conversion_bounds: MinerUConversionBounds,
) -> Sha256:
    adapter_bounds = {
        "archive_timeout_seconds": float(bounds.archive_timeout_seconds),
        "health_timeout_seconds": float(bounds.health_timeout_seconds),
        "max_input_bytes": bounds.max_input_bytes,
        "max_pages": bounds.max_pages,
        "max_poll_attempts": bounds.max_poll_attempts,
        "max_task_id_characters": bounds.max_task_id_characters,
        "poll_timeout_seconds": float(bounds.poll_timeout_seconds),
        "submit_timeout_seconds": float(bounds.submit_timeout_seconds),
    }
    payload = {
        "adapter_contract": _PARAMETERS_CONTRACT,
        "archive_backend": _SUPPORTED_ARCHIVE_BACKEND,
        "bounds": adapter_bounds,
        "conversion_bounds": asdict(conversion_bounds),
        "markdown_conversion_contract": _MARKDOWN_CONVERSION_CONTRACT,
        "model_identity": model_identity,
        "parser_name": _PARSER_NAME,
        "parser_release": _SUPPORTED_RELEASE,
        "profile": _SUPPORTED_PROFILE,
        "service_protocol": _SUPPORTED_PROTOCOL,
    }
    encoded = json.dumps(
        payload,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    return sha256_digest(encoded)


class OperatorManagedMinerUAdapter:
    """Explicit ``vlm-engine`` adapter for an already-running MinerU service."""

    __slots__ = (
        "_bounds",
        "_clock",
        "_conversion_bounds",
        "_model_identity",
        "_parameters_sha256",
        "_provenance_id_factory",
        "_service",
    )

    def __init__(
        self,
        *,
        service: MinerUServicePort,
        profile: str,
        model_identity: str,
        provenance_id_factory: Callable[[], ProvenanceId] | None = None,
        clock: Callable[[], UtcTimestamp] | None = None,
        bounds: MinerUAdapterBounds | None = None,
        conversion_bounds: MinerUConversionBounds | None = None,
    ) -> None:
        if not isinstance(service, MinerUServicePort):
            raise TypeError("service must implement MinerUServicePort")
        if profile != _SUPPORTED_PROFILE:
            raise ValueError("only the explicit vlm-engine MinerU profile is supported")
        if provenance_id_factory is not None and not callable(provenance_id_factory):
            raise TypeError("provenance_id_factory must be callable")
        if clock is not None and not callable(clock):
            raise TypeError("clock must be callable")
        self._service = service
        self._model_identity = _checked_model_identity(model_identity)
        self._bounds = _checked_bounds(bounds)
        self._conversion_bounds = _checked_conversion_bounds(conversion_bounds)
        self._provenance_id_factory = provenance_id_factory or _new_provenance_id
        self._clock = clock or _utc_now
        self._parameters_sha256 = _parameters_sha256(
            model_identity=self._model_identity,
            bounds=self._bounds,
            conversion_bounds=self._conversion_bounds,
        )

    def __repr__(self) -> str:
        return "OperatorManagedMinerUAdapter(profile='vlm-engine', service=<redacted>)"

    def parse(
        self,
        request: ParserRequest,
        *,
        cancel_event: threading.Event | None = None,
    ) -> StagedParserOutput:
        """Submit and complete one bounded ephemeral MinerU attempt."""

        return self._execute(
            request,
            existing_task_id=None,
            cancel_event=cancel_event,
        )

    def resume(
        self,
        request: ParserRequest,
        task_id: str,
        *,
        cancel_event: threading.Event | None = None,
    ) -> StagedParserOutput:
        """Resume polling a caller-held task without persisting or resubmitting it."""

        checked_task_id = self._checked_task_id(task_id)
        return self._execute(
            request,
            existing_task_id=checked_task_id,
            cancel_event=cancel_event,
        )

    def _execute(
        self,
        request: ParserRequest,
        *,
        existing_task_id: str | None,
        cancel_event: threading.Event | None,
    ) -> StagedParserOutput:
        pdf, page_count = self._validated_pdf(request)
        self._validate_health(cancel_event)
        submitted = self._submit(pdf, cancel_event) if existing_task_id is None else None
        task_id = submitted.task_id if submitted is not None else existing_task_id
        if task_id is None:
            _fail("task-invalid")
        completed_task_id = (
            task_id
            if submitted is not None and submitted.state == "completed"
            else self._wait_for_completion(task_id, cancel_event)
        )
        archive = self._download_archive(completed_task_id, cancel_event)
        try:
            converted = convert_mineru_archive(
                archive,
                expected_page_count=page_count,
                bounds=self._conversion_bounds,
            )
        except MinerUConversionError:
            _fail("output-invalid")
        except Exception:
            _fail("output-invalid")
        provenance = self._provenance(request.source_sha256)
        return StagedParserOutput(
            source_asset_id=request.source_asset_id,
            source_sha256=request.source_sha256,
            page_count=converted.page_count,
            markdown=converted.markdown,
            resources=converted.resources,
            provenance=provenance,
        )

    def _validated_pdf(self, request: ParserRequest) -> tuple[bytes, int]:
        if not isinstance(request, ParserRequest) or request.media_type != "application/pdf":
            _fail("input-invalid")
        pdf = self._read_pdf_bytes(request)
        if not pdf or sha256_digest(pdf) != request.source_sha256:
            _fail("input-invalid")
        page_count = self._physical_page_count(pdf)
        if page_count > self._bounds.max_pages:
            _fail("input-budget")
        return pdf, page_count

    def _read_pdf_bytes(self, request: ParserRequest) -> bytes:
        chunks: list[bytes] = []
        byte_size = 0
        try:
            with request.content_ref.open() as stream:
                while True:
                    chunk = stream.read(_READ_CHUNK_BYTES)
                    if type(chunk) is not bytes:
                        _fail("input-invalid")
                    if not chunk:
                        break
                    byte_size += len(chunk)
                    if byte_size > self._bounds.max_input_bytes:
                        _fail("input-budget")
                    chunks.append(chunk)
        except MinerUAdapterError:
            raise
        except Exception:
            _fail("input-invalid")
        return b"".join(chunks)

    @staticmethod
    def _physical_page_count(pdf: bytes) -> int:
        if not pdf.startswith(b"%PDF-"):
            _fail("input-invalid")
        try:
            reader = PdfReader(io.BytesIO(pdf), strict=True)
            if reader.is_encrypted:
                _fail("input-invalid")
            page_count = len(reader.pages)
        except MinerUAdapterError:
            raise
        except Exception:
            _fail("input-invalid")
        if page_count <= 0:
            _fail("input-invalid")
        return page_count

    def _validate_health(self, cancel_event: threading.Event | None) -> None:
        try:
            health = self._service.health(
                timeout_seconds=float(self._bounds.health_timeout_seconds),
                cancel_event=cancel_event,
            )
        except Exception:
            _fail("service-unavailable")
        if (
            not isinstance(health, MinerUHealth)
            or health.status != "healthy"
            or health.release != _SUPPORTED_RELEASE
            or health.api_protocol != _SUPPORTED_PROTOCOL
        ):
            _fail("service-contract-invalid")

    def _checked_task_id(self, value: str) -> str:
        if (
            type(value) is not str
            or not value
            or len(value) > self._bounds.max_task_id_characters
            or _TASK_ID.fullmatch(value) is None
        ):
            _fail("task-invalid")
        return value

    def _checked_task(self, value: object, *, expected_task_id: str | None) -> MinerUTask:
        if not isinstance(value, MinerUTask):
            _fail("task-invalid")
        task_id = self._checked_task_id(value.task_id)
        if expected_task_id is not None and task_id != expected_task_id:
            _fail("task-invalid")
        if value.state == "failed":
            _fail("task-failed")
        if value.state not in {"pending", "processing", "completed"}:
            _fail("task-invalid")
        return value

    def _submit(self, pdf: bytes, cancel_event: threading.Event | None) -> MinerUTask:
        try:
            response = self._service.submit(
                pdf,
                profile=_SUPPORTED_PROFILE,
                timeout_seconds=float(self._bounds.submit_timeout_seconds),
                cancel_event=cancel_event,
            )
        except Exception:
            _fail("service-unavailable")
        return self._checked_task(response, expected_task_id=None)

    def _wait_for_completion(
        self,
        task_id: str,
        cancel_event: threading.Event | None,
    ) -> str:
        checked_task_id = self._checked_task_id(task_id)
        # A submit response may already be complete, but resume intentionally
        # starts with a poll because only the task ID crosses that call boundary.
        for _attempt in range(self._bounds.max_poll_attempts):
            try:
                response = self._service.poll(
                    checked_task_id,
                    timeout_seconds=float(self._bounds.poll_timeout_seconds),
                    cancel_event=cancel_event,
                )
            except Exception:
                _fail("service-unavailable")
            if response is None:
                _fail("task-missing")
            task = self._checked_task(response, expected_task_id=checked_task_id)
            if task.state == "completed":
                return checked_task_id
        _fail("poll-limit")

    def _download_archive(
        self,
        task_id: str,
        cancel_event: threading.Event | None,
    ) -> bytes:
        try:
            result = self._service.archive(
                task_id,
                timeout_seconds=float(self._bounds.archive_timeout_seconds),
                cancel_event=cancel_event,
            )
        except Exception:
            _fail("service-unavailable")
        if isinstance(result, MinerUArchiveResult) and result.state == "failed":
            _fail("task-failed")
        if (
            not isinstance(result, MinerUArchiveResult)
            or result.state != "completed"
            or type(result.payload) is not bytes
            or not result.payload
        ):
            _fail("archive-unavailable")
        return result.payload

    def _provenance(self, input_sha256: Sha256) -> ParserProvenance:
        try:
            provenance_id = self._provenance_id_factory()
            observed_at = self._clock()
            if not isinstance(provenance_id, ProvenanceId) or not isinstance(
                observed_at, UtcTimestamp
            ):
                _fail("provenance-invalid")
            return ParserProvenance(
                provenance=Provenance(
                    provenance_id=provenance_id,
                    source_kind=SourceKind.PARSER,
                    source_name=_PARSER_NAME,
                    source_record_id=None,
                    observed_at=observed_at,
                    input_sha256=input_sha256,
                    parameters_sha256=self._parameters_sha256,
                ),
                parser_version=_SUPPORTED_RELEASE,
                mode=_SUPPORTED_PROFILE,
                model_identity=self._model_identity,
            )
        except MinerUAdapterError:
            raise
        except Exception:
            _fail("provenance-invalid")


__all__ = (
    "MinerUAdapterBounds",
    "MinerUAdapterError",
    "MinerUArchiveResult",
    "MinerUHealth",
    "MinerUProtocol2Bounds",
    "MinerUProtocol2Error",
    "MinerUProtocol2ServiceClient",
    "MinerUServicePort",
    "MinerUTask",
    "OperatorManagedMinerUAdapter",
)
