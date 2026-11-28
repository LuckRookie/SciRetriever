import { expect, it, vi } from "vitest";
import { archiveFixture } from "./archive-fixture.js";
import {
  DRAFT_BASES,
  parseArchiveTextBundleV2,
  parsePageProofreadRecord,
  type ArrangementOperation,
} from "@sciretriever/contracts";
import {
  FORMAT_RULE,
  applyFormatEdits,
  formatEdits,
  originalOffset,
  unifiedText,
} from "../src/archive/format-normalize.js";
import {
  acceptArrangement,
  reviewArrangement,
} from "../src/archive/arrangement.js";
import { ArchivePageProofreadService } from "../src/proofread/page-service.js";
import {
  archiveTextVersion,
  pendingArchivePages,
} from "../src/archive/text-pipeline.js";
import { emptyArchiveUsage } from "../src/archive/text-session.js";
import {
  archiveTextFixture,
  arranged,
  assigned,
  fakePages,
  fakeTextRuntime,
  memoryTextCache,
  modelTool,
} from "./archive-text-fixture.js";
import type { ModelRequest } from "../src/agents/model-protocol.js";

const method = {
  arrange: "synthetic",
  page_classify: "synthetic",
  suspects: "synthetic",
  correction: "synthetic",
  model_config_sha256: null,
};
/** An arrangement made with the notation rule, as the arrangement service makes one. */
function withRule(
  source: Awaited<ReturnType<typeof archiveTextFixture>>["source"],
  operations: readonly ArrangementOperation[] = assigned(source),
) {
  const review = reviewArrangement(source, operations);
  return acceptArrangement(
    source,
    {
      schema_version: 1,
      source_input_sha256: source.input_sha256,
      reviewed_candidates_sha256: review.candidates_sha256,
      operations,
      break_decisions: review.candidates.map((c) => ({
        candidate_id: c.candidate_id,
        decision: "keep",
        reason: "separate",
      })),
    },
    "c".repeat(64),
    { format_rule: FORMAT_RULE },
  );
}
function pageLeaves(request: ModelRequest) {
  for (const m of request.messages)
    for (const p of m.parts)
      if ("text" in p && p.text.startsWith("{")) {
        const v = JSON.parse(p.text) as Record<string, unknown>;
        if (Array.isArray(v.leaves))
          return v.leaves as { leaf: string; text: string }[];
      }
  throw Error("missing-page-input");
}

it("writes sub- and superscript tags as LaTeX and moves a closing period out of an inline formula", () => {
  // The library's own shapes: mixed citation notation and a melting point.
  expect(unifiedText("metals.<sup>4</sup> The H<sub>2</sub>O", "text")).toBe(
    "metals.$^{4}$ The H$_{2}$O",
  );
  expect(unifiedText("mp $177 - 178^{\\circ}C.$ IR", "text")).toBe(
    "mp $177 - 178^{\\circ}C$. IR",
  );
  expect(unifiedText("ends $x.$", "caption")).toBe("ends $x$.");
  expect(unifiedText("then $a.$$b$ next", "footnote")).toBe(
    "then $a$.$b$ next",
  );
  // A period followed by a letter, an ellipsis, an escaped period and display math stay.
  for (const same of [
    "$a.$b",
    "$x, y, ...$ more",
    "$\\.$ accent",
    // LaTeX's empty delimiter, as MinerU writes it in a reagent footnote.
    "$\\mathrm{H}_{2}\\mathrm{O}\\left( {{1.0}/{0.14}}\\right.$ mL),irradiated",
    "$\\left( {{1.0}}\\right.$ mL).",
    "$$\nx.\n$$",
    "<sup>$\\dagger$</sup> stays",
    "<sup>a{</sup> unbalanced",
    "<sup> </sup> empty",
    "$x <sup>2</sup>$ inside math",
  ])
    expect(unifiedText(same, "text")).toBe(same);
  // Table HTML, images and display equations keep their text.
  for (const type of ["table", "image", "equation"])
    expect(formatEdits("<sup>4</sup> $x.$", type)).toEqual([]);
  // Code points, not UTF-16 units.
  const text = "😀<sup>4</sup> 😀 $x.$",
    edits = formatEdits(text, "text");
  expect(edits.map((e) => [e.start, e.end, e.original, e.rule])).toEqual([
    [1, 13, "<sup>4</sup>", `${FORMAT_RULE}/superscript`],
    [18, 20, ".$", `${FORMAT_RULE}/formula-period`],
  ]);
  expect(applyFormatEdits(text, edits)).toBe("😀$^{4}$ 😀 $x$.");
});

it("maps a cut in the unified text back to the original text", () => {
  const text = "A<sup>4</sup> B. Next",
    edits = formatEdits(text, "text"),
    unified = applyFormatEdits(text, edits);
  expect(unified).toBe("A$^{4}$ B. Next");
  const cut = (at: string, s: string) => [...s.slice(0, s.indexOf(at))].length;
  expect(originalOffset(edits, cut("Next", unified))).toBe(cut("Next", text));
  expect(originalOffset(edits, cut(" B", unified))).toBe(cut(" B", text));
  // Inside the replacement: the cut stays before the edit.
  expect(originalOffset(edits, 3)).toBe(1);
  expect(originalOffset(edits, 0)).toBe(0);
});

it("records the notation edits as program corrections of the page, keeps the model's request unchanged and lets a person's text win", async () => {
  const body = "The H<sup>1</sup> NMR showed mp $177 - 178^{\\circ}C.$",
    f = await archiveTextFixture([{ text: body }, { text: "Plain text." }], {
      layers: ["The H1 NMR showed mp 177 - 178 °C. Plain text."],
    });
  const seen: string[][] = [];
  const runtime = fakeTextRuntime(async (request) => {
    const leaves = pageLeaves(request);
    seen.push(leaves.map((l) => l.text));
    // The model happens to make the same edit the program made: it is not made twice.
    return modelTool("submit_corrections", {
      corrections: [
        {
          leaf: leaves[0]!.leaf,
          original: "<sup>1</sup>",
          replacement: "$^{1}$",
          reason: "superscript",
        },
      ],
      uncertain: [],
    });
  });
  try {
    const snapshot = withRule(f.source),
      cache = memoryTextCache().cache,
      result = await new ArchivePageProofreadService(
        runtime,
        fakePages(f.pages),
        cache,
      ).build(f.source, snapshot, f.pages);
    // The page request is unchanged: it carries the parser's text.
    expect(seen).toEqual([[body, "Plain text."]]);
    const page = result.pages[0]!;
    expect(page.status).toBe("accepted");
    expect(page.review!.refused).toEqual([]);
    expect(
      page.corrections.map((c) => [c.source, c.rule, c.operation.replacement]),
    ).toEqual([
      ["program", `${FORMAT_RULE}/superscript`, "$^{1}$"],
      ["program", `${FORMAT_RULE}/formula-period`, "$."],
    ]);
    expect(parsePageProofreadRecord(page, 1)).toEqual(page);
    const output = await archiveTextVersion(
      f.source,
      snapshot,
      result.pages,
      emptyArchiveUsage(),
      method,
      [],
      null,
    );
    expect(output.bundle.leaves[0]).toMatchObject({
      corrected_text: "The H$^{1}$ NMR showed mp $177 - 178^{\\circ}C$.",
      text_source: "parser",
    });
    expect(output.bundle.leaves[1]!.correction_ids).toEqual([]);
    // A person's locked text replaces the leaf; the program does not edit it.
    const locked = await new ArchivePageProofreadService(
      runtime,
      fakePages(f.pages),
      memoryTextCache().cache,
    ).build(f.source, snapshot, f.pages, undefined, [
      {
        leaf_id: snapshot.leaves[0]!.leaf_id,
        replacement: body,
        decision_id: "00000000-0000-0000-0000-000000000123",
      },
    ]);
    expect(locked.pages[0]!.corrections).toEqual([]);
  } finally {
    await runtime.close();
  }
});

it("adds no program correction to an arrangement made before the rule", async () => {
  const f = await archiveTextFixture([{ text: "A<sup>4</sup> $x.$" }]),
    runtime = fakeTextRuntime(async () =>
      modelTool("submit_corrections", { corrections: [], uncertain: [] }),
    );
  try {
    const snapshot = arranged(f.source);
    expect(snapshot.format_rule).toBeUndefined();
    const result = await new ArchivePageProofreadService(
      runtime,
      fakePages(f.pages),
      memoryTextCache().cache,
    ).build(f.source, snapshot, f.pages);
    expect(result.pages[0]!.corrections).toEqual([]);
  } finally {
    await runtime.close();
  }
});

it("lets an unreviewed long-document page carry program corrections with a draft basis", async () => {
  const f = await archiveTextFixture([{ text: "A<sup>4</sup> text." }], {
      page_count: 51,
    }),
    review = reviewArrangement(f.source, assigned(f.source));
  const snapshot = acceptArrangement(
    f.source,
    {
      schema_version: 1,
      source_input_sha256: f.source.input_sha256,
      reviewed_candidates_sha256: review.candidates_sha256,
      operations: assigned(f.source),
      break_decisions: [],
    },
    "c".repeat(64),
    {
      format_rule: FORMAT_RULE,
      classification: {
        pages: 51,
        arrange_input_bytes: 10,
        reasons: ["pages"],
      },
    },
  );
  const runtime = fakeTextRuntime(async () => {
    throw Error("no model on unreviewed pages");
  });
  try {
    const result = await new ArchivePageProofreadService(
      runtime,
      fakePages(f.pages),
      memoryTextCache().cache,
    ).build(
      f.source,
      snapshot,
      f.pages,
      undefined,
      [],
      undefined,
      undefined,
      true,
    );
    const page = result.pages[0]!;
    expect(page.status).toBe("unreviewed");
    expect(page.corrections.map((c) => c.source)).toEqual(["program"]);
    const output = await archiveTextVersion(
      f.source,
      snapshot,
      result.pages,
      emptyArchiveUsage(),
      method,
      [],
      null,
    );
    expect(output.bundle.leaves[0]).toMatchObject({
      corrected_text: "A$^{4}$ text.",
      text_source: "parser",
    });
    expect(DRAFT_BASES).toContain(output.bundle.leaves[0]!.basis);
    // Without its correction a changed draft text is still refused.
    expect(() =>
      parseArchiveTextBundleV2({
        ...output.bundle,
        leaves: output.bundle.leaves.map((l) => ({ ...l, correction_ids: [] })),
      }),
    ).toThrow();
  } finally {
    await runtime.close();
  }
});

it("reuses an arrangement made before the rule on a normal resume and arranges it again only for from_step arrange (ADR 0074 §6)", async () => {
  const e = await archiveFixture();
  try {
    await e.app.documentProcessing.parseDocuments(e.rawParseRequest);
    const pipeline = e.app.archiveText!,
      first = await pipeline.arrange(e.asset.asset_id, "full"),
      stored = (await pipeline.storage.load(first.proofread_id))!;
    expect(stored.bundle.arrangement!.format_rule).toBe(FORMAT_RULE);
    // The step identity a version records is unchanged, so old versions still match.
    expect(stored.version.method.arrange).toBe(
      "arrangement-operations-v2/arrangement-single-pass-v2/paragraph-break-v3",
    );
    // A current arrangement is reused, with or without from_step arrange.
    let calls = e.modelCalls;
    expect(await pipeline.arrange(e.asset.asset_id, "full")).toMatchObject({
      reused: true,
    });
    expect(
      await pipeline.arrange(e.asset.asset_id, "full", undefined, true),
    ).toMatchObject({ reused: true });
    expect(e.modelCalls).toBe(calls);
    // The same version as an existing document arranged before the rule has it.
    const load = pipeline.storage.load.bind(pipeline.storage);
    vi.spyOn(pipeline.storage, "load").mockImplementation(async (...args) => {
      const out = await load(...args);
      if (!out?.bundle.arrangement) return out;
      const { format_rule, ...arrangement } = out.bundle.arrangement;
      void format_rule;
      return { ...out, bundle: { ...out.bundle, arrangement } };
    });
    expect(await pipeline.arrange(e.asset.asset_id, "full")).toMatchObject({
      reused: true,
    });
    expect(e.modelCalls).toBe(calls);
    calls = e.modelCalls;
    const again = await pipeline.arrange(
      e.asset.asset_id,
      "full",
      undefined,
      true,
    );
    // It goes back to the arrangement service. This one answers from the checkpoint
    // its first run saved under the current rule; an old document has none and asks.
    expect(again).not.toHaveProperty("reused", true);
    expect(e.modelCalls).toBe(calls);
  } finally {
    await e.close();
  }
}, 30000);
it("keeps pending pages of a new arrangement free of corrections until proofreading", async () => {
  const f = await archiveTextFixture([{ text: "A<sup>4</sup>." }]),
    snapshot = withRule(f.source);
  expect(snapshot.format_rule).toBe(FORMAT_RULE);
  expect(
    pendingArchivePages(f.source, snapshot).flatMap((p) => p.corrections),
  ).toEqual([]);
});
