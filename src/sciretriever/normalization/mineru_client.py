"""Strict MinerU 3.4.4 protocol-2 asynchronous client."""

from __future__ import annotations

from dataclasses import dataclass
import http.client
import ipaddress
import json
import math
import os
import socket
import ssl
from typing import Callable, Mapping, Protocol
from urllib.parse import urlsplit, urlunsplit
from uuid import uuid4

from sciretriever.config import MinerUConfig, get_credential
from sciretriever.core.ids import validate_uuid
from sciretriever.errors import MinerUError, MinerUErrorCategory

from .mineru_contracts import MinerUHealth, MinerUResult, MinerUResultState, MinerUTask, MinerUTaskStatus


@dataclass(frozen=True, slots=True)
class MinerUHttpResponse:
    status: int
    final_url: str
    headers: Mapping[str, str]
    body: bytes


class MinerUTransport(Protocol):
    def request(
        self, method: str, url: str, *, headers: Mapping[str, str], timeout: float,
        max_bytes: int, fields: Mapping[str, str] | None = None,
        file: tuple[str, bytes, str] | None = None, address: str | None = None,
    ) -> MinerUHttpResponse: ...


class _PinnedHTTPSConnection(http.client.HTTPSConnection):
    def __init__(self, hostname: str, address: str, port: int, timeout: float) -> None:
        context = ssl.create_default_context()
        super().__init__(hostname, port=port, timeout=timeout, context=context)
        self._address = address
        self._tls_context = context

    def connect(self) -> None:
        raw_socket = socket.create_connection((self._address, self.port), self.timeout)
        try:
            self.sock = self._tls_context.wrap_socket(raw_socket, server_hostname=self.host)
        except Exception:
            raw_socket.close()
            raise


class RequestsMinerUTransport:
    """Pinned-address HTTP transport with no proxy or redirect behavior."""

    @staticmethod
    def _multipart(fields: Mapping[str, str], file: tuple[str, bytes, str]) -> tuple[bytes, str]:
        filename, payload, media_type = file
        if not filename.isascii() or not filename or any(character in filename for character in '\r\n\"/\\'):
            raise MinerUError(MinerUErrorCategory.CONFIGURATION, "MinerU upload filename is invalid")
        boundary = f"sciretriever-{uuid4().hex}"
        chunks: list[bytes] = []
        for key, value in fields.items():
            chunks.append(
                f'--{boundary}\r\nContent-Disposition: form-data; name="{key}"\r\n\r\n{value}\r\n'.encode("ascii")
            )
        chunks.append(
            f'--{boundary}\r\nContent-Disposition: form-data; name="files"; filename="{filename}"\r\nContent-Type: {media_type}\r\n\r\n'.encode("ascii")
        )
        chunks.extend((payload, f"\r\n--{boundary}--\r\n".encode("ascii")))
        return b"".join(chunks), boundary

    def request(
        self, method: str, url: str, *, headers: Mapping[str, str], timeout: float,
        max_bytes: int, fields: Mapping[str, str] | None = None,
        file: tuple[str, bytes, str] | None = None, address: str | None = None,
    ) -> MinerUHttpResponse:
        parsed = urlsplit(url)
        hostname = parsed.hostname or ""
        if address is None:
            raise MinerUError(MinerUErrorCategory.TRANSPORT, "MinerU request has no pinned address")
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
        target = urlunsplit(("", "", parsed.path or "/", parsed.query, ""))
        request_headers = dict(headers)
        request_headers["Host"] = parsed.netloc
        body: bytes | None = None
        if file is not None:
            body, boundary = self._multipart(fields or {}, file)
            request_headers["Content-Type"] = f"multipart/form-data; boundary={boundary}"
            request_headers["Content-Length"] = str(len(body))
        connection: http.client.HTTPConnection
        if parsed.scheme == "https":
            connection = _PinnedHTTPSConnection(hostname, address, port, timeout)
        else:
            connection = http.client.HTTPConnection(address, port=port, timeout=timeout)
        try:
            connection.request(method, target, body=body, headers=request_headers)
            response = connection.getresponse()
            response_headers = {key.lower(): value for key, value in response.getheaders()}
            declared = response_headers.get("content-length")
            if declared is not None and (not declared.isascii() or not declared.isdecimal() or int(declared) > max_bytes):
                raise MinerUError(MinerUErrorCategory.PROTOCOL, "MinerU response has invalid length")
            chunks: list[bytes] = []
            size = 0
            while True:
                chunk = response.read(min(64 * 1024, max_bytes - size + 1))
                if not chunk:
                    break
                size += len(chunk)
                if size > max_bytes:
                    raise MinerUError(MinerUErrorCategory.TRANSPORT, "MinerU response exceeds byte bound")
                chunks.append(chunk)
            if declared is not None and size != int(declared):
                raise MinerUError(MinerUErrorCategory.PROTOCOL, "MinerU response length mismatch")
            return MinerUHttpResponse(response.status, url, response_headers, b"".join(chunks))
        except MinerUError:
            raise
        except (OSError, http.client.HTTPException, ssl.SSLError) as error:
            raise MinerUError(MinerUErrorCategory.TRANSPORT, "MinerU transport failed", retryable=True) from error
        finally:
            connection.close()


Resolver = Callable[[str], tuple[str, ...]]


def _resolve(hostname: str) -> tuple[str, ...]:
    return tuple(sorted({str(item[4][0]) for item in socket.getaddrinfo(hostname, 443)}))


class MinerUClient:
    def __init__(
        self, config: MinerUConfig, *, transport: MinerUTransport | None = None,
        resolver: Resolver = _resolve, env: Mapping[str, str] | None = None,
    ) -> None:
        if config.mode == "disabled" or config.endpoint is None:
            raise MinerUError(MinerUErrorCategory.CONFIGURATION, "MinerU connector is disabled")
        parsed = urlsplit(config.endpoint)
        try:
            port = parsed.port
        except ValueError as error:
            raise MinerUError(MinerUErrorCategory.CONFIGURATION, "MinerU endpoint is invalid") from error
        try:
            address = ipaddress.ip_address(parsed.hostname or "")
            loopback = address.is_loopback
        except ValueError:
            loopback = parsed.hostname == "localhost"
        valid_origin = (
            parsed.hostname is not None and parsed.username is None and parsed.password is None
            and parsed.path in {"", "/"} and not parsed.query and not parsed.fragment
        )
        if config.mode == "loopback":
            valid_origin = valid_origin and parsed.scheme == "http" and loopback
        elif config.mode == "remote":
            valid_origin = valid_origin and parsed.scheme == "https" and not loopback and port in {None, 443}
        else:
            valid_origin = False
        if not valid_origin:
            raise MinerUError(MinerUErrorCategory.CONFIGURATION, "MinerU endpoint violates origin policy")
        if config.mode == "remote":
            if not config.remote_upload:
                raise MinerUError(MinerUErrorCategory.CONFIGURATION, "MinerU remote upload is not authorized")
            if config.auth_env is None:
                raise MinerUError(MinerUErrorCategory.CONFIGURATION, "MinerU remote authentication is not configured")
        self.config = config
        self.transport = transport or RequestsMinerUTransport()
        self._resolver = resolver
        self._env = os.environ if env is None else env

    def _headers(self) -> Mapping[str, str]:
        headers = {"Accept": "application/json"}
        if self.config.mode == "remote":
            if self.config.auth_env is None:
                raise MinerUError(MinerUErrorCategory.CONFIGURATION, "MinerU remote authentication is not configured")
            credential = get_credential(self.config.auth_env, env=self._env)
            if credential is None:
                raise MinerUError(MinerUErrorCategory.AUTHENTICATION, "MinerU authentication is unavailable")
            headers["Authorization"] = f"Bearer {credential}"
        return headers

    def _url(self, path: str) -> tuple[str, str]:
        assert self.config.endpoint is not None
        url = f"{self.config.endpoint}{path}"
        parsed = urlsplit(url)
        try:
            addresses = self._resolver(parsed.hostname or "")
        except OSError as error:
            raise MinerUError(MinerUErrorCategory.TRANSPORT, "MinerU DNS resolution failed", retryable=True) from error
        if not addresses:
            raise MinerUError(MinerUErrorCategory.TRANSPORT, "MinerU DNS resolution returned no addresses", retryable=True)
        for value in addresses:
            try:
                address = ipaddress.ip_address(value)
            except ValueError as error:
                raise MinerUError(MinerUErrorCategory.TRANSPORT, "MinerU DNS returned an invalid address") from error
            allowed = address.is_global if self.config.mode == "remote" else address.is_loopback
            if not allowed:
                raise MinerUError(MinerUErrorCategory.TRANSPORT, "MinerU DNS returned a forbidden address")
        return url, addresses[0]

    def _request(
        self, method: str, path: str, *, timeout: float, max_bytes: int,
        fields: Mapping[str, str] | None = None, file: tuple[str, bytes, str] | None = None,
    ) -> MinerUHttpResponse:
        url, address = self._url(path)
        response = self.transport.request(
            method, url, headers=self._headers(), timeout=timeout, max_bytes=max_bytes,
            fields=fields, file=file, address=address,
        )
        if response.status in {301, 302, 303, 307, 308}:
            raise MinerUError(MinerUErrorCategory.PROTOCOL, "MinerU redirect rejected")
        if response.final_url != url:
            raise MinerUError(MinerUErrorCategory.PROTOCOL, "MinerU response URL mismatch")
        return response

    @staticmethod
    def _json(response: MinerUHttpResponse) -> object:
        try:
            def object_pairs(pairs: list[tuple[str, object]]) -> dict[str, object]:
                result: dict[str, object] = {}
                for key, item in pairs:
                    if key in result:
                        raise ValueError("duplicate JSON key")
                    result[key] = item
                return result

            def reject_constant(_: str) -> object:
                raise ValueError("non-finite JSON number")

            def finite_float(value: str) -> float:
                parsed = float(value)
                if not math.isfinite(parsed):
                    raise ValueError("non-finite JSON number")
                return parsed

            return json.loads(
                response.body, object_pairs_hook=object_pairs,
                parse_constant=reject_constant, parse_float=finite_float,
            )
        except (UnicodeDecodeError, ValueError) as error:
            raise MinerUError(MinerUErrorCategory.PROTOCOL, "MinerU returned invalid JSON") from error

    @staticmethod
    def _mapping(value: object) -> Mapping[str, object]:
        if not isinstance(value, dict) or not all(isinstance(key, str) for key in value):
            raise MinerUError(MinerUErrorCategory.PROTOCOL, "MinerU returned an invalid object")
        return value

    def health(self, timeout: float) -> MinerUHealth:
        response = self._request("GET", "/health", timeout=timeout, max_bytes=64 * 1024)
        if response.status != 200:
            raise MinerUError(MinerUErrorCategory.PROTOCOL, "MinerU health check failed")
        data = self._mapping(self._json(response))
        status = data.get("status")
        version = data.get("version")
        protocol = data.get("protocol_version")
        if not isinstance(status, str) or not isinstance(version, str) or not isinstance(protocol, int) or isinstance(protocol, bool):
            raise MinerUError(MinerUErrorCategory.PROTOCOL, "MinerU health response is invalid")
        health = MinerUHealth(status, version, protocol)
        if health != MinerUHealth("healthy", self.config.service_version, self.config.api_protocol):
            raise MinerUError(MinerUErrorCategory.PROTOCOL, "MinerU health contract mismatch")
        return health

    def submit(self, _filename: str, pdf: bytes, timeout: float) -> MinerUTask:
        if len(pdf) > self.config.max_upload_bytes:
            raise MinerUError(MinerUErrorCategory.CONFIGURATION, "MinerU PDF exceeds upload byte bound")
        fields = {
            "backend": "vlm-engine", "parse_method": "auto", "formula_enable": "true",
            "table_enable": "true", "image_analysis": "true", "return_md": "false",
            "return_middle_json": "true", "return_model_output": "true",
            "return_content_list": "true", "return_images": "true",
            "response_format_zip": "true", "return_original_file": "false",
            "client_side_output_generation": "false",
        }
        response = self._request(
            "POST", "/tasks", timeout=timeout, max_bytes=64 * 1024,
            fields=fields, file=("document.pdf", pdf, "application/pdf"),
        )
        if response.status != 202:
            raise MinerUError(MinerUErrorCategory.PROTOCOL, "MinerU task submission failed")
        return self._task(self._json(response))

    def _task(self, value: object) -> MinerUTask:
        data = self._mapping(value)
        task_id = data.get("task_id")
        status = data.get("status")
        if not isinstance(task_id, str) or not isinstance(status, str):
            raise MinerUError(MinerUErrorCategory.PROTOCOL, "MinerU task response is incomplete")
        try:
            canonical = validate_uuid(task_id, "task_id")
            parsed_status = MinerUTaskStatus(status)
        except (TypeError, ValueError) as error:
            raise MinerUError(MinerUErrorCategory.PROTOCOL, "MinerU task response is invalid") from error
        return MinerUTask(canonical, parsed_status)

    def status(self, task_id: str, timeout: float) -> MinerUTask | None:
        task_id = validate_uuid(task_id, "task_id")
        response = self._request("GET", f"/tasks/{task_id}", timeout=timeout, max_bytes=64 * 1024)
        if response.status == 404:
            return None
        if response.status != 200:
            raise MinerUError(MinerUErrorCategory.PROTOCOL, "MinerU task status failed")
        task = self._task(self._json(response))
        if task.task_id != task_id:
            raise MinerUError(MinerUErrorCategory.PROTOCOL, "MinerU task identity mismatch")
        return task

    def result(self, task_id: str, timeout: float) -> MinerUResult:
        task_id = validate_uuid(task_id, "task_id")
        response = self._request(
            "GET", f"/tasks/{task_id}/result", timeout=timeout,
            max_bytes=self.config.max_archive_bytes,
        )
        if response.status == 202:
            return MinerUResult(MinerUResultState.PENDING)
        if response.status == 404:
            return MinerUResult(MinerUResultState.EXPIRED)
        if response.status == 409:
            raise MinerUError(MinerUErrorCategory.REMOTE_FAILED, "MinerU task failed")
        if response.status != 200:
            raise MinerUError(MinerUErrorCategory.PROTOCOL, "MinerU result request failed")
        if not response.body:
            raise MinerUError(MinerUErrorCategory.PROTOCOL, "MinerU result archive is empty")
        return MinerUResult(MinerUResultState.COMPLETED, response.body)


__all__ = ("MinerUClient", "MinerUHttpResponse", "MinerUTransport", "RequestsMinerUTransport")
