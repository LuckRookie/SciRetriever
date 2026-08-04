from __future__ import annotations

import os
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest import TestCase, mock

from pydantic import ValidationError

import sciretriever.composition.configuration.loader as loader
from sciretriever.composition.configuration import parse_configuration
from sciretriever.composition.configuration.validation import validate_configuration
from sciretriever.model.configuration import PathsConfig, TargetConfig


def configuration_body(
    root: Path,
    *,
    catalog: Path | None = None,
    storage_root: Path | None = None,
    parsing_protocol: str = "loopback",
    parsing_base_url: str = "http://127.0.0.1:8000",
    parsing_model: str = "mineru-3.4.4",
    parsing_remote_upload: bool = False,
    parsing_secret_ref: str | None = None,
    analysis_base_url: str = "https://api.example.com/v1",
    analysis_model: str = "analysis-model",
) -> str:
    selected_catalog = root / "catalog.sqlite" if catalog is None else catalog
    selected_storage = root / "storage" if storage_root is None else storage_root
    parsing_secret = "" if parsing_secret_ref is None else f'\nsecret_ref = "{parsing_secret_ref}"'
    return (
        f'schema_version = 2\n[paths]\ncatalog = "{selected_catalog}"\n'
        f'storage_root = "{selected_storage}"\n[collection]\n'
        'citation_providers = ["openalex"]\n'
        f'[sources]\nproviders = ["crossref"]\n[assets]\nproviders = ["crossref"]\n'
        f'[parsing]\nprotocol = "{parsing_protocol}"\nbase_url = "{parsing_base_url}"\n'
        f'model = "{parsing_model}"\n'
        f"remote_upload = {str(parsing_remote_upload).lower()}{parsing_secret}\n"
        '[analysis]\nprotocol = "openai"\n'
        f'base_url = "{analysis_base_url}"\nmodel = "{analysis_model}"\n'
        'secret_ref = "env:ANALYSIS_SECRET"\n[execution]\n[library]\n'
        "[access]\n[credentials]\n"
    )


class M10DescriptorSecurityTests(TestCase):
    def test_exact_bound_reads_at_most_one_megabyte_plus_one(self) -> None:
        with TemporaryDirectory() as directory:
            path = Path(directory) / "config.toml"
            path.write_bytes(b"x" * loader.MAX_CONFIGURATION_BYTES)
            with mock.patch.object(loader.os, "read", wraps=loader.os.read) as read:
                payload = loader._read_configuration(path)

        requested = [call.args[1] for call in read.call_args_list]
        self.assertEqual(len(payload), loader.MAX_CONFIGURATION_BYTES)
        self.assertLessEqual(sum(requested), loader.MAX_CONFIGURATION_BYTES + 1)

    def test_oversize_is_rejected_before_any_payload_read(self) -> None:
        with TemporaryDirectory() as directory:
            path = Path(directory) / "config.toml"
            path.write_bytes(b"x" * (loader.MAX_CONFIGURATION_BYTES + 1))
            with (
                mock.patch.object(loader.os, "read", side_effect=AssertionError("read")) as read,
                self.assertRaisesRegex(ValidationError, "size limit"),
            ):
                loader._read_configuration(path)

        read.assert_not_called()

    def test_named_symlink_swap_is_rejected_without_reading_payload(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / "config.toml"
            replacement = root / "replacement.toml"
            path.write_bytes(b"payload")
            replacement.write_bytes(b"replacement")
            named_before = os.lstat(path)
            named_symlink = SimpleNamespace(
                st_mode=0o120777,
                st_dev=named_before.st_dev,
                st_ino=named_before.st_ino,
            )
            with (
                mock.patch.object(
                    loader.os,
                    "lstat",
                    side_effect=(named_before, named_symlink),
                ),
                mock.patch.object(loader.os, "read", side_effect=AssertionError("read")) as read,
                self.assertRaisesRegex(ValidationError, "symbolic link"),
            ):
                loader._read_configuration(path)

        read.assert_not_called()

    def test_descriptor_identity_mutation_is_rejected_after_read(self) -> None:
        with TemporaryDirectory() as directory:
            path = Path(directory) / "config.toml"
            path.write_bytes(b"payload")
            real_fstat = loader.os.fstat
            call_count = 0

            def fstat(fd: int) -> os.stat_result | SimpleNamespace:
                nonlocal call_count
                current = real_fstat(fd)
                call_count += 1
                if call_count == 2:
                    return SimpleNamespace(
                        st_mode=current.st_mode,
                        st_dev=current.st_dev,
                        st_ino=current.st_ino + 1,
                        st_size=current.st_size,
                        st_mtime_ns=current.st_mtime_ns,
                        st_ctime_ns=current.st_ctime_ns,
                    )
                return current

            with (
                mock.patch.object(loader.os, "fstat", side_effect=fstat),
                self.assertRaisesRegex(ValidationError, "changed"),
            ):
                loader._read_configuration(path)


class M10PathAndUrlSecurityTests(TestCase):
    def test_writable_ancestor_is_rejected_even_with_safe_deepest_anchor(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            writable = root / "writable"
            anchor = writable / "anchor"
            writable.mkdir(mode=0o770)
            anchor.mkdir(mode=0o700)
            with self.assertRaisesRegex(ValidationError, "unsafe_path"):
                parse_configuration(
                    configuration_body(
                        root, catalog=anchor / "catalog.sqlite", storage_root=anchor / "storage"
                    ),
                    base_dir=root,
                )

    def test_sticky_world_writable_ancestor_requires_and_accepts_private_anchor(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            sticky = root / "sticky"
            anchor = sticky / "anchor"
            sticky.mkdir(mode=0o1777)
            sticky.chmod(0o1777)
            anchor.mkdir(mode=0o700)
            body = configuration_body(
                root, catalog=anchor / "catalog.sqlite", storage_root=anchor / "storage"
            )
            config = parse_configuration(body, base_dir=root)
        self.assertEqual(config.paths.catalog, anchor / "catalog.sqlite")

    def test_direct_relative_and_lexical_alias_paths_are_rejected(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            config = parse_configuration(configuration_body(root), base_dir=root)
            relative = config.model_copy(
                update={
                    "paths": PathsConfig(
                        catalog=Path("catalog.sqlite"), storage_root=Path("storage")
                    )
                }
            )
            lexical = config.model_copy(
                update={
                    "paths": PathsConfig(
                        catalog=root / "nested" / ".." / "catalog.sqlite",
                        storage_root=root / "storage",
                    )
                }
            )
            for invalid in (relative, lexical):
                with self.subTest(invalid=invalid), self.assertRaises(ValidationError):
                    validate_configuration(invalid)

    def _configuration_url_body(self, root: Path, url: str, *, remote: bool) -> str:
        if remote:
            return configuration_body(
                root,
                parsing_protocol="remote",
                parsing_base_url=url,
                parsing_remote_upload=True,
                parsing_secret_ref="env:PARSER_SECRET",
            )
        return configuration_body(root, analysis_base_url=url)

    def _parse_url(self, root: Path, url: str, *, remote: bool) -> TargetConfig:
        return parse_configuration(
            self._configuration_url_body(root, url, remote=remote), base_dir=root
        )

    def _assert_url_rejected(self, root: Path, url: str, *, remote: bool) -> None:
        with self.assertRaises(ValidationError):
            self._parse_url(root, url, remote=remote)

    def _assert_loopback_rejected(self, root: Path, base_url: str) -> None:
        with self.assertRaises(ValidationError):
            parse_configuration(configuration_body(root, parsing_base_url=base_url), base_dir=root)

    def test_url_hostname_corpus_rejects_unsafe_and_legacy_forms(self) -> None:
        overlong_label = "a" * 64
        overlong_total = ".".join(("a" * 63, "b" * 63, "c" * 63, "d" * 62))
        invalid_urls = (
            "https://api.example.com/%00",
            "https://api.example.com/%20",
            "https://api.example.com/%C3%28",
            "https://api.example.com/v1//part",
            "https://api.example.com/../part",
            "https://api.example.com./v1",
            "https://api..example.com/v1",
            "https://%65xample.com/v1",
            "https://api.example.com/v1?",
            "https://api.example.com/v1#",
            "https://[2001:db8::1]/v1",
            "https://-bad.example/v1",
            "https://bad-.example/v1",
            "https://api_example.com/v1",
            f"https://{overlong_label}.example/v1",
            f"https://{overlong_total}/v1",
            "https://api.example.com\\\\evil/v1",
            "https://api%2eexample.com/v1",
        )
        invalid_hosts = (
            "127.000.000.001 2130706433 0x7f000001 017700000001 0177.0.0.1 "
            "xn--a xn--aa xn--0 xn--zzzz xn--abc xn---abc xn--a-b"
        ).split()
        with TemporaryDirectory() as directory:
            root = Path(directory)
            for role, remote in (("analysis", False), ("remote", True)):
                for url in invalid_urls:
                    with self.subTest(role=role, url=url):
                        self._assert_url_rejected(root, url, remote=remote)
                for host in invalid_hosts:
                    with self.subTest(role=role, host=host):
                        self._assert_url_rejected(root, f"https://{host}/v1", remote=remote)

    def test_url_hostname_corpus_preserves_valid_hosts_and_remote_policy(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            for role, remote in (("analysis", False), ("remote", True)):
                for host in (
                    "api.example.com Api.Example.COM bücher.example xn--bcher-kva.example"
                ).split():
                    with self.subTest(role=role, host=host):
                        self._parse_url(root, f"https://{host}/v1", remote=remote)
            for base_url in ("http://localhost:8000", "http://127.0.0.1:8000", "http://[::1]:8000"):
                parse_configuration(
                    configuration_body(root, parsing_base_url=base_url), base_dir=root
                )
            for base_url in ("http://localhost.", "http://127.0.0.1."):
                self._assert_loopback_rejected(root, base_url)
            self._assert_url_rejected(root, "https://192.0.2.10/parser", remote=True)
            self.assertEqual(
                self._parse_url(
                    root, "https://parser.example.com:8443/parser", remote=True
                ).parsing.protocol.value,
                "remote",
            )

    def test_parser_and_analysis_model_ids_reject_any_whitespace(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            cases = (
                configuration_body(root, parsing_model=" model"),
                configuration_body(root, parsing_model="model\t"),
                configuration_body(root, analysis_model="analysis model"),
                configuration_body(root, analysis_model="\\n"),
            )
            for index, body in enumerate(cases):
                with self.subTest(index=index), self.assertRaises(ValidationError):
                    parse_configuration(body, base_dir=root)
