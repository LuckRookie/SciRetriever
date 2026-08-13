from __future__ import annotations

import unittest

import sciretriever.literature.content as literature_content
from sciretriever.analysis.markdown import render_canonical_markdown
from sciretriever.literature.content import (
    ContentAcceptanceReplacement,
    decide_content_acceptance,
    metadata_sha256,
)
from sciretriever.literature.state import (
    CurrentContentLineage,
    CurrentLiteratureFacts,
    CurrentPrimaryPdf,
    derive_status,
)
from sciretriever.model.acquisition import Asset, AssetRole, LiteratureAsset
from sciretriever.model.analysis import (
    ArtifactRef,
    LiteratureContent,
    LiteratureContentProposal,
    LiteratureSection,
    LiteratureSectionRole,
    analysis_input_sha256,
    content_sha256,
)
from sciretriever.model.literature import (
    Identifier,
    Literature,
    LiteratureStatus,
    VersionRole,
)
from sciretriever.model.metadata import LiteratureMetadata
from sciretriever.model.parsing import (
    ParserArtifactRef,
    ParserProvenance,
    ParserResult,
    parser_result_sha256,
)
from sciretriever.model.primitives import (
    AssetId,
    LiteratureAssetId,
    LiteratureId,
    MetaLiteratureId,
    ProvenanceId,
    RelativeArtifactPath,
    Sha256,
    SourceKind,
    UtcTimestamp,
    sha256_digest,
)
from sciretriever.model.provenance import Provenance

_LITERATURE_ID = "123e4567-e89b-12d3-a456-426614174000"
_META_ID = "223e4567-e89b-12d3-a456-426614174000"
_ASSET_ID = "323e4567-e89b-12d3-a456-426614174000"
_RELATION_ID = "423e4567-e89b-12d3-a456-426614174000"
_PROVENANCE_ID = "523e4567-e89b-12d3-a456-426614174000"
_PARSER_PROVENANCE_ID = "623e4567-e89b-12d3-a456-426614174000"
_CONTENT_PROVENANCE_ID = "723e4567-e89b-12d3-a456-426614174000"
_TIMESTAMP = UtcTimestamp("2026-08-10T12:34:56Z")


class LiteratureContentTests(unittest.TestCase):
    def _provenance(
        self,
        source_kind: SourceKind,
        source_name: str,
        provenance_id: str,
        *,
        input_sha256: Sha256 | None,
        parameters_sha256: Sha256 | None,
    ) -> Provenance:
        return Provenance(
            provenance_id=ProvenanceId(provenance_id),
            source_kind=source_kind,
            source_name=source_name,
            source_record_id=None,
            observed_at=_TIMESTAMP,
            input_sha256=input_sha256,
            parameters_sha256=parameters_sha256,
        )

    def _metadata(self, *, final: bool = False) -> LiteratureMetadata:
        return LiteratureMetadata(
            title="A target paper",
            abstract="A concise abstract." if final else None,
            publication_year=2026,
            document_type="article",
            language="en",
            venue="Journal",
            publisher="Publisher",
            identifiers=(Identifier(namespace="doi", value="10.1234/example"),),
            keywords=("analysis", "testing") if final else (),
        )

    def _asset(self) -> Asset:
        return Asset(
            asset_id=AssetId(_ASSET_ID),
            sha256=sha256_digest(b"pdf bytes"),
            size_bytes=9,
            media_type="application/pdf",
            path=RelativeArtifactPath("assets/paper.pdf"),
        )

    def _primary_pdf(self) -> CurrentPrimaryPdf:
        asset = self._asset()
        return CurrentPrimaryPdf(
            asset=asset,
            relation=LiteratureAsset(
                literature_asset_id=LiteratureAssetId(_RELATION_ID),
                literature_id=LiteratureId(_LITERATURE_ID),
                asset_id=asset.asset_id,
                role=AssetRole.PRIMARY_PDF,
                provenance=self._provenance(
                    SourceKind.ASSET_PROVIDER,
                    "fixture-source",
                    _PROVENANCE_ID,
                    input_sha256=asset.sha256,
                    parameters_sha256=Sha256("a" * 64),
                ),
                source_url="https://example.invalid/paper.pdf",
            ),
        )

    def _parser_result(self) -> ParserResult:
        primary = self._primary_pdf().asset
        markdown = ParserArtifactRef(
            sha256=sha256_digest(b"# parser input"),
            media_type="text/markdown",
            byte_size=14,
        )
        provenance = ParserProvenance(
            provenance=self._provenance(
                SourceKind.PARSER,
                "fixture-parser",
                _PARSER_PROVENANCE_ID,
                input_sha256=primary.sha256,
                parameters_sha256=Sha256("b" * 64),
            ),
            parser_version="1.0",
            mode=None,
            model_identity=None,
        )
        return ParserResult(
            source_asset_id=primary.asset_id,
            source_sha256=primary.sha256,
            page_count=1,
            markdown=markdown,
            resources=(),
            result_sha256=parser_result_sha256(
                source_asset_id=primary.asset_id,
                source_sha256=primary.sha256,
                page_count=1,
                markdown=markdown,
                resources=(),
                provenance=provenance,
            ),
            provenance=provenance,
        )

    def _literature(self, metadata: LiteratureMetadata | None = None) -> Literature:
        return Literature(
            literature_id=LiteratureId(_LITERATURE_ID),
            meta_literature_id=MetaLiteratureId(_META_ID),
            version_role=VersionRole.PUBLISHED,
            metadata=metadata or self._metadata(),
            # The state is deliberately recomputed from CurrentLiteratureFacts.
            status=LiteratureStatus.UNREVIEWED,
        )

    def _sections(self) -> tuple[LiteratureSection, ...]:
        return tuple(
            LiteratureSection(
                role=role,
                title=None,
                markdown="A section." if role is LiteratureSectionRole.DATA else "未提供",
                subsections=(),
            )
            for role in (
                LiteratureSectionRole.BACKGROUND_AND_OBJECTIVES,
                LiteratureSectionRole.METHODS,
                LiteratureSectionRole.DATA,
                LiteratureSectionRole.CONCLUSIONS_AND_LIMITATIONS,
            )
        )

    def _content(
        self,
        *,
        metadata: LiteratureMetadata | None = None,
        revision: int = 2,
        references: tuple[str, ...] = ("A. Author, A study (2020).",),
    ) -> LiteratureContent:
        final_metadata = metadata or self._metadata(final=True)
        metadata_hash = metadata_sha256(final_metadata)
        sections = self._sections()
        primary = self._primary_pdf().asset
        parser = self._parser_result()
        provenance = self._provenance(
            SourceKind.ANALYSIS,
            "fixture-analysis/model",
            _CONTENT_PROVENANCE_ID,
            input_sha256=analysis_input_sha256(
                primary.sha256,
                parser.result_sha256,
                metadata_hash,
            ),
            parameters_sha256=Sha256("c" * 64),
        )
        rendered = render_canonical_markdown(
            metadata=final_metadata,
            sections=sections,
            references=references,
        )
        return LiteratureContent(
            literature_content_sha256=content_sha256(
                metadata_sha256=metadata_hash,
                sections=sections,
                references=references,
            ),
            metadata_revision=revision,
            metadata_sha256=metadata_hash,
            sections=sections,
            references=references,
            markdown=ArtifactRef(
                sha256=sha256_digest(rendered),
                media_type="text/markdown",
                byte_size=len(rendered),
            ),
            provenance=provenance,
        )

    def _facts(self, *, content: LiteratureContent | None = None) -> CurrentLiteratureFacts:
        primary = self._primary_pdf()
        parser = self._parser_result()
        return CurrentLiteratureFacts(
            literature=self._literature(),
            metadata_revision=1,
            metadata_sha256=metadata_sha256(self._metadata()),
            current_primary_pdfs=(primary,),
            current_parser_result=parser,
            current_content=content,
            current_content_lineage=(
                None
                if content is None
                else CurrentContentLineage(
                    primary_asset_id=primary.asset.asset_id,
                    primary_pdf_sha256=primary.asset.sha256,
                    parser_result_sha256=parser.result_sha256,
                )
            ),
        )

    def _proposal(
        self,
        *,
        content: LiteratureContent | None = None,
    ) -> LiteratureContentProposal:
        primary = self._primary_pdf().asset
        parser = self._parser_result()
        proposed = content or self._content()
        return LiteratureContentProposal(
            literature_id=LiteratureId(_LITERATURE_ID),
            primary_asset_id=primary.asset_id,
            primary_pdf_sha256=primary.sha256,
            parser_result_sha256=parser.result_sha256,
            input_metadata_revision=1,
            input_metadata_sha256=metadata_sha256(self._metadata()),
            final_metadata=self._metadata(final=True),
            metadata_sha256=proposed.metadata_sha256,
            sections=proposed.sections,
            references=proposed.references,
            literature_content_sha256=proposed.literature_content_sha256,
            markdown=proposed.markdown,
            provenance=proposed.provenance,
        )

    def test_state_is_derived_from_authoritative_facts_only(self) -> None:
        unreviewed = self._facts()
        self.assertEqual(derive_status(unreviewed), LiteratureStatus.ASSET_READY)
        self.assertEqual(
            derive_status(unreviewed.model_copy(update={"current_primary_pdfs": ()})),
            LiteratureStatus.UNREVIEWED,
        )
        self.assertEqual(
            derive_status(
                unreviewed.model_copy(
                    update={
                        "current_primary_pdfs": (),
                        "current_parser_result": self._parser_result(),
                    }
                )
            ),
            LiteratureStatus.UNREVIEWED,
        )
        self.assertEqual(
            derive_status(
                unreviewed.model_copy(
                    update={
                        "metadata_revision": 2,
                        "metadata_sha256": metadata_sha256(self._metadata(final=True)),
                        "current_content": self._content(),
                        "current_content_lineage": CurrentContentLineage(
                            primary_asset_id=self._primary_pdf().asset.asset_id,
                            primary_pdf_sha256=self._primary_pdf().asset.sha256,
                            parser_result_sha256=self._parser_result().result_sha256,
                        ),
                    }
                )
            ),
            LiteratureStatus.CONTENT_READY,
        )
        # ParserResult alone does not advance the state; references are not
        # part of the state snapshot at all.
        self.assertEqual(
            derive_status(
                unreviewed.model_copy(
                    update={
                        "current_parser_result": None,
                    }
                )
            ),
            LiteratureStatus.ASSET_READY,
        )

    def test_complete_proposal_is_one_replacement_and_reaches_content_ready(self) -> None:
        facts = self._facts()
        proposal = self._proposal()
        decision = decide_content_acceptance(facts, proposal)

        self.assertEqual(decision.decision, "accepted")
        self.assertEqual(decision.status, LiteratureStatus.CONTENT_READY)
        self.assertIsInstance(decision.replacement, ContentAcceptanceReplacement)
        assert decision.replacement is not None
        self.assertEqual(decision.replacement.metadata, self._metadata(final=True))
        self.assertEqual(decision.replacement.metadata_revision, facts.metadata_revision + 1)
        self.assertEqual(
            decision.replacement.content.metadata_revision,
            facts.metadata_revision + 1,
        )
        self.assertEqual(decision.replacement.content.sections, self._sections())
        self.assertEqual(
            decision.replacement.content.references,
            ("A. Author, A study (2020).",),
        )
        self.assertEqual(decision.replacement.content.markdown, self._content().markdown)
        self.assertIsNone(decision.old_content_sha256_to_cleanup)
        self.assertFalse(hasattr(proposal, "metadata_revision"))
        self.assertFalse(hasattr(proposal, "content"))

    def test_private_proposal_and_second_renderer_are_removed(self) -> None:
        self.assertFalse(hasattr(literature_content, "ContentAcceptanceProposal"))
        self.assertFalse(hasattr(literature_content, "render_canonical_markdown"))
        self.assertNotIn("metadata-output-revision-mismatch", literature_content.__dict__)

    def test_replacement_explicitly_marks_old_content_hash_for_follow_up_cleanup(self) -> None:
        old = self._content(
            metadata=self._metadata(final=True),
            revision=1,
            references=("An older reference.",),
        )
        decision = decide_content_acceptance(self._facts(content=old), self._proposal())

        self.assertEqual(decision.decision, "accepted")
        self.assertEqual(decision.old_content_sha256_to_cleanup, old.literature_content_sha256)

    def test_stale_or_publication_conflicts_fail_closed_without_cleanup(self) -> None:
        cases = (
            (
                "literature-mismatch",
                self._proposal().model_copy(update={"literature_id": LiteratureId(_META_ID)}),
            ),
            (
                "primary-pdf-mismatch",
                self._proposal().model_copy(update={"primary_pdf_sha256": Sha256("d" * 64)}),
            ),
            (
                "parser-result-mismatch",
                self._proposal().model_copy(update={"parser_result_sha256": Sha256("e" * 64)}),
            ),
            (
                "metadata-revision-stale",
                self._proposal().model_copy(update={"input_metadata_revision": 2}),
            ),
            (
                "metadata-hash-stale",
                self._proposal().model_copy(update={"input_metadata_sha256": Sha256("f" * 64)}),
            ),
        )
        for reason, proposal in cases:
            with self.subTest(reason=reason):
                decision = decide_content_acceptance(self._facts(content=self._content()), proposal)
                self.assertEqual(decision.decision, "rejected")
                self.assertEqual(decision.reason, reason)
                self.assertIsNone(decision.replacement)
                self.assertIsNone(decision.old_content_sha256_to_cleanup)

        conflict_facts = self._facts().model_copy(
            update={
                "current_primary_pdfs": (
                    self._primary_pdf(),
                    self._primary_pdf(),
                )
            }
        )
        conflict = decide_content_acceptance(conflict_facts, self._proposal())
        self.assertEqual(conflict.decision, "rejected")
        self.assertEqual(conflict.reason, "primary-pdf-publication-conflict")

    def test_metadata_content_hash_and_provenance_must_match(self) -> None:
        content = self._content()
        bad_metadata_hash = Sha256("8" * 64)
        bad_metadata = self._proposal().model_copy(
            update={
                "metadata_sha256": bad_metadata_hash,
                "literature_content_sha256": content_sha256(
                    metadata_sha256=bad_metadata_hash,
                    sections=content.sections,
                    references=content.references,
                ),
            }
        )
        decision = decide_content_acceptance(self._facts(), bad_metadata)
        self.assertEqual(decision.decision, "rejected")
        self.assertEqual(decision.reason, "content-metadata-mismatch")

        bad_structure_hash = LiteratureContentProposal.model_construct(
            literature_id=LiteratureId(_LITERATURE_ID),
            primary_asset_id=self._primary_pdf().asset.asset_id,
            primary_pdf_sha256=self._primary_pdf().asset.sha256,
            parser_result_sha256=self._parser_result().result_sha256,
            input_metadata_revision=1,
            input_metadata_sha256=metadata_sha256(self._metadata()),
            final_metadata=self._metadata(final=True),
            metadata_sha256=content.metadata_sha256,
            literature_content_sha256=Sha256("7" * 64),
            sections=content.sections,
            references=content.references,
            markdown=content.markdown,
            provenance=content.provenance,
        )
        decision = decide_content_acceptance(self._facts(), bad_structure_hash)
        self.assertEqual(decision.decision, "rejected")
        self.assertEqual(decision.reason, "content-hash-mismatch")

        bad_provenance = self._proposal().model_copy(
            update={
                "provenance": content.provenance.model_copy(
                    update={"input_sha256": Sha256("6" * 64)}
                )
            }
        )
        decision = decide_content_acceptance(self._facts(), bad_provenance)
        self.assertEqual(decision.decision, "rejected")
        self.assertEqual(decision.reason, "content-provenance-mismatch")

    def test_literature_accepts_the_analysis_markdown_descriptor_without_rerendering(self) -> None:
        proposal = self._proposal()
        replacement_descriptor = proposal.markdown.model_copy(update={"sha256": Sha256("9" * 64)})
        proposal = proposal.model_copy(update={"markdown": replacement_descriptor})

        decision = decide_content_acceptance(self._facts(), proposal)

        self.assertEqual(decision.decision, "accepted")
        assert decision.replacement is not None
        self.assertEqual(decision.replacement.content.markdown, replacement_descriptor)


if __name__ == "__main__":
    unittest.main()
