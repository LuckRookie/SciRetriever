"""Repository-root entry point for SciRetriever."""

import sys
from pathlib import Path


SRC = Path(__file__).resolve().parent / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from sciretriever.cli.main import main


if __name__ == "__main__":
    raise SystemExit(main())
