"""Semantic architecture checks for the Literature database core."""

from __future__ import annotations

import ast
import sqlite3
import unittest
from dataclasses import dataclass
from pathlib import Path
from typing import Final

from sciretriever.model.analysis import LiteratureContent
from sciretriever.model.literature import Literature, MetaLiterature, Reference, ReferenceSupport
from sciretriever.model.metadata import (
    LiteratureMetadata,
    MetadataObservation,
    ProviderRelationObservation,
)
from sciretriever.storage.sqlite.schema import (
    SCHEMA_FINGERPRINT,
    SCHEMA_INDEXES,
    SCHEMA_MANIFEST,
    SCHEMA_TABLES,
    SCHEMA_TRIGGERS,
    schema_fingerprint,
)

ROOT: Final[Path] = Path(__file__).resolve().parents[1]
SOURCE_ROOT: Final[Path] = ROOT / "src" / "sciretriever"
LITERATURE_ROOT: Final[Path] = SOURCE_ROOT / "literature"
STORAGE_ROOT: Final[Path] = SOURCE_ROOT / "storage"

FEATURE_PACKAGES: Final[tuple[str, ...]] = (
    "entry",
    "metadata",
    "acquisition",
    "parsing",
    "analysis",
)

STORAGE_CONSUMER_FEATURES: Final[tuple[str, ...]] = (
    "literature",
    *FEATURE_PACKAGES,
)

STORAGE_ALLOWED_FEATURE_PORT_MODULES: Final[frozenset[str]] = frozenset(
    f"sciretriever.{feature}.ports" for feature in STORAGE_CONSUMER_FEATURES
)

REVOKED_IDENTIFIERS: Final[frozenset[str]] = frozenset(
    {
        "Work",
        "WorkVersion",
        "Collection",
        "CollectionRun",
        "CollectionMembership",
        "CollectionSelector",
        "BatchRun",
        "BatchTarget",
        "DocumentPackage",
        "ReferenceObservation",
        "CitationObservation",
        "LiteratureRelation",
        "LiteratureRelationObservation",
        "LiteratureRelationship",
        "Relationship",
        "RelationshipEdge",
        "RelationshipGraph",
    }
)

REVOKED_IMPORT_PREFIXES: Final[tuple[str, ...]] = (
    "sciretriever.core",
    "sciretriever.services",
    "sciretriever.infrastructure",
    "sciretriever.interface",
    "sciretriever.composition",
    "sciretriever.model.assets",
    "sciretriever.model.canonical_json",
    "sciretriever.model.collection",
    "sciretriever.model.document_package",
    "sciretriever.model.documents",
    "sciretriever.model.library_details",
    "sciretriever.model.library_pages",
    "sciretriever.model.library_query",
    "sciretriever.model.library_views",
    "sciretriever.model.sources",
    "sciretriever.literature.work",
    "sciretriever.literature.collection",
    "sciretriever.literature.batch",
    "sciretriever.literature.document_package",
    "sciretriever.literature.relationships",
)

REVOKED_IMPORT_MEMBERS: Final[dict[str, frozenset[str]]] = {
    "sciretriever": frozenset({"core", "services", "infrastructure", "interface", "composition"}),
    "sciretriever.model": frozenset(
        {
            "assets",
            "canonical_json",
            "collection",
            "document_package",
            "documents",
            "library_details",
            "library_pages",
            "library_query",
            "library_views",
            "sources",
        }
    ),
    "sciretriever.literature": frozenset(
        {"work", "collection", "batch", "document_package", "relationships"}
    ),
}

STORAGE_FORBIDDEN_DECISIONS: Final[frozenset[str]] = frozenset(
    {
        "IdentityDecision",
        "MetaLiteratureDecision",
        "MetadataProjectionDecision",
        "MetadataObservationAcceptanceDecision",
        "ContentAcceptanceDecision",
        "ReferenceAcceptanceDecision",
        "resolve_literature_identity",
        "resolve_meta_literature",
        "project_metadata",
        "accept_observation",
        "decide_content_acceptance",
        "decide_reference",
        "observation_from_bibliographic_record",
        "select_export_literatures",
    }
)

ENTRY_SELECTOR_INPUT_IDENTIFIERS: Final[frozenset[str]] = frozenset(
    {
        "AllPendingSelector",
        "DiscoveryRunSelector",
        "ImportReportSelector",
        "QuerySelector",
        "MetaLiteratureSelector",
        "LiteratureSelector",
        "BatchSelector",
    }
)

ENTRY_SELECTOR_DECISION_IDENTIFIERS: Final[frozenset[str]] = frozenset(
    {
        "BatchRequest",
        "BatchGoal",
    }
)

ENTRY_SELECTOR_READER: Final[Path] = STORAGE_ROOT / "sqlite" / "entry_reader.py"

FORBIDDEN_EXTERNAL_ADAPTER_IMPORTS: Final[tuple[str, ...]] = (
    "aiohttp",
    "anthropic",
    "httpx",
    "openai",
    "playwright",
    "requests",
    "socket",
    "urllib.request",
)


@dataclass(frozen=True, slots=True)
class _ImportReference:
    module: str
    imported_name: str | None
    line: int


def _python_files(root: Path) -> tuple[Path, ...]:
    if not root.is_dir():
        return ()
    return tuple(sorted(root.rglob("*.py")))


def _tree(path: Path) -> ast.Module:
    return ast.parse(path.read_text(encoding="utf-8"), filename=str(path))


def _source_module_name(path: Path) -> str:
    parts = list(path.relative_to(SOURCE_ROOT).with_suffix("").parts)
    if parts[-1] == "__init__":
        parts.pop()
    return ".".join(("sciretriever", *parts))


def _resolved_from_module(path: Path, node: ast.ImportFrom) -> str:
    if node.level == 0:
        return node.module or ""
    current_module = _source_module_name(path)
    package = current_module if path.name == "__init__.py" else current_module.rpartition(".")[0]
    package_parts = package.split(".")
    keep = len(package_parts) - node.level + 1
    if keep < 1:
        return node.module or ""
    resolved = package_parts[:keep]
    if node.module:
        resolved.extend(node.module.split("."))
    return ".".join(resolved)


def _imports(path: Path) -> tuple[_ImportReference, ...]:
    references: list[_ImportReference] = []
    for node in ast.walk(_tree(path)):
        if isinstance(node, ast.Import):
            references.extend(
                _ImportReference(alias.name, None, node.lineno) for alias in node.names
            )
        elif isinstance(node, ast.ImportFrom):
            module = _resolved_from_module(path, node)
            references.extend(
                _ImportReference(module, alias.name, node.lineno) for alias in node.names
            )
    return tuple(references)


def _matches_module(module: str, prefix: str) -> bool:
    return module == prefix or module.startswith(f"{prefix}.")


def _storage_internal_dependency_violation(reference: _ImportReference) -> str | None:
    module = reference.module
    if module == "sciretriever" and reference.imported_name is not None:
        module = f"{module}.{reference.imported_name}"

    consumer_feature_prefixes = tuple(f"sciretriever.{name}" for name in STORAGE_CONSUMER_FEATURES)
    if any(_matches_module(module, prefix) for prefix in consumer_feature_prefixes):
        if module not in STORAGE_ALLOWED_FEATURE_PORT_MODULES:
            return module
    if _matches_module(module, "sciretriever.network"):
        return module
    return None


def _semantic_identifiers(path: Path) -> frozenset[str]:
    identifiers: set[str] = set()
    for node in ast.walk(_tree(path)):
        if isinstance(node, (ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
            identifiers.add(node.name)
        elif isinstance(node, ast.Name):
            identifiers.add(node.id)
        elif isinstance(node, ast.Attribute):
            identifiers.add(node.attr)
        elif isinstance(node, ast.arg):
            identifiers.add(node.arg)
        elif isinstance(node, ast.alias):
            identifiers.add(node.asname or node.name.rsplit(".", 1)[-1])
    return frozenset(identifiers)


def _dynamic_import_lines(path: Path) -> tuple[int, ...]:
    lines: list[int] = []
    for node in ast.walk(_tree(path)):
        if not isinstance(node, ast.Call):
            continue
        if isinstance(node.func, ast.Name) and node.func.id == "__import__":
            lines.append(node.lineno)
        elif isinstance(node.func, ast.Attribute) and node.func.attr == "import_module":
            lines.append(node.lineno)
    return tuple(lines)


def _all_exports(path: Path) -> tuple[str, ...]:
    for node in _tree(path).body:
        value: ast.expr | None = None
        if isinstance(node, ast.Assign) and any(
            isinstance(target, ast.Name) and target.id == "__all__" for target in node.targets
        ):
            value = node.value
        elif (
            isinstance(node, ast.AnnAssign)
            and isinstance(node.target, ast.Name)
            and node.target.id == "__all__"
        ):
            value = node.value
        if value is None:
            continue
        literal = ast.literal_eval(value)
        if not isinstance(literal, (list, tuple)) or any(
            not isinstance(item, str) for item in literal
        ):
            raise AssertionError(f"{path}: __all__ must be a literal string sequence")
        return tuple(literal)
    return ()


def _manifest_connection() -> sqlite3.Connection:
    connection = sqlite3.connect(":memory:")
    connection.execute("PRAGMA foreign_keys = ON")
    try:
        for statement in SCHEMA_MANIFEST:
            connection.execute(statement)
    except BaseException:
        connection.close()
        raise
    return connection


def _manifest_object_names() -> tuple[
    frozenset[str],
    frozenset[str],
    frozenset[str],
]:
    tables: set[str] = set()
    indexes: set[str] = set()
    triggers: set[str] = set()
    for statement in SCHEMA_MANIFEST:
        words = statement.partition("(")[0].split()
        if words[:2] == ["CREATE", "TABLE"]:
            tables.add(words[2])
        elif words[:3] == ["CREATE", "VIRTUAL", "TABLE"]:
            tables.add(words[3])
        elif words[:2] == ["CREATE", "INDEX"]:
            indexes.add(words[2])
        elif words[:3] == ["CREATE", "UNIQUE", "INDEX"]:
            indexes.add(words[3])
        elif words[:2] == ["CREATE", "TRIGGER"]:
            triggers.add(words[2])
        else:
            raise AssertionError(f"unsupported schema manifest statement: {statement}")
    return frozenset(tables), frozenset(indexes), frozenset(triggers)


def _table_columns(connection: sqlite3.Connection, table: str) -> tuple[str, ...]:
    rows = connection.execute(f'PRAGMA table_info("{table}")').fetchall()
    return tuple(str(row[1]) for row in rows)


def _unique_column_sets(connection: sqlite3.Connection, table: str) -> frozenset[tuple[str, ...]]:
    result: set[tuple[str, ...]] = set()
    for index_row in connection.execute(f'PRAGMA index_list("{table}")').fetchall():
        if int(index_row[2]) != 1:
            continue
        index_name = str(index_row[1]).replace('"', '""')
        columns = tuple(
            str(column_row[2])
            for column_row in connection.execute(f'PRAGMA index_info("{index_name}")').fetchall()
        )
        result.add(columns)
    return frozenset(result)


def _foreign_key_groups(
    connection: sqlite3.Connection,
    table: str,
) -> frozenset[tuple[str, tuple[tuple[str, str], ...]]]:
    grouped: dict[int, tuple[str, list[tuple[int, str, str]]]] = {}
    for row in connection.execute(f'PRAGMA foreign_key_list("{table}")').fetchall():
        group_id = int(row[0])
        target_table = str(row[2])
        sequence = int(row[1])
        source_column = str(row[3])
        target_column = str(row[4])
        if group_id not in grouped:
            grouped[group_id] = (target_table, [])
        grouped[group_id][1].append((sequence, source_column, target_column))
    return frozenset(
        (
            target_table,
            tuple((source, target) for _, source, target in sorted(columns)),
        )
        for target_table, columns in grouped.values()
    )


class LiteratureArchitectureTests(unittest.TestCase):
    def test_package_markers_are_inert_and_export_nothing(self) -> None:
        paths = (
            LITERATURE_ROOT / "__init__.py",
            STORAGE_ROOT / "sqlite" / "__init__.py",
        )
        for path in paths:
            with self.subTest(path=path.relative_to(ROOT)):
                self.assertTrue(path.is_file())
                tree = _tree(path)
                body = tree.body[1:] if ast.get_docstring(tree) is not None else tree.body
                self.assertEqual(len(body), 1)
                assignment = body[0]
                self.assertIsInstance(assignment, ast.Assign)
                assert isinstance(assignment, ast.Assign)
                self.assertEqual(
                    tuple(
                        target.id for target in assignment.targets if isinstance(target, ast.Name)
                    ),
                    ("__all__",),
                )
                self.assertIsInstance(assignment.value, ast.Tuple)
                assert isinstance(assignment.value, ast.Tuple)
                self.assertEqual(assignment.value.elts, [])
                self.assertFalse(
                    any(
                        isinstance(
                            node,
                            (
                                ast.Import,
                                ast.ImportFrom,
                                ast.Call,
                                ast.ClassDef,
                                ast.FunctionDef,
                                ast.AsyncFunctionDef,
                            ),
                        )
                        for node in ast.walk(tree)
                    )
                )

    def test_literature_depends_only_on_its_rules_neutral_model_and_logging_api(self) -> None:
        allowed_sciretriever_prefixes = (
            "sciretriever.literature",
            "sciretriever.model",
            "sciretriever.logging.api",
        )
        forbidden_runtime_modules = (
            "sqlite3",
            "sqlalchemy",
            *FORBIDDEN_EXTERNAL_ADAPTER_IMPORTS,
        )
        for path in _python_files(LITERATURE_ROOT):
            for reference in _imports(path):
                with self.subTest(
                    path=path.relative_to(ROOT),
                    module=reference.module,
                    line=reference.line,
                ):
                    if reference.module.startswith("sciretriever"):
                        self.assertTrue(
                            any(
                                _matches_module(reference.module, allowed)
                                for allowed in allowed_sciretriever_prefixes
                            ),
                            f"Literature crossed into {reference.module}",
                        )
                    self.assertFalse(
                        any(
                            _matches_module(reference.module, forbidden)
                            for forbidden in forbidden_runtime_modules
                        ),
                        f"Literature imported adapter/runtime module {reference.module}",
                    )
            self.assertEqual(_dynamic_import_lines(path), (), path.relative_to(ROOT))

    def test_feature_modules_call_literature_only_through_public_api(self) -> None:
        for feature in FEATURE_PACKAGES:
            for path in _python_files(SOURCE_ROOT / feature):
                for reference in _imports(path):
                    if not _matches_module(reference.module, "sciretriever.literature"):
                        continue
                    with self.subTest(
                        feature=feature,
                        path=path.relative_to(ROOT),
                        line=reference.line,
                    ):
                        self.assertEqual(reference.module, "sciretriever.literature.api")

    def test_entry_calls_metadata_only_through_public_api(self) -> None:
        for path in _python_files(SOURCE_ROOT / "entry"):
            for reference in _imports(path):
                if not _matches_module(reference.module, "sciretriever.metadata"):
                    continue
                with self.subTest(
                    path=path.relative_to(ROOT),
                    line=reference.line,
                ):
                    self.assertEqual(reference.module, "sciretriever.metadata.api")

    def test_storage_import_boundary_reads_root_members_without_reclassifying_port_symbols(
        self,
    ) -> None:
        for feature in STORAGE_CONSUMER_FEATURES:
            with self.subTest(feature=feature, form="root-member"):
                self.assertEqual(
                    _storage_internal_dependency_violation(
                        _ImportReference("sciretriever", feature, 1)
                    ),
                    f"sciretriever.{feature}",
                )
            with self.subTest(feature=feature, form="port-symbol"):
                self.assertIsNone(
                    _storage_internal_dependency_violation(
                        _ImportReference(
                            f"sciretriever.{feature}.ports",
                            "ConsumerOwnedPort",
                            1,
                        )
                    )
                )

        for module in (
            "sciretriever.model",
            "sciretriever.model.literature",
        ):
            with self.subTest(module=module, boundary="model"):
                self.assertIsNone(
                    _storage_internal_dependency_violation(_ImportReference(module, None, 1))
                )
        self.assertIsNone(
            _storage_internal_dependency_violation(_ImportReference("sciretriever", "model", 1))
        )

        for reference in (
            _ImportReference("sciretriever", "network", 1),
            _ImportReference("sciretriever.network", "HttpClient", 1),
            _ImportReference("sciretriever.network.http", None, 1),
        ):
            with self.subTest(module=reference.module, boundary="network"):
                self.assertIsNotNone(_storage_internal_dependency_violation(reference))

        for feature in STORAGE_CONSUMER_FEATURES:
            for runtime_module in (
                "api",
                "execution",
                "service",
                "publication",
                "rules",
                "providers",
                "sources",
                "state",
            ):
                module = f"sciretriever.{feature}.{runtime_module}"
                with self.subTest(module=module, boundary="feature-runtime"):
                    self.assertEqual(
                        _storage_internal_dependency_violation(_ImportReference(module, None, 1)),
                        module,
                    )

    def test_storage_has_no_private_feature_or_business_decision_dependencies(self) -> None:
        storage_files = _python_files(STORAGE_ROOT)
        self.assertIn(ENTRY_SELECTOR_READER, storage_files)
        for path in storage_files:
            identifiers = _semantic_identifiers(path)
            with self.subTest(path=path.relative_to(ROOT), boundary="decisions"):
                self.assertEqual(identifiers & STORAGE_FORBIDDEN_DECISIONS, frozenset())
                self.assertEqual(
                    identifiers & ENTRY_SELECTOR_DECISION_IDENTIFIERS,
                    frozenset(),
                )
                if path == ENTRY_SELECTOR_READER:
                    self.assertEqual(
                        identifiers & ENTRY_SELECTOR_INPUT_IDENTIFIERS,
                        ENTRY_SELECTOR_INPUT_IDENTIFIERS,
                    )
                else:
                    self.assertEqual(
                        identifiers & ENTRY_SELECTOR_INPUT_IDENTIFIERS,
                        frozenset(),
                    )
                self.assertEqual(_dynamic_import_lines(path), ())
            for reference in _imports(path):
                with self.subTest(
                    path=path.relative_to(ROOT),
                    module=reference.module,
                    imported_name=reference.imported_name,
                    line=reference.line,
                ):
                    self.assertIsNone(
                        _storage_internal_dependency_violation(reference),
                        (
                            "Storage may depend on a consuming feature only through its "
                            "owned Ports and may not import Network"
                        ),
                    )
                    self.assertFalse(
                        any(
                            _matches_module(reference.module, prefix)
                            for prefix in FORBIDDEN_EXTERNAL_ADAPTER_IMPORTS
                        ),
                        (
                            "Storage imported external Provider/Network/LLM runtime "
                            f"{reference.module}"
                        ),
                    )

    def test_storage_adapters_implement_literature_owned_ports(self) -> None:
        storage_files = _python_files(STORAGE_ROOT)
        port_classes: dict[str, frozenset[str]] = {}
        for node in _tree(LITERATURE_ROOT / "ports.py").body:
            if not isinstance(node, ast.ClassDef) or not any(
                isinstance(base, ast.Name) and base.id == "Protocol" for base in node.bases
            ):
                continue
            methods = frozenset(
                child.name
                for child in node.body
                if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef))
                and not child.name.startswith("_")
            )
            if methods:
                port_classes[node.name] = methods

        adapter_classes: dict[str, frozenset[str]] = {}
        for path in storage_files:
            for node in ast.walk(_tree(path)):
                if not isinstance(node, ast.ClassDef):
                    continue
                adapter_classes[f"{path.relative_to(SOURCE_ROOT)}:{node.name}"] = frozenset(
                    child.name
                    for child in node.body
                    if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef))
                    and not child.name.startswith("_")
                )

        self.assertTrue(port_classes)
        for port_name, required_methods in sorted(port_classes.items()):
            with self.subTest(port=port_name):
                self.assertTrue(
                    any(
                        required_methods.issubset(adapter_methods)
                        for adapter_methods in adapter_classes.values()
                    ),
                    f"no Storage adapter implements {port_name}: {sorted(required_methods)}",
                )

    def test_revoked_concepts_are_absent_as_identifiers_imports_and_exports(self) -> None:
        for path in _python_files(SOURCE_ROOT):
            identifiers = _semantic_identifiers(path)
            with self.subTest(path=path.relative_to(ROOT), check="identifiers"):
                self.assertEqual(identifiers & REVOKED_IDENTIFIERS, frozenset())
            with self.subTest(path=path.relative_to(ROOT), check="exports"):
                self.assertEqual(frozenset(_all_exports(path)) & REVOKED_IDENTIFIERS, frozenset())
            for reference in _imports(path):
                with self.subTest(
                    path=path.relative_to(ROOT),
                    check="import",
                    module=reference.module,
                    line=reference.line,
                ):
                    self.assertFalse(
                        any(
                            _matches_module(reference.module, prefix)
                            for prefix in REVOKED_IMPORT_PREFIXES
                        )
                    )
                    self.assertNotIn(
                        reference.imported_name,
                        REVOKED_IMPORT_MEMBERS.get(reference.module, frozenset()),
                    )

        old_paths = (
            SOURCE_ROOT / "core",
            SOURCE_ROOT / "services",
            SOURCE_ROOT / "infrastructure",
            SOURCE_ROOT / "interface",
            SOURCE_ROOT / "composition",
            LITERATURE_ROOT / "work.py",
            LITERATURE_ROOT / "collection.py",
            LITERATURE_ROOT / "batch.py",
            LITERATURE_ROOT / "document_package.py",
            LITERATURE_ROOT / "relationships.py",
        )
        for path in old_paths:
            with self.subTest(path=path.relative_to(ROOT), check="old-path"):
                self.assertFalse(path.exists())

    def test_current_models_keep_precise_non_graph_contracts(self) -> None:
        expected_fields = {
            MetaLiterature: ("meta_literature_id", "representative_literature_id"),
            Literature: (
                "literature_id",
                "meta_literature_id",
                "version_role",
                "metadata",
                "status",
            ),
            LiteratureMetadata: (
                "title",
                "authors",
                "abstract",
                "publication_date",
                "publication_year",
                "document_type",
                "language",
                "venue",
                "publisher",
                "volume",
                "issue",
                "pages",
                "identifiers",
                "keywords",
            ),
            MetadataObservation: (
                "observation_id",
                "provenance",
                "metadata",
                "version_role",
                "version_links",
                "declared_keywords",
                "reference_texts",
                "reference_count",
                "cited_by_count",
                "asset_hints",
            ),
            ProviderRelationObservation: ("observation_id", "provenance", "citing", "cited"),
            Reference: ("reference_id", "source_literature_id", "target_literature_id"),
            ReferenceSupport: ("reference_id", "source"),
            LiteratureContent: (
                "literature_content_sha256",
                "metadata_revision",
                "metadata_sha256",
                "sections",
                "references",
                "markdown",
                "provenance",
            ),
        }
        for model, fields in expected_fields.items():
            with self.subTest(model=model.__name__):
                self.assertEqual(tuple(model.model_fields), fields)

    def test_schema_manifest_matches_created_objects(self) -> None:
        self.assertIsInstance(SCHEMA_MANIFEST, tuple)
        self.assertEqual(len(SCHEMA_MANIFEST), len(set(SCHEMA_MANIFEST)))
        self.assertEqual(SCHEMA_FINGERPRINT, schema_fingerprint(SCHEMA_MANIFEST))
        self.assertEqual(len(SCHEMA_TABLES), len(set(SCHEMA_TABLES)))
        self.assertEqual(len(SCHEMA_INDEXES), len(set(SCHEMA_INDEXES)))
        self.assertEqual(len(SCHEMA_TRIGGERS), len(set(SCHEMA_TRIGGERS)))
        manifest_tables, manifest_indexes, manifest_triggers = _manifest_object_names()
        self.assertEqual(manifest_tables, frozenset(SCHEMA_TABLES))
        self.assertEqual(manifest_indexes, frozenset(SCHEMA_INDEXES))
        self.assertEqual(manifest_triggers, frozenset(SCHEMA_TRIGGERS))

        connection = _manifest_connection()
        self.addCleanup(connection.close)
        objects = {
            (str(row[0]), str(row[1]))
            for row in connection.execute(
                "SELECT type,name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'"
            ).fetchall()
        }
        for table in SCHEMA_TABLES:
            with self.subTest(table=table):
                self.assertIn(("table", table), objects)
        for index in SCHEMA_INDEXES:
            with self.subTest(index=index):
                self.assertIn(("index", index), objects)
        for trigger in SCHEMA_TRIGGERS:
            with self.subTest(trigger=trigger):
                self.assertIn(("trigger", trigger), objects)

    def test_schema_relationalizes_scalars_and_ordered_repetitions(self) -> None:
        connection = _manifest_connection()
        self.addCleanup(connection.close)

        self.assertEqual(
            _table_columns(connection, "literature_metadata"),
            (
                "literature_id",
                "metadata_revision",
                "metadata_sha256",
                "title",
                "abstract",
                "publication_date",
                "publication_year",
                "document_type",
                "language",
                "venue",
                "publisher",
                "volume",
                "issue",
                "pages",
            ),
        )
        self.assertEqual(
            _table_columns(connection, "metadata_observations"),
            (
                "observation_id",
                "provenance_id",
                "version_role",
                "reference_count",
                "cited_by_count",
                "title",
                "abstract",
                "publication_date",
                "publication_year",
                "document_type",
                "language",
                "venue",
                "publisher",
                "volume",
                "issue",
                "pages",
            ),
        )

        ordered_child_keys = {
            "literature_metadata_authors": ("literature_id", "ordinal"),
            "literature_metadata_author_affiliations": (
                "literature_id",
                "author_ordinal",
                "affiliation_ordinal",
            ),
            "literature_metadata_identifiers": ("literature_id", "ordinal"),
            "literature_metadata_keywords": ("literature_id", "ordinal"),
            "metadata_observation_authors": ("observation_id", "ordinal"),
            "metadata_observation_author_affiliations": (
                "observation_id",
                "author_ordinal",
                "affiliation_ordinal",
            ),
            "metadata_observation_identifiers": ("observation_id", "ordinal"),
            "metadata_observation_keywords": ("observation_id", "ordinal"),
            "metadata_observation_declared_keywords": ("observation_id", "ordinal"),
            "metadata_observation_reference_texts": (
                "observation_id",
                "reference_index",
            ),
            "metadata_observation_asset_hints": ("observation_id", "hint_ordinal"),
            "metadata_observation_version_links": ("observation_id", "link_ordinal"),
            "metadata_observation_version_link_identifiers": (
                "observation_id",
                "link_ordinal",
                "ordinal",
            ),
            "provider_relation_endpoint_identifiers": (
                "observation_id",
                "endpoint_kind",
                "ordinal",
            ),
            "parser_result_resources": ("source_asset_id", "ordinal"),
            "literature_content_reference_texts": (
                "literature_content_sha256",
                "reference_index",
            ),
        }
        for table, ordered_key in ordered_child_keys.items():
            with self.subTest(table=table):
                self.assertTrue(set(ordered_key).issubset(_table_columns(connection, table)))
                self.assertIn(ordered_key, _unique_column_sets(connection, table))

    def test_schema_binds_structured_content_to_artifacts_without_section_tables(self) -> None:
        connection = _manifest_connection()
        self.addCleanup(connection.close)
        content_columns = _table_columns(connection, "literature_contents")
        self.assertEqual(
            content_columns,
            (
                "literature_id",
                "literature_content_sha256",
                "metadata_revision",
                "metadata_sha256",
                "primary_asset_id",
                "primary_asset_sha256",
                "parser_result_sha256",
                "structured_artifact_path",
                "structured_artifact_sha256",
                "structured_artifact_byte_size",
                "structured_artifact_media_type",
                "markdown_artifact_path",
                "markdown_artifact_sha256",
                "markdown_artifact_byte_size",
                "markdown_artifact_media_type",
                "analysis_provenance_id",
            ),
        )
        foreign_keys = _foreign_key_groups(connection, "literature_contents")
        self.assertIn(
            (
                "artifact_objects",
                (
                    ("structured_artifact_path", "relative_path"),
                    ("structured_artifact_sha256", "sha256"),
                    ("structured_artifact_byte_size", "byte_size"),
                    ("structured_artifact_media_type", "media_type"),
                ),
            ),
            foreign_keys,
        )
        self.assertIn(
            (
                "artifact_objects",
                (
                    ("markdown_artifact_path", "relative_path"),
                    ("markdown_artifact_sha256", "sha256"),
                    ("markdown_artifact_byte_size", "byte_size"),
                    ("markdown_artifact_media_type", "media_type"),
                ),
            ),
            foreign_keys,
        )
        self.assertFalse(
            any(target_table == "parser_results" for target_table, _columns in foreign_keys)
        )
        relational_section_tables = {
            name
            for name in SCHEMA_TABLES
            if any(
                token.startswith("section") or token.startswith("subsection")
                for token in name.split("_")
            )
        }
        self.assertEqual(relational_section_tables, set())

    def test_schema_has_no_legacy_entities_generic_json_or_persisted_read_models(self) -> None:
        connection = _manifest_connection()
        self.addCleanup(connection.close)

        forbidden_tables = {
            "works",
            "work_versions",
            "collections",
            "collection_memberships",
            "collection_runs",
            "batch_runs",
            "batch_targets",
            "document_packages",
            "relationships",
            "relationship_edges",
            "relationship_graph",
            "literature_relations",
            "literature_relation_observations",
            "library_queries",
            "library_search_requests",
            "library_search_pages",
            "literature_search_items",
            "literature_details",
            "literature_reference_pages",
            "reference_details",
            "read_models",
        }
        self.assertEqual(set(SCHEMA_TABLES) & forbidden_tables, set())

        forbidden_columns = {
            "json",
            "model_json",
            "model_payload",
            "pydantic_json",
            "details",
            "extra",
            "extra_json",
            "vendor_payload",
            "vendor_response",
            "raw_payload",
            "raw_response",
            "cursor",
            "next_cursor",
            "page",
            "page_number",
            "selected_ids",
            "selected_literature_ids",
            "selected_meta_literature_ids",
            "query_json",
            "query_sql",
            "selector",
            "selector_json",
            "read_model_json",
        }
        column_locations: dict[str, set[str]] = {}
        column_types: dict[tuple[str, str], str] = {}
        status_columns: set[tuple[str, str]] = set()
        for table in SCHEMA_TABLES:
            for row in connection.execute(f'PRAGMA table_info("{table}")').fetchall():
                column = str(row[1])
                column_locations.setdefault(column, set()).add(table)
                column_types[(table, column)] = str(row[2]).upper()
                if column == "status" or column.endswith("_status"):
                    status_columns.add((table, column))
                with self.subTest(table=table, column=column):
                    self.assertNotIn(column, forbidden_columns)
                    self.assertFalse(column.endswith("_json"))
                    self.assertFalse(column.endswith("_payload"))
        self.assertFalse(
            any(column_type in {"BLOB", "JSON"} for column_type in column_types.values())
        )
        self.assertEqual(column_locations.get("status"), {"discovery_runs"})
        self.assertEqual(
            status_columns,
            {
                ("discovery_runs", "status"),
                ("metadata_observation_asset_hints", "access_status"),
            },
        )
        self.assertEqual(column_locations.get("query"), {"topic_discovery_inputs"})
        self.assertEqual(
            _table_columns(connection, "literatures"),
            ("literature_id", "meta_literature_id", "version_role"),
        )
        self.assertEqual(
            _table_columns(connection, "meta_literatures"),
            ("meta_literature_id", "representative_literature_id"),
        )


if __name__ == "__main__":
    unittest.main()
