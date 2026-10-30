import {
  ContractValidationError,
  parseAssetId,
  parsePageRegion,
  parseCorrectOperation,
  parseSuspectDisposition,
  parsePageProofreadRecord,
  type ArrangementSnapshot,
  type ArrangementLeaf,
  type CorrectOperation,
  type CorrectRecord,
  type SuspectDisposition,
  type PageProofreadRecord,
  type ArchiveTextIssue,
  type ArchiveRateLimitRetry,
  type ArchiveStepReceipt,
  type RetainedPageSuspect,
} from "@sciretriever/contracts";
import { PageProofreadConcurrency } from "./page-concurrency.js";
import type { DshAgentRuntime } from "../agents/dsh/runtime.js";
import type { PdfPageInspection } from "../browser/pdf-region.js";
import type { PdfPages, ProofreadCache } from "./contract.js";
import {
  LEAF_CORRECTION_METHOD,
  RETAINED_SUSPECT_METHOD,
  retainedPageSuspects,
  pageReviewSuspects,
  correctRecordId,
  applyLeafCorrections,
  acceptPageSubmission,
} from "./leaf-corrections.js";
import {
  ArchiveTextError,
  cpSlice,
  textHash,
  type ArchiveTextSource,
} from "../archive/text-source.js";
import { verifyArrangement } from "../archive/arrangement.js";
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
  stopFor,
  sumArchiveUsage,
  archiveUsageFailure,
} from "../archive/text-session.js";
export interface PageProofreadResult {
  readonly complete: boolean;
  readonly pages: readonly PageProofreadRecord[];
  readonly issues: readonly ArchiveTextIssue[];
  readonly reused_page_indexes: readonly number[];
  readonly untouched_page_indexes: readonly number[];
  readonly usage: ReturnType<typeof sumArchiveUsage>;
}
const str = { type: "string" },
  integer = { type: "integer", minimum: 0 },
  windowLimit = {
    type: "integer",
    minimum: 1,
    maximum: 20,
    description:
      "Number of items per window, not characters; a larger value returns 20.",
  },
  idList = { type: "array", items: str, maxItems: 20 },
  reasonText = {
    type: "string",
    description: "A short reason: one line, at most 120 characters.",
  };
const correctionSchema = objectSchema({
  kind: { const: "correct" },
  leaf_id: { type: "string", description: "Short leaf ID (b1, b2, ...)." },
  start: integer,
  end: integer,
  original: str,
  replacement: str,
  basis_page_index: integer,
  reason: reasonText,
});
// One shape for every status: a model that fixed a suspect still wants to say why.
const dispositionSchema = objectSchema({
  suspect_id: {
    type: "string",
    description: "The suspect's short ID from read_reference, such as s12.",
  },
  status: { type: "string", enum: ["fixed", "draft-correct", "uncertain"] },
  correction_ids: {
    ...idList,
    description:
      "Short correction IDs (such as c3) that resolve this suspect: required for fixed, empty otherwise.",
  },
  reason: reasonText,
});
/** The first field of a batch item that breaks a rule the schema cannot state. */
function itemField(item: unknown): string {
  if (!item || typeof item !== "object" || Array.isArray(item)) return "";
  const r = item as Record<string, unknown>;
  const valid = (parse: () => unknown) => {
    try {
      parse();
      return true;
    } catch {
      return false;
    }
  };
  for (const key of ["leaf_id", "suspect_id"])
    if (key in r && !valid(() => parseAssetId(r[key]))) return `.${key}`;
  if (
    Array.isArray(r.correction_ids) &&
    !r.correction_ids.every((id) => valid(() => parseAssetId(id)))
  )
    return ".correction_ids";
  if (
    typeof r.reason === "string" &&
    (!r.reason.trim() || /[\r\n]/u.test(r.reason) || [...r.reason].length > 120)
  )
    return ".reason";
  if (
    typeof r.original === "string" &&
    typeof r.start === "number" &&
    typeof r.end === "number" &&
    (r.end - r.start !== [...r.original].length || r.original === r.replacement)
  )
    return ".original";
  return "";
}
/**
 * Page-local short names for host IDs. Real models mis-copied 36-character suspect
 * UUIDs (a changed group, an extra digit, a truncated tail) and resent them unchanged;
 * "s12" cannot drift that way. Records keep the real IDs.
 */
class PageHandles {
  private readonly handles = new Map<string, string>();
  private readonly ids = new Map<string, string>();
  constructor(private readonly prefix: "b" | "s" | "c") {}
  handle(id: string): string {
    let h = this.handles.get(id);
    if (!h) {
      h = `${this.prefix}${this.handles.size + 1}`;
      this.handles.set(id, h);
      this.ids.set(h, id);
    }
    return h;
  }
  /** The handle a model knows, or the value itself when it never received one. */
  name(id: string): string {
    return this.handles.get(id) ?? id;
  }
  /** A handle, or a real ID sent directly, becomes the host ID; anything else stays as sent. */
  id(value: unknown): unknown {
    return typeof value === "string" ? (this.ids.get(value) ?? value) : value;
  }
}
/** Parse a batch item by item so a rejection names each item to fix. */
function batchItems<T>(
  field: string,
  rows: readonly unknown[],
  parse: (row: unknown) => T,
): T[] {
  const issues: { code: string; id: string }[] = [];
  const parsed = rows.flatMap((row, i) => {
    try {
      return [parse(row)];
    } catch (error) {
      if (!(error instanceof ContractValidationError)) throw error;
      issues.push({
        code: "tool-input",
        id: `${field}[${i}]${itemField(row)}`,
      });
      return [];
    }
  });
  if (issues.length) throw new ArchiveTextError("tool-input", issues);
  return parsed;
}
export function pageProofreadInputKey(
  source: ArchiveTextSource,
  leaves: readonly ArrangementLeaf[],
  deleted: readonly ArrangementLeaf[],
  page: PdfPageInspection,
  method: string,
) {
  return textHash({
    stage: "independent-page-v1",
    asset: source.raw.source_asset_id,
    asset_sha256: source.raw.source_sha256,
    raw_parse: source.raw.result_sha256,
    page,
    leaves,
    deleted,
    method,
  });
}
export class ArchivePageProofreadService {
  constructor(
    private readonly runtime: DshAgentRuntime,
    private readonly pdf: PdfPages,
    private readonly cache: ProofreadCache,
    private readonly maxConcurrentPages = 3,
  ) {}
  async build(
    source: ArchiveTextSource,
    value: ArrangementSnapshot,
    pages: readonly PdfPageInspection[],
    signal?: AbortSignal,
    manualTexts: readonly {
      leaf_id: string;
      replacement: string;
      decision_id: string;
    }[] = [],
    onPage?: (
      page: PageProofreadRecord,
      reused: boolean,
      usage: import("@sciretriever/contracts").ArchiveModelUsage,
      counts: NonNullable<ArchiveStepReceipt["pages"]>,
    ) => Promise<void>,
    preservedPages: ReadonlyMap<number, PageProofreadRecord> = new Map(),
  ): Promise<PageProofreadResult> {
    const snapshot = verifyArrangement(source, value, value.method_sha256);
    if (
      pages.length !== source.raw.page_count ||
      pages.some((p, i) => p.page !== i)
    )
      throw new ArchiveTextError("source-integrity");
    const method = textHash({
      correction: LEAF_CORRECTION_METHOD,
      suspects: RETAINED_SUSPECT_METHOD,
      pages: this.pdf.method,
      stop: ARCHIVE_TEXT_STOP_POLICY,
      model: archiveTextModelIdentity(this.runtime),
      image: "latest",
    });
    const destinations = new Map(
      snapshot.destinations.map((d) => [d.leaf_id, d.destination]),
    );
    const attempts: import("@sciretriever/contracts").ArchiveModelUsage[] = [];
    const completed = new Map<number, PageProofreadRecord>();
    const issues: ArchiveTextIssue[] = [],
      reused: number[] = [],
      untouched: number[] = [];
    const concurrency = new PageProofreadConcurrency(this.maxConcurrentPages);
    let publication = Promise.resolve();
    const required = pages.filter((p) =>
      snapshot.leaves.some(
        (l) =>
          l.page_index === p.page &&
          destinations.get(l.leaf_id)?.kind === "assigned",
      ),
    ).length;
    const reportPage = (record: PageProofreadRecord, wasReused: boolean) => {
      const work = publication.then(async () => {
        completed.set(record.page_index, record);
        const finished = [...completed.values()].filter(
          (p) => p.status !== "not-required",
        );
        const accepted = finished.filter((p) => p.status === "accepted").length;
        const failed = finished.filter((p) => p.status === "failed").length;
        await onPage?.(record, wasReused, sumArchiveUsage(attempts), {
          required,
          accepted,
          failed,
          reused: finished.filter(
            (p) => p.status === "accepted" && reused.includes(p.page_index),
          ).length,
          pending: required - accepted - failed,
        });
      });
      publication = work.catch(() => {});
      return work;
    };
    const runPage = async (inputPage: PdfPageInspection) => {
      // A page owns its records, tools, evidence, compression and DSH session.
      const records: PageProofreadRecord[] = [];
      const page = inputPage;
      const retained = snapshot.leaves.filter(
          (l) =>
            l.page_index === page.page &&
            destinations.get(l.leaf_id)?.kind === "assigned",
        ),
        deleted = snapshot.leaves.filter(
          (l) =>
            l.page_index === page.page &&
            destinations.get(l.leaf_id)?.kind === "dropped",
        );
      const manual = manualTexts.filter((t) =>
          retained.some((l) => l.leaf_id === t.leaf_id),
        ),
        lockedIds = new Set(manual.map((t) => t.leaf_id));
      const key = pageProofreadInputKey(
        source,
        retained,
        deleted,
        page,
        manual.length ? textHash({ method, manual }) : method,
      );
      const manualOperations: CorrectOperation[] = manual.flatMap((t) => {
        const leaf = retained.find((l) => l.leaf_id === t.leaf_id)!;
        return t.replacement === leaf.original_text
          ? []
          : [
              {
                kind: "correct",
                leaf_id: leaf.leaf_id,
                start: 0,
                end: [...leaf.original_text].length,
                original: leaf.original_text,
                replacement: t.replacement,
                basis_page_index: page.page,
                reason: "manual",
              },
            ];
      });
      const withManual = (c: CorrectRecord): CorrectRecord => {
        const lock = manual.find((t) => t.leaf_id === c.operation.leaf_id);
        return lock
          ? { ...c, source: "manual", decision_id: lock.decision_id }
          : c;
      };
      if (!retained.length) {
        if (
          !snapshot.leaves.some((l) => l.page_index === page.page) &&
          (page.text.length > 0 || page.has_graphics || page.visible_glyphs > 0)
        )
          issues.push({
            code: "page-content-missing",
            page_index: page.page,
            affects_readiness: false,
          });
        records.push({
          schema_version: 2,
          page_index: page.page,
          page_kind: page.kind,
          page_input_sha256: key,
          retained_leaf_ids: [],
          evidence: {
            read_leaf_ids: [],
            viewed_full_page: false,
            viewed_regions: [],
          },
          suspects: [],
          dispositions: [],
          corrections: [],
          usage: emptyArchiveUsage(),
          status: "not-required",
          no_change: true,
          not_required_reason:
            page.kind === "blank"
              ? "blank"
              : deleted.length
                ? "all-content-classified"
                : "no-retained-content",
          classified_leaf_ids: deleted.map((l) => l.leaf_id),
          stop: null,
        });
        await reportPage(records.at(-1)!, false);
        return records.at(-1)!;
      }
      const validateCached = (old: {
        media_type: string;
        bytes: Uint8Array;
      }) => {
        try {
          if (old.media_type !== "application/json")
            throw new ArchiveTextError("source-integrity");
          const record = parsePageProofreadRecord(
            JSON.parse(
              new TextDecoder("utf-8", { fatal: true }).decode(old.bytes),
            ),
            source.raw.page_count,
          );
          if (
            record.page_input_sha256 !== key ||
            record.status !== "accepted" ||
            record.page_index !== page.page ||
            record.page_kind !== page.kind ||
            textHash(record.classified_leaf_ids) !==
              textHash(deleted.map((l) => l.leaf_id)) ||
            textHash(record.retained_leaf_ids) !==
              textHash(retained.map((l) => l.leaf_id))
          )
            throw new ArchiveTextError("source-integrity");
          const verified = acceptPageSubmission(
            {
              page,
              retained,
              deleted,
              page_input_sha256: key,
              suspects: record.suspects,
              evidence: record.evidence,
            },
            {
              schema_version: 2,
              page_index: page.page,
              page_input_sha256: key,
              corrections: record.corrections.map((c) => c.operation),
              no_change: record.no_change,
              dispositions: record.dispositions,
            },
          );
          if (
            textHash(verified.records.map(withManual)) !==
            textHash(record.corrections)
          )
            throw new ArchiveTextError("source-integrity");
          return record;
        } catch {
          throw new ArchiveTextError("source-integrity");
        }
      };
      const prior = preservedPages.get(page.page);
      if (prior) {
        const preserved = parsePageProofreadRecord(
          prior,
          source.raw.page_count,
        );
        if (
          preserved.page_index !== page.page ||
          preserved.page_kind !== page.kind ||
          textHash(preserved.retained_leaf_ids) !==
            textHash(retained.map((l) => l.leaf_id)) ||
          textHash(preserved.classified_leaf_ids) !==
            textHash(deleted.map((l) => l.leaf_id)) ||
          (preserved.status !== "pending" &&
            preserved.page_input_sha256 !== key)
        )
          throw new ArchiveTextError("input-stale");
        if (preserved.status === "accepted") {
          records.push(
            validateCached({
              media_type: "application/json",
              bytes: Buffer.from(JSON.stringify(preserved)),
            }),
          );
          reused.push(page.page);
          await reportPage(records.at(-1)!, true);
        } else {
          records.push(preserved);
          untouched.push(page.page);
        }
        return records.at(-1)!;
      }
      const cancelled = async () => {
        const corrections = applyLeafCorrections(
          retained,
          manualOperations,
          page.page,
          key,
        ).records.map(withManual);
        records.push({
          schema_version: 2,
          page_index: page.page,
          page_kind: page.kind,
          page_input_sha256: key,
          retained_leaf_ids: retained.map((l) => l.leaf_id),
          evidence: {
            read_leaf_ids: [],
            viewed_full_page: false,
            viewed_regions: [],
          },
          suspects: [],
          dispositions: [],
          corrections,
          usage: emptyArchiveUsage(),
          status: "failed",
          no_change: corrections.length === 0,
          not_required_reason: null,
          classified_leaf_ids: deleted.map((l) => l.leaf_id),
          stop: stopFor(new Error("cancelled"), "proofread", page.page, true),
        });
        await reportPage(records.at(-1)!, false);
        return records.at(-1)!;
      };
      if (signal?.aborted) return cancelled();
      let old;
      try {
        old = await this.cache.read(key, signal);
      } catch (error) {
        if (signal?.aborted) return cancelled();
        throw error;
      }
      if (old) {
        records.push(validateCached(old));
        reused.push(page.page);
        await reportPage(records.at(-1)!, true);
        return records.at(-1)!;
      }
      const corrections = new Map<string, CorrectOperation>(
          manualOperations.map((c) => [correctRecordId(c, key), c]),
        ),
        dispositions = new Map<string, SuspectDisposition>(),
        readRanges = new TextReadCoverage(),
        read = new Set<string>(),
        regions: NonNullable<ArrangementLeaf["region"]>[] = [];
      const initialSuspects = retainedPageSuspects(
          page,
          retained,
          deleted,
          key,
        ),
        suspects = new Map<string, RetainedPageSuspect>(
          initialSuspects.map((s) => [s.suspect_id, s]),
        );
      const leafNames = new PageHandles("b"),
        suspectNames = new PageHandles("s"),
        correctionNames = new PageHandles("c");
      // Leaves are named in reading order, so b1 is the first leaf read_blocks returns.
      for (const l of retained) leafNames.handle(l.leaf_id);
      const leafId = (value: unknown) => String(leafNames.id(value));
      let fullViewed = false,
        accepted: ReturnType<typeof acceptPageSubmission> | null = null;
      const progress = new TextProgress("proofread", page.page);
      const rateLimits: ArchiveRateLimitRetry[] = [];
      const evidence = () => ({
        read_leaf_ids: [...read],
        viewed_full_page: fullViewed,
        viewed_regions: [...regions],
      });
      const refreshSuspects = () => {
        const applied = applyLeafCorrections(
          retained,
          [...corrections.values()],
          page.page,
          key,
        );
        suspects.clear();
        for (const q of pageReviewSuspects(
          page,
          retained,
          deleted,
          key,
          applied.texts,
        ))
          suspects.set(q.suspect_id, q);
        for (const id of dispositions.keys())
          if (!suspects.has(id)) dispositions.delete(id);
        return applied;
      };
      const tools = [
        toolDeclaration(
          "draft_status",
          "Inspect this page's host-held corrections/dispositions and coverage after compaction; does not read evidence.",
          {
            kind: { type: "string", enum: ["corrections", "dispositions"] },
            offset: integer,
            limit: windowLimit,
          },
        ),
        toolDeclaration(
          "read_blocks",
          "Read only retained leaf text on this page in bounded Unicode code-point windows; follow next until null.",
          {
            page_index: integer,
            index: integer,
            offset: integer,
            limit: windowLimit,
          },
        ),
        toolDeclaration(
          "view_page",
          "View only the assigned PDF page. region=null is the required full-page image; crops do not replace it.",
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
          "read_reference",
          "Read this page visible text layer and current suspects; both are hints, the image is authoritative. Page them separately with next_text_offset and next_suspect_offset; a text_offset past the end returns no text.",
          {
            page_index: integer,
            text_offset: integer,
            suspect_offset: integer,
          },
        ),
        toolDeclaration(
          "find_text",
          "Find exact original characters in one retained leaf on this page; never change offsets to UTF-16 or use another leaf.",
          {
            leaf_id: {
              type: "string",
              description: "Short leaf ID (b1, b2, ...).",
            },
            text: str,
            start: integer,
          },
        ),
        toolDeclaration(
          "put_corrections",
          "Store leaf-local transcription corrections against original text. Host returns one short correction ID (c1, c2, ...) per item in the order sent and detects new suspects.",
          {
            corrections: {
              type: "array",
              items: correctionSchema,
              maxItems: 20,
            },
          },
        ),
        toolDeclaration(
          "remove_corrections",
          "Remove draft corrections by their short IDs (c1, c2, ...) before replacing an overlapping draft.",
          { correction_ids: idList },
        ),
        toolDeclaration(
          "put_dispositions",
          "Resolve every suspect by its short ID (s1, s2, ...), citing short correction IDs (c1, c2, ...) for fixed, or a short reason (one line, at most 120 characters) for draft-correct/uncertain.",
          {
            dispositions: {
              type: "array",
              items: dispositionSchema,
              maxItems: 20,
            },
          },
        ),
        toolDeclaration(
          "submit_page",
          "Submit this page after reading every retained character and viewing its full image. no_change must reflect the complete correction draft.",
          { no_change: { type: "boolean" } },
        ),
      ];
      const session = await runArchiveTextSession(
        this.runtime,
        {
          requests: {
            beforeAttempt: (active) => concurrency.acquireRequest(active),
            onRateLimited: (delay, active) =>
              concurrency.rateLimited(page.page, delay, active, (event) =>
                rateLimits.push(event),
              ),
          },
          rateLimits,
          step: "proofread",
          page_index: page.page,
          input_sha256: key,
          progress,
          system:
            "Check transcription fidelity on this page only, not style or scientific truth. Never polish, summarize, infer missing facts or dehyphenate by habit. A hyphen the PDF prints only because a word breaks at the end of a line is not part of the text: never add one to a joined word. The original PDF image is authoritative; the text layer and suspects are hints. Read every retained leaf and view the full page before submitting, even on text-layer pages without suspects. Image-only pages have no text-layer reference. Keep uncertain original text with a reason. LaTeX in leaves is judged by the characters it prints, not by its markup. Never add, remove or change spacing in math (\\, \\; \\quad ~ or spaces, including between a number and its unit), never convert between LaTeX and Unicode (^{\\circ} and °, \\times and ×, ^{-1} and ⁻¹, \\mu and µ), and never rewrite \\mathrm as \\text, add braces or move $ delimiters: none of these is a transcription error, so resolve a suspect that differs only in such notation as draft-correct. Correct math only where a printed digit, letter, symbol, sign, subscript or superscript differs from the image, or where two names the image prints apart are fused into one (\\mathrm{mgcm} for mg cm). A replacement inside math follows the notation around it: units and element symbols upright in \\mathrm{}, a multi-character subscript or superscript in braces, separate units as \\mathrm{mg}\\,\\mathrm{cm}, and $ delimiters balanced. Every superscript or subscript a correction adds or changes is written in LaTeX, in running text and in table cells alike: $^{7}$, $^{4b,8,9}$, $^{a,b}$, $\\mathrm{Cs_2CO_3}$, $\\mathrm{D_p}$. Never write <sup> or <sub> tags and never introduce Unicode superscript or subscript characters (⁷, ₂, ᵃ); existing notation stays as it is. Corrections are Unicode code-point [start,end) ranges in ORIGINAL leaf text, cannot cross leaves and cannot change dropped text, page assignments or structure roles. Read evidence in bounded windows. Store corrections and dispositions in host-managed batches; do not output a full page or document.",
          initial: {
            page_index: page.page,
            page_input_sha256: key,
            page_kind: page.kind,
            locked_leaf_ids: [...lockedIds]
              .slice(0, 100)
              .map((id) => leafNames.name(id)),
            leaf_count: retained.length,
            suspect_count: suspects.size,
            coordinate_unit: "unicode-code-point-half-open",
            instruction:
              "Begin read_blocks at index=0,offset=0 for this page only. Each returned id is a short leaf_id (b1, b2, ...). View this full page then inspect reference suspects.",
          },
          tools,
          accepted: () => accepted,
          execute: async (name, args, context) => {
            try {
              if (
                ["read_blocks", "view_page", "read_reference"].includes(name) &&
                args.page_index !== page.page
              )
                throw new ArchiveTextError("page-outside-session", [
                  { code: "page-outside-session", id: null },
                ]);
              if (name === "read_blocks") {
                const r = toolRecord(args, [
                  "page_index",
                  "index",
                  "offset",
                  "limit",
                ]);
                return textReply(
                  boundedTextWindow(
                    retained.map((l) => ({
                      id: leafNames.name(l.leaf_id),
                      text: l.original_text,
                    })),
                    toolCount(r.index, retained.length),
                    toolCount(r.offset),
                    toolLimit(r.limit),
                    (name, start, end) => {
                      const id = leafId(name);
                      const changed = readRanges.add(id, start, end);
                      if (
                        readRanges.complete(
                          id,
                          [
                            ...retained.find((l) => l.leaf_id === id)!
                              .original_text,
                          ].length,
                        )
                      )
                        read.add(id);
                      if (changed)
                        progress.progress("read-leaf", [id, start, end]);
                    },
                  ),
                );
              }
              if (name === "draft_status") {
                const r = toolRecord(args, ["kind", "offset", "limit"]);
                if (r.kind !== "corrections" && r.kind !== "dispositions")
                  throw new ArchiveTextError("tool-input");
                const rows: readonly unknown[] =
                  r.kind === "corrections"
                    ? [...corrections].map(([correction_id, operation]) => ({
                        correction_id: correctionNames.handle(correction_id),
                        leaf_id: leafNames.name(operation.leaf_id),
                        start: operation.start,
                        end: operation.end,
                        original_preview: cpSlice(operation.original, 0, 80),
                        replacement_preview: cpSlice(
                          operation.replacement,
                          0,
                          80,
                        ),
                        original_length: [...operation.original].length,
                        replacement_length: [...operation.replacement].length,
                      }))
                    : [...dispositions.values()].map((d) => ({
                        ...d,
                        suspect_id: suspectNames.handle(d.suspect_id),
                        ...(d.status === "fixed"
                          ? {
                              correction_ids: d.correction_ids.map((id) =>
                                correctionNames.handle(id),
                              ),
                            }
                          : {}),
                      }));
                return textReply({
                  draft: boundedItems(
                    rows,
                    toolCount(r.offset),
                    toolLimit(r.limit),
                  ),
                  read_leaf_count: read.size,
                  leaf_count: retained.length,
                  viewed_full_page: fullViewed,
                  suspect_count: suspects.size,
                });
              }
              if (name === "view_page") {
                const r = toolRecord(args, ["page_index", "region"]),
                  region = r.region === null ? null : parsePageRegion(r.region),
                  image = await this.pdf
                    .image(
                      source.raw.source_asset_id,
                      source.raw.source_sha256,
                      page.page,
                      region,
                      context.signal,
                    )
                    .catch((error: unknown) => {
                      if (context.signal.aborted) throw error;
                      throw new ArchiveTextError("page-tools-unavailable", [], {
                        cause: error,
                      });
                    });
                if (region === null) fullViewed = true;
                else if (regions.length < 100) regions.push(region);
                // A crop not seen before is new evidence; zooming in on a suspect is real work.
                progress.progress(
                  "page",
                  region === null ? page.page : [page.page, ...region],
                );
                return { status: "success", parts: [image] };
              }
              if (name === "read_reference") {
                const r = toolRecord(args, [
                    "page_index",
                    "text_offset",
                    "suspect_offset",
                  ]),
                  offset = toolCount(r.text_offset),
                  suspectOffset = toolCount(r.suspect_offset);
                const window = boundedItems(
                  [...suspects.values()].map((q) => ({
                    ...q,
                    suspect_id: suspectNames.handle(q.suspect_id),
                    leaf_ids: q.leaf_ids.map((id) => leafNames.name(id)),
                    tokens: q.tokens.map((t) => cpSlice(t, 0, 200)),
                    tokens_truncated: q.tokens.some((t) => [...t].length > 200),
                  })),
                  suspectOffset,
                  20,
                  7000,
                );
                const layer = page.kind === "text-layer" ? page.text : "";
                // Paging suspects past the end of the layer text is not an input error.
                const reference = boundedTextWindow(
                  [{ id: `reference:${page.page}`, text: layer }],
                  0,
                  Math.min(offset, [...layer].length),
                  1,
                  (id, start, end) => {
                    if (readRanges.add(id, start, end))
                      progress.progress("reference", [id, start, end]);
                  },
                );
                return textReply({
                  page_index: page.page,
                  text:
                    page.kind === "text-layer"
                      ? (reference.items[0]?.text ?? "")
                      : null,
                  next_text_offset: reference.next?.offset ?? null,
                  suspects: window.items,
                  next_suspect_offset: window.next_offset,
                });
              }
              if (name === "find_text") {
                const r = toolRecord(args, ["leaf_id", "text", "start"]),
                  leaf = retained.find((l) => l.leaf_id === leafId(r.leaf_id));
                // Name the field: an unknown leaf is a mistyped ID, not an edit off this page.
                if (!leaf)
                  throw new ArchiveTextError("tool-input", [
                    { code: "tool-input", id: "leaf_id" },
                  ]);
                if (
                  typeof r.text !== "string" ||
                  !r.text.length ||
                  [...r.text].length > 200
                )
                  throw new ArchiveTextError("tool-input", [
                    { code: "tool-input", id: "text" },
                  ]);
                const start = toolCount(r.start),
                  tail = cpSlice(leaf.original_text, start),
                  at = tail.indexOf(r.text);
                // Locating a new span to correct is real work; a repeated search is not.
                if (at >= 0)
                  progress.progress("find", [leaf.leaf_id, r.text, start]);
                return textReply({
                  start: at < 0 ? null : start + [...tail.slice(0, at)].length,
                  end:
                    at < 0
                      ? null
                      : start + [...tail.slice(0, at + r.text.length)].length,
                });
              }
              if (name === "put_corrections") {
                const r = toolRecord(args, ["corrections"]);
                if (!Array.isArray(r.corrections) || r.corrections.length > 20)
                  throw new ArchiveTextError("tool-input");
                const batch = batchItems(
                  "corrections",
                  r.corrections.map((c: unknown) =>
                    c && typeof c === "object" && "leaf_id" in c
                      ? { ...c, leaf_id: leafNames.id(c.leaf_id) }
                      : c,
                  ),
                  parseCorrectOperation,
                );
                const draft = new Map(corrections);
                for (const c of batch) {
                  if (lockedIds.has(c.leaf_id))
                    throw new ArchiveTextError("manual-conflict");
                  draft.set(correctRecordId(c, key), c);
                }
                // Rejects overlapping or out-of-leaf edits before the draft changes.
                applyLeafCorrections(
                  retained,
                  [...draft.values()],
                  page.page,
                  key,
                );
                corrections.clear();
                for (const [id, c] of draft) corrections.set(id, c);
                refreshSuspects();
                for (const c of batch)
                  progress.progress("corrections", {
                    ...c,
                    reason: "transcription",
                  });
                return textReply({
                  // One ID per correction in this batch, in the order sent.
                  correction_ids: batch.map((c) =>
                    correctionNames.handle(correctRecordId(c, key)),
                  ),
                  correction_count: corrections.size,
                  suspect_count: suspects.size,
                });
              }
              if (name === "remove_corrections") {
                const r = toolRecord(args, ["correction_ids"]);
                if (
                  !Array.isArray(r.correction_ids) ||
                  r.correction_ids.length > 20
                )
                  throw new ArchiveTextError("tool-input");
                const removed = r.correction_ids.map((id) =>
                  String(correctionNames.id(id)),
                );
                if (removed.some((id) => !corrections.has(id)))
                  throw new ArchiveTextError("tool-input");
                for (const id of removed) {
                  if (lockedIds.has(corrections.get(String(id))!.leaf_id))
                    throw new ArchiveTextError("manual-conflict");
                  corrections.delete(String(id));
                }
                refreshSuspects();
                return textReply({ correction_count: corrections.size });
              }
              if (name === "put_dispositions") {
                const r = toolRecord(args, ["dispositions"]);
                if (
                  !Array.isArray(r.dispositions) ||
                  r.dispositions.length > 20
                )
                  throw new ArchiveTextError("tool-input");
                const parsed = batchItems(
                  "dispositions",
                  r.dispositions.map((d: unknown) =>
                    d && typeof d === "object" && !Array.isArray(d)
                      ? {
                          ...d,
                          suspect_id: suspectNames.id(
                            (d as Record<string, unknown>).suspect_id,
                          ),
                          ...(Array.isArray(
                            (d as Record<string, unknown>).correction_ids,
                          )
                            ? {
                                correction_ids: (
                                  (d as Record<string, unknown>)
                                    .correction_ids as unknown[]
                                ).map((id) => correctionNames.id(id)),
                              }
                            : {}),
                        }
                      : d,
                  ),
                  parseSuspectDisposition,
                );
                // Name each rejected item, or the model resends the same batch unchanged.
                const invalid = parsed.filter(
                  (d) =>
                    !suspects.has(d.suspect_id) ||
                    (d.status === "fixed" &&
                      d.correction_ids.some((id) => !corrections.has(id))),
                );
                if (invalid.length)
                  throw new ArchiveTextError(
                    "suspect-disposition-invalid",
                    invalid.map((d) => ({
                      code: "suspect-disposition-invalid",
                      id: suspectNames.name(d.suspect_id),
                    })),
                  );
                for (const d of parsed) dispositions.set(d.suspect_id, d);
                for (const d of parsed)
                  progress.progress(
                    "dispositions",
                    d.status === "fixed"
                      ? d
                      : { suspect_id: d.suspect_id, status: d.status },
                  );
                return textReply({
                  disposed: dispositions.size,
                  total: suspects.size,
                  // Saying the next step stops a model from re-sending the same disposition.
                  ...([...suspects.keys()].every((id) => dispositions.has(id))
                    ? {
                        next: "All suspects are resolved. Call submit_page now; no_change is true when there are no corrections.",
                      }
                    : {}),
                });
              }
              if (name === "submit_page") {
                const r = toolRecord(args, ["no_change"]);
                accepted = acceptPageSubmission(
                  {
                    page,
                    retained,
                    deleted,
                    page_input_sha256: key,
                    suspects: [...suspects.values()],
                    evidence: evidence(),
                  },
                  {
                    schema_version: 2,
                    page_index: page.page,
                    page_input_sha256: key,
                    corrections: [...corrections.values()],
                    no_change: r.no_change,
                    dispositions: [...dispositions.values()],
                  },
                );
                context.concludeTurn();
                return textReply({ accepted: true, page_index: page.page });
              }
              throw new ArchiveTextError("tool-input");
            } catch (error) {
              // A rejection names suspects and corrections by the short IDs the model holds.
              if (!(error instanceof ArchiveTextError)) throw error;
              throw new ArchiveTextError(
                error.code,
                error.issues.map((i) =>
                  i.id === null
                    ? i
                    : {
                        ...i,
                        id: leafNames.name(
                          correctionNames.name(suspectNames.name(i.id)),
                        ),
                      },
                ),
                { cause: error },
              );
            }
          },
        },
        signal,
      );
      const result = session.value;
      const record = parsePageProofreadRecord(
        {
          schema_version: 2,
          page_index: page.page,
          page_kind: page.kind,
          page_input_sha256: key,
          retained_leaf_ids: retained.map((l) => l.leaf_id),
          evidence: evidence(),
          suspects: [...suspects.values()],
          dispositions: result?.submission.dispositions ?? [],
          corrections: result?.records.map(withManual) ?? [],
          usage: session.usage,
          status: result ? "accepted" : "failed",
          no_change: result?.submission.no_change ?? true,
          not_required_reason: null,
          classified_leaf_ids: deleted.map((l) => l.leaf_id),
          stop: session.stop,
        },
        source.raw.page_count,
      );
      attempts.push(session.usage);
      records.push(record);
      // A host-accepted page is durable work even if cancellation arrives during cache publication.
      if (result)
        try {
          await this.cache.save(
            key,
            Buffer.from(JSON.stringify(record)),
            "application/json",
          );
        } catch (error) {
          if (
            !error ||
            typeof error !== "object" ||
            !("code" in error) ||
            error.code !== "proofread-cache-conflict"
          )
            throw error;
          const winner = await this.cache.read(key);
          if (!winner) throw new ArchiveTextError("source-integrity");
          records[records.length - 1] = validateCached(winner);
        }
      await reportPage(records.at(-1)!, false);
      return records[0]!;
    };
    try {
      await concurrency.run(
        pages,
        async (page) => {
          const record = await runPage(page);
          completed.set(page.page, record);
        },
        signal,
      );
      await publication;
      const records = [...completed.values()].sort(
        (a, b) => a.page_index - b.page_index,
      );
      return {
        complete:
          records.length === pages.length &&
          records.every(
            (r) => r.status === "accepted" || r.status === "not-required",
          ),
        pages: records,
        issues,
        reused_page_indexes: reused.sort((a, b) => a - b),
        untouched_page_indexes: untouched.sort((a, b) => a - b),
        usage: sumArchiveUsage(attempts),
      };
    } catch (error) {
      throw archiveUsageFailure(error, sumArchiveUsage(attempts));
    }
  }
}
