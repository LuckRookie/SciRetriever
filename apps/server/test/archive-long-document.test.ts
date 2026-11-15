import { expect, it } from "vitest";
import {
  ARRANGE_INPUT_MAX_BYTES,
  classifyArchiveDocument,
  canonicalJsonBytes,
} from "@sciretriever/contracts";
import { ArchiveArrangementService } from "../src/archive/arrangement-service.js";
import { boundedArrangementBatches } from "../src/archive/arrangement-batches.js";
import { ArchivePageProofreadService } from "../src/proofread/page-service.js";
import {
  archiveTextVersion,
  pendingArchivePages,
} from "../src/archive/text-pipeline.js";
import { byteHash } from "../src/archive/text-source.js";
import { emptyArchiveUsage } from "../src/archive/text-session.js";
import { renderArrangement } from "../src/archive/render.js";
import {
  acceptArrangement,
  reviewArrangement,
  verifyArrangement,
} from "../src/archive/arrangement.js";
import {
  archiveTextFixture,
  assigned,
  fakePages,
  fakeTextRuntime,
  memoryTextCache,
  modelTool,
} from "./archive-text-fixture.js";
import type { ModelRequest } from "../src/agents/model-protocol.js";

function input(request: ModelRequest): Record<string, unknown> {
  for (const m of request.messages)
    if (m.role === "user")
      for (const p of m.parts)
        if ("text" in p && p.text.startsWith("{")) return JSON.parse(p.text);
  throw Error("Missing fixture input");
}
const answer = (
  blocks: { id: string }[],
  role = "methods",
  heading: string | null = null,
) =>
  modelTool("submit_arrangement", {
    sections: [
      { first: blocks[0]!.id, last: blocks.at(-1)!.id, role, heading },
    ],
    headings: [],
    drops: [],
    captions: [],
    splits: [],
  });

const fixtureMethod = {
  arrange: "fixture",
  page_classify: "fixture",
  suspects: "fixture",
  correction: "fixture",
  model_config_sha256: null,
};
function classifiedSnapshot(
  source: Awaited<ReturnType<typeof archiveTextFixture>>["source"],
) {
  const operations = assigned(source),
    review = reviewArrangement(source, operations);
  return acceptArrangement(
    source,
    {
      schema_version: 1,
      source_input_sha256: source.input_sha256,
      reviewed_candidates_sha256: review.candidates_sha256,
      operations,
      break_decisions: [],
    },
    "c".repeat(64),
    { classification: classifyArchiveDocument(source.raw.page_count, 100) },
  );
}

it("keeps ordinary proofread content, Markdown and structure bytes at the pre-v5 fingerprints", async () => {
  const f = await archiveTextFixture([
    { text: "Original heading", type: "title" },
    { text: "Aligned original text α🙂." },
    { text: "E = mc^2", type: "equation", image: true, page: 1 },
  ]);
  const snapshot = classifiedSnapshot(f.source),
    output = await archiveTextVersion(
      f.source,
      snapshot,
      pendingArchivePages(f.source, snapshot),
      emptyArchiveUsage(),
      fixtureMethod,
      [],
      null,
    ),
    rendered = renderArrangement(output.bundle, f.source.raw.resources);
  expect({
    content: byteHash(canonicalJsonBytes(output.bundle)),
    markdown: byteHash(rendered.markdown),
    structure: rendered.sha256,
  }).toEqual({
    content: "d27b337a5c7ae0880bc79163e1626cdc67496f39d2556822dd773f3cfee412f9",
    markdown:
      "7a989d1aa9bb0dbff81efd476fd5fa170a8f44688bd5ba749b608794f7f8c4a7",
    structure:
      "ca486bf10aadf8e0e7e6739ee973548bb6cdbb49f98f16e48d70c595b1296c01",
  });
});

it("compares every retained unreviewed long-document leaf using the draft rule without page tools", async () => {
  const f = await archiveTextFixture(
    [
      { text: "Aligned original text." },
      { text: "We observed 18 molecules in the synthetic sample.", page: 1 },
      { text: "Scanned text remains unchanged.", page: 2 },
    ],
    {
      page_count: 51,
      layers: [
        "Aligned original text.",
        "We observed 19 molecules in the synthetic sample.",
        "",
      ],
    },
  );
  const snapshot = classifiedSnapshot(f.source),
    pages = pendingArchivePages(f.source, snapshot).map((page) =>
      page.retained_leaf_ids.length
        ? {
            ...page,
            status: "unreviewed" as const,
            unreviewed_reason: "long-document" as const,
            stop: null,
          }
        : page,
    ),
    output = await archiveTextVersion(
      f.source,
      snapshot,
      pages,
      emptyArchiveUsage(),
      fixtureMethod,
      [],
      null,
    );
  expect(output.bundle.leaves.map((leaf) => leaf.basis)).toEqual([
    "text-layer-match",
    "text-layer-differs",
    "no-text-layer",
  ]);
  const rendered = renderArrangement(
    output.bundle,
    [],
    "source-order-leaves-v5",
  );
  expect(rendered.structure.segments.map((segment) => segment.basis)).toEqual([
    "text-layer-match",
    "text-layer-differs",
    "no-text-layer",
  ]);
  expect(() =>
    renderArrangement(output.bundle, [], "source-order-leaves-v4"),
  ).toThrow();
  const runtime = fakeTextRuntime(async () =>
    modelTool("submit_corrections", { corrections: [], uncertain: [] }),
  );
  try {
    const service = new ArchivePageProofreadService(
      runtime,
      fakePages(f.pages),
      memoryTextCache().cache,
    );
    const initial = await service.build(
      f.source,
      snapshot,
      f.pages,
      undefined,
      [],
      undefined,
      undefined,
      true,
    );
    const retried = await service.build(
      f.source,
      snapshot,
      f.pages,
      undefined,
      [],
      undefined,
      new Map(
        initial.pages
          .filter((p) => p.page_index !== 1 && p.page_index !== 2)
          .map((p) => [p.page_index, p]),
      ),
    );
    expect(retried.pages.slice(0, 3).map((p) => p.status)).toEqual([
      "unreviewed",
      "accepted",
      "accepted",
    ]);
    const mixed = await archiveTextVersion(
      f.source,
      snapshot,
      retried.pages,
      retried.usage,
      fixtureMethod,
      [],
      null,
    );
    expect(mixed.bundle.leaves.map((l) => l.basis)).toEqual([
      "text-layer-match",
      "text-layer",
      "image-only",
    ]);
    expect(
      renderArrangement(
        mixed.bundle,
        [],
        "source-order-leaves-v5",
      ).structure.segments.map((s) => s.basis),
    ).toEqual(["text-layer-match", "text-layer", "image-only"]);
  } finally {
    await runtime.close();
  }
});

it("renders historical long content with identical v4 and v5 bytes, including the equation resource closure", async () => {
  const f = await archiveTextFixture(
    [
      { text: "Original heading", type: "title" },
      { text: "E = mc^2", type: "equation", image: true },
      { text: "An unchanged synthetic paragraph.", page: 1 },
    ],
    { page_count: 51 },
  );
  const snapshot = classifiedSnapshot(f.source),
    output = await archiveTextVersion(
      f.source,
      snapshot,
      pendingArchivePages(f.source, snapshot),
      emptyArchiveUsage(),
      fixtureMethod,
      [],
      null,
    ),
    v4 = renderArrangement(
      output.bundle,
      f.source.raw.resources,
      "source-order-leaves-v4",
    ),
    v5 = renderArrangement(
      output.bundle,
      f.source.raw.resources,
      "source-order-leaves-v5",
    );
  expect(v5.markdown).toEqual(v4.markdown);
  expect(v5.bytes).toEqual(v4.bytes);
  expect(v5.sha256).toBe(v4.sha256);
  expect(v4.resources).toEqual([]);
  expect(v5.resources).toEqual(v4.resources);
  expect(v5.source_map).toEqual(v4.source_map);
});

it("packs whole pages under the request limit, carries an additional section across batches, and globally validates the merged result", async () => {
  const f = await archiveTextFixture([
    { text: "1 Original chapter", type: "title" },
    ...Array.from({ length: 4 }, (_, page) => ({
      text: "An observation. ".repeat(8500),
      page,
    })),
  ]);
  const requests: Record<string, unknown>[] = [];
  const runtime = fakeTextRuntime(async (request) => {
    const q = input(request);
    requests.push(q);
    return answer(
      q.blocks as { id: string }[],
      "additional",
      requests.length === 1 ? "r1" : null,
    );
  });
  try {
    const result = await new ArchiveArrangementService(
      runtime,
      fakePages(f.pages),
      memoryTextCache().cache,
    ).build(f.source);
    expect(result.stop).toBeNull();
    expect(result.classification.reasons).toEqual(["arrange-input"]);
    expect(result.segment_count).toBe(2);
    expect(result.usage.calls).toBe(2);
    expect(
      requests.every(
        (q) => Buffer.byteLength(JSON.stringify(q)) <= ARRANGE_INPUT_MAX_BYTES,
      ),
    ).toBe(true);
    const pageSets = requests.map(
      (q) => new Set((q.blocks as { page: number }[]).map((b) => b.page)),
    );
    expect([...pageSets[0]!].filter((p) => pageSets[1]!.has(p))).toEqual([]);
    expect(requests[1]!.previous_section).toMatchObject({ role: "additional" });
    const destinations = result.value!.destinations.filter(
      (d) => d.destination.kind === "assigned",
    );
    expect(
      new Set(
        destinations.map((d) =>
          JSON.stringify(
            d.destination.kind === "assigned" ? d.destination.target : null,
          ),
        ),
      ).size,
    ).toBe(1);
    expect(
      verifyArrangement(f.source, result.value, result.value!.method_sha256),
    ).toEqual(result.value);
    expect(result.value!.classification).toEqual(result.classification);
  } finally {
    await runtime.close();
  }
});

it("batches every break decision including cross-batch boundaries, and preserves all prior answers", async () => {
  const f = await archiveTextFixture(
    Array.from({ length: 700 }, (_, i) => ({
      text: `段${i} ${"文字".repeat(110)}，`,
      page: Math.floor(i / 175),
    })),
  );
  const breakRequests: Record<string, unknown>[] = [];
  const runtime = fakeTextRuntime(async (request) => {
    const q = input(request);
    if (q.blocks) return answer(q.blocks as { id: string }[]);
    breakRequests.push(q);
    return modelTool("submit_breaks", {
      decisions: (q.candidates as { candidate: string }[]).map((c) => ({
        candidate: c.candidate,
        decision: "keep",
        reason: "Separate paragraphs.",
      })),
    });
  });
  try {
    const result = await new ArchiveArrangementService(
      runtime,
      fakePages(f.pages),
      memoryTextCache().cache,
    ).build(f.source);
    expect(result.stop).toBeNull();
    expect(breakRequests.length).toBeGreaterThan(1);
    expect(
      breakRequests.every(
        (q) => Buffer.byteLength(JSON.stringify(q)) <= ARRANGE_INPUT_MAX_BYTES,
      ),
    ).toBe(true);
    const candidates = breakRequests.flatMap(
      (q) => q.candidates as { candidate: string }[],
    );
    expect(candidates).toHaveLength(
      result.value!.break_candidates.filter((c) => !c.automatic).length,
    );
    expect(new Set(candidates.map((c) => c.candidate)).size).toBe(
      candidates.length,
    );
    expect(result.value!.break_decisions).toHaveLength(
      result.value!.break_candidates.length,
    );
    expect(
      result.value!.break_candidates.some((c) => {
        const left = result.value!.leaves.find(
          (l) => l.leaf_id === c.left_leaf_id,
        )!;
        const right = result.value!.leaves.find(
          (l) => l.leaf_id === c.right_leaf_id,
        )!;
        return left.page_index !== right.page_index;
      }),
    ).toBe(true);
  } finally {
    await runtime.close();
  }
}, 30000);

it("fails explicitly for an indivisible oversized page and accounts for the envelope at exact byte boundaries", async () => {
  const request = (items: readonly string[]) => ({ items });
  const size = Buffer.byteLength(JSON.stringify(request(["α"])));
  expect(boundedArrangementBatches([["α"]], request, size)).toEqual([["α"]]);
  expect(() => boundedArrangementBatches([["α"]], request, size - 1)).toThrow();
  const f = await archiveTextFixture([
    { text: "x".repeat(ARRANGE_INPUT_MAX_BYTES) },
  ]);
  const runtime = fakeTextRuntime(async () => {
    throw Error("No request expected");
  });
  try {
    const result = await new ArchiveArrangementService(
      runtime,
      fakePages(f.pages),
      memoryTextCache().cache,
    ).build(f.source);
    expect(result.stop?.code).toBe("request-too-large");
    expect(result.usage.calls).toBe(0);
    expect(result.classification.reasons).toEqual(["arrange-input"]);
  } finally {
    await runtime.close();
  }
});

it("skips long-document page models and image tools, preserves parser bytes and reviews only explicitly selected pages", async () => {
  const f = await archiveTextFixture(
    [
      { text: "解析 α🙂.", page: 0 },
      { text: "Another paragraph.", page: 1 },
    ],
    { page_count: 51 },
  );
  const review = reviewArrangement(f.source, assigned(f.source));
  const classification = classifyArchiveDocument(51, 100);
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
    { classification },
  );
  let calls = 0,
    images = 0;
  const runtime = fakeTextRuntime(async () => {
    calls++;
    return modelTool("submit_corrections", { corrections: [], uncertain: [] });
  });
  const pdf = fakePages(f.pages);
  const service = new ArchivePageProofreadService(
    runtime,
    {
      ...pdf,
      image: async (...args) => {
        images++;
        return pdf.image(...args);
      },
    },
    memoryTextCache().cache,
  );
  try {
    const progress: unknown[] = [];
    const first = await service.build(
      f.source,
      snapshot,
      f.pages,
      undefined,
      [],
      async (_p, _r, _u, c) => {
        progress.push(c);
      },
      undefined,
      true,
    );
    expect(first.complete).toBe(true);
    expect(first.pages.slice(0, 2).map((p) => p.status)).toEqual([
      "unreviewed",
      "unreviewed",
    ]);
    expect(progress.at(-1)).toMatchObject({
      required: 2,
      accepted: 0,
      unreviewed: 2,
      pending: 0,
      failed: 0,
    });
    expect([calls, images, first.usage.calls]).toEqual([0, 0, 0]);
    const output = await archiveTextVersion(
      f.source,
      snapshot,
      first.pages,
      emptyArchiveUsage(),
      {
        arrange: "fixture",
        page_classify: "fixture",
        suspects: "fixture",
        correction: "fixture",
        model_config_sha256: null,
      },
      [],
      null,
    );
    expect(output.version.status).toBe("complete");
    const render = renderArrangement(output.bundle, []);
    expect(render.markdown.toString()).toBe(
      "解析 α🙂.\n\nAnother paragraph.\n\n",
    );
    expect(render.structure.long_document).toEqual(classification);
    const second = await service.build(
      f.source,
      snapshot,
      f.pages,
      undefined,
      [],
      undefined,
      new Map(
        first.pages
          .filter((p) => p.page_index !== 1)
          .map((p) => [p.page_index, p]),
      ),
    );
    expect(second.complete).toBe(true);
    expect(second.pages[0]).toEqual(first.pages[0]);
    expect(second.pages[1]!.status).toBe("accepted");
    expect([calls, images, second.usage.calls]).toEqual([1, 1, 1]);
  } finally {
    await runtime.close();
  }
});
