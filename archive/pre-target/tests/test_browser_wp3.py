import asyncio
from io import BytesIO
import os
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
from unittest import TestCase, mock

from PyPDF2 import PdfWriter

REPOSITORY = Path(__file__).resolve().parents[1]
SRC = REPOSITORY / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from sciretriever.acquisition.browser import BrowserRuleResolver, PlaywrightBrowserRunner, _copy_profile, validate_browser_profile
from sciretriever.acquisition.candidate_executor import CandidateExecutionStatus, CandidateExecutor
from sciretriever.acquisition.identity_validation import IdentityDisposition, IdentityValidationResult
from sciretriever.acquisition.models import AcquisitionTarget
from sciretriever.config import BrowserConfig, BrowserRuleConfig, load_config
from sciretriever.core.contracts import Identifier
from sciretriever.core.enums import AssetRole
from sciretriever.errors import ConfigError


def pdf_bytes(label="authenticated browser") -> bytes:
    stream = BytesIO()
    writer = PdfWriter()
    writer.add_blank_page(width=72, height=72)
    writer.add_blank_page(width=72, height=72)
    writer.add_metadata({"/Subject": label * 100})
    writer.write(stream)
    return stream.getvalue()


def rule() -> BrowserRuleConfig:
    return BrowserRuleConfig(
        "publisher", "https://landing.example/article/{doi}",
        ("landing.example",), ("pdf.example",),
        ("landing.example", "pdf.example", "assets.example"),
    )


class FakeResponse:
    def __init__(self, url, media_type="text/html", body=b"", content_length=None):
        self.url = url
        self.headers = {"content-type": media_type}
        if content_length is not None:
            self.headers["content-length"] = content_length
        self._body = body
        self.body_calls = 0

    def body(self):
        self.body_calls += 1
        return self._body


class FakePage:
    def __init__(self, context, html, responses, on_goto=None):
        self.context = context
        self._html = html
        self.responses = responses
        self.url = "about:blank"
        self.on_goto = on_goto
        self.goto_timeouts = []
        self.title_calls = 0
        self.content_calls = 0

    def goto(self, url, **kwargs):
        self.goto_timeouts.append(kwargs["timeout"])
        response = self.responses[url]
        self.url = response.url
        for callback in self.context.events.get("response", []):
            callback(response)
            if not self.context.extras_emitted:
                for extra in self.context.extra_responses:
                    callback(extra)
                self.context.extras_emitted = True
        if self.on_goto is not None:
            self.on_goto()
        return response

    def title(self):
        self.title_calls += 1
        return "Article"

    def content(self):
        self.content_calls += 1
        return self._html


class FakeContext:
    def __init__(self, html, responses, on_goto=None, extra_responses=()):
        self.events = {}
        self.routes = []
        self.closed = False
        self.extra_responses = extra_responses
        self.extras_emitted = False
        self.page = FakePage(self, html, responses, on_goto)
        self.pages = [self.page]

    def set_default_timeout(self, value):
        self.action_timeout = value

    def set_default_navigation_timeout(self, value):
        self.navigation_timeout = value

    def route(self, pattern, callback):
        self.routes.append((pattern, callback))

    def on(self, name, callback):
        self.events.setdefault(name, []).append(callback)

    def new_page(self):
        return self.page

    def close(self):
        self.closed = True


class FakeChromium:
    def __init__(self, context):
        self.context = context
        self.kwargs = None

    def launch_persistent_context(self, **kwargs):
        self.kwargs = kwargs
        return self.context


class FakePlaywrightManager:
    def __init__(self, chromium):
        self.chromium = chromium

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


class Route:
    def __init__(self, url):
        self.request = type("Request", (), {"url": url})()
        self.action = None

    def continue_(self):
        self.action = "continue"

    def abort(self):
        self.action = "abort"


class FakeClock:
    def __init__(self, value=0.0, step=0.0):
        self.value = value
        self.step = step

    def __call__(self):
        current = self.value
        self.value += self.step
        return current


class SequenceIdentityValidator:
    def __init__(self, *dispositions):
        self.dispositions = list(dispositions)
        self.calls = []

    def validate(self, content, target):
        self.calls.append((content.data, target))
        return IdentityValidationResult(self.dispositions.pop(0))


class PassingIdentityValidator:
    def validate(self, content, target):
        del content, target
        return IdentityValidationResult(IdentityDisposition.PASS)


class BrowserTests(TestCase):
    def setUp(self):
        temporary = TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.profile = self.root / "profile"
        self.storage = self.root / "storage"
        self.profile.mkdir(mode=0o700)
        self.storage.mkdir()
        self.profile.chmod(0o700)
        (self.profile / "Cookies").write_bytes(b"original-auth-state")

    def config(self, *, max_bytes=1024 * 1024, max_files=10):
        return BrowserConfig(True, self.profile, max_bytes, max_files, (rule(),))

    def candidate(self):
        return BrowserRuleResolver(rule()).resolve(
            AcquisitionTarget((Identifier("doi", "10.1000/example"),)),
            AssetRole.PRIMARY_PDF, timeout=1,
        )[0]

    def target(self):
        return AcquisitionTarget((Identifier("doi", "10.1000/example"),))

    def test_default_disabled_and_strict_browser_schema(self):
        path = self.root / "config.toml"
        path.write_text("schema_version = 1", encoding="utf-8")
        self.assertFalse(load_config(path).acquisition.browser.enabled)
        cases = (
            '[acquisition.browser]\nprofile_dir="profile"',
            '[acquisition.browser]\nenabled=true\nprofile_dir="profile"',
            '[acquisition.browser]\nenabled=true\nprofile_dir="profile"\nmax_profile_files=0',
            '[acquisition.browser]\nunknown=true',
        )
        for index, body in enumerate(cases):
            with self.subTest(index=index):
                path.write_text("schema_version = 1\n" + body, encoding="utf-8")
                with self.assertRaises(ConfigError):
                    load_config(path)

    def test_rule_schema_resolves_profile_and_closes_host_sets(self):
        path = self.root / "config.toml"
        path.write_text('''schema_version = 1
[acquisition.browser]
enabled = true
profile_dir = "profile"
max_profile_bytes = 1000
max_profile_files = 5
[[acquisition.browser.rules]]
name = "publisher"
landing_url_template = "https://landing.example/article/{doi}"
allowed_landing_hosts = []
allowed_pdf_hosts = ["pdf.example"]
allowed_network_hosts = ["assets.example"]
''', encoding="utf-8")
        browser = load_config(path).acquisition.browser
        self.assertEqual(browser.profile_dir, self.profile)
        self.assertEqual(browser.rules[0].allowed_landing_hosts, ("landing.example",))
        self.assertEqual(browser.rules[0].allowed_network_hosts, ("landing.example", "assets.example", "pdf.example"))

    def test_rule_rejects_unsafe_templates_and_hosts(self):
        unsafe = ("http://landing.example/{doi}", "https://127.0.0.1/{doi}", "https://localhost/{doi}", "https://user@landing.example/{doi}", "https://landing.example:444/{doi}", "https://landing.example/{other}")
        for value in unsafe:
            path = self.root / "unsafe.toml"
            path.write_text(f'''schema_version = 1
[acquisition.browser]
enabled = true
profile_dir = "profile"
[[acquisition.browser.rules]]
name = "publisher"
landing_url_template = "{value}"
allowed_landing_hosts = []
allowed_pdf_hosts = ["pdf.example"]
allowed_network_hosts = []
''', encoding="utf-8")
            with self.subTest(value=value), self.assertRaises(ConfigError):
                load_config(path)

    def test_profile_validation_rejects_permissions_symlink_storage_and_caps(self):
        validate_browser_profile(self.config(), self.storage)
        if os.name == "posix":
            self.profile.chmod(0o600)
            with self.assertRaisesRegex(ConfigError, "browser profile is invalid"):
                validate_browser_profile(self.config(), self.storage)
            self.profile.chmod(0o700)
            validate_browser_profile(self.config(), self.storage)
            self.profile.chmod(0o750)
            with self.assertRaisesRegex(ConfigError, "browser profile is invalid") as raised:
                validate_browser_profile(self.config(), self.storage)
            self.assertNotIn(str(self.profile), str(raised.exception))
            self.profile.chmod(0o700)
        link = self.root / "link"
        link.symlink_to(self.profile, target_is_directory=True)
        with self.assertRaises(ConfigError):
            validate_browser_profile(BrowserConfig(True, link, 100, 2, (rule(),)), self.storage)
        with self.assertRaises(ConfigError):
            validate_browser_profile(BrowserConfig(True, self.storage, 100, 2, (rule(),)), self.storage)

    def test_resolver_is_neutral_and_contains_no_credentials(self):
        candidate = self.candidate()
        self.assertEqual(candidate.transport, "browser")
        self.assertEqual(candidate.access_method, "browser")
        self.assertEqual(candidate.execution_url, "https://landing.example/article/10.1000%2Fexample")
        self.assertEqual(candidate.request_headers, {})
        self.assertEqual(candidate.request_params, {})
        self.assertNotIn("10.1000", repr(candidate))

    def test_authenticated_pdf_uses_persistent_context_and_cleans_snapshot(self):
        landing = self.candidate().execution_url
        pdf_url = "https://pdf.example/article.pdf"
        context = FakeContext("<html>article</html>", {
            landing: FakeResponse(pdf_url, "application/pdf", pdf_bytes()),
        })
        chromium = FakeChromium(context)
        runner = PlaywrightBrowserRunner(
            self.config(), max_asset_bytes=10_000_000,
            playwright_factory=lambda: FakePlaywrightManager(chromium),
            resolve_host=lambda host: ("93.184.216.34",),
        )
        result = asyncio.run(CandidateExecutor(browser_runner=runner).execute(self.candidate(), timeout=1))
        self.assertEqual(result.status, CandidateExecutionStatus.VALIDATED)
        self.assertTrue(context.closed)
        self.assertTrue(chromium.kwargs["headless"])
        self.assertTrue(chromium.kwargs["accept_downloads"])
        self.assertNotEqual(Path(chromium.kwargs["user_data_dir"]), self.profile)
        self.assertFalse(Path(chromium.kwargs["user_data_dir"]).exists())
        self.assertEqual((self.profile / "Cookies").read_bytes(), b"original-auth-state")
        self.assertFalse(hasattr(context, "storage_state"))
        self.assertEqual(context.page.title_calls, 0)
        self.assertEqual(context.page.content_calls, 0)

    def test_route_boundary_and_challenge_fail_closed_with_cleanup(self):
        landing = self.candidate().execution_url
        context = FakeContext('<input type="password"><div>verify you are human</div>', {
            landing: FakeResponse(landing),
        })
        chromium = FakeChromium(context)
        runner = PlaywrightBrowserRunner(self.config(), max_asset_bytes=10_000,
            playwright_factory=lambda: FakePlaywrightManager(chromium),
            resolve_host=lambda host: ("93.184.216.34",))
        result = asyncio.run(CandidateExecutor(browser_runner=runner).execute(self.candidate(), timeout=1))
        self.assertEqual(result.status, CandidateExecutionStatus.FAILED)
        self.assertTrue(context.closed)
        callback = context.routes[0][1]
        allowed, rejected = Route("https://assets.example/style.css"), Route("https://evil.example/x")
        callback(allowed)
        callback(rejected)
        self.assertEqual((allowed.action, rejected.action), ("continue", "abort"))

    def test_static_candidate_falls_back_after_invalid_pdf(self):
        landing = self.candidate().execution_url
        invalid = "https://pdf.example/invalid.pdf"
        valid = "https://pdf.example/article.pdf"
        context = FakeContext(f'<a href="{invalid}">bad</a><iframe src="{valid}"></iframe>', {
            landing: FakeResponse(landing),
            invalid: FakeResponse(invalid, "application/pdf", b"bad"),
            valid: FakeResponse(valid, "application/pdf", pdf_bytes()),
        })
        runner = PlaywrightBrowserRunner(self.config(), max_asset_bytes=10_000_000,
            playwright_factory=lambda: FakePlaywrightManager(FakeChromium(context)),
            resolve_host=lambda host: ("93.184.216.34",))
        result = asyncio.run(CandidateExecutor(browser_runner=runner).execute(self.candidate(), timeout=1))
        self.assertEqual(result.status, CandidateExecutionStatus.VALIDATED)
        self.assertEqual(context.page.url, valid)

    def test_oversized_static_body_falls_through_to_next_candidate(self):
        landing = self.candidate().execution_url
        oversized = "https://pdf.example/oversized.pdf"
        valid = "https://pdf.example/article.pdf"
        oversized_body = pdf_bytes() + b"PRIVATE-BODY" * 100
        context = FakeContext(f'<a href="{oversized}">large</a><a href="{valid}">valid</a>', {
            landing: FakeResponse(landing),
            oversized: FakeResponse(oversized, "application/pdf", oversized_body),
            valid: FakeResponse(valid, "application/pdf", pdf_bytes()),
        })
        runner = PlaywrightBrowserRunner(
            self.config(), max_asset_bytes=len(pdf_bytes()) + 10,
            playwright_factory=lambda: FakePlaywrightManager(FakeChromium(context)),
            resolve_host=lambda host: ("93.184.216.34",),
        )
        result = asyncio.run(CandidateExecutor(browser_runner=runner).execute(self.candidate(), timeout=1))
        self.assertEqual(result.status, CandidateExecutionStatus.VALIDATED)
        self.assertEqual(context.page.url, valid)
        self.assertNotIn("PRIVATE-BODY", repr(result))

    def test_observer_caps_distinct_responses_and_deduplicates_urls(self):
        landing = self.candidate().execution_url
        responses = [
            FakeResponse(f"https://pdf.example/{index}.pdf", "application/pdf", b"bad")
            for index in range(9)
        ]
        duplicate = FakeResponse(responses[0].url, "application/pdf", b"duplicate")
        context = FakeContext("<html>article</html>", {
            landing: FakeResponse(landing),
        }, extra_responses=(*responses, duplicate))
        runner = PlaywrightBrowserRunner(
            self.config(), max_asset_bytes=10_000_000,
            playwright_factory=lambda: FakePlaywrightManager(FakeChromium(context)),
            resolve_host=lambda host: ("93.184.216.34",),
        )
        result = asyncio.run(CandidateExecutor(browser_runner=runner).execute(self.candidate(), timeout=1))
        self.assertEqual(result.status, CandidateExecutionStatus.FAILED)
        self.assertTrue(all(response.body_calls == 1 for response in responses[:8]))
        self.assertEqual(responses[8].body_calls, 0)
        self.assertEqual(duplicate.body_calls, 0)

    def test_observed_wrong_identity_falls_through_to_later_observed_pdf(self):
        landing = self.candidate().execution_url
        wrong = pdf_bytes("wrong identity")
        valid = pdf_bytes("target identity")
        validator = SequenceIdentityValidator(
            IdentityDisposition.MISMATCH, IdentityDisposition.PASS,
        )
        context = FakeContext("<html>article</html>", {
            landing: FakeResponse(landing),
        }, extra_responses=(
            FakeResponse("https://pdf.example/wrong.pdf", "application/pdf", wrong),
            FakeResponse("https://pdf.example/valid.pdf", "application/pdf", valid),
        ))
        runner = PlaywrightBrowserRunner(
            self.config(), max_asset_bytes=10_000_000,
            playwright_factory=lambda: FakePlaywrightManager(FakeChromium(context)),
            resolve_host=lambda host: ("93.184.216.34",),
            identity_validator=validator,
        )
        result = asyncio.run(CandidateExecutor(
            browser_runner=runner, identity_validator=PassingIdentityValidator(),
        ).execute(self.candidate(), timeout=1, target=self.target()))
        self.assertEqual(result.status, CandidateExecutionStatus.VALIDATED)
        assert result.content is not None
        self.assertEqual(result.content.data, valid)
        self.assertEqual([data for data, _ in validator.calls], [wrong, valid])

    def test_static_wrong_identity_falls_through_to_later_static_pdf(self):
        landing = self.candidate().execution_url
        wrong_url = "https://pdf.example/wrong.pdf"
        valid_url = "https://pdf.example/valid.pdf"
        wrong = pdf_bytes("wrong static identity")
        valid = pdf_bytes("valid static identity")
        validator = SequenceIdentityValidator(
            IdentityDisposition.MISMATCH, IdentityDisposition.PASS,
        )
        context = FakeContext(
            f'<a href="{wrong_url}">wrong</a><a href="{valid_url}">valid</a>',
            {
                landing: FakeResponse(landing),
                wrong_url: FakeResponse(wrong_url, "application/pdf", wrong),
                valid_url: FakeResponse(valid_url, "application/pdf", valid),
            },
        )
        runner = PlaywrightBrowserRunner(
            self.config(), max_asset_bytes=10_000_000,
            playwright_factory=lambda: FakePlaywrightManager(FakeChromium(context)),
            resolve_host=lambda host: ("93.184.216.34",),
            identity_validator=validator,
        )
        result = asyncio.run(CandidateExecutor(
            browser_runner=runner, identity_validator=PassingIdentityValidator(),
        ).execute(self.candidate(), timeout=1, target=self.target()))
        self.assertEqual(result.status, CandidateExecutionStatus.VALIDATED)
        assert result.content is not None
        self.assertEqual(result.content.data, valid)
        self.assertEqual(context.page.url, valid_url)
        self.assertEqual([data for data, _ in validator.calls], [wrong, valid])

    def test_all_identity_rejections_return_generic_no_valid_pdf_failure(self):
        landing = self.candidate().execution_url
        wrong_url = "https://pdf.example/private-wrong.pdf"
        other_url = "https://pdf.example/private-other.pdf"
        validator = SequenceIdentityValidator(
            IdentityDisposition.MISMATCH, IdentityDisposition.UNCONFIRMED,
        )
        context = FakeContext(
            f'<a href="{wrong_url}">wrong</a><a href="{other_url}">other</a>',
            {
                landing: FakeResponse(landing),
                wrong_url: FakeResponse(wrong_url, "application/pdf", pdf_bytes("PRIVATE-WRONG")),
                other_url: FakeResponse(other_url, "application/pdf", pdf_bytes("PRIVATE-OTHER")),
            },
        )
        runner = PlaywrightBrowserRunner(
            self.config(), max_asset_bytes=10_000_000,
            playwright_factory=lambda: FakePlaywrightManager(FakeChromium(context)),
            resolve_host=lambda host: ("93.184.216.34",),
            identity_validator=validator,
        )
        result = asyncio.run(CandidateExecutor(
            browser_runner=runner, identity_validator=PassingIdentityValidator(),
        ).execute(self.candidate(), timeout=1, target=self.target()))
        self.assertEqual(result.status, CandidateExecutionStatus.FAILED)
        self.assertIsNone(result.content)
        self.assertIsNotNone(result.error)
        message = str(result.error)
        self.assertIn("browser supplied no valid PDF", message)
        for secret in ("private-wrong", "private-other", "PRIVATE-WRONG", "PRIVATE-OTHER", "mismatch", "unconfirmed"):
            self.assertNotIn(secret, message)

    def test_content_length_short_circuits_observed_and_static_bodies(self):
        landing = self.candidate().execution_url
        declared_large = "https://pdf.example/declared-large.pdf"
        malformed = "https://pdf.example/malformed.pdf"
        valid = "https://pdf.example/valid.pdf"
        large_response = FakeResponse(
            declared_large, "application/pdf", b"SECRET-LARGE",
            content_length="999999999",
        )
        malformed_response = FakeResponse(
            malformed, "application/pdf", b"SECRET-MALFORMED",
            content_length="not-a-number",
        )
        valid_body = pdf_bytes()
        valid_response = FakeResponse(
            valid, "application/pdf", valid_body, content_length=str(len(valid_body)),
        )
        context = FakeContext(
            f'<a href="{declared_large}">large</a><a href="{malformed}">bad</a><a href="{valid}">valid</a>',
            {
                landing: FakeResponse(landing),
                declared_large: large_response,
                malformed: malformed_response,
                valid: valid_response,
            },
        )
        runner = PlaywrightBrowserRunner(
            self.config(), max_asset_bytes=len(valid_body) + 10,
            playwright_factory=lambda: FakePlaywrightManager(FakeChromium(context)),
            resolve_host=lambda host: ("93.184.216.34",),
        )
        result = asyncio.run(CandidateExecutor(browser_runner=runner).execute(self.candidate(), timeout=1))
        self.assertEqual(result.status, CandidateExecutionStatus.VALIDATED)
        self.assertEqual(large_response.body_calls, 0)
        self.assertEqual(malformed_response.body_calls, 0)
        self.assertEqual(valid_response.body_calls, 1)
        self.assertNotIn("SECRET-", repr(result))

    def test_oversized_rendered_dom_is_rejected_and_cleaned_without_leak(self):
        landing = self.candidate().execution_url
        marker = "PRIVATE-DOM-MARKER"
        context = FakeContext(marker + "x" * 2_000_001, {
            landing: FakeResponse(landing),
        })
        chromium = FakeChromium(context)
        runner = PlaywrightBrowserRunner(
            self.config(), max_asset_bytes=10_000_000,
            playwright_factory=lambda: FakePlaywrightManager(chromium),
            resolve_host=lambda host: ("93.184.216.34",),
        )
        result = asyncio.run(CandidateExecutor(browser_runner=runner).execute(self.candidate(), timeout=1))
        self.assertEqual(result.status, CandidateExecutionStatus.FAILED)
        self.assertTrue(context.closed)
        self.assertFalse(Path(chromium.kwargs["user_data_dir"]).exists())
        self.assertNotIn(marker, repr(result))
        self.assertEqual(context.page.content_calls, 1)

    def test_absolute_deadline_reduces_launch_and_navigation_timeouts(self):
        landing = self.candidate().execution_url
        pdf_url = "https://pdf.example/article.pdf"
        clock = FakeClock(step=0.001)
        context = FakeContext("<html>article</html>", {
            landing: FakeResponse(pdf_url, "application/pdf", pdf_bytes()),
        })
        chromium = FakeChromium(context)
        runner = PlaywrightBrowserRunner(
            self.config(), max_asset_bytes=10_000_000,
            playwright_factory=lambda: FakePlaywrightManager(chromium),
            resolve_host=lambda host: ("93.184.216.34",), monotonic=clock,
        )
        result = asyncio.run(CandidateExecutor(browser_runner=runner).execute(self.candidate(), timeout=1))
        self.assertEqual(result.status, CandidateExecutionStatus.VALIDATED)
        launch_timeout = chromium.kwargs["timeout"]
        self.assertLess(launch_timeout, 1000)
        self.assertLess(context.page.goto_timeouts[0], launch_timeout)

    def test_deadline_exhaustion_closes_context_and_cleans_temp_state(self):
        landing = self.candidate().execution_url
        clock = FakeClock()
        context = FakeContext("<html>article</html>", {
            landing: FakeResponse(landing),
        }, on_goto=lambda: setattr(clock, "value", 2.0))
        chromium = FakeChromium(context)
        runner = PlaywrightBrowserRunner(
            self.config(), max_asset_bytes=10_000_000,
            playwright_factory=lambda: FakePlaywrightManager(chromium),
            resolve_host=lambda host: ("93.184.216.34",), monotonic=clock,
        )
        result = asyncio.run(CandidateExecutor(browser_runner=runner).execute(self.candidate(), timeout=1))
        self.assertEqual(result.status, CandidateExecutionStatus.INTERRUPTED)
        self.assertTrue(context.closed)
        temporary_profile = Path(chromium.kwargs["user_data_dir"])
        self.assertFalse(temporary_profile.exists())
        rendered = repr(result)
        self.assertNotIn(str(self.profile), rendered)
        self.assertNotIn("original-auth-state", rendered)

    def test_profile_directory_replacement_race_is_rejected(self):
        child = self.profile / "State"
        child.mkdir()
        (child / "record").write_bytes(b"private-state")
        moved = self.profile / "State-moved"
        destination = self.root / "snapshot"
        real_open = os.open
        replaced = False

        def replace_before_open(path, flags, mode=0o777, *, dir_fd=None):
            nonlocal replaced
            if path == "State" and dir_fd is not None and not replaced:
                child.rename(moved)
                child.symlink_to(moved, target_is_directory=True)
                replaced = True
            return real_open(path, flags, mode, dir_fd=dir_fd)

        with mock.patch("sciretriever.acquisition.browser.os.open", side_effect=replace_before_open):
            with self.assertRaises(ConfigError) as raised:
                _copy_profile(self.profile, destination, 20, 1024 * 1024)
        self.assertTrue(replaced)
        message = str(raised.exception)
        self.assertNotIn(str(self.profile), message)
        self.assertNotIn("private-state", message)

    def test_profile_entry_and_caps_fail_and_missing_runner_is_stable(self):
        (self.profile / "too-large").write_bytes(b"x" * 100)
        runner = PlaywrightBrowserRunner(self.config(max_bytes=10), max_asset_bytes=1000,
            playwright_factory=lambda: None, resolve_host=lambda host: ("93.184.216.34",))
        result = asyncio.run(CandidateExecutor(browser_runner=runner).execute(self.candidate(), timeout=1))
        self.assertEqual(result.status, CandidateExecutionStatus.FAILED)
        missing = asyncio.run(CandidateExecutor().execute(self.candidate(), timeout=1))
        self.assertEqual(missing.status, CandidateExecutionStatus.FAILED)


if __name__ == "__main__":
    import unittest
    unittest.main()
