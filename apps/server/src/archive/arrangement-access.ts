import { SqliteRawParseStorage } from "../storage/raw-parsing.js";
import { randomUUID } from "node:crypto";
import {
  longDocumentInfo,
  annotationRecord,
  annotationInteger,
  parseAssetId,
  parseArrangementEditRequest,
  parseArrangementQueryV2,
  ARCHIVE_SECTION_ROLES,
  ARCHIVE_DROP_REASONS,
  canonicalJsonBytes,
  archivePageCursor,
} from "@sciretriever/contracts";
import { SqliteArchiveTextStorage } from "../storage/archive-text.js";
import { textHash, ArchiveTextError } from "./text-source.js";
import { acceptArrangement, reviewArrangement } from "./arrangement.js";
import {
  archiveTextVersion,
  pendingArchivePages,
  archiveStop,
  type ArchiveTextPipeline,
} from "./text-pipeline.js";
import { emptyArchiveUsage } from "./text-session.js";
import {
  renderArrangement,
  arrangedBuilderFor,
  LEGACY_ARRANGED_DOCUMENT_BUILDER,
  isArrangedBuilder,
} from "./render.js";
import { mapMarkdownEdit } from "./markdown-edit.js";
import {
  applyLeafCorrections,
  pageReviewSuspects,
} from "../proofread/leaf-corrections.js";

function cursorRecord(value: string, keys: readonly string[]) {
  try {
    return annotationRecord(JSON.parse(value), keys);
  } catch {
    throw new ArchiveTextError("query-invalid");
  }
}
function jsonWindow(
  bytes: Buffer,
  start: number,
  maximum: number,
  header: object,
  endLimit = bytes.length,
) {
  let end = Math.min(
    bytes.length,
    endLimit,
    start + Math.max(1, maximum - 512),
  );
  while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
  while (
    Buffer.byteLength(
      JSON.stringify({
        ...header,
        text: bytes.subarray(start, end).toString("utf8"),
      }),
    ) >
    maximum - 512
  ) {
    end = start + Math.floor((end - start) / 2);
    while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
    if (end <= start) throw new ArchiveTextError("response-too-large");
  }
  return { end, text: bytes.subarray(start, end).toString("utf8") };
}
export class ArchiveArrangementAccess {
  constructor(
    readonly storage: SqliteArchiveTextStorage,
    readonly pipeline?: ArchiveTextPipeline,
  ) {}
  async inspect(value: unknown, signal?: AbortSignal) {
    const r = annotationRecord(value, [
      "asset_id",
      ...Object.keys(value && typeof value === "object" ? value : {}).filter(
        (k) => k !== "asset_id",
      ),
    ]);
    if (
      Object.keys(r).some(
        (k) =>
          ![
            "asset_id",
            "schema_version",
            "proofread_id",
            "offset",
            "limit",
            "max_bytes",
            "unresolved_only",
            "block_id",
            "page_offset",
            "page_limit",
          ].includes(k),
      )
    )
      throw new ArchiveTextError("query-invalid");
    const asset = parseAssetId(r.asset_id),
      state = await this.storage.state(asset, signal),
      id = r.proofread_id
        ? parseAssetId(r.proofread_id)
        : state.current
          ? String(state.current.proofread_id)
          : null;
    const output = id ? await this.storage.load(id, signal) : null;
    if (!output) return null;
    if (output.version.part_asset_id !== asset)
      throw new ArchiveTextError("input-stale");
    const offset = annotationInteger(r.offset ?? 0),
      max = annotationInteger(r.max_bytes ?? 65536, 1024, 65536),
      pages = output.version.pages.filter(
        (p) =>
          !r.unresolved_only ||
          p.status !== "accepted" ||
          p.dispositions.some((d) => d.status === "uncertain"),
      );
    const bytes = Buffer.from(
      canonicalJsonBytes({
        version: output.version,
        pages,
        leaves: output.bundle.leaves.filter(
          (l) => r.block_id === undefined || l.leaf.leaf_id === r.block_id,
        ),
      }),
    );
    if (
      offset > bytes.length ||
      (offset < bytes.length && (bytes[offset]! & 0xc0) === 0x80)
    )
      throw new ArchiveTextError("query-invalid");
    const { end, text } = jsonWindow(bytes, offset, max, {
      asset_id: asset,
      proofread_id: id,
    });
    return {
      schema_version: 2,
      format: "arranged-v2",
      asset_id: asset,
      proofread_id: id,
      manual_revision: state.manual_revision,
      encoding: "json-utf8",
      start: offset,
      end,
      total_bytes: bytes.length,
      text,
      next_offset: end < bytes.length ? end : null,
    };
  }
  private async renderFixed(
    bundle: import("@sciretriever/contracts").ArchiveTextBundleV2,
    version: import("@sciretriever/contracts").ProofreadVersionV2,
    signal?: AbortSignal,
  ) {
    const binding = await this.storage.database.proofread<{
      document_version_id: string;
    } | null>("binding", version.part_asset_id, signal);
    const fixed = binding
      ? await this.storage.database.documentVersion(binding.document_version_id)
      : null;
    const builder =
      fixed?.version.schema_version === 2 &&
      fixed.version.proofread_id === version.proofread_id &&
      isArrangedBuilder(fixed.version.builder_version)
        ? fixed.version.builder_version
        : version.method.arrange.includes("/arrangement-single-pass-v2/")
          ? arrangedBuilderFor(bundle)
          : LEGACY_ARRANGED_DOCUMENT_BUILDER;
    return renderArrangement(bundle, version.resources, builder);
  }
  async save(value: unknown, actor: string, signal?: AbortSignal) {
    if (
      !value ||
      typeof value !== "object" ||
      !("schema_version" in value) ||
      value.schema_version !== 2
    )
      throw new ArchiveTextError("archive-contract-obsolete");
    const r = annotationRecord(value, [
        "schema_version",
        "literature_id",
        "asset_id",
        "proofread_id",
        "expected_arrangement_id",
        "expected_manual_revision",
        "markdown",
        ...(Object.hasOwn(value, "actor") ? ["actor"] : []),
      ]),
      asset = parseAssetId(r.asset_id),
      id = parseAssetId(r.proofread_id),
      pipeline = this.pipeline;
    if (!pipeline || typeof r.markdown !== "string")
      throw new ArchiveTextError("input-missing");
    const state = await this.storage.decisions(asset, signal),
      old = await this.storage.load(id, signal);
    if (
      !old ||
      old.version.status !== "complete" ||
      old.version.part_asset_id !== asset ||
      state.current?.proofread_id !== id ||
      state.manual_revision !== r.expected_manual_revision ||
      old.version.arrangement_id !== r.expected_arrangement_id
    )
      throw new ArchiveTextError("publication-conflict");
    const literature = parseAssetId(r.literature_id),
      binding = await this.storage.database.documentMaterial(literature, asset);
    if (!binding) throw new ArchiveTextError("input-stale");
    const rendered = await this.renderFixed(old.bundle, old.version, signal),
      mapped = mapMarkdownEdit(
        rendered.markdown,
        r.markdown,
        rendered.source_map,
      );
    if (mapped.status === "mapping-conflict")
      return {
        schema_version: 2,
        saved: false,
        changed: false,
        conflict: mapped,
      };
    if (!mapped.changes.length)
      return {
        schema_version: 2,
        saved: true,
        changed: false,
        proofread_id: id,
        rebuild: { status: "unchanged" },
      };
    const source = await pipeline.source(asset, "full", signal);
    const { arrangement_id: oldArrangement, ...body } = old.bundle.arrangement!;
    void oldArrangement;
    const snapshotBody = {
        ...body,
        manual_revision: state.manual_revision + 1,
      },
      snapshot = { ...snapshotBody, arrangement_id: textHash(snapshotBody) };
    if (source.input_sha256 !== snapshot.source_input_sha256)
      throw new ArchiveTextError("manual-conflict");
    const edits = new Map(mapped.changes.map((c) => [c.leaf_id, c.text])),
      manualItems: {
        decision_id: string;
        block_id: string;
        scope_key: string;
        value: unknown;
      }[] = [],
      pages = [];
    for (const page of old.version.pages) {
      const retained = snapshot.leaves.filter(
          (l) =>
            l.page_index === page.page_index &&
            old.bundle.leaves.find((row) => row.leaf.leaf_id === l.leaf_id)
              ?.destination.kind === "assigned",
        ),
        deleted = snapshot.leaves.filter(
          (l) => l.page_index === page.page_index && !retained.includes(l),
        );
      const operations = page.corrections
        .filter((c) => !edits.has(c.operation.leaf_id))
        .map((c) => c.operation);
      const decisions = new Map<string, string>();
      for (const leaf of retained) {
        const text = edits.get(leaf.leaf_id);
        if (text === undefined) continue;
        const decision_id = randomUUID();
        decisions.set(leaf.leaf_id, decision_id);
        if (text !== leaf.original_text)
          operations.push({
            kind: "correct",
            leaf_id: leaf.leaf_id,
            start: 0,
            end: [...leaf.original_text].length,
            original: leaf.original_text,
            replacement: text,
            basis_page_index: page.page_index,
            reason: "manual",
          });
        manualItems.push({
          decision_id,
          block_id: leaf.leaf_id,
          scope_key: `leaf:${leaf.source.root_block_id}:${leaf.source.start}:${leaf.source.end}:text`,
          value: {
            schema_version: 2,
            action: "leaf-text",
            decision_id,
            part_asset_id: asset,
            source_span: leaf.source,
            replacement: text,
            locked: true,
            actor,
            created_at: new Date().toISOString(),
          },
        });
      }
      const applied = applyLeafCorrections(
          retained,
          operations,
          page.page_index,
          page.page_input_sha256,
        ),
        corrections = applied.records.map((c) => {
          const decision_id = decisions.get(c.operation.leaf_id);
          if (decision_id)
            return { ...c, source: "manual" as const, decision_id };
          return (
            page.corrections.find((p) => p.correction_id === c.correction_id) ??
            c
          );
        }),
        // ADR 0047 pages carry review notes and no suspects; older pages recompute theirs.
        suspects =
          page.review || page.status === "unreviewed"
            ? []
            : pageReviewSuspects(
                source.pages[page.page_index]!,
                retained,
                deleted,
                page.page_input_sha256,
                applied.texts,
              );
      pages.push({
        ...page,
        corrections,
        suspects,
        dispositions: suspects.map((s) => ({
          suspect_id: s.suspect_id,
          status: "draft-correct" as const,
          reason: "manual",
        })),
        no_change: corrections.length === 0,
      });
    }
    const scopes = new Set(manualItems.map((m) => m.scope_key)),
      ids = state.decisions
        .filter((d) => !scopes.has(String(d.scope_key)))
        .map((d) => String(d.decision_id));
    const output = await archiveTextVersion(
      source,
      snapshot,
      pages,
      emptyArchiveUsage(),
      old.version.method,
      [...ids, ...manualItems.map((m) => m.decision_id)],
      null,
    );
    await this.storage.publish(
      output.version,
      output.bundle,
      {
        current_revision: Number(state.current!.revision),
        manual_revision: state.manual_revision,
      },
      signal,
      { expected_proofread_id: id, actor, items: manualItems },
    );
    let rebuild: unknown;
    try {
      rebuild = {
        status: "done",
        ...(await pipeline.render(literature, asset, signal)),
      };
    } catch {
      rebuild = {
        status: "failed",
        stop: archiveStop("render-failed", "render"),
      };
    }
    return {
      schema_version: 2,
      saved: true,
      changed: true,
      proofread_id: output.version.proofread_id,
      manual_revision: state.manual_revision + 1,
      decision_ids: manualItems.map((m) => m.decision_id),
      rebuild,
    };
  }
  async read(value: unknown, signal?: AbortSignal) {
    const q = parseArrangementQueryV2(value),
      state = await this.storage.state(q.asset_id, signal),
      id =
        q.proofread_id ??
        (state.current ? String(state.current.proofread_id) : null);
    if (!id)
      return {
        schema_version: 2,
        format: "not-built",
        asset_id: q.asset_id,
        editable: false,
        unavailable_code: "not-built",
      };
    const output = await this.storage.load(id, signal);
    if (!output) {
      const legacy = await this.storage.database.proofread<Record<
        string,
        unknown
      > | null>("get", id, signal);
      if (!legacy || legacy.part_asset_id !== q.asset_id)
        throw new ArchiveTextError("input-missing");
      return {
        schema_version: 2,
        format: "legacy-v1",
        asset_id: q.asset_id,
        proofread_id: id,
        arrangement_id: null,
        counts: null,
        editable: false,
        unavailable_code: "legacy-not-arranged",
      };
    }
    const { version, bundle } = output,
      snapshot = bundle.arrangement;
    if (version.part_asset_id !== q.asset_id)
      throw new ArchiveTextError("input-stale");
    const header = {
      schema_version: 2,
      format: "arranged-v2",
      asset_id: q.asset_id,
      proofread_id: id,
      arrangement_id: version.arrangement_id,
      manual_revision: snapshot?.manual_revision ?? state.manual_revision,
    };
    if (q.kind === "summary") {
      const binding = await this.storage.database.proofread<{
        document_version_id: string;
      } | null>("binding", q.asset_id, signal);
      const raw = await new SqliteRawParseStorage(
          this.storage.database,
          this.storage.files,
        ).current(q.asset_id, signal),
        inputCurrent = raw.some(
          (r) => r.result?.raw_parse_id === version.draft_input.raw_parse_id,
        );
      const annotation = binding
        ? await this.storage.database.annotation<{
            current: { annotation_id: string } | null;
          }>("state", binding.document_version_id, signal)
        : null;
      const pending = version.pages.filter(
        (p) => !["accepted", "not-required", "unreviewed"].includes(p.status),
      );
      const statuses = [];
      for (const p of version.pages.slice(0, 200)) {
        const item = {
          page_index: p.page_index,
          status: p.status,
          stop: p.stop,
        };
        if (Buffer.byteLength(JSON.stringify([...statuses, item])) > 16 * 1024)
          break;
        statuses.push(item);
      }
      return {
        ...header,
        long_document: longDocumentInfo(snapshot?.classification),
        default_annotation_id: annotation?.current?.annotation_id ?? null,
        editable:
          inputCurrent &&
          state.current?.proofread_id === id &&
          snapshot !== null,
        unavailable_code: !inputCurrent
          ? "input-stale"
          : state.current?.proofread_id !== id
            ? "not-current"
            : null,
        counts: {
          retained: bundle.leaves.filter(
            (l) => l.destination.kind === "assigned",
          ).length,
          dropped: bundle.leaves.filter((l) => l.destination.kind === "dropped")
            .length,
          corrections: version.pages.reduce(
            (n, p) => n + p.corrections.length,
            0,
          ),
          manual_destination_locks:
            snapshot?.destinations.filter((d) => d.locked).length ?? 0,
          by_section: Object.fromEntries(
            ARCHIVE_SECTION_ROLES.map((role) => [
              role,
              bundle.leaves.filter(
                (l) =>
                  l.destination.kind === "assigned" &&
                  l.destination.target.role === role,
              ).length,
            ]),
          ),
          by_drop_reason: Object.fromEntries(
            ARCHIVE_DROP_REASONS.map((reason) => [
              reason,
              bundle.leaves.filter(
                (l) =>
                  l.destination.kind === "dropped" &&
                  l.destination.reason === reason,
              ).length,
            ]),
          ),
        },
        pending_page_count: pending.length,
        pending_page_indexes: pending.slice(0, 200).map((p) => p.page_index),
        page_status: {
          items: statuses,
          next_cursor:
            version.pages.length > statuses.length
              ? archivePageCursor(id, statuses.length)
              : null,
        },
        default_document_version_id: binding?.document_version_id ?? null,
      };
    }
    if (q.kind === "pages") {
      const cursor =
        q.cursor === null
          ? null
          : cursorRecord(q.cursor, ["proofread_id", "offset"]);
      if (cursor && cursor.proofread_id !== id)
        throw new ArchiveTextError("query-cursor-stale");
      const start = cursor
          ? annotationInteger(cursor.offset, 0, version.pages.length)
          : 0,
        items = [];
      for (const p of version.pages.slice(start, start + q.limit)) {
        const item = {
          page_index: p.page_index,
          status: p.status,
          stop: p.stop,
        };
        if (
          Buffer.byteLength(
            JSON.stringify({ ...header, items: [...items, item] }),
          ) >
          q.max_bytes - 256
        )
          break;
        items.push(item);
      }
      if (!items.length && start < version.pages.length)
        throw new ArchiveTextError("response-too-large");
      const end = start + items.length;
      return {
        ...header,
        items,
        total: version.pages.length,
        next_cursor:
          end < version.pages.length ? archivePageCursor(id, end) : null,
      };
    }
    const rendered =
      version.status === "complete" && snapshot
        ? await this.renderFixed(bundle, version, signal)
        : null;
    const data =
      q.kind === "breaks"
        ? (snapshot?.break_candidates ?? []).map((c) => ({
            candidate: c,
            decision: snapshot!.break_decisions.find(
              (d) => d.candidate_id === c.candidate_id,
            )!,
          }))
        : q.kind === "source-map"
          ? [
              ...(rendered?.source_map ?? []).map((range) => ({
                kind: "payload",
                ...range,
              })),
              ...(rendered?.structural_ranges ?? []).map((range) => ({
                kind: "structure",
                range,
              })),
            ]
          : bundle.leaves.flatMap((l, index) => {
              if (q.kind !== "leaves")
                throw new ArchiveTextError("query-invalid");
              if (q.page_index !== null && q.page_index !== l.leaf.page_index)
                return [];
              if (
                q.visibility !== "all" &&
                (q.visibility === "kept") !==
                  (l.destination.kind === "assigned")
              )
                return [];
              if (
                q.drop_reason !== null &&
                (l.destination.kind !== "dropped" ||
                  l.destination.reason !== q.drop_reason)
              )
                return [];
              const lock = snapshot?.destinations.find(
                (d) => d.leaf_id === l.leaf.leaf_id,
              );
              return [
                {
                  ...l,
                  locked: lock?.locked ?? false,
                  decision_id: lock?.decision_id ?? null,
                  rendered_ranges:
                    rendered?.source_map.filter(
                      (r) => r.leaf_id === l.leaf.leaf_id,
                    ) ?? null,
                  placement: {
                    source_index: index,
                    page_index: l.leaf.page_index,
                    previous_kept_leaf_id:
                      bundle.leaves
                        .slice(0, index)
                        .reverse()
                        .find((l) => l.destination.kind === "assigned")?.leaf
                        .leaf_id ?? null,
                    next_kept_leaf_id:
                      bundle.leaves
                        .slice(index + 1)
                        .find((l) => l.destination.kind === "assigned")?.leaf
                        .leaf_id ?? null,
                  },
                },
              ];
            });
    // JSON-byte continuation keeps even a single unusually long block lossless and bounded.
    const bytes = Buffer.from(canonicalJsonBytes(data)),
      key = textHash({ ...q, proofread_id: id, cursor: null }),
      cursor =
        q.cursor === null
          ? null
          : cursorRecord(Buffer.from(q.cursor, "base64url").toString("utf8"), [
              "key",
              "offset",
            ]);
    if (cursor && cursor.key !== key)
      throw new ArchiveTextError("query-cursor-stale");
    const start = cursor
      ? annotationInteger(cursor.offset, 0, bytes.length)
      : 0;
    if (start < bytes.length && (bytes[start]! & 0xc0) === 0x80)
      throw new ArchiveTextError("query-invalid");
    const ends: number[] = [];
    let position = 1;
    for (const [index, item] of data.entries()) {
      if (index) position++;
      position += Buffer.byteLength(JSON.stringify(item));
      ends.push(position);
    }
    const first = ends.findIndex((e) => e > start),
      itemEnd =
        first < 0
          ? bytes.length
          : ends[Math.min(ends.length - 1, first + q.limit - 1)]!;
    const { end, text } = jsonWindow(
      bytes,
      start,
      q.max_bytes,
      header,
      itemEnd === bytes.length - 1 ? bytes.length : itemEnd,
    );
    return {
      ...header,
      encoding: "json-utf8",
      start,
      end,
      total_bytes: bytes.length,
      text,
      next_cursor:
        end < bytes.length
          ? Buffer.from(JSON.stringify({ key, offset: end })).toString(
              "base64url",
            )
          : null,
    };
  }
  async edit(value: unknown, actor: string, signal?: AbortSignal) {
    const q = parseArrangementEditRequest(value),
      pipeline = this.pipeline;
    if (!pipeline) throw new ArchiveTextError("model-unavailable");
    const state = await this.storage.decisions(q.asset_id, signal),
      old = await this.storage.load(q.expected_proofread_id, signal),
      snapshot = old?.bundle.arrangement;
    if (
      !old ||
      !snapshot ||
      old.version.part_asset_id !== q.asset_id ||
      state.current?.proofread_id !== q.expected_proofread_id ||
      snapshot.arrangement_id !== q.expected_arrangement_id ||
      state.manual_revision !== q.expected_manual_revision
    )
      throw new ArchiveTextError("publication-conflict");
    const binding = await this.storage.database.documentMaterial(
      q.literature_id,
      q.asset_id,
    );
    if (!binding) throw new ArchiveTextError("input-stale");
    const source = await pipeline.source(q.asset_id, "full", signal);
    if (source.input_sha256 !== snapshot.source_input_sha256)
      throw new ArchiveTextError("manual-conflict");
    const changed = new Set(q.changes.map((c) => c.leaf_id)),
      locks = new Map(
        snapshot.destinations
          .filter((d) => d.locked)
          .map((d) => [d.leaf_id, d.decision_id!]),
      ),
      manualItems = [];
    const ops = snapshot.operations.filter((o) =>
      o.kind === "merge"
        ? !o.leaf_ids.some((id) => changed.has(id))
        : o.kind === "assign" || o.kind === "drop"
          ? !changed.has(o.leaf_id)
          : true,
    );
    for (const change of q.changes) {
      const leaf = snapshot.leaves.find((l) => l.leaf_id === change.leaf_id),
        destination = snapshot.destinations.find(
          (d) => d.leaf_id === change.leaf_id,
        )?.destination;
      if (
        !leaf ||
        !destination ||
        (change.kind === "restore") !== (destination.kind === "dropped")
      )
        throw new ArchiveTextError("manual-conflict");
      const decision_id = randomUUID();
      locks.set(change.leaf_id, decision_id);
      ops.push({
        kind: "assign",
        leaf_id: change.leaf_id,
        target: change.target,
        presentation: change.presentation,
      });
      manualItems.push({
        decision_id,
        block_id: change.leaf_id,
        scope_key: `leaf:${leaf.source.root_block_id}:${leaf.source.start}:${leaf.source.end}:destination`,
        value: {
          schema_version: 1,
          action: "arrangement",
          decision_id,
          part_asset_id: q.asset_id,
          source_input_sha256: source.input_sha256,
          source_span: leaf.source,
          change,
          locked: true,
          actor,
          created_at: new Date().toISOString(),
        },
      });
    }
    const viewed = new Set(
        snapshot.operations
          .filter((o) => o.kind === "assign-page")
          .map((o) => o.page_index),
      ),
      review = reviewArrangement(source, ops, { evidence_pages: viewed }),
      decisions = review.candidates.map((c) =>
        review.operations.some(
          (o) =>
            o.kind === "merge" &&
            o.leaf_ids.includes(c.left_leaf_id) &&
            o.leaf_ids.includes(c.right_leaf_id),
        )
          ? { candidate_id: c.candidate_id, decision: "merge" as const }
          : {
              candidate_id: c.candidate_id,
              decision: "keep" as const,
              reason: "manual",
            },
      );
    const next = acceptArrangement(
      source,
      {
        schema_version: 1,
        source_input_sha256: source.input_sha256,
        reviewed_candidates_sha256: review.candidates_sha256,
        operations: ops,
        break_decisions: decisions,
      },
      snapshot.method_sha256,
      {
        evidence_pages: viewed,
        classification: snapshot.classification,
        manual_revision: state.manual_revision + 1,
        locked_decisions: locks,
        format_rule: snapshot.format_rule,
      },
    );
    const pending = pendingArchivePages(source, next),
      pages = pending.map((p) => {
        const prev = old.version.pages[p.page_index]!;
        return textHash(prev.retained_leaf_ids) ===
          textHash(p.retained_leaf_ids) &&
          textHash(prev.classified_leaf_ids) === textHash(p.classified_leaf_ids)
          ? prev
          : p;
      }),
      pendingIndexes = pages
        .filter(
          (p) => !["accepted", "not-required", "unreviewed"].includes(p.status),
        )
        .map((p) => p.page_index);
    const replaced = new Set(manualItems.map((i) => i.scope_key)),
      prior = state.decisions
        .filter((d) => !replaced.has(String(d.scope_key)))
        .map((d) => String(d.decision_id));
    const output = await archiveTextVersion(
      source,
      next,
      pages,
      emptyArchiveUsage(),
      old.version.method,
      [...prior, ...manualItems.map((i) => i.decision_id)],
      null,
    );
    await this.storage.publish(
      output.version,
      output.bundle,
      {
        current_revision: Number(state.current!.revision),
        manual_revision: state.manual_revision,
      },
      signal,
      {
        expected_proofread_id: q.expected_proofread_id,
        actor,
        items: manualItems,
      },
    );
    let rebuild: unknown = {
      status: "pending",
      stop:
        pending.find((p) => pendingIndexes.includes(p.page_index))?.stop ??
        null,
    };
    if (!pendingIndexes.length) {
      try {
        rebuild = {
          status: "done",
          ...(await pipeline.render(q.literature_id, q.asset_id, signal)),
        };
      } catch {
        rebuild = {
          status: "failed",
          stop: archiveStop("render-failed", "render"),
        };
      }
    }
    return {
      schema_version: 2,
      changed: true,
      proofread_id: output.version.proofread_id,
      arrangement_id: next.arrangement_id,
      manual_revision: next.manual_revision,
      decision_ids: manualItems.map((i) => i.decision_id),
      affected_page_indexes: [
        ...new Set(
          q.changes.map(
            (c) =>
              snapshot.leaves.find((l) => l.leaf_id === c.leaf_id)!.page_index,
          ),
        ),
      ],
      pending_page_indexes: pendingIndexes,
      rebuild,
    };
  }
}
