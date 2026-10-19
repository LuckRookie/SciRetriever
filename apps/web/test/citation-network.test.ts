import { expect, it } from "vitest";
import {
  parseLiteratureSearchItem,
  type LiteratureReferenceRequest,
  type LiteratureSearchItem,
} from "@sciretriever/contracts";
import { FIXTURE_LITERATURE } from "../../server/src/workbench/synthetic-fixture.js";
import {
  loadCitationNetwork,
  type CitationQueryClient,
} from "../src/app/data/citations.js";

const id = (value: number) =>
  `00000000-0000-0000-0000-${String(value).padStart(12, "0")}`;
function item(value: number): LiteratureSearchItem {
  return parseLiteratureSearchItem({
    literature: {
      ...FIXTURE_LITERATURE,
      literature_id: id(value),
      meta_literature_id: id(100 + value),
      metadata: { ...FIXTURE_LITERATURE.metadata, title: `Paper ${value}` },
    },
    metadata_revision: 1,
    metadata_sha256: "a".repeat(64),
    missing_step: "primary-pdf",
    needs_manual_pdf: false,
  });
}
function relation(source: number, target: number, incoming = false) {
  return {
    reference: {
      reference_id: id(1000 + source * 100 + target),
      source_literature_id: id(source),
      target_literature_id: id(target),
    },
    related_literature: item(incoming ? source : target),
    support_count: 2,
  };
}
const page = (
  items: readonly ReturnType<typeof relation>[],
  total = items.length,
  next: string | null = null,
) => ({ page: { items, total_count: total, next_cursor: next } });
function client(
  respond: (
    request: LiteratureReferenceRequest,
    signal?: AbortSignal,
  ) => unknown | Promise<unknown>,
) {
  const calls: LiteratureReferenceRequest[] = [];
  const api: CitationQueryClient = {
    query: async (name, request, signal) => {
      expect(name).toBe("references");
      calls.push(request);
      return respond(request, signal);
    },
  };
  return { api, calls };
}

it("paginates a fixed scope, deduplicates rows, and reports excluded known neighbors", async () => {
  const seeds = [item(1), item(2), item(3), item(1)];
  const snapshot = structuredClone(seeds);
  const fake = client((request) => {
    if (request.literature_id === id(1))
      return request.cursor === null
        ? page([relation(1, 2)], 3, "page-two")
        : page([relation(1, 2), relation(1, 3), relation(1, 9)], 3);
    return page([]);
  });
  const graph = await loadCitationNetwork(fake.api, {
    seeds,
    mode: "within-scope",
  });
  expect(graph.nodes.map((node) => node.item.literature.literature_id)).toEqual(
    [id(1), id(2), id(3)],
  );
  expect(graph.edges.map((edge) => [edge.source, edge.target])).toEqual([
    [id(1), id(2)],
    [id(1), id(3)],
  ]);
  expect(graph.coverage).toMatchObject({
    requested_seeds: 3,
    included_seeds: 3,
    pages: 4,
    outside_scope_edges: 1,
    truncation: [],
  });
  expect(graph.coverage.queries[0]).toMatchObject({
    read_count: 3,
    page_count: 2,
    total_count: 3,
    complete: true,
  });
  expect(fake.calls.map((call) => call.literature_id)).toEqual([
    id(1),
    id(2),
    id(3),
    id(1),
  ]);
  expect(seeds).toEqual(snapshot);
});

it("expands one real incoming and outgoing hop without requiring PDFs or following neighbors recursively", async () => {
  const fake = client((request) =>
    request.direction === "references"
      ? page([relation(1, 2)])
      : page([relation(3, 1, true)]),
  );
  const graph = await loadCitationNetwork(fake.api, {
    seeds: [item(1)],
    mode: "neighbors",
  });
  expect(fake.calls).toHaveLength(2);
  expect(fake.calls.every((call) => call.literature_id === id(1))).toBe(true);
  expect(
    graph.nodes.map((node) => [
      node.item.literature.literature_id,
      node.in_scope,
    ]),
  ).toEqual([
    [id(1), true],
    [id(2), false],
    [id(3), false],
  ]);
  expect(graph.edges.map((edge) => [edge.source, edge.target])).toEqual([
    [id(1), id(2)],
    [id(3), id(1)],
  ]);
  expect(graph.coverage.truncation).toEqual([]);
});

it("does not count the same relation twice when both selected endpoints return it", async () => {
  const fake = client((request) => {
    if (request.literature_id === id(1) && request.direction === "references")
      return page([relation(1, 2)]);
    if (request.literature_id === id(2) && request.direction === "cited-by")
      return page([relation(1, 2, true)]);
    return page([]);
  });
  const graph = await loadCitationNetwork(fake.api, {
    seeds: [item(1), item(2)],
    mode: "neighbors",
  });
  expect(graph.edges).toHaveLength(1);
  expect(graph.edges[0]?.support_count).toBe(2);
});

it("reports seed and page bounds, including directions which have not been read", async () => {
  const fake = client(() => page([relation(1, 2)], 2, "next"));
  const graph = await loadCitationNetwork(fake.api, {
    seeds: [item(1), item(2), item(3)],
    mode: "neighbors",
    maxNodes: 2,
    maxPages: 1,
  });
  expect(graph.coverage).toMatchObject({
    requested_seeds: 3,
    included_seeds: 2,
    pages: 1,
    truncation: ["seed-limit", "page-limit"],
  });
  expect(graph.coverage.queries[0]).toMatchObject({
    total_count: 2,
    read_count: 1,
    next_cursor: "next",
    complete: false,
  });
  expect(graph.coverage.queries[1]).toMatchObject({
    total_count: null,
    read_count: 0,
    page_count: 0,
    complete: false,
  });
  expect(fake.calls).toHaveLength(1);
});

it.each([
  { maxNodes: 2, maxEdges: 10, reason: "node-limit" },
  { maxNodes: 10, maxEdges: 1, reason: "edge-limit" },
])(
  "keeps every edge endpoint visible and states the $reason",
  async ({ maxNodes, maxEdges, reason }) => {
    const fake = client((request) =>
      request.direction === "references"
        ? page([relation(1, 2), relation(1, 3)])
        : page([]),
    );
    const graph = await loadCitationNetwork(fake.api, {
      seeds: [item(1)],
      mode: "neighbors",
      maxNodes,
      maxEdges,
    });
    expect(graph.edges).toHaveLength(1);
    expect(graph.nodes).toHaveLength(2);
    expect(graph.coverage.truncation).toEqual([reason]);
    expect(graph.coverage.queries.every((query) => query.complete)).toBe(true);
  },
);

it("rejects a cancelled late page without changing the selected papers", async () => {
  const abort = new AbortController();
  const seeds = [item(1)];
  const snapshot = structuredClone(seeds);
  const fake = client((_request, signal) => {
    expect(signal).toBe(abort.signal);
    abort.abort();
    return page([relation(1, 2)]);
  });
  await expect(
    loadCitationNetwork(fake.api, {
      seeds,
      mode: "neighbors",
      signal: abort.signal,
    }),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(fake.calls).toHaveLength(1);
  expect(seeds).toEqual(snapshot);
});

it("rejects mismatched endpoints and repeated cursors instead of fabricating edges or looping", async () => {
  const mismatched = client(() => page([relation(2, 3)]));
  await expect(
    loadCitationNetwork(mismatched.api, {
      seeds: [item(1)],
      mode: "neighbors",
    }),
  ).rejects.toThrow("endpoint mismatch");
  const repeated = client(() => page([relation(1, 2)], 2, "same"));
  await expect(
    loadCitationNetwork(repeated.api, {
      seeds: [item(1)],
      mode: "within-scope",
    }),
  ).rejects.toThrow("cursor did not advance");
  expect(repeated.calls).toHaveLength(2);
});

it("does not request anything for an empty selection and propagates read failures", async () => {
  const failing = client(() => {
    throw new Error("read unavailable");
  });
  const empty = await loadCitationNetwork(failing.api, {
    seeds: [],
    mode: "neighbors",
  });
  expect(empty.nodes).toEqual([]);
  expect(empty.edges).toEqual([]);
  expect(empty.coverage.queries).toEqual([]);
  expect(failing.calls).toEqual([]);
  await expect(
    loadCitationNetwork(failing.api, {
      seeds: [item(1)],
      mode: "neighbors",
    }),
  ).rejects.toThrow("read unavailable");
});
