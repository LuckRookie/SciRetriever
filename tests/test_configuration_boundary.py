from __future__ import annotations

import os
import pickle
import stat
import tempfile
import unittest
from pathlib import Path
from typing import Iterator, Mapping, TypeVar, overload
from unittest import mock

from pydantic import ValidationError

import sciretriever.configuration as configuration
from sciretriever.configuration import (
    ConfigurationError,
    credential_diagnostic,
    credential_path,
    credential_section_exists,
    credential_status_for,
    load_credentials,
    parse_configuration,
    remove_credentials,
    set_credentials,
)
from sciretriever.model.configuration import (
    Configuration,
    CredentialStatus,
    ProviderCapability,
)

SENTINEL = "CONFIGURATION-SECRET-SENTINEL"
_DefaultT = TypeVar("_DefaultT")


class _TrackingEnvironment(Mapping[str, str]):
    def __init__(self, values: Mapping[str, str]) -> None:
        self._values = dict(values)
        self.reads: list[str] = []

    def __getitem__(self, key: str) -> str:
        raise AssertionError("runtime secret selection must use bounded get")

    def __iter__(self) -> Iterator[str]:
        raise AssertionError("runtime secret selection must not enumerate environment")

    def __len__(self) -> int:
        raise AssertionError("runtime secret selection must not inspect environment size")

    @overload
    def get(self, key: str) -> str | None: ...

    @overload
    def get(self, key: str, default: str) -> str: ...

    @overload
    def get(self, key: str, default: _DefaultT) -> str | _DefaultT: ...

    def get(self, key: str, default: _DefaultT | None = None) -> str | _DefaultT | None:
        self.reads.append(key)
        return self._values.get(key, default)


class ConfigurationModelBoundaryTests(unittest.TestCase):
    def test_private_secret_containers_explicitly_reject_pickle_without_leakage(self) -> None:
        selected = parse_configuration(
            """
            [parsing]
            connection_mode = "remote"
            [analysis]
            provider = "openai"
            """
        )
        runtime = configuration.load_runtime_secrets(
            selected,
            environment={
                "SCIRETRIEVER_MINERU_BEARER_TOKEN": f"mineru-{SENTINEL}",
                "SCIRETRIEVER_OPENAI_API_KEY": f"analysis-{SENTINEL}",
            },
        )
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            set_credentials("web-of-science", {"api_key": SENTINEL}, home=home)
            credentials = load_credentials(home=home)

        for container in (runtime, credentials):
            with self.subTest(container=type(container).__name__):
                with self.assertRaises(TypeError) as caught:
                    pickle.dumps(container)
                self.assertEqual(str(caught.exception), "secret container is not serializable")
                self.assertNotIn(SENTINEL, str(caught.exception))
                self.assertNotIn(SENTINEL, repr(caught.exception))
                self.assertNotIn(SENTINEL, repr(container))

    def test_runtime_secret_selection_reads_only_requested_fixed_capabilities(self) -> None:
        selected = parse_configuration(
            """
            [parsing]
            connection_mode = "remote"
            [analysis]
            provider = "openai"
            """
        )
        values = {
            "SCIRETRIEVER_MINERU_BEARER_TOKEN": "mineru-secret",
            "SCIRETRIEVER_OPENAI_API_KEY": "analysis-secret",
        }
        cases = (
            (True, False, ["SCIRETRIEVER_MINERU_BEARER_TOKEN"]),
            (False, True, ["SCIRETRIEVER_OPENAI_API_KEY"]),
            (False, False, []),
        )
        for include_parser, include_analysis, expected_reads in cases:
            with self.subTest(parser=include_parser, analysis=include_analysis):
                environment = _TrackingEnvironment(values)
                configuration.load_runtime_secrets(
                    selected,
                    environment=environment,
                    include_parser=include_parser,
                    include_analysis=include_analysis,
                )
                self.assertEqual(environment.reads, expected_reads)

    def test_only_nine_empty_responsibility_groups_are_ordinary_configuration(self) -> None:
        configuration_model = parse_configuration(
            """
            [paths]
            [discovery]
            [sources]
            [assets]
            [parsing]
            [analysis]
            [execution]
            [library]
            [access]
            """
        )
        self.assertIsInstance(configuration_model, Configuration)
        self.assertEqual(
            set(Configuration.model_fields),
            {
                "paths",
                "discovery",
                "sources",
                "assets",
                "parsing",
                "analysis",
                "execution",
                "library",
                "access",
            },
        )
        self.assertNotIn("credentials", Configuration.model_fields)
        self.assertNotIn("schema_version", Configuration.model_fields)

    def test_unknown_sections_keys_duplicate_toml_and_secret_reference_fail_closed(self) -> None:
        invalid = (
            "[collection]\n",
            "[paths]\nunknown = 1\n",
            "schema_version = 2\n",
            '[analysis]\nsecret_ref = "env:SECRET"\n',
            "[paths]\na = 1\na = 2\n",
        )
        for payload in invalid:
            with self.subTest(payload=payload):
                with self.assertRaises(ConfigurationError) as caught:
                    parse_configuration(payload)
                self.assertNotIn(SENTINEL, str(caught.exception))

    def test_model_contracts_are_frozen_and_secret_free(self) -> None:
        model = parse_configuration("[paths]\n")
        with self.assertRaises(ValidationError):
            model.paths = model.paths  # type: ignore[misc]
        self.assertNotIn(SENTINEL, repr(model))
        self.assertNotIn(SENTINEL, model.model_dump_json())
        self.assertNotIn(
            "CredentialsConfig",
            vars(__import__("sciretriever.model.configuration", fromlist=["configuration"])),
        )


class CredentialStatusTests(unittest.TestCase):
    def test_provider_matrix_and_exact_status_vocabulary(self) -> None:
        expected = {
            "web-of-science": ("metadata",),
            "crossref": ("metadata", "acquisition"),
            "semantic-scholar": ("metadata", "acquisition"),
            "arxiv": ("metadata", "acquisition"),
            "openalex": ("metadata", "acquisition"),
            "europe-pmc": ("metadata", "acquisition"),
            "elsevier": ("metadata", "acquisition"),
            "springer": ("metadata", "acquisition"),
            "datacite": ("metadata", "acquisition"),
            "core": ("metadata", "acquisition"),
            "opencitations": ("metadata",),
            "unpaywall": ("acquisition",),
            "wiley": ("acquisition",),
            "sci-hub": ("acquisition",),
        }
        with tempfile.TemporaryDirectory() as temporary:
            credentials = load_credentials(home=Path(temporary))
        with mock.patch.object(
            configuration,
            "load_credentials",
            side_effect=AssertionError("offline status must not read default credentials"),
        ):
            for provider, capabilities in expected.items():
                diagnostic = credential_diagnostic(
                    provider,
                    credentials=credentials,
                    supported_capabilities=capabilities,
                )
                self.assertEqual(
                    tuple(item.capability.value for item in diagnostic.capabilities), capabilities
                )
                for item in diagnostic.capabilities:
                    self.assertIn(item.status, tuple(CredentialStatus))
            self.assertEqual(
                credential_status_for(
                    "web-of-science",
                    "metadata",
                    credentials=credentials,
                    supported_capabilities=(ProviderCapability.METADATA,),
                ).status,
                CredentialStatus.MISSING,
            )
            self.assertEqual(
                credential_status_for(
                    "semantic-scholar",
                    "metadata",
                    credentials=credentials,
                    supported_capabilities=("metadata",),
                ).status,
                CredentialStatus.OPTIONAL_MISSING,
            )
            self.assertEqual(
                credential_status_for(
                    "crossref",
                    "metadata",
                    credentials=credentials,
                    supported_capabilities=("metadata",),
                ).status,
                CredentialStatus.NOT_REQUIRED,
            )
            self.assertEqual(
                credential_status_for(
                    "wiley",
                    "acquisition",
                    credentials=credentials,
                    supported_capabilities=("acquisition",),
                ).status,
                CredentialStatus.UNSUPPORTED,
            )
            with self.assertRaises(ConfigurationError):
                credential_status_for(
                    "web-of-science",
                    "acquisition",
                    credentials=credentials,
                    supported_capabilities=("acquisition",),
                )
            self.assertEqual(
                credential_status_for(
                    "sci-hub",
                    "acquisition",
                    credentials=credentials,
                    supported_capabilities=("acquisition",),
                ).status,
                CredentialStatus.NOT_REQUIRED,
            )
            self.assertEqual(
                credential_status_for(
                    "web-of-science",
                    "metadata",
                    credentials=credentials,
                ).status,
                CredentialStatus.UNSUPPORTED,
            )
            with self.assertRaises(ConfigurationError):
                credential_diagnostic(
                    "web-of-science",
                    credentials=credentials,
                    supported_capabilities=("acquisition",),
                )
            with self.assertRaises(ConfigurationError):
                credential_status_for(
                    "web-of-science",
                    "metadata",
                    credentials=credentials,
                    supported_capabilities=("metadata", "acquisition"),
                )

    def test_configured_partial_and_optional_missing_statuses_have_presence_only(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            set_credentials("web-of-science", {"api_key": SENTINEL}, home=home)
            status = credential_status_for(
                "web-of-science", "metadata", home=home, supported_capabilities=("metadata",)
            )
            self.assertEqual(status.status, CredentialStatus.CONFIGURED)
            self.assertEqual(status.fields[0].present, True)
            self.assertNotIn(SENTINEL, repr(status))
            self.assertNotIn(SENTINEL, status.model_dump_json())

            set_credentials("elsevier", {"api_key": SENTINEL}, home=home)
            status = credential_status_for(
                "elsevier", "metadata", home=home, supported_capabilities=("metadata",)
            )
            self.assertEqual(status.status, CredentialStatus.OPTIONAL_MISSING)
            self.assertEqual(
                tuple(field.name for field in status.fields),
                ("api_key", "institution_token"),
            )

            set_credentials("elsevier", {"institution_token": "institution"}, home=home)
            status = credential_status_for(
                "elsevier", "metadata", home=home, supported_capabilities=("metadata",)
            )
            self.assertEqual(status.status, CredentialStatus.PARTIAL)

            springer = credential_diagnostic(
                "springer",
                home=home,
                supported_capabilities=("metadata", "acquisition"),
            )
            self.assertEqual(
                tuple(field.name for field in springer.capabilities[0].fields),
                ("api_key",),
            )
            self.assertEqual(springer.capabilities[1].status, CredentialStatus.UNSUPPORTED)


class CredentialFileSecurityTests(unittest.TestCase):
    def _secure_dir(self, home: Path) -> Path:
        directory = home / ".sciretriever"
        directory.mkdir(mode=0o700)
        os.chmod(directory, 0o700)
        return directory

    def _write(self, home: Path, payload: bytes) -> Path:
        directory = self._secure_dir(home)
        path = directory / "credentials.toml"
        path.write_bytes(payload)
        os.chmod(path, 0o600)
        return path

    def test_fixed_path_and_missing_file_do_not_read_an_arbitrary_credentials_path(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            path = credential_path(home=home)
            self.assertEqual(path, home / ".sciretriever" / "credentials.toml")
            self.assertEqual(load_credentials(home=home).field_names("web-of-science"), ())
            self.assertEqual(path.name, "credentials.toml")

    def test_credential_section_presence_is_secret_free_and_fail_closed(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            self.assertIs(credential_section_exists("web-of-science", home=home), False)
            set_credentials("web-of-science", {"api_key": SENTINEL}, home=home)
            present = credential_section_exists("web-of-science", home=home)
            self.assertIs(present, True)
            self.assertNotIn(SENTINEL, repr(present))

            for provider in ("crossref", "wiley", "sci-hub"):
                with self.subTest(provider=provider):
                    with self.assertRaises(ConfigurationError) as caught:
                        credential_section_exists(provider, home=home)
                    self.assertEqual(str(caught.exception), "credentials provider is unsupported")

            os.chmod(credential_path(home=home), 0o644)
            with self.assertRaises(ConfigurationError) as caught:
                credential_section_exists("web-of-science", home=home)
            self.assertEqual(
                str(caught.exception),
                "credentials file has unsafe ownership or permissions",
            )

    def test_credential_section_presence_does_not_construct_network_or_storage(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            with (
                mock.patch(
                    "sciretriever.network.http.HttpClient",
                    side_effect=AssertionError("credential presence must not construct Network"),
                ),
                mock.patch(
                    "sciretriever.storage.sqlite.engine.CatalogEngine",
                    side_effect=AssertionError("credential presence must not construct Storage"),
                ),
            ):
                self.assertFalse(credential_section_exists("elsevier", home=home))

    def test_directory_and_file_owner_mode_regular_nofollow_and_single_link(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            path = self._write(home, b'[web-of-science]\napi_key = "value"\n')
            self.assertEqual(stat.S_IMODE(path.parent.stat().st_mode), 0o700)
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
            self.assertEqual(path.stat().st_nlink, 1)
            self.assertEqual(load_credentials(home=home).get("web-of-science", "api_key"), "value")

            os.chmod(path.parent, 0o755)
            with self.assertRaises(ConfigurationError):
                load_credentials(home=home)
            os.chmod(path.parent, 0o700)
            os.chmod(path, 0o644)
            with self.assertRaises(ConfigurationError):
                load_credentials(home=home)

    def test_symlink_directory_file_and_hardlink_are_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            home = root / "home"
            home.mkdir()
            target = root / "target"
            target.mkdir()
            (home / ".sciretriever").symlink_to(target, target_is_directory=True)
            with self.assertRaises(ConfigurationError):
                load_credentials(home=home)

            (home / ".sciretriever").unlink()
            directory = self._secure_dir(home)
            real = root / "real.toml"
            real.write_text('[web-of-science]\napi_key = "value"\n', encoding="utf-8")
            os.chmod(real, 0o600)
            (directory / "credentials.toml").symlink_to(real)
            with self.assertRaises(ConfigurationError):
                load_credentials(home=home)

            (directory / "credentials.toml").unlink()
            path = directory / "credentials.toml"
            path.write_text('[web-of-science]\napi_key = "value"\n', encoding="utf-8")
            os.chmod(path, 0o600)
            os.link(path, root / "hardlink.toml")
            with self.assertRaises(ConfigurationError):
                load_credentials(home=home)

    def test_wrong_owner_is_fail_closed_without_reading_values(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            self._write(home, f'[web-of-science]\napi_key = "{SENTINEL}"\n'.encode())
            with mock.patch.object(configuration, "_current_uid", return_value=os.getuid() + 1):
                with self.assertRaises(ConfigurationError) as caught:
                    load_credentials(home=home)
            self.assertNotIn(SENTINEL, str(caught.exception))

    def test_bounded_read_and_duplicate_unknown_empty_non_string_toml_fail_closed(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            path = self._write(home, b"x" * (configuration._MAX_CREDENTIALS_BYTES + 1))
            with self.assertRaises(ConfigurationError):
                load_credentials(home=home)
            path.write_text('[unknown]\napi_key = "value"\n', encoding="utf-8")
            os.chmod(path, 0o600)
            with self.assertRaises(ConfigurationError):
                load_credentials(home=home)
            for payload in (
                '[web-of-science]\nother = "value"\n',
                '[web-of-science]\napi_key = ""\n',
                "[web-of-science]\napi_key = 1\n",
                '[web-of-science]\napi_key = "a"\napi_key = "b"\n',
                '[wiley]\napi_key = "value"\n',
            ):
                path.write_text(payload, encoding="utf-8")
                os.chmod(path, 0o600)
                with self.subTest(payload=payload):
                    with self.assertRaises(ConfigurationError) as caught:
                        load_credentials(home=home)
                    self.assertNotIn(SENTINEL, str(caught.exception))


class CredentialPublicationTests(unittest.TestCase):
    def test_set_remove_are_atomic_and_keep_providers_separate(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            set_credentials("web-of-science", {"api_key": SENTINEL}, home=home)
            original = credential_path(home=home).read_bytes()
            set_credentials("elsevier", {"api_key": "elsevier"}, home=home)
            self.assertIn(b"web-of-science", credential_path(home=home).read_bytes())
            remove_credentials("web-of-science", home=home)
            payload = credential_path(home=home).read_bytes()
            self.assertNotIn(SENTINEL.encode(), payload)
            self.assertIn(b"elsevier", payload)
            self.assertEqual(
                remove_credentials("web-of-science", home=home).field_names("web-of-science"), ()
            )
            self.assertNotEqual(original, payload)

    def test_each_prepublication_failure_keeps_old_bytes_and_cleans_staging(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            path = credential_path(home=home)
            set_credentials("web-of-science", {"api_key": "old"}, home=home)
            old = path.read_bytes()
            for fail_name in (
                "staging-created",
                "staging-written",
                "staging-fsynced",
                "staging-validated",
                "before-replace",
            ):

                def failpoint(name: str, expected: str = fail_name) -> None:
                    if name == expected:
                        raise RuntimeError("publication fault")

                with self.subTest(fail_name=fail_name):
                    with self.assertRaises(ConfigurationError):
                        set_credentials(
                            "web-of-science",
                            {"api_key": SENTINEL},
                            home=home,
                            failpoint=failpoint,
                        )
                    self.assertEqual(path.read_bytes(), old)
                    self.assertEqual(tuple(path.parent.glob(".credentials-*.staging")), ())

    def test_replacement_race_is_detected_before_atomic_replace(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            path = credential_path(home=home)
            set_credentials("web-of-science", {"api_key": "old"}, home=home)
            old = path.read_bytes()

            def replace_before_publish(name: str) -> None:
                if name == "staging-validated":
                    replacement = path.with_name("replacement.toml")
                    replacement.write_bytes(b'[web-of-science]\napi_key = "other"\n')
                    os.chmod(replacement, 0o600)
                    os.replace(replacement, path)

            with self.assertRaises(ConfigurationError):
                set_credentials(
                    "web-of-science",
                    {"api_key": SENTINEL},
                    home=home,
                    failpoint=replace_before_publish,
                )
            self.assertNotEqual(path.read_bytes(), old)
            self.assertNotIn(SENTINEL.encode(), path.read_bytes())
            self.assertEqual(tuple(path.parent.glob(".credentials-*.staging")), ())

    def test_after_commit_injection_returns_complete_new_file_without_failure(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            path = credential_path(home=home)
            set_credentials("web-of-science", {"api_key": "old"}, home=home)

            def fail_after_replace(name: str) -> None:
                if name == "after-replace":
                    raise RuntimeError("post-publication fault")

            returned = set_credentials(
                "web-of-science",
                {"api_key": SENTINEL},
                home=home,
                failpoint=fail_after_replace,
            )
            self.assertEqual(returned.get("web-of-science", "api_key"), SENTINEL)
            self.assertEqual(
                path.read_bytes(), f'[web-of-science]\napi_key = "{SENTINEL}"\n\n'.encode()
            )
            self.assertNotIn(SENTINEL, repr(returned))
            self.assertEqual(tuple(path.parent.glob(".credentials-*.staging")), ())
            self.assertEqual(tuple(path.parent.glob("*.bak")), ())

    def test_directory_fsync_is_attempted_after_commit(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            path = credential_path(home=home)
            set_credentials("web-of-science", {"api_key": "old"}, home=home)
            events: list[str] = []

            def observe(name: str) -> None:
                events.append(name)

            set_credentials(
                "web-of-science",
                {"api_key": SENTINEL},
                home=home,
                failpoint=observe,
            )
            self.assertIn("before-directory-fsync", events)
            self.assertIn("directory-fsynced", events)
            self.assertEqual(
                path.read_bytes(), f'[web-of-science]\napi_key = "{SENTINEL}"\n\n'.encode()
            )
            self.assertEqual(tuple(path.parent.glob(".credentials-*.staging")), ())
            self.assertEqual(tuple(path.parent.glob("*.bak")), ())

    def test_directory_fsync_failure_after_commit_does_not_report_failure(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            path = credential_path(home=home)
            set_credentials("web-of-science", {"api_key": "old"}, home=home)
            real_fsync = os.fsync

            def fail_directory_fsync(descriptor: int) -> None:
                if stat.S_ISDIR(os.fstat(descriptor).st_mode):
                    raise OSError("directory fsync fault")
                real_fsync(descriptor)

            with mock.patch.object(
                configuration.os,
                "fsync",
                side_effect=fail_directory_fsync,
            ):
                returned = set_credentials(
                    "web-of-science",
                    {"api_key": SENTINEL},
                    home=home,
                )

            self.assertEqual(returned.get("web-of-science", "api_key"), SENTINEL)
            self.assertEqual(
                path.read_bytes(), f'[web-of-science]\napi_key = "{SENTINEL}"\n\n'.encode()
            )
            self.assertEqual(tuple(path.parent.glob(".credentials-*.staging")), ())
            self.assertEqual(tuple(path.parent.glob("*.bak")), ())


if __name__ == "__main__":
    unittest.main()
