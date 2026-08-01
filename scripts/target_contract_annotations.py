from __future__ import annotations

import ast
from dataclasses import dataclass
from typing import Final

from scripts.target_ast_bindings import BindingIndex


_MAX_DEPTH: Final = 32
_MAX_FORWARD_REFERENCE_LENGTH: Final = 4096
_VENDOR_MARKERS: Final = (
    "vendorwork", "mineru", "openai", "anthropic", "playwright", "sqlalchemy",
)
_ARBITRARY_MAPPINGS: Final = frozenset({
    "dict", "typing.dict", "mapping", "typing.mapping",
    "collections.abc.mapping", "mutablemapping", "typing.mutablemapping",
})
_ABSOLUTE_PATHS: Final = frozenset({
    "path", "pathlib.path", "pathlib.posixpath", "pathlib.windowspath",
})


@dataclass(frozen=True, slots=True)
class ContractAnnotationAnalysis:
    leaks: tuple[str, ...]
    malformed_forward_reference: bool


def analyze_public_contract_annotations(tree: ast.AST) -> ContractAnnotationAnalysis:
    index = BindingIndex.build(tree)
    aliases = _assignment_aliases(tree)
    classes = {
        node.name: tuple(node.bases)
        for node in getattr(tree, "body", ())
        if isinstance(node, ast.ClassDef)
    }
    leaks: set[str] = set()
    malformed = False
    for annotation in _public_annotations(tree):
        found, invalid = _inspect(
            annotation, index, aliases, classes, frozenset(), 0, False,
        )
        leaks.update(found)
        malformed = malformed or invalid
    return ContractAnnotationAnalysis(tuple(sorted(leaks)), malformed)


def _assignment_aliases(tree: ast.AST) -> dict[str, ast.AST]:
    aliases: dict[str, ast.AST] = {}
    for node in getattr(tree, "body", ()):
        if isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name):
                    aliases[target.id] = node.value
        if (
            isinstance(node, ast.AnnAssign)
            and isinstance(node.target, ast.Name)
            and node.value is not None
        ):
            aliases[node.target.id] = node.value
    return aliases


def _public_annotations(tree: ast.AST) -> tuple[ast.AST, ...]:
    annotations: list[ast.AST] = []
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and not node.name.startswith("_"):
            annotations.extend(
                argument.annotation for argument in (
                    *node.args.posonlyargs, *node.args.args, *node.args.kwonlyargs
                ) if argument.annotation is not None
            )
            if node.returns is not None:
                annotations.append(node.returns)
        if isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
            annotations.append(node.annotation)
    return tuple(annotations)


def _inspect(
    node: ast.AST,
    index: BindingIndex,
    aliases: dict[str, ast.AST],
    classes: dict[str, tuple[ast.expr, ...]],
    visiting: frozenset[str],
    depth: int,
    annotated_metadata: bool,
) -> tuple[set[str], bool]:
    if depth > _MAX_DEPTH:
        return set(), True
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        if annotated_metadata:
            return set(), False
        return _inspect_forward(node.value, index, aliases, classes, visiting, depth)
    if isinstance(node, ast.Name):
        rendered = index.symbol(node) or node.id
        leaks = {rendered} if _is_forbidden(rendered.casefold()) else set()
        if node.id in visiting:
            return leaks, False
        nested = visiting | {node.id}
        if node.id in aliases:
            found, malformed = _inspect(
                aliases[node.id], index, aliases, classes, nested, depth + 1, False,
            )
            return leaks | found, malformed
        malformed = False
        for base in classes.get(node.id, ()):
            found, invalid = _inspect(
                base, index, aliases, classes, nested, depth + 1, False,
            )
            leaks.update(found)
            malformed = malformed or invalid
        return leaks, malformed
    canonical = index.symbol(node)
    leaks = {canonical} if canonical is not None and _is_forbidden(canonical.casefold()) else set()
    if isinstance(node, ast.Subscript):
        base = index.symbol(node.value)
        items = node.slice.elts if isinstance(node.slice, ast.Tuple) else (node.slice,)
        if base in {"typing.Literal", "typing_extensions.Literal"}:
            selected = ()
        else:
            selected = items[:1] if base in {
                "typing.Annotated", "typing_extensions.Annotated",
            } else items
        return _inspect_many((node.value, *selected), index, aliases, classes, visiting, depth, leaks)
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.BitOr):
        return _inspect_many((node.left, node.right), index, aliases, classes, visiting, depth, leaks)
    if isinstance(node, (ast.Tuple, ast.List)):
        return _inspect_many(tuple(node.elts), index, aliases, classes, visiting, depth, leaks)
    if isinstance(node, ast.Attribute):
        return leaks, False
    return leaks, False


def _inspect_many(
    nodes: tuple[ast.AST, ...],
    index: BindingIndex,
    aliases: dict[str, ast.AST],
    classes: dict[str, tuple[ast.expr, ...]],
    visiting: frozenset[str],
    depth: int,
    leaks: set[str],
) -> tuple[set[str], bool]:
    malformed = False
    for node in nodes:
        found, invalid = _inspect(
            node, index, aliases, classes, visiting, depth + 1, False,
        )
        leaks.update(found)
        malformed = malformed or invalid
    return leaks, malformed


def _inspect_forward(
    value: str,
    index: BindingIndex,
    aliases: dict[str, ast.AST],
    classes: dict[str, tuple[ast.expr, ...]],
    visiting: frozenset[str],
    depth: int,
) -> tuple[set[str], bool]:
    if not value or len(value) > _MAX_FORWARD_REFERENCE_LENGTH:
        return set(), True
    try:
        expression = ast.parse(value, mode="eval", feature_version=(3, 10)).body
    except SyntaxError:
        return set(), True
    return _inspect(expression, index, aliases, classes, visiting, depth + 1, False)


def _is_forbidden(annotation: str) -> bool:
    return (
        any(marker in annotation for marker in _VENDOR_MARKERS)
        or annotation in _ARBITRARY_MAPPINGS
        or annotation in _ABSOLUTE_PATHS
        or annotation.endswith(".row")
    )


__all__ = ("ContractAnnotationAnalysis", "analyze_public_contract_annotations")
