from __future__ import annotations

import os
import pickle
import stat
import tempfile
import threading
import unittest
from pathlib import Path
from typing import cast
from unittest import mock

import sciretriever.configuration as configuration
from sciretriever.configuration import (
    BrowserProfileHandle,
    ConfigurationError,
    browser_profile_path,
    browser_profile_status,
    configure_browser_access_profile,
    credential_path,
    initialize_browser_profile,
    load_editable_configuration,
    remove_browser_profile,
    resolve_browser_profile,
    set_credentials,
)
from sciretriever.model.configuration import AccessConfig, BrowserProfilePresence

_PROFILE_IDENTITY = "wiley-online-library"
_CONTENT_SENTINEL = "BROWSER-COOKIE-CONTENT-SENTINEL"


class _SequencedCancellation:
    def __init__(self, cancel_on_call: int) -> None:
        self.cancel_on_call = cancel_on_call
        self.calls = 0

    def is_set(self) -> bool:
        self.calls += 1
        return self.calls >= self.cancel_on_call


class _BrokenCancellation:
    def is_set(self) -> bool:
        raise RuntimeError("cancellation sentinel")


class BrowserProfileBoundaryTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="sciretriever-profile-test-")
        self.addCleanup(self.temporary.cleanup)
        self.home = Path(self.temporary.name)

    @staticmethod
    def _mode(path: Path) -> int:
        return stat.S_IMODE(path.lstat().st_mode)

    def _initialize(self, identity: str = _PROFILE_IDENTITY) -> BrowserProfileHandle:
        return initialize_browser_profile(identity, home=self.home)

    def test_identity_maps_only_to_the_fixed_user_profile_directory(self) -> None:
        expected = self.home / ".sciretriever" / "browser-profiles" / _PROFILE_IDENTITY
        self.assertEqual(
            browser_profile_path("  Wiley-Online-Library  ", home=self.home),
            expected,
        )
        invalid: tuple[object, ...] = (
            None,
            "",
            "/tmp/profile",
            "../profile",
            "https://publisher.test/profile",
            "publisher-token",
            "cookie-profile",
            "123e4567-e89b-12d3-a456-426614174000",
            "profile_name",
            "a" * 97,
        )
        for value in invalid:
            with self.subTest(value=value), self.assertRaises(ConfigurationError):
                browser_profile_path(cast(str, value), home=self.home)
        self.assertFalse((self.home / ".sciretriever").exists())

    def test_initialize_and_resolve_are_owner_only_and_credentials_independent(self) -> None:
        credentials = set_credentials(
            "web-of-science",
            {"api_key": "fixture-provider-secret"},
            home=self.home,
        )
        self.assertTrue(credentials.has_provider("web-of-science"))
        credential_bytes = credential_path(home=self.home).read_bytes()

        handle = self._initialize()
        path = browser_profile_path(_PROFILE_IDENTITY, home=self.home)
        selected = resolve_browser_profile(_PROFILE_IDENTITY, home=self.home)

        self.assertIsInstance(handle, BrowserProfileHandle)
        self.assertEqual(handle.profile_identity, _PROFILE_IDENTITY)
        self.assertEqual(selected.runtime_directory(), path)
        self.assertEqual(handle.runtime_directory(), path)
        self.assertEqual(self._mode(self.home / ".sciretriever"), 0o700)
        self.assertEqual(self._mode(path.parent), 0o700)
        self.assertEqual(self._mode(path), 0o700)
        self.assertEqual(credential_path(home=self.home).read_bytes(), credential_bytes)
        self.assertEqual(
            browser_profile_status(_PROFILE_IDENTITY, home=self.home).presence,
            BrowserProfilePresence.CONFIGURED,
        )

    def test_recursive_validation_reads_no_profile_bytes_and_discloses_no_content(self) -> None:
        handle = self._initialize()
        path = handle.runtime_directory()
        nested = path / "Default" / "Storage"
        nested.mkdir(parents=True, mode=0o700)
        os.chmod(path / "Default", 0o700)
        os.chmod(nested, 0o700)
        cookie_store = nested / "Cookies"
        cookie_store.write_text(_CONTENT_SENTINEL, encoding="utf-8")
        os.chmod(cookie_store, 0o600)

        with mock.patch.object(
            configuration.os,
            "read",
            side_effect=AssertionError("profile bytes must not be read"),
        ):
            selected = resolve_browser_profile(_PROFILE_IDENTITY, home=self.home)
            status = browser_profile_status(_PROFILE_IDENTITY, home=self.home)

        self.assertEqual(selected.runtime_directory(), path)
        self.assertEqual(status.model_dump(mode="json"), {"presence": "configured"})
        for value in (repr(selected), repr(status), str(status), repr(status.model_dump())):
            self.assertNotIn(_CONTENT_SENTINEL, value)
            self.assertNotIn("Cookies", value)
        with self.assertRaises(TypeError) as caught:
            pickle.dumps(selected)
        self.assertNotIn(_CONTENT_SENTINEL, str(caught.exception))
        self.assertNotIn(os.fspath(self.home), repr(selected))
        self.assertNotIn(_PROFILE_IDENTITY, repr(selected))

    def test_status_has_only_configured_missing_and_attention_states(self) -> None:
        self.assertEqual(
            browser_profile_status(None, home=self.home).presence,
            BrowserProfilePresence.MISSING,
        )
        self.assertFalse((self.home / ".sciretriever").exists())
        self.assertEqual(
            browser_profile_status(_PROFILE_IDENTITY, home=self.home).presence,
            BrowserProfilePresence.MISSING,
        )
        self.assertEqual(
            browser_profile_status("publisher-token", home=self.home).presence,
            BrowserProfilePresence.ATTENTION,
        )
        path = self._initialize().runtime_directory()
        os.chmod(path, 0o755)
        status = browser_profile_status(_PROFILE_IDENTITY, home=self.home)
        self.assertEqual(status.presence, BrowserProfilePresence.ATTENTION)
        self.assertEqual(set(status.model_dump()), {"presence"})
        with self.assertRaises(ConfigurationError) as caught:
            resolve_browser_profile(_PROFILE_IDENTITY, home=self.home)
        self.assertNotIn(os.fspath(path), str(caught.exception))

    def test_parent_profile_and_nested_symlinks_fail_closed(self) -> None:
        outside = self.home / "outside"
        outside.mkdir(mode=0o700)
        private = self.home / ".sciretriever"
        private.symlink_to(outside, target_is_directory=True)
        self.assertEqual(
            browser_profile_status(_PROFILE_IDENTITY, home=self.home).presence,
            BrowserProfilePresence.ATTENTION,
        )
        with self.assertRaises(ConfigurationError):
            self._initialize()

        private.unlink()
        private.mkdir(mode=0o700)
        profile_storage = private / "browser-profiles"
        profile_storage.mkdir(mode=0o700)
        profile = profile_storage / _PROFILE_IDENTITY
        profile.symlink_to(outside, target_is_directory=True)
        self.assertEqual(
            browser_profile_status(_PROFILE_IDENTITY, home=self.home).presence,
            BrowserProfilePresence.ATTENTION,
        )
        profile.unlink()
        profile.mkdir(mode=0o700)
        (profile / "unsafe-link").symlink_to(outside)
        self.assertEqual(
            browser_profile_status(_PROFILE_IDENTITY, home=self.home).presence,
            BrowserProfilePresence.ATTENTION,
        )

    def test_recursive_permissions_hardlinks_and_special_files_fail_closed(self) -> None:
        cases = ("directory-mode", "file-mode", "hardlink", "fifo", "owner")
        for case in cases:
            with self.subTest(case=case):
                with tempfile.TemporaryDirectory(prefix="sciretriever-profile-case-") as temporary:
                    home = Path(temporary)
                    profile = initialize_browser_profile(_PROFILE_IDENTITY, home=home)
                    path = profile.runtime_directory()
                    child = path / "Default"
                    child.mkdir(mode=0o700)
                    payload = child / "state.db"
                    payload.write_bytes(b"fixture")
                    os.chmod(payload, 0o600)
                    if case == "directory-mode":
                        os.chmod(child, 0o755)
                    elif case == "file-mode":
                        os.chmod(payload, 0o644)
                    elif case == "hardlink":
                        os.link(payload, child / "state-copy.db")
                    elif case == "fifo":
                        payload.unlink()
                        os.mkfifo(payload, 0o600)
                    if case == "owner":
                        current_uid = os.geteuid()
                        owner = mock.patch.object(
                            configuration,
                            "_current_uid",
                            return_value=current_uid + 1,
                        )
                    else:
                        owner = mock.patch.object(
                            configuration,
                            "_current_uid",
                            wraps=configuration._current_uid,
                        )
                    with owner:
                        status = browser_profile_status(_PROFILE_IDENTITY, home=home)
                        self.assertEqual(status.presence, BrowserProfilePresence.ATTENTION)
                        with self.assertRaises(ConfigurationError):
                            resolve_browser_profile(_PROFILE_IDENTITY, home=home)

    def test_cancellation_creates_no_profile_and_cleans_a_just_created_directory(self) -> None:
        already_cancelled = threading.Event()
        already_cancelled.set()
        with self.assertRaisesRegex(ConfigurationError, "cancelled"):
            initialize_browser_profile(
                _PROFILE_IDENTITY,
                home=self.home,
                cancel_event=already_cancelled,
            )
        self.assertFalse((self.home / ".sciretriever").exists())

        cancellation = _SequencedCancellation(cancel_on_call=4)
        with self.assertRaisesRegex(ConfigurationError, "cancelled"):
            initialize_browser_profile(
                _PROFILE_IDENTITY,
                home=self.home,
                cancel_event=cancellation,
            )
        self.assertGreaterEqual(cancellation.calls, 4)
        self.assertFalse(browser_profile_path(_PROFILE_IDENTITY, home=self.home).exists())
        profile_storage = self.home / ".sciretriever" / "browser-profiles"
        self.assertTrue(profile_storage.is_dir())
        self.assertEqual(tuple(profile_storage.iterdir()), ())
        self.assertFalse(credential_path(home=self.home).exists())

        other_home = self.home / "broken-cancel"
        other_home.mkdir()
        with self.assertRaisesRegex(ConfigurationError, "cancelled"):
            initialize_browser_profile(
                _PROFILE_IDENTITY,
                home=other_home,
                cancel_event=_BrokenCancellation(),
            )
        self.assertFalse((other_home / ".sciretriever").exists())

    def test_existing_handle_detects_profile_directory_replacement(self) -> None:
        handle = self._initialize()
        path = handle.runtime_directory()
        displaced = path.with_name("displaced-profile")
        path.rename(displaced)
        path.mkdir(mode=0o700)

        self.assertEqual(
            browser_profile_status(_PROFILE_IDENTITY, home=self.home).presence,
            BrowserProfilePresence.CONFIGURED,
        )
        with self.assertRaisesRegex(ConfigurationError, "changed during validation"):
            handle.runtime_directory()

    def test_profile_removal_deletes_only_the_selected_validated_session(self) -> None:
        config_path = self.home / "config.toml"
        config_path.write_text("[execution]\nmax_concurrency = 3\n", encoding="utf-8")
        credentials = set_credentials(
            "web-of-science",
            {"api_key": "removal-secret-sentinel"},
            home=self.home,
        )
        self.assertTrue(credentials.has_provider("web-of-science"))
        credential_bytes = credential_path(home=self.home).read_bytes()
        configuration_bytes = config_path.read_bytes()

        profile_path = self._initialize().runtime_directory()
        nested = profile_path / "Default" / "Storage"
        nested.mkdir(parents=True, mode=0o700)
        os.chmod(nested.parent, 0o700)
        os.chmod(nested, 0o700)
        session = nested / "session.db"
        session.write_bytes(b"opaque-browser-session")
        os.chmod(session, 0o600)

        self.assertTrue(remove_browser_profile(_PROFILE_IDENTITY, home=self.home))
        self.assertFalse(profile_path.exists())
        self.assertEqual(
            browser_profile_status(_PROFILE_IDENTITY, home=self.home).presence,
            BrowserProfilePresence.MISSING,
        )
        self.assertFalse(remove_browser_profile(_PROFILE_IDENTITY, home=self.home))
        self.assertEqual(credential_path(home=self.home).read_bytes(), credential_bytes)
        self.assertEqual(config_path.read_bytes(), configuration_bytes)
        storage = self.home / ".sciretriever" / "browser-profiles"
        self.assertEqual(tuple(storage.iterdir()), ())

    def test_profile_removal_fails_closed_for_an_unsafe_tree(self) -> None:
        profile = self._initialize().runtime_directory()
        outside = self.home / "outside-session"
        outside.write_text("must-survive", encoding="utf-8")
        (profile / "unsafe-link").symlink_to(outside)

        with self.assertRaises(ConfigurationError):
            remove_browser_profile(_PROFILE_IDENTITY, home=self.home)

        self.assertTrue(profile.is_dir())
        self.assertTrue((profile / "unsafe-link").is_symlink())
        self.assertEqual(outside.read_text(encoding="utf-8"), "must-survive")
        storage = self.home / ".sciretriever" / "browser-profiles"
        self.assertFalse(any(item.name.startswith(".removing-") for item in storage.iterdir()))

    def test_access_selection_initializes_profile_and_preserves_other_configuration(self) -> None:
        config_path = self.home / "config.toml"
        config_path.write_text(
            "# keep this comment\n[execution]\nmax_concurrency = 7\n",
            encoding="utf-8",
        )
        candidate = AccessConfig(
            browser_enabled=True,
            browser_profile="Institutional-Access",
            browser_max_concurrency=1,
        )

        configured = configure_browser_access_profile(
            config_path,
            candidate,
            home=self.home,
        )

        self.assertTrue(configured.access.browser_enabled)
        self.assertEqual(configured.access.browser_profile, "institutional-access")
        self.assertEqual(configured.execution.max_concurrency, 7)
        self.assertIn("# keep this comment", config_path.read_text(encoding="utf-8"))
        reloaded = load_editable_configuration(config_path)
        self.assertEqual(reloaded, configured)
        self.assertEqual(
            browser_profile_status("institutional-access", home=self.home).presence,
            BrowserProfilePresence.CONFIGURED,
        )
        self.assertFalse(credential_path(home=self.home).exists())

    def test_cancelled_or_failed_access_selection_has_no_published_side_effect(self) -> None:
        config_path = self.home / "config.toml"
        original = b"# unchanged\n[execution]\nmax_concurrency = 5\n"
        config_path.write_bytes(original)
        candidate = AccessConfig(
            browser_enabled=True,
            browser_profile="institutional-access",
        )
        cancelled = threading.Event()
        cancelled.set()

        with self.assertRaisesRegex(ConfigurationError, "cancelled"):
            configure_browser_access_profile(
                config_path,
                candidate,
                home=self.home,
                cancel_event=cancelled,
            )
        self.assertEqual(config_path.read_bytes(), original)
        self.assertFalse((self.home / ".sciretriever").exists())

        def fail_after_profile(stage: str) -> None:
            if stage == "profile-initialized":
                raise RuntimeError(stage)

        with self.assertRaisesRegex(ConfigurationError, "interrupted"):
            configure_browser_access_profile(
                config_path,
                candidate,
                home=self.home,
                failpoint=fail_after_profile,
            )
        self.assertEqual(config_path.read_bytes(), original)
        self.assertEqual(
            browser_profile_status("institutional-access", home=self.home).presence,
            BrowserProfilePresence.MISSING,
        )
        self.assertFalse(credential_path(home=self.home).exists())

    def test_failed_access_selection_never_removes_an_existing_profile(self) -> None:
        config_path = self.home / "config.toml"
        original = b"# unchanged\n[execution]\nmax_concurrency = 5\n"
        config_path.write_bytes(original)
        profile = self._initialize().runtime_directory()
        existing_session = profile / "existing-session.db"
        existing_session.write_bytes(b"opaque-existing-session")
        os.chmod(existing_session, 0o600)
        candidate = AccessConfig(
            browser_enabled=True,
            browser_profile=_PROFILE_IDENTITY,
        )

        def fail_after_profile(stage: str) -> None:
            if stage == "profile-initialized":
                raise RuntimeError(stage)

        with self.assertRaisesRegex(ConfigurationError, "interrupted"):
            configure_browser_access_profile(
                config_path,
                candidate,
                home=self.home,
                failpoint=fail_after_profile,
            )

        self.assertEqual(config_path.read_bytes(), original)
        self.assertEqual(existing_session.read_bytes(), b"opaque-existing-session")
        self.assertEqual(
            browser_profile_status(_PROFILE_IDENTITY, home=self.home).presence,
            BrowserProfilePresence.CONFIGURED,
        )
        self.assertFalse(credential_path(home=self.home).exists())


if __name__ == "__main__":
    unittest.main()
