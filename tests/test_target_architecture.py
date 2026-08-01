from __future__ import annotations

from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from scripts import architecture_checks


def write_module(source_root: Path, relative: str, source: str) -> None:
    path = source_root / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(source, encoding="utf-8")


def scan_fixture(relative: str, source: str) -> tuple[str, ...]:
    with TemporaryDirectory(prefix="sciretriever-target-architecture-") as temporary:
        source_root = Path(temporary)
        write_module(source_root, relative, source)
        return architecture_checks.find_architecture_violations(
            source_root,
            frozenset(),
        )


class TargetArchitectureTests(unittest.TestCase):
    def test_passing_target_graph_has_zero_violations(self) -> None:
        with TemporaryDirectory(prefix="sciretriever-target-architecture-") as temporary:
            # Given every target layer uses only its declared public dependencies
            source_root = Path(temporary)
            modules = {
                "kernel/contracts.py": "class OpaqueExtensionRecordStorePort: pass\n",
                "bibliography/api.py": "from sciretriever.kernel.ids import WorkId\n",
                "collection/service.py": (
                    "from sciretriever.kernel.ids import CollectionId\n"
                    "from sciretriever.bibliography.api import BibliographyApi\n"
                ),
                "content/api.py": "from sciretriever.kernel.ids import WorkVersionId\n",
                "interoperability/query.py": (
                    "from sciretriever.kernel.ids import WorkId\n"
                    "from sciretriever.bibliography.api import BibliographyApi\n"
                ),
                "batching/advancement.py": (
                    "from sciretriever.kernel.ids import BatchRunId\n"
                    "from sciretriever.collection.api import CollectionApi\n"
                    "from sciretriever.bibliography.api import BibliographyApi\n"
                    "from sciretriever.content.api import ContentApi\n"
                    "from sciretriever.interoperability.api import InteroperabilityApi\n"
                ),
                "literature_store/sqlite/extensions.py": (
                    "from typing import Annotated\n"
                    "from sciretriever.kernel.contracts import "
                    "OpaqueExtensionRecordStorePort\n"
                    "from sciretriever.bibliography.ports import BibliographyRepositoryPort\n"
                    "class OpaqueExtensionRecordStore(OpaqueExtensionRecordStorePort):\n"
                    "    def put(self, payload: Annotated[str, "
                    "'sciretriever:opaque-extension-payload']): return payload\n"
                ),
                "adapters/metadata/provider.py": (
                    "from sciretriever.collection.ports import MetadataDiscoveryPort\n"
                ),
                "extensions/packaging/service.py": (
                    "from sciretriever.kernel.contracts import "
                    "OpaqueExtensionRecordStorePort\n"
                ),
                "runtime/bootstrap.py": (
                    "from sciretriever.collection.api import CollectionApi\n"
                    "from sciretriever.literature_store.api import LiteratureStore\n"
                    "from sciretriever.adapters.metadata.provider import Provider\n"
                    "from sciretriever.extensions.packaging.service import PackageService\n"
                ),
                "runtime/config.py": "import os\nimport tomllib\nVALUE = os.getenv('X')\n",
            }
            for relative, source in modules.items():
                write_module(source_root, relative, source)

            # When the target architecture gate scans the complete fixture
            violations = architecture_checks.find_architecture_violations(
                source_root,
                frozenset(),
            )

        # Then the declared graph and generic opaque store are accepted
        self.assertEqual(violations, ())

    def test_each_forbidden_target_edge_has_a_precise_violation(self) -> None:
        cases = {
            "undeclared dependency": (
                "content/bad.py",
                "from sciretriever.bibliography.api import BibliographyApi\n",
                "content/bad.py: target dependency content -> bibliography is forbidden",
            ),
            "sqlalchemy outside store": (
                "content/bad.py",
                "from sqlalchemy import Table\n",
                "content/bad.py: SQLAlchemy is restricted to literature_store",
            ),
            "sdk outside adapters": (
                "content/bad.py",
                "from openai import OpenAI\n",
                "content/bad.py: vendor SDK openai is restricted to adapters",
            ),
            "environment outside runtime": (
                "content/bad.py",
                "import os\nVALUE = os.getenv('TOKEN')\n",
                "content/bad.py: environment reads are restricted to runtime",
            ),
            "toml outside runtime": (
                "content/bad.py",
                "import tomllib\n",
                "content/bad.py: TOML reads are restricted to runtime",
            ),
            "private cross-module import": (
                "collection/bad.py",
                "from sciretriever.bibliography.service import BibliographyService\n",
                "collection/bad.py: cross-module import bibliography.service is private",
            ),
            "kernel to extension": (
                "kernel/bad.py",
                "from sciretriever.extensions.packaging import PackageService\n",
                "kernel/bad.py: target dependency kernel -> extensions is forbidden",
            ),
            "core to runtime": (
                "bibliography/bad.py",
                "from sciretriever.runtime.config import Config\n",
                "bibliography/bad.py: target dependency bibliography -> runtime is forbidden",
            ),
            "extension to store": (
                "extensions/packaging/bad.py",
                "from sciretriever.literature_store.api import LiteratureStore\n",
                (
                    "extensions/packaging/bad.py: target dependency extensions -> "
                    "literature_store is forbidden"
                ),
            ),
            "package schema in store": (
                "literature_store/sqlite/schema.py",
                "class DocumentPackageSchema: pass\n",
                (
                    "literature_store/sqlite/schema.py: literature_store must remain "
                    "opaque to Package schemas"
                ),
            ),
            "package import in store": (
                "literature_store/bad.py",
                "from sciretriever.extensions.packaging.model import PackagePreparation\n",
                (
                    "literature_store/bad.py: literature_store must not import Package "
                    "implementation sciretriever.extensions.packaging.model"
                ),
            ),
            "business artifact write": (
                "content/bad.py",
                "from pathlib import Path\nPath('artifact').write_bytes(b'x')\n",
                "content/bad.py: business modules must not write artifact files",
            ),
            "business publisher payload in store": (
                "literature_store/publisher_contracts.py",
                "from dataclasses import dataclass\n@dataclass\nclass TargetProjection:\n    target_id: str\n",
                "literature_store/publisher_contracts.py: literature_store must not declare business publisher payload TargetProjection",
            ),
        }
        for name, (relative, source, expected) in cases.items():
            with self.subTest(name=name):
                # Given one otherwise isolated forbidden target edge
                # When the architecture gate scans it
                violations = scan_fixture(relative, source)

                # Then that edge has one stable, actionable diagnostic
                self.assertEqual(violations, (expected,))

    def test_generic_opaque_store_does_not_trigger_package_schema_rule(self) -> None:
        # Given literature_store implements only the kernel-owned opaque port
        source = (
            "from typing import Annotated\n"
            "from sciretriever.kernel.contracts import "
            "OpaqueExtensionRecord, OpaqueExtensionRecordStorePort\n"
            "class SqliteOpaqueExtensionRecordStore"
            "(OpaqueExtensionRecordStorePort):\n"
            "    table_name = 'opaque_extension_records'\n"
            "    def put(self, payload: Annotated[str, "
            "'sciretriever:opaque-extension-payload']): return payload\n"
        )

        # When the architecture gate scans the implementation
        violations = scan_fixture("literature_store/sqlite/extensions.py", source)

        # Then generic payload storage remains allowed
        self.assertEqual(violations, ())

    def test_unknown_root_is_rejected_instead_of_routed_as_legacy(self) -> None:
        # Given an unclassified package containing an otherwise forbidden dependency
        # When the integrated gate scans it
        violations = scan_fixture("rogue/bad.py", "from sqlalchemy import Table\n")

        # Then root classification fails before the package can bypass target policy
        self.assertEqual(
            violations,
            ("rogue/bad.py: unclassified architecture root rogue",),
        )

    def test_temporary_legacy_allowance_contains_only_importable_approved_roots(self) -> None:
        # Given the repository source tree and temporary legacy policy
        source_root = Path(__file__).resolve().parents[1] / "src" / "sciretriever"

        # When each allowance entry is resolved as a package root
        stale = tuple(
            package
            for package in sorted(architecture_checks.TEMPORARY_LEGACY_PACKAGES)
            if not (source_root / package / "__init__.py").is_file()
        )

        # Then no removed or non-importable package remains allowlisted
        self.assertNotIn("enrichment", architecture_checks.TEMPORARY_LEGACY_PACKAGES)
        self.assertEqual(stale, ())

    def test_literature_store_cannot_dispatch_and_deserialize_opaque_payload(self) -> None:
        source = (
            "import json\nfrom typing import Annotated\n"
            "from sciretriever.kernel.extensions import OpaqueExtensionRecordStorePort\n"
            "def decode(namespace: str, payload_json: Annotated[str, "
            "'sciretriever:opaque-extension-payload']):\n"
            "    if namespace == 'package':\n"
            "        return json.loads(payload_json)\n"
            "    return None\n"
        )

        violations = scan_fixture("literature_store/opaque.py", source)

        self.assertEqual(
            violations,
            (
                "literature_store/opaque.py: literature_store must not deserialize "
                "or interpret opaque extension payloads",
            ),
        )

    def test_benign_package_name_and_artifact_read_are_accepted(self) -> None:
        with TemporaryDirectory(prefix="sciretriever-target-architecture-") as temporary:
            # Given a non-schema helper name and a read-only business file access
            source_root = Path(temporary)
            write_module(
                source_root,
                "literature_store/helpers.py",
                "class PackageDeliveryCounter: pass\n",
            )
            write_module(
                source_root,
                "content/reader.py",
                "from pathlib import Path\nDATA = Path('input').open('rb').read()\n",
            )

            # When the target architecture gate scans both benign shapes
            violations = architecture_checks.find_architecture_violations(
                source_root,
                frozenset(),
            )

        # Then neither name substrings nor read modes produce false violations
        self.assertEqual(violations, ())

    def test_malformed_target_module_fails_closed(self) -> None:
        # Given malformed Python in a target module
        # When the architecture gate scans it
        violations = scan_fixture("content/broken.py", "def broken(:\n")

        # Then the parse failure is observable and cannot report success
        self.assertEqual(len(violations), 1)
        self.assertTrue(violations[0].startswith("content/broken.py: cannot parse:"))

    def test_temporary_legacy_allowance_is_explicit_and_target_disjoint(self) -> None:
        # Given the temporary pre-cutover package allowance
        legacy = architecture_checks.TEMPORARY_LEGACY_PACKAGES

        # When its scope is inspected
        overlap = legacy & architecture_checks.TARGET_PACKAGES

        # Then it names legacy roots without weakening any target package
        self.assertIn("core", legacy)
        self.assertIn("catalog", legacy)
        self.assertEqual(overlap, frozenset())


if __name__ == "__main__":
    unittest.main()
