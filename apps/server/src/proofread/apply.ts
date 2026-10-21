import {
  parseProofreadEdit,
  parseProofreadDisposition,
  type ProofreadEdit,
  type ProofreadBlock,
  type ProofreadEditRecord,
} from "@sciretriever/contracts";
import {
  proofreadId,
  requireTableMarkup,
  type CorrectionContext,
  type CorrectionSubmission,
  type DraftBlock,
} from "./contract.js";
export function draftBlocks(
  drafts: readonly DraftBlock[],
  context: Pick<CorrectionContext, "pages">,
): ProofreadBlock[] {
  return drafts.map((d) => ({
    block_id: d.block_id,
    page: d.page,
    region: d.region,
    continuation_regions: d.continuation_regions,
    locate: d.locate,
    type: d.type,
    title_level: d.title_level,
    text: d.text,
    html: d.html,
    image_ref: d.image_ref,
    text_source: d.text_source,
    basis:
      context.pages[d.page]!.kind === "text-layer"
        ? "text-layer"
        : "image-only",
    uncertainty: null,
    raw_ref: d.raw_ref,
    edit_refs: [],
  }));
}
function fail(code: string): never {
  throw Object.assign(new Error(code), { code });
}
export function parseCorrectionSubmission(
  value: unknown,
  input: CorrectionContext,
): CorrectionSubmission {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("proofread-correction-invalid");
  const r = value as Record<string, unknown>;
  if (
    Object.keys(r).sort().join() !== "dispositions,edits,no_body_reason" ||
    !Array.isArray(r.edits) ||
    r.edits.length > 10000 ||
    !Array.isArray(r.dispositions) ||
    r.dispositions.length > 10000 ||
    (r.no_body_reason !== null &&
      (typeof r.no_body_reason !== "string" ||
        !r.no_body_reason.trim() ||
        r.no_body_reason.length > 65536))
  )
    fail("proofread-correction-invalid");
  const expected = new Set(input.suspects.map((s) => s.suspect_id)),
    seen = new Set<string>();
  const dispositions = r.dispositions.map((v: unknown) => {
    if (
      !v ||
      typeof v !== "object" ||
      Array.isArray(v) ||
      Object.keys(v).sort().join() !== "disposition,suspect_id"
    )
      fail("proofread-disposition-invalid");
    const d = v as Record<string, unknown>;
    if (
      typeof d.suspect_id !== "string" ||
      !expected.has(d.suspect_id) ||
      seen.has(d.suspect_id)
    )
      fail("proofread-disposition-invalid");
    seen.add(d.suspect_id);
    return {
      suspect_id: d.suspect_id,
      disposition: parseProofreadDisposition(d.disposition),
    };
  });
  if (seen.size !== expected.size) fail("proofread-disposition-incomplete");
  const edits = r.edits.map((e) =>
    parseProofreadEdit(e, input.pages.length, input.resources),
  );
  return {
    edits,
    dispositions,
    no_body_reason: r.no_body_reason as string | null,
  };
}
/** Validate the entire edit batch before publishing any changed bytes. */
export function applyEdits(
  blocks: readonly ProofreadBlock[],
  submission: CorrectionSubmission,
  input: CorrectionContext,
  locked: ReadonlySet<string> = new Set(),
) {
  const result = [...blocks],
    records: ProofreadEditRecord[] = [];
  const touched = new Map<string, Set<string>>(),
    moves = new Map<string, string>();
  const known = new Set(blocks.map((b) => b.block_id));
  const deleted = new Set(
    submission.edits.filter((e) => e.kind === "delete").map((e) => e.block_id),
  );
  const inserted = new Set<string>();
  const editIdentity = (edit: ProofreadEdit) =>
    proofreadId([
      "proofread-edit-v2",
      input.asset_sha256,
      input.page.page,
      edit,
    ]);
  for (const edit of submission.edits) {
    if (Math.abs(edit.basis_page - input.page.page) > 1)
      fail("proofread-edit-page-scope");
    if (edit.kind === "insert_after") {
      if (edit.block.type === "table") requireTableMarkup(edit.block.html);
      const identity = proofreadId(edit);
      if (
        inserted.has(identity) ||
        known.has(proofreadId(["inserted-block", editIdentity(edit)]))
      )
        fail("proofread-edit-conflict");
      inserted.add(identity);
      if (
        edit.after_block_id !== null &&
        (!known.has(edit.after_block_id) || deleted.has(edit.after_block_id))
      )
        fail("proofread-edit-target");
      if (Math.abs(edit.block.page - input.page.page) > 1)
        fail("proofread-edit-page-scope");
      continue;
    }
    const target = blocks.find((b) => b.block_id === edit.block_id);
    if (!target) fail("proofread-edit-target");
    if (edit.kind === "replace" && target.type === "table")
      requireTableMarkup(edit.text);
    if (locked.has(edit.block_id)) fail("proofread-manual-locked");
    if (
      Math.abs(target.page - input.page.page) > 1 &&
      !input.suspects.some((s) => s.block_ids.includes(target.block_id))
    )
      fail("proofread-edit-page-scope");
    const kinds = touched.get(edit.block_id) ?? new Set<string>();
    if (
      kinds.has(edit.kind) ||
      kinds.has("delete") ||
      (edit.kind === "delete" && kinds.size)
    )
      fail("proofread-edit-conflict");
    kinds.add(edit.kind);
    touched.set(edit.block_id, kinds);
    if (edit.kind === "move") {
      if (
        edit.after_block_id === edit.block_id ||
        (edit.after_block_id !== null &&
          (!known.has(edit.after_block_id) ||
            deleted.has(edit.after_block_id))) ||
        Math.abs(edit.page - input.page.page) > 1
      )
        fail("proofread-edit-target");
      if (edit.after_block_id !== null)
        moves.set(edit.block_id, edit.after_block_id);
    }
  }
  for (const id of moves.keys()) {
    const seen = new Set<string>();
    let next: string | undefined = id;
    while (next) {
      if (seen.has(next)) fail("proofread-edit-cycle");
      seen.add(next);
      next = moves.get(next);
    }
  }
  const basis = (page: number) =>
    input.pages[page]!.kind === "text-layer"
      ? ("text-layer" as const)
      : ("image-only" as const);
  // Apply span annotations after text changes, independent of the submitted order.
  for (const edit of [...submission.edits].sort(
    (a, b) =>
      Number(a.kind === "mark_uncertain") - Number(b.kind === "mark_uncertain"),
  )) {
    const edit_id = editIdentity(edit);
    records.push({ edit_id, edit });
    if (edit.kind === "insert_after") {
      const block: ProofreadBlock = {
        ...edit.block,
        block_id: proofreadId(["inserted-block", edit_id]),
        locate: edit.block.region ? "region" : "page",
        continuation_regions: [],
        text_source: "agent",
        basis: basis(edit.block.page),
        uncertainty: null,
        raw_ref: [],
        edit_refs: [edit_id],
      };
      result.splice(
        edit.after_block_id === null
          ? 0
          : result.findIndex((b) => b.block_id === edit.after_block_id) + 1,
        0,
        block,
      );
      continue;
    }
    const i = result.findIndex((b) => b.block_id === edit.block_id);
    if (i < 0) fail("proofread-edit-target");
    const b = result[i]!;
    if (edit.kind === "delete") {
      result.splice(i, 1);
      continue;
    }
    let updated: ProofreadBlock = {
      ...b,
      text_source: "agent",
      basis: b.uncertainty ? "uncertain" : basis(b.page),
      edit_refs: [...new Set([...b.edit_refs, edit_id])],
    };
    if (edit.kind === "replace")
      updated = {
        ...updated,
        text: b.type === "table" ? b.text : edit.text,
        html: b.type === "table" ? edit.text : b.html,
        // A replacement invalidates old character offsets, not the unresolved concern.
        uncertainty: b.uncertainty
          ? { ...b.uncertainty, span: [0, edit.text.length] }
          : null,
      };
    if (edit.kind === "move") {
      updated = {
        ...updated,
        page: edit.page,
        region: null,
        locate: "page",
        continuation_regions: [],
        basis: b.uncertainty ? "uncertain" : basis(edit.page),
      };
      result.splice(i, 1);
      result.splice(
        edit.after_block_id === null
          ? 0
          : result.findIndex((b) => b.block_id === edit.after_block_id) + 1,
        0,
        updated,
      );
      continue;
    }
    if (edit.kind === "mark_uncertain") {
      if (edit.span[1] > (updated.html ?? updated.text).length)
        fail("proofread-edit-span");
      updated = {
        ...updated,
        basis: "uncertain",
        uncertainty: {
          span: edit.span,
          reason: edit.reason,
          page: edit.basis_page,
        },
      };
    }
    result[i] = updated;
  }
  // Explicit ordering changes are stable within each page; final document pages remain monotone.
  result.sort((a, b) => a.page - b.page);
  return { blocks: result, edits: records };
}
