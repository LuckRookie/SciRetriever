import {
  parseArrangementOperation,
  parseArrangementSubmission,
  parseArrangementSnapshot,
  type ArrangementOperation,
  type ArrangementLeaf,
  type ArrangementSourceBlock,
  type ArrangementSnapshot,
  type LeafDestination,
  type SourceSpan,
  type ParagraphBreakCandidate,
  type ParagraphBreakDecision,
} from "@sciretriever/contracts";
import {
  ArchiveTextError,
  cpSlice,
  textHash,
  textId,
  type ArchiveTextSource,
} from "./text-source.js";
export const ARRANGEMENT_METHOD = "arrangement-operations-v1";
export const PARAGRAPH_BREAK_RULE = "paragraph-break-v1";
export const BODY_ROLES = new Set([
  "introduction",
  "methods",
  "results-discussion",
  "conclusion",
  "additional",
]);
const keyTarget = (d: LeafDestination) =>
  d.kind === "assigned" ? JSON.stringify(d.target) : null;
export function arrangementOperationKey(op: ArrangementOperation): string {
  if (op.kind === "assign" || op.kind === "drop")
    return `destination:${op.leaf_id}`;
  if (op.kind === "split") return `split:${op.root_block_id}`;
  if (op.kind === "merge") return `merge:${op.leaf_ids[0]}`;
  if (op.kind === "caption") return `caption:${op.object_leaf_id}`;
  return `page:${op.leaf_id}`;
}
export function arrangementLeafId(
  root: string,
  start: number,
  end: number,
  resultHash: string,
) {
  return textId(["arrangement-leaf-v1", resultHash, root, start, end]);
}
/** The draft and the final review share exactly the same program-derived identities. */
export function arrangementLeafSpans(
  root: ArrangementSourceBlock,
  resultHash: string,
  splitCuts: readonly number[] = [],
) {
  const cuts = [0, ...splitCuts, [...root.text].length];
  return cuts.slice(1).map((end, i) => ({
    leaf_id: arrangementLeafId(root.root_block_id, cuts[i]!, end, resultHash),
    start: cuts[i]!,
    end,
  }));
}
export interface ArrangementReview {
  readonly leaves: readonly ArrangementLeaf[];
  readonly destinations: ReadonlyMap<string, LeafDestination>;
  readonly operations: readonly ArrangementOperation[];
  readonly candidates: readonly ParagraphBreakCandidate[];
  readonly candidates_sha256: string;
}
export interface ArrangementConstraints {
  readonly viewed_pages?: ReadonlySet<number>;
  /** For host-held draft batches; final review and acceptance always require coverage. */
  readonly allow_incomplete?: boolean;
  readonly locked_destinations?: ReadonlyMap<string, LeafDestination>;
  readonly manual_revision?: number;
  readonly locked_decisions?: ReadonlyMap<string, string>;
  readonly locked_spans?: readonly SourceSpan[];
}
export function reviewArrangement(
  source: ArchiveTextSource,
  values: readonly unknown[],
  constraints: ArrangementConstraints = {},
): ArrangementReview {
  const ops = values.map(parseArrangementOperation),
    issues: { code: string; id: string | null }[] = [];
  const add = (code: string, id: string | null) => issues.push({ code, id });
  const keys = new Set<string>();
  for (const op of ops) {
    const key = arrangementOperationKey(op);
    if (keys.has(key)) add("duplicate-operation", key);
    keys.add(key);
  }
  const splits = new Map(
    ops.filter((o) => o.kind === "split").map((o) => [o.root_block_id, o]),
  );
  for (const id of splits.keys())
    if (!source.blocks.some((b) => b.root_block_id === id))
      add("unknown-root", id);
  const leaves: ArrangementLeaf[] = [];
  for (const root of source.blocks) {
    const length = [...root.text].length,
      cuts = [0, ...(splits.get(root.root_block_id)?.cuts ?? []), length];
    if (cuts.slice(1, -1).some((p) => p >= length)) {
      add("split-out-of-range", root.root_block_id);
      continue;
    }
    for (const { leaf_id, start, end } of arrangementLeafSpans(
      root,
      source.raw.result_sha256,
      splits.get(root.root_block_id)?.cuts,
    )) {
      const text = cpSlice(root.text, start, end);
      if (
        root.type === "table" &&
        cuts.length > 2 &&
        !/^\s*<table\b[^>]*>[\s\S]*<\/table>\s*$/iu.test(text)
      )
        add("split-table-format", root.root_block_id);
      leaves.push({
        leaf_id,
        source: {
          root_block_id: root.root_block_id,
          source_sha256: root.source_sha256,
          start,
          end,
        },
        type: root.type,
        original_text: text,
        page_index: root.page_hint,
        region: root.region_hint,
        image_ref: root.image_ref,
      });
    }
  }
  const byId = new Map(leaves.map((l) => [l.leaf_id, l])),
    destinations = new Map<string, LeafDestination>();
  for (const op of ops) {
    if ("leaf_id" in op && !byId.has(op.leaf_id)) {
      add("unknown-leaf", op.leaf_id);
      continue;
    }
    if (op.kind === "assign")
      destinations.set(op.leaf_id, {
        kind: "assigned",
        target: op.target,
        presentation: op.presentation,
      });
    if (op.kind === "drop")
      destinations.set(op.leaf_id, { kind: "dropped", reason: op.reason });
    if (op.kind === "assign-page") {
      if (
        op.page_index >= source.raw.page_count ||
        op.basis_page_index !== op.page_index
      )
        add("invalid-page-assignment", op.leaf_id);
      else if (
        constraints.viewed_pages &&
        !constraints.viewed_pages.has(op.basis_page_index)
      )
        add("page-basis-not-viewed", op.leaf_id);
    }
  }
  // Leaves are immutable contract values; replace page assignments rather than mutate callers.
  const assignedLeaves = leaves.map((l) => {
    const op = ops.find(
      (o) => o.kind === "assign-page" && o.leaf_id === l.leaf_id,
    );
    const root = source.blocks.find(
      (b) => b.root_block_id === l.source.root_block_id,
    )!;
    return op?.kind === "assign-page" && op.page_index < source.raw.page_count
      ? {
          ...l,
          page_index: op.page_index,
          region: op.page_index === root.page_hint ? root.region_hint : null,
        }
      : l;
  });
  const finalById = new Map(assignedLeaves.map((l) => [l.leaf_id, l]));
  for (const l of assignedLeaves) {
    if (!destinations.has(l.leaf_id) && !constraints.allow_incomplete)
      add("leaf-destination-missing", l.leaf_id);
    const lock = constraints.locked_destinations?.get(l.leaf_id);
    if (
      lock &&
      textHash(lock) !== textHash(destinations.get(l.leaf_id) ?? null)
    )
      add("manual-conflict", l.leaf_id);
  }
  if (constraints.locked_destinations)
    for (const id of constraints.locked_destinations.keys())
      if (!finalById.has(id)) add("manual-conflict", id);
  for (const span of constraints.locked_spans ?? []) {
    const leaf = assignedLeaves.find(
      (l) => textHash(l.source) === textHash(span),
    );
    if (!leaf || destinations.get(leaf.leaf_id)?.kind !== "assigned")
      add("manual-conflict", span.root_block_id);
  }
  for (const [id, d] of destinations) {
    if (
      d.kind === "assigned" &&
      d.target.role === "additional" &&
      d.target.original_heading_leaf_id !== null
    ) {
      const heading = finalById.get(d.target.original_heading_leaf_id),
        hd = destinations.get(d.target.original_heading_leaf_id);
      if (
        !heading ||
        heading.type !== "title" ||
        hd?.kind !== "assigned" ||
        keyTarget(hd) !== keyTarget(d)
      )
        add("additional-heading-invalid", id);
    }
  }
  const captions = new Set<string>();
  for (const op of ops.filter((o) => o.kind === "caption")) {
    const object = finalById.get(op.object_leaf_id);
    if (
      !object ||
      !["image", "table"].includes(object.type) ||
      destinations.get(op.object_leaf_id)?.kind !== "assigned"
    )
      add("caption-object-invalid", op.object_leaf_id);
    for (const id of op.caption_leaf_ids) {
      const leaf = finalById.get(id);
      if (
        !leaf ||
        leaf.type !== "caption" ||
        destinations.get(id)?.kind !== "assigned" ||
        id === op.object_leaf_id ||
        captions.has(id)
      )
        add("caption-invalid", id);
      captions.add(id);
    }
  }
  const eligible = (id: string) => {
    const l = finalById.get(id),
      d = destinations.get(id);
    return (
      !!l &&
      ["text", "list", "aside"].includes(l.type) &&
      d?.kind === "assigned" &&
      d.presentation.kind === "content" &&
      BODY_ROLES.has(d.target.role)
    );
  };
  const independent = (id: string) => {
    const l = finalById.get(id),
      d = destinations.get(id);
    return (
      d?.kind === "dropped" ||
      (!!l && ["footnote", "image", "table", "caption"].includes(l.type))
    );
  };
  const merged = new Set<string>();
  for (const op of ops.filter((o) => o.kind === "merge")) {
    let prior = -1;
    const target = destinations.get(op.leaf_ids[0]!);
    for (const id of op.leaf_ids) {
      const index = assignedLeaves.findIndex((l) => l.leaf_id === id);
      if (
        index <= prior ||
        !eligible(id) ||
        merged.has(id) ||
        keyTarget(
          destinations.get(id) ?? { kind: "dropped", reason: "decoration" },
        ) !== keyTarget(target ?? { kind: "dropped", reason: "decoration" })
      )
        add("merge-invalid", id);
      if (prior >= 0)
        for (const l of assignedLeaves.slice(prior + 1, index))
          if (!independent(l.leaf_id)) add("merge-crosses-body", l.leaf_id);
      prior = index;
      merged.add(id);
    }
  }
  if (issues.length) throw new ArchiveTextError("arrangement-invalid", issues);
  const candidates: ParagraphBreakCandidate[] = [];
  let previous: ArrangementLeaf | undefined;
  for (const leaf of assignedLeaves) {
    if (!eligible(leaf.leaf_id)) {
      if (!independent(leaf.leaf_id)) previous = undefined;
      continue;
    }
    if (previous) {
      const left = previous.original_text.trimEnd(),
        right = leaf.original_text.trimStart(),
        a = destinations.get(previous.leaf_id)!,
        b = destinations.get(leaf.leaf_id)!;
      if (
        keyTarget(a) === keyTarget(b) &&
        left.length > 0 &&
        !/[.?!:;。？！：；]$/u.test(left) &&
        /^[\p{Ll}\p{N})\]}’”"']/u.test(right)
      ) {
        const body = {
          left_leaf_id: previous.leaf_id,
          right_leaf_id: leaf.leaf_id,
          skipped_leaf_ids: assignedLeaves
            .slice(
              assignedLeaves.indexOf(previous) + 1,
              assignedLeaves.indexOf(leaf),
            )
            .map((l) => l.leaf_id),
          input_sha256: source.input_sha256,
          rule_version: PARAGRAPH_BREAK_RULE,
          left_ends_with_hyphen: left.endsWith("-"),
        };
        candidates.push({ candidate_id: textHash(body), ...body });
      }
    }
    previous = leaf;
  }
  return {
    leaves: assignedLeaves,
    destinations,
    operations: ops,
    candidates,
    candidates_sha256: textHash({
      source: source.input_sha256,
      operations: ops,
      candidates,
    }),
  };
}
export function acceptArrangement(
  source: ArchiveTextSource,
  value: unknown,
  methodHash: string,
  constraints: ArrangementConstraints = {},
): ArrangementSnapshot {
  const s = parseArrangementSubmission(value),
    review = reviewArrangement(source, s.operations, constraints),
    issues: { code: string; id: string | null }[] = [];
  if (s.source_input_sha256 !== source.input_sha256)
    issues.push({ code: "source-input-stale", id: null });
  if (s.reviewed_candidates_sha256 !== review.candidates_sha256)
    issues.push({ code: "break-review-stale", id: null });
  const decisions = new Map<string, ParagraphBreakDecision>();
  for (const d of s.break_decisions) {
    if (
      decisions.has(d.candidate_id) ||
      !review.candidates.some((c) => c.candidate_id === d.candidate_id)
    )
      issues.push({ code: "break-decision-invalid", id: d.candidate_id });
    decisions.set(d.candidate_id, d);
  }
  for (const c of review.candidates) {
    const d = decisions.get(c.candidate_id),
      isMerged = review.operations.some(
        (o) =>
          o.kind === "merge" &&
          o.leaf_ids.includes(c.left_leaf_id) &&
          o.leaf_ids.includes(c.right_leaf_id),
      );
    if (!d || (d.decision === "merge") !== isMerged)
      issues.push({
        code: "break-decision-missing-or-conflicting",
        id: c.candidate_id,
      });
  }
  if (issues.length) throw new ArchiveTextError("arrangement-invalid", issues);
  const body = {
    schema_version: 1 as const,
    source_input_sha256: source.input_sha256,
    method_sha256: methodHash,
    leaves: review.leaves,
    operations: review.operations,
    destinations: review.leaves.map((l) => ({
      leaf_id: l.leaf_id,
      destination: review.destinations.get(l.leaf_id)!,
      decision_id: constraints.locked_decisions?.get(l.leaf_id) ?? null,
      locked: constraints.locked_decisions?.has(l.leaf_id) ?? false,
    })),
    break_candidates: review.candidates,
    break_decisions: s.break_decisions,
    manual_revision: constraints.manual_revision ?? 0,
  };
  const snapshot = parseArrangementSnapshot(
    { ...body, arrangement_id: textHash(body) },
    source.raw.page_count,
  );
  verifyArrangementPayload(
    source,
    snapshot,
    arrangementPreview(snapshot).flatMap((node) => node.payloads),
  );
  return snapshot;
}
export function verifyArrangement(
  source: ArchiveTextSource,
  value: unknown,
  methodHash: string,
  constraints: ArrangementConstraints = {},
): ArrangementSnapshot {
  const old = parseArrangementSnapshot(value, source.raw.page_count);
  const { arrangement_id, ...oldBody } = old;
  if (textHash(oldBody) !== arrangement_id)
    throw new ArchiveTextError("source-integrity");
  const locks = new Map(
    old.destinations
      .filter((d) => d.locked)
      .map((d) => [d.leaf_id, d.destination]),
  );
  constraints = {
    ...constraints,
    locked_destinations: locks,
    locked_decisions: new Map(
      old.destinations
        .filter((d) => d.locked)
        .map((d) => [d.leaf_id, d.decision_id!]),
    ),
  };
  const review = reviewArrangement(source, old.operations, constraints),
    fresh = acceptArrangement(
      source,
      {
        schema_version: 1,
        source_input_sha256: source.input_sha256,
        reviewed_candidates_sha256: review.candidates_sha256,
        operations: old.operations,
        break_decisions: old.break_decisions,
      },
      methodHash,
      { ...constraints, manual_revision: old.manual_revision },
    );
  if (textHash(old) !== textHash(fresh))
    throw new ArchiveTextError("source-integrity");
  return fresh;
}
/** Validate payload independently of Markdown syntax; no trim or word comparison. */
export function verifyArrangementPayload(
  source: ArchiveTextSource,
  snapshot: ArrangementSnapshot,
  payloads: readonly { leaf_id: string; text: string }[],
): void {
  const retained = new Set(
    snapshot.destinations
      .filter((d) => d.destination.kind === "assigned")
      .map((d) => d.leaf_id),
  );
  const seen = new Set<string>();
  for (const p of payloads) {
    const leaf = snapshot.leaves.find((l) => l.leaf_id === p.leaf_id),
      root =
        leaf &&
        source.blocks.find(
          (b) => b.root_block_id === leaf.source.root_block_id,
        );
    if (
      !leaf ||
      !retained.has(p.leaf_id) ||
      !root ||
      seen.has(p.leaf_id) ||
      leaf.source.source_sha256 !== root.source_sha256 ||
      p.text !== cpSlice(root.text, leaf.source.start, leaf.source.end)
    )
      throw new ArchiveTextError("arrangement-text-difference", [
        { code: "payload-changed", id: p.leaf_id },
      ]);
    seen.add(p.leaf_id);
  }
  if (seen.size !== retained.size)
    throw new ArchiveTextError("arrangement-text-difference", [
      { code: "payload-missing", id: null },
    ]);
}

export interface ArrangementPreviewNode {
  readonly leaf_ids: readonly string[];
  readonly text: string;
  readonly payloads: readonly { leaf_id: string; text: string }[];
  readonly joiners: readonly string[];
  readonly out_of_flow: boolean;
}
/** An audit projection, not a published DocumentVersion or Markdown builder. */
export function arrangementPreview(
  snapshot: ArrangementSnapshot,
): readonly ArrangementPreviewNode[] {
  const destinations = new Map(
    snapshot.destinations.map((d) => [d.leaf_id, d.destination]),
  );
  const retained = (id: string) => destinations.get(id)?.kind === "assigned";
  const byId = new Map(snapshot.leaves.map((l) => [l.leaf_id, l]));
  const groups = new Map(
    snapshot.operations
      .filter((o) => o.kind === "merge")
      .map((o) => [o.leaf_ids[0]!, o.leaf_ids]),
  );
  const tails = new Set([...groups.values()].flatMap((ids) => ids.slice(1)));
  const captions = new Map(
    snapshot.operations
      .filter((o) => o.kind === "caption")
      .map((o) => [o.object_leaf_id, o.caption_leaf_ids]),
  );
  const captionIds = new Set([...captions.values()].flat());
  const emitted = new Set<string>(),
    nodes: ArrangementPreviewNode[] = [];
  const emit = (id: string, outOfFlow = false) => {
    if (emitted.has(id) || !retained(id)) return;
    const ids = groups.get(id) ?? [id];
    const payloads = ids.map((key) => ({
      leaf_id: key,
      text: byId.get(key)!.original_text,
    }));
    const joiners = ids
      .slice(1)
      .map((_, i) => (payloads[i]!.text.trimEnd().endsWith("-") ? "" : " "));
    nodes.push({
      leaf_ids: ids,
      payloads,
      joiners,
      text: payloads.map((p, i) => (i ? joiners[i - 1] : "") + p.text).join(""),
      out_of_flow: outOfFlow,
    });
    ids.forEach((key) => emitted.add(key));
    for (const key of captions.get(id) ?? []) emit(key, true);
    if (ids.length > 1) {
      const first = snapshot.leaves.findIndex((l) => l.leaf_id === ids[0]),
        last = snapshot.leaves.findIndex((l) => l.leaf_id === ids.at(-1));
      for (const leaf of snapshot.leaves.slice(first + 1, last))
        if (!ids.includes(leaf.leaf_id)) emit(leaf.leaf_id, true);
    }
  };
  for (const leaf of snapshot.leaves)
    if (!tails.has(leaf.leaf_id) && !captionIds.has(leaf.leaf_id))
      emit(leaf.leaf_id);
  return nodes;
}
