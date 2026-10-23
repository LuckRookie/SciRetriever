import { parseManualDocument } from "./manual-document.js";
import {
  canonicalJsonBytes,
  parseProofreadBlocksV1,
  parseProofreadVersion,
  proofreadIdentity,
  sha256,
  type ArtifactRef,
  type ProofreadPage,
  type ProofreadVersionInput,
  type RawParse,
} from "@sciretriever/contracts";
import type { PdfPageInspection } from "../browser/pdf-region.js";
import { applyEdits, draftBlocks } from "./apply.js";
import { CLEAN_RULES_VERSION } from "./clean.js";
import { prepareDraft, type ProofreadInputReader } from "./draft.js";
import {
  manualPageIdentity,
  insertedDraft,
  type ManualProofreadDecision,
  type ProofreadCorrector,
  type CorrectionContext,
} from "./contract.js";
import { findSuspects, SUSPECTS_VERSION, textTokens } from "./suspects.js";
import { renderBlocks, PROOFREAD_RENDER_VERSION } from "./render.js";
export type { ManualProofreadDecision } from "./contract.js";
export type { ProofreadInputReader } from "./draft.js";
export const proofreadCorrectionMethod = (
  corrector?: Pick<ProofreadCorrector, "method"> | null,
) =>
  `${corrector?.method ?? "correction-unconfigured"}:residual-review-v2-no-block-uncertainty`;
export const proofreadMethod = (
  pageMethod: string,
  corrector?: Pick<ProofreadCorrector, "method" | "model_config_sha256"> | null,
) => ({
  clean: CLEAN_RULES_VERSION,
  page_classify: pageMethod,
  suspects: SUSPECTS_VERSION,
  correction: proofreadCorrectionMethod(corrector),
  render: PROOFREAD_RENDER_VERSION,
  model_config_sha256: corrector?.model_config_sha256 ?? null,
});
const artifact = async (
  bytes: Uint8Array,
  media_type: string,
): Promise<ArtifactRef> => ({
  sha256: await sha256(bytes),
  byte_size: bytes.length,
  media_type,
});
/** One parser draft; images settle questions; reasoned unresolved dispositions do not reject completeness. */
export async function buildProofreadVersion(input: {
  raw: RawParse;
  reader: ProofreadInputReader;
  pages: readonly PdfPageInspection[];
  page_method: string;
  corrector?: ProofreadCorrector | null;
  decisions?: readonly ManualProofreadDecision[];
  signal?: AbortSignal;
}) {
  const started = performance.now();
  input.signal?.throwIfAborted();
  const {
    raw,
    drafts,
    removed: ruleRemoved,
  } = await prepareDraft(input.raw, input.reader, input.pages, input.signal);
  const removed = [...ruleRemoved];
  let blocks = draftBlocks(drafts, { pages: input.pages });
  let suspects = findSuspects(input.pages, blocks, removed, drafts);
  const pages: ProofreadPage[] = input.pages.map((p) => ({
    page: p.page,
    kind: p.kind,
    checked: p.kind === "blank",
    no_body_reason: null,
    pending_reason: null,
  }));
  const edits: ProofreadVersionInput["edits"][number][] = [],
    decisions = input.decisions ?? [],
    used: string[] = [],
    deferred: ManualProofreadDecision[] = [],
    locked = new Set<string>();
  const usage = { calls: 0, input_tokens: 0, output_tokens: 0 };
  let failure: ProofreadVersionInput["failure"] = null;
  if (
    new Set(decisions.map((d) => d.decision_id)).size !== decisions.length ||
    decisions.some((d) => d.part_asset_id !== raw.source_asset_id)
  )
    throw new Error("proofread-manual-scope");
  const documentEdit = decisions.find((d) => d.action === "document-edit");
  if (documentEdit) {
    if (documentEdit.draft_sha256 !== raw.result_sha256)
      throw new Error("proofread-manual-input-conflict");
    const saved = parseManualDocument(
      documentEdit.text!,
      raw.resources.map((r) => r.reference),
    );
    if (saved.blocks.page_count !== pages.length)
      throw new Error("proofread-manual-input-conflict");
    blocks = [...saved.blocks.blocks];
    edits.push(...saved.edits);
    used.push(documentEdit.decision_id);
    for (const b of blocks)
      if (b.text_source === "manual") locked.add(b.block_id);
    for (const id of saved.changed_ids) locked.add(id);
    for (const record of saved.edits) {
      if (
        record.edit.kind !== "delete" ||
        record.edit.reason !== "manual-document-edit"
      )
        continue;
      const deletedId = record.edit.block_id;
      const deleted = drafts.find((d) => d.block_id === deletedId);
      if (deleted)
        removed.push({
          page: deleted.page,
          type: "manual-delete",
          text: deleted.html ?? deleted.text,
          raw_ref: deleted.raw_ref[0] ?? [0, 0],
        });
    }
    suspects = findSuspects(input.pages, blocks, removed, drafts);
    for (let i = 0; i < suspects.length; i++) {
      const s = suspects[i]!;
      if (s.block_ids.some((id) => locked.has(id)))
        suspects[i] = {
          ...s,
          disposition: { status: "fixed", reason: "manual-document-edit" },
        };
    }
    for (let i = 0; i < pages.length; i++)
      if (
        !blocks.some((b) => b.page === i) &&
        saved.changed_ids.some((id) =>
          drafts.some((d) => d.block_id === id && d.page === i),
        )
      )
        pages[i] = {
          ...pages[i]!,
          checked: true,
          no_body_reason: "manual-document-edit",
        };
  }
  for (const decision of decisions.filter(
    (d) => d.action !== "document-edit",
  )) {
    if (decision.action === "no-body") {
      const page = pages[decision.page];
      if (!page) throw new Error("proofread-manual-scope");
      const identity = await manualPageIdentity(
        raw.source_asset_id,
        decision.page,
        drafts,
        raw.result_sha256,
      );
      if (
        identity.block_id !== decision.block_id ||
        identity.draft_sha256 !== decision.draft_sha256
      ) {
        pages[decision.page] = {
          ...page,
          checked: false,
          pending_reason: "manual-conflict",
        };
        continue;
      }
      used.push(decision.decision_id);
      pages[decision.page] = {
        ...page,
        checked: true,
        no_body_reason: decision.reason,
      };
      suspects = suspects.map((s) =>
        s.page === decision.page
          ? {
              ...s,
              disposition: { status: "draft-correct", reason: decision.reason },
            }
          : s,
      );
      continue;
    }
    if (
      decision.action === "resolve-suspect" &&
      !drafts.some((d) => d.block_id === decision.block_id)
    ) {
      const identity = await manualPageIdentity(
        raw.source_asset_id,
        decision.page,
        drafts,
        raw.result_sha256,
      );
      const suspect = suspects.find(
        (s) =>
          s.suspect_id === decision.suspect_id &&
          !s.block_ids.length &&
          s.page === decision.page,
      );
      if (
        identity.block_id === decision.block_id &&
        identity.draft_sha256 === decision.draft_sha256 &&
        suspect &&
        decision.disposition
      ) {
        used.push(decision.decision_id);
        suspects = suspects.map((s) =>
          s === suspect ? { ...s, disposition: decision.disposition } : s,
        );
      } else if (pages[decision.page])
        pages[decision.page] = {
          ...pages[decision.page]!,
          checked: false,
          pending_reason: "manual-conflict",
        };
      continue;
    }
    const d = drafts.find((b) => b.block_id === decision.block_id);
    if (!d && decision.action === "replace") {
      deferred.push(decision);
      continue;
    }
    if (
      !d ||
      d.draft_sha256 !== decision.draft_sha256 ||
      JSON.stringify(d.raw_ref) !== JSON.stringify(decision.raw_ref)
    ) {
      if (pages[decision.page])
        pages[decision.page] = {
          ...pages[decision.page]!,
          checked: false,
          pending_reason: "manual-conflict",
        };
      continue;
    }
    used.push(decision.decision_id);
    locked.add(d.block_id);
    if (decision.action === "replace")
      blocks = blocks.map((b) =>
        b.block_id === d.block_id
          ? {
              ...b,
              text:
                decision.action === "replace" && b.type !== "table"
                  ? decision.text!
                  : b.text,
              html:
                decision.action === "replace" && b.type === "table"
                  ? decision.text!
                  : b.html,
              text_source: "manual",
              basis: "manual",
            }
          : b,
      );
    suspects = suspects.map((s) =>
      decision.suspect_id === s.suspect_id ||
      (decision.action === "replace" && s.block_ids.includes(d.block_id))
        ? {
            ...s,
            disposition: decision.disposition ?? {
              status: "draft-correct",
              reason: decision.reason,
            },
          }
        : s,
    );
  }
  const context = (page: number): CorrectionContext => ({
    locked_block_ids: [...locked],
    asset_id: raw.source_asset_id,
    asset_sha256: raw.source_sha256,
    page: input.pages[page]!,
    pages: input.pages,
    drafts: blocks.map((b) => {
      const d = drafts.find((d) => d.block_id === b.block_id);
      return {
        ...b,
        draft_sha256: d?.draft_sha256 ?? raw.result_sha256,
        known_defect: false,
        page_text:
          d && d.text === b.text && d.html === b.html && d.page === b.page
            ? d.page_text
            : [{ page: b.page, text: b.html ?? b.text }],
      };
    }),
    suspects: suspects.filter((s) => s.page === page && !s.disposition),
    resources: raw.resources.map((r) => r.reference),
  });
  const checkPage = async (page: PdfPageInspection) => {
    input.signal?.throwIfAborted();
    if (pages[page.page]!.pending_reason === "manual-conflict") return;
    const questions = suspects.filter(
      (s) => s.page === page.page && !s.disposition,
    );
    if (
      page.kind === "blank" ||
      (page.kind === "text-layer" && !questions.length) ||
      pages[page.page]!.no_body_reason
    ) {
      pages[page.page] = { ...pages[page.page]!, checked: true };
      return;
    }
    if (!input.corrector) {
      pages[page.page] = {
        ...pages[page.page]!,
        pending_reason: "correction-model-unconfigured",
      };
      return;
    }
    const c = context(page.page);
    let result;
    try {
      result = await input.corrector.correct(
        c,
        Math.max(0, input.corrector.max_calls - usage.calls),
        input.signal,
      );
    } catch (error) {
      if (input.signal?.aborted) throw error;
      failure = {
        page: page.page,
        reason: "correction-failed",
        message: "correction-execution-failed",
      };
      return;
    }
    usage.calls += result.calls;
    usage.input_tokens += result.input_tokens;
    usage.output_tokens += result.output_tokens;
    if (!result.submission) {
      pages[page.page] = {
        ...pages[page.page]!,
        pending_reason: result.reason ?? "correction-incomplete",
      };
      if (result.reason === "correction-failed") {
        failure = {
          page: page.page,
          reason: "correction-failed",
          message: "correction-execution-failed",
        };
        return;
      }
      return;
    }
    try {
      const applied = applyEdits(blocks, result.submission, c, locked);
      blocks = applied.blocks;
      const recorded = new Set(edits.map((e) => e.edit_id));
      edits.push(...applied.edits.filter((e) => !recorded.has(e.edit_id)));
      const settled = new Map(
        result.submission.dispositions.map((d) => [
          d.suspect_id,
          d.disposition,
        ]),
      );
      suspects = suspects.map((s) =>
        settled.has(s.suspect_id)
          ? { ...s, disposition: settled.get(s.suspect_id)! }
          : s,
      );
      pages[page.page] = {
        ...pages[page.page]!,
        checked: true,
        pending_reason: null,
        no_body_reason: result.submission.no_body_reason,
      };
    } catch {
      pages[page.page] = {
        ...pages[page.page]!,
        checked: false,
        pending_reason: "correction-edit-conflict",
      };
    }
  };
  for (const page of input.pages) {
    await checkPage(page);
    if (failure) break;
  }
  for (const decision of deferred) {
    const block = blocks.find((b) => b.block_id === decision.block_id);
    if (
      !block ||
      (await insertedDraft(block, raw.result_sha256, edits)).draft_sha256 !==
        decision.draft_sha256
    ) {
      if (pages[decision.page])
        pages[decision.page] = {
          ...pages[decision.page]!,
          checked: false,
          pending_reason: "manual-conflict",
        };
      continue;
    }
    used.push(decision.decision_id);
    locked.add(block.block_id);
    blocks = blocks.map((b) =>
      b !== block
        ? b
        : {
            ...b,
            text:
              decision.action === "replace" && b.type !== "table"
                ? decision.text!
                : b.text,
            html:
              decision.action === "replace" && b.type === "table"
                ? decision.text!
                : b.html,
            text_source: "manual",
            basis: "manual",
          },
    );
  }
  // Recompare after edits. New differences require a specific reasoned edit,
  // rather than disappearing behind a page-level success flag.
  const recomparisonStates = new Set<string>();
  while (true) {
    const residual = findSuspects(input.pages, blocks, removed, drafts);
    for (const s of residual) {
      const previous = suspects.find((p) => p.suspect_id === s.suspect_id);
      const justified = s.tokens.every(
        (token) =>
          decisions.some(
            (d) =>
              used.includes(d.decision_id) &&
              d.page === s.page &&
              d.reason.trim() &&
              [
                d.text,
                ...drafts
                  .filter((b) => b.block_id === d.block_id)
                  .map((b) => b.html ?? b.text),
              ].some((t) => t !== null && textTokens(t).includes(token)),
          ) ||
          edits.some(({ edit: e }) => {
            if (!e.reason.trim()) return false;
            if (e.kind === "insert_after")
              return (
                e.block.page === s.page &&
                textTokens(e.block.html ?? e.block.text).includes(token)
              );
            const d = drafts.find((d) => d.block_id === e.block_id),
              b = blocks.find((b) => b.block_id === e.block_id);
            return (
              (d?.page === s.page || b?.page === s.page) &&
              textTokens(
                [d?.html ?? d?.text ?? "", b?.html ?? b?.text ?? ""].join(" "),
              ).includes(token)
            );
          }),
      );
      if (
        previous?.disposition &&
        (previous.disposition.status !== "fixed" || justified)
      )
        continue;
      if (justified) continue;
      if (!previous) suspects.push(s);
      else if (previous.disposition)
        suspects = suspects.map((p) =>
          p.suspect_id === s.suspect_id ? { ...p, disposition: null } : p,
        );
      pages[s.page] = {
        ...pages[s.page]!,
        checked: false,
        pending_reason:
          pages[s.page]!.pending_reason ?? "correction-new-suspects",
      };
    }
    const pending = pages.filter(
      (page) => page.pending_reason === "correction-new-suspects",
    );
    if (!pending.length || !input.corrector || failure) break;
    // Replay accepted pages from cache, then review only the changed questions.
    // A repeated state is not progress and must never spin or be marked complete.
    const state = JSON.stringify({
      blocks: blocks.map(({ edit_refs: _refs, ...block }) => {
        void _refs;
        return block;
      }),
      unresolved: suspects
        .filter((s) => !s.disposition)
        .map((s) => s.suspect_id),
      pages,
    });
    if (recomparisonStates.has(state)) break;
    recomparisonStates.add(state);
    for (const page of pending) {
      await checkPage(input.pages[page.page]!);
      if (failure) break;
    }
  }
  // Manual text is authoritative even when it intentionally differs from the PDF layer.
  for (const p of pages) {
    if (p.pending_reason === "manual-conflict") continue;
    if (
      input.pages[p.page]!.kind !== "blank" &&
      p.checked &&
      !p.no_body_reason &&
      !blocks.some(
        (b) =>
          b.page === p.page ||
          b.continuation_regions.some((r) => r.page === p.page),
      )
    )
      failure = {
        page: p.page,
        reason: "page-content-missing",
        message: "nonblank-page-has-no-body-content",
      };
  }
  const status = failure
    ? "failed"
    : pages.every((p) => p.checked) && suspects.every((s) => s.disposition)
      ? "complete"
      : "incomplete";
  const parsed = parseProofreadBlocksV1(
    { schema_version: 1, page_count: pages.length, blocks },
    raw.resources.map((r) => r.reference),
  );
  const rendered = renderBlocks(parsed.blocks, raw.resources);
  const required = new Set(raw.resources.map((r) => r.reference));
  for (const { edit: e } of edits)
    if (e.kind === "insert_after" && e.block.image_ref)
      required.add(e.block.image_ref);
  const resources = [];
  for (const r of raw.resources.filter((r) => required.has(r.reference))) {
    const bytes = await input.reader.readArtifact(
      raw.raw_parse_id,
      "image",
      r.reference,
      input.signal,
    );
    if (
      bytes.length !== r.artifact.byte_size ||
      (await sha256(bytes)) !== r.artifact.sha256
    )
      throw new Error("proofread-resource-integrity");
    resources.push({ ...r, bytes });
  }
  const blockBytes = canonicalJsonBytes(parsed),
    blockArtifact = await artifact(blockBytes, "application/json"),
    markdownArtifact = await artifact(rendered.markdown, "text/markdown");
  const stats = {
    text_layer_pages: pages.filter((p) => p.kind === "text-layer").length,
    image_only_pages: pages.filter((p) => p.kind === "image-only").length,
    blank_pages: pages.filter((p) => p.kind === "blank").length,
    missing: suspects.filter((s) => s.kind === "missing").length,
    extra: suspects.filter((s) => s.kind === "extra").length,
    token_mismatch: suspects.filter((s) => s.kind === "token-mismatch").length,
    page_misplaced: suspects.filter((s) => s.kind === "page-misplaced").length,
    fixed: suspects.filter((s) => s.disposition?.status === "fixed").length,
    draft_correct: suspects.filter(
      (s) => s.disposition?.status === "draft-correct",
    ).length,
    agent_deletions: edits.filter(
      (e) =>
        e.edit.kind === "delete" && e.edit.reason !== "manual-document-edit",
    ).length,
    ...usage,
    elapsed_ms: Math.round(performance.now() - started),
  };
  const value: ProofreadVersionInput = {
    part_asset_id: raw.source_asset_id,
    part_sha256: raw.source_sha256,
    draft_input: {
      raw_parse_id: raw.raw_parse_id,
      profile: raw.profile,
      result_sha256: raw.result_sha256,
    },
    method: proofreadMethod(input.page_method, input.corrector),
    manual_decision_ids: used,
    status,
    pages,
    suspects,
    edits,
    blocks: blockArtifact,
    markdown: markdownArtifact,
    resources: resources.map(({ bytes: _bytes, ...r }) => {
      void _bytes;
      return r;
    }),
    stats,
    failure,
  };
  const version = await parseProofreadVersion({
    ...value,
    ...(await proofreadIdentity(value)),
  });
  return {
    version,
    blocks: { artifact: blockArtifact, bytes: blockBytes },
    markdown: { artifact: markdownArtifact, bytes: rendered.markdown },
    resources,
    ranges: rendered.ranges,
    drafts,
    removed,
    usage,
  };
}
