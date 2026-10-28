import {
  parseCorrectOperation,
  parseSuspectDisposition,
  parsePageProofreadSubmission,
  type ArrangementLeaf,
  type CorrectOperation,
  type CorrectRecord,
  type RetainedPageSuspect,
  type SuspectDisposition,
  type PageProofreadSubmission,
  type PageReviewEvidence,
} from "@sciretriever/contracts";
import type { PdfPageInspection } from "../browser/pdf-region.js";
import { comparableTokens } from "./suspects.js";
import { requireTableMarkup } from "./contract.js";
import {
  ArchiveTextError,
  cpSlice,
  textHash,
  textId,
} from "../archive/text-source.js";
export const LEAF_CORRECTION_METHOD = "leaf-correct-codepoint-v1";
export const RETAINED_SUSPECT_METHOD = "retained-page-comparable-v4";
function subtract(left: readonly string[], right: readonly string[]) {
  const counts = new Map<string, number>();
  for (const t of right) counts.set(t, (counts.get(t) ?? 0) + 1);
  return left.flatMap((token, index) => {
    const n = counts.get(token) ?? 0;
    if (n) {
      counts.set(token, n - 1);
      return [];
    }
    return [{ token, index }];
  });
}
/** Deleted occurrences are consumed by count, never by a global stop-word set. */
export function retainedPageSuspects(
  page: PdfPageInspection,
  retained: readonly ArrangementLeaf[],
  deleted: readonly ArrangementLeaf[],
  inputHash: string,
  texts?: ReadonlyMap<string, string>,
): readonly RetainedPageSuspect[] {
  if (page.kind !== "text-layer") return [];
  const expected = subtract(
    comparableTokens(page.text),
    deleted.flatMap((l) => comparableTokens(l.original_text)),
  ).map((t) => t.token);
  const entries = retained.flatMap((l) =>
    comparableTokens(texts?.get(l.leaf_id) ?? l.original_text).map((token) => ({
      token,
      id: l.leaf_id,
    })),
  );
  const missing = subtract(
      expected,
      entries.map((e) => e.token),
    ),
    extra = subtract(
      entries.map((e) => e.token),
      expected,
    );
  const scientific = (token: string) =>
    /[\d%‰°_^]/u.test(token) || /^(?:[A-Z][a-z]?){1,}$/u.test(token);
  const result: RetainedPageSuspect[] = [];
  const add = (
    kind: RetainedPageSuspect["kind"],
    tokens: readonly string[],
    index: number,
    ids: readonly string[],
  ) => {
    const body = {
      page_index: page.page,
      kind,
      leaf_ids: ids,
      tokens,
    };
    result.push({
      suspect_id: textId([RETAINED_SUSPECT_METHOD, inputHash, body, index]),
      ...body,
    });
  };
  // One question per run of adjacent differing tokens: a paragraph the draft lacks, or
  // a figure's text the layer lacks, is one thing to check, not one per word. A run
  // with a number, unit or formula is a token mismatch; ADR 0037 counts it once.
  const runs = (
    values: readonly { token: string; index: number }[],
    owner: (index: number) => string,
  ) => {
    const out: { token: string; index: number }[][] = [];
    for (const v of values) {
      const last = out.at(-1)?.at(-1);
      if (
        last &&
        last.index + 1 === v.index &&
        owner(last.index) === owner(v.index)
      )
        out.at(-1)!.push(v);
      else out.push([v]);
    }
    return out;
  };
  const kind = (
    run: readonly { token: string }[],
    side: "missing" | "extra",
  ) => (run.some((t) => scientific(t.token)) ? "token-mismatch" : side);
  for (const run of runs(missing, () => "")) {
    const ids = retained.length === 1 ? [retained[0]!.leaf_id] : [];
    add(
      kind(run, "missing"),
      run.map((t) => t.token),
      run[0]!.index,
      ids,
    );
  }
  for (const run of runs(extra, (i) => entries[i]!.id)) {
    const ids = [entries[run[0]!.index]!.id];
    add(
      kind(run, "extra"),
      run.map((t) => t.token),
      run[0]!.index,
      ids,
    );
  }
  for (const leaf of retained) {
    const value = texts?.get(leaf.leaf_id) ?? leaf.original_text;
    for (const match of value.matchAll(/[\uFFFD\p{Co}\p{Cc}]/gu)) {
      if (["\t", "\r", "\n"].includes(match[0])) continue;
      add(
        "extra",
        [`U+${match[0].codePointAt(0)!.toString(16).toUpperCase()}`],
        [...value.slice(0, match.index)].length,
        [leaf.leaf_id],
      );
    }
  }
  return result;
}
/** Original questions remain auditable; only current new questions are added. */
export function pageReviewSuspects(
  page: PdfPageInspection,
  retained: readonly ArrangementLeaf[],
  deleted: readonly ArrangementLeaf[],
  inputHash: string,
  texts?: ReadonlyMap<string, string>,
) {
  const values = new Map(
    retainedPageSuspects(page, retained, deleted, inputHash).map((s) => [
      s.suspect_id,
      s,
    ]),
  );
  if (texts)
    for (const s of retainedPageSuspects(
      page,
      retained,
      deleted,
      inputHash,
      texts,
    ))
      values.set(s.suspect_id, s);
  return [...values.values()];
}
export function correctRecordId(op: CorrectOperation, pageInput: string) {
  return textId([
    LEAF_CORRECTION_METHOD,
    pageInput,
    { ...op, reason: "transcription" },
  ]);
}
export function applyLeafCorrections(
  leaves: readonly ArrangementLeaf[],
  values: readonly unknown[],
  page: number,
  inputHash: string,
  locked = new Set<string>(),
): { texts: ReadonlyMap<string, string>; records: readonly CorrectRecord[] } {
  const corrections = values.map(parseCorrectOperation),
    byId = new Map(leaves.map((l) => [l.leaf_id, l])),
    issues: { code: string; id: string | null }[] = [];
  const grouped = new Map<string, CorrectOperation[]>();
  for (const c of corrections) {
    const leaf = byId.get(c.leaf_id);
    if (
      !leaf ||
      leaf.page_index !== page ||
      c.basis_page_index !== page ||
      locked.has(c.leaf_id)
    ) {
      issues.push({
        code: locked.has(c.leaf_id)
          ? "manual-conflict"
          : "correction-outside-page",
        id: c.leaf_id,
      });
      continue;
    }
    if (
      c.end > [...leaf.original_text].length ||
      cpSlice(leaf.original_text, c.start, c.end) !== c.original
    ) {
      issues.push({ code: "correction-original-mismatch", id: c.leaf_id });
      continue;
    }
    const list = grouped.get(c.leaf_id) ?? [];
    list.push(c);
    grouped.set(c.leaf_id, list);
  }
  const texts = new Map(leaves.map((l) => [l.leaf_id, l.original_text]));
  for (const [id, ops] of grouped) {
    const sorted = [...ops].sort((a, b) => a.start - b.start || a.end - b.end);
    for (let i = 1; i < sorted.length; i++)
      if (
        sorted[i]!.start < sorted[i - 1]!.end ||
        sorted[i]!.start === sorted[i - 1]!.start
      )
        issues.push({ code: "correction-overlap", id });
    let chars = [...byId.get(id)!.original_text];
    for (const c of [...sorted].reverse())
      chars = [
        ...chars.slice(0, c.start),
        ...c.replacement,
        ...chars.slice(c.end),
      ];
    const text = chars.join("");
    if (byId.get(id)!.type === "table")
      try {
        requireTableMarkup(text);
      } catch {
        issues.push({ code: "correction-table-format", id });
      }
    texts.set(id, text);
  }
  if (issues.length)
    throw new ArchiveTextError("page-submission-invalid", issues);
  const records = corrections.map((operation): CorrectRecord => {
    const leaf = byId.get(operation.leaf_id)!;
    return {
      correction_id: correctRecordId(operation, inputHash),
      operation,
      source_span: {
        ...leaf.source,
        start: leaf.source.start + operation.start,
        end: leaf.source.start + operation.end,
      },
      source: "agent",
      decision_id: null,
    };
  });
  return { texts, records };
}
export function acceptPageSubmission(
  input: {
    page: PdfPageInspection;
    retained: readonly ArrangementLeaf[];
    deleted: readonly ArrangementLeaf[];
    page_input_sha256: string;
    suspects: readonly RetainedPageSuspect[];
    evidence: PageReviewEvidence;
  },
  value: unknown,
) {
  const s: PageProofreadSubmission = parsePageProofreadSubmission(value),
    issues: { code: string; id: string | null }[] = [];
  if (
    s.page_index !== input.page.page ||
    s.page_input_sha256 !== input.page_input_sha256
  )
    issues.push({ code: "page-input-stale", id: null });
  if (!input.evidence.viewed_full_page)
    issues.push({ code: "full-page-not-viewed", id: null });
  for (const l of input.retained)
    if (!input.evidence.read_leaf_ids.includes(l.leaf_id))
      issues.push({ code: "leaf-not-read", id: l.leaf_id });
  const applied = applyLeafCorrections(
    input.retained,
    s.corrections,
    input.page.page,
    input.page_input_sha256,
  );
  const required = pageReviewSuspects(
    input.page,
    input.retained,
    input.deleted,
    input.page_input_sha256,
    applied.texts,
  );
  if (textHash(required) !== textHash(input.suspects))
    issues.push({ code: "suspect-set-stale", id: null });
  const dispositions = new Map<string, SuspectDisposition>();
  const current = retainedPageSuspects(
    input.page,
    input.retained,
    input.deleted,
    input.page_input_sha256,
    applied.texts,
  );
  for (const d of s.dispositions.map(parseSuspectDisposition)) {
    if (
      dispositions.has(d.suspect_id) ||
      !input.suspects.some((q) => q.suspect_id === d.suspect_id)
    )
      issues.push({ code: "suspect-disposition-invalid", id: d.suspect_id });
    dispositions.set(d.suspect_id, d);
    if (d.status === "fixed") {
      const suspect = input.suspects.find((q) => q.suspect_id === d.suspect_id);
      if (
        d.correction_ids.some(
          (id) => !applied.records.some((c) => c.correction_id === id),
        ) ||
        (suspect && current.some((c) => c.suspect_id === suspect.suspect_id)) ||
        (suspect &&
          !applied.records.some(
            (c) =>
              d.correction_ids.includes(c.correction_id) &&
              (!suspect.leaf_ids.length ||
                suspect.leaf_ids.includes(c.operation.leaf_id)),
          ))
      )
        issues.push({ code: "suspect-not-fixed", id: d.suspect_id });
    }
  }
  for (const q of input.suspects)
    if (!dispositions.has(q.suspect_id))
      issues.push({ code: "suspect-disposition-missing", id: q.suspect_id });
  const priorKeys = new Set(
    input.suspects.map((q) =>
      textHash({ kind: q.kind, tokens: q.tokens, ids: q.leaf_ids }),
    ),
  );
  for (const q of current)
    if (
      !priorKeys.has(
        textHash({ kind: q.kind, tokens: q.tokens, ids: q.leaf_ids }),
      )
    )
      issues.push({ code: "new-suspect-unresolved", id: q.suspect_id });
  if (issues.length)
    throw new ArchiveTextError("page-submission-invalid", issues);
  return { submission: s, ...applied };
}
