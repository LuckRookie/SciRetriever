import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { parseLiteratureMetadata } from "@sciretriever/contracts";
import { createQueryApplication } from "../src/bootstrap/application.js";
import { coreProcessingFixture } from "./core-processing-fixture.js";
import {
  FIXTURE_DOI,
  FIXTURE_LITERATURE,
} from "../src/workbench/synthetic-fixture.js";

describe("post-parse article identity", () => {
  it("supports a title and author without identifiers, retaining history but clearing the label when accepted metadata changes", async () => {
    const env = await coreProcessingFixture();
    try {
      const updateMetadata = async (title: string) => {
        const observationId = randomUUID();
        await env.app.observations.publish({
          observation_id: observationId,
          provenance: {
            provenance_id: randomUUID(),
            source_kind: "metadata-provider",
            source_name: "fixture",
            source_record_id: observationId,
            observed_at: new Date().toISOString(),
            input_sha256: "b".repeat(64),
            parameters_sha256: null,
          },
          metadata: parseLiteratureMetadata({
            ...FIXTURE_LITERATURE.metadata,
            title,
            identifiers: [],
            authors: [
              {
                kind: "person",
                display_name: "Ada Researcher",
                given_name: "Ada",
                family_name: "Researcher",
                orcid: null,
                affiliations: [],
              },
            ],
          }),
          version_role: "published",
          reference_count: null,
          cited_by_count: null,
          declared_keywords: [],
          reference_texts: [],
        });
        const baseline = await env.app.library.detail(
          env.parseRequest.literature_id,
        );
        await env.app.observations.accept(
          observationId,
          env.parseRequest.literature_id,
          baseline.metadata_revision,
          baseline.metadata_sha256,
        );
      };
      await updateMetadata("Chemical synthesis: a review");
      env.setText("# Chemical synthesis:  a review\n\nAda  Researcher\n");
      env.setModel((input) => ({
        document_kind: "article",
        fields: [
          {
            field: "title",
            value: "Chemical synthesis: a review",
            quote: "Chemical synthesis:  a review",
          },
          {
            field: "author",
            value: "Ada Researcher",
            quote: "Ada  Researcher",
          },
        ].map((field) => ({
          ...field,
          segment_id: input.segments!.find((s) => s.text.includes(field.quote))!
            .segment_id,
        })),
      }));
      await env.app.documentProcessing.parseDocuments(env.parseRequest);
      const request = await env.identityRequest();
      const assessed = await env.app.articleIdentity!.assess(request);
      expect(assessed.assessment).toMatchObject({
        status: "match-supported",
        reason: "title-and-author-match",
      });
      await updateMetadata("A different title");
      expect(
        (await env.app.library.detail(env.parseRequest.literature_id))
          .primary_pdf?.article_identity_status,
      ).toBe("unverified");
      expect(
        await env.app.articleIdentity!.read(assessed.assessment.assessment_id),
      ).toMatchObject({
        current: false,
        assessment: { status: "match-supported" },
      });
      await expect(
        env.app.articleIdentity!.assess(request),
      ).rejects.toMatchObject({ code: "article-identity-stale" });
      expect(env.modelCalls).toBe(1);
    } finally {
      await env.close();
    }
  });
  it("publishes evidence through the production model binding, reuses it after restart, and invalidates its current label after reparse", async () => {
    const env = await coreProcessingFixture();
    try {
      await env.app.documentProcessing.parseDocuments(env.parseRequest);
      expect(
        (await env.app.library.detail(env.parseRequest.literature_id))
          .primary_pdf?.article_identity_status,
      ).toBe("unverified");
      const request = await env.identityRequest();
      const result = await env.app.articleIdentity!.assess(request);
      expect(result.assessment).toMatchObject({
        status: "match-supported",
        reason: "identifier-match",
        asset_sha256: env.asset.sha256,
        evidence: [{ field: "doi", value: FIXTURE_DOI }],
      });
      expect(result.published).toBe(true);
      expect(env.modelCalls).toBe(1);
      await env.reopen();
      expect((await env.app.articleIdentity!.assess(request)).published).toBe(
        false,
      );
      expect(env.modelCalls).toBe(1);
      const query = await createQueryApplication(env.home);
      try {
        expect(
          (await query.query!.detail(env.parseRequest.literature_id))
            .primary_pdf?.article_identity_status,
        ).toBe("match-supported");
        expect(
          await query.articleIdentityRead!(result.assessment.assessment_id),
        ).toMatchObject({ current: true });
        env.setText("# New parser representation\nNo identity extracted.\n");
        await env.app.documentProcessing.parseDocuments({
          ...env.parseRequest,
          expected_default_revision: 1,
        });
        expect(
          (await query.query!.detail(env.parseRequest.literature_id))
            .primary_pdf?.article_identity_status,
        ).toBe("unverified");
        expect(
          await query.articleIdentityRead!(result.assessment.assessment_id),
        ).toMatchObject({ current: false });
      } finally {
        await query.close();
      }
      expect(
        (await env.app.library.detail(env.parseRequest.literature_id))
          .primary_pdf?.asset.sha256,
      ).toBe(env.asset.sha256);
    } finally {
      await env.close();
    }
  });
  it("retains conflicting and insufficient evidence without blocking parsing or deleting the PDF", async () => {
    for (const conflict of [true, false]) {
      const env = await coreProcessingFixture();
      try {
        env.setText(
          conflict
            ? "# Another article\nDOI: 10.5555/another\n"
            : `# No own identity\nReferences\n${FIXTURE_DOI}\n`,
        );
        env.setModel((input) =>
          conflict
            ? {
                document_kind: "article",
                fields: [
                  {
                    field: "doi",
                    value: "10.5555/another",
                    quote: "DOI: 10.5555/another",
                    segment_id: input.segments!.find((s) =>
                      s.text.includes("DOI:"),
                    )!.segment_id,
                  },
                ],
              }
            : { document_kind: "unknown", fields: [] },
        );
        const parsed = await env.app.documentProcessing.parseDocuments(
          env.parseRequest,
        );
        const result = await env.app.articleIdentity!.assess(
          await env.identityRequest(),
        );
        expect(result.assessment.status).toBe(
          conflict ? "conflict" : "insufficient-evidence",
        );
        expect(
          await env.app.documentRead.describe({
            document_version_id: parsed.document.document_version_id,
          }),
        ).toBeDefined();
        expect(
          (await env.app.library.detail(env.parseRequest.literature_id))
            .primary_pdf?.asset.sha256,
        ).toBe(env.asset.sha256);
      } finally {
        await env.close();
      }
    }
  });
  it("rejects invented quotes, stale metadata, over-budget input and cancelled model work without a false current verdict", async () => {
    const env = await coreProcessingFixture();
    try {
      await env.app.documentProcessing.parseDocuments(env.parseRequest);
      const request = await env.identityRequest();
      env.setModel((input) => ({
        document_kind: "article",
        fields: [
          {
            field: "doi",
            value: FIXTURE_DOI,
            quote: `invented quote ${FIXTURE_DOI}`,
            segment_id: input.segments![0]!.segment_id,
          },
        ],
      }));
      await expect(
        env.app.articleIdentity!.assess(request),
      ).rejects.toMatchObject({ code: "article-identity-evidence" });
      await expect(
        env.app.articleIdentity!.assess({
          ...request,
          metadata_revision: request.metadata_revision + 1,
        }),
      ).rejects.toMatchObject({ code: "article-identity-stale" });
      await expect(
        env.app.articleIdentity!.assess({
          ...request,
          budget: { ...request.budget, max_input_bytes: 1 },
        }),
      ).rejects.toMatchObject({ code: "article-identity-budget" });
      const controller = new AbortController();
      controller.abort();
      await expect(
        env.app.articleIdentity!.assess(request, controller.signal),
      ).rejects.toMatchObject({ code: "article-identity-cancelled" });
      expect(
        (await env.app.library.detail(env.parseRequest.literature_id))
          .primary_pdf?.article_identity_status,
      ).toBe("unverified");
    } finally {
      await env.close();
    }
  });
});
