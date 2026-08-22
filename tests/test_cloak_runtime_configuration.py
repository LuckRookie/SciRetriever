from __future__ import annotations

import hashlib
import json
import os
import pickle
import stat
import sys
import tempfile
import threading
import types
import unittest
from pathlib import Path
from unittest import mock

import sciretriever.configuration.browser_identity as identity_module
import sciretriever.configuration.cloak_runtime as runtime_module
from sciretriever.configuration.browser_profiles import (
    BrowserProfileTransitionError,
    browser_profile_identity_status,
    browser_profile_path,
    initialize_browser_profile,
    remove_browser_profile,
)
from sciretriever.configuration.cloak_runtime import (
    CloakBinarySpec,
    CloakBinaryVerification,
    CloakRuntimeManager,
    CloakRuntimeStatus,
)
from sciretriever.configuration.errors import ConfigurationError


def _bundle_digest(bundle: Path) -> str:
    digest = hashlib.sha256()
    paths = sorted(
        (
            path
            for path in bundle.rglob("*")
            if path.is_file() and path.name != ".sciretriever-binary-manifest.json"
        ),
        key=lambda path: path.relative_to(bundle).as_posix(),
    )
    for path in paths:
        relative = path.relative_to(bundle).as_posix().encode("utf-8")
        digest.update(len(relative).to_bytes(4, "big"))
        digest.update(relative)
        digest.update(stat.S_IMODE(path.stat().st_mode).to_bytes(2, "big"))
        digest.update(path.read_bytes())
    return digest.hexdigest()


class _Installer:
    def __init__(self, *, symlink: bool = False, hardlink: bool = False) -> None:
        self.calls = 0
        self.license_keys: list[str | None] = []
        self.symlink = symlink
        self.hardlink = hardlink

    def install(
        self,
        destination: Path,
        spec: CloakBinarySpec,
        license_key: str | None = None,
    ) -> None:
        self.calls += 1
        self.license_keys.append(license_key)
        executable = destination / "chrome"
        executable.write_bytes(spec.version.encode("ascii"))
        crashpad = destination / "chrome_crashpad_handler"
        crashpad.write_bytes(b"fixture-crashpad")
        os.chmod(crashpad, 0o755)
        (destination / "icudtl.dat").write_bytes(b"fixture-icu")
        locale = destination / "locales"
        locale.mkdir()
        (locale / "en-US.pak").write_bytes(b"fixture-locale")
        if self.symlink:
            outside = destination.parent / "outside"
            outside.write_text("must-survive", encoding="utf-8")
            (destination / "escape").symlink_to(outside)
        if self.hardlink:
            os.link(destination / "icudtl.dat", destination / "icudtl-copy.dat")


class _Verifier:
    def __init__(self, *, valid: bool = True) -> None:
        self.calls = 0
        self.valid = valid

    def verify(self, bundle: Path, spec: CloakBinarySpec) -> CloakBinaryVerification:
        self.calls += 1
        executable = hashlib.sha256((bundle / "chrome").read_bytes()).hexdigest()
        return CloakBinaryVerification(
            version=spec.version if self.valid else "0.0.0.0",
            platform=spec.platform,
            archive_sha256=spec.archive_sha256,
            signature_algorithm="ed25519",
            signature_verified=self.valid,
            executable_sha256=executable,
            bundle_sha256=_bundle_digest(bundle),
        )


class _DigestMismatchVerifier(_Verifier):
    def verify(self, bundle: Path, spec: CloakBinarySpec) -> CloakBinaryVerification:
        evidence = super().verify(bundle, spec)
        return CloakBinaryVerification(
            version=evidence.version,
            platform=evidence.platform,
            archive_sha256=evidence.archive_sha256,
            signature_algorithm=evidence.signature_algorithm,
            signature_verified=evidence.signature_verified,
            executable_sha256="0" * 64,
            bundle_sha256=evidence.bundle_sha256,
        )


class _BareVerifier:
    def verify(self, bundle: Path, spec: CloakBinarySpec) -> object:
        del bundle, spec
        return True


class _BlockingInstaller(_Installer):
    def __init__(self, entered: threading.Event, release: threading.Event) -> None:
        super().__init__()
        self.entered = entered
        self.release = release

    def install(
        self,
        destination: Path,
        spec: CloakBinarySpec,
        license_key: str | None = None,
    ) -> None:
        super().install(destination, spec, license_key)
        self.entered.set()
        if not self.release.wait(timeout=5):
            raise RuntimeError("installer release timed out")


class CloakRuntimeConfigurationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="sciretriever-cloak-runtime-")
        self.addCleanup(self.temporary.cleanup)
        self.home = Path(self.temporary.name)

    def test_status_is_pure_local_and_install_requires_explicit_injected_actions(self) -> None:
        installer = _Installer()
        verifier = _Verifier()
        manager = CloakRuntimeManager(home=self.home, installer=installer, verifier=verifier)
        self.assertFalse(manager.status().ready)
        self.assertEqual(installer.calls, 0)
        self.assertEqual(verifier.calls, 0)
        self.assertEqual(
            manager.install(license_key="fixture-license").version,
            runtime_module.CLOAKBROWSER_BROWSER_VERSION,
        )
        self.assertEqual(installer.calls, 1)
        self.assertEqual(installer.license_keys, ["fixture-license"])
        self.assertEqual(verifier.calls, 1)
        self.assertTrue(manager.status().ready)
        self.assertEqual(installer.calls, 1)
        self.assertEqual(verifier.calls, 1)

    def test_production_installer_is_pinned_and_sanitizes_vendor_environment(self) -> None:
        archive_bytes = b"production-fixture-archive"
        archive_digest = hashlib.sha256(archive_bytes).hexdigest()
        spec = CloakBinarySpec(archive_sha256=archive_digest)
        calls: list[tuple[str, dict[str, str]]] = []
        signature_calls: list[tuple[bytes, bytes]] = []
        vendor = types.ModuleType("cloakbrowser")
        vendor_download = types.ModuleType("cloakbrowser.download")

        def download_file(url: str, destination: Path) -> None:
            calls.append((url, dict(os.environ)))
            if url.endswith(f"/{runtime_module._ARCHIVE_NAME}"):
                destination.write_bytes(archive_bytes)
            elif url.endswith(f"/{runtime_module._SIGNED_MANIFEST_NAME}"):
                destination.write_text(
                    f"version={spec.version}\n{archive_digest}  {runtime_module._ARCHIVE_NAME}\n",
                    encoding="utf-8",
                )
            elif url.endswith(f"/{runtime_module._SIGNED_MANIFEST_SIGNATURE_NAME}"):
                destination.write_bytes(b"fixture-signature")
            else:  # pragma: no cover - a new URL requires an explicit fixture.
                raise AssertionError(url)

        def verify_signature(manifest: bytes, signature: bytes) -> None:
            signature_calls.append((manifest, signature))

        def extract_archive(
            archive: Path,
            bundle: Path,
            executable: Path,
        ) -> None:
            self.assertEqual(hashlib.sha256(archive.read_bytes()).hexdigest(), archive_digest)
            self.assertEqual(executable, bundle / "chrome")
            bundle.mkdir(parents=True)
            (bundle / "chrome").write_bytes(b"production-fixture")
            crashpad = bundle / "chrome_crashpad_handler"
            crashpad.write_bytes(b"fixture-crashpad")
            os.chmod(crashpad, 0o755)
            (bundle / "locales").mkdir()
            (bundle / "locales" / "en-US.pak").write_bytes(b"fixture-locale")

        setattr(vendor_download, "_download_file", download_file)
        setattr(vendor_download, "_verify_signature", verify_signature)
        setattr(vendor_download, "_extract_archive", extract_archive)
        ambient = {
            "CLOAKBROWSER_BINARY_PATH": "/tmp/ambient-binary",
            "CLOAKBROWSER_DOWNLOAD_URL": "https://ambient.invalid",
            "CLOAKBROWSER_LICENSE_KEY": "ambient-secret",
            "CLOAKBROWSER_VERSION": "150.0.0.0.0",
            "HTTP_PROXY": "http://ambient.invalid",
            "HTTPS_PROXY": "http://ambient.invalid",
            "ALL_PROXY": "http://ambient.invalid",
        }
        with mock.patch.dict(
            sys.modules,
            {
                "cloakbrowser": vendor,
                "cloakbrowser.download": vendor_download,
            },
        ):
            with mock.patch.dict(os.environ, ambient, clear=False):
                with mock.patch.object(runtime_module, "DEFAULT_CLOAK_BINARY_SPEC", spec):
                    manager = CloakRuntimeManager(home=self.home)
                    self.assertTrue(manager.install().ready)
        self.assertEqual(len(calls), 3)
        self.assertEqual(len(signature_calls), 1)
        self.assertIn(f"version={spec.version}".encode(), signature_calls[0][0])
        self.assertEqual(signature_calls[0][1], b"fixture-signature")
        for url, environment in calls:
            self.assertTrue(
                url.startswith(f"{runtime_module._PRIMARY_RELEASE_BASE}/chromium-v{spec.version}/")
            )
            self.assertEqual(environment["CLOAKBROWSER_AUTO_UPDATE"], "false")
            self.assertIn("CLOAKBROWSER_CACHE_DIR", environment)
            self.assertFalse(
                any(
                    key.upper().startswith("CLOAKBROWSER_")
                    for key in environment
                    if key not in {"CLOAKBROWSER_CACHE_DIR", "CLOAKBROWSER_AUTO_UPDATE"}
                )
            )
            self.assertFalse(
                any(
                    key.lower() in {"http_proxy", "https_proxy", "all_proxy", "no_proxy"}
                    for key in environment
                )
            )

        # The durable runtime root is never exposed as the vendor cache during
        # ordinary use. Even if vendor credential/Pro state appears there, the
        # per-lease view contains only the authenticated fixed-version bundle.
        runtime_root = manager.cache_directory
        for name, payload in (("license.key", "fixture-key"), (".license_cache", "{}")):
            path = runtime_root / name
            path.write_text(payload, encoding="utf-8")
            os.chmod(path, 0o600)
        lease = manager.acquire_runtime()
        launch_cache = lease.cache_directory
        self.assertNotEqual(launch_cache, runtime_root)
        self.assertEqual(stat.S_IMODE(launch_cache.stat().st_mode), 0o700)
        self.assertTrue((launch_cache / f"chromium-{spec.version}").is_symlink())
        self.assertTrue((launch_cache / f"chromium-{spec.version}" / "chrome").is_file())
        self.assertFalse((launch_cache / "license.key").exists())
        self.assertFalse((launch_cache / ".license_cache").exists())
        lease.close()
        self.assertFalse(launch_cache.exists())

    def test_production_installer_rejects_authenticated_archive_digest_drift(self) -> None:
        archive_bytes = b"replacement-archive"
        archive_digest = hashlib.sha256(archive_bytes).hexdigest()
        vendor_download = types.ModuleType("cloakbrowser.download")
        extracted = False

        def download_file(url: str, destination: Path) -> None:
            if url.endswith(f"/{runtime_module._ARCHIVE_NAME}"):
                destination.write_bytes(archive_bytes)
            elif url.endswith(f"/{runtime_module._SIGNED_MANIFEST_NAME}"):
                destination.write_text(
                    f"version={runtime_module.CLOAKBROWSER_BROWSER_VERSION}\n"
                    f"{archive_digest}  {runtime_module._ARCHIVE_NAME}\n",
                    encoding="utf-8",
                )
            else:
                destination.write_bytes(b"valid-signature-fixture")

        def verify_signature(unused_manifest: bytes, unused_signature: bytes) -> None:
            return None

        def extract_archive(*unused: object) -> None:
            nonlocal extracted
            extracted = True

        setattr(vendor_download, "_download_file", download_file)
        setattr(vendor_download, "_verify_signature", verify_signature)
        setattr(vendor_download, "_extract_archive", extract_archive)
        with mock.patch.dict(sys.modules, {"cloakbrowser.download": vendor_download}):
            with self.assertRaises(ConfigurationError):
                CloakRuntimeManager(home=self.home).install()
        self.assertFalse(extracted)

    def test_production_installer_rejects_bundle_without_archive_evidence(self) -> None:
        vendor_download = types.ModuleType("cloakbrowser.download")
        called = False

        def ensure_binary(**unused: object) -> str:
            nonlocal called
            called = True
            return "/unverified/chrome"

        setattr(vendor_download, "ensure_binary", ensure_binary)
        with mock.patch.dict(sys.modules, {"cloakbrowser.download": vendor_download}):
            with self.assertRaises(ConfigurationError):
                CloakRuntimeManager(home=self.home).install()
        self.assertFalse(called)

    def test_production_fixed_free_runtime_rejects_license_key_without_vendor_call(self) -> None:
        vendor = types.ModuleType("cloakbrowser")
        called = False

        def ensure_binary(**unused: object) -> str:
            nonlocal called
            called = True
            raise AssertionError("vendor must not be called for an unsafe license")

        vendor.ensure_binary = ensure_binary  # type: ignore[attr-defined]
        with mock.patch.dict(sys.modules, {"cloakbrowser": vendor}):
            with self.assertRaises(ConfigurationError):
                CloakRuntimeManager(home=self.home).install(license_key="pro-secret")
        self.assertFalse(called)

    def test_production_gate_rejects_unsupported_platform_before_cache_or_vendor(self) -> None:
        vendor = types.ModuleType("cloakbrowser")
        called = False

        def ensure_binary(**unused: object) -> str:
            nonlocal called
            called = True
            raise AssertionError("vendor must not be called on an unsupported platform")

        vendor.ensure_binary = ensure_binary  # type: ignore[attr-defined]
        with mock.patch.object(runtime_module.sys, "platform", "darwin"):
            with mock.patch.dict(sys.modules, {"cloakbrowser": vendor}):
                manager = CloakRuntimeManager(home=self.home)
                status = manager.status()
                self.assertFalse(status.ready)
                self.assertEqual(status.presence, "attention")
                self.assertEqual(status.reason, "unsupported-platform")
                with self.assertRaises(ConfigurationError):
                    manager.install()
        self.assertFalse(called)
        self.assertFalse((self.home / ".sciretriever").exists())

    def test_production_gate_rejects_dependency_version_mismatch_locally(self) -> None:
        versions = {"cloakbrowser": "0.5.7", "playwright": "1.55.0"}
        with mock.patch.object(
            runtime_module.importlib.metadata,
            "version",
            side_effect=lambda package: versions[package],
        ):
            manager = CloakRuntimeManager(home=self.home)
            status = manager.status()
            self.assertFalse(status.ready)
            self.assertEqual(status.presence, "attention")
            self.assertEqual(status.reason, "dependency-version-mismatch")
            with self.assertRaises(ConfigurationError):
                manager.install()
        self.assertFalse((self.home / ".sciretriever").exists())

    def test_offline_injected_runtime_ignores_host_production_gate(self) -> None:
        versions = {"cloakbrowser": "0.0.0", "playwright": "0.0.0"}
        with mock.patch.object(runtime_module.sys, "platform", "darwin"):
            with mock.patch.object(runtime_module.platform, "machine", return_value="arm64"):
                with mock.patch.object(
                    runtime_module.importlib.metadata,
                    "version",
                    side_effect=lambda package: versions[package],
                ):
                    manager = CloakRuntimeManager(
                        home=self.home,
                        installer=_Installer(),
                        verifier=_Verifier(),
                    )
                    self.assertTrue(manager.install().ready)
                    self.assertTrue(manager.status().ready)

    def test_runtime_lease_holds_shared_lock_until_close_and_closes_access(self) -> None:
        newer = CloakBinarySpec(version="147.0.1.2.3", archive_sha256="2" * 64)
        entered = threading.Event()
        release = threading.Event()
        installer = _BlockingInstaller(entered, release)
        manager = CloakRuntimeManager(
            home=self.home,
            installer=_Installer(),
            verifier=_Verifier(),
            specs=(newer,),
        )
        manager.install()
        lease = manager.acquire_runtime()
        result: list[object] = []

        # A separate manager with a blocking installer proves that update
        # cannot enter its installer while the runtime shared lease is held.
        blocking = CloakRuntimeManager(
            home=self.home,
            installer=installer,
            verifier=_Verifier(),
            specs=(newer,),
        )
        thread = threading.Thread(target=lambda: result.append(blocking.update(newer.version)))
        thread.start()
        self.assertFalse(entered.wait(timeout=0.2))
        self.assertEqual(result, [])
        lease.close()
        self.assertTrue(entered.wait(timeout=5))
        release.set()
        thread.join(timeout=5)
        self.assertFalse(thread.is_alive())
        self.assertEqual(len(result), 1)
        self.assertIsInstance(result[0], CloakRuntimeStatus)
        with self.assertRaises(ConfigurationError):
            _ = lease.cache_directory
        with self.assertRaises(ConfigurationError):
            _ = lease.browser_version

    def test_complete_vendor_bundle_layout_and_status_rehash(self) -> None:
        manager = CloakRuntimeManager(home=self.home, installer=_Installer(), verifier=_Verifier())
        manager.install()
        cache = manager.cache_directory
        bundle = cache / f"chromium-{runtime_module.CLOAKBROWSER_BROWSER_VERSION}"
        self.assertTrue((bundle / "chrome").is_file())
        self.assertTrue((bundle / "chrome_crashpad_handler").is_file())
        self.assertTrue((bundle / "locales" / "en-US.pak").is_file())
        self.assertEqual(stat.S_IMODE(bundle.stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE((bundle / "chrome").stat().st_mode), 0o700)
        self.assertEqual(
            stat.S_IMODE((bundle / "chrome_crashpad_handler").stat().st_mode),
            0o700,
        )
        self.assertEqual(stat.S_IMODE((bundle / "locales" / "en-US.pak").stat().st_mode), 0o600)
        os.chmod(bundle / "chrome_crashpad_handler", 0o600)
        self.assertFalse(manager.status().ready)
        self.assertEqual(manager.status().presence, "attention")
        os.chmod(bundle / "chrome_crashpad_handler", 0o700)
        self.assertTrue(manager.status().ready)
        (bundle / "chrome").write_bytes(b"tampered")
        self.assertFalse(manager.status().ready)
        self.assertEqual(manager.status().presence, "attention")

    def test_owner_only_root_and_bundle_manifests_are_required(self) -> None:
        manager = CloakRuntimeManager(home=self.home, installer=_Installer(), verifier=_Verifier())
        manager.install()
        root_manifest = manager.cache_directory / "binary-manifest.json"
        version_manifest = (
            manager.cache_directory
            / f"chromium-{runtime_module.CLOAKBROWSER_BROWSER_VERSION}"
            / ".sciretriever-binary-manifest.json"
        )
        original_root = root_manifest.read_bytes()
        original_version = version_manifest.read_bytes()
        for manifest in (root_manifest, version_manifest):
            os.chmod(manifest, 0o644)
            self.assertEqual(manager.status().presence, "attention")
            manifest.write_bytes(original_root if manifest is root_manifest else original_version)
            os.chmod(manifest, 0o600)

    def test_typed_verifier_rejects_signature_version_and_digest_failures(self) -> None:
        for verifier in (_Verifier(valid=False), _DigestMismatchVerifier(), _BareVerifier()):
            with self.subTest(verifier=type(verifier).__name__):
                manager = CloakRuntimeManager(
                    home=self.home,
                    installer=_Installer(),
                    verifier=verifier,
                )
                with self.assertRaises(ConfigurationError):
                    manager.install()
                self.assertEqual(manager.status().presence, "attention")

        with self.assertRaises(ConfigurationError):
            CloakRuntimeManager(
                home=self.home,
                installer=_Installer(),
                verifier=object(),
            )

    def test_update_rollback_and_current_bytes_are_preserved(self) -> None:
        old = CloakBinarySpec(version="145.0.1.2.3", archive_sha256="1" * 64)
        installer = _Installer()
        manager = CloakRuntimeManager(
            home=self.home,
            installer=installer,
            verifier=_Verifier(),
            specs=(old,),
        )
        manager.install()
        current = (
            manager.cache_directory
            / f"chromium-{runtime_module.CLOAKBROWSER_BROWSER_VERSION}"
            / "chrome"
        )
        original = current.read_bytes()
        manager.update(old.version)
        self.assertEqual(current.read_bytes(), original)
        self.assertEqual(
            manager.status().previous_version,
            runtime_module.CLOAKBROWSER_BROWSER_VERSION,
        )
        manager.rollback()
        self.assertEqual(manager.status().version, runtime_module.CLOAKBROWSER_BROWSER_VERSION)
        self.assertEqual(installer.calls, 2)

    def test_atomic_interruption_keeps_current_and_cleans_staging(self) -> None:
        newer = CloakBinarySpec(version="147.0.1.2.3", archive_sha256="2" * 64)
        manager = CloakRuntimeManager(
            home=self.home,
            installer=_Installer(),
            verifier=_Verifier(),
            specs=(newer,),
        )
        manager.install()
        current = manager.status().version

        def interrupt(stage: str) -> None:
            if stage == "staging-verified":
                raise RuntimeError("interrupt")

        with self.assertRaises(ConfigurationError):
            manager.update(newer.version, failpoint=interrupt)
        self.assertEqual(manager.status().version, current)
        self.assertEqual(tuple(manager.cache_directory.glob("*.staging")), ())

    def test_install_uses_one_cross_process_lock_for_shared_cache(self) -> None:
        entered = threading.Event()
        release = threading.Event()
        first_installer = _BlockingInstaller(entered, release)
        second_installer = _Installer()
        first = CloakRuntimeManager(
            home=self.home,
            installer=first_installer,
            verifier=_Verifier(),
        )
        second = CloakRuntimeManager(
            home=self.home,
            installer=second_installer,
            verifier=_Verifier(),
        )
        first_failure: list[BaseException] = []

        def install_first() -> None:
            try:
                first.install()
            except BaseException as error:
                first_failure.append(error)

        first_thread = threading.Thread(target=install_first)
        first_thread.start()
        self.assertTrue(entered.wait(timeout=5))

        second_started = threading.Event()
        second_result: list[object] = []

        def install_second() -> None:
            second_started.set()
            try:
                second_result.append(second.install())
            except BaseException as error:
                second_result.append(error)

        second_thread = threading.Thread(target=install_second)
        second_thread.start()
        self.assertTrue(second_started.wait(timeout=5))
        self.assertFalse(second_installer.calls)
        release.set()
        first_thread.join(timeout=5)
        second_thread.join(timeout=5)
        self.assertFalse(first_thread.is_alive())
        self.assertFalse(second_thread.is_alive())
        self.assertEqual(first_failure, [])
        self.assertEqual(len(second_result), 1)
        self.assertFalse(isinstance(second_result[0], BaseException))
        self.assertEqual(second_installer.calls, 0)

    def test_manifest_duplicate_unknown_and_oversize_are_attention(self) -> None:
        manager = CloakRuntimeManager(home=self.home, installer=_Installer(), verifier=_Verifier())
        manager.install()
        manifest = manager.cache_directory / "binary-manifest.json"
        original = manifest.read_bytes()
        for payload in (
            b'{"schema_version":1,"schema_version":1,"current_version":"1.2.3.4","previous_version":null}',
            b'{"schema_version":1,"current_version":"1.2.3.4","previous_version":null,"unknown":true}',
            b"{" + b"a" * (runtime_module._MANIFEST_MAX_BYTES + 1) + b"}",
        ):
            manifest.write_bytes(payload)
            os.chmod(manifest, 0o600)
            self.assertFalse(manager.status().ready)
        manifest.write_bytes(original)
        os.chmod(manifest, 0o600)

    def test_bundle_symlink_and_hardlink_fail_closed_without_escape(self) -> None:
        for installer in (_Installer(symlink=True), _Installer(hardlink=True)):
            with self.subTest(installer=installer):
                manager = CloakRuntimeManager(
                    home=self.home,
                    installer=installer,
                    verifier=_Verifier(),
                )
                with self.assertRaises(ConfigurationError):
                    manager.install()
                outside = manager.cache_directory.parent / "outside"
                if outside.exists():
                    self.assertEqual(outside.read_text(encoding="utf-8"), "must-survive")
                self.home = Path(tempfile.mkdtemp(prefix="sciretriever-cloak-bundle-"))
                self.addCleanup(lambda: None)


class BrowserIdentityConfigurationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="sciretriever-profile-identity-")
        self.addCleanup(self.temporary.cleanup)
        self.home = Path(self.temporary.name)

    def test_same_profile_reuses_seed_and_different_profiles_do_not(self) -> None:
        first = initialize_browser_profile("first", home=self.home)
        second = initialize_browser_profile("second", home=self.home)
        seed = first.runtime_identity().fingerprint_seed
        self.assertEqual(seed, first.runtime_identity().fingerprint_seed)
        lease = first.acquire_runtime()
        self.assertEqual(seed, lease.launch_identity.fingerprint_seed)
        lease.close()
        self.assertNotEqual(seed, second.runtime_identity().fingerprint_seed)
        self.assertNotIn(str(seed), repr(first.runtime_identity()))
        with self.assertRaises(TypeError):
            pickle.dumps(first.runtime_identity())

    def test_identity_manifest_is_strict_and_stock_profile_is_untouched(self) -> None:
        profile = initialize_browser_profile("fixture", home=self.home)
        manifest = browser_profile_path("fixture", home=self.home) / identity_module.MANIFEST_NAME
        raw = manifest.read_bytes()
        malformed = raw[:-1] + b',"unknown":true}' if raw.endswith(b"}") else raw
        malformed_payloads = (
            raw[:-1] + b" ",
            b'{"schema_version":1,"schema_version":1}',
            malformed,
            raw.replace(b'"mode":"exact"', b'"mode":"other"'),
            raw.replace(b'"persona":"linux"', b'"persona":"windows"'),
            raw.replace(b'"zh-CN"', b'"fr"'),
            raw.replace(b'"width":1920', b'"width":0'),
            raw.replace(identity_module.BROWSER_VERSION.encode(), b"0.0.0.0"),
        )
        for payload in malformed_payloads:
            manifest.write_bytes(payload)
            os.chmod(manifest, 0o600)
            status = browser_profile_identity_status("fixture", home=self.home)
            self.assertTrue(status.manifest_present)
            self.assertEqual(status.presence, "attention")
        manifest.write_bytes(raw)
        os.chmod(manifest, 0o600)

        stock = browser_profile_path("stock", home=self.home)
        stock.mkdir(parents=True, mode=0o700)
        (stock / "Cookies").write_bytes(b"do-not-touch")
        os.chmod(stock / "Cookies", 0o600)
        before = (stock / "Cookies").read_bytes()
        self.assertEqual(
            browser_profile_identity_status("stock", home=self.home).presence,
            "needs-new-runtime-profile",
        )
        with self.assertRaises(BrowserProfileTransitionError):
            initialize_browser_profile("stock", home=self.home)
        self.assertEqual((stock / "Cookies").read_bytes(), before)
        self.assertFalse((stock / identity_module.MANIFEST_NAME).exists())
        self.assertIsNotNone(profile)

    def test_identity_digest_binds_canonical_manifest_fields(self) -> None:
        initialize_browser_profile("digest", home=self.home)
        manifest = browser_profile_path("digest", home=self.home) / identity_module.MANIFEST_NAME
        original = manifest.read_bytes()
        payload = json.loads(original)
        payload["locale"] = "fr-FR"
        manifest.write_text(json.dumps(payload), encoding="utf-8")
        os.chmod(manifest, 0o600)
        self.assertEqual(
            browser_profile_identity_status("digest", home=self.home).presence,
            "attention",
        )
        manifest.write_bytes(original)
        os.chmod(manifest, 0o600)
        payload = json.loads(original)
        payload["identity_digest"] = "0" * 64
        manifest.write_text(json.dumps(payload), encoding="utf-8")
        os.chmod(manifest, 0o600)
        self.assertEqual(
            browser_profile_identity_status("digest", home=self.home).presence,
            "attention",
        )

    def test_lease_carries_identity_and_delete_removes_manifest(self) -> None:
        profile = initialize_browser_profile("lease", home=self.home)
        lease = profile.acquire_runtime()
        self.assertEqual(lease.launch_identity.persona, "linux")
        with self.assertRaises(ConfigurationError):
            profile.acquire_runtime()
        lease.close()
        manifest = browser_profile_path("lease", home=self.home) / identity_module.MANIFEST_NAME
        self.assertTrue(manifest.exists())
        self.assertTrue(remove_browser_profile("lease", home=self.home))
        self.assertFalse(manifest.exists())

    def test_concurrent_initialization_converges_without_manifest_overwrite(self) -> None:
        results: list[object] = []

        def initialize() -> None:
            try:
                results.append(
                    initialize_browser_profile("race", home=self.home).runtime_identity()
                )
            except BaseException as error:
                results.append(error)

        threads = [threading.Thread(target=initialize) for _ in range(2)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(len(results), 2)
        self.assertTrue(all(not isinstance(value, BaseException) for value in results))
        identities = [value for value in results if not isinstance(value, BaseException)]
        self.assertEqual(identities[0], identities[1])


if __name__ == "__main__":
    unittest.main()
