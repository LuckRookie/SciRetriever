import importlib
import os
import sys
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase
from unittest.mock import patch


REPOSITORY = Path(__file__).resolve().parents[1]
SRC = REPOSITORY / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

config = importlib.import_module("sciretriever.config")
errors = importlib.import_module("sciretriever.errors")


class ConfigTests(TestCase):
    def test_explicit_storage_root_takes_precedence(self) -> None:
        explicit = Path("explicit-root")
        resolved = config.resolve_storage_root(
            explicit, env={"SCIRETRIEVER_STORAGE_ROOT": "environment-root"}
        )

        self.assertEqual(resolved, explicit.resolve())

    def test_storage_root_uses_injected_environment(self) -> None:
        resolved = config.resolve_storage_root(
            env={config.STORAGE_ROOT_ENV: "~/injected-root"}
        )

        self.assertEqual(resolved, Path("~/injected-root").expanduser().resolve())

    def test_storage_root_uses_process_environment_by_default(self) -> None:
        with patch.dict(
            os.environ, {config.STORAGE_ROOT_ENV: "process-root"}, clear=True
        ):
            resolved = config.resolve_storage_root()

        self.assertEqual(resolved, Path("process-root").resolve())

    def test_unset_storage_root_raises_config_error(self) -> None:
        with self.assertRaises(errors.ConfigError):
            config.resolve_storage_root(env={})

    def test_nonexisting_storage_root_is_not_created(self) -> None:
        with TemporaryDirectory() as temporary_directory:
            candidate = Path(temporary_directory) / "missing" / "root"

            resolved = config.resolve_storage_root(candidate, env={})

            self.assertEqual(resolved, candidate.resolve())
            self.assertFalse(candidate.exists())

    def test_credential_is_stripped(self) -> None:
        self.assertEqual(
            config.get_credential("API_KEY", env={"API_KEY": " secret \n"}),
            "secret",
        )

    def test_absent_and_empty_credentials_return_none(self) -> None:
        self.assertIsNone(config.get_credential("ABSENT", env={}))
        self.assertIsNone(config.get_credential("EMPTY", env={"EMPTY": " \t"}))

    def test_credential_uses_process_environment_by_default(self) -> None:
        with patch.dict(os.environ, {"API_KEY": " process-secret "}, clear=True):
            credential = config.get_credential("API_KEY")

        self.assertEqual(credential, "process-secret")

    def test_blank_credential_variable_name_raises_config_error(self) -> None:
        with self.assertRaises(errors.ConfigError):
            config.get_credential("   ", env={})

    def test_import_and_calls_create_no_files_or_directories(self) -> None:
        with TemporaryDirectory() as temporary_directory:
            temporary_path = Path(temporary_directory)
            storage_root = temporary_path / "storage" / "root"
            before = set(temporary_path.rglob("*"))

            sys.modules.pop("sciretriever.config", None)
            config = importlib.import_module("sciretriever.config")
            config.resolve_storage_root(storage_root, env={})
            config.get_credential("API_KEY", env={"API_KEY": "secret"})

            self.assertEqual(set(temporary_path.rglob("*")), before)
