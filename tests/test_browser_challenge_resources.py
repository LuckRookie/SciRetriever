from __future__ import annotations

import unittest

from sciretriever.acquisition.sources.browser import build_browser_rule_destination_guard
from sciretriever.acquisition.sources.browser_rules import (
    BrowserChallengeResourceMatch,
    BrowserChallengeResourceProfile,
    BrowserRuleCatalog,
    BrowserSiteRule,
)
from sciretriever.acquisition.sources.browser_rules.helpers import cloudflare_challenge_profile
from sciretriever.acquisition.sources.browser_rules.model import BrowserChallengePathFamily
from sciretriever.network.browser import (
    BrowserCaptureKind,
    BrowserDestinationKind,
    BrowserRequestObservation,
)
from sciretriever.network.playwright import _frame_observation


def _rule(*, profile: BrowserChallengeResourceProfile | None) -> BrowserSiteRule:
    return BrowserSiteRule(
        rule_id="fixture-publisher",
        revision=1,
        landing_origin="https://publisher.test",
        allowed_origins=("https://publisher.test",),
        web_scope_provider_name="fixture-publisher",
        challenge_resource_profile=profile,
    )


def _profile() -> BrowserChallengeResourceProfile:
    return BrowserChallengeResourceProfile(
        origin="https://challenges.cloudflare.com",
        path_prefixes=(
            "https://challenges.cloudflare.com/cdn-cgi/challenge-platform/",
            "https://challenges.cloudflare.com/turnstile/v0/",
        ),
        resource_types=("script", "document", "fetch", "image"),
    )


def _publisher_navigation(path: str, *, redirect_depth: int = 0) -> BrowserRequestObservation:
    locator = f"https://publisher.test{path}"
    return BrowserRequestObservation(
        locator=locator,
        kind=BrowserDestinationKind.NAVIGATION,
        resource_type="document",
        is_navigation=True,
        is_top_frame=True,
        frame_depth=0,
        top_frame_locator=locator,
        redirect_depth=redirect_depth,
    )


def _challenge_observation(
    path: str = "/cdn-cgi/challenge-platform/challenge.js",
    *,
    resource_type: str = "script",
    is_navigation: bool = False,
    is_top_frame: bool = True,
    frame_depth: int | None = 0,
    frame_ancestry: tuple[str, ...] = (),
    top_frame_locator: str | None = "https://publisher.test/article/one",
    is_popup: bool = False,
    capture_kind: BrowserCaptureKind | None = None,
) -> BrowserRequestObservation:
    return BrowserRequestObservation(
        locator=f"https://challenges.cloudflare.com{path}",
        kind=(
            BrowserDestinationKind.NAVIGATION if is_navigation else BrowserDestinationKind.REQUEST
        ),
        resource_type=resource_type,
        is_navigation=is_navigation,
        is_top_frame=is_top_frame,
        frame_depth=frame_depth,
        frame_ancestry=frame_ancestry,
        top_frame_locator=top_frame_locator,
        is_popup=is_popup,
        capture_kind=capture_kind,
    )


class BrowserChallengeResourceProfileTests(unittest.TestCase):
    def test_production_cloudflare_profile_is_narrow_for_turnstile(self) -> None:
        profile = cloudflare_challenge_profile()
        self.assertEqual(profile.origin, "https://challenges.cloudflare.com")
        self.assertEqual(
            profile.path_prefixes,
            (
                "https://challenges.cloudflare.com/cdn-cgi/challenge-platform/",
                "https://challenges.cloudflare.com/turnstile/v0/",
            ),
        )
        self.assertEqual(
            profile.resource_types,
            ("script", "document", "fetch", "xhr", "image"),
        )

    def test_production_profile_admits_bounded_challenge_iframe_image(self) -> None:
        profile = cloudflare_challenge_profile()
        guard = build_browser_rule_destination_guard(
            _rule(profile=profile), "https://publisher.test/article/one"
        )
        image = _challenge_observation(
            path="/cdn-cgi/challenge-platform/challenge.gif",
            resource_type="image",
            is_top_frame=False,
            frame_depth=1,
            frame_ancestry=("https://publisher.test/article/one",),
        )

        guard.check(image.locator, BrowserDestinationKind.REQUEST)
        guard.check_request(image)

        self.assertEqual(profile.match_reason(image), BrowserChallengeResourceMatch.ADMITTED)
        self.assertEqual(guard.challenge_resource_counts(), (1, 0))

    def test_challenge_image_expansion_remains_fail_closed(self) -> None:
        profile = cloudflare_challenge_profile()
        guard = build_browser_rule_destination_guard(
            _rule(profile=profile), "https://publisher.test/article/one"
        )
        image_path = "/cdn-cgi/challenge-platform/challenge.gif"

        with self.assertRaises(ValueError):
            guard.check(
                f"https://challenges.cloudflare.com{image_path}",
                BrowserDestinationKind.DOWNLOAD,
            )
        with self.assertRaises(ValueError):
            guard.check(
                "https://unknown.test/cdn-cgi/challenge-platform/challenge.gif",
                BrowserDestinationKind.REQUEST,
            )
        rejected = (
            _challenge_observation(
                path=image_path,
                resource_type="image",
                is_navigation=True,
                is_top_frame=True,
            ),
            _challenge_observation(
                path=image_path,
                resource_type="image",
                is_top_frame=False,
                frame_depth=1,
                frame_ancestry=("https://publisher.test/article/one",),
                is_popup=True,
            ),
            _challenge_observation(
                path=image_path,
                resource_type="image",
                is_top_frame=False,
                frame_depth=1,
                frame_ancestry=(),
            ),
            _challenge_observation(
                path="/cdn-cgi/other/challenge.gif",
                resource_type="image",
                is_top_frame=False,
                frame_depth=1,
                frame_ancestry=("https://publisher.test/article/one",),
            ),
            _challenge_observation(
                path=image_path,
                resource_type="media",
                is_top_frame=False,
                frame_depth=1,
                frame_ancestry=("https://publisher.test/article/one",),
            ),
            _challenge_observation(
                path="/turnstile/v1/challenge.gif",
                resource_type="image",
                is_top_frame=False,
                frame_depth=1,
                frame_ancestry=("https://publisher.test/article/one",),
            ),
        )
        for observation in rejected:
            with self.subTest(
                resource_type=observation.resource_type,
                is_navigation=observation.is_navigation,
                is_popup=observation.is_popup,
            ):
                with self.assertRaises(ValueError):
                    guard.check_request(observation)

    def test_frame_observation_keeps_opaque_child_depth(self) -> None:
        class Frame:
            def __init__(self, url: str, parent_frame: object | None = None) -> None:
                self.url = url
                self.parent_frame = parent_frame

        class Request:
            def __init__(self, frame: Frame) -> None:
                self.frame = frame

        top = Frame("https://publisher.test/article/one")
        child = Frame("about:blank", top)
        is_top, depth, ancestry, locator = _frame_observation(Request(child))
        self.assertFalse(is_top)
        self.assertEqual(depth, 1)
        self.assertEqual(ancestry, ("https://publisher.test/article/one",))
        self.assertEqual(locator, "https://publisher.test/article/one")

    def test_profile_is_not_an_allowed_origin_but_is_prebound(self) -> None:
        profile = _profile()
        rule = _rule(profile=profile)
        guard = build_browser_rule_destination_guard(rule, "https://publisher.test/article/one")

        self.assertNotIn(profile.origin, rule.allowed_origins)
        self.assertIn(profile.origin, guard.connection_origins())
        guard.check(
            "https://challenges.cloudflare.com/cdn-cgi/challenge-platform/challenge.js",
            BrowserDestinationKind.REQUEST,
        )
        with self.assertRaises(ValueError):
            guard.check(
                "https://challenges.cloudflare.com/cdn-cgi/challenge-platform/challenge.js",
                BrowserDestinationKind.INITIAL_NAVIGATION,
            )

    def test_top_frame_script_and_bounded_iframe_navigation_are_admitted(self) -> None:
        guard = build_browser_rule_destination_guard(
            _rule(profile=_profile()), "https://publisher.test/article/one"
        )
        guard.check_request(_challenge_observation())
        guard.check_request(
            _challenge_observation(
                resource_type="document",
                is_navigation=True,
                is_top_frame=False,
                frame_depth=1,
                frame_ancestry=("https://publisher.test/article/one",),
            )
        )

    def test_same_origin_redirect_updates_article_chain_before_challenge(self) -> None:
        guard = build_browser_rule_destination_guard(
            _rule(profile=_profile()), "https://publisher.test/article/one"
        )
        guard.check_request(_publisher_navigation("/article/one"))
        guard.check_request(_publisher_navigation("/challenge/redirected", redirect_depth=1))
        guard.check_request(
            _challenge_observation(
                top_frame_locator="https://publisher.test/challenge/redirected",
            )
        )

    def test_same_origin_without_redirect_still_rejects_cross_article_path(self) -> None:
        guard = build_browser_rule_destination_guard(
            _rule(profile=_profile()), "https://publisher.test/article/one"
        )
        guard.check_request(_publisher_navigation("/article/one"))
        guard.check_request(_publisher_navigation("/article/two"))
        with self.assertRaises(ValueError):
            guard.check_request(
                _challenge_observation(top_frame_locator="https://publisher.test/article/two")
            )

    def test_identity_proven_page_rebind_admits_top_frame_challenge_script(self) -> None:
        rule = _rule(profile=_profile())
        current_landing = "https://publisher.test/article/one"
        rebound: list[str] = []

        def rebind(value: str) -> bool:
            if not rule.matches_article_landing(
                value,
                landing_url=current_landing,
                identifiers=(),
            ):
                return False
            rebound.append(value)
            return True

        guard = build_browser_rule_destination_guard(
            rule,
            current_landing,
            rebind,
        )
        guard.check_request(_publisher_navigation("/article/one"))
        guard.check_request(
            _challenge_observation(
                path="/turnstile/v0/api.js",
                top_frame_locator="https://publisher.test/abstract/one",
            )
        )

        self.assertEqual(rebound, ["https://publisher.test/abstract/one"])
        self.assertEqual(guard.challenge_resource_counts(), (1, 0))
        self.assertTrue(
            rule.matches_article_landing(
                "https://publisher.test/abstract/one",
                landing_url=current_landing,
                identifiers=(),
            )
        )
        self.assertFalse(
            rule.matches_article_landing(
                "https://publisher.test/article/two",
                landing_url=current_landing,
                identifiers=(),
            )
        )

    def test_cross_origin_redirect_and_ancestor_remain_rejected(self) -> None:
        guard = build_browser_rule_destination_guard(
            _rule(profile=_profile()), "https://publisher.test/article/one"
        )
        guard.check_request(_publisher_navigation("/article/one"))
        foreign_navigation = BrowserRequestObservation(
            locator="https://other.test/challenge/redirected",
            kind=BrowserDestinationKind.NAVIGATION,
            resource_type="document",
            is_navigation=True,
            is_top_frame=True,
            frame_depth=0,
            top_frame_locator="https://other.test/challenge/redirected",
            redirect_depth=1,
        )
        with self.assertRaises(ValueError):
            guard.check(foreign_navigation.locator, BrowserDestinationKind.NAVIGATION)
        with self.assertRaises(ValueError):
            guard.check_request(
                _challenge_observation(
                    frame_depth=1,
                    is_top_frame=False,
                    frame_ancestry=("https://other.test/article/one",),
                    top_frame_locator="https://other.test/article/one",
                )
            )

    def test_challenge_navigation_capture_and_unknown_paths_fail_closed(self) -> None:
        guard = build_browser_rule_destination_guard(
            _rule(profile=_profile()), "https://publisher.test/article/one"
        )
        with self.assertRaises(ValueError):
            guard.check_request(
                _challenge_observation(
                    resource_type="document",
                    is_navigation=True,
                    is_top_frame=True,
                )
            )
        with self.assertRaises(ValueError):
            guard.check_request(_challenge_observation(is_popup=True))
        with self.assertRaises(ValueError):
            guard.check_request(
                _challenge_observation(
                    is_top_frame=False,
                    frame_depth=None,
                    top_frame_locator=None,
                )
            )
        with self.assertRaises(ValueError):
            guard.check_request(
                _challenge_observation(
                    path="/other/script.js",
                )
            )
        with self.assertRaises(ValueError):
            guard.check_request(
                _challenge_observation(
                    path="/cdn-cgi/challenge-platform/challenge.pdf",
                    capture_kind=BrowserCaptureKind.RESPONSE,
                )
            )

    def test_turnstile_v0_is_admitted_but_other_turnstile_paths_fail_closed(self) -> None:
        guard = build_browser_rule_destination_guard(
            _rule(profile=_profile()), "https://publisher.test/article/one"
        )
        guard.check_request(_challenge_observation(path="/turnstile/v0/api.js"))
        with self.assertRaises(ValueError):
            guard.check_request(_challenge_observation(path="/turnstile/v1/api.js"))

    def test_path_family_diagnostic_is_fixed_and_payload_free(self) -> None:
        profile = _profile()
        self.assertEqual(
            profile.path_family(_challenge_observation()),
            BrowserChallengePathFamily.CHALLENGE_PLATFORM,
        )
        self.assertEqual(
            profile.path_family(_challenge_observation(path="/turnstile/v0/api.js")),
            BrowserChallengePathFamily.TURNSTILE,
        )
        self.assertEqual(
            profile.path_family(_challenge_observation(path="/turnstile/v1/api.js")),
            BrowserChallengePathFamily.TURNSTILE,
        )
        self.assertEqual(
            profile.path_family(_challenge_observation(path="/cdn-cgi/other/private-token.js")),
            BrowserChallengePathFamily.OTHER,
        )

    def test_unknown_publisher_ancestor_and_cross_article_are_rejected(self) -> None:
        guard = build_browser_rule_destination_guard(
            _rule(profile=_profile()), "https://publisher.test/article/one"
        )
        with self.assertRaises(ValueError):
            guard.check_request(
                _challenge_observation(
                    is_top_frame=False,
                    frame_depth=1,
                    frame_ancestry=("https://other.test/article/one",),
                    top_frame_locator="https://other.test/article/one",
                )
            )
        guard.check_request(_publisher_navigation("/article/one"))
        guard.check_request(_publisher_navigation("/article/two"))
        with self.assertRaises(ValueError):
            guard.check_request(
                _challenge_observation(top_frame_locator="https://publisher.test/article/two")
            )

    def test_profile_validation_is_strict_and_catalog_remains_closed(self) -> None:
        with self.assertRaises(ValueError):
            BrowserChallengeResourceProfile(
                origin="https://challenges.cloudflare.com:8443",
                path_prefixes=("https://challenges.cloudflare.com/cdn-cgi/",),
                resource_types=("script",),
            )
        with self.assertRaises(ValueError):
            BrowserChallengeResourceProfile(
                origin="https://challenges.cloudflare.com",
                path_prefixes=("https://other.test/cdn-cgi/",),
                resource_types=("script",),
            )
        with self.assertRaises(ValueError):
            BrowserSiteRule(
                rule_id="fixture-publisher",
                revision=1,
                landing_origin="https://publisher.test",
                allowed_origins=(
                    "https://publisher.test",
                    "https://challenges.cloudflare.com",
                ),
                web_scope_provider_name="fixture-publisher",
                challenge_resource_profile=_profile(),
            )
        catalog = BrowserRuleCatalog((_rule(profile=None),))
        self.assertEqual(len(catalog.rules), 1)

    def test_profile_match_reason_is_bounded_and_does_not_expose_locator(self) -> None:
        profile = _profile()
        self.assertEqual(
            profile.match_reason(_challenge_observation()),
            BrowserChallengeResourceMatch.ADMITTED,
        )
        self.assertEqual(
            profile.match_reason(_challenge_observation(path="/other/script.js")),
            BrowserChallengeResourceMatch.PATH_MISMATCH,
        )
        self.assertEqual(
            profile.match_reason(_challenge_observation(resource_type="media")),
            BrowserChallengeResourceMatch.RESOURCE_TYPE_MISMATCH,
        )
        self.assertEqual(
            profile.match_reason(
                _challenge_observation(top_frame_locator="https://publisher.test/article/one")
            ),
            BrowserChallengeResourceMatch.ADMITTED,
        )

    def test_guard_rejection_diagnostic_contains_only_bounded_request_shape(self) -> None:
        guard = build_browser_rule_destination_guard(
            _rule(profile=_profile()), "https://publisher.test/article/one"
        )
        with self.assertLogs("sciretriever.acquisition.sources.browser", level="DEBUG") as captured:
            with self.assertRaises(ValueError):
                guard.check_request(_challenge_observation(path="/cdn-cgi/other/private-token.js"))
        output = "\n".join(captured.output)
        self.assertIn("event=browser-challenge-resource-rejected", output)
        self.assertIn("reason=path", output)
        self.assertIn("path_family=other", output)
        self.assertIn("resource_type=script", output)
        self.assertIn("request_kind=request", output)
        self.assertIn("frame_depth=0", output)
        self.assertIn("ancestry_depth=0", output)
        self.assertNotIn("https://", output)
        self.assertNotIn("/cdn-cgi/", output)
        self.assertNotIn("private-token.js", output)


if __name__ == "__main__":
    unittest.main()
