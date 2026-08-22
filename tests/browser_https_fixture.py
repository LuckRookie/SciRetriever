"""Neutral local HTTPS helpers shared by controlled Browser acceptance tests."""

from __future__ import annotations

import io
import os
import subprocess
from pathlib import Path

from PyPDF2 import PdfWriter

HOSTNAME = "publisher.sciretriever.test"


def certificate(root: Path, *, hostname: str = HOSTNAME) -> tuple[Path, Path]:
    """Create a one-day test CA/server certificate for one synthetic hostname."""

    key = root / "fixture-key.pem"
    certificate_path = root / "fixture-cert.pem"
    config = root / "openssl.cnf"
    config.write_text(
        "\n".join(
            (
                "[req]",
                "distinguished_name = subject",
                "x509_extensions = extensions",
                "prompt = no",
                "[subject]",
                f"CN = {hostname}",
                "[extensions]",
                f"subjectAltName = DNS:{hostname}",
                "basicConstraints = critical,CA:TRUE",
                "keyUsage = critical,digitalSignature,keyEncipherment,keyCertSign",
                "extendedKeyUsage = serverAuth",
                "",
            )
        ),
        encoding="utf-8",
    )
    result = subprocess.run(
        (
            "openssl",
            "req",
            "-x509",
            "-newkey",
            "rsa:2048",
            "-nodes",
            "-sha256",
            "-days",
            "1",
            "-keyout",
            os.fspath(key),
            "-out",
            os.fspath(certificate_path),
            "-config",
            os.fspath(config),
        ),
        cwd=root,
        check=False,
        capture_output=True,
        text=False,
        timeout=30,
    )
    if result.returncode != 0:
        raise RuntimeError("local Browser fixture certificate generation failed")
    key.chmod(0o600)
    certificate_path.chmod(0o600)
    return certificate_path, key


def pdf() -> bytes:
    """Return the smallest valid one-page PDF used by Browser fixtures."""

    output = io.BytesIO()
    writer = PdfWriter()
    writer.add_blank_page(width=72, height=72)
    writer.write(output)
    return output.getvalue()


__all__ = ("HOSTNAME", "certificate", "pdf")
