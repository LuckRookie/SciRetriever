from __future__ import annotations

import unittest
from dataclasses import dataclass

import sciretriever.acquisition.sources.browser_rules as browser_rules
from sciretriever.acquisition.sources.browser_rules.catalog import (
    BROWSER_RULE_VERIFICATION_CATALOG,
    PRODUCTION_BROWSER_RULE_CATALOG,
)
from sciretriever.acquisition.sources.browser_rules.model import (
    BrowserActionKind,
    BrowserCaptureDisposition,
    BrowserPageMarkerKind,
    BrowserRuleCatalog,
    BrowserSiteRule,
)
from sciretriever.acquisition.sources.browser_rules.providers.acs import ACS_BROWSER_RULE
from sciretriever.acquisition.sources.browser_rules.providers.aip import AIP_BROWSER_RULE
from sciretriever.acquisition.sources.browser_rules.providers.elsevier import (
    ELSEVIER_BROWSER_RULE,
)
from sciretriever.acquisition.sources.browser_rules.providers.iop import (
    IOPSCIENCE_BROWSER_RULE,
)
from sciretriever.acquisition.sources.browser_rules.providers.oxford import (
    OXFORD_ACADEMIC_BROWSER_RULE,
)
from sciretriever.acquisition.sources.browser_rules.providers.rsc import RSC_BROWSER_RULE
from sciretriever.acquisition.sources.browser_rules.providers.science import (
    SCIENCE_BROWSER_RULE,
)
from sciretriever.acquisition.sources.browser_rules.providers.springer import (
    SPRINGERLINK_BROWSER_RULE,
)
from sciretriever.acquisition.sources.browser_rules.providers.wiley import WILEY_BROWSER_RULE
from sciretriever.model.access import BrowserCaptureKind
from sciretriever.model.literature import Identifier

_PROVIDER_RULE_EXPORTS = (
    ("ACS_BROWSER_RULE", ACS_BROWSER_RULE),
    ("AIP_BROWSER_RULE", AIP_BROWSER_RULE),
    ("ELSEVIER_BROWSER_RULE", ELSEVIER_BROWSER_RULE),
    ("IOPSCIENCE_BROWSER_RULE", IOPSCIENCE_BROWSER_RULE),
    ("OXFORD_ACADEMIC_BROWSER_RULE", OXFORD_ACADEMIC_BROWSER_RULE),
    ("RSC_BROWSER_RULE", RSC_BROWSER_RULE),
    ("SCIENCE_BROWSER_RULE", SCIENCE_BROWSER_RULE),
    ("SPRINGERLINK_BROWSER_RULE", SPRINGERLINK_BROWSER_RULE),
    ("WILEY_BROWSER_RULE", WILEY_BROWSER_RULE),
)

_VERIFICATION_RULES = tuple(rule for _, rule in _PROVIDER_RULE_EXPORTS)

_PRODUCTION_RULES = (
    ACS_BROWSER_RULE,
    AIP_BROWSER_RULE,
    ELSEVIER_BROWSER_RULE,
    IOPSCIENCE_BROWSER_RULE,
    OXFORD_ACADEMIC_BROWSER_RULE,
    RSC_BROWSER_RULE,
    SCIENCE_BROWSER_RULE,
    SPRINGERLINK_BROWSER_RULE,
    WILEY_BROWSER_RULE,
)


@dataclass(frozen=True, slots=True)
class _ProviderRuleCase:
    rule: BrowserSiteRule
    landing_url: str
    identifiers: tuple[Identifier, ...]
    primary_locator: str
    supplement_locator: str
    excluded_locator: str
    wrong_article_locator: str
    rejected_locator: str
    doi_pdf_locator: str | None


_PROVIDER_RULE_CASES = (
    _ProviderRuleCase(
        rule=ACS_BROWSER_RULE,
        landing_url="https://pubs.acs.org/doi/10.1021/acs.energy.6c00001",
        identifiers=(Identifier(namespace="doi", value="10.1021/acs.energy.6c00001"),),
        primary_locator="https://pubs.acs.org/doi/pdf/10.1021/acs.energy.6c00001",
        supplement_locator=("https://pubs.acs.org/doi/pdf/10.1021/acs.energy.6c00001-supp.pdf"),
        excluded_locator=("https://pubs.acs.org/doi/pdf/10.1021/acs.energy.6c00001-preview.pdf"),
        wrong_article_locator="https://pubs.acs.org/doi/pdf/10.1021/acs.energy.6c99999",
        rejected_locator="https://pubs.acs.org/doi/full/10.1021/acs.energy.6c00001",
        doi_pdf_locator="https://pubs.acs.org/doi/pdf/10.1021/acs.energy.6c00001",
    ),
    _ProviderRuleCase(
        rule=AIP_BROWSER_RULE,
        landing_url="https://pubs.aip.org/doi/10.1063/5.0123456",
        identifiers=(Identifier(namespace="doi", value="10.1063/5.0123456"),),
        primary_locator="https://pubs.aip.org/doi/epdf/10.1063/5.0123456",
        supplement_locator="https://pubs.aip.org/doi/epdf/10.1063/5.0123456-supp.pdf",
        excluded_locator="https://pubs.aip.org/doi/epdf/10.1063/5.0123456-preview.pdf",
        wrong_article_locator="https://pubs.aip.org/doi/epdf/10.1063/5.0999999",
        rejected_locator="https://pubs.aip.org/doi/full/10.1063/5.0123456",
        doi_pdf_locator="https://pubs.aip.org/doi/epdf/10.1063/5.0123456",
    ),
    _ProviderRuleCase(
        rule=ELSEVIER_BROWSER_RULE,
        landing_url=("https://www.sciencedirect.com/science/article/pii/S0013468626000012"),
        identifiers=(Identifier(namespace="pii", value="S0013468626000012"),),
        primary_locator=(
            "https://pdf.sciencedirectassets.com/271074/1-s2.0-S0013468626000012-main.pdf"
        ),
        supplement_locator=(
            "https://pdf.sciencedirectassets.com/271074/1-s2.0-S0013468626000012-mmc1.pdf"
        ),
        excluded_locator=(
            "https://pdf.sciencedirectassets.com/271074/1-s2.0-S0013468626000012-main-preview.pdf"
        ),
        wrong_article_locator=(
            "https://pdf.sciencedirectassets.com/271074/1-s2.0-S0013468626999999-main.pdf"
        ),
        rejected_locator=(
            "https://pdf.sciencedirectassets.com/271074/1-s2.0-S0013468626000012-document.pdf"
        ),
        doi_pdf_locator=None,
    ),
    _ProviderRuleCase(
        rule=IOPSCIENCE_BROWSER_RULE,
        landing_url="https://iopscience.iop.org/article/10.1088/2053-1591/ad1234",
        identifiers=(Identifier(namespace="doi", value="10.1088/2053-1591/ad1234"),),
        primary_locator="https://iopscience.iop.org/article/10.1088/2053-1591/ad1234/pdf",
        supplement_locator=(
            "https://iopscience.iop.org/article/10.1088/2053-1591/ad1234/supplement.pdf"
        ),
        excluded_locator=(
            "https://iopscience.iop.org/article/10.1088/2053-1591/ad1234/preview.pdf"
        ),
        wrong_article_locator=("https://iopscience.iop.org/article/10.1088/2053-1591/ad9999/pdf"),
        rejected_locator="https://iopscience.iop.org/journal/2053-1591/ad1234",
        doi_pdf_locator="https://iopscience.iop.org/article/10.1088/2053-1591/ad1234/pdf",
    ),
    _ProviderRuleCase(
        rule=OXFORD_ACADEMIC_BROWSER_RULE,
        landing_url="https://academic.oup.com/example/article/1/1/fixture/1234567",
        identifiers=(Identifier(namespace="doi", value="10.1093/oxford/fixture01"),),
        primary_locator="https://academic.oup.com/doi/pdf/10.1093/oxford/fixture01",
        supplement_locator=("https://academic.oup.com/doi/pdf/10.1093/oxford/fixture01-supp.pdf"),
        excluded_locator=("https://academic.oup.com/doi/pdf/10.1093/oxford/fixture01-preview.pdf"),
        wrong_article_locator="https://academic.oup.com/doi/pdf/10.1093/oxford/wrong01",
        rejected_locator="https://academic.oup.com/doi/full/10.1093/oxford/fixture01",
        doi_pdf_locator="https://academic.oup.com/doi/pdf/10.1093/oxford/fixture01",
    ),
    _ProviderRuleCase(
        rule=RSC_BROWSER_RULE,
        landing_url=("https://pubs.rsc.org/en/content/articlelanding/2026/ta/d6ta01234a"),
        identifiers=(),
        primary_locator=("https://pubs.rsc.org/en/content/articlepdf/2026/ta/d6ta01234a"),
        supplement_locator=(
            "https://pubs.rsc.org/en/content/articlepdf/2026/ta/d6ta01234a-supp.pdf"
        ),
        excluded_locator=(
            "https://pubs.rsc.org/en/content/articlepdf/2026/ta/d6ta01234a-preview.pdf"
        ),
        wrong_article_locator=("https://pubs.rsc.org/en/content/articlepdf/2026/ta/d6ta99999a"),
        rejected_locator=("https://pubs.rsc.org/en/content/articlehtml/2026/ta/d6ta01234a"),
        doi_pdf_locator=None,
    ),
    _ProviderRuleCase(
        rule=SCIENCE_BROWSER_RULE,
        landing_url="https://www.science.org/doi/10.1126/science.ad12345",
        identifiers=(Identifier(namespace="doi", value="10.1126/science.ad12345"),),
        primary_locator="https://www.science.org/doi/epdf/10.1126/science.ad12345",
        supplement_locator=("https://www.science.org/doi/epdf/10.1126/science.ad12345-supp.pdf"),
        excluded_locator=("https://www.science.org/doi/epdf/10.1126/science.ad12345-preview.pdf"),
        wrong_article_locator="https://www.science.org/doi/epdf/10.1126/science.zz99999",
        rejected_locator="https://www.science.org/doi/full/10.1126/science.ad12345",
        doi_pdf_locator="https://www.science.org/doi/epdf/10.1126/science.ad12345",
    ),
    _ProviderRuleCase(
        rule=SPRINGERLINK_BROWSER_RULE,
        landing_url=("https://link.springer.com/article/10.1007/s10853-026-12345-6"),
        identifiers=(Identifier(namespace="doi", value="10.1007/s10853-026-12345-6"),),
        primary_locator=("https://link.springer.com/content/pdf/10.1007/s10853-026-12345-6.pdf"),
        supplement_locator=(
            "https://static-content.springer.com/esm/article/"
            "s10853-026-12345-6/MediaObjects/supplement.pdf"
        ),
        excluded_locator="https://link.springer.com/content/pdf/book-cover/fixture.pdf",
        wrong_article_locator=(
            "https://link.springer.com/content/pdf/10.1007/s10853-026-99999-9.pdf"
        ),
        rejected_locator=("https://link.springer.com/article/10.1007/s10853-026-12345-6"),
        doi_pdf_locator=("https://link.springer.com/content/pdf/10.1007/s10853-026-12345-6.pdf"),
    ),
    _ProviderRuleCase(
        rule=WILEY_BROWSER_RULE,
        landing_url="https://onlinelibrary.wiley.com/doi/10.1002/aenm.202601234",
        identifiers=(Identifier(namespace="doi", value="10.1002/aenm.202601234"),),
        primary_locator=("https://onlinelibrary.wiley.com/doi/pdfdirect/10.1002/aenm.202601234"),
        supplement_locator=(
            "https://onlinelibrary.wiley.com/doi/pdfdirect/10.1002/aenm.202601234-supp.pdf"
        ),
        excluded_locator=(
            "https://onlinelibrary.wiley.com/doi/pdfdirect/10.1002/aenm.202601234-preview.pdf"
        ),
        wrong_article_locator=(
            "https://onlinelibrary.wiley.com/doi/pdfdirect/10.1002/aenm.202699999"
        ),
        rejected_locator=("https://onlinelibrary.wiley.com/doi/full/10.1002/aenm.202601234"),
        doi_pdf_locator=("https://onlinelibrary.wiley.com/doi/pdfdirect/10.1002/aenm.202601234"),
    ),
)


class BrowserRuleModuleTests(unittest.TestCase):
    def test_public_facade_reexports_each_provider_rule_instance(self) -> None:
        for export_name, rule in _PROVIDER_RULE_EXPORTS:
            with self.subTest(rule_id=rule.rule_id):
                exported = getattr(browser_rules, export_name)
                self.assertIs(exported, rule)

    def test_catalog_admission_remains_explicit(self) -> None:
        self.assertEqual(BROWSER_RULE_VERIFICATION_CATALOG.rules, _VERIFICATION_RULES)
        self.assertEqual(PRODUCTION_BROWSER_RULE_CATALOG.rules, _PRODUCTION_RULES)

    def test_reviewed_doi_landing_aliases_match_exactly_and_cannot_overlap(self) -> None:
        cases = (
            (
                "https://linkinghub.elsevier.com/retrieve/pii/S0013468626000012",
                ELSEVIER_BROWSER_RULE,
            ),
            (
                "https://advanced.onlinelibrary.wiley.com/doi/10.1002/aenm.202601234",
                WILEY_BROWSER_RULE,
            ),
        )
        for locator, expected in cases:
            with self.subTest(rule_id=expected.rule_id):
                self.assertIs(PRODUCTION_BROWSER_RULE_CATALOG.match_url(locator), expected)
                alias = locator.split("/", 3)[:3]
                self.assertIn("/".join(alias), expected.recognized_landing_origins)
                self.assertIsNone(
                    PRODUCTION_BROWSER_RULE_CATALOG.match_url(
                        locator.replace(".com/", ".com.evil.invalid/", 1)
                    )
                )

        conflicting = BrowserSiteRule(
            rule_id="conflicting-alias",
            revision=1,
            landing_origin="https://other-publisher.test",
            landing_origin_aliases=("https://linkinghub.elsevier.com",),
            allowed_origins=(
                "https://other-publisher.test",
                "https://linkinghub.elsevier.com",
            ),
            web_scope_provider_name="other-publisher",
        )
        with self.assertRaisesRegex(ValueError, "unique landing origins"):
            BrowserRuleCatalog((ELSEVIER_BROWSER_RULE, conflicting))

    def test_every_provider_rule_classifies_the_closed_document_matrix(self) -> None:
        expected_dispositions = (
            ("primary", BrowserCaptureDisposition.PRIMARY),
            ("supplement", BrowserCaptureDisposition.SUPPLEMENT),
            ("excluded", BrowserCaptureDisposition.EXCLUDED),
            ("wrong_article", BrowserCaptureDisposition.WRONG_ARTICLE),
            ("rejected", BrowserCaptureDisposition.REJECTED),
        )
        for case in _PROVIDER_RULE_CASES:
            with self.subTest(rule_id=case.rule.rule_id):
                for field_name, expected in expected_dispositions:
                    locator = getattr(case, f"{field_name}_locator")
                    self.assertEqual(
                        case.rule.classify_capture(
                            locator,
                            BrowserCaptureKind.RESPONSE,
                            "application/pdf",
                            landing_url=case.landing_url,
                            identifiers=case.identifiers,
                        ),
                        expected,
                        (case.rule.rule_id, field_name, locator),
                    )
                self.assertEqual(
                    case.rule.classify_capture(
                        case.primary_locator,
                        BrowserCaptureKind.RESPONSE,
                        "text/html",
                        landing_url=case.landing_url,
                        identifiers=case.identifiers,
                    ),
                    BrowserCaptureDisposition.REJECTED,
                )
                self.assertEqual(
                    case.rule.classify_capture(
                        "https://unreviewed.sciretriever.invalid/document.pdf",
                        BrowserCaptureKind.RESPONSE,
                        "application/pdf",
                        landing_url=case.landing_url,
                        identifiers=case.identifiers,
                    ),
                    BrowserCaptureDisposition.REJECTED,
                )

    def test_every_provider_rule_builds_reviewed_doi_locator_and_redacts_query(self) -> None:
        for case in _PROVIDER_RULE_CASES:
            with self.subTest(rule_id=case.rule.rule_id):
                self.assertEqual(
                    case.rule.doi_pdf_locator(case.identifiers),
                    case.doi_pdf_locator,
                )
                locator_with_query = f"{case.primary_locator}?download=1&view=full"
                self.assertEqual(
                    case.rule.safe_capture_locator(locator_with_query),
                    case.primary_locator,
                )
                self.assertTrue(case.rule.allows_url(case.primary_locator))
                self.assertFalse(
                    case.rule.allows_url(
                        f"https://{case.rule.landing_hostname}.evil.invalid/document.pdf"
                    )
                )

    def test_every_provider_rule_has_closed_actions_and_required_page_states(self) -> None:
        required_page_states = {
            BrowserPageMarkerKind.ENTITLED,
            BrowserPageMarkerKind.LOGIN_REQUIRED,
            BrowserPageMarkerKind.PAYWALL,
            BrowserPageMarkerKind.CHALLENGE_REQUIRED,
            BrowserPageMarkerKind.RATE_LIMITED,
            BrowserPageMarkerKind.ACCESS_DENIED,
            BrowserPageMarkerKind.NOT_FOUND,
        }
        for case in _PROVIDER_RULE_CASES:
            with self.subTest(rule_id=case.rule.rule_id):
                self.assertEqual(
                    tuple(action.kind for action in case.rule.actions),
                    (
                        BrowserActionKind.CLICK,
                        BrowserActionKind.WAIT_FOR_ANY_CAPTURE,
                    ),
                )
                self.assertLessEqual(len(case.rule.actions), case.rule.max_actions)
                self.assertIsNotNone(case.rule.actions[0].selector)
                self.assertIsNone(case.rule.actions[1].capture_kind)
                self.assertTrue(
                    required_page_states.issubset(
                        {marker.kind for marker in case.rule.page_markers}
                    )
                )
                status_403_markers = tuple(
                    marker for marker in case.rule.page_markers if 403 in marker.response_statuses
                )
                self.assertEqual(len(status_403_markers), 1)
                self.assertIs(
                    status_403_markers[0].kind,
                    BrowserPageMarkerKind.ACCESS_DENIED,
                )


if __name__ == "__main__":
    unittest.main()
