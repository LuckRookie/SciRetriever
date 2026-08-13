"""Load the test-owned offline transport only for explicit acceptance runs."""

from __future__ import annotations

import os

if os.environ.get("SCIRETRIEVER_TEST_PRODUCTION_FIXTURE") == "1":
    from sciretriever_acceptance_transport import install

    install()
