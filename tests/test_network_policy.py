from __future__ import annotations

import ipaddress
import unittest

import sciretriever.network.policy as policy_module
from sciretriever.network.policy import (
    AddressClass,
    DestinationPolicy,
    NormalizedURL,
    PolicyError,
    ResourceBudget,
    append_opaque_path_parameter,
    classify_address,
    evaluate_redirect,
    normalize_url,
    redact_cookie,
    redact_exception,
    redact_headers,
    redact_query,
    redact_url,
    resolve_destination,
)

SENTINEL = "NETWORK-POLICY-SECRET-SENTINEL"


class FakeResolver:
    def __init__(self, answers: list[list[str]]) -> None:
        self.answers = list(answers)
        self.calls: list[str] = []

    def resolve(self, hostname: str) -> tuple[str, ...]:
        self.calls.append(hostname)
        if not self.answers:
            raise RuntimeError("resolver exhausted")
        return tuple(self.answers.pop(0))


class UrlPolicyTests(unittest.TestCase):
    def test_normalizes_https_host_default_port_and_idna_without_dns(self) -> None:
        normalized = normalize_url("HTTPS://BÜCHER.example:443/a%20b?q=plain")

        self.assertEqual(normalized.scheme, "https")
        self.assertEqual(normalized.hostname, "xn--bcher-kva.example")
        self.assertEqual(normalized.port, 443)
        self.assertEqual(normalized.url, "https://xn--bcher-kva.example/a%20b?q=plain")
        self.assertEqual(normalized.origin.text, "https://xn--bcher-kva.example")

    def test_rejects_malformed_scheme_port_userinfo_controls_backslash_and_fragments(self) -> None:
        invalid = (
            "http://example.test/",
            "ftp://example.test/",
            "https://example.test:444/",
            "https://user:password@example.test/",
            "https://example.test/a\\b",
            "https://example.test/a\tb",
            "https://example.test/a#fragment",
            "https://example.test/%2fprivate",
            "https://example.test/a/%2e%2e/private",
            "https://example.test/%252fprivate",
            "https://example.test/%255cprivate",
            "https://example.test/%252e%252e/private",
            "https://127.1/",
            "https://2130706433/",
            "https://127.0.0.1./",
        )
        for value in invalid:
            with self.subTest(value=value):
                with self.assertRaises(PolicyError) as caught:
                    normalize_url(value)
                self.assertNotIn("password", str(caught.exception))
                self.assertNotIn(SENTINEL, str(caught.exception))

    def test_default_and_explicit_exact_port_policies_are_closed(self) -> None:
        for value, schemes in (
            ("https://example.test:8443/resource", ("https",)),
            ("http://example.test:8000/resource", ("http",)),
        ):
            with self.subTest(value=value):
                with self.assertRaises(PolicyError):
                    normalize_url(value, allowed_schemes=schemes)

        normalized = normalize_url(
            "HTTP://127.0.0.1:8000/health",
            allowed_schemes=("http",),
            allowed_ports=frozenset({("http", 8000)}),
        )
        self.assertEqual(normalized.url, "http://127.0.0.1:8000/health")
        self.assertEqual(normalized.port, 8000)
        self.assertEqual(normalized.origin.text, "http://127.0.0.1:8000")

        with self.assertRaises(PolicyError):
            normalize_url(
                "http://127.0.0.1:8001/health",
                allowed_schemes=("http",),
                allowed_ports=frozenset({("http", 8000)}),
            )

    def test_destination_policy_rejects_invalid_exact_port_pairs(self) -> None:
        invalid = (
            frozenset({("ftp", 8000)}),
            frozenset({("https", 8443)}),
            frozenset({("http", True)}),
            frozenset({("http", 0)}),
            frozenset({("http", 65536)}),
        )
        for allowed_ports in invalid:
            with self.subTest(allowed_ports=allowed_ports):
                with self.assertRaises(PolicyError):
                    DestinationPolicy(
                        allowed_schemes=frozenset({"http"}),
                        allowed_ports=allowed_ports,
                    )

    def test_rejects_sensitive_query_and_malformed_idna(self) -> None:
        for value in (
            f"https://example.test/?token={SENTINEL}",
            "https://example.test/?api-key=value",
            "https://example.test/?api%5Fkey=value",
            "https://example.test/?sig=value",
            "https://example.test/?X-Amz-Credential=value",
            "https://example.test/?X-Goog-Signature=value",
            "https://example.test/?bad=%ZZ",
            "https://-bad.example/",
            "https://example..test/",
        ):
            with self.subTest(value=value):
                with self.assertRaises(PolicyError):
                    normalize_url(value)

    def test_query_allows_only_encoded_ascii_space(self) -> None:
        valid = (
            "https://example.test/?query=retrieval+systems",
            "https://example.test/?query=retrieval%20systems",
            ("https://example.test/?search_query=submittedDate:%5B202601010000+TO+202601312359%5D"),
        )
        for value in valid:
            with self.subTest(value=value):
                self.assertEqual(normalize_url(value).url, value)

        invalid = (
            "https://example.test/?query=retrieval systems",
            "https://example.test/?query=retrieval%09systems",
            "https://example.test/?query=retrieval%0Dsystems",
            "https://example.test/?query=retrieval%0Asystems",
            "https://example.test/?query=retrieval%C2%A0systems",
            "https://example.test/?query=retrieval%E2%80%8Bsystems",
            "https://example.test/?query=retrieval%ZZsystems",
            "https://example.test/?api%5Fkey=value",
        )
        for value in invalid:
            with self.subTest(value=value):
                with self.assertRaises(PolicyError):
                    normalize_url(value)

    def test_network_appends_one_validated_opaque_path_parameter(self) -> None:
        base = normalize_url("https://example.test/works/?query=retrieval+systems")

        result = append_opaque_path_parameter(
            base,
            "10.1038/s41586-020-2649-2",
        )

        self.assertEqual(
            result.url,
            ("https://example.test/works/10.1038%2Fs41586-020-2649-2?query=retrieval+systems"),
        )
        self.assertEqual(result.path, "/works/10.1038%2Fs41586-020-2649-2")
        self.assertEqual(result.query, base.query)
        with self.assertRaises(PolicyError):
            normalize_url(result.url)

        suffixed = append_opaque_path_parameter(
            normalize_url("https://example.test/graph/v1/paper"),
            "DOI:10.1038/s41586-020-2649-2",
            suffix="references",
        )
        self.assertEqual(
            suffixed.url,
            ("https://example.test/graph/v1/paper/DOI:10.1038%2Fs41586-020-2649-2/references"),
        )

    def test_opaque_path_parameter_preserves_an_explicit_exact_port(self) -> None:
        base = normalize_url(
            "http://127.0.0.1:8000/tasks",
            allowed_schemes=("http",),
            allowed_ports=frozenset({("http", 8000)}),
        )

        result = append_opaque_path_parameter(base, "fixture/task", suffix="result")

        self.assertEqual(
            result.url,
            "http://127.0.0.1:8000/tasks/fixture%2Ftask/result",
        )
        self.assertEqual(result.port, 8000)
        self.assertEqual(result.origin.text, "http://127.0.0.1:8000")

    def test_opaque_path_parameter_rejects_ambiguous_or_traversing_input(self) -> None:
        base = normalize_url("https://example.test/works")
        invalid = (
            "",
            "   ",
            "../x",
            "/a",
            "a/",
            "a//b",
            "a/./b",
            "a/../b",
            "a\\b",
            "a/\x00/b",
            "a/\u200b/b",
            "%2E%2E/x",
            "%252E%252E%252Fx",
            "a%2F%2Fb",
            "a%255Cb",
            "\ud800",
        )
        for value in invalid:
            with self.subTest(value=repr(value)):
                with self.assertRaises(PolicyError):
                    append_opaque_path_parameter(base, value)

        forged = NormalizedURL(
            url="https://example.test/works/10.1038%2Funsafe",
            scheme="https",
            hostname="example.test",
            port=443,
            path="/works/10.1038%2Funsafe",
            query="",
        )
        with self.assertRaises(PolicyError):
            append_opaque_path_parameter(forged, "another/value")

    def test_opaque_path_suffix_is_one_ascii_unreserved_literal(self) -> None:
        base = normalize_url("https://example.test/graph/v1/paper")
        for suffix in ("references", "citations", "safe-segment_1.0~"):
            with self.subTest(suffix=suffix):
                result = append_opaque_path_parameter(
                    base,
                    "CorpusId:123",
                    suffix=suffix,
                )
                self.assertTrue(result.path.endswith(f"/CorpusId:123/{suffix}"))

        invalid = (
            "",
            ".",
            "..",
            "/",
            "references/citations",
            "references\\citations",
            "%72eferences",
            "references?limit=1",
            "references#fragment",
            " references",
            "references ",
            "references\t",
            "references\n",
            "references\u200b",
            "références",
        )
        for suffix in invalid:
            with self.subTest(suffix=repr(suffix)):
                with self.assertRaises(PolicyError):
                    append_opaque_path_parameter(
                        base,
                        "CorpusId:123",
                        suffix=suffix,
                    )

    def test_address_classes_cover_special_and_public_values(self) -> None:
        cases = {
            "10.0.0.1": AddressClass.PRIVATE,
            "127.0.0.1": AddressClass.LOOPBACK,
            "169.254.1.1": AddressClass.LINK_LOCAL,
            "224.0.0.1": AddressClass.MULTICAST,
            "0.0.0.0": AddressClass.UNSPECIFIED,
            "192.0.0.1": AddressClass.RESERVED,
            "93.184.216.34": AddressClass.PUBLIC,
        }
        for value, expected in cases.items():
            with self.subTest(value=value):
                self.assertEqual(classify_address(value), expected)

        self.assertEqual(
            classify_address(ipaddress.IPv6Address("2001:db8::1")), AddressClass.RESERVED
        )


class DestinationPolicyTests(unittest.TestCase):
    def test_exact_port_policy_applies_to_initial_and_redirect_destinations(self) -> None:
        exact_policy = DestinationPolicy(
            allowed_schemes=frozenset({"http"}),
            allowed_ports=frozenset({("http", 8000)}),
            allowed_classes=frozenset({AddressClass.LOOPBACK}),
            allowed_addresses=frozenset({"127.0.0.1"}),
        )
        resolver = FakeResolver([])
        current = resolve_destination(
            "http://127.0.0.1:8000/start",
            resolver,
            policy=exact_policy,
        )

        allowed = evaluate_redirect(current, "/next", resolver, policy=exact_policy)

        self.assertTrue(allowed.same_origin)
        self.assertEqual(allowed.destination.url.url, "http://127.0.0.1:8000/next")
        with self.assertRaises(PolicyError):
            evaluate_redirect(
                current,
                "http://127.0.0.1:8001/next",
                resolver,
                policy=exact_policy,
            )

    def test_cross_port_redirect_is_cross_origin_and_does_not_forward_credentials(self) -> None:
        policy = DestinationPolicy(
            allowed_schemes=frozenset({"http"}),
            allowed_ports=frozenset({("http", 8000), ("http", 8001)}),
            allowed_classes=frozenset({AddressClass.LOOPBACK}),
            allowed_addresses=frozenset({"127.0.0.1"}),
        )
        resolver = FakeResolver([])
        current = resolve_destination(
            "http://127.0.0.1:8000/start",
            resolver,
            policy=policy,
        )

        decision = evaluate_redirect(
            current,
            "http://127.0.0.1:8001/next",
            resolver,
            policy=policy,
        )

        self.assertFalse(decision.same_origin)
        self.assertFalse(decision.forward_credentials)
        self.assertNotEqual(decision.source.origin, decision.destination.origin)

    def test_forged_normalized_url_cannot_bypass_exact_port_policy(self) -> None:
        policy = DestinationPolicy(
            allowed_ports=frozenset({("https", 443)}),
        )
        forged = NormalizedURL(
            url="https://example.test:8443/resource",
            scheme="https",
            hostname="example.test",
            port=8443,
            path="/resource",
            query="",
        )

        with self.assertRaises(PolicyError):
            resolve_destination(
                forged,
                FakeResolver([["93.184.216.34"]]),
                policy=policy,
            )

    def test_all_dns_results_are_checked_and_private_result_fails_closed(self) -> None:
        resolver = FakeResolver([["93.184.216.34", "10.0.0.8"]])

        with self.assertRaises(PolicyError):
            resolve_destination("https://example.test/", resolver)
        self.assertEqual(resolver.calls, ["example.test"])

    def test_dns_rebinding_is_rechecked_and_detected(self) -> None:
        resolver = FakeResolver([["93.184.216.34"], ["127.0.0.1"]])
        first = resolve_destination("https://example.test/", resolver)

        with self.assertRaises(PolicyError):
            resolve_destination("https://example.test/", resolver, previous=first)
        self.assertEqual(resolver.calls, ["example.test", "example.test"])

    def test_explicit_operator_address_policy_can_narrow_destination_without_url_override(
        self,
    ) -> None:
        policy = DestinationPolicy(
            allowed_classes=frozenset({AddressClass.PRIVATE}),
            allowed_addresses=frozenset({"10.0.0.8"}),
        )
        destination = resolve_destination(
            "https://operator.test/",
            FakeResolver([["10.0.0.8"]]),
            policy=policy,
        )
        self.assertEqual(destination.addresses, ("10.0.0.8",))

    def test_redirect_rechecks_each_target_and_strips_cross_origin_credentials(self) -> None:
        resolver = FakeResolver([["93.184.216.34"], ["93.184.216.34"], ["1.1.1.1"], ["127.0.0.1"]])
        current = resolve_destination("https://example.test/start", resolver)
        same_origin = evaluate_redirect(current, "/next", resolver)
        self.assertTrue(same_origin.same_origin)
        self.assertTrue(same_origin.forward_credentials)

        cross_origin = evaluate_redirect(
            same_origin.destination, "https://other.test/next", resolver
        )
        self.assertFalse(cross_origin.same_origin)
        self.assertFalse(cross_origin.forward_credentials)

        with self.assertRaises(PolicyError):
            evaluate_redirect(cross_origin.destination, "https://private.test/", resolver)

    def test_redirect_relative_target_cannot_escape_path_policy(self) -> None:
        resolver = FakeResolver([["93.184.216.34"], ["93.184.216.34"]])
        current = resolve_destination("https://example.test/a/b", resolver)
        with self.assertRaises(PolicyError):
            evaluate_redirect(current, "../../secret", resolver)

    def test_redirect_target_guard_sees_absolute_text_before_any_dns_resolution(self) -> None:
        resolver = FakeResolver([["93.184.216.34"], ["1.1.1.1"]])
        guarded_targets: list[str] = []

        def reject_target(target: str) -> None:
            guarded_targets.append(target)
            self.assertEqual(resolver.calls, [])
            raise RuntimeError(SENTINEL)

        with self.assertRaises(PolicyError) as caught:
            evaluate_redirect(
                "https://example.test/start",
                f"https://{SENTINEL.casefold()}.danger.test/next",
                resolver,
                target_guard=reject_target,
            )

        self.assertEqual(
            guarded_targets,
            [f"https://{SENTINEL.casefold()}.danger.test/next"],
        )
        self.assertEqual(resolver.calls, [])
        self.assertNotIn(SENTINEL, str(caught.exception))

    def test_redirect_target_guard_allows_resolution_after_precheck(self) -> None:
        resolver = FakeResolver([["93.184.216.34"], ["1.1.1.1"]])
        guarded_targets: list[str] = []

        decision = evaluate_redirect(
            "https://example.test/start",
            "https://other.test/next",
            resolver,
            target_guard=guarded_targets.append,
        )

        self.assertEqual(guarded_targets, ["https://other.test/next"])
        self.assertEqual(resolver.calls, ["example.test", "other.test"])
        self.assertEqual(decision.destination.hostname, "other.test")


class BudgetAndRedactionTests(unittest.TestCase):
    def test_resource_budget_is_the_only_budget_export(self) -> None:
        self.assertFalse(hasattr(policy_module, "AccessBudget"))
        self.assertNotIn("AccessBudget", policy_module.__all__)

    def test_budget_is_protocol_neutral_and_fail_closed_at_each_boundary(self) -> None:
        budget = ResourceBudget(
            max_response_bytes=10,
            max_navigations=2,
            max_downloads=1,
            max_total_seconds=5.0,
        )
        usage = budget.consume(response_bytes=10, navigations=2, downloads=1, elapsed_seconds=5.0)
        self.assertEqual(usage.response_bytes, 10)
        with self.assertRaises(PolicyError):
            budget.consume(response_bytes=11)
        with self.assertRaises(PolicyError):
            budget.consume(navigations=3)
        with self.assertRaises(PolicyError):
            budget.consume(downloads=2)
        with self.assertRaises(PolicyError):
            budget.consume(elapsed_seconds=5.1)

    def test_redaction_never_returns_url_query_header_cookie_or_exception_secret(self) -> None:
        url = f"https://example.test/private?token={SENTINEL}&page=1"
        values = (
            redact_url(url),
            redact_query(f"token={SENTINEL}&page=1"),
            str(redact_headers({"Authorization": SENTINEL, "X-Trace": SENTINEL})),
            redact_cookie(f"session={SENTINEL}"),
            redact_exception(RuntimeError(SENTINEL)),
        )
        for value in values:
            self.assertNotIn(SENTINEL, value)
        self.assertNotIn("token=", values[0])

    def test_policy_errors_are_stable_and_do_not_echo_untrusted_values(self) -> None:
        with self.assertRaises(PolicyError) as caught:
            normalize_url(f"https://example.test/?secret={SENTINEL}")
        self.assertEqual(str(caught.exception), "network policy rejected input")


if __name__ == "__main__":
    unittest.main()
