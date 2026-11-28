import { expect, it } from "vitest";
import {
  parsePageProofreadRecord,
  type ArrangementOperation,
} from "@sciretriever/contracts";
import { FORMAT_RULE } from "../src/archive/format-normalize.js";
import {
  acceptArrangement,
  reviewArrangement,
} from "../src/archive/arrangement.js";
import {
  ArchivePageProofreadService,
  pageProofreadInputKey,
} from "../src/proofread/page-service.js";
import { SENTENCE_SPACE_RULE } from "../src/proofread/sentence-space.js";
import { LEAF_CORRECTION_METHOD } from "../src/proofread/leaf-corrections.js";
import {
  PAGE_REVIEW_METHOD,
  PAGE_REVIEW_SYSTEM,
  pageReviewPlan,
} from "../src/proofread/page-review.js";
import {
  ARCHIVE_TEXT_STOP_POLICY,
  archiveTextModelIdentity,
  emptyArchiveUsage,
} from "../src/archive/text-session.js";
import { textHash } from "../src/archive/text-source.js";
import { archiveTextVersion } from "../src/archive/text-pipeline.js";
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

type Fixture = Awaited<ReturnType<typeof archiveTextFixture>>;
/** An arrangement made with the notation rule, as the arrangement service makes one. */
function withRule(
  source: Fixture["source"],
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
const noEdits = () =>
  modelTool("submit_corrections", { corrections: [], uncertain: [] });
const method = {
  arrange: "synthetic",
  page_classify: "synthetic",
  suspects: "synthetic",
  correction: "synthetic",
  model_config_sha256: null,
};
async function proofread(
  f: Fixture,
  snapshot: ReturnType<typeof withRule>,
  answer: Parameters<typeof fakeTextRuntime>[0] = async () => noEdits(),
  cache = memoryTextCache().cache,
) {
  const seen: string[][] = [];
  const runtime = fakeTextRuntime(async (request, ...rest) => {
    seen.push(pageLeaves(request).map((l) => l.text));
    return answer(request, ...rest);
  });
  try {
    const result = await new ArchivePageProofreadService(
      runtime,
      fakePages(f.pages),
      cache,
    ).build(f.source, snapshot, f.pages);
    const texts = (
      await archiveTextVersion(
        f.source,
        snapshot,
        result.pages,
        emptyArchiveUsage(),
        method,
        [],
        null,
      )
    ).bundle.leaves.map((l) => l.corrected_text);
    return { result, seen, texts, runtime };
  } finally {
    await runtime.close();
  }
}
const spaceRules = (r: Awaited<ReturnType<typeof proofread>>) =>
  r.result.pages.flatMap((p) =>
    p.corrections.map((c) => [
      c.source,
      c.rule,
      c.operation.original,
      c.operation.replacement,
    ]),
  );

it("puts back the space after a period where the trusted text layer prints a space or a line break, and sends the model the parser's text", async () => {
  const one = "The solid was collected (85% yield).MP 120 °C was measured.",
    two = "Found C 54.31 and H 110.37.IR (KBr) bands were strong.",
    three = "Compound C1.Red crystals formed after washing with water.",
    f = await archiveTextFixture(
      [{ text: one }, { text: two }, { text: three }],
      {
        layers: [
          "The solid was collected (85% yield). MP 120 °C was measured.\n" +
            "Found C 54.31 and H 110.37.\nIR (KBr) bands were strong.\n" +
            "Compound C1.  Red crystals formed after washing with water.",
        ],
      },
    );
  const r = await proofread(f, withRule(f.source));
  expect(r.seen).toEqual([[one, two, three]]);
  const page = r.result.pages[0]!;
  expect(page.status).toBe("accepted");
  expect(spaceRules(r)).toEqual([
    ["program", SENTENCE_SPACE_RULE, ".", ". "],
    ["program", SENTENCE_SPACE_RULE, ".", ". "],
    ["program", SENTENCE_SPACE_RULE, ".", ". "],
  ]);
  expect(parsePageProofreadRecord(page, 1)).toEqual(page);
  expect(r.texts).toEqual([
    "The solid was collected (85% yield). MP 120 °C was measured.",
    "Found C 54.31 and H 110.37. IR (KBr) bands were strong.",
    "Compound C1. Red crystals formed after washing with water.",
  ]);
  // The cached page is reused as it is.
  const cache = memoryTextCache().cache;
  await proofread(f, withRule(f.source), undefined, cache);
  const again = await proofread(
    f,
    withRule(f.source),
    async () => {
      throw Error("no model on a cached page");
    },
    cache,
  );
  expect(again.result.reused_page_indexes).toEqual([0]);
  expect(again.texts).toEqual(r.texts);
});

it("leaves a period glued where the text layer is glued too, inside formulas, and where the place is not in the text layer", async () => {
  const contents = "10.Relativistic effects and 11.Korringa relations follow.",
    code = "The parser reads outputs.Vasprun files from each run directory.",
    formula = "We define $C1.Red$ and $$x.Ab$$ for the reduced state here.",
    missing = "The value rose sharply.Then the sample cooled down slowly.",
    comma = "Data were saved.Later analysis followed in the same lab.",
    f = await archiveTextFixture(
      [
        { text: contents },
        { text: code },
        { text: formula },
        { text: missing },
        { text: comma },
      ],
      {
        layers: [
          [
            contents,
            code,
            "We define C1. Red and x. Ab for the reduced state here.",
            // The word after the period is not the leaf's.
            "The value rose sharply. the sample cooled down slowly.",
            // The text layer prints another character between the two words.
            "Data were saved,Later analysis followed in the same lab.",
          ].join("\n"),
        ],
      },
    );
  const r = await proofread(f, withRule(f.source));
  expect(r.result.pages[0]!.status).toBe("accepted");
  expect(spaceRules(r)).toEqual([]);
  expect(r.texts).toEqual([contents, code, formula, missing, comma]);
});

it("does nothing on a page without a trusted text layer", async () => {
  const glued = "The solid was collected (85% yield).MP 120 °C was measured.";
  // No text layer at all.
  const image = await archiveTextFixture([{ text: glued }], { layers: [""] });
  expect(image.pages[0]!.kind).toBe("image-only");
  expect(spaceRules(await proofread(image, withRule(image.source)))).toEqual(
    [],
  );
  // A text layer that matches too little of the page to be trusted.
  const other =
      "Alpha beta gamma delta epsilon zeta eta theta iota kappa lambda.",
    poor = await archiveTextFixture([{ text: glued }, { text: other }], {
      layers: [
        "The solid was collected (85% yield). MP 120 °C was measured.\n" +
          "Alpha beta gamma delta one two three four five six seven.",
      ],
    });
  const snapshot = withRule(poor.source),
    plan = pageReviewPlan(poor.pages[0]!, snapshot.leaves);
  expect([plan.trusted, plan.figure_leaf_ids]).toEqual([false, []]);
  const r = await proofread(poor, snapshot);
  expect(r.result.pages[0]!.status).toBe("accepted");
  expect(spaceRules(r)).toEqual([]);
  expect(r.texts[0]).toBe(glued);
});

it("adds nothing to an arrangement made before the rule and keeps its page input key and cached page (ADR 0074 §6)", async () => {
  const glued = "The solid was collected (85% yield).MP 120 °C was measured.",
    f = await archiveTextFixture([{ text: glued }], {
      layers: ["The solid was collected (85% yield). MP 120 °C was measured."],
    });
  const snapshot = arranged(f.source);
  expect(snapshot.format_rule).toBeUndefined();
  const cache = memoryTextCache().cache,
    r = await proofread(f, snapshot, undefined, cache);
  expect(spaceRules(r)).toEqual([]);
  expect(r.texts).toEqual([glued]);
  // The key is the one an old document was proofread under: no program part.
  const key = pageProofreadInputKey(
    f.source,
    snapshot.leaves,
    [],
    f.pages[0]!,
    textHash({
      correction: LEAF_CORRECTION_METHOD,
      review: PAGE_REVIEW_METHOD,
      prompt: textHash(PAGE_REVIEW_SYSTEM),
      pages: fakePages().method,
      stop: ARCHIVE_TEXT_STOP_POLICY,
      model: archiveTextModelIdentity(r.runtime),
    }),
  );
  expect(r.result.pages[0]!.page_input_sha256).toBe(key);
  const again = await proofread(
    f,
    snapshot,
    async () => {
      throw Error("no model on a cached page");
    },
    cache,
  );
  expect(again.result.reused_page_indexes).toEqual([0]);
  // Under the rule the same page is a different input.
  const ruled = await proofread(f, withRule(f.source));
  expect(ruled.result.pages[0]!.page_input_sha256).not.toBe(key);
});

it("records an identical model edit once and refuses one that overlaps the program's space", async () => {
  const glued = "The yield was 85%.Melting point 120 °C",
    f = await archiveTextFixture([{ text: glued }], {
      layers: ["The yield was 85%. Melting point 120 °C"],
    });
  const r = await proofread(f, withRule(f.source), async (request) => {
    const leaf = pageLeaves(request)[0]!.leaf;
    return modelTool("submit_corrections", {
      corrections: [
        { leaf, original: ".", replacement: ". ", reason: "space" },
        {
          leaf,
          original: "85%.Melting",
          replacement: "85%. Melting",
          reason: "space",
        },
      ],
      uncertain: [],
    });
  });
  const page = r.result.pages[0]!;
  expect(page.status).toBe("accepted");
  expect(spaceRules(r)).toEqual([["program", SENTENCE_SPACE_RULE, ".", ". "]]);
  expect(page.review!.refused.map((x) => [x.original, x.rule])).toEqual([
    ["85%.Melting", "conflict"],
  ]);
  expect(r.texts).toEqual(["The yield was 85%. Melting point 120 °C"]);
});
