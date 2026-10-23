import { expect, it } from "vitest";
import {
  parseProofreadBlocksV1,
  parseProofreadVersion,
} from "@sciretriever/contracts";
import { buildProofreadVersion } from "../src/proofread/engine.js";
import { buildProofreadStructure } from "../src/document/proofread-builder.js";
import { renderBlocks } from "../src/proofread/render.js";
import type {
  ProofreadCorrector,
  ManualProofreadDecision,
} from "../src/proofread/contract.js";
import { proofreadFixture } from "./proofread-fixture.js";
const corrector = (
  correct: ProofreadCorrector["correct"],
): ProofreadCorrector => ({
  method: "fake-correction",
  model_config_sha256: "b".repeat(64) as never,
  max_calls: 4,
  correct,
});
const read = (out: Awaited<ReturnType<typeof buildProofreadVersion>>) =>
  parseProofreadBlocksV1(
    JSON.parse(new TextDecoder().decode(out.blocks.bytes)),
    out.resources.map((r) => r.reference),
  ).blocks;
it("publishes a stable single-profile draft with text-layer provenance and rejects forged bytes", async () => {
  const f = await proofreadFixture(),
    a = await buildProofreadVersion(f),
    b = await buildProofreadVersion(f);
  expect(a.version.status).toBe("complete");
  expect(a.version.proofread_id).toBe(b.version.proofread_id);
  expect(a.version.draft_input.raw_parse_id).toBe(f.raw.raw_parse_id);
  expect(read(a)[0]).toMatchObject({
    text_source: "parser",
    basis: "text-layer",
  });
  expect(a.version).not.toHaveProperty("inputs");
  await expect(
    parseProofreadVersion({ ...a.version, part_sha256: "c".repeat(64) }),
  ).rejects.toThrow();
  await expect(
    buildProofreadVersion({
      ...f,
      reader: { readArtifact: async () => Buffer.from("forged") },
    }),
  ).rejects.toThrow("proofread-input-integrity");
});
it("keeps unresolved text questions incomplete without a configured correction model", async () => {
  const out = await buildProofreadVersion(
    await proofreadFixture("Yield 12.5%.", "Yield 12.5 C."),
  );
  expect(out.version.status).toBe("incomplete");
  expect(out.version.pages[0]!.pending_reason).toBe(
    "correction-model-unconfigured",
  );
  expect(out.version.suspects.some((s) => s.kind === "token-mismatch")).toBe(
    true,
  );
  expect(out.version.failure).toBeNull();
});
it("accepts an image-backed numerical correction instead of enforcing old candidate-number restrictions", async () => {
  const f = await proofreadFixture("Yield 67%.", "Yield 97%.");
  const out = await buildProofreadVersion({
    ...f,
    corrector: corrector(async (c) => ({
      submission: {
        edits: [
          {
            kind: "replace",
            block_id: c.drafts[0]!.block_id,
            text: "Yield 97%.",
            basis_page: 0,
            reason: "The image shows 97.",
          },
        ],
        dispositions: c.suspects.map((s) => ({
          suspect_id: s.suspect_id,
          disposition: {
            status: "fixed",
            reason: "Corrected against the image.",
          },
        })),
        no_body_reason: null,
      },
      reason: null,
      calls: 2,
      input_tokens: 100,
      output_tokens: 20,
    })),
  });
  expect(out.version.status).toBe("complete");
  expect(read(out)[0]).toMatchObject({
    text: "Yield 97%.",
    text_source: "agent",
    basis: "text-layer",
  });
  expect(out.version.stats).toMatchObject({
    calls: 2,
    input_tokens: 100,
    output_tokens: 20,
  });
});
it("completes uncertain transcription without adding uncertainty prose to Markdown", async () => {
  const f = await proofreadFixture("Yield 67%.", "Yield 97%.");
  const out = await buildProofreadVersion({
    ...f,
    corrector: corrector(async (c) => ({
      submission: {
        edits: [],
        dispositions: c.suspects.map((s) => ({
          suspect_id: s.suspect_id,
          disposition: {
            status: "uncertain",
            reason: "Original digits remain unreadable after zooming.",
          },
        })),
        no_body_reason: null,
      },
      reason: null,
      calls: 1,
      input_tokens: 40,
      output_tokens: 10,
    })),
  });
  expect(out.version.status).toBe("complete");
  expect(read(out)[0]!.basis).toBe("text-layer");
  expect(read(out)[0]).not.toHaveProperty("uncertainty");
  expect(out.version.stats).not.toHaveProperty("uncertain_blocks");
  expect(
    out.version.suspects.some((s) => s.disposition?.status === "uncertain"),
  ).toBe(true);
  expect(Buffer.from(out.markdown.bytes).toString()).not.toContain(
    "unreadable",
  );
});
it("requires explicit image-only page inspection and preserves resumable budget exhaustion", async () => {
  const f = await proofreadFixture("Scanned text.", "", "image-only");
  const pending = await buildProofreadVersion({
    ...f,
    corrector: corrector(async () => ({
      submission: null,
      reason: "correction-budget-exhausted",
      calls: 0,
      input_tokens: 0,
      output_tokens: 0,
    })),
  });
  expect(pending.version.status).toBe("incomplete");
  expect(pending.version.pages[0]!.checked).toBe(false);
  const done = await buildProofreadVersion({
    ...f,
    corrector: corrector(async () => ({
      submission: { edits: [], dispositions: [], no_body_reason: null },
      reason: null,
      calls: 1,
      input_tokens: 2,
      output_tokens: 3,
    })),
  });
  expect(done.version.status).toBe("complete");
  expect(done.version.pages[0]!.checked).toBe(true);
});
it("keeps unreadable image-only blocks empty and publishes their locations without invented transcription", async () => {
  const f = await proofreadFixture("Unverified OCR 67%.", "", "image-only");
  const out = await buildProofreadVersion({
    ...f,
    corrector: corrector(async (c) => ({
      submission: {
        edits: c.drafts
          .filter((d) => d.page === c.page.page)
          .map((d) => ({
            kind: "replace" as const,
            block_id: d.block_id,
            text: "",
            basis_page: c.page.page,
            reason: "Unreadable after image inspection.",
          })),
        dispositions: c.suspects.map((s) => ({
          suspect_id: s.suspect_id,
          disposition: {
            status: "uncertain" as const,
            reason: "Unreadable after image inspection.",
          },
        })),
        no_body_reason: null,
      },
      reason: null,
      calls: 1,
      input_tokens: 10,
      output_tokens: 2,
    })),
  });
  expect(out.version.status).toBe("complete");
  const block = read(out)[0]!;
  expect(block).toMatchObject({ text: "", html: null, basis: "image-only" });
  expect(Buffer.from(out.markdown.bytes).toString().trim()).toBe("");
  const document = await buildProofreadStructure(
    out.version,
    out.blocks.bytes,
    out.markdown.bytes,
  );
  expect(document.structure.segments).toHaveLength(1);
  expect(document.structure.segments[0]).toMatchObject({
    block_id: block.block_id,
    page: 0,
    basis: "image-only",
  });
  for (const type of ["title", "table", "equation"] as const) {
    const rendered = renderBlocks(
      [{ ...block, type, title_level: type === "title" ? 1 : null }],
      [],
    );
    expect(Buffer.from(rendered.markdown).toString().trim()).toBe("");
    expect(rendered.ranges).toHaveLength(1);
  }
});
it("resumes newly exposed questions after replaying cached edits within the per-run budget", async () => {
  const f = await proofreadFixture("A old B missing.", "A new B gone.");
  const cache = new Map<
    string,
    Awaited<ReturnType<ProofreadCorrector["correct"]>>
  >();
  let dispatches = 0;
  const model: ProofreadCorrector = {
    ...corrector(async (context, remaining) => {
      const key = JSON.stringify(context);
      const cached = cache.get(key);
      if (cached)
        return { ...cached, calls: 0, input_tokens: 0, output_tokens: 0 };
      if (!remaining)
        return {
          submission: null,
          reason: "correction-budget-exhausted",
          calls: 0,
          input_tokens: 0,
          output_tokens: 0,
        };
      dispatches++;
      const first = context.drafts[0]!.text.includes("old");
      if (!first)
        expect(context.drafts[0]!.page_text).toEqual([
          { page: 0, text: "A new B missing." },
        ]);
      const result: Awaited<ReturnType<ProofreadCorrector["correct"]>> = {
        submission: {
          edits: first
            ? [
                {
                  kind: "replace",
                  block_id: context.drafts[0]!.block_id,
                  text: "A new B missing.",
                  basis_page: 0,
                  reason: "The image shows new.",
                },
              ]
            : [],
          dispositions: context.suspects.map((s) => ({
            suspect_id: s.suspect_id,
            disposition: {
              status: first ? "fixed" : "uncertain",
              reason: first
                ? "Checked the image."
                : "The remaining word is unreadable.",
            },
          })),
          no_body_reason: null,
        },
        reason: null,
        calls: 1,
        input_tokens: 10,
        output_tokens: 5,
      };
      cache.set(key, result);
      return result;
    }),
    max_calls: 1,
  };
  const pending = await buildProofreadVersion({ ...f, corrector: model });
  expect(pending.version.status).toBe("incomplete");
  expect(pending.version.pages[0]!.pending_reason).toBe(
    "correction-budget-exhausted",
  );
  const completed = await buildProofreadVersion({ ...f, corrector: model });
  expect(completed.version.status).toBe("complete");
  expect(completed.usage.calls).toBe(1);
  expect(dispatches).toBe(2);
  expect(read(completed)[0]!.basis).toBe("text-layer");
  expect(
    completed.version.suspects.some(
      (s) => s.disposition?.status === "uncertain",
    ),
  ).toBe(true);
  const reused = await buildProofreadVersion({ ...f, corrector: model });
  expect(reused.version.proofread_id).toBe(completed.version.proofread_id);
  expect(reused.usage.calls).toBe(0);
});

it("does not loop or claim completion when a cached fixed disposition makes no progress", async () => {
  const f = await proofreadFixture("A.", "A missing.");
  let reviews = 0;
  const output = await buildProofreadVersion({
    ...f,
    corrector: corrector(async (context) => {
      reviews++;
      return {
        submission: {
          edits: [],
          dispositions: context.suspects.map((s) => ({
            suspect_id: s.suspect_id,
            disposition: {
              status: "fixed",
              reason: "Allegedly fixed without editing.",
            },
          })),
          no_body_reason: null,
        },
        reason: null,
        calls: 0,
        input_tokens: 0,
        output_tokens: 0,
      };
    }),
  });
  expect(reviews).toBe(2);
  expect(output.version.status).toBe("incomplete");
  expect(output.version.suspects.some((s) => !s.disposition)).toBe(true);
});

it("does not count changed edit explanations as progress when the text and pending questions stay identical", async () => {
  const f = await proofreadFixture("A.", "A missing.");
  let reviews = 0;
  const output = await buildProofreadVersion({
    ...f,
    corrector: corrector(async (context) => {
      reviews++;
      return {
        submission: {
          edits: [
            {
              kind: "replace",
              block_id: context.drafts[0]!.block_id,
              text: "A.",
              basis_page: 0,
              reason: `Checked image attempt ${reviews}.`,
            },
          ],
          dispositions: context.suspects.map((s) => ({
            suspect_id: s.suspect_id,
            disposition: { status: "fixed", reason: `Claimed fix ${reviews}.` },
          })),
          no_body_reason: null,
        },
        reason: null,
        calls: 1,
        input_tokens: 1,
        output_tokens: 1,
      };
    }),
  });
  expect(reviews).toBe(2);
  expect(output.version.status).toBe("incomplete");
});

it("preserves manual text and detects a changed draft instead of silently dropping the lock", async () => {
  const f = await proofreadFixture(),
    initial = await buildProofreadVersion(f),
    d = initial.drafts[0]!;
  const decision: ManualProofreadDecision = {
    decision_id: "00000000-0000-0000-0000-000000000992",
    part_asset_id: f.raw.source_asset_id,
    block_id: d.block_id,
    draft_sha256: d.draft_sha256,
    raw_ref: d.raw_ref,
    action: "replace",
    text: "Manually verified 99%.",
    reason: "Checked the original PDF.",
    page: 0,
    suspect_id: null,
    disposition: null,
  };
  const locked = await buildProofreadVersion({ ...f, decisions: [decision] });
  expect(locked.version.status).toBe("complete");
  expect(read(locked)[0]).toMatchObject({
    text: decision.text,
    text_source: "manual",
    basis: "manual",
  });
  const changed = await buildProofreadVersion({
    ...(await proofreadFixture("A new draft.")),
    decisions: [decision],
  });
  expect(changed.version.status).toBe("incomplete");
  expect(changed.version.pages[0]!.pending_reason).toBe("manual-conflict");
  await expect(
    buildProofreadVersion({ ...f, signal: AbortSignal.abort() }),
  ).rejects.toThrow();
});

it("preserves a human correction on an agent-inserted block across reruns", async () => {
  const f = await proofreadFixture("Scanned text.", "", "image-only");
  const model = corrector(async (c) => ({
    submission: {
      edits: [
        {
          kind: "insert_after",
          after_block_id: c.drafts[0]!.block_id,
          basis_page: 0,
          reason: "A missing caption is visible.",
          block: {
            page: 0,
            region: null,
            type: "text",
            title_level: null,
            text: "Caption 67%.",
            html: null,
            image_ref: null,
          },
        },
      ],
      dispositions: [],
      no_body_reason: null,
    },
    calls: 1,
    input_tokens: 1,
    output_tokens: 1,
    reason: null,
  }));
  const initial = await buildProofreadVersion({ ...f, corrector: model }),
    block = read(initial)[1]!;
  const { insertedDraft } = await import("../src/proofread/contract.js");
  const target = await insertedDraft(
    block,
    f.raw.result_sha256,
    initial.version.edits,
  );
  const decision: ManualProofreadDecision = {
    decision_id: "00000000-0000-0000-0000-000000000993",
    part_asset_id: f.raw.source_asset_id,
    block_id: block.block_id,
    draft_sha256: target.draft_sha256,
    raw_ref: [],
    action: "replace",
    text: "Caption 97%.",
    reason: "Checked the original caption.",
    page: 0,
    suspect_id: null,
    disposition: null,
  };
  const locked = await buildProofreadVersion({
    ...f,
    corrector: model,
    decisions: [decision],
  });
  expect(locked.version.status).toBe("complete");
  expect(read(locked)[1]).toMatchObject({
    text: "Caption 97%.",
    text_source: "manual",
    basis: "manual",
  });
  expect(locked.version.manual_decision_ids).toEqual([decision.decision_id]);
});
