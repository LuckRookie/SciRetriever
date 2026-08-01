from __future__ import annotations

import ast
from typing import Final

from scripts.target_ast_bindings import BindingIndex


OPAQUE_MARKER: Final = "sciretriever:opaque-extension-payload"
_DECODER_METHODS: Final = frozenset(
    {"decode", "from_json", "load", "loads", "model_validate", "model_validate_json",
     "parse_obj", "parse_raw", "validate_json", "validate_python"}
)
_MUTATIONS: Final = frozenset(
    {"mkdir", "rename", "replace", "touch", "write_bytes", "write_text"}
)
_PACKAGE_FIELDS: Final = frozenset(
    {"analysis", "assets", "light_document", "lineage", "package_id", "package_sha256",
     "payload", "provenance", "published_at", "references", "schema_version", "tags",
     "work_version_id"}
)


def reads_environment(tree: ast.AST) -> bool:
    index = BindingIndex.build(tree)
    for node in ast.walk(tree):
        canonical = index.symbol(node)
        if canonical in {"os.environ", "os.getenv"}:
            return True
        if isinstance(node, ast.Call) and canonical in {
            "os.getenv()", "os.environ.get()"
        }:
            return True
    return False


def dynamic_import_modules(tree: ast.AST) -> tuple[str, ...]:
    index = BindingIndex.build(tree)
    modules: list[str] = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call) or not node.args:
            continue
        if index.symbol(node.func) not in {"importlib.import_module", "builtins.__import__"}:
            continue
        module = index.string(node.args[0])
        if module is not None:
            modules.append(module)
    return tuple(modules)


def writes_artifact(tree: ast.AST, fail_unknown: bool = True) -> bool:
    module_index = BindingIndex.build(tree)
    scopes: list[tuple[ast.AST, BindingIndex]] = [(tree, module_index)]
    scopes.extend(
        (node, BindingIndex.build(node, module_index))
        for node in ast.walk(tree)
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
    )
    for scope, index in scopes:
        for node in ast.walk(scope):
            if not isinstance(node, ast.Call):
                continue
            canonical = index.symbol(node.func)
            terminal = "" if canonical is None else canonical.rsplit(".", 1)[-1]
            if terminal in _MUTATIONS:
                return True
            if canonical == "builtins.open" or canonical == "pathlib.Path().open":
                position = 1 if canonical == "builtins.open" else 0
                mode = _call_mode(node, position, index)
                if mode is None:
                    return fail_unknown
                if any(marker in mode for marker in "wax+"):
                    return True
    return False


def declares_package_schema(tree: ast.AST) -> bool:
    index = BindingIndex.build(tree)
    for node in ast.walk(tree):
        if _declares_document_packages_table(node, index):
            return True
        if not isinstance(node, ast.ClassDef):
            continue
        normalized_name = node.name.casefold()
        if "documentpackage" in normalized_name or "packageschema" in normalized_name:
            return True
        decorators = {index.symbol(item) for item in node.decorator_list}
        bases = {index.symbol(item) for item in node.bases}
        structured = "dataclasses.dataclass" in decorators or bool(
            bases & {"pydantic.BaseModel", "typing.TypedDict", "typing.NamedTuple"}
        )
        fields = {
            item.target.id for item in node.body
            if isinstance(item, ast.AnnAssign) and isinstance(item.target, ast.Name)
        }
        if structured and _package_signature(fields):
            return True
    return False


def _declares_document_packages_table(node: ast.AST, index: BindingIndex) -> bool:
    if isinstance(node, ast.Call) and index.symbol(node.func) == "sqlalchemy.Table":
        return bool(node.args and index.string(node.args[0]) == "document_packages")
    if isinstance(node, ast.Assign):
        declares_name = any(
            isinstance(target, ast.Name) and target.id == "__tablename__"
            for target in node.targets
        )
        return declares_name and index.string(node.value) == "document_packages"
    if isinstance(node, ast.AnnAssign):
        return (
            isinstance(node.target, ast.Name)
            and node.target.id == "__tablename__"
            and node.value is not None
            and index.string(node.value) == "document_packages"
        )
    return False


def violates_opaque_boundary(tree: ast.AST) -> bool:
    module_index = BindingIndex.build(tree)
    owner_classes = [
        node for node in ast.walk(tree) if isinstance(node, ast.ClassDef)
        and any(
            (module_index.symbol(base) or "").endswith("OpaqueExtensionRecordStorePort")
            for base in node.bases
        )
    ]
    owns_table = any(
        isinstance(node, ast.Constant) and node.value == "opaque_extension_records"
        for node in ast.walk(tree)
    )
    functions = [
        node for node in ast.walk(tree)
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
    ]
    marked = [function for function in functions if _marked_parameters(function)]
    owner_entrypoints = [
        item for owner in owner_classes for item in owner.body
        if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef))
        and _marked_parameters(item)
    ]
    if owner_classes and not owner_entrypoints:
        return True
    if owns_table and functions and not marked:
        return True
    return any(_tainted_decoder(function, module_index) for function in marked)


def _marked_parameters(function: ast.FunctionDef | ast.AsyncFunctionDef) -> set[str]:
    arguments = (*function.args.posonlyargs, *function.args.args, *function.args.kwonlyargs)
    return {
        argument.arg for argument in arguments
        if argument.annotation is not None
        and any(
            isinstance(node, ast.Constant) and node.value == OPAQUE_MARKER
            for node in ast.walk(argument.annotation)
        )
    }


def _tainted_decoder(
    function: ast.FunctionDef | ast.AsyncFunctionDef, module_index: BindingIndex,
) -> bool:
    index = BindingIndex.build(function, module_index)
    tainted = _marked_parameters(function)
    for _ in range(3):
        for node in ast.walk(function):
            if isinstance(node, (ast.Assign, ast.AnnAssign)):
                targets = node.targets if isinstance(node, ast.Assign) else [node.target]
                if _uses_names(node.value, tainted):
                    tainted.update(target.id for target in targets if isinstance(target, ast.Name))
    for node in ast.walk(function):
        if not isinstance(node, ast.Call) or not any(_uses_names(arg, tainted) for arg in node.args):
            continue
        canonical = index.symbol(node.func)
        terminal = _terminal(node.func, canonical)
        if terminal in _DECODER_METHODS:
            return True
    return False


def _uses_names(node: ast.AST | None, names: set[str]) -> bool:
    return node is not None and any(
        isinstance(item, ast.Name) and item.id in names for item in ast.walk(node)
    )


def _terminal(node: ast.AST, canonical: str | None) -> str:
    if canonical is not None:
        return canonical.rsplit(".", 1)[-1]
    if isinstance(node, ast.Attribute):
        return node.attr
    if isinstance(node, ast.Name):
        return node.id
    return ""


def _call_mode(call: ast.Call, position: int, index: BindingIndex) -> str | None:
    mode = call.args[position] if len(call.args) > position else None
    for keyword in call.keywords:
        if keyword.arg == "mode":
            mode = keyword.value
    return index.string(mode) if mode is not None else "r"


def _package_signature(fields: set[str]) -> bool:
    selected = fields & _PACKAGE_FIELDS
    package_anchor = bool({"package_id", "package_sha256"} & selected) and len(selected) >= 2
    return package_anchor or {"schema_version", "payload"} <= fields or {
        "work_version_id", "published_at"} <= fields


__all__ = (
    "OPAQUE_MARKER", "declares_package_schema", "dynamic_import_modules", "reads_environment",
    "violates_opaque_boundary", "writes_artifact",
)
