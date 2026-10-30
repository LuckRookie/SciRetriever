import { expect, it } from "vitest";
import type {
  ArrangementOperation,
  CorrectOperation,
} from "@sciretriever/contracts";
import { AgentFailure } from "../src/agents/protocol.js";
import type { ModelRequest } from "../src/agents/model-protocol.js";
import { ArchivePageProofreadService } from "../src/proofread/page-service.js";
import { applyLeafCorrections } from "../src/proofread/leaf-corrections.js";
import { arrangementLeafId } from "../src/archive/arrangement.js";
import { textHash } from "../src/archive/text-source.js";
import {
  archiveTextFixture,
  arranged,
  assigned,
  fakePages,
  fakeTextRuntime,
  initialPage,
  memoryTextCache,
  modelTool,
} from "./archive-text-fixture.js";
const hash = "d".repeat(64);
/** The page JSON the host sent: leaves, differences, figure text. */
function pageInput(request: ModelRequest) {
  for (const m of request.messages)
    for (const p of m.parts)
      if ("text" in p && p.text.startsWith("{")) {
        const v = JSON.parse(p.text) as Record<string, unknown>;
        if (Array.isArray(v.leaves))
          return v as {
            page_index: number;
            leaves: { leaf: string; type: string; text: string }[];
            differences?: {
              leaf: string;
              parsed: string;
              text_layer: string;
            }[];
            note?: string;
          };
      }
  throw Error("missing-page-input");
}
const submit = (
  corrections: {
    leaf: string;
    original: string;
    replacement: string;
    reason: string;
  }[] = [],
  uncertain: { leaf: string; text: string; reason: string }[] = [],
) => modelTool("submit_corrections", { corrections, uncertain });

it("sends one request per page with the page image, its leaves and the text-layer differences", async () => {
  const f = await archiveTextFixture(
      [
        {
          text: "The sample was heated to 50 °C for 2 h and then cooled slowly.",
        },
      ],
      {
        layers: [
          "The sample was heated to 60 °C for 2 h and then cooled slowly.",
        ],
      },
    ),
    requests: ModelRequest[] = [];
  const runtime = fakeTextRuntime(async (request) => {
    requests.push(request);
    const input = pageInput(request);
    return submit([
      {
        leaf: input.leaves[0]!.leaf,
        original: "50 °C",
        replacement: "60 °C",
        reason: "image",
      },
    ]);
  });
  try {
    const result = await new ArchivePageProofreadService(
      runtime,
      fakePages(f.pages),
      memoryTextCache().cache,
    ).build(f.source, arranged(f.source), f.pages);
    expect(requests).toHaveLength(1);
    const first = requests[0]!.messages.find((m) => m.role === "user")!;
    expect("data" in first.parts[0]!).toBe(true);
    expect(requests[0]!.tool_choice).toBe("required");
    expect(pageInput(requests[0]!)).toMatchObject({
      page_index: 0,
      leaves: [{ leaf: "b1", type: "text" }],
      differences: [{ leaf: "b1", parsed: "50", text_layer: "60" }],
    });
    const page = result.pages[0]!;
    expect(result.complete).toBe(true);
    expect(page.status).toBe("accepted");
    expect(page.corrections.map((c) => c.operation.replacement)).toEqual([
      "60 °C",
    ]);
    expect(page.evidence.viewed_full_page).toBe(true);
    expect(page.review).toEqual({ refused: [], uncertain: [] });
    expect(result.usage.calls).toBe(1);
  } finally {
    await runtime.close();
  }
});

it("refuses edits that fail the program checks, keeps them in the review notes and corrects repeats everywhere", async () => {
  const text =
    "Pd2(dbab)3 and Pd2(dbab)3 gave 3a in 85% yield; see Seo, J.; Jeon, I.; Ryu, T. for details.";
  const f = await archiveTextFixture([{ text }], {
    layers: [text.replaceAll("dbab", "dba")],
  });
  const runtime = fakeTextRuntime(async (request) => {
    const b = pageInput(request).leaves[0]!.leaf;
    return submit(
      [
        {
          leaf: b,
          original: "Pd2(dbab)3",
          replacement: "Pd2(dba)3",
          reason: "printed dba",
        },
        {
          leaf: b,
          original: "Jeon, I.",
          replacement: "Jeon, J.",
          reason: "initial",
        },
        { leaf: b, original: "", replacement: "Figure 2", reason: "drawn" },
        {
          leaf: b,
          original: "for details.",
          replacement: "for details. © 2024 Elsevier",
          reason: "footer",
        },
        { leaf: b, original: "85% yield", replacement: "% yield", reason: "x" },
        {
          leaf: "b9",
          original: "3a",
          replacement: "3b",
          reason: "unknown leaf",
        },
      ],
      [{ leaf: b, text: "Ryu, T.", reason: "blurred" }],
    );
  });
  try {
    const result = await new ArchivePageProofreadService(
      runtime,
      fakePages(f.pages),
      memoryTextCache().cache,
    ).build(f.source, arranged(f.source), f.pages);
    const page = result.pages[0]!;
    expect(page.status).toBe("accepted");
    expect(
      page.corrections.map((c) => [c.operation.start, c.operation.replacement]),
    ).toEqual([
      [0, "Pd2(dba)3"],
      [15, "Pd2(dba)3"],
    ]);
    expect(page.review!.refused.map((r) => r.rule)).toEqual([
      "not-printed",
      "insert-from-nothing",
      "copyright",
      "drops-digits",
    ]);
    expect(page.review!.uncertain).toEqual([
      expect.objectContaining({ leaf_id: null, text: "3a" }),
      expect.objectContaining({
        leaf_id: page.retained_leaf_ids[0],
        text: "Ryu, T.",
      }),
    ]);
  } finally {
    await runtime.close();
  }
});

it("takes a DOI as the text layer prints it and never edits a leaf a person fixed", async () => {
  const f = await archiveTextFixture(
      [
        {
          text: "Available at https://doi.org/10.1002/smssc.202300070 online.",
        },
        { text: "Manually fixed sentence with a typo here." },
      ],
      {
        layers: [
          "Available at https://doi.org/10.1002/smsc.202300070 online. Manually fixed sentence with a typo here.",
        ],
      },
    ),
    snapshot = arranged(f.source),
    locked = snapshot.leaves[1]!;
  const runtime = fakeTextRuntime(async (request) =>
    submit([
      {
        leaf: pageInput(request).leaves[1]!.leaf,
        original: "typo",
        replacement: "tpyo",
        reason: "x",
      },
    ]),
  );
  try {
    const result = await new ArchivePageProofreadService(
      runtime,
      fakePages(f.pages),
      memoryTextCache().cache,
    ).build(f.source, snapshot, f.pages, undefined, [
      {
        leaf_id: locked.leaf_id,
        replacement: "Manually fixed sentence without a typo.",
        decision_id: "00000000-0000-4000-8000-000000000123",
      },
    ]);
    const page = result.pages[0]!;
    expect(
      page.corrections.map((c) => [c.source, c.operation.replacement]).sort(),
    ).toEqual([
      ["agent", "https://doi.org/10.1002/smsc.202300070"],
      ["manual", "Manually fixed sentence without a typo."],
    ]);
    expect(page.review!.refused).toEqual([
      expect.objectContaining({ leaf_id: locked.leaf_id, rule: "locked" }),
    ]);
  } finally {
    await runtime.close();
  }
});

it("sends a failed request once more, then records only that page as failed", async () => {
  const f = await archiveTextFixture([
      { text: "FIRSTPAGE synthetic.", page: 0 },
      { text: "SECONDPAGE synthetic.", page: 1 },
    ]),
    snapshot = arranged(f.source),
    cache = memoryTextCache(),
    visited: number[] = [];
  let failing = new Set([0, 1]);
  const runtime = fakeTextRuntime(async (request) => {
    const { page_index } = initialPage(request);
    visited.push(page_index);
    if (failing.has(page_index)) throw new AgentFailure("agent-response-limit");
    return submit();
  });
  try {
    const service = new ArchivePageProofreadService(
      runtime,
      fakePages(f.pages),
      cache.cache,
    );
    const first = await service.build(f.source, snapshot, f.pages);
    expect(first.pages.map((p) => p.status)).toEqual(["failed", "failed"]);
    expect(visited.sort()).toEqual([0, 0, 1, 1]);
    expect(first.pages[0]!.usage.calls).toBe(2);
    // A selected retry runs page 0 only and leaves page 1's record as it was.
    failing = new Set();
    visited.length = 0;
    const second = await service.build(
      f.source,
      snapshot,
      f.pages,
      undefined,
      [],
      undefined,
      new Map([[1, first.pages[1]!]]),
    );
    expect(visited).toEqual([0]);
    expect(second.pages.map((p) => p.status)).toEqual(["accepted", "failed"]);
    expect(second.pages[1]).toEqual(first.pages[1]);
    expect(second.untouched_page_indexes).toEqual([1]);
    expect(second.usage.calls).toBe(1);
    visited.length = 0;
    const third = await service.build(
      f.source,
      snapshot,
      f.pages,
      undefined,
      [],
      undefined,
      new Map([[0, second.pages[0]!]]),
    );
    expect(visited).toEqual([1]);
    expect(third.complete).toBe(true);
    expect(third.reused_page_indexes).toEqual([0]);
  } finally {
    await runtime.close();
  }
});

it("isolates page context and reuses unchanged page inputs after rearrangement", async () => {
  const f = await archiveTextFixture([
      { text: "FIRSTPAGE secret synthetic.", page: 0 },
      { text: "SECONDPAGE synthetic.", page: 1 },
      { text: "SECONDNOTE synthetic.", page: 1 },
      { text: "THIRDPAGE synthetic.", page: 2 },
    ]),
    snapshot = arranged(f.source),
    cache = memoryTextCache(),
    seenPages: number[] = [];
  const runtime = fakeTextRuntime(async (request) => {
    const { page_index } = initialPage(request);
    seenPages.push(page_index);
    const body = JSON.stringify(request.messages);
    for (const [index, marker] of [
      "FIRSTPAGE",
      "SECONDPAGE",
      "THIRDPAGE",
    ].entries())
      if (index !== page_index) expect(body).not.toContain(marker);
    return submit();
  });
  try {
    const service = () =>
      new ArchivePageProofreadService(runtime, fakePages(f.pages), cache.cache);
    const first = await service().build(f.source, snapshot, f.pages);
    expect(first.complete).toBe(true);
    expect(seenPages.sort()).toEqual([0, 1, 2]);
    seenPages.length = 0;
    const second = await service().build(f.source, snapshot, f.pages);
    expect(second.reused_page_indexes).toEqual([0, 1, 2]);
    expect(seenPages).toEqual([]);
    const changed = assigned(f.source),
      leaf = snapshot.leaves[2]!;
    changed[2] = { kind: "drop", leaf_id: leaf.leaf_id, reason: "footer" };
    const third = await service().build(
      f.source,
      arranged(f.source, changed),
      f.pages,
    );
    expect(third.complete).toBe(true);
    expect(third.reused_page_indexes).toEqual([0, 2]);
    expect(seenPages).toEqual([1]);
    expect(third.pages[1]!.page_input_sha256).not.toBe(
      second.pages[1]!.page_input_sha256,
    );
  } finally {
    await runtime.close();
  }
});

it("ends a page with a typed page-tools stop and no request when image rendering fails", async () => {
  const f = await archiveTextFixture([{ text: "Content." }]),
    runtime = fakeTextRuntime(async () => submit());
  try {
    const result = await new ArchivePageProofreadService(
      runtime,
      {
        ...fakePages(f.pages),
        image: async () => {
          throw Error("synthetic-render-failure");
        },
      },
      memoryTextCache().cache,
    ).build(f.source, arranged(f.source), f.pages);
    expect(result.complete).toBe(false);
    expect(result.pages[0]!.stop).toMatchObject({
      code: "page-tools-unavailable",
      page_index: 0,
      scope: "page",
    });
    expect(result.usage.calls).toBe(0);
  } finally {
    await runtime.close();
  }
});
it("applies leaf-local code-point corrections with an exact raw span, including insertions and deletions", async () => {
  const f = await archiveTextFixture([{ text: "prefix:A😀B12Z" }]),
    root = f.source.blocks[0]!,
    start = 7,
    id = arrangementLeafId(
      root.root_block_id,
      start,
      [...root.text].length,
      f.source.raw.result_sha256,
    ),
    ops: ArrangementOperation[] = [
      { kind: "split", root_block_id: root.root_block_id, cuts: [start] },
      {
        kind: "drop",
        leaf_id: arrangementLeafId(
          root.root_block_id,
          0,
          start,
          f.source.raw.result_sha256,
        ),
        reason: "interface",
      },
      {
        kind: "assign",
        leaf_id: id,
        target: { role: "methods" },
        presentation: { kind: "content" },
      },
    ],
    snapshot = arranged(f.source, ops),
    leaf = snapshot.leaves[1]!;
  const correct: CorrectOperation = {
    kind: "correct",
    leaf_id: id,
    start: 1,
    end: 2,
    original: "😀",
    replacement: "β",
    basis_page_index: 0,
    reason: "image",
  };
  const result = applyLeafCorrections(
    [leaf],
    [
      correct,
      { ...correct, start: 3, end: 5, original: "12", replacement: "" },
      { ...correct, start: 6, end: 6, original: "", replacement: "!" },
    ],
    0,
    hash,
  );
  expect(result.texts.get(id)).toBe("AβBZ!");
  expect(result.records[0]!.source_span).toMatchObject({
    root_block_id: root.root_block_id,
    start: 8,
    end: 9,
  });
  for (const invalid of [
    { ...correct, original: "B" },
    { ...correct, basis_page_index: 1 },
    { ...correct, leaf_id: snapshot.leaves[0]!.leaf_id },
    { ...correct, end: 99, original: "x" },
  ])
    expect(() => applyLeafCorrections([leaf], [invalid], 0, hash)).toThrow();
  expect(() =>
    applyLeafCorrections([leaf], [correct, correct], 0, hash),
  ).toThrow();
  expect(() =>
    applyLeafCorrections([leaf], [correct], 0, hash, new Set([id])),
  ).toThrow();
});
it("refuses overlapping edits and flattened table corrections while retaining valid table markup", async () => {
  const html = "<table><tr><td>67</td></tr></table>",
    f = await archiveTextFixture([{ type: "table", text: "67", html }]),
    leaf = arranged(f.source).leaves[0]!,
    offset = [...html.slice(0, html.indexOf("67"))].length;
  const correct: CorrectOperation = {
    kind: "correct",
    leaf_id: leaf.leaf_id,
    start: offset,
    end: offset + 2,
    original: "67",
    replacement: "97",
    basis_page_index: 0,
    reason: "image",
  };
  expect(
    applyLeafCorrections([leaf], [correct], 0, hash).texts.get(leaf.leaf_id),
  ).toBe(html.replace("67", "97"));
  expect(() =>
    applyLeafCorrections(
      [leaf],
      [
        {
          ...correct,
          start: 0,
          end: [...html].length,
          original: html,
          replacement: "97",
        },
      ],
      0,
      hash,
    ),
  ).toThrow();
  expect(() =>
    applyLeafCorrections(
      [leaf],
      [
        correct,
        {
          ...correct,
          start: offset + 1,
          end: offset + 2,
          original: "7",
          replacement: "9",
        },
      ],
      0,
      hash,
    ),
  ).toThrow();
});
it("does not call a model for classified or missing pages, and reports a nonblocking content gap without inventing leaves", async () => {
  const f = await archiveTextFixture(
      [{ text: "Page header.", type: "header" }],
      { page_count: 2, layers: ["Page header.", "This body was not parsed."] },
    ),
    operation = assigned(f.source)[0]!,
    id = "leaf_id" in operation ? operation.leaf_id : "",
    snapshot = arranged(f.source, [
      { kind: "drop", leaf_id: id, reason: "header" },
    ]);
  let calls = 0;
  const runtime = fakeTextRuntime(async () => {
    calls++;
    throw Error("model-not-allowed");
  });
  try {
    const result = await new ArchivePageProofreadService(
      runtime,
      fakePages(f.pages),
      memoryTextCache().cache,
    ).build(f.source, snapshot, f.pages);
    expect(result.complete).toBe(true);
    expect(result.pages.map((p) => p.not_required_reason)).toEqual([
      "all-content-classified",
      "no-retained-content",
    ]);
    expect(result.issues).toEqual([
      { code: "page-content-missing", page_index: 1, affects_readiness: false },
    ]);
    expect(result.usage.calls).toBe(0);
    expect(calls).toBe(0);
    expect(snapshot.leaves).toHaveLength(1);
  } finally {
    await runtime.close();
  }
});
it("rejects a changed source mapping or missing page inspection before any model call", async () => {
  const f = await archiveTextFixture([{ text: "Stable." }]),
    snapshot = arranged(f.source),
    runtime = fakeTextRuntime(async () => {
      throw Error("forbidden");
    });
  try {
    const service = new ArchivePageProofreadService(
      runtime,
      fakePages(f.pages),
      memoryTextCache().cache,
    );
    await expect(
      service.build(
        f.source,
        { ...snapshot, source_input_sha256: textHash("other") },
        f.pages,
      ),
    ).rejects.toThrow();
    await expect(service.build(f.source, snapshot, [])).rejects.toMatchObject({
      code: "source-integrity",
    });
  } finally {
    await runtime.close();
  }
});
it("compares retained text with the text layer after removing notation differences", async () => {
  const { comparableTokens } = await import("../src/proofread/suspects.js");
  // Text layer (left) and parser text (right) from a real ACS page, 2026-10-28.
  expect(
    comparableTokens(
      "Over 20 syntheses of sparteine.4 Its antiar-\nrhythmic use (±)-sparteine and η2 binding were sup-\npressed",
    ),
  ).toEqual(
    comparableTokens(
      "Over 20 syntheses of sparteine.$^{4}$ Its antiarrhythmic use $(\\pm)$-sparteine and $\\eta^2$ binding were suppressed",
    ),
  );
  // A real Wiley page: 27 suspects were a number glued to its unit, and the
  // model spent the page inserting thin spaces.
  expect(
    comparableTokens(
      "$200\\mathrm{mL}$ water, $1\\,\\mathrm{g}$ PVP and $25~\\mathrm{mL}$",
    ),
  ).toEqual(comparableTokens("200 mL water, 1 g PVP and 25 mL"));
  // Two units fused into one name still print differently.
  expect(comparableTokens("$\\mathrm{mgcm}^{-2}$")).not.toEqual(
    comparableTokens("mg cm-2"),
  );
  // A real character difference survives.
  expect(comparableTokens("measured 4.2 eV")).not.toEqual(
    comparableTokens("measured 4.7 eV"),
  );
});
