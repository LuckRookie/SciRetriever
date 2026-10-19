import {
  parseLiteratureSearchItem,
  parseReference,
  type LiteratureId,
  type LiteratureReferenceRequest,
  type LiteratureSearchItem,
  type ReferenceDirection,
} from "@sciretriever/contracts";
import { record } from "./wire.js";

export interface CitationQueryClient {
  query(
    name: "references",
    request: LiteratureReferenceRequest,
    signal?: AbortSignal,
  ): Promise<unknown>;
}
export interface CitationNetworkOptions {
  readonly seeds: readonly LiteratureSearchItem[];
  readonly mode: "within-scope" | "neighbors";
  /** Configurable display/read bounds, not limits on stored citation facts. */
  readonly maxPages?: number;
  readonly maxNodes?: number;
  readonly maxEdges?: number;
  readonly signal?: AbortSignal;
}
export interface CitationNode {
  readonly item: LiteratureSearchItem;
  /** Neighbors outside the selected scope still belong to the local catalog. */
  readonly in_scope: boolean;
}
export interface CitationEdge {
  readonly id: string;
  readonly source: LiteratureId;
  readonly target: LiteratureId;
  readonly support_count: number;
}
export interface CitationQueryCoverage {
  readonly literature_id: LiteratureId;
  readonly direction: ReferenceDirection;
  readonly total_count: number | null;
  readonly read_count: number;
  readonly page_count: number;
  readonly next_cursor: string | null;
  readonly complete: boolean;
}
export type CitationTruncation =
  | "seed-limit"
  | "page-limit"
  | "node-limit"
  | "edge-limit";
export interface CitationNetwork {
  readonly mode: CitationNetworkOptions["mode"];
  readonly nodes: readonly CitationNode[];
  readonly edges: readonly CitationEdge[];
  readonly coverage: {
    readonly requested_seeds: number;
    readonly included_seeds: number;
    readonly pages: number;
    readonly outside_scope_edges: number;
    readonly truncation: readonly CitationTruncation[];
    readonly queries: readonly CitationQueryCoverage[];
  };
}

function positive(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error("invalid citation display bound");
  return value;
}
function count(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new Error("invalid citation count");
  return value;
}
function pageResponse(value: unknown, request: LiteratureReferenceRequest) {
  const page = record(record(value, "reference response").page, "references");
  if (!Array.isArray(page.items) || page.items.length > request.limit)
    throw new Error("invalid citation page");
  const total = count(page.total_count);
  const cursor = page.next_cursor;
  if (
    (cursor !== null && (typeof cursor !== "string" || !cursor.trim())) ||
    total < page.items.length
  )
    throw new Error("invalid citation pagination");
  const items = page.items.map((value: unknown) => {
    const raw = record(value, "reference");
    const reference = parseReference(raw.reference);
    const related = parseLiteratureSearchItem(raw.related_literature);
    const from = request.direction === "references";
    if (
      (from
        ? reference.source_literature_id
        : reference.target_literature_id) !== request.literature_id ||
      (from
        ? reference.target_literature_id
        : reference.source_literature_id) !== related.literature.literature_id
    )
      throw new Error("citation endpoint mismatch");
    return { reference, related, support: count(raw.support_count) };
  });
  return { items, total, cursor };
}

interface PendingQuery {
  literature_id: LiteratureId;
  direction: ReferenceDirection;
  total_count: number | null;
  read_count: number;
  page_count: number;
  next_cursor: string | null;
  complete: boolean;
  cursors: Set<string>;
  references: Set<string>;
}

/**
 * Read actual catalog relations around a fixed selection. Within-scope mode
 * keeps only edges between selected papers; neighbors adds one incoming/outgoing
 * hop. No query mutates the selection, fetches remote metadata, or processes PDF.
 * Pages are read round-robin so one highly cited paper cannot consume every page.
 */
export async function loadCitationNetwork(
  client: CitationQueryClient,
  options: CitationNetworkOptions,
): Promise<CitationNetwork> {
  const maxPages = positive(options.maxPages ?? 40);
  const maxNodes = positive(options.maxNodes ?? 160);
  const maxEdges = positive(options.maxEdges ?? 400);
  if (options.mode !== "within-scope" && options.mode !== "neighbors")
    throw new Error("invalid citation scope");
  const signal = options.signal;
  signal?.throwIfAborted();
  const seeds = new Map<LiteratureId, LiteratureSearchItem>();
  for (const raw of options.seeds) {
    const item = parseLiteratureSearchItem(raw);
    seeds.set(item.literature.literature_id, item);
  }
  const included = [...seeds.values()].slice(0, maxNodes);
  const nodes = new Map<LiteratureId, CitationNode>(
    included.map((item) => [
      item.literature.literature_id,
      { item, in_scope: true },
    ]),
  );
  const edges = new Map<string, CitationEdge>();
  const pairs = new Map<string, string>();
  const observed = new Map<string, string>();
  const excluded = new Set<string>();
  const truncation = new Set<CitationTruncation>();
  if (seeds.size > included.length) truncation.add("seed-limit");
  const directions: readonly ReferenceDirection[] =
    options.mode === "neighbors" ? ["references", "cited-by"] : ["references"];
  const queries: PendingQuery[] = included.flatMap((item) =>
    directions.map((direction) => ({
      literature_id: item.literature.literature_id,
      direction,
      total_count: null,
      read_count: 0,
      page_count: 0,
      next_cursor: null,
      complete: false,
      cursors: new Set<string>(),
      references: new Set<string>(),
    })),
  );
  const queue = [...queries];
  let pages = 0;
  while (queue.length && pages < maxPages) {
    signal?.throwIfAborted();
    const current = queue.shift()!;
    const request: LiteratureReferenceRequest = {
      literature_id: current.literature_id,
      direction: current.direction,
      limit: 100,
      cursor: current.next_cursor,
    };
    if (request.cursor !== null) current.cursors.add(request.cursor);
    const response = await client.query("references", request, signal);
    signal?.throwIfAborted();
    const page = pageResponse(response, request);
    if (page.cursor !== null && current.cursors.has(page.cursor))
      throw new Error("citation cursor did not advance");
    pages++;
    current.page_count++;
    current.total_count = page.total;
    current.next_cursor = page.cursor;
    current.complete = page.cursor === null;
    for (const row of page.items) {
      const ref = row.reference;
      const pair = `${ref.source_literature_id}:${ref.target_literature_id}`;
      if (
        observed.has(ref.reference_id) &&
        observed.get(ref.reference_id) !== pair
      )
        throw new Error("citation identity changed endpoints");
      observed.set(ref.reference_id, pair);
      current.references.add(ref.reference_id);
      const relatedId = row.related.literature.literature_id;
      if (options.mode === "within-scope" && !seeds.has(relatedId)) {
        excluded.add(pair);
        continue;
      }
      const existing = pairs.get(pair);
      if (existing) {
        const previous = edges.get(existing)!;
        // A repeated endpoint/page is the same relation, not additional support.
        edges.set(existing, {
          ...previous,
          support_count: Math.max(previous.support_count, row.support),
        });
        continue;
      }
      if (edges.size >= maxEdges) {
        truncation.add("edge-limit");
        continue;
      }
      if (!nodes.has(relatedId)) {
        if (nodes.size >= maxNodes) {
          truncation.add("node-limit");
          continue;
        }
        nodes.set(relatedId, {
          item: row.related,
          in_scope: seeds.has(relatedId),
        });
      }
      edges.set(ref.reference_id, {
        id: ref.reference_id,
        source: ref.source_literature_id,
        target: ref.target_literature_id,
        support_count: row.support,
      });
      pairs.set(pair, ref.reference_id);
    }
    current.read_count = current.references.size;
    if (!current.complete) queue.push(current);
  }
  if (queue.length) truncation.add("page-limit");
  signal?.throwIfAborted();
  return {
    mode: options.mode,
    nodes: [...nodes.values()],
    edges: [...edges.values()],
    coverage: {
      requested_seeds: seeds.size,
      included_seeds: included.length,
      pages,
      outside_scope_edges: excluded.size,
      truncation: [...truncation],
      queries: queries.map((row) => ({
        literature_id: row.literature_id,
        direction: row.direction,
        total_count: row.total_count,
        read_count: row.read_count,
        page_count: row.page_count,
        next_cursor: row.next_cursor,
        complete: row.complete,
      })),
    },
  };
}
