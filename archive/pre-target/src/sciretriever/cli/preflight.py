"""Side-effect-free acquisition preflight CLI."""

from __future__ import annotations

import argparse
import json
import sys

from sciretriever.acquisition.preflight import run_preflight
from sciretriever.acquisition.transport import UrllibAcquisitionTransport
from sciretriever.acquisition.url_policy import UrlPolicy
from sciretriever.config import SciRetrieverConfig


def configure_parser(parser: argparse.ArgumentParser) -> None:
    parser.description = "Validate foreground acquisition policy without downloading a response body."
    parser.add_argument("--url", metavar="HTTPS_URL", help="direct URL used only for headers readiness")


def run(args: argparse.Namespace) -> int:
    config: SciRetrieverConfig | None = getattr(args, "_loaded_config", None)
    if config is None:
        print("sciretriever: error: preflight requires a selected config file", file=sys.stderr)
        return 2
    def transport_factory(policy: UrlPolicy, max_bytes: int) -> UrllibAcquisitionTransport:
        return UrllibAcquisitionTransport(policy, max_bytes=max_bytes)

    report = run_preflight(
        config,
        direct_url=args.url,
        transport_factory=transport_factory,
    )
    print(json.dumps(report.to_dict(), sort_keys=True, separators=(",", ":"), ensure_ascii=True))
    return 0 if report.status == "ready" else 1


__all__ = ("configure_parser", "run")
