import {
  longDocumentInfo,
  DRAFT_BASES,
  canonicalJsonBytes,
  parseArtifactRef,
  parseArchiveTextBundleV2,
  parseProofreadVersionV2,
  type ProofreadVersionV2,
  type ArchiveTextBundleV2,
  type ArtifactRef,
} from "@sciretriever/contracts";
import { KnowledgeStorageError, type SqliteWorker } from "./sqlite/worker.js";
import type { FileStore } from "./files/store.js";
import { artifactReference } from "./artifact-layout.js";
import { createLogger } from "../logging/index.js";
import type {
  LocatedProofreadArtifact,
  ProofreadPublication,
} from "./sqlite/proofread-engine.js";
import {
  byteHash,
  textHash,
  textId,
  ArchiveTextError,
} from "../archive/text-source.js";
import { applyLeafCorrections } from "../proofread/leaf-corrections.js";

type Row = Record<string, unknown>;
function verifyText(version: ProofreadVersionV2, bundle: ArchiveTextBundleV2) {
  const refuse = (): never => {
    throw new Error("archive-text-integrity");
  };
  if (
    bundle.page_count !== version.pages.length ||
    (bundle.arrangement?.arrangement_id ?? null) !== version.arrangement_id ||
    (version.pages.some((p) => p.status === "unreviewed") &&
      !longDocumentInfo(bundle.arrangement?.classification))
  )
    refuse();
  for (const row of bundle.leaves)
    if (
      DRAFT_BASES.some((basis) => basis === row.basis) &&
      version.pages[row.leaf.page_index]?.status !== "unreviewed"
    )
      refuse();
  for (const root of bundle.source_blocks)
    if (
      root.raw_parse_id !== version.draft_input.raw_parse_id ||
      root.result_sha256 !== version.draft_input.result_sha256 ||
      root.source_sha256 !== byteHash(Buffer.from(root.text)) ||
      root.root_block_id !==
        textId(["archive-source-v1", root.result_sha256, root.locator])
    )
      refuse();
  if (bundle.arrangement) {
    const { arrangement_id, ...body } = bundle.arrangement;
    if (textHash(body) !== arrangement_id) refuse();
  }
  for (const page of version.pages) {
    const retained = bundle.leaves.filter(
      (l) =>
        l.destination.kind === "assigned" &&
        l.leaf.page_index === page.page_index,
    );
    if (
      textHash(retained.map((l) => l.leaf.leaf_id)) !==
      textHash(page.retained_leaf_ids)
    )
      refuse();
    const applied = applyLeafCorrections(
      retained.map((l) => l.leaf),
      page.corrections.map((c) => c.operation),
      page.page_index,
      page.page_input_sha256,
    );
    for (const c of page.corrections) {
      const expected = applied.records.find(
        (e) => e.correction_id === c.correction_id,
      );
      if (
        !expected ||
        textHash(expected.source_span) !== textHash(c.source_span) ||
        (c.source === "manual" &&
          !version.manual_decision_ids.includes(c.decision_id!))
      )
        refuse();
    }
    for (const l of retained) {
      const records = page.corrections.filter(
          (c) => c.operation.leaf_id === l.leaf.leaf_id,
        ),
        source = records.some((c) => c.source === "manual")
          ? "manual"
          : records.some((c) => c.source === "agent")
            ? "agent"
            : "parser";
      if (
        applied.texts.get(l.leaf.leaf_id) !== l.corrected_text ||
        source !== l.text_source ||
        textHash(records.map((c) => c.correction_id)) !==
          textHash(l.correction_ids)
      )
        refuse();
    }
  }
  for (const l of bundle.leaves)
    if (
      l.destination.kind === "dropped" &&
      (l.corrected_text !== l.leaf.original_text || l.correction_ids.length)
    )
      refuse();
}
export class SqliteArchiveTextStorage {
  constructor(
    readonly database: SqliteWorker,
    readonly files: FileStore,
    private readonly onDefaultChanged?: () => Promise<unknown>,
  ) {}
  private async bytes(path: string, ref: ArtifactRef, signal?: AbortSignal) {
    return this.files.withVerified(
      path,
      ref,
      async (chunks) => {
        const all: Uint8Array[] = [];
        for await (const b of chunks) {
          signal?.throwIfAborted();
          all.push(b);
        }
        return Buffer.concat(all);
      },
      { maxBytes: 32 * 1024 * 1024, ...(signal ? { signal } : {}) },
    );
  }
  private async object(row: Row, signal?: AbortSignal) {
    const ref = parseArtifactRef({
      sha256: row.manifest_sha256,
      byte_size: row.manifest_size,
      media_type: row.manifest_media_type,
    });
    return JSON.parse(
      (await this.bytes(String(row.manifest_reference), ref, signal)).toString(
        "utf8",
      ),
    ) as unknown;
  }
  state(asset: string, signal?: AbortSignal) {
    return this.database.proofread<{
      current: Row | null;
      manual_revision: number;
      decisions: Row[];
      last_manual_edit: { actor: string; at: string } | null;
    }>("state", asset, signal);
  }
  async load(id: string, signal?: AbortSignal) {
    const row = await this.database.proofread<Row | null>("get", id, signal);
    if (!row) return null;
    const value = await this.object(row, signal);
    if (
      !value ||
      typeof value !== "object" ||
      !("schema_version" in value) ||
      value.schema_version !== 2
    )
      return null;
    const version = await parseProofreadVersionV2(value);
    if (
      version.proofread_id !== id ||
      version.content_sha256 !== row.content_sha256 ||
      version.part_asset_id !== row.part_asset_id ||
      version.part_sha256 !== row.part_sha256 ||
      version.status !== row.status
    )
      throw new Error("archive-text-integrity");
    const resources = await this.database.proofread<Row[]>(
        "resources",
        id,
        signal,
      ),
      blocks = resources.find((r) => r.kind === "blocks" && r.reference === "");
    if (
      !blocks ||
      blocks.sha256 !== version.blocks.sha256 ||
      blocks.byte_size !== version.blocks.byte_size
    )
      throw new Error("archive-text-integrity");
    const bundle = parseArchiveTextBundleV2(
      JSON.parse(
        (
          await this.bytes(
            String(blocks.artifact_reference),
            version.blocks,
            signal,
          )
        ).toString("utf8"),
      ),
    );
    verifyText(version, bundle);
    return { version, bundle };
  }
  async decisions(asset: string, signal?: AbortSignal) {
    const state = await this.state(asset, signal);
    const items = [];
    for (const row of state.decisions)
      items.push(await this.object(row, signal));
    return { ...state, items };
  }
  async write(
    kind: Parameters<typeof artifactReference>[0],
    bytes: Uint8Array,
    media_type = "application/json",
  ): Promise<LocatedProofreadArtifact> {
    const ref = parseArtifactRef({
      sha256: byteHash(bytes),
      byte_size: bytes.length,
      media_type,
    });
    const reference =
        (await this.database.locateArtifact(ref))?.reference ??
        artifactReference(kind, ref),
      stage = await this.files.stage({ maxBytes: Math.max(1, bytes.length) });
    try {
      await stage.write(bytes);
      const saved = await this.files.publish(stage, reference);
      if (saved.sha256 !== ref.sha256)
        throw new Error("archive-text-integrity");
      return { ...ref, reference };
    } finally {
      await stage.discard();
    }
  }
  async publish(
    version: ProofreadVersionV2,
    bundle: ArchiveTextBundleV2,
    expected: { current_revision: number | null; manual_revision: number },
    signal?: AbortSignal,
    manual?: {
      expected_proofread_id: string;
      actor: string;
      items: readonly {
        value: unknown;
        decision_id: string;
        block_id: string;
        scope_key: string;
      }[];
    },
  ) {
    const v = await parseProofreadVersionV2(version),
      blockBytes = canonicalJsonBytes(parseArchiveTextBundleV2(bundle));
    verifyText(v, bundle);
    if (
      byteHash(blockBytes) !== v.blocks.sha256 ||
      blockBytes.length !== v.blocks.byte_size ||
      blockBytes.length > 32 * 1024 * 1024
    )
      throw new Error("archive-text-integrity");
    return this.files
      .withWrite(async () => {
        signal?.throwIfAborted();
        const existing = await this.load(v.proofread_id, signal),
          stored = existing?.version ?? v;
        const resources: ProofreadPublication["resources"][number][] = [];
        if (!existing)
          resources.push({
            ...(await this.write("proofread-blocks", blockBytes)),
            kind: "blocks",
            logical_reference: "",
          });
        const manifest = await this.write(
          "proofread-manifest",
          canonicalJsonBytes(stored),
        );
        const items = [];
        for (const item of manual?.items ?? [])
          items.push({
            decision_id: item.decision_id,
            block_id: item.block_id,
            scope_key: item.scope_key,
            manifest: await this.write(
              "proofread-decision",
              canonicalJsonBytes(item.value),
            ),
          });
        const result = await this.database.proofread<{
          published: boolean;
          revision: number;
          default_changed: boolean;
        }>(
          "publish",
          {
            version: stored,
            manifest,
            resources,
            manual_revision: expected.manual_revision,
            expected_current_revision: expected.current_revision,
            ...(manual
              ? {
                  manual_decisions: {
                    actor: manual.actor,
                    expected_proofread_id: manual.expected_proofread_id,
                    items,
                  },
                }
              : {}),
          },
          signal,
        );
        const { default_changed, ...receipt } = result;
        if (default_changed && this.onDefaultChanged) {
          try {
            await this.onDefaultChanged();
          } catch {
            createLogger("archive-text-storage").warn(
              "Default text changed but index refresh could not be scheduled",
            );
          }
        }
        return { ...receipt, version: stored };
      })
      .catch((error) => {
        if (error instanceof KnowledgeStorageError) {
          const code = [
            "proofread-manual-stale",
            "proofread-current-stale",
          ].includes(error.code)
            ? "publication-conflict"
            : error.code === "proofread-input-stale"
              ? "input-stale"
              : error.code;
          throw new ArchiveTextError(code, [], { cause: error });
        }
        throw error;
      });
  }
}
