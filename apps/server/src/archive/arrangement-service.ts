import {
  ARCHIVE_SECTION_ROLES,
  parseArrangementOperation,
  parseParagraphBreakDecision,
  parsePageRegion,
  parseArchiveModelUsage,
  type ArrangementSnapshot,
  type SourceSpan,
  type ArrangementOperation,
  type ParagraphBreakDecision,
} from "@sciretriever/contracts";
import type { DshAgentRuntime } from "../agents/dsh/runtime.js";
import type { PdfPages, ProofreadCache } from "../proofread/contract.js";
import { textTokens } from "../proofread/suspects.js";
import {
  ARRANGEMENT_METHOD,
  PARAGRAPH_BREAK_RULE,
  arrangementOperationKey,
  arrangementLeafSpans,
  reviewArrangement,
  acceptArrangement,
  verifyArrangement,
  type ArrangementConstraints,
} from "./arrangement.js";
import {
  ArchiveTextError,
  cpSlice,
  textHash,
  type ArchiveTextSource,
} from "./text-source.js";
import {
  archiveTextModelIdentity,
  TextProgress,
  ARCHIVE_TEXT_STOP_POLICY,
  objectSchema,
  toolDeclaration,
  textReply,
  toolRecord,
  toolCount,
  toolLimit,
  boundedTextWindow,
  boundedItems,
  TextReadCoverage,
  runArchiveTextSession,
  emptyArchiveUsage,
  archiveUsageFailure,
  type ArchiveTextSessionResult,
} from "./text-session.js";
const str = { type: "string" },
  reasonText = {
    type: "string",
    description: "A short reason: one line, at most 120 characters.",
  },
  integer = { type: "integer", minimum: 0 },
  windowLimit = {
    type: "integer",
    minimum: 1,
    maximum: 20,
    description:
      "Number of items per window, not characters; a larger value returns 20.",
  },
  strings = { type: "array", items: str, maxItems: 20 };
const target = {
  anyOf: [
    objectSchema({
      role: {
        type: "string",
        enum: ARCHIVE_SECTION_ROLES.filter((r) => r !== "additional"),
      },
    }),
    objectSchema({
      role: { const: "additional" },
      original_heading_leaf_id: { anyOf: [str, { type: "null" }] },
    }),
  ],
};
const presentation = {
  anyOf: [
    objectSchema({
      kind: { type: "string", enum: ["content", "section-heading"] },
    }),
    objectSchema({
      kind: { const: "subheading" },
      level: { type: "integer", minimum: 2, maximum: 6 },
    }),
  ],
};
const opSchema = {
  anyOf: [
    objectSchema({
      kind: { const: "assign" },
      leaf_id: str,
      target,
      presentation,
    }),
    objectSchema({
      kind: { const: "drop" },
      leaf_id: str,
      reason: {
        type: "string",
        enum: [
          "header",
          "footer",
          "interface",
          "bibliography",
          "copyright",
          "decoration",
        ],
      },
    }),
    objectSchema({
      kind: { const: "split" },
      root_block_id: str,
      cuts: { type: "array", items: integer, maxItems: 100 },
    }),
    objectSchema({ kind: { const: "merge" }, leaf_ids: strings }),
    objectSchema({
      kind: { const: "caption" },
      object_leaf_id: str,
      caption_leaf_ids: strings,
      object_kind: { type: "string", enum: ["figure", "table", "scheme"] },
    }),
    objectSchema({
      kind: { const: "assign-page" },
      leaf_id: str,
      page_index: integer,
      basis_page_index: integer,
      reason: reasonText,
    }),
  ],
};
const decisionSchema = {
  anyOf: [
    objectSchema({ candidate_id: str, decision: { const: "merge" } }),
    objectSchema({
      candidate_id: str,
      decision: { const: "keep" },
      reason: reasonText,
    }),
  ],
};
export class ArchiveArrangementService {
  constructor(
    private readonly runtime: DshAgentRuntime,
    private readonly pages: PdfPages,
    private readonly cache: ProofreadCache,
  ) {}
  async build(
    source: ArchiveTextSource,
    signal?: AbortSignal,
    seed?: ArrangementSnapshot,
    lockedTextSpans: readonly SourceSpan[] = [],
  ): Promise<ArchiveTextSessionResult<ArrangementSnapshot>> {
    signal?.throwIfAborted();
    const method = textHash({
      arrange: ARRANGEMENT_METHOD,
      tools: "arrangement-read-leaves-v2",
      breaks: PARAGRAPH_BREAK_RULE,
      stop: ARCHIVE_TEXT_STOP_POLICY,
      image: "latest",
      pages: this.pages.method,
      model: archiveTextModelIdentity(this.runtime),
    });
    const key = textHash({
      stage: "arrangement-checkpoint-v1",
      manual: seed?.destinations.filter((d) => d.locked) ?? [],
      manual_revision: seed?.manual_revision ?? 0,
      locked_text_spans: lockedTextSpans,
      source: source.input_sha256,
      method,
    });
    const old = await this.cache.read(key, signal);
    if (old) {
      try {
        if (old.media_type !== "application/json")
          throw new ArchiveTextError("source-integrity");
        const stored = toolRecord(
          JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(old.bytes),
          ),
          [
            "schema_version",
            "stage",
            "source_input_sha256",
            "method_sha256",
            "snapshot",
            "usage",
            "evidence",
          ],
        );
        if (
          stored.schema_version !== 1 ||
          stored.stage !== "arrange" ||
          stored.source_input_sha256 !== source.input_sha256 ||
          stored.method_sha256 !== method
        )
          throw new ArchiveTextError("source-integrity");
        parseArchiveModelUsage(stored.usage);
        const evidence = toolRecord(stored.evidence, [
          "read_root_ids",
          "viewed_pages",
        ]);
        if (
          !Array.isArray(evidence.read_root_ids) ||
          textHash(evidence.read_root_ids) !==
            textHash(source.blocks.map((b) => b.root_block_id)) ||
          !Array.isArray(evidence.viewed_pages) ||
          evidence.viewed_pages.some(
            (p) =>
              !Number.isSafeInteger(p) || p < 0 || p >= source.raw.page_count,
          )
        )
          throw new ArchiveTextError("source-integrity");
        return {
          value: verifyArrangement(source, stored.snapshot, method, {
            viewed_pages: new Set<number>(evidence.viewed_pages),
          }),
          usage: emptyArchiveUsage(),
          stop: null,
        };
      } catch {
        throw new ArchiveTextError("source-integrity");
      }
    }
    const ops = new Map<string, ArrangementOperation>(
        seed?.operations.map((o) => [arrangementOperationKey(o), o]) ?? [],
      ),
      decisions = new Map<string, ParagraphBreakDecision>();
    const viewed = new Set<number>(
        seed?.operations
          .filter((o) => o.kind === "assign-page")
          .map((o) => o.page_index) ?? [],
      ),
      read = new TextReadCoverage(),
      progress = new TextProgress("arrange", null);
    const layerTokens = source.pages.map((p) => {
      const counts = new Map<string, number>();
      if (p.kind === "text-layer")
        for (const t of textTokens(p.text))
          counts.set(t, (counts.get(t) ?? 0) + 1);
      return counts;
    });
    let accepted: ArrangementSnapshot | null = null;
    const constraints: ArrangementConstraints = {
      locked_spans: lockedTextSpans,
      viewed_pages: viewed,
      manual_revision: seed?.manual_revision ?? 0,
      locked_destinations: new Map(
        seed?.destinations
          .filter((d) => d.locked)
          .map((d) => [d.leaf_id, d.destination]) ?? [],
      ),
      locked_decisions: new Map(
        seed?.destinations
          .filter((d) => d.locked)
          .map((d) => [d.leaf_id, d.decision_id!]) ?? [],
      ),
    };
    const review = () =>
      reviewArrangement(source, [...ops.values()], constraints);
    const tools = [
      toolDeclaration(
        "draft_status",
        "Inspect bounded host-held operation drafts after compaction. This does not read source evidence.",
        {
          offset: integer,
          limit: windowLimit,
        },
      ),
      toolDeclaration(
        "read_page_reference",
        "Read bounded visible text-layer hints for a page. Hints are not authoritative and do not replace viewing the PDF.",
        { page_index: integer, offset: integer },
      ),
      toolDeclaration(
        "read_blocks",
        "Read exact original block characters with type, page hint and current program-derived leaf IDs, including draft splits. Leaves intersect the returned text window. Follow next until null; offsets are Unicode code points. limit counts blocks per window (1-20), not characters.",
        {
          index: integer,
          offset: integer,
          limit: windowLimit,
        },
      ),
      toolDeclaration(
        "block_info",
        "Refresh program-derived leaf IDs after a split, or request text-layer page hints. Otherwise use identities from read_blocks. Never infer IDs.",
        { root_block_id: str },
      ),
      toolDeclaration(
        "view_page",
        "View an original PDF page or crop. Whole-page view is region=null. Pages are zero-based.",
        {
          page_index: integer,
          region: {
            anyOf: [
              {
                type: "array",
                items: { type: "integer", minimum: 0, maximum: 1000 },
                minItems: 4,
                maxItems: 4,
              },
              { type: "null" },
            ],
          },
        },
      ),
      toolDeclaration(
        "find_text",
        "Find exact text within one original block. Returned offsets are Unicode code points; searching alone does not count as reading new evidence.",
        { root_block_id: str, text: str, start: integer },
      ),
      toolDeclaration(
        "put_operations",
        "Add or replace operation drafts by host-derived scope key. Submit batches; never send rewritten body text.",
        {
          operations: {
            type: "array",
            items: opSchema,
            minItems: 1,
            maxItems: 20,
          },
        },
      ),
      toolDeclaration(
        "remove_operations",
        "Remove stale draft operations by exact keys. Removal does not delete source content.",
        { keys: strings },
      ),
      toolDeclaration(
        "review_breaks",
        "Validate complete destinations and return bounded paragraph-break candidates. Review hash changes when the draft changes.",
        {
          offset: integer,
          limit: windowLimit,
        },
      ),
      toolDeclaration(
        "decide_breaks",
        "Decide every current candidate; keep needs a short reason (one line, at most 120 characters). A merge decision also needs a merge operation.",
        {
          reviewed_candidates_sha256: str,
          decisions: { type: "array", items: decisionSchema, maxItems: 20 },
        },
      ),
      toolDeclaration(
        "submit_operations",
        "Accept the host-held operations after coverage, paragraph decisions and zero-character-difference validation.",
        { reviewed_candidates_sha256: str },
      ),
    ];
    const result = await runArchiveTextSession(
      this.runtime,
      {
        step: "arrange",
        page_index: null,
        input_sha256: key,
        progress,
        system:
          "Arrange the original blocks without changing characters. Classify each terminal leaf exactly once. Use the fixed skeleton, keeping original subheadings. Authors contain names only; affiliations, funding, notes and final supporting-information notices belong to end-matter. Drop bibliographic lines, UI labels, headers, footers, copyright and decoration with their closed reason. Split embedded copyright then drop only that span. Never dehyphenate or normalize text. Cross independent footnotes/figures/tables/captions when merging, without losing them. Page hints can be wrong: view the destination page before assign-page. Read sources via bounded read_blocks, using its current leaf IDs, types and page hints. After each read_blocks window, put_operations for every leaf in that window before reading the next one; drafts are kept by the host, so context compaction never loses finished work. Use block_info only to refresh identities after a split or obtain text-layer page hints. Review and decide paragraph candidates, then submit. Do not output full text.",
        initial: {
          source_input_sha256: source.input_sha256,
          block_count: source.blocks.length,
          page_count: source.raw.page_count,
          roles: ARCHIVE_SECTION_ROLES,
          coordinate_unit: "unicode-code-point-half-open",
          instruction:
            "Start at read_blocks index=0,offset=0. Use its leaf IDs and follow next until null; leaf spans and text windows use Unicode code points. Splitting replaces leaf identities: reread the block or use block_info after changing a split.",
        },
        tools,
        accepted: () => accepted,
        execute: async (name, args, context) => {
          if (name === "read_blocks") {
            const r = toolRecord(args, ["index", "offset", "limit"]),
              spans = new Map<
                string,
                ReturnType<typeof arrangementLeafSpans>
              >();
            return textReply(
              boundedTextWindow(
                source.blocks.map((b) => ({
                  id: b.root_block_id,
                  text: b.text,
                  block: b,
                })),
                toolCount(r.index, source.blocks.length),
                toolCount(r.offset),
                toolLimit(r.limit),
                (id, start, end) => {
                  if (read.add(id, start, end))
                    progress.progress("read-block", [id, start, end]);
                },
                (row, start, end) => {
                  let leaves = spans.get(row.id);
                  if (!leaves) {
                    const split = ops.get(`split:${row.id}`);
                    leaves = arrangementLeafSpans(
                      row.block,
                      source.raw.result_sha256,
                      split?.kind === "split" ? split.cuts : [],
                    );
                    spans.set(row.id, leaves);
                  }
                  return {
                    type: row.block.type,
                    page_hint: row.block.page_hint,
                    image_ref: row.block.image_ref,
                    leaf_count: leaves.length,
                    leaves: leaves.filter((leaf) =>
                      start === end
                        ? leaf.start <= start && leaf.end >= end
                        : leaf.start < end && leaf.end > start,
                    ),
                  };
                },
              ),
            );
          }
          if (name === "draft_status") {
            const r = toolRecord(args, ["offset", "limit"]);
            return textReply({
              operations: boundedItems(
                [...ops].map(([key, operation]) => ({ key, operation })),
                toolCount(r.offset),
                toolLimit(r.limit),
              ),
              decision_count: decisions.size,
              read_block_count: source.blocks.filter((b) =>
                read.complete(b.root_block_id, [...b.text].length),
              ).length,
              viewed_pages: [...viewed].slice(0, 100),
              block_count: source.blocks.length,
            });
          }
          if (name === "read_page_reference") {
            const r = toolRecord(args, ["page_index", "offset"]),
              page =
                source.pages[toolCount(r.page_index, source.pages.length - 1)]!;
            return textReply(
              boundedTextWindow(
                [
                  {
                    id: String(page.page),
                    text: page.kind === "text-layer" ? page.text : "",
                  },
                ],
                0,
                toolCount(r.offset),
                1,
                (id, start, end) => {
                  if (read.add(`reference:${id}`, start, end))
                    progress.progress("reference", [id, start, end]);
                },
              ),
            );
          }
          if (name === "block_info") {
            const r = toolRecord(args, ["root_block_id"]),
              root = source.blocks.find(
                (b) => b.root_block_id === r.root_block_id,
              );
            if (!root) throw new ArchiveTextError("unknown-root");
            const split = ops.get(`split:${root.root_block_id}`);
            const tokens = textTokens(root.text),
              needed = new Map<string, number>();
            for (const token of tokens)
              needed.set(token, (needed.get(token) ?? 0) + 1);
            const matches = source.pages
              .filter(
                (p) =>
                  tokens.length > 0 &&
                  p.kind === "text-layer" &&
                  [...needed].every(
                    ([t, count]) => (layerTokens[p.page]!.get(t) ?? 0) >= count,
                  ),
              )
              .map((p) => p.page);
            return textReply({
              root_block_id: root.root_block_id,
              type: root.type,
              page_hint: root.page_hint,
              image_ref: root.image_ref,
              text_layer_page_hints: matches.slice(0, 20),
              text_layer_page_hint_count: matches.length,
              leaves: arrangementLeafSpans(
                root,
                source.raw.result_sha256,
                split?.kind === "split" ? split.cuts : [],
              ),
            });
          }
          if (name === "view_page") {
            const r = toolRecord(args, ["page_index", "region"]),
              page = toolCount(r.page_index, source.raw.page_count - 1),
              region = r.region === null ? null : parsePageRegion(r.region);
            const image = await this.pages
              .image(
                source.raw.source_asset_id,
                source.raw.source_sha256,
                page,
                region,
                context.signal,
              )
              .catch((error: unknown) => {
                if (context.signal.aborted) throw error;
                throw new ArchiveTextError("page-tools-unavailable", [], {
                  cause: error,
                });
              });
            if (region === null) viewed.add(page);
            progress.progress("page", page);
            return { status: "success", parts: [image] };
          }
          if (name === "find_text") {
            const r = toolRecord(args, ["root_block_id", "text", "start"]),
              root = source.blocks.find(
                (b) => b.root_block_id === r.root_block_id,
              );
            if (
              !root ||
              typeof r.text !== "string" ||
              !r.text.length ||
              [...r.text].length > 200
            )
              throw new ArchiveTextError("tool-input");
            const start = toolCount(r.start),
              tail = cpSlice(root.text, start),
              at = tail.indexOf(r.text);
            return textReply({
              start: at < 0 ? null : start + [...tail.slice(0, at)].length,
              end:
                at < 0
                  ? null
                  : start + [...tail.slice(0, at + r.text.length)].length,
            });
          }
          if (name === "put_operations") {
            const r = toolRecord(args, ["operations"]);
            if (
              !Array.isArray(r.operations) ||
              !r.operations.length ||
              r.operations.length > 20
            )
              throw new ArchiveTextError("tool-input");
            const parsed = r.operations.map(parseArrangementOperation);
            const draft = new Map(ops);
            for (const op of parsed) draft.set(arrangementOperationKey(op), op);
            reviewArrangement(source, [...draft.values()], {
              ...constraints,
              allow_incomplete: true,
            });
            for (const op of parsed) ops.set(arrangementOperationKey(op), op);
            decisions.clear();
            for (const op of parsed)
              progress.progress(
                "operation-draft",
                op.kind === "assign-page" ? { ...op, reason: "page" } : op,
              );
            return textReply({
              stored_keys: parsed.map(arrangementOperationKey),
              operation_count: ops.size,
            });
          }
          if (name === "remove_operations") {
            const r = toolRecord(args, ["keys"]);
            if (
              !Array.isArray(r.keys) ||
              r.keys.length > 20 ||
              r.keys.some((k) => typeof k !== "string" || !ops.has(k))
            )
              throw new ArchiveTextError("tool-input");
            for (const key of r.keys) ops.delete(String(key));
            decisions.clear();
            return textReply({ operation_count: ops.size });
          }
          if (name === "review_breaks") {
            const r = toolRecord(args, ["offset", "limit"]),
              v = review(),
              offset = toolCount(r.offset),
              limit = toolLimit(r.limit);
            if (limit < 1 || offset > v.candidates.length)
              throw new ArchiveTextError("tool-input");
            return textReply({
              reviewed_candidates_sha256: v.candidates_sha256,
              candidates: v.candidates
                .slice(offset, offset + limit)
                .map((c) => ({
                  candidate_id: c.candidate_id,
                  left_leaf_id: c.left_leaf_id,
                  right_leaf_id: c.right_leaf_id,
                  left_ends_with_hyphen: c.left_ends_with_hyphen,
                  skipped_leaf_count: c.skipped_leaf_ids.length,
                })),
              total: v.candidates.length,
              next_offset:
                offset + limit < v.candidates.length ? offset + limit : null,
            });
          }
          if (name === "decide_breaks") {
            const r = toolRecord(args, [
                "reviewed_candidates_sha256",
                "decisions",
              ]),
              v = review();
            if (
              r.reviewed_candidates_sha256 !== v.candidates_sha256 ||
              !Array.isArray(r.decisions) ||
              r.decisions.length > 20
            )
              throw new ArchiveTextError("break-review-stale");
            const parsed = r.decisions.map(parseParagraphBreakDecision);
            if (
              parsed.some(
                (d) =>
                  !v.candidates.some((c) => c.candidate_id === d.candidate_id),
              )
            )
              throw new ArchiveTextError("break-decision-invalid");
            for (const d of parsed) decisions.set(d.candidate_id, d);
            for (const d of parsed)
              progress.progress("break-decisions", {
                candidate_id: d.candidate_id,
                decision: d.decision,
              });
            return textReply({
              decided: decisions.size,
              total: v.candidates.length,
            });
          }
          if (name === "submit_operations") {
            const r = toolRecord(args, ["reviewed_candidates_sha256"]);
            const unread = source.blocks.filter(
              (b) => !read.complete(b.root_block_id, [...b.text].length),
            );
            if (unread.length)
              throw new ArchiveTextError(
                "arrangement-invalid",
                unread.map((b) => ({
                  code: "block-not-read",
                  id: b.root_block_id,
                })),
              );
            accepted = acceptArrangement(
              source,
              {
                schema_version: 1,
                source_input_sha256: source.input_sha256,
                reviewed_candidates_sha256: r.reviewed_candidates_sha256,
                operations: [...ops.values()],
                break_decisions: [...decisions.values()],
              },
              method,
              constraints,
            );
            context.concludeTurn();
            return textReply({
              accepted: true,
              arrangement_id: accepted.arrangement_id,
            });
          }
          throw new ArchiveTextError("tool-input");
        },
      },
      signal,
    );
    if (result.value && !signal?.aborted) {
      try {
        await this.cache.save(
          key,
          Buffer.from(
            JSON.stringify({
              schema_version: 1,
              stage: "arrange",
              source_input_sha256: source.input_sha256,
              method_sha256: method,
              snapshot: result.value,
              usage: result.usage,
              evidence: {
                read_root_ids: source.blocks.map((b) => b.root_block_id),
                viewed_pages: [...viewed],
              },
            }),
          ),
          "application/json",
          signal,
        );
      } catch (error) {
        try {
          if (
            !error ||
            typeof error !== "object" ||
            !("code" in error) ||
            error.code !== "proofread-cache-conflict"
          )
            throw error;
          const winner = await this.build(
            source,
            signal,
            seed,
            lockedTextSpans,
          );
          return { ...result, value: winner.value };
        } catch (failure) {
          throw archiveUsageFailure(failure, result.usage);
        }
      }
    }
    return result;
  }
}
