"""Negative architecture checks for the pre-v1 contract cutover."""

from __future__ import annotations

import ast
import io
import subprocess
import sys
import tokenize
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE_ROOT = ROOT / "src" / "sciretriever"

LEGACY_PACKAGES = (
    "core",
    "services",
    "infrastructure",
    "interface",
    "composition",
)

LEGACY_MODEL_FILES = (
    "assets.py",
    "canonical_json.py",
    "collection.py",
    "document_package.py",
    "documents.py",
    "library_details.py",
    "library_pages.py",
    "library_query.py",
    "library_views.py",
    "sources.py",
)

TARGET_MODEL_MODULES = (
    "primitives",
    "provenance",
    "literature",
    "metadata",
    "discovery",
    "acquisition",
    "parsing",
    "analysis",
    "library",
    "execution",
    "report",
    "access",
    "llm",
    "record",
    "configuration",
)

FUNCTIONAL_PACKAGES = (
    "acquisition",
    "analysis",
    "literature",
    "metadata",
    "parsing",
)

STORAGE_CONCRETE_PREFIXES = (
    "sciretriever.storage.files",
    "sciretriever.storage.sqlite",
)

REVOKED_EXACT_NAMES = frozenset({"Work", "DurableExchange", "durable_exchange", "sqlalchemy"})
REVOKED_NAME_PREFIXES = ("WorkVersion", "Collection", "BatchRun", "DocumentPackage")


def _import_probe(module_name: str) -> subprocess.CompletedProcess[str]:
    """Import one module in a clean interpreter with only the source tree."""

    return subprocess.run(
        [sys.executable, "-c", f"import {module_name}"],
        cwd=ROOT,
        env={"PYTHONPATH": str(ROOT / "src")},
        capture_output=True,
        text=True,
        check=False,
    )


def _import_names(path: Path) -> tuple[str, ...]:
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    names: list[str] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            names.extend(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            names.append(node.module or "")
    return tuple(names)


def _is_revoked_identifier(name: str) -> bool:
    return name in REVOKED_EXACT_NAMES or name.startswith(REVOKED_NAME_PREFIXES)


def _legacy_import(module: str) -> bool:
    return any(
        module == f"sciretriever.{package}" or module.startswith(f"sciretriever.{package}.")
        for package in LEGACY_PACKAGES
    )


def _entry_private_function_import(module: str) -> bool:
    for package in FUNCTIONAL_PACKAGES:
        public_module = f"sciretriever.{package}.api"
        if module == f"sciretriever.{package}" or (
            module.startswith(f"sciretriever.{package}.") and module != public_module
        ):
            return True
    return False


def _storage_concrete_import(module: str) -> bool:
    return any(
        module == prefix or module.startswith(f"{prefix}.") for prefix in STORAGE_CONCRETE_PREFIXES
    )


def _string_values(node: ast.AST | None) -> tuple[str, ...]:
    if node is None:
        return ()
    return tuple(
        value.value
        for value in ast.walk(node)
        if isinstance(value, ast.Constant) and isinstance(value.value, str)
    )


def _revoked_names_in_expression(value: str) -> tuple[str, ...]:
    try:
        tokens = tokenize.generate_tokens(io.StringIO(value).readline)
        return tuple(
            token.string
            for token in tokens
            if token.type == tokenize.NAME and _is_revoked_identifier(token.string)
        )
    except (IndentationError, tokenize.TokenError):
        return (value,) if _is_revoked_identifier(value) else ()


def _import_surface_violations(node: ast.AST) -> tuple[str, ...]:
    if isinstance(node, ast.Import):
        modules = tuple(alias.name for alias in node.names)
        line = node.lineno
    elif isinstance(node, ast.ImportFrom):
        modules = (node.module or "",)
        line = node.lineno
    else:
        return ()
    violations: list[str] = []
    for module in modules:
        if _legacy_import(module):
            violations.append(f"line {line}: legacy import {module}")
        if module == "sqlalchemy" or module.startswith("sqlalchemy."):
            violations.append(f"line {line}: SQLAlchemy import {module}")
    return tuple(violations)


def _dynamic_contract_strings(node: ast.AST) -> tuple[int, tuple[str, ...]]:  # noqa: C901
    if isinstance(node, ast.Assign) and any(
        isinstance(target, ast.Name) and target.id == "__all__" for target in node.targets
    ):
        return node.lineno, _string_values(node.value)
    if (
        isinstance(node, ast.AnnAssign)
        and isinstance(node.target, ast.Name)
        and node.target.id == "__all__"
    ):
        return node.lineno, _string_values(node.value)
    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == "__getattr__":
        return node.lineno, _string_values(node)
    if (
        isinstance(node, ast.Subscript)
        and isinstance(node.value, ast.Call)
        and isinstance(node.value.func, ast.Name)
        and node.value.func.id == "globals"
    ):
        return node.lineno, _string_values(node.slice)
    if (
        isinstance(node, ast.Call)
        and (
            (isinstance(node.func, ast.Name) and node.func.id == "setattr")
            or (isinstance(node.func, ast.Attribute) and node.func.attr == "setattr")
        )
        and len(node.args) >= 2
    ):
        return node.lineno, _string_values(node.args[1])
    if isinstance(node, ast.Call) and (
        (isinstance(node.func, ast.Name) and node.func.id == "ForwardRef")
        or (isinstance(node.func, ast.Attribute) and node.func.attr == "ForwardRef")
    ):
        return node.lineno, tuple(
            value for argument in node.args for value in _string_values(argument)
        )
    if isinstance(node, ast.AnnAssign):
        return node.lineno, _string_values(node.annotation)
    if isinstance(node, ast.arg):
        return node.lineno, _string_values(node.annotation)
    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
        return node.lineno, _string_values(node.returns)
    return 0, ()


def _contract_surface_violations(source: str, *, filename: str) -> tuple[str, ...]:
    """Find revoked Python surfaces without scanning provider prose or payload strings."""

    tree = ast.parse(source, filename=filename)
    violations: set[str] = set()
    for token in tokenize.generate_tokens(io.StringIO(source).readline):
        if token.type == tokenize.NAME and _is_revoked_identifier(token.string):
            violations.add(f"line {token.start[0]}: revoked identifier {token.string}")

    for node in ast.walk(tree):
        violations.update(_import_surface_violations(node))
        line, dynamic_strings = _dynamic_contract_strings(node)
        for value in dynamic_strings:
            for name in _revoked_names_in_expression(value):
                violations.add(f"line {line}: dynamic revoked name {name}")

    return tuple(sorted(violations))


class ArchitectureCutoverTests(unittest.TestCase):
    def test_legacy_packages_and_model_files_are_absent(self) -> None:
        for package in LEGACY_PACKAGES:
            with self.subTest(package=package):
                self.assertFalse((SOURCE_ROOT / package).exists())
        for filename in LEGACY_MODEL_FILES:
            with self.subTest(filename=filename):
                self.assertFalse((SOURCE_ROOT / "model" / filename).exists())

    def test_only_target_modules_import_in_a_fresh_process(self) -> None:
        modules = (
            "sciretriever",
            "sciretriever.configuration",
            "sciretriever.model",
            *(f"sciretriever.model.{name}" for name in TARGET_MODEL_MODULES),
            "sciretriever.logging",
            "sciretriever.logging.api",
        )
        for module in modules:
            with self.subTest(module=module):
                result = _import_probe(module)
                self.assertEqual(result.returncode, 0, result.stderr)

    def test_old_imports_fail_in_a_fresh_process(self) -> None:
        modules = tuple(f"sciretriever.{name}" for name in LEGACY_PACKAGES) + tuple(
            f"sciretriever.model.{name[:-3]}" for name in LEGACY_MODEL_FILES
        )
        for module in modules:
            with self.subTest(module=module):
                result = _import_probe(module)
                self.assertNotEqual(result.returncode, 0)

    def test_model_package_marker_and_root_package_have_no_compatibility_surface(self) -> None:
        model_tree = ast.parse((SOURCE_ROOT / "model" / "__init__.py").read_text(encoding="utf-8"))
        model_body = model_tree.body[1:] if ast.get_docstring(model_tree) else model_tree.body
        self.assertFalse(any(isinstance(node, (ast.Import, ast.ImportFrom)) for node in model_body))
        self.assertNotIn("__all__", (SOURCE_ROOT / "model" / "__init__.py").read_text())

        root_tree = ast.parse((SOURCE_ROOT / "__init__.py").read_text(encoding="utf-8"))
        self.assertFalse(
            any(isinstance(node, (ast.Import, ast.ImportFrom)) for node in root_tree.body)
        )
        assignments = [node for node in root_tree.body if isinstance(node, ast.Assign)]
        self.assertEqual(len(assignments), 1)
        self.assertEqual(
            [target.id for target in assignments[0].targets if isinstance(target, ast.Name)],
            ["__version__"],
        )

    def test_active_source_has_no_revoked_contract_surface(self) -> None:
        for path in sorted(SOURCE_ROOT.rglob("*.py")):
            with self.subTest(path=path.relative_to(ROOT)):
                self.assertEqual(
                    _contract_surface_violations(
                        path.read_text(encoding="utf-8"),
                        filename=str(path),
                    ),
                    (),
                )

    def test_revoked_contract_guard_rejects_representative_mutations(self) -> None:
        mutations = {
            "class": "class Work:\n    pass\n",
            "version": "class WorkVersion:\n    pass\n",
            "alias": "Work = MetaLiterature\n",
            "typed-alias": "Work: TypeAlias = MetaLiterature\n",
            "collection": "CollectionService = MetadataService\n",
            "batch": "class BatchRun:\n    pass\n",
            "package": "class DocumentPackage:\n    pass\n",
            "renamed-import": "from sciretriever.model import MetaLiterature as Work\n",
            "hidden-import": "from provider import Work as Literature\n",
            "legacy-import": "import sciretriever.services\n",
            "legacy-from": "from sciretriever.composition import build_object_graph\n",
            "sqlalchemy": "from sqlalchemy.orm import Session\n",
            "all": "__all__ = ('Work',)\n",
            "getattr": (
                "def __getattr__(name):\n    if name == 'Work':\n        return MetaLiterature\n"
            ),
            "globals": "globals()['Work'] = MetaLiterature\n",
            "setattr": "setattr(module, 'Collection', DiscoveryRun)\n",
            "annotation": "legacy: 'list[Work]'\n",
            "forward-ref": "value = ForwardRef('DocumentPackage')\n",
        }
        for name, source in mutations.items():
            with self.subTest(name=name):
                self.assertTrue(_contract_surface_violations(source, filename=f"<{name}>"))

    def test_provider_protocol_language_is_not_a_contract_surface(self) -> None:
        source = '''"""CORE v3 Work search, Work/Output lookup, and outgoing references."""

action = "Use an OpenAlex Work ID or WOS Core Collection for citing-item queries."
provider_payload = {"entity_type": "Work", "product": "Core Collection"}

class OpenAlexWorkRecord:
    pass

class WosCoreCollectionResponse:
    pass
'''
        self.assertEqual(
            _contract_surface_violations(source, filename="<provider-protocol>"),
            (),
        )

    def test_model_does_not_depend_on_io_or_logging_and_logging_is_leaf_package(self) -> None:
        model_root = SOURCE_ROOT / "model"
        for path in sorted(model_root.glob("*.py")):
            imported = _import_names(path)
            with self.subTest(path=path.relative_to(ROOT)):
                self.assertFalse(any(name.startswith("sciretriever.logging") for name in imported))
                self.assertNotIn("logging", imported)
                self.assertNotIn("sqlite3", imported)
                self.assertNotIn("sqlalchemy", imported)

        logging_root = SOURCE_ROOT / "logging"
        for path in sorted(logging_root.glob("*.py")):
            imported = _import_names(path)
            business_imports = tuple(
                name
                for name in imported
                if name.startswith("sciretriever.") and not name.startswith("sciretriever.logging")
            )
            with self.subTest(path=path.relative_to(ROOT)):
                self.assertEqual(business_imports, ())

    def test_entry_imports_functional_modules_only_through_public_api(self) -> None:
        entry_root = SOURCE_ROOT / "entry"
        for path in sorted(entry_root.rglob("*.py")):
            violations = tuple(
                module for module in _import_names(path) if _entry_private_function_import(module)
            )
            with self.subTest(path=path.relative_to(ROOT)):
                self.assertEqual(violations, ())

    def test_functional_business_modules_do_not_import_storage_concretes(self) -> None:
        for package in FUNCTIONAL_PACKAGES:
            for path in sorted((SOURCE_ROOT / package).rglob("*.py")):
                violations = tuple(
                    module for module in _import_names(path) if _storage_concrete_import(module)
                )
                with self.subTest(path=path.relative_to(ROOT)):
                    self.assertEqual(violations, ())

    def test_public_boundary_guards_reject_representative_private_imports(self) -> None:
        entry_modules = (
            "sciretriever.acquisition.ports",
            "sciretriever.analysis.content",
            "sciretriever.literature.service",
            "sciretriever.metadata.rules",
            "sciretriever.parsing.ports",
        )
        for module in entry_modules:
            with self.subTest(module=module):
                self.assertTrue(_entry_private_function_import(module))
        for package in FUNCTIONAL_PACKAGES:
            with self.subTest(public=f"sciretriever.{package}.api"):
                self.assertFalse(_entry_private_function_import(f"sciretriever.{package}.api"))

        for module in (
            "sciretriever.storage.files.staging",
            "sciretriever.storage.sqlite.engine",
        ):
            with self.subTest(module=module):
                self.assertTrue(_storage_concrete_import(module))


if __name__ == "__main__":
    unittest.main()
