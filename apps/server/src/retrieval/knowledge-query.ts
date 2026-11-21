import { DocumentReadError } from "../document/read.js";
import {
  materialContextRequest,
  parseKnowledgeContextBundle,
  parseKnowledgeContextRequest,
  type KnowledgeContextBundle,
  type KnowledgeContextItem,
  type KnowledgeContextRequest,
} from "@sciretriever/contracts";
import { createHash } from "node:crypto";
import {
  ProcessorQueryError,
  type SqliteProcessorStorage,
} from "../storage/processor-results.js";
import type { MaterialContextService } from "./query.js";
export class KnowledgeContextError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
interface Cursor {
  version: 2;
  fingerprint: string;
  index_token: string | null;
  phase: "source" | "result" | "done";
  source: string | null;
  watermark: number | null;
  after: { result_id: string; record_id: string } | null;
}
const encode = (cursor: Cursor) => {
  const payload = JSON.stringify(cursor);
  return Buffer.from(
    JSON.stringify({ payload, checksum: hash(payload) }),
  ).toString("base64url");
};
function decode(request: KnowledgeContextRequest): Cursor {
  const fingerprint = hash({ ...request, continuation: null });
  if (!request.continuation)
    return {
      version: 2,
      fingerprint,
      index_token: null,
      phase: request.kinds.some((k) => k !== "knowledge") ? "source" : "result",
      source: null,
      watermark: null,
      after: null,
    };
  try {
    const envelope = JSON.parse(
      Buffer.from(request.continuation, "base64url").toString("utf8"),
    ) as { payload: string; checksum: string };
    if (hash(envelope.payload) !== envelope.checksum) throw new Error();
    const c = JSON.parse(envelope.payload) as Cursor;
    if (
      Object.keys(envelope).sort().join() !== "checksum,payload" ||
      Object.keys(c).sort().join() !==
        "after,fingerprint,index_token,phase,source,version,watermark" ||
      c.version !== 2 ||
      c.fingerprint !== fingerprint ||
      (c.index_token !== null &&
        (typeof c.index_token !== "string" ||
          !/^[a-f0-9]{64}$/u.test(c.index_token))) ||
      !["source", "result"].includes(c.phase) ||
      (c.source !== null &&
        (typeof c.source !== "string" || c.source.length > 1024)) ||
      (c.watermark !== null &&
        (!Number.isSafeInteger(c.watermark) || c.watermark < 0)) ||
      (c.after !== null &&
        (!c.after ||
          Object.keys(c.after).sort().join() !== "record_id,result_id" ||
          typeof c.after.result_id !== "string" ||
          typeof c.after.record_id !== "string"))
    )
      throw new Error();
    return c;
  } catch {
    throw new KnowledgeContextError("context-cursor-invalid");
  }
}
function count(bundle: KnowledgeContextBundle): KnowledgeContextBundle {
  let value = {
    ...bundle,
    usage: { ...bundle.usage, bytes: 0, items: bundle.items.length },
  };
  for (let i = 0; i < 10; i++) {
    const bytes = Buffer.byteLength(JSON.stringify(value));
    if (bytes === value.usage.bytes) return value;
    value = { ...value, usage: { ...value.usage, bytes } };
  }
  throw new KnowledgeContextError("context-budget-invalid");
}
/** Source ranking is retained within the source branch. Saved results follow in stable ID order, never presented as model confidence. */
export class KnowledgeContextService {
  private stopped = false;
  private readonly active = new Set<Promise<KnowledgeContextBundle>>();
  constructor(
    private readonly material: MaterialContextService | null,
    private readonly results: SqliteProcessorStorage | null,
  ) {}
  async close() {
    this.stopped = true;
    await Promise.allSettled([...this.active]);
  }
  search(value: unknown, signal?: AbortSignal) {
    const request = parseKnowledgeContextRequest(value);
    if (request.budget.token_limit)
      throw new KnowledgeContextError("context-tokenizer-unsupported");
    if (this.stopped) throw new KnowledgeContextError("context-cancelled");
    const p = (
      this.results
        ? this.results.contextReadScope(() => this.run(request, signal))
        : this.run(request, signal)
    ).catch((error: unknown) => {
      if (
        error instanceof DocumentReadError &&
        error.code === "document-budget"
      )
        throw new KnowledgeContextError("context-budget-invalid");
      throw error;
    });
    this.active.add(p);
    return p.finally(() => this.active.delete(p));
  }
  private async run(
    request: KnowledgeContextRequest,
    signal?: AbortSignal,
  ): Promise<KnowledgeContextBundle> {
    let cursor = decode(request);
    const items: KnowledgeContextItem[] = [],
      gaps: KnowledgeContextBundle["gaps"][number][] = [];
    const addGap = (gap: KnowledgeContextBundle["gaps"][number]) => {
      if (
        gaps.some(
          (g) =>
            g.code === gap.code &&
            (g.literature_id === null || g.literature_id === gap.literature_id),
        )
      )
        return;
      gaps.push(gap);
      if (gaps.length > 32) {
        const codes = [...new Set(gaps.map((g) => g.code))];
        gaps.splice(
          0,
          gaps.length,
          ...codes.map((code) => ({ code, literature_id: null })),
        );
      }
    };
    const material = request.kinds.some((kind) => kind !== "knowledge")
      ? this.material
      : null;
    const initial = await material?.indexSnapshot();
    const searchMaterial = material?.searchSession();
    if (
      request.continuation &&
      cursor.index_token !== (initial?.state_token ?? null)
    )
      throw new KnowledgeContextError("context-cursor-invalid");
    cursor = { ...cursor, index_token: initial?.state_token ?? null };
    let relevanceLimit: KnowledgeContextBundle["relevance_limit"];
    const addIndexGap = (coverage: string) => {
      if (coverage.startsWith("index-"))
        addGap({ code: `material-${coverage}`, literature_id: null });
    };
    if (initial) addIndexGap(initial.coverage);
    const bundle = () =>
      count({
        schema_version: 3,
        score_rule: "sources-then-results-v1",
        ...(relevanceLimit === undefined
          ? {}
          : { relevance_limit: relevanceLimit }),
        items,
        coverage: gaps.some((gap) => gap.code === "material-index-stale")
          ? "index-stale"
          : gaps.length || cursor.phase !== "done"
            ? "partial"
            : "complete",
        gaps,
        usage: { items: items.length, bytes: 0, tokens: null, tokenizer: null },
        truncated: cursor.phase !== "done",
        continuation: cursor.phase === "done" ? null : encode(cursor),
      });
    let scanned = 0;
    while (cursor.phase !== "done" && items.length < request.budget.max_items) {
      if (++scanned > 4096) {
        addGap({ code: "candidate-limit", literature_id: null });
        break;
      }
      if (signal?.aborted) throw new KnowledgeContextError("context-cancelled");
      const previous = { ...cursor };
      let item: KnowledgeContextItem | undefined;
      if (cursor.phase === "source") {
        if (!searchMaterial) {
          addGap({
            code: "material-index-unavailable",
            literature_id: null,
          });
          cursor = { ...cursor, phase: "result" };
          continue;
        }
        const source = materialContextRequest(request, cursor.source),
          page = await searchMaterial(
            { ...source, budget: { ...source.budget, max_items: 1 } },
            signal,
          );
        page.gaps.forEach(addGap);
        relevanceLimit = page.relevance_limit ?? relevanceLimit;
        addIndexGap(page.coverage);
        item = page.items[0];
        cursor = {
          ...cursor,
          source: page.continuation,
          phase: page.continuation
            ? "source"
            : request.kinds.includes("knowledge")
              ? "result"
              : "done",
        };
      } else {
        if (!request.kinds.includes("knowledge")) {
          cursor = { ...cursor, phase: "done" };
          continue;
        }
        if (!this.results) {
          addGap({ code: "result-index-unavailable", literature_id: null });
          cursor = { ...cursor, phase: "done" };
          continue;
        }
        try {
          const page = await this.results.contextPage(
            request.query,
            request.scope.kind === "library"
              ? []
              : request.scope.literature_ids,
            cursor.watermark,
            cursor.after,
            signal,
          );
          cursor = {
            ...cursor,
            watermark: page.watermark,
            after: page.row ?? cursor.after,
            phase: page.row ? "result" : "done",
          };
          item = page.item ?? undefined;
          if (page.gap) addGap({ code: page.gap, literature_id: null });
        } catch (error) {
          if (signal?.aborted) throw error;
          if (
            error instanceof ProcessorQueryError &&
            error.code === "processor-index-stale"
          ) {
            addGap({ code: "result-index-stale", literature_id: null });
            cursor = { ...cursor, phase: "done" };
            continue;
          }
          throw error;
        }
      }
      if (!item) continue;
      items.push({ ...item, rank: items.length + 1 });
      if (bundle().usage.bytes > request.budget.max_bytes) {
        items.pop();
        if (items.length) {
          cursor = previous;
          break;
        }
        items.push({
          ...item,
          text: "",
          evidence: [],
          gap: "context-too-large",
          rank: 1,
        });
        addGap({
          code: "context-too-large",
          literature_id:
            item.kind === "generated-result" ? null : item.literature_id,
        });
        if (bundle().usage.bytes > request.budget.max_bytes)
          throw new KnowledgeContextError("context-budget-invalid");
      }
    }
    if (material) {
      const latest = await material.indexSnapshot();
      if (latest.state_token !== cursor.index_token)
        throw new KnowledgeContextError("context-cursor-invalid");
      addIndexGap(latest.coverage);
    }
    const result = bundle();
    if (result.usage.bytes > request.budget.max_bytes)
      throw new KnowledgeContextError("context-budget-invalid");
    return parseKnowledgeContextBundle(result, request);
  }
}
