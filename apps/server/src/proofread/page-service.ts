import {
  parsePageProofreadRecord,
  longDocumentInfo,
  type ArrangementSnapshot,
  type ArrangementLeaf,
  type ArchiveTextStop,
  type CorrectOperation,
  type CorrectRecord,
  type PageProofreadRecord,
  type PageReviewNotes,
  type ArchiveTextIssue,
  type ArchiveRateLimitRetry,
  type ArchiveStepReceipt,
} from "@sciretriever/contracts";
import { PageProofreadConcurrency } from "./page-concurrency.js";
import type { DshAgentRuntime } from "../agents/dsh/runtime.js";
import type { AgentImagePart } from "../agents/protocol.js";
import { pdfPageText, type PdfPageInspection } from "../browser/pdf-region.js";
import type { PdfPages, ProofreadCache } from "./contract.js";
import {
  LEAF_CORRECTION_METHOD,
  applyLeafCorrections,
  correctRecordId,
} from "./leaf-corrections.js";
import { FORMAT_RULE, formatCorrections } from "../archive/format-normalize.js";
import {
  SENTENCE_SPACE_RULE,
  sentenceSpaceCorrections,
} from "./sentence-space.js";
import {
  PAGE_REVIEW_METHOD,
  PAGE_REVIEW_SYSTEM,
  editOperations,
  guardEdit,
  identifierFixes,
  pageReviewPlan,
  type PageReviewPlan,
  type PageReviewRule,
} from "./page-review.js";
import {
  ArchiveTextError,
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
  shortLeaf = { type: "string", description: "Short leaf ID (b1, b2, ...)." },
  reasonText = {
    type: "string",
    description: "A short reason: one line, at most 120 characters.",
  };
const submitTool = toolDeclaration(
  "submit_corrections",
  "Submit every correction of this page at once, and the places you could not settle from the image.",
  {
    corrections: {
      type: "array",
      maxItems: 100,
      items: objectSchema({
        leaf: shortLeaf,
        original: str,
        replacement: str,
        reason: reasonText,
      }),
    },
    uncertain: {
      type: "array",
      maxItems: 50,
      items: objectSchema({ leaf: shortLeaf, text: str, reason: reasonText }),
    },
  },
);
interface PageSubmission {
  readonly corrections: readonly {
    leaf: string;
    original: string;
    replacement: string;
    reason: string;
  }[];
  readonly uncertain: readonly { leaf: string; text: string; reason: string }[];
}
/** Each row must carry exactly these string fields; a rejection names every bad row. */
function submissionRows<K extends string>(
  value: unknown,
  keys: readonly K[],
  field: string,
  issues: { code: string; id: string }[],
): Record<K, string>[] {
  if (!Array.isArray(value)) {
    issues.push({ code: "tool-input", id: field });
    return [];
  }
  return value.filter((row: unknown, i) => {
    const ok =
      !!row &&
      typeof row === "object" &&
      !Array.isArray(row) &&
      Object.keys(row).sort().join() === [...keys].sort().join() &&
      keys.every(
        (k) => typeof (row as Record<string, unknown>)[k] === "string",
      );
    if (!ok) issues.push({ code: "tool-input", id: `${field}[${i}]` });
    return ok;
  }) as Record<K, string>[];
}
const clip = (value: string, max: number) => [...value].slice(0, max).join("");
/**
 * Page-local short names for host IDs. Real models mis-copied 36-character suspect
 * UUIDs (a changed group, an extra digit, a truncated tail) and resent them unchanged;
 * "b12" cannot drift that way. Records keep the real IDs.
 */
class PageHandles {
  private readonly handles = new Map<string, string>();
  private readonly ids = new Map<string, string>();
  constructor(private readonly prefix: "b") {}
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
export function pageProofreadInputKey(
  source: ArchiveTextSource,
  leaves: readonly ArrangementLeaf[],
  deleted: readonly ArrangementLeaf[],
  page: PdfPageInspection,
  method: string,
) {
  const proofreadPage = pdfPageText(page);
  return textHash({
    stage: "independent-page-v1",
    asset: source.raw.source_asset_id,
    asset_sha256: source.raw.source_sha256,
    raw_parse: source.raw.result_sha256,
    page: proofreadPage,
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
    skipReview = false,
  ): Promise<PageProofreadResult> {
    const snapshot = verifyArrangement(source, value, value.method_sha256);
    if (
      pages.length !== source.raw.page_count ||
      pages.some((p, i) => p.page !== i)
    )
      throw new ArchiveTextError("source-integrity");
    const method = textHash({
      correction: LEAF_CORRECTION_METHOD,
      review: PAGE_REVIEW_METHOD,
      prompt: textHash(PAGE_REVIEW_SYSTEM),
      pages: this.pdf.method,
      stop: ARCHIVE_TEXT_STOP_POLICY,
      model: archiveTextModelIdentity(this.runtime),
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
        const unreviewed = finished.filter(
          (p) => p.status === "unreviewed",
        ).length;
        await onPage?.(record, wasReused, sumArchiveUsage(attempts), {
          required,
          accepted,
          failed,
          reused: finished.filter(
            (p) => p.status === "accepted" && reused.includes(p.page_index),
          ).length,
          ...(unreviewed ? { unreviewed } : {}),
          pending: required - accepted - failed - unreviewed,
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
      let reviewPlan: PageReviewPlan | null = null;
      const planOf = () => (reviewPlan ??= pageReviewPlan(page, retained));
      // ADR 0074 §2–3: an arrangement made with the notation rule carries its program
      // corrections into every page; a person's locked text wins over them. Older
      // arrangements get none, so their page inputs and cached pages stay the same.
      const ruled = snapshot.format_rule === FORMAT_RULE,
        open = retained.filter((l) => !lockedIds.has(l.leaf_id));
      const format = ruled
          ? open.flatMap((l) => formatCorrections(l, page.page))
          : [],
        space = ruled
          ? sentenceSpaceCorrections(page, planOf(), open).filter(
              (s) =>
                !format.some(
                  (f) =>
                    f.leaf_id === s.leaf_id &&
                    f.start < s.end &&
                    s.start < f.end,
                ),
            )
          : [],
        program = [...format, ...space];
      const key = pageProofreadInputKey(
        source,
        retained,
        deleted,
        page,
        manual.length || program.length
          ? textHash({
              method,
              manual,
              ...(format.length ? { program: FORMAT_RULE } : {}),
              ...(space.length ? { sentence_space: SENTENCE_SPACE_RULE } : {}),
            })
          : method,
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
      const programOperations: CorrectOperation[] = program.map(
          ({ rule, ...op }) => {
            void rule;
            return op;
          },
        ),
        programRules = new Map(
          program.map(({ rule, ...op }) => [correctRecordId(op, key), rule]),
        );
      const baseOperations = [...manualOperations, ...programOperations];
      const withManual = (c: CorrectRecord): CorrectRecord => {
        const lock = manual.find((t) => t.leaf_id === c.operation.leaf_id),
          rule = programRules.get(c.correction_id);
        return lock
          ? { ...c, source: "manual", decision_id: lock.decision_id }
          : rule
            ? { ...c, source: "program", rule }
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
          // The page's corrections must be exactly what its operations yield on these leaves.
          const verified = applyLeafCorrections(
            retained,
            record.corrections.map((c) => c.operation),
            page.page,
            key,
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
          baseOperations,
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
      if (skipReview) {
        if (!longDocumentInfo(snapshot.classification))
          throw new ArchiveTextError("source-integrity");
        const corrections = applyLeafCorrections(
          retained,
          baseOperations,
          page.page,
          key,
        ).records.map(withManual);
        const record = parsePageProofreadRecord(
          {
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
            status: "unreviewed",
            unreviewed_reason: "long-document",
            no_change: corrections.length === 0,
            not_required_reason: null,
            classified_leaf_ids: deleted.map((l) => l.leaf_id),
            stop: null,
          },
          source.raw.page_count,
        );
        await reportPage(record, false);
        return record;
      }
      const plan = planOf(),
        leafNames = new PageHandles("b");
      // Leaves are named in reading order, so b1 is the first leaf of the page.
      for (const l of retained) leafNames.handle(l.leaf_id);
      const leafOf = (handle: string) =>
        retained.find((l) => l.leaf_id === leafNames.id(handle));
      let image: AgentImagePart | null = null,
        stop: ArchiveTextStop | null = null;
      try {
        image = await this.pdf.image(
          source.raw.source_asset_id,
          source.raw.source_sha256,
          page.page,
          null,
          signal,
        );
      } catch (error) {
        if (signal?.aborted) return cancelled();
        stop = stopFor(
          new ArchiveTextError("page-tools-unavailable", [], { cause: error }),
          "proofread",
          page.page,
        );
      }
      const initial = {
        page_index: page.page,
        page_input_sha256: key,
        leaves: retained.map((l) => ({
          leaf: leafNames.name(l.leaf_id),
          type: l.type,
          text: l.original_text,
        })),
        ...(plan.figure_leaf_ids.length
          ? {
              figure_leaves: plan.figure_leaf_ids.map((id) =>
                leafNames.name(id),
              ),
            }
          : {}),
        ...(plan.mode === "differences"
          ? {
              differences: plan.differences.map((d) => ({
                leaf: leafNames.name(d.leaf_id),
                parsed: d.parsed,
                text_layer: d.text_layer,
              })),
            }
          : {
              note: "This page has no trustworthy text layer: compare every leaf with the image.",
            }),
        ...(lockedIds.size
          ? {
              locked_leaves: [...lockedIds].map((id) => leafNames.name(id)),
              locked_note: "A person fixed these leaves; do not correct them.",
            }
          : {}),
      };
      const submitted: { value: PageSubmission | null } = { value: null },
        usages: import("@sciretriever/contracts").ArchiveModelUsage[] = [];
      // One request; a failed request is sent once more (ADR 0047 §4).
      for (
        let attempt = 0;
        image && !submitted.value && attempt < 2 && !signal?.aborted;
        attempt++
      ) {
        const progress = new TextProgress("proofread", page.page),
          rateLimits: ArchiveRateLimitRetry[] = [];
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
            system: PAGE_REVIEW_SYSTEM,
            images: [image],
            toolChoice: "required",
            initial,
            tools: [submitTool],
            accepted: () => submitted.value,
            execute: async (name, args, context) => {
              if (name !== "submit_corrections")
                throw new ArchiveTextError("tool-input");
              const r = toolRecord(args, ["corrections", "uncertain"]),
                issues: { code: string; id: string }[] = [];
              const corrections = submissionRows(
                  r.corrections,
                  ["leaf", "original", "replacement", "reason"],
                  "corrections",
                  issues,
                ),
                uncertain = submissionRows(
                  r.uncertain,
                  ["leaf", "text", "reason"],
                  "uncertain",
                  issues,
                );
              if (issues.length)
                throw new ArchiveTextError("tool-input", issues.slice(0, 20));
              submitted.value = { corrections, uncertain };
              progress.progress("corrections", corrections.length);
              context.concludeTurn();
              return textReply({ accepted: true, page_index: page.page });
            },
          },
          signal,
        );
        usages.push(session.usage);
        stop = submitted.value ? null : session.stop;
      }
      const usage = usages.length
        ? sumArchiveUsage(usages)
        : emptyArchiveUsage();
      let record: PageProofreadRecord;
      if (!submitted.value) {
        if (signal?.aborted) return cancelled();
        const corrections = applyLeafCorrections(
          retained,
          baseOperations,
          page.page,
          key,
        ).records.map(withManual);
        record = parsePageProofreadRecord(
          {
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
            usage,
            status: "failed",
            no_change: corrections.length === 0,
            not_required_reason: null,
            classified_leaf_ids: deleted.map((l) => l.leaf_id),
            stop:
              stop ??
              stopFor(
                new Error("agent-result-missing"),
                "proofread",
                page.page,
              ),
          },
          source.raw.page_count,
        );
      } else {
        // Every edit passes the program checks one by one; a refused edit leaves the parse.
        const operations: CorrectOperation[] = [...baseOperations],
          refused: PageReviewNotes["refused"][number][] = [],
          uncertain: PageReviewNotes["uncertain"][number][] = [];
        const consider = (
          leaf: ArrangementLeaf,
          original: string,
          replacement: string,
          reason: string,
          checked: boolean,
        ) => {
          let rule: PageReviewRule | null = lockedIds.has(leaf.leaf_id)
            ? "locked"
            : checked
              ? guardEdit(page, plan, leaf, original, replacement)
              : null;
          if (!rule) {
            // An edit the program already made is not made twice.
            const next = editOperations(
              leaf,
              original,
              replacement,
              page.page,
              reason,
            ).filter((op) => !programRules.has(correctRecordId(op, key)));
            try {
              applyLeafCorrections(
                retained,
                [...operations, ...next],
                page.page,
                key,
              );
              operations.push(...next);
            } catch (error) {
              if (!(error instanceof ArchiveTextError)) throw error;
              rule = "conflict";
            }
          }
          if (rule)
            refused.push({
              leaf_id: leaf.leaf_id,
              original: clip(original, 65536),
              replacement: clip(replacement, 65536),
              rule,
              reason: clip(reason, 480),
            });
        };
        for (const c of submitted.value.corrections) {
          const leaf = leafOf(c.leaf);
          if (leaf) consider(leaf, c.original, c.replacement, c.reason, true);
          else
            uncertain.push({
              leaf_id: null,
              text: clip(c.original, 65536),
              reason: clip(`unknown leaf ${c.leaf}: ${c.reason}`, 480),
            });
        }
        for (const fix of identifierFixes(page, retained))
          consider(
            retained.find((l) => l.leaf_id === fix.leaf_id)!,
            fix.original,
            fix.replacement,
            "identifier as printed in the text layer",
            false,
          );
        for (const u of submitted.value.uncertain)
          uncertain.push({
            leaf_id: leafOf(u.leaf)?.leaf_id ?? null,
            text: clip(u.text, 65536),
            reason: clip(u.reason, 480),
          });
        const corrections = applyLeafCorrections(
          retained,
          operations,
          page.page,
          key,
        ).records.map(withManual);
        record = parsePageProofreadRecord(
          {
            schema_version: 2,
            page_index: page.page,
            page_kind: page.kind,
            page_input_sha256: key,
            retained_leaf_ids: retained.map((l) => l.leaf_id),
            // The request carried every retained leaf and the full page image.
            evidence: {
              read_leaf_ids: retained.map((l) => l.leaf_id),
              viewed_full_page: true,
              viewed_regions: [],
            },
            suspects: [],
            dispositions: [],
            corrections,
            usage,
            status: "accepted",
            no_change: corrections.length === 0,
            not_required_reason: null,
            classified_leaf_ids: deleted.map((l) => l.leaf_id),
            stop: null,
            review: { refused, uncertain },
          },
          source.raw.page_count,
        );
      }
      const result = record.status === "accepted";
      attempts.push(usage);
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
          records.every((r) =>
            ["accepted", "not-required", "unreviewed"].includes(r.status),
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
