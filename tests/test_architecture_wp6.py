from __future__ import annotations

from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from scripts import architecture_checks


REPOSITORY = Path(__file__).resolve().parents[1]


def write_module(source_root: Path, relative: str, source: str) -> None:
    module = source_root / relative
    module.parent.mkdir(parents=True, exist_ok=True)
    module.write_text(source, encoding="utf-8")


class ArchitectureWp6CharacterizationTests(unittest.TestCase):
    def test_current_repository_architecture_is_accepted(self) -> None:
        # Given the current product source tree
        source_root = REPOSITORY / "src" / "sciretriever"

        # When the architecture gate runs
        violations = architecture_checks.find_architecture_violations(source_root)

        # Then no existing boundary is rejected
        self.assertEqual(violations, ())

    def test_current_core_forbidden_import_is_rejected(self) -> None:
        # Given a synthetic core module importing catalog
        with TemporaryDirectory(prefix="sciretriever-wp6-architecture-") as temporary:
            source_root = Path(temporary)
            write_module(
                source_root,
                "core/bad.py",
                "from sciretriever.catalog import Catalog\n",
            )

            # When the architecture gate runs
            violations = architecture_checks.find_architecture_violations(
                source_root,
                frozenset(),
            )

        # Then the existing dependency rule rejects it
        self.assertEqual(
            violations,
            ("core/bad.py: core must not import sciretriever.catalog",),
        )

    def test_wp6_gate_rejects_concrete_provider_imports(self) -> None:
        # Given expansion and references modules coupled to concrete providers
        with TemporaryDirectory(prefix="sciretriever-wp6-architecture-") as temporary:
            source_root = Path(temporary)
            write_module(
                source_root,
                "expansion/service.py",
                "from sciretriever.integrations.openalex import OpenAlexClient\n",
            )
            write_module(
                source_root,
                "references/resolver.py",
                "from sciretriever.discovery.providers.base import Provider\n",
            )

            # When the WP6 architecture gate runs
            violations = architecture_checks.find_architecture_violations(
                source_root,
                frozenset(),
            )

        # Then both concrete-provider dependencies are rejected
        self.assertEqual(len(violations), 2)
        self.assertTrue(all("concrete provider" in item for item in violations))

    def test_wp6_gate_rejects_reverse_dependencies(self) -> None:
        # Given core and catalog modules importing WP6 workflows or providers
        with TemporaryDirectory(prefix="sciretriever-wp6-architecture-") as temporary:
            source_root = Path(temporary)
            write_module(
                source_root,
                "core/bad.py",
                "from sciretriever.expansion import ExpansionService\n",
            )
            write_module(
                source_root,
                "catalog/bad.py",
                "from sciretriever.references import ReferenceResolver\n",
            )

            # When the WP6 architecture gate runs
            violations = architecture_checks.find_architecture_violations(
                source_root,
                frozenset(),
            )

        # Then both reverse dependencies are rejected
        self.assertEqual(len(violations), 2)

    def test_wp6_gate_rejects_retired_architecture_shapes(self) -> None:
        cases = {
            "catalog/expansion_status.py": "EXPANSION_STATUS = 'pending'\n",
            "expansion/scheduler.py": "class ExpansionScheduler: pass\n",
            "catalog/migrations/v2.py": "def migrate(): pass\n",
            "config/compat.py": "def load_legacy(): pass\n",
        }
        for relative, source in cases.items():
            with self.subTest(relative=relative), TemporaryDirectory(
                prefix="sciretriever-wp6-architecture-"
            ) as temporary:
                # Given a forbidden status, scheduler, migration, or compatibility module
                source_root = Path(temporary)
                write_module(source_root, relative, source)

                # When the WP6 architecture gate runs
                violations = architecture_checks.find_architecture_violations(
                    source_root,
                    frozenset(),
                )

                # Then the retired architecture shape is rejected
                self.assertTrue(any("WP6 forbids" in item for item in violations))

    def test_wp6_gate_rejects_second_parser_and_package_builder(self) -> None:
        # Given non-owner modules parsing TOML and constructing a package
        with TemporaryDirectory(prefix="sciretriever-wp6-architecture-") as temporary:
            source_root = Path(temporary)
            write_module(source_root, "cli/parser.py", "import tomllib\n")
            write_module(
                source_root,
                "cli/export.py",
                "from sciretriever.core.package import DocumentPackage\n"
                "package = DocumentPackage()\n",
            )

            # When the WP6 architecture gate runs
            violations = architecture_checks.find_architecture_violations(
                source_root,
                frozenset(),
            )

        # Then ownership violations are rejected independently
        self.assertTrue(any("config parser" in item for item in violations))
        self.assertTrue(any("package construction" in item for item in violations))

    def test_wp6_gate_accepts_config_loader_as_the_toml_owner(self) -> None:
        with TemporaryDirectory(prefix="sciretriever-wp6-architecture-") as temporary:
            source_root = Path(temporary)
            write_module(source_root, "config_loader.py", "import tomllib\n")

            violations = architecture_checks.find_architecture_violations(
                source_root,
                frozenset(),
            )

        self.assertEqual(violations, ())

    def test_wp6_gate_rejects_forbidden_schema_declarations(self) -> None:
        cases = {
            "catalog/core_table.py": (
                "from sqlalchemy import MetaData, Table\n"
                "status = Table('expansion_status', MetaData())\n"
            ),
            "catalog/declarative.py": (
                "class CompletionState:\n"
                "    __tablename__ = 'completion_status'\n"
            ),
        }
        for relative, source in cases.items():
            with self.subTest(relative=relative), TemporaryDirectory(
                prefix="sciretriever-wp6-architecture-"
            ) as temporary:
                # Given a SQLAlchemy Core or declarative forbidden table
                source_root = Path(temporary)
                write_module(source_root, relative, source)
                before = (source_root / relative).read_bytes()

                # When the architecture gate scans declarations
                violations = architecture_checks.find_architecture_violations(
                    source_root,
                    frozenset(),
                )
                after = (source_root / relative).read_bytes()

                # Then the schema declaration is rejected independent of its path
                self.assertEqual(after, before)
                self.assertTrue(any("forbidden WP6 schema table" in item for item in violations))

    def test_wp6_gate_accepts_benign_schema_text_and_table(self) -> None:
        # Given an ordinary table plus benign status columns, strings, and comments
        with TemporaryDirectory(prefix="sciretriever-wp6-architecture-") as temporary:
            source_root = Path(temporary)
            write_module(
                source_root,
                "catalog/models.py",
                "from sqlalchemy import Column, MetaData, String, Table\n"
                "# scheduler task status is descriptive text only\n"
                "message = 'completion_status is not a declaration'\n"
                "works = Table('works', MetaData(), Column('status', String))\n",
            )
            # When the architecture gate scans declarations
            violations = architecture_checks.find_architecture_violations(
                source_root,
                frozenset(),
            )

        # Then non-table-name occurrences do not trigger the gate
        self.assertEqual(violations, ())


if __name__ == "__main__":
    unittest.main()
