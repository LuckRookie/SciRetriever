from __future__ import annotations

import argparse
import contextlib
import io
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest import mock

from sciretriever.cli import expand
from sciretriever.cli.main import _build_parser, main
from sciretriever.config import load_config


WORK_ID = "00000000-0000-4000-8000-000000000001"
VERSION_ID = "10000000-0000-4000-8000-000000000001"


class ExpandRuntimeFake:
    def __init__(self, *, interrupted: bool = False) -> None:
        self.closed = False
        self.interrupted = interrupted
        self.calls: list[argparse.Namespace] = []

    def execute(self, args: argparse.Namespace):
        self.calls.append(args)
        return SimpleNamespace(
            interrupted=self.interrupted,
            to_dict=lambda: {
                "depth": args.depth,
                "direction": args.direction,
                "interrupted": self.interrupted,
                "layers": [{"depth": 0, "failed_providers": ["openalex"]}],
                "seed": {"work_version_id": VERSION_ID},
            },
        )

    def close(self) -> None:
        self.closed = True


def arguments(**overrides) -> argparse.Namespace:
    values = {
        "catalog": Path("catalog.sqlite"),
        "storage_root": Path("storage"),
        "work_id": None,
        "work_version_id": VERSION_ID,
        "query": None,
        "direction": "references",
        "depth": 0,
        "graph_provider": ["openalex"],
        "max_provider_calls": 2,
        "provider_page_size": 100,
    }
    values.update(overrides)
    return argparse.Namespace(**values)


class ExpandParserTests(unittest.TestCase):
    def test_command_tree_requires_explicit_seed_and_depth(self) -> None:
        parser = _build_parser()

        with self.assertRaises(SystemExit):
            parser.parse_args(["expand", "--catalog", "db", "--storage-root", "store"])

        parsed = parser.parse_args([
            "expand", "--catalog", "db", "--storage-root", "store",
            "--work-id", WORK_ID, "--depth", "0",
        ])
        self.assertEqual(parsed.command, "expand")
        self.assertEqual(parsed.direction, "references")
        self.assertEqual(parsed.depth, 0)

    def test_parser_accepts_each_direction_and_rejects_negative_depth(self) -> None:
        parser = _build_parser()
        for direction in ("references", "cited-by", "both"):
            parsed = parser.parse_args([
                "expand", "--catalog", "db", "--storage-root", "store",
                "--query", "seed title", "--depth", "1", "--direction", direction,
            ])
            self.assertEqual(parsed.direction, direction)
        with self.assertRaises(SystemExit):
            parser.parse_args([
                "expand", "--catalog", "db", "--storage-root", "store",
                "--work-version-id", VERSION_ID, "--depth", "-1",
            ])

    def test_main_rejects_unsupported_graph_provider_before_runtime(self) -> None:
        with self.assertRaises(SystemExit) as raised:
            main([
                "--no-config", "expand", "--catalog", "db", "--storage-root", "store",
                "--work-version-id", VERSION_ID, "--depth", "1",
                "--graph-provider", "unknown",
            ])
        self.assertEqual(raised.exception.code, 2)


class ExpandConfigTests(unittest.TestCase):
    def test_strict_expansion_config_is_injected_and_cli_overrides_it(self) -> None:
        with mock.patch("sciretriever.config_loader._read_config_snapshot") as snapshot:
            snapshot.return_value = (
                SimpleNamespace(st_mode=0o100600),
                (
                    b"schema_version=1\n[paths]\ncatalog='db'\nstorage_root='store'\n"
                    b"[expansion]\ndirection='both'\ndepth=2\n"
                    b"providers=['semantic-scholar']\nmax_provider_calls=3\npage_size=50\n"
                ),
                Path("."),
            )
            config = load_config("config.toml")
        self.assertEqual(config.expansion.providers, ("semantic-scholar",))
        self.assertEqual(config.expansion.max_provider_calls, 3)
        self.assertEqual(config.expansion.page_size, 50)

        with mock.patch("pathlib.Path.exists", return_value=True), \
                mock.patch("sciretriever.cli.main.load_config", return_value=config), \
                mock.patch.object(expand, "run", return_value=0) as run:
            main(["--config", "config.toml", "expand", "--work-id", WORK_ID,
                  "--direction", "cited-by"])
        args = run.call_args.args[0]
        self.assertEqual(args.depth, 2)
        self.assertEqual(args.direction, "cited-by")
        self.assertEqual(args.graph_provider, ["semantic-scholar"])


class ExpandCommandTests(unittest.TestCase):
    def test_command_delegates_and_renders_deterministic_partial_result(self) -> None:
        runtime = ExpandRuntimeFake()
        output = io.StringIO()
        with mock.patch.object(expand, "build_expand_runtime", return_value=runtime) as build, \
                contextlib.redirect_stdout(output):
            code = expand.run(arguments(direction="both"))
        self.assertEqual(code, 0)
        build.assert_called_once()
        self.assertEqual(len(runtime.calls), 1)
        self.assertTrue(runtime.closed)
        self.assertEqual(json.loads(output.getvalue())["layers"][0]["failed_providers"], ["openalex"])
        self.assertEqual(output.getvalue(), json.dumps(
            json.loads(output.getvalue()), ensure_ascii=True, separators=(",", ":"), sort_keys=True,
        ) + "\n")

    def test_interrupted_result_and_hard_interrupt_return_130(self) -> None:
        runtime = ExpandRuntimeFake(interrupted=True)
        with mock.patch.object(expand, "build_expand_runtime", return_value=runtime), \
                contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(expand.run(arguments()), 130)
        hard = ExpandRuntimeFake()
        hard.execute = mock.Mock(side_effect=KeyboardInterrupt)
        output = io.StringIO()
        with mock.patch.object(expand, "build_expand_runtime", return_value=hard), \
                contextlib.redirect_stdout(output):
            self.assertEqual(expand.run(arguments()), 130)
        self.assertEqual(json.loads(output.getvalue()), {"interrupted": True, "layers": []})
        self.assertTrue(hard.closed)


if __name__ == "__main__":
    unittest.main()
