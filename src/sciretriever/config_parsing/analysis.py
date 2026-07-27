from __future__ import annotations

import ipaddress
from collections.abc import Mapping
from typing import Any
from urllib.parse import urlsplit

from sciretriever.config_models import AnalysisConfig, LLMConfig, MinerUConfig

from .common import (
    boolean,
    bounded_positive,
    choice,
    config_error,
    env_name,
    nonblank,
    optional_string,
    positive_number,
    table,
)


def parse_analysis(root: Mapping[str, Any]) -> AnalysisConfig:
    analysis = table(root, "analysis", {"mineru", "llm"})
    mineru_table = table(analysis, "mineru", {
        "mode", "endpoint", "auth_env", "remote_upload", "service_version",
        "api_protocol", "backend", "model", "overall_deadline", "poll_interval",
        "max_archive_bytes", "max_json_bytes", "max_pages", "max_blocks",
        "max_spans", "max_text_characters", "max_image_bytes", "max_archive_files",
        "max_extracted_bytes", "max_file_bytes", "max_compression_ratio", "max_images",
        "max_json_depth", "max_json_elements", "max_json_string_characters",
        "max_upload_bytes", "max_attempts",
    })
    mode = "disabled" if "mode" not in mineru_table else choice(
        mineru_table["mode"],
        "analysis.mineru.mode",
        {"disabled", "loopback", "remote"},
    )
    endpoint = None if "endpoint" not in mineru_table else _fixed_origin(
        mineru_table["endpoint"],
        "analysis.mineru.endpoint",
        loopback=mode == "loopback",
    )
    auth_env = None if "auth_env" not in mineru_table else env_name(
        mineru_table["auth_env"], "analysis.mineru.auth_env"
    )
    remote_upload = False if "remote_upload" not in mineru_table else boolean(
        mineru_table["remote_upload"], "analysis.mineru.remote_upload"
    )
    service_version = str(mineru_table.get("service_version", "3.4.4"))
    api_protocol = mineru_table.get("api_protocol", 2)
    backend = str(mineru_table.get("backend", "vlm-engine"))
    model = optional_string(mineru_table, "model", "analysis.mineru")
    if (
        service_version != "3.4.4"
        or api_protocol != 2
        or isinstance(api_protocol, bool)
        or backend != "vlm-engine"
    ):
        raise config_error(
            "analysis.mineru",
            "must pin service_version 3.4.4, api_protocol 2, and backend vlm-engine",
        )
    if mode == "disabled" and (
        endpoint is not None or auth_env is not None or remote_upload or model is not None
    ):
        raise config_error("analysis.mineru", "must not configure a disabled target")
    if mode in {"loopback", "remote"} and (endpoint is None or model is None):
        raise config_error(
            "analysis.mineru", "requires endpoint and model when enabled"
        )
    if mode == "loopback" and (auth_env is not None or remote_upload):
        raise config_error(
            "analysis.mineru", "loopback mode forbids auth_env and remote_upload"
        )
    if mode == "remote" and (auth_env is None or not remote_upload):
        raise config_error(
            "analysis.mineru", "remote mode requires auth_env and remote_upload=true"
        )
    mineru = MinerUConfig(
        mode,
        endpoint,
        auth_env,
        remote_upload,
        service_version,
        2,
        backend,
        model,
        900.0 if "overall_deadline" not in mineru_table else positive_number(
            mineru_table["overall_deadline"], "analysis.mineru.overall_deadline"
        ),
        2.0 if "poll_interval" not in mineru_table else positive_number(
            mineru_table["poll_interval"], "analysis.mineru.poll_interval"
        ),
        bounded_positive(mineru_table, "max_archive_bytes", "analysis.mineru", 512 * 1024 * 1024, 2 * 1024 * 1024 * 1024),
        bounded_positive(mineru_table, "max_json_bytes", "analysis.mineru", 128 * 1024 * 1024, 512 * 1024 * 1024),
        bounded_positive(mineru_table, "max_pages", "analysis.mineru", 2000, 10_000),
        bounded_positive(mineru_table, "max_blocks", "analysis.mineru", 500_000, 2_000_000),
        bounded_positive(mineru_table, "max_spans", "analysis.mineru", 2_000_000, 10_000_000),
        bounded_positive(mineru_table, "max_text_characters", "analysis.mineru", 100_000_000, 500_000_000),
        bounded_positive(mineru_table, "max_image_bytes", "analysis.mineru", 64 * 1024 * 1024, 256 * 1024 * 1024),
        bounded_positive(mineru_table, "max_archive_files", "analysis.mineru", 10_000, 100_000),
        bounded_positive(mineru_table, "max_extracted_bytes", "analysis.mineru", 1024 * 1024 * 1024, 4 * 1024 * 1024 * 1024),
        bounded_positive(mineru_table, "max_file_bytes", "analysis.mineru", 256 * 1024 * 1024, 1024 * 1024 * 1024),
        bounded_positive(mineru_table, "max_compression_ratio", "analysis.mineru", 200, 1000),
        bounded_positive(mineru_table, "max_images", "analysis.mineru", 5000, 50_000),
        bounded_positive(mineru_table, "max_json_depth", "analysis.mineru", 100, 500),
        bounded_positive(mineru_table, "max_json_elements", "analysis.mineru", 2_000_000, 10_000_000),
        bounded_positive(mineru_table, "max_json_string_characters", "analysis.mineru", 100_000_000, 500_000_000),
        bounded_positive(mineru_table, "max_upload_bytes", "analysis.mineru", 100 * 1024 * 1024, 1024 * 1024 * 1024),
        bounded_positive(mineru_table, "max_attempts", "analysis.mineru", 3, 100),
    )
    if mineru.max_file_bytes > mineru.max_extracted_bytes:
        raise config_error(
            "analysis.mineru.max_file_bytes", "must not exceed max_extracted_bytes"
        )
    if mineru.poll_interval > mineru.overall_deadline:
        raise config_error(
            "analysis.mineru.poll_interval", "must not exceed overall_deadline"
        )
    llm_table = table(analysis, "llm", {
        "endpoint", "model", "credential_env", "timeout", "max_output_tokens",
        "max_input_characters", "max_source_units",
    })
    llm_endpoint = None if "endpoint" not in llm_table else _https_base_url(
        llm_table["endpoint"], "analysis.llm.endpoint"
    )
    llm_model = optional_string(llm_table, "model", "analysis.llm")
    credential_env = None if "credential_env" not in llm_table else env_name(
        llm_table["credential_env"], "analysis.llm.credential_env"
    )
    configured = bool(llm_table)
    if configured and (
        llm_endpoint is None or llm_model is None or credential_env is None
    ):
        raise config_error(
            "analysis.llm", "requires endpoint, model, and credential_env"
        )
    llm = LLMConfig(
        llm_endpoint,
        llm_model,
        credential_env,
        120.0 if "timeout" not in llm_table else positive_number(
            llm_table["timeout"], "analysis.llm.timeout"
        ),
        bounded_positive(llm_table, "max_output_tokens", "analysis.llm", 16_384, 131_072),
        bounded_positive(llm_table, "max_input_characters", "analysis.llm", 200_000, 2_000_000),
        bounded_positive(llm_table, "max_source_units", "analysis.llm", 5_000, 100_000),
    )
    if llm.timeout > 600:
        raise config_error("analysis.llm.timeout", "exceeds the supported bound")
    return AnalysisConfig(mineru, llm)


def _fixed_origin(value: Any, name: str, *, loopback: bool) -> str:
    endpoint = nonblank(value, name)
    parsed = urlsplit(endpoint)
    try:
        port = parsed.port
    except ValueError as error:
        raise config_error(name, "must be a fixed-origin endpoint") from error
    if (
        parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
        or not parsed.hostname
    ):
        raise config_error(name, "must be a fixed-origin endpoint")
    try:
        address = ipaddress.ip_address(parsed.hostname)
        is_loopback = address.is_loopback
    except ValueError:
        is_loopback = parsed.hostname == "localhost"
    if loopback:
        if parsed.scheme != "http" or not is_loopback:
            raise config_error(name, "must be explicit loopback HTTP in loopback mode")
    elif parsed.scheme != "https" or is_loopback or port not in (None, 443):
        raise config_error(name, "must be remote HTTPS on the default port")
    if parsed.path not in ("", "/"):
        raise config_error(name, "must contain only an origin")
    return endpoint.rstrip("/")


def _https_base_url(value: Any, name: str) -> str:
    endpoint = nonblank(value, name)
    if any(ord(character) < 33 or ord(character) == 127 for character in endpoint) or "\\" in endpoint:
        raise config_error(name, "must be a safe remote HTTPS base URL")
    parsed = urlsplit(endpoint)
    try:
        port = parsed.port
    except ValueError as error:
        raise config_error(name, "must be a safe remote HTTPS base URL") from error
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
        or port not in (None, 443)
    ):
        raise config_error(name, "must be a safe remote HTTPS base URL")
    try:
        ipaddress.ip_address(parsed.hostname)
    except ValueError:
        is_loopback = parsed.hostname == "localhost"
    else:
        raise config_error(name, "must use a DNS hostname, not an IP literal")
    segments = parsed.path.split("/")
    lowered_path = parsed.path.lower()
    if (
        is_loopback
        or "" in segments[1:-1]
        or any(segment in {".", ".."} for segment in segments)
        or any(encoded in lowered_path for encoded in ("%2e", "%2f", "%5c"))
    ):
        raise config_error(name, "must be a safe remote HTTPS base URL")
    path = parsed.path.rstrip("/")
    return f"https://{parsed.hostname.lower()}{path}"


__all__ = ("parse_analysis",)
