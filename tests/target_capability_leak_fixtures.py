from __future__ import annotations


FORBIDDEN_CONTRACT_FIXTURES = (
    ("vendor DTO", "from vendor import VendorWork as Neutral\nclass Port:\n    def search(self) -> Neutral: ...\n"),
    ("MinerU wire", "class Port:\n    def parse(self, value: MinerUTaskResponse) -> str: ...\n"),
    ("OpenAI object", "from openai import OpenAI as ModelClient\nclass Port:\n    def run(self, value: ModelClient) -> str: ...\n"),
    ("Anthropic object", "from anthropic import Message as Reply\nclass Port:\n    def run(self) -> Reply: ...\n"),
    ("Playwright object", "from playwright.sync_api import Page as BrowserPage\nclass Port:\n    def run(self, page: BrowserPage) -> str: ...\n"),
    ("ORM row", "from sqlalchemy.engine import Row as DatabaseRow\nclass Port:\n    def load(self) -> DatabaseRow: ...\n"),
    ("absolute Path", "from pathlib import Path as AbsolutePath\nclass Port:\n    def load(self, path: AbsolutePath) -> bytes: ...\n"),
    ("arbitrary dictionary", "from typing import Dict as Payload\nclass Port:\n    def load(self) -> Payload[str, str]: ...\n"),
    ("quoted Path", "from pathlib import Path\nclass Port:\n    def load(self, value: 'Path') -> bytes: ...\n"),
    ("nested quoted vendor mapping", "from typing import Mapping\nfrom vendor import VendorWork\nclass Port:\n    def load(self) -> 'tuple[Mapping[str, VendorWork], ...]': ...\n"),
    ("subscript alias", "from pathlib import Path\nLeak = tuple[Path, ...]\nclass Port:\n    def load(self) -> Leak: ...\n"),
    ("two-level union alias", "from pathlib import Path as P\nFirst = P | None\nSecond = tuple[First, ...]\nclass Port:\n    def load(self) -> Second: ...\n"),
    ("annotated alias", "from pathlib import Path\nfrom typing import Annotated\nLeak = Annotated[tuple[Path, ...], 'safe-metadata']\nclass Port:\n    def load(self) -> Leak: ...\n"),
    ("vendor subclass", "from vendor import VendorWork\nclass NeutralWork(VendorWork): pass\nclass Port:\n    def search(self) -> NeutralWork: ...\n"),
    ("transitive ORM subclass", "from sqlalchemy.engine import Row\nclass First(Row): pass\nclass Second(First): pass\nclass Port:\n    def load(self) -> Second: ...\n"),
)

MALFORMED_FORWARD_REFERENCE_FIXTURES = (
    "class Port:\n    def load(self) -> 'tuple[': ...\n",
    "class Port:\n    def load(self) -> 'Path |': ...\n",
)

ALLOWED_CONTRACT_FIXTURES = (
    (
        "from typing import Protocol, Sequence\n"
        "from sciretriever.kernel.paths import RelativeArtifactPath\n"
        "class Port(Protocol):\n"
        "    def load(self, paths: Sequence[RelativeArtifactPath]) -> bytes: ...\n"
    ),
    "First = Second\nSecond = First\nclass Port:\n    def load(self) -> First: ...\n",
    "class NeutralRecord: pass\nclass Port:\n    def load(self) -> 'NeutralRecord': ...\n",
    "from typing import Annotated\nclass NeutralRecord: pass\nAlias = Annotated[NeutralRecord | None, 'Path is metadata only']\nclass Port:\n    def load(self) -> Alias: ...\n",
    "from typing import Literal\nAlias = Literal['Path']\nclass Port:\n    def load(self) -> Alias: ...\n",
)
