from download_wp3_fixture import *


class DownloadTierWp3Tests(DownloadWp3Fixture):
    def test_first_tier_success_skips_translator(self):
        direct = "https://first.test/article.pdf"
        landing = "https://translator.test/article/10.1000%2Falpha"
        transport = Transport({
            direct: (0, 200, "application/pdf", pdf_bytes("first")),
            landing: (0, 200, "text/html", b'<a href="/translated.pdf">x</a>'),
        })
        translator = self.translator(transport, "one", "translator.test")
        result = asyncio.run(self.service(
            transport,
            {"first": Resolver("first", {AssetRole.PRIMARY_PDF: (direct,)})},
            translators=(translator,),
        ).acquire(
            self.first.id, AssetRole.PRIMARY_PDF,
            self.target(self.first.id),
            ("first",), timeout=1,
        ))
        self.assertEqual(result.status, "succeeded")
        self.assertNotIn(landing, [url for url, _ in transport.calls])

    def test_first_tier_exhaustion_runs_ordered_translators_with_executor_fallback(self):
        first_landing = "https://translator-one.test/article/10.1000%2Falpha"
        second_landing = "https://translator-two.test/article/10.1000%2Falpha"
        invalid = "https://translator-two.test/invalid.pdf"
        valid = "https://translator-two.test/valid.pdf"
        transport = Transport({
            first_landing: (0, 200, "text/html", b"<html>article not found</html>"),
            second_landing: (0, 200, "text/html", (
                f'<a href="{invalid}">bad</a><a href="{valid}">good</a>'
            ).encode()),
            invalid: (0, 200, "application/pdf", b"bad"),
            valid: (0, 200, "application/pdf", pdf_bytes("translated")),
        })
        translators = (
            self.translator(transport, "one", "translator-one.test"),
            self.translator(transport, "two", "translator-two.test"),
        )
        result = asyncio.run(self.service(
            transport, {"empty": Resolver("empty", {})}, translators=translators,
        ).acquire(
            self.first.id, AssetRole.PRIMARY_PDF,
            self.target(self.first.id),
            ("empty",), timeout=1,
        ))
        self.assertEqual(result.status, "succeeded")
        calls = [url for url, _ in transport.calls]
        self.assertLess(calls.index(first_landing), calls.index(second_landing))
        self.assertLess(calls.index(invalid), calls.index(valid))
        with self.engine.connect() as connection:
            self.assertEqual(connection.exec_driver_sql("SELECT count(*) FROM diagnostic_records").scalar_one(), 0)

    def test_browser_is_third_tier_and_prior_success_short_circuits_it(self):
        browser = BrowserRuleResolver(BrowserRuleConfig(
            "publisher", "https://browser.test/article/{doi}",
            ("browser.test",), ("pdf.test",), ("browser.test", "pdf.test"),
        ))
        class Runner:
            def __init__(self):
                self.calls = 0
            def run(self, candidate, timeout, target):
                del timeout, target
                self.calls += 1
                return ProviderContent(
                    AssetRole.PRIMARY_PDF, "application/pdf", "pdf", "candidate://unsafe",
                    candidate.provider, pdf_bytes("browser"), {"secret_url": "https://secret.test/x"},
                )
        runner = Runner()
        target = self.target(self.first.id)
        result = asyncio.run(self.service(
            Transport({}), {"empty": Resolver("empty", {})},
            browsers=(browser,), browser_runner=runner,
        ).acquire(self.first.id, AssetRole.PRIMARY_PDF, target, ("empty",), timeout=1))
        self.assertEqual(result.status, "succeeded")
        self.assertEqual(runner.calls, 1)
        with self.engine.connect() as connection:
            self.assertEqual(connection.exec_driver_sql("SELECT count(*) FROM diagnostic_records").scalar_one(), 0)

        second_runner = Runner()
        direct = "https://first.test/second.pdf"
        result = asyncio.run(self.service(
            Transport({direct: (0, 200, "application/pdf", pdf_bytes("first"))}),
            {"first": Resolver("first", {AssetRole.PRIMARY_PDF: (direct,)})},
            browsers=(browser,), browser_runner=second_runner,
        ).acquire(self.second.id, AssetRole.PRIMARY_PDF,
                  self.target(self.second.id),
                  ("first",), timeout=1))
        self.assertEqual(result.status, "succeeded")
        self.assertEqual(second_runner.calls, 0)

    def test_all_tier_failure_is_missing_with_sanitized_diagnostics(self):
        landing = "https://translator-fail.test/article/10.1000%2Falpha"
        secret = "secret-query-value"
        transport = Transport({
            landing: (0, 200, "text/html", f'<a href="/paper.pdf?token={secret}">x</a>'.encode()),
            f"https://translator-fail.test/paper.pdf?token={secret}": (0, 200, "application/pdf", b"bad"),
        })
        result = asyncio.run(self.service(
            transport, {"empty": Resolver("empty", {})},
            translators=(self.translator(transport, "fail", "translator-fail.test"),),
        ).acquire(
            self.first.id, AssetRole.PRIMARY_PDF,
            self.target(self.first.id),
            ("empty",), timeout=1,
        ))
        self.assertEqual(result.status, "failed")
        self.assertEqual([item["tier"] for item in result.source_failures], ["first", "translator"])
        self.assertNotIn(secret, repr(result.source_failures))

    def test_failure_diagnostics_redact_runtime_credentials(self):
        url = "https://secret.test/file"
        secret = "Bearer DO-NOT-EMIT"
        transport = Transport({url: (0, 200, "application/pdf", b"bad")})
        resolver = Resolver("secret", {AssetRole.PRIMARY_PDF: (url,)}, secret=secret)
        result = asyncio.run(self.service(transport, {"secret": resolver}).acquire(
            self.first.id, AssetRole.PRIMARY_PDF,
            AcquisitionTarget((), role=AssetRole.PRIMARY_PDF), ("secret",), timeout=1,
        ))
        self.assertEqual(result.status, "failed")
        with self.engine.connect() as connection:
            details = connection.exec_driver_sql(
                "SELECT details_json FROM diagnostic_records WHERE stage='acquisition' ORDER BY occurred_at DESC LIMIT 1"
            ).scalar_one()
        self.assertNotIn(secret, details)
        self.assertNotIn(url, details)

    def test_springer_xml_keeps_api_key_out_of_candidate_url_and_repr(self):
        secret = "SPRINGER-DO-NOT-EMIT"
        candidate = SpringerResolver(Transport({}), secret).resolve(
            AcquisitionTarget(self.repository.get(self.first.id).identifiers),
            AssetRole.XML,
            timeout=1,
        )[0]
        self.assertNotIn(secret, candidate.execution_url)
        self.assertNotIn(secret, repr(candidate))
        self.assertEqual(candidate.request_params, {"api_key": secret})

if __name__ == "__main__":
    import unittest
    unittest.main()
