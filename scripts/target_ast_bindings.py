"""Shared AST binding and import-name resolution."""

from __future__ import annotations

import ast
from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class BindingIndex:
    symbols: dict[str, str | None]
    strings: dict[str, str | None]

    @classmethod
    def build(cls, tree: ast.AST, parent: BindingIndex | None = None) -> BindingIndex:
        symbols: dict[str, str | None] = (
            dict(parent.symbols) if parent is not None else {"open": "builtins.open"}
        )
        strings: dict[str, str | None] = dict(parent.strings) if parent is not None else {}
        assignments: list[ast.Assign | ast.AnnAssign] = []
        body = tree.body if isinstance(tree, (ast.Module, ast.FunctionDef, ast.AsyncFunctionDef)) else []
        for node in body:
            if isinstance(node, ast.Import):
                for alias in node.names:
                    _bind(symbols, alias.asname or alias.name.split(".")[0], alias.name)
            if isinstance(node, ast.ImportFrom) and node.module is not None:
                for alias in node.names:
                    _bind(symbols, alias.asname or alias.name, f"{node.module}.{alias.name}")
            if isinstance(node, (ast.Assign, ast.AnnAssign)):
                assignments.append(node)
        for _ in range(3):
            for node in assignments:
                targets = node.targets if isinstance(node, ast.Assign) else [node.target]
                symbol = _symbol_value(node.value, symbols)
                string = _string_value(node.value, strings)
                for target in targets:
                    if isinstance(target, ast.Name):
                        if symbol is not None:
                            _bind(symbols, target.id, symbol)
                        if string is not None:
                            _bind(strings, target.id, string)
        for node in assignments:
            targets = node.targets if isinstance(node, ast.Assign) else [node.target]
            for target in targets:
                if isinstance(target, ast.Name):
                    if _symbol_value(node.value, symbols) is None:
                        symbols[target.id] = None
                    if _string_value(node.value, strings) is None:
                        strings[target.id] = None
        return cls(symbols, strings)

    def symbol(self, node: ast.AST) -> str | None:
        return _symbol_value(node, self.symbols)

    def string(self, node: ast.AST) -> str | None:
        return _string_value(node, self.strings)


def _bind(bindings: dict[str, str | None], name: str, value: str | None) -> None:
    if name not in bindings:
        bindings[name] = value
    elif bindings[name] != value:
        bindings[name] = None


def _symbol_value(node: ast.AST | None, bindings: dict[str, str | None]) -> str | None:
    if isinstance(node, ast.Name):
        return bindings.get(node.id)
    if isinstance(node, ast.Attribute):
        owner = _symbol_value(node.value, bindings)
        return None if owner is None else f"{owner}.{node.attr}"
    if isinstance(node, ast.Call):
        function = _symbol_value(node.func, bindings)
        return None if function is None else f"{function}()"
    return None


def _string_value(node: ast.AST | None, bindings: dict[str, str | None]) -> str | None:
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    if isinstance(node, ast.Name):
        return bindings.get(node.id)
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
        left = _string_value(node.left, bindings)
        right = _string_value(node.right, bindings)
        return None if left is None or right is None else left + right
    return None


__all__ = ("BindingIndex",)
