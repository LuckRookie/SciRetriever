from __future__ import annotations

import asyncio
import json
import unittest
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from email.utils import format_datetime
from pathlib import Path
from typing import Callable, cast
from unittest.mock import patch

import sciretriever.metadata.ports as metadata_ports
from sciretriever.metadata.api import MetadataApi
from sciretriever.metadata.ports import (
    MetadataProviderFailure,
    RawItemSession,
)
from sciretriever.metadata.providers._shared import (
    access_failure_to_provider_failure,
    header_value,
    interpreted_access_feedback,
    invalid_record_failure,
    monotonic_deadline_from_wall_time,
    optional_nonblank_string,
    optional_nonnegative_integer,
    parse_bounded_json,
    parse_bounded_xml,
    parse_retry_after,
    require_json_array,
    require_json_object,
    require_xml_root,
    retry_after_feedback,
    strict_nonnegative_integer,
    xml_children,
)
from sciretriever.metadata.rules import (
    MetadataLookupRequest,
    MetadataProviderResult,
    MetadataReferenceQueryRequest,
    NeutralMetadataItem,
    ProviderReferenceQuery,
    ReferenceQueryContext,
    TopicSearchQuery,
)
from sciretriever.metadata.service import MetadataService
from sciretriever.model.access import AccessFailure, Header, TransportResponse
from sciretriever.model.acquisition import AssetHint, AssetHintKind, AssetRole
from sciretriever.model.discovery import ProviderDiscoveryLimit, TopicDiscoveryInput
from sciretriever.model.literature import (
    Affiliation,
    Author,
    AuthorKind,
    Identifier,
    VersionRole,
)
from sciretriever.model.metadata import (
    LiteratureMetadata,
    MetadataObservation,
    ProviderLiteratureKey,
    ProviderRelationObservation,
)
from sciretriever.model.primitives import (
    ObservationId,
    ProvenanceId,
    Sha256,
    SourceKind,
    UtcTimestamp,
)
from sciretriever.model.provenance import Provenance
from sciretriever.network.admission import (
    AccessFeedback,
    AccessPolicy,
    AccessScope,
    AdmissionTimeout,
)
from sciretriever.network.http import HttpClient
from sciretriever.network.policy import Origin
from tests.metadata_provider_contract import (
    ContractBinding,
    ContractEnvironment,
    ContractExpectedResult,
    ContractPorts,
    ContractScenario,
    CredentialMode,
    ExpectedAffiliation,
    ExpectedAuthor,
    ProviderContractCase,
)

_FIXTURES = Path(__file__).parent / "fixtures" / "metadata" / "common"
_TIME = UtcTimestamp("2026-08-11T12:00:00Z")
_HASH = Sha256("a" * 64)


def _uuid(index: int) -> str:
    return f"{index:08x}-0000-4000-8000-000000000000"


def _key(namespace: str, value: str) -> ProviderLiteratureKey:
    return ProviderLiteratureKey(identifiers=(Identifier(namespace=namespace, value=value),))


def _provenance(index: int, *, record_id: str = "provider-record-1") -> Provenance:
    return Provenance(
        provenance_id=ProvenanceId(_uuid(index + 1000)),
        source_kind=SourceKind.METADATA_PROVIDER,
        source_name="contract-subject",
        source_record_id=record_id,
        observed_at=_TIME,
        input_sha256=_HASH,
        parameters_sha256=None,
    )


def _observation(
    index: int,
    *,
    title: str = "Contract record",
    record_id: str | None = None,
) -> MetadataObservation:
    return MetadataObservation(
        observation_id=ObservationId(_uuid(index)),
        provenance=_provenance(index, record_id=record_id or f"record-{index}"),
        metadata=LiteratureMetadata(title=title),
    )


@dataclass(frozen=True, slots=True)
class _RawRecord:
    index: int


class _TopicPort:
    provider_name = "contract-subject"

    def __init__(self, factory: Callable[[], RawItemSession]) -> None:
        self._factory = factory

    def open_topic_search(self, query: TopicSearchQuery) -> RawItemSession:
        del query
        return self._factory()


class _ReferencePort:
    provider_name = "contract-subject"

    def __init__(
        self,
        factory: Callable[[ReferenceQueryContext], RawItemSession],
    ) -> None:
        self._factory = factory

    def open_reference_query(self, query: ReferenceQueryContext) -> RawItemSession:
        return self._factory(query)


class _LookupPort:
    provider_name = "contract-subject"

    def __init__(
        self,
        factory: Callable[[ProviderLiteratureKey], RawItemSession],
    ) -> None:
        self._factory = factory

    def open_lookup(self, key: ProviderLiteratureKey) -> RawItemSession:
        return self._factory(key)


def _session(
    pages: dict[str | None, metadata_ports._RawPage[_RawRecord, str]],
    converter: Callable[[_RawRecord], NeutralMetadataItem],
    *,
    fetched: list[str | None] | None = None,
) -> RawItemSession:
    def fetch(cursor: str | None) -> metadata_ports._RawPage[_RawRecord, str]:
        if fetched is not None:
            fetched.append(cursor)
        return pages[cursor]

    return metadata_ports._PagedRawItemSession(fetch, converter)


def _topic_request(scan_limit: int) -> TopicDiscoveryInput:
    return TopicDiscoveryInput(
        kind="topic",
        query="contract query",
        providers=(
            ProviderDiscoveryLimit(
                provider_name="contract-subject",
                scan_limit=scan_limit,
            ),
        ),
    )


_CONTRACT_SCOPE = AccessScope(
    provider_name="contract-subject",
    channel="api",
    service_name="metadata",
)
_CONTRACT_ORIGIN = Origin("https", "api.contract.invalid", 443)


@dataclass(frozen=True, slots=True)
class _NetworkRawRecord:
    index: int
    capability: str
    payload: dict[str, object] = field(repr=False)


class _NetworkContractAdapter:
    """Test-only adapter proving the reusable contract reaches real Network I/O."""

    provider_name = "contract-subject"

    def __init__(
        self,
        *,
        http_client: HttpClient,
        access_scope: AccessScope,
        access_policy: AccessPolicy,
        wall_clock: Callable[[], datetime],
        credential_mode: CredentialMode,
        credential: str,
    ) -> None:
        self._http_client = http_client
        self._access_scope = access_scope
        self._access_policy = access_policy
        self._wall_clock = wall_clock
        self._credential_mode = credential_mode
        self._credential = credential

    def open_topic_search(self, query: TopicSearchQuery) -> RawItemSession:
        return self._open_session(
            "search",
            f"https://api.contract.invalid/topic?query={query.query.replace(' ', '+')}",
        )

    def open_lookup(self, key: ProviderLiteratureKey) -> RawItemSession:
        del key
        return self._open_session(
            "lookup",
            "https://api.contract.invalid/lookup?value=contract",
        )

    def open_reference_query(self, query: ReferenceQueryContext) -> RawItemSession:
        return self._open_session(
            "references",
            f"https://api.contract.invalid/references?direction={query.direction}",
        )

    def _open_session(self, capability: str, url: str) -> RawItemSession:
        def fetch(cursor: str | None) -> metadata_ports._RawPage[_NetworkRawRecord, str]:
            return self._fetch_page(capability, url, cursor)

        return metadata_ports._PagedRawItemSession(fetch, self._convert_record)

    def _credential_request_parts(
        self,
    ) -> tuple[
        tuple[tuple[str, str], ...],
        tuple[tuple[str, str], ...],
        tuple[Origin, ...],
    ]:
        if not self._credential or self._credential_mode == "none":
            return (), (), ()
        allowed_origins = (_CONTRACT_ORIGIN,)
        if self._credential_mode == "header":
            return (("Authorization", self._credential),), (), allowed_origins
        return (), (("api_key", self._credential),), allowed_origins

    def _response_feedback(self, response: TransportResponse) -> AccessFeedback | None:
        if response.status != 429:
            return None
        return retry_after_feedback(
            response.status,
            response.headers,
            wall_now=self._wall_clock(),
        )

    def _fetch_page(
        self,
        capability: str,
        url: str,
        cursor: str | None,
    ) -> metadata_ports._RawPage[_NetworkRawRecord, str]:
        if cursor is not None:
            url = f"{url}&cursor={cursor}"
        credential_headers, credential_query, allowed_origins = self._credential_request_parts()
        response = self._http_client.request(
            self._access_scope,
            url,
            self._access_policy,
            credential_headers=credential_headers,
            credential_query=credential_query,
            credential_allowed_origins=allowed_origins,
            response_feedback=self._response_feedback,
        )
        if isinstance(response, AccessFailure):
            raise access_failure_to_provider_failure(response)
        if response.status == 429:
            raise access_failure_to_provider_failure(
                AccessFailure(
                    code="throttled",
                    reason="The remote request failed.",
                    action="Retry later.",
                    retryable=True,
                )
            )
        if response.status != 200:
            raise access_failure_to_provider_failure(
                AccessFailure(
                    code="status",
                    reason="The remote request failed.",
                    action="Retry if appropriate.",
                    retryable=response.status >= 500,
                )
            )
        document = require_json_object(parse_bounded_json(response.body, max_bytes=16 * 1024))
        items = require_json_array(document.get("items"))
        records: list[_NetworkRawRecord] = []
        for raw in items:
            item = require_json_object(raw)
            index = strict_nonnegative_integer(item.get("index"))
            records.append(
                _NetworkRawRecord(
                    index=index,
                    capability=capability,
                    payload=item,
                )
            )
        next_cursor = optional_nonblank_string(document.get("next_cursor"))
        return metadata_ports._RawPage(
            items=tuple(records),
            next_cursor=next_cursor,
            exhausted=next_cursor is None,
        )

    def _convert_record(self, raw: _NetworkRawRecord) -> NeutralMetadataItem:
        if raw.capability == "references":
            citing = optional_nonblank_string(raw.payload.get("citing"))
            cited = optional_nonblank_string(raw.payload.get("cited"))
            if citing is None or cited is None:
                raise invalid_record_failure()
            relation = ProviderRelationObservation(
                observation_id=ObservationId(_uuid(raw.index + 200)),
                provenance=_provenance(
                    raw.index + 200,
                    record_id=f"relation-{raw.index}",
                ),
                citing=_key("doi", citing),
                cited=_key("doi", cited),
            )
            return NeutralMetadataItem(relations=(relation,))

        record_id = optional_nonblank_string(raw.payload.get("record_id"))
        title = optional_nonblank_string(raw.payload.get("title"))
        doi = optional_nonblank_string(raw.payload.get("doi"))
        version = optional_nonblank_string(raw.payload.get("version"))
        if None in (record_id, title, doi, version):
            raise invalid_record_failure()
        assert record_id is not None
        assert title is not None
        assert doi is not None
        assert version is not None

        authors: list[Author] = []
        for value in require_json_array(raw.payload.get("authors")):
            author = require_json_object(value)
            kind = optional_nonblank_string(author.get("kind"))
            display_name = optional_nonblank_string(author.get("display_name"))
            if kind is None or display_name is None:
                raise invalid_record_failure()
            affiliations: list[Affiliation] = []
            for affiliation_value in require_json_array(author.get("affiliations", [])):
                affiliation = require_json_object(affiliation_value)
                name = optional_nonblank_string(affiliation.get("name"))
                if name is None:
                    raise invalid_record_failure()
                affiliations.append(
                    Affiliation(
                        name=name,
                        ror=optional_nonblank_string(affiliation.get("ror")),
                    )
                )
            authors.append(
                Author(
                    kind=AuthorKind(kind),
                    display_name=display_name,
                    given_name=optional_nonblank_string(author.get("given_name")),
                    family_name=optional_nonblank_string(author.get("family_name")),
                    orcid=optional_nonblank_string(author.get("orcid")),
                    affiliations=tuple(affiliations),
                )
            )

        hints: list[AssetHint] = []
        for value in require_json_array(raw.payload.get("assets")):
            asset = require_json_object(value)
            asset_url = optional_nonblank_string(asset.get("url"))
            asset_kind = optional_nonblank_string(asset.get("kind"))
            if asset_url is None or asset_kind is None:
                raise invalid_record_failure()
            asset_role = optional_nonblank_string(asset.get("asset_role"))
            version_role = optional_nonblank_string(asset.get("version_role"))
            hints.append(
                AssetHint(
                    url=asset_url,
                    kind=AssetHintKind(asset_kind),
                    media_type=optional_nonblank_string(asset.get("media_type")),
                    asset_role=AssetRole(asset_role) if asset_role is not None else None,
                    version_role=VersionRole(version_role) if version_role is not None else None,
                )
            )
        observation = MetadataObservation(
            observation_id=ObservationId(_uuid(raw.index)),
            provenance=_provenance(raw.index, record_id=record_id),
            metadata=LiteratureMetadata(
                title=title,
                authors=tuple(authors),
                identifiers=(Identifier(namespace="doi", value=doi),),
            ),
            version_links=(_key("arxiv", version),),
            asset_hints=tuple(hints),
        )
        return NeutralMetadataItem(observations=(observation,))


def _rich_contract_body(*, next_cursor: str | None = None) -> bytes:
    document: dict[str, object] = {
        "items": [
            {
                "index": 90,
                "record_id": "provider-record-90",
                "title": "Network contract semantics",
                "doi": "https://doi.org/10.1000/CONTRACT",
                "version": "arXiv:2501.01234v2",
                "authors": [
                    {
                        "kind": "person",
                        "display_name": "Ada Lovelace",
                        "given_name": "Ada",
                        "family_name": "Lovelace",
                        "orcid": "0000-0002-1825-0097",
                        "affiliations": [
                            {
                                "name": "Analytical Engine Institute",
                                "ror": "03yrm5c26",
                            }
                        ],
                    },
                    {
                        "kind": "organization",
                        "display_name": "Contract Research Consortium",
                        "affiliations": [],
                    },
                ],
                "assets": [
                    {
                        "url": "https://assets.contract.invalid/article.pdf",
                        "kind": "direct-file",
                        "media_type": "application/pdf",
                        "asset_role": "primary-pdf",
                        "version_role": "published",
                    },
                    {
                        "url": "https://landing.contract.invalid/article",
                        "kind": "landing-page",
                        "media_type": "text/html",
                    },
                ],
                "ignored_vendor_field": "adapter-whitelist-must-ignore-this-key",
            }
        ]
    }
    if next_cursor is not None:
        document["next_cursor"] = next_cursor
    return json.dumps(
        document,
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode("utf-8")


def _relation_contract_body() -> bytes:
    return json.dumps(
        {
            "items": [
                {
                    "index": 91,
                    "citing": "10.1000/citing",
                    "cited": "10.1000/anchor",
                }
            ]
        },
        separators=(",", ":"),
    ).encode("utf-8")


def _expected_contract_hints() -> tuple[AssetHint, ...]:
    return (
        AssetHint(
            url="https://assets.contract.invalid/article.pdf",
            kind=AssetHintKind.DIRECT_FILE,
            media_type="application/pdf",
            asset_role=AssetRole.PRIMARY_PDF,
            version_role=VersionRole.PUBLISHED,
        ),
        AssetHint(
            url="https://landing.contract.invalid/article",
            kind=AssetHintKind.LANDING_PAGE,
            media_type="text/html",
        ),
    )


def _rich_contract_evidence(
    contract: ProviderContractCase,
    environment: ContractEnvironment,
    result: MetadataProviderResult,
) -> None:
    observation = result.observations[0]
    contract.assert_author_mapping(
        observation.metadata.authors,
        (
            ExpectedAuthor(
                kind="person",
                display_name="Ada Lovelace",
                given_name="Ada",
                family_name="Lovelace",
                orcid="0000-0002-1825-0097",
                affiliations=(
                    ExpectedAffiliation(
                        name="Analytical Engine Institute",
                        ror="03yrm5c26",
                    ),
                ),
            ),
            ExpectedAuthor(
                kind="organization",
                display_name="Contract Research Consortium",
            ),
        ),
    )
    contract.assert_identifier_record_id_separation(
        observation,
        expected_identifiers=(Identifier(namespace="doi", value="10.1000/contract"),),
        expected_record_id="provider-record-90",
        forbidden_record_ids=("provider-record-90",),
    )
    contract.assert_version_links(
        observation,
        (_key("arxiv", "arXiv:2501.01234v2"),),
    )
    contract.assert_asset_hints(
        observation,
        _expected_contract_hints(),
        runtime_secret=environment.secret_sentinel,
    )
    contract.assert_no_private_payload(
        result,
        runtime_secret=environment.secret_sentinel,
        forbidden_values=("adapter-whitelist-must-ignore-this-key",),
    )


def _relation_contract_evidence(
    contract: ProviderContractCase,
    _environment: ContractEnvironment,
    result: MetadataProviderResult,
) -> None:
    contract.assert_citing_to_cited(
        result.relations[0],
        citing=_key("doi", "10.1000/citing"),
        cited=_key("doi", "10.1000/anchor"),
    )


def _prepare_rich_contract_response(environment: ContractEnvironment) -> None:
    environment.queue_http_response(status=200, body=_rich_contract_body())


def _prepare_relation_contract_response(environment: ContractEnvironment) -> None:
    environment.queue_http_response(status=200, body=_relation_contract_body())


def _prepare_feedback_contract_response(environment: ContractEnvironment) -> None:
    environment.queue_http_response(
        status=200,
        body=_rich_contract_body(next_cursor="contract-next-page"),
    )
    environment.queue_http_response(
        status=429,
        headers=(Header(name="Retry-After", value="3"),),
    )


def _prepare_redirect_contract_response(
    environment: ContractEnvironment,
    *,
    hostname: str,
) -> None:
    environment.queue_http_response(
        status=302,
        headers=(
            Header(
                name="Location",
                value=f"https://{hostname}/redirected",
            ),
        ),
    )
    environment.queue_http_response(status=200, body=_rich_contract_body())


def _network_contract_ports(
    environment: ContractEnvironment,
    credential_mode: CredentialMode,
) -> ContractPorts:
    adapter = _NetworkContractAdapter(
        http_client=environment.http_client,
        access_scope=environment.scope,
        access_policy=environment.policy,
        wall_clock=environment.wall_clock,
        credential_mode=credential_mode,
        credential=environment.secret_sentinel,
    )
    return ContractPorts(
        topic_search=adapter,
        lookup=adapter,
        reference_query=adapter,
    )


def _network_contract_binding(credential_mode: CredentialMode) -> ContractBinding:
    anchor = _key("doi", "10.1000/anchor")
    scenarios: list[ContractScenario] = [
        ContractScenario(
            name="search-rich-neutral-output",
            capability="search",
            request=_topic_request(3),
            prepare=_prepare_rich_contract_response,
            expected=ContractExpectedResult(
                outcome="EXHAUSTED",
                raw_item_count=1,
                observation_count=1,
                relation_count=0,
            ),
            evidence=_rich_contract_evidence,
        ),
        ContractScenario(
            name="lookup-through-metadata-api",
            capability="lookup",
            request=MetadataLookupRequest(
                provider_name="contract-subject",
                key=_key("doi", "10.1000/contract"),
                scan_limit=3,
            ),
            prepare=_prepare_rich_contract_response,
            expected=ContractExpectedResult(
                outcome="EXHAUSTED",
                raw_item_count=1,
                observation_count=1,
                relation_count=0,
            ),
            evidence=_rich_contract_evidence,
        ),
        ContractScenario(
            name="reference-citing-to-cited",
            capability="references",
            request=MetadataReferenceQueryRequest(
                direction="cited-by",
                providers=(
                    ProviderReferenceQuery(
                        provider_name="contract-subject",
                        keys=(anchor,),
                        scan_limit=3,
                    ),
                ),
            ),
            prepare=_prepare_relation_contract_response,
            expected=ContractExpectedResult(
                outcome="EXHAUSTED",
                raw_item_count=1,
                observation_count=0,
                relation_count=1,
            ),
            evidence=_relation_contract_evidence,
        ),
        ContractScenario(
            name="retry-after-reaches-coordinator",
            capability="search",
            request=_topic_request(3),
            prepare=_prepare_feedback_contract_response,
            expected=ContractExpectedResult(
                outcome="FAILED",
                raw_item_count=1,
                observation_count=1,
                relation_count=0,
                failure_code="metadata-provider-access",
            ),
            evidence=_rich_contract_evidence,
            expects_feedback=True,
        ),
    ]
    if credential_mode != "none":
        scenarios.extend(
            (
                ContractScenario(
                    name="credential-same-origin-redirect",
                    capability="search",
                    request=_topic_request(3),
                    prepare=lambda environment: _prepare_redirect_contract_response(
                        environment,
                        hostname="api.contract.invalid",
                    ),
                    expected=ContractExpectedResult(
                        outcome="EXHAUSTED",
                        raw_item_count=1,
                        observation_count=1,
                        relation_count=0,
                    ),
                    evidence=_rich_contract_evidence,
                    credential_redirect="same-origin",
                ),
                ContractScenario(
                    name="credential-cross-origin-redirect",
                    capability="search",
                    request=_topic_request(3),
                    prepare=lambda environment: _prepare_redirect_contract_response(
                        environment,
                        hostname="other.contract.invalid",
                    ),
                    expected=ContractExpectedResult(
                        outcome="EXHAUSTED",
                        raw_item_count=1,
                        observation_count=1,
                        relation_count=0,
                    ),
                    evidence=_rich_contract_evidence,
                    credential_redirect="cross-origin",
                ),
            )
        )
    return ContractBinding(
        provider_name="contract-subject",
        capabilities=frozenset({"search", "lookup", "references"}),
        expected_scope=_CONTRACT_SCOPE,
        credential_mode=credential_mode,
        port_factory=lambda environment: _network_contract_ports(
            environment,
            credential_mode,
        ),
        scenarios=tuple(scenarios),
    )


class SharedParsingTests(unittest.TestCase):
    def test_bounded_json_guards_shape_and_preserves_item_order(self) -> None:
        document = parse_bounded_json(
            (_FIXTURES / "ordered.json").read_bytes(),
            max_bytes=1024,
        )
        root = require_json_object(document)
        self.assertEqual(tuple(root), ("items", "unknown"))

        items = require_json_array(root["items"])
        self.assertEqual(
            tuple(optional_nonblank_string(require_json_object(item)["title"]) for item in items),
            ("First record", "Second record"),
        )
        self.assertEqual(
            tuple(strict_nonnegative_integer(require_json_object(item)["count"]) for item in items),
            (0, 2),
        )

    def test_json_malformed_wrong_shape_and_oversize_are_fixed_failures(self) -> None:
        cases: tuple[tuple[str, Callable[[], object], str], ...] = (
            (
                "malformed",
                lambda: parse_bounded_json(
                    (_FIXTURES / "malformed.json").read_bytes(),
                    max_bytes=1024,
                ),
                "metadata-provider-malformed-json",
            ),
            (
                "wrong-shape",
                lambda: require_json_object(
                    parse_bounded_json(
                        (_FIXTURES / "wrong-shape.json").read_bytes(),
                        max_bytes=1024,
                    )
                ),
                "metadata-provider-unknown-shape",
            ),
            (
                "oversize",
                lambda: parse_bounded_json(b'{"value":"0123456789"}', max_bytes=8),
                "metadata-provider-response-too-large",
            ),
        )
        for name, action, expected_code in cases:
            with self.subTest(name=name):
                with self.assertRaises(MetadataProviderFailure) as raised:
                    action()
                self.assertEqual(raised.exception.failure.code, expected_code)
                serialized = raised.exception.failure.model_dump_json()
                self.assertNotIn("0123456789", serialized)
                self.assertNotIn("truncated", serialized)

    def test_bounded_xml_rejects_truncation_dtd_and_wrong_root(self) -> None:
        root = parse_bounded_xml(
            (_FIXTURES / "ordered.xml").read_bytes(),
            max_bytes=1024,
        )
        require_xml_root(root, "{urn:sciretriever:contract}feed")
        records = xml_children(root, "{urn:sciretriever:contract}record")
        self.assertEqual(tuple(record.attrib["id"] for record in records), ("first", "second"))

        cases = (
            ("truncated.xml", "metadata-provider-malformed-xml"),
            ("doctype.xml", "metadata-provider-unsafe-xml"),
        )
        for fixture_name, expected_code in cases:
            with self.subTest(fixture=fixture_name):
                with self.assertRaises(MetadataProviderFailure) as raised:
                    parse_bounded_xml(
                        (_FIXTURES / fixture_name).read_bytes(),
                        max_bytes=1024,
                    )
                self.assertEqual(raised.exception.failure.code, expected_code)
                self.assertNotIn("entity-expansion", raised.exception.failure.model_dump_json())

        wrong = parse_bounded_xml(
            (_FIXTURES / "wrong-root.xml").read_bytes(),
            max_bytes=1024,
        )
        with self.assertRaises(MetadataProviderFailure) as raised:
            require_xml_root(wrong, "{urn:sciretriever:contract}feed")
        self.assertEqual(raised.exception.failure.code, "metadata-provider-unknown-shape")

    def test_optional_string_and_optional_count_are_conservative_and_strict(self) -> None:
        self.assertEqual(optional_nonblank_string("  Ångström  "), "Ångström")
        self.assertIsNone(optional_nonblank_string(None))
        self.assertIsNone(optional_nonblank_string(" \n "))
        self.assertIsNone(optional_nonnegative_integer(None))
        self.assertEqual(optional_nonnegative_integer(0), 0)

        for value in (True, -1, 1.0, "1"):
            with self.subTest(value=value):
                with self.assertRaises(MetadataProviderFailure) as raised:
                    strict_nonnegative_integer(value)
                self.assertEqual(
                    raised.exception.failure.code,
                    "metadata-provider-invalid-record",
                )

        with self.assertRaises(MetadataProviderFailure):
            optional_nonblank_string(42)

    def test_parsers_do_not_catch_programming_errors_or_cancellation(self) -> None:
        with patch(
            "sciretriever.metadata.providers._shared.parsing.json.loads",
            side_effect=RuntimeError("programming defect"),
        ):
            with self.assertRaisesRegex(RuntimeError, "programming defect"):
                parse_bounded_json(b"{}", max_bytes=8)

        with patch(
            "sciretriever.metadata.providers._shared.parsing.ElementTree.fromstring",
            side_effect=asyncio.CancelledError(),
        ):
            with self.assertRaises(asyncio.CancelledError):
                parse_bounded_xml(b"<root />", max_bytes=16)


class SharedFeedbackAndFailureTests(unittest.TestCase):
    def test_header_lookup_is_case_insensitive_and_rejects_conflicting_duplicates(
        self,
    ) -> None:
        headers = (
            Header(name="X-Quota", value=" 12 "),
            Header(name="x-quota", value="12"),
        )
        self.assertEqual(header_value(headers, "X-QUOTA"), "12")
        self.assertIsNone(header_value(headers, "missing"))

        with self.assertRaises(MetadataProviderFailure) as raised:
            header_value(
                (
                    Header(name="X-Quota", value="12"),
                    Header(name="x-quota", value="13"),
                ),
                "x-quota",
            )
        self.assertEqual(
            raised.exception.failure.code,
            "metadata-provider-conflicting-header",
        )
        self.assertNotIn("12", raised.exception.failure.model_dump_json())
        self.assertNotIn("13", raised.exception.failure.model_dump_json())

    def test_retry_after_delta_and_http_date_use_explicit_clock_domains(self) -> None:
        wall_now = datetime(2026, 8, 11, 4, 0, tzinfo=timezone.utc)
        self.assertEqual(parse_retry_after("120", wall_now=wall_now), 120.0)

        future = wall_now + timedelta(seconds=75)
        self.assertEqual(
            parse_retry_after(format_datetime(future, usegmt=True), wall_now=wall_now),
            75.0,
        )
        self.assertEqual(
            parse_retry_after(
                format_datetime(wall_now - timedelta(seconds=5), usegmt=True),
                wall_now=wall_now,
            ),
            0.0,
        )
        self.assertIsNone(parse_retry_after("not-a-delay-or-date", wall_now=wall_now))
        huge = "9" * 5000
        self.assertIsNone(parse_retry_after(huge, wall_now=wall_now))
        huge_feedback = retry_after_feedback(
            429,
            (Header(name="Retry-After", value=huge),),
            wall_now=wall_now,
        )
        self.assertIsNotNone(huge_feedback)
        assert huge_feedback is not None
        self.assertTrue(huge_feedback.throttled)
        self.assertIsNone(huge_feedback.retry_after)
        self.assertEqual(
            monotonic_deadline_from_wall_time(
                future,
                wall_now=wall_now,
                monotonic_now=400.0,
            ),
            475.0,
        )

    def test_interpreted_quota_values_become_monotonic_access_feedback(self) -> None:
        feedback = interpreted_access_feedback(
            monotonic_now=500.0,
            retry_after_seconds=3,
            blocked_for_seconds=10,
            quota_reset_after_seconds=60,
            throttled=True,
        )
        self.assertEqual(feedback.retry_after, 3.0)
        self.assertEqual(feedback.blocked_until, 510.0)
        self.assertEqual(feedback.quota_reset_at, 560.0)
        self.assertTrue(feedback.throttled)
        self.assertLess(feedback.quota_reset_at or 0.0, 10_000.0)

        environment = ContractEnvironment(
            provider_name="contract-subject",
            capabilities=frozenset(),
            port_factory=lambda _environment: ContractPorts(),
        )
        permit = environment.coordinator.acquire_scope(
            environment.scope,
            environment.policy,
        )
        permit.release(
            interpreted_access_feedback(
                monotonic_now=environment.monotonic_clock(),
                quota_reset_after_seconds=60,
                throttled=True,
            )
        )
        self.assertEqual(
            tuple(scope for scope, _feedback in environment.coordinator.feedback_records),
            (environment.scope,),
        )
        with self.assertRaises(AdmissionTimeout):
            environment.coordinator.acquire_scope(
                environment.scope,
                timeout=0.01,
            )
        environment.monotonic_clock.advance(60)
        resumed = environment.coordinator.acquire_scope(
            environment.scope,
            timeout=0.01,
        )
        resumed.release()
        environment.close()

        for invalid in (True, -1, float("inf"), "10"):
            with self.subTest(invalid=invalid):
                with self.assertRaises((TypeError, ValueError)):
                    interpreted_access_feedback(
                        monotonic_now=500.0,
                        quota_reset_after_seconds=invalid,
                    )

    def test_malformed_or_conflicting_429_feedback_is_conservatively_throttled(self) -> None:
        wall_now = datetime(2026, 8, 11, 4, 0, tzinfo=timezone.utc)
        malformed = retry_after_feedback(
            429,
            (Header(name="Retry-After", value="not-valid"),),
            wall_now=wall_now,
        )
        assert malformed is not None
        self.assertTrue(malformed.throttled)
        self.assertIsNone(malformed.retry_after)

        conflict = retry_after_feedback(
            429,
            (
                Header(name="Retry-After", value="10"),
                Header(name="retry-after", value="20"),
            ),
            wall_now=wall_now,
        )
        assert conflict is not None
        self.assertTrue(conflict.throttled)
        self.assertIsNone(conflict.retry_after)

        valid = retry_after_feedback(
            429,
            (Header(name="retry-after", value="10"),),
            wall_now=wall_now,
        )
        assert valid is not None
        self.assertTrue(valid.throttled)
        self.assertEqual(valid.retry_after, 10.0)

        for name, feedback in (("malformed", malformed), ("conflict", conflict)):
            with self.subTest(name=name):
                environment = ContractEnvironment(
                    provider_name="contract-subject",
                    capabilities=frozenset(),
                    port_factory=lambda _environment: ContractPorts(),
                )
                permit = environment.coordinator.acquire_scope(
                    environment.scope,
                    environment.policy,
                )
                permit.release(feedback)
                self.assertEqual(
                    tuple(scope for scope, _feedback in environment.coordinator.feedback_records),
                    (environment.scope,),
                )
                with self.assertRaises(AdmissionTimeout):
                    environment.coordinator.acquire_scope(
                        environment.scope,
                        timeout=0.01,
                    )
                environment.monotonic_clock.advance(environment.policy.backoff_seconds)
                resumed = environment.coordinator.acquire_scope(
                    environment.scope,
                    timeout=0.01,
                )
                resumed.release()
                environment.close()

    def test_access_failure_mapping_is_fixed_and_does_not_retain_private_details(self) -> None:
        access = AccessFailure(
            code="upstream-specific-code",
            reason="The remote request failed.",
            action="Retry the request.",
            retryable=True,
        )
        converted = access_failure_to_provider_failure(access)
        self.assertEqual(converted.failure.code, "metadata-provider-access")
        self.assertTrue(converted.failure.retryable)
        serialized = converted.failure.model_dump_json()
        self.assertNotIn("upstream-specific-code", serialized)
        self.assertNotIn("remote request", serialized.lower())

        oversize = access_failure_to_provider_failure(
            AccessFailure(
                code="oversize",
                reason="private response detail",
                action="private endpoint action",
                retryable=False,
            )
        )
        self.assertEqual(
            oversize.failure.code,
            "metadata-provider-response-too-large",
        )
        oversize_serialized = oversize.failure.model_dump_json()
        self.assertNotIn("private response detail", oversize_serialized)
        self.assertNotIn("private endpoint action", oversize_serialized)

        invalid = invalid_record_failure()
        self.assertEqual(invalid.failure.code, "metadata-provider-invalid-record")
        self.assertEqual(str(invalid), "metadata provider call failed")


class ProviderContractDiscoveryTests(unittest.TestCase):
    def test_bare_subclass_is_discovered_and_fails_for_missing_binding(self) -> None:
        class BrokenProviderContract(ProviderContractCase, unittest.TestCase):
            pass

        suite = unittest.defaultTestLoader.loadTestsFromTestCase(BrokenProviderContract)
        self.assertGreater(suite.countTestCases(), 0)
        result = unittest.TestResult()
        suite.run(result)
        self.assertTrue(result.failures)
        self.assertFalse(result.skipped)

    def test_none_and_query_credential_bindings_pass_the_fixed_gate(self) -> None:
        for credential_mode in ("none", "query"):
            with self.subTest(credential_mode=credential_mode):
                binding = _network_contract_binding(credential_mode)

                class BoundProviderContract(ProviderContractCase, unittest.TestCase):
                    def provider_contract_binding(self) -> ContractBinding:
                        return binding

                suite = unittest.defaultTestLoader.loadTestsFromTestCase(BoundProviderContract)
                result = unittest.TestResult()
                suite.run(result)
                details = "\n".join(
                    traceback for _test, traceback in (*result.failures, *result.errors)
                )
                self.assertTrue(result.wasSuccessful(), details)
                self.assertFalse(result.skipped)

    def test_network_adapter_passes_only_the_fixed_credential_origin(self) -> None:
        expected_origins: tuple[tuple[CredentialMode, tuple[Origin, ...]], ...] = (
            ("none", ()),
            ("header", (_CONTRACT_ORIGIN,)),
            ("query", (_CONTRACT_ORIGIN,)),
        )
        for credential_mode, expected in expected_origins:
            with self.subTest(credential_mode=credential_mode):
                binding = _network_contract_binding(credential_mode)
                with ContractEnvironment(
                    provider_name=binding.provider_name,
                    capabilities=binding.capabilities,
                    port_factory=binding.port_factory,
                    expected_scope=binding.expected_scope,
                ) as environment:
                    adapter = environment.ports.topic_search
                    self.assertIsInstance(adapter, _NetworkContractAdapter)
                    adapter = cast(_NetworkContractAdapter, adapter)
                    environment.queue_http_response(status=200, body=_rich_contract_body())
                    with patch.object(
                        environment.http_client,
                        "request",
                        wraps=environment.http_client.request,
                    ) as request:
                        page = adapter._fetch_page(
                            "search",
                            "https://api.contract.invalid/topic?query=contract",
                            None,
                        )
                    self.assertEqual(len(page.items), 1)
                    self.assertEqual(
                        request.call_args.kwargs["credential_allowed_origins"],
                        expected,
                    )


class ProviderContractHarnessTests(ProviderContractCase, unittest.TestCase):
    def provider_contract_binding(self) -> ContractBinding:
        return _network_contract_binding("header")

    def test_environment_assembles_only_declared_capabilities(self) -> None:
        port = _TopicPort(
            lambda: _session(
                {
                    None: metadata_ports._RawPage(
                        items=(),
                        next_cursor=None,
                        exhausted=True,
                    )
                },
                lambda _raw: NeutralMetadataItem(),
            )
        )
        environment = ContractEnvironment(
            provider_name="contract-subject",
            capabilities=frozenset({"search"}),
            port_factory=lambda _environment: ContractPorts(topic_search=port),
        )
        self.assertTrue(environment.has_capability("search"))
        self.assertFalse(environment.has_capability("lookup"))
        self.assertIsInstance(environment.api, MetadataApi)

        with self.assertRaises(ValueError):
            ContractEnvironment(
                provider_name="contract-subject",
                capabilities=frozenset({"lookup"}),
                port_factory=lambda _environment: ContractPorts(topic_search=port),
            )

    def test_fixture_conversion_whitelists_fields_and_never_exposes_vendor_payload(
        self,
    ) -> None:
        root = require_json_object(
            parse_bounded_json(
                (_FIXTURES / "ordered.json").read_bytes(),
                max_bytes=1024,
            )
        )
        records = tuple(require_json_object(item) for item in require_json_array(root["items"]))

        def fetch(
            cursor: str | None,
        ) -> metadata_ports._RawPage[dict[str, object], str]:
            self.assertIsNone(cursor)
            return metadata_ports._RawPage(
                items=records,
                next_cursor=None,
                exhausted=True,
            )

        converted = 0

        def convert(raw: dict[str, object]) -> NeutralMetadataItem:
            nonlocal converted
            converted += 1
            title = optional_nonblank_string(raw.get("title"))
            if title is None:
                raise invalid_record_failure()
            return NeutralMetadataItem(observations=(_observation(converted, title=title),))

        port = _TopicPort(lambda: metadata_ports._PagedRawItemSession(fetch, convert))
        environment = ContractEnvironment(
            provider_name="contract-subject",
            capabilities=frozenset({"search"}),
            port_factory=lambda _environment: ContractPorts(topic_search=port),
        )
        result = self.assert_topic_scan(
            environment,
            _topic_request(10),
            outcome="EXHAUSTED",
            raw_item_count=2,
            observation_count=2,
        )
        self.assertEqual(
            tuple(item.metadata.title for item in result.observations),
            ("First record", "Second record"),
        )
        self.assert_no_private_payload(
            result,
            runtime_secret=environment.secret_sentinel,
            forbidden_values=("adapter-whitelist-must-ignore-this-key",),
        )

    def test_lookup_capability_uses_the_same_api_scan_contract(self) -> None:
        key = _key("doi", "10.1000/lookup")
        calls: list[ProviderLiteratureKey] = []

        def factory(actual: ProviderLiteratureKey) -> RawItemSession:
            calls.append(actual)
            return _session(
                {
                    None: metadata_ports._RawPage(
                        items=(_RawRecord(1),),
                        next_cursor=None,
                        exhausted=True,
                    )
                },
                lambda raw: NeutralMetadataItem(observations=(_observation(raw.index),)),
            )

        environment = ContractEnvironment(
            provider_name="contract-subject",
            capabilities=frozenset({"lookup"}),
            port_factory=lambda _environment: ContractPorts(lookup=_LookupPort(factory)),
        )
        self.assert_lookup_scan(
            environment,
            MetadataLookupRequest(
                provider_name="contract-subject",
                key=key,
                scan_limit=2,
            ),
            outcome="EXHAUSTED",
            raw_item_count=1,
            observation_count=1,
        )
        self.assertEqual(calls, [key])

    def test_pagination_has_no_prefetch_and_counts_before_nth_conversion(self) -> None:
        fetched: list[str | None] = []
        converted: list[int] = []

        def convert(raw: _RawRecord) -> NeutralMetadataItem:
            converted.append(raw.index)
            return NeutralMetadataItem(observations=(_observation(raw.index),))

        pages = {
            None: metadata_ports._RawPage(
                items=(_RawRecord(1), _RawRecord(2)),
                next_cursor="second-page-runtime-cursor",
                exhausted=False,
            ),
            "second-page-runtime-cursor": metadata_ports._RawPage(
                items=(_RawRecord(3), _RawRecord(4)),
                next_cursor="third-page-must-not-be-fetched",
                exhausted=False,
            ),
        }
        port = _TopicPort(lambda: _session(pages, convert, fetched=fetched))
        environment = ContractEnvironment(
            provider_name="contract-subject",
            capabilities=frozenset({"search"}),
            port_factory=lambda _environment: ContractPorts(topic_search=port),
        )

        result = self.assert_topic_scan(
            environment,
            _topic_request(3),
            outcome="SCAN_LIMIT_REACHED",
            raw_item_count=3,
            observation_count=3,
        )
        self.assertEqual(converted, [1, 2, 3])
        self.assertEqual(fetched, [None, "second-page-runtime-cursor"])
        self.assert_no_private_payload(
            result,
            runtime_secret=environment.secret_sentinel,
            forbidden_values=(
                "second-page-runtime-cursor",
                "third-page-must-not-be-fetched",
            ),
        )

        counted_before_failure: list[int] = []

        def fail_second(raw: _RawRecord) -> NeutralMetadataItem:
            counted_before_failure.append(raw.index)
            if raw.index == 2:
                raise invalid_record_failure()
            return NeutralMetadataItem(observations=(_observation(raw.index),))

        failure_port = _TopicPort(
            lambda: _session(
                {
                    None: metadata_ports._RawPage(
                        items=(_RawRecord(1), _RawRecord(2), _RawRecord(3)),
                        next_cursor=None,
                        exhausted=True,
                    )
                },
                fail_second,
            )
        )
        failure_environment = ContractEnvironment(
            provider_name="contract-subject",
            capabilities=frozenset({"search"}),
            port_factory=lambda _environment: ContractPorts(topic_search=failure_port),
        )
        failed = self.assert_topic_scan(
            failure_environment,
            _topic_request(10),
            outcome="FAILED",
            raw_item_count=3,
            observation_count=2,
        )
        self.assertEqual(counted_before_failure, [1, 2, 3])
        self.assert_stable_failure(
            failed,
            expected_code="metadata-provider-invalid-record",
            forbidden_values=(failure_environment.secret_sentinel,),
        )

    def test_source_exhaustion_wins_at_exact_limit_and_repeated_cursor_is_stable(self) -> None:
        exhausted_port = _TopicPort(
            lambda: _session(
                {
                    None: metadata_ports._RawPage(
                        items=(_RawRecord(1), _RawRecord(2)),
                        next_cursor=None,
                        exhausted=True,
                    )
                },
                lambda raw: NeutralMetadataItem(observations=(_observation(raw.index),)),
            )
        )
        exhausted_environment = ContractEnvironment(
            provider_name="contract-subject",
            capabilities=frozenset({"search"}),
            port_factory=lambda _environment: ContractPorts(topic_search=exhausted_port),
        )
        self.assert_topic_scan(
            exhausted_environment,
            _topic_request(2),
            outcome="EXHAUSTED",
            raw_item_count=2,
            observation_count=2,
        )

        repeated_port = _TopicPort(
            lambda: _session(
                {
                    None: metadata_ports._RawPage(
                        items=(_RawRecord(1),),
                        next_cursor="repeated-runtime-cursor",
                        exhausted=False,
                    ),
                    "repeated-runtime-cursor": metadata_ports._RawPage(
                        items=(_RawRecord(2),),
                        next_cursor="repeated-runtime-cursor",
                        exhausted=False,
                    ),
                },
                lambda raw: NeutralMetadataItem(observations=(_observation(raw.index),)),
            )
        )
        repeated_environment = ContractEnvironment(
            provider_name="contract-subject",
            capabilities=frozenset({"search"}),
            port_factory=lambda _environment: ContractPorts(topic_search=repeated_port),
        )
        result = self.assert_topic_scan(
            repeated_environment,
            _topic_request(10),
            outcome="FAILED",
            raw_item_count=1,
            observation_count=1,
        )
        self.assert_stable_failure(
            result,
            expected_code="metadata-pagination-loop",
            forbidden_values=("repeated-runtime-cursor",),
        )

    def test_multi_provider_partial_success_is_verified_through_metadata_api(self) -> None:
        successful = _TopicPort(
            lambda: _session(
                {
                    None: metadata_ports._RawPage(
                        items=(_RawRecord(1),),
                        next_cursor=None,
                        exhausted=True,
                    )
                },
                lambda raw: NeutralMetadataItem(observations=(_observation(raw.index),)),
            )
        )

        class _FailedTopicPort:
            provider_name = "failed-subject"

            def open_topic_search(self, query: TopicSearchQuery) -> RawItemSession:
                del query
                raise invalid_record_failure()

        api = MetadataApi(
            MetadataService(
                topic_search_ports=(
                    _FailedTopicPort(),
                    successful,
                )
            )
        )
        batch = api.search_topic(
            TopicDiscoveryInput(
                kind="topic",
                query="contract query",
                providers=(
                    ProviderDiscoveryLimit(
                        provider_name="failed-subject",
                        scan_limit=3,
                    ),
                    ProviderDiscoveryLimit(
                        provider_name="contract-subject",
                        scan_limit=3,
                    ),
                ),
            )
        )
        self.assertEqual(
            tuple(result.outcome for result in batch.providers),
            ("FAILED", "EXHAUSTED"),
        )
        self.assertEqual(batch.providers[1].observations, (_observation(1),))

    def test_reference_contract_normalizes_cited_by_to_citing_then_cited(self) -> None:
        anchor = _key("doi", "10.1000/anchor")
        citing = _key("doi", "10.1000/citing")

        def factory(context: ReferenceQueryContext) -> RawItemSession:
            self.assertEqual(context.direction, "cited-by")
            relation = ProviderRelationObservation(
                observation_id=ObservationId(_uuid(50)),
                provenance=_provenance(50, record_id="relation-50"),
                citing=citing,
                cited=anchor,
            )
            return _session(
                {
                    None: metadata_ports._RawPage(
                        items=(_RawRecord(1),),
                        next_cursor=None,
                        exhausted=True,
                    )
                },
                lambda _raw: NeutralMetadataItem(relations=(relation,)),
            )

        environment = ContractEnvironment(
            provider_name="contract-subject",
            capabilities=frozenset({"references"}),
            port_factory=lambda _environment: ContractPorts(
                reference_query=_ReferencePort(factory)
            ),
        )
        request = MetadataReferenceQueryRequest(
            direction="cited-by",
            providers=(
                ProviderReferenceQuery(
                    provider_name="contract-subject",
                    keys=(anchor,),
                    scan_limit=3,
                ),
            ),
        )
        result = self.assert_reference_scan(
            environment,
            request,
            outcome="EXHAUSTED",
            raw_item_count=1,
            relation_count=1,
        )
        self.assert_citing_to_cited(result.relations[0], citing=citing, cited=anchor)

    def test_scope_remains_neutral_and_contains_no_runtime_values(self) -> None:
        empty_port = _TopicPort(
            lambda: _session(
                {
                    None: metadata_ports._RawPage(
                        items=(),
                        next_cursor=None,
                        exhausted=True,
                    )
                },
                lambda _raw: NeutralMetadataItem(),
            )
        )
        environment = ContractEnvironment(
            provider_name="contract-subject",
            capabilities=frozenset({"search"}),
            port_factory=lambda _environment: ContractPorts(topic_search=empty_port),
        )
        self.assert_scope_is_neutral(
            environment.scope,
            forbidden_values=(
                environment.secret_sentinel,
                "10.1000/private-query-id",
                "https://api.contract.invalid/private",
            ),
        )
        environment.close()

    def test_semantic_assertions_cover_authors_identity_versions_assets_and_payload(
        self,
    ) -> None:
        environment = ContractEnvironment(
            provider_name="contract-subject",
            capabilities=frozenset(),
            port_factory=lambda _environment: ContractPorts(),
        )
        authors = (
            Author(
                kind=AuthorKind.PERSON,
                display_name="Ada Lovelace",
                given_name="Ada",
                family_name="Lovelace",
                orcid="0000-0002-1825-0097",
                affiliations=(
                    Affiliation(name="Analytical Engine Institute", ror="03yrm5c26"),
                    Affiliation(name="Mathematics Society"),
                ),
            ),
            Author(
                kind=AuthorKind.ORGANIZATION,
                display_name="Contract Research Consortium",
            ),
            Author(
                kind=AuthorKind.UNKNOWN,
                display_name="署名未分类",
            ),
        )
        own_doi = Identifier(namespace="doi", value="https://doi.org/10.1000/CONTRACT")
        version = _key("arxiv", "arXiv:2501.01234v2")
        hints = (
            AssetHint(
                url="https://assets.contract.invalid/article.pdf",
                kind=AssetHintKind.DIRECT_FILE,
                media_type="application/pdf",
                asset_role=AssetRole.PRIMARY_PDF,
                version_role=VersionRole.PUBLISHED,
                access_status="open",
                license="CC-BY-4.0",
            ),
            AssetHint(
                url="https://landing.contract.invalid/article",
                kind=AssetHintKind.LANDING_PAGE,
                media_type="text/html",
            ),
        )
        observation = MetadataObservation(
            observation_id=ObservationId(_uuid(70)),
            provenance=_provenance(70, record_id="provider-record-70"),
            metadata=LiteratureMetadata(
                title="Contract semantics",
                authors=authors,
                identifiers=(own_doi,),
            ),
            version_links=(version,),
            asset_hints=hints,
        )

        self.assert_author_mapping(
            observation.metadata.authors,
            (
                ExpectedAuthor(
                    kind="person",
                    display_name="Ada Lovelace",
                    given_name="Ada",
                    family_name="Lovelace",
                    orcid="0000-0002-1825-0097",
                    affiliations=(
                        ExpectedAffiliation(
                            name="Analytical Engine Institute",
                            ror="03yrm5c26",
                        ),
                        ExpectedAffiliation(name="Mathematics Society"),
                    ),
                ),
                ExpectedAuthor(
                    kind="organization",
                    display_name="Contract Research Consortium",
                ),
                ExpectedAuthor(
                    kind="unknown",
                    display_name="署名未分类",
                ),
            ),
        )
        self.assert_identifier_record_id_separation(
            observation,
            expected_identifiers=(Identifier(namespace="doi", value="10.1000/contract"),),
            expected_record_id="provider-record-70",
            forbidden_record_ids=("provider-record-70",),
        )
        self.assert_version_links(observation, (version,))
        self.assert_asset_hints(
            observation,
            hints,
            runtime_secret=environment.secret_sentinel,
        )
        self.assert_no_private_payload(
            observation,
            runtime_secret=environment.secret_sentinel,
            forbidden_values=("adapter-whitelist-must-ignore-this-key",),
        )

        # Bypass the now-shared Model guard only to self-test the independent
        # provider-contract assertion.  Production adapters cannot construct
        # this value through normal validation.
        signed_hint = AssetHint.model_construct(
            url=(
                "https://assets.contract.invalid/article.pdf?signature="
                + environment.secret_sentinel
            ),
            kind=AssetHintKind.DIRECT_FILE,
        )
        unsafe = observation.model_copy(update={"asset_hints": (signed_hint,)})
        with self.assertRaises(AssertionError):
            self.assert_asset_hints(
                unsafe,
                (signed_hint,),
                runtime_secret=environment.secret_sentinel,
            )


if __name__ == "__main__":
    unittest.main()
