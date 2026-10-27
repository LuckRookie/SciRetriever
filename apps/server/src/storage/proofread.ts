import { SqliteArchiveTextStorage } from "./archive-text.js";
import {
  canonicalJsonBytes,
  parseArtifactRef,
  parseProofreadVersion,
  parseProofreadBlocksV1,
  sha256,
  type ArtifactRef,
  type ProofreadVersion,
} from "@sciretriever/contracts";
import type { buildProofreadVersion } from "../proofread/engine.js";
import type { ManualProofreadDecision } from "../proofread/contract.js";
import { parseStoredDraft } from "../proofread/draft.js";
import { renderBlocks } from "../proofread/render.js";
import type { SqliteWorker } from "./sqlite/worker.js";
import type { FileStore } from "./files/store.js";
import { artifactReference } from "./artifact-layout.js";
import type {
  ProofreadPublication,
  ProofreadDecisionPublication,
  LocatedProofreadArtifact,
} from "./sqlite/proofread-engine.js";

type Row = Record<string, unknown>;
type Output = Awaited<ReturnType<typeof buildProofreadVersion>>;
function fail(code = "proofread-integrity"): never {
  throw Object.assign(new Error("proofread storage failed"), { code });
}
function check(signal?: AbortSignal) {
  if (signal?.aborted) fail("proofread-cancelled");
}
const artifact = async (
  bytes: Uint8Array,
  media_type = "application/json",
): Promise<ArtifactRef> => ({
  sha256: await sha256(bytes),
  byte_size: bytes.length,
  media_type,
});
export class SqliteProofreadStorage {
  constructor(
    private readonly database: SqliteWorker,
    private readonly files: FileStore,
  ) {}
  async arranged(id: string, signal?: AbortSignal) {
    return new SqliteArchiveTextStorage(this.database, this.files).load(
      id,
      signal,
    );
  }
  async arrangedHead(asset: string, signal?: AbortSignal) {
    return new SqliteArchiveTextStorage(this.database, this.files).state(
      asset,
      signal,
    );
  }
  async read(key: string, signal?: AbortSignal) {
    const row = await this.database.proofread<Row | null>(
      "cache-read",
      key,
      signal,
    );
    if (!row) return null;
    const a = parseArtifactRef({
      sha256: row.sha256,
      byte_size: row.byte_size,
      media_type: row.media_type,
    });
    return {
      id: String(row.cache_id),
      bytes: await this.bytes(String(row.artifact_reference), a, signal),
      media_type: a.media_type,
    };
  }
  async save(
    key: string,
    bytes: Uint8Array,
    mediaType: string,
    signal?: AbortSignal,
  ) {
    return this.files.withWrite(async () => {
      check(signal);
      const expected = parseArtifactRef({
        sha256: await sha256(bytes),
        byte_size: bytes.length,
        media_type: mediaType,
      });
      const artifact = await this.write("proofread-cache", bytes, expected);
      return this.database.proofread<string>(
        "cache-write",
        { key, artifact },
        signal,
      );
    });
  }
  private async bytes(
    reference: string,
    expected: ArtifactRef,
    signal?: AbortSignal,
  ) {
    check(signal);
    return this.files.withVerified(
      reference,
      expected,
      async (chunks) => {
        const parts: Uint8Array[] = [];
        for await (const chunk of chunks) {
          check(signal);
          parts.push(chunk);
        }
        return Buffer.concat(parts);
      },
      { maxBytes: 32 * 1024 * 1024, ...(signal ? { signal } : {}) },
    );
  }
  private async manifest(
    row: Row,
    signal?: AbortSignal,
    reserveVerifiedBytes?: (bytes: number) => void,
  ): Promise<unknown> {
    const a = parseArtifactRef({
      sha256: row.manifest_sha256,
      byte_size: row.manifest_size,
      media_type: row.manifest_media_type,
    });
    if (typeof row.manifest_reference !== "string") fail();
    reserveVerifiedBytes?.(a.byte_size);
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        await this.bytes(row.manifest_reference, a, signal),
      ),
    );
  }
  async byId(
    id: string,
    signal?: AbortSignal,
    reserveVerifiedBytes?: (bytes: number) => void,
  ): Promise<ProofreadVersion | null> {
    const row = await this.database.proofread<Row | null>("get", id, signal);
    if (!row) return null;
    const v = await parseProofreadVersion(
      await this.manifest(row, signal, reserveVerifiedBytes),
    );
    if (
      v.proofread_id !== id ||
      v.content_sha256 !== row.content_sha256 ||
      v.part_asset_id !== row.part_asset_id ||
      v.part_sha256 !== row.part_sha256 ||
      v.status !== row.status
    )
      fail();
    return v;
  }
  /** The fixed document reader needs only its source manifest and block bytes. Images are already verified by the document closure. */
  async documentSource(
    id: string,
    signal?: AbortSignal,
    reserveVerifiedBytes?: (bytes: number) => void,
  ) {
    const version = await this.byId(id, signal, reserveVerifiedBytes);
    if (!version) fail("proofread-missing");
    const rows = await this.database.proofread<Row[]>("resources", id, signal);
    const row = rows.find((r) => r.kind === "blocks" && r.reference === "");
    if (!row || typeof row.artifact_reference !== "string") fail();
    const ref = parseArtifactRef({
      sha256: row.sha256,
      byte_size: row.byte_size,
      media_type: row.media_type,
    });
    if (
      JSON.stringify(ref) !== JSON.stringify(parseArtifactRef(version.blocks))
    )
      fail();
    reserveVerifiedBytes?.(ref.byte_size);
    return {
      version,
      blocks: await this.bytes(row.artifact_reference, ref, signal),
    };
  }
  async load(id: string, signal?: AbortSignal) {
    const version = await this.byId(id, signal);
    if (!version) fail("proofread-missing");
    const rows = await this.database.proofread<Row[]>("resources", id, signal);
    const read = async (kind: string, ref: string, expected?: ArtifactRef) => {
      const row = rows.find((r) => r.kind === kind && r.reference === ref);
      if (!row || typeof row.artifact_reference !== "string") fail();
      const a = parseArtifactRef({
        sha256: row.sha256,
        byte_size: row.byte_size,
        media_type: row.media_type,
      });
      if (
        expected &&
        JSON.stringify(a) !== JSON.stringify(parseArtifactRef(expected))
      )
        fail();
      return this.bytes(row.artifact_reference, a, signal);
    };
    const blockBytes = await read("blocks", "", version.blocks);
    const blocks = parseProofreadBlocksV1(
      JSON.parse(new TextDecoder().decode(blockBytes)),
      version.resources.map((r) => r.reference),
    );
    const markdown = await read("markdown", "", version.markdown);
    const rendered = renderBlocks(blocks.blocks, version.resources);
    if (!Buffer.from(markdown).equals(Buffer.from(rendered.markdown))) fail();
    const values: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        await read("drafts", ""),
      ),
    );
    if (!Array.isArray(values) || values.length > 100000) fail();
    const drafts = await Promise.all(
      values.map((v) =>
        parseStoredDraft(
          v,
          blocks.page_count,
          version.resources.map((r) => r.reference),
        ),
      ),
    );
    if (new Set(drafts.map((d) => d.block_id)).size !== drafts.length) fail();
    const resources = [];
    for (const r of version.resources)
      resources.push({
        ...r,
        bytes: await read("image", r.reference, r.artifact),
      });
    return {
      version,
      blocks: { artifact: version.blocks, bytes: blockBytes },
      markdown: { artifact: version.markdown, bytes: markdown },
      ranges: rendered.ranges,
      drafts,
      removed: [],
      usage: { calls: 0, input_tokens: 0, output_tokens: 0 },
      resources,
    };
  }
  current(asset: string, signal?: AbortSignal) {
    return this.database.proofread<Row | null>("current", asset, signal);
  }
  async state(asset: string, signal?: AbortSignal) {
    const state = await this.database.proofread<{
      current: Row | null;
      manual_revision: number;
      last_manual_edit: { actor: string; at: string } | null;
      decisions: Row[];
    }>("state", asset, signal);
    const decisions: ManualProofreadDecision[] = [];
    if (
      state.decisions.length > 100000 ||
      state.decisions.reduce((sum, row) => sum + Number(row.manifest_size), 0) >
        32 * 1024 * 1024
    )
      fail("proofread-input-limit");
    for (const row of state.decisions) {
      const value = (await this.manifest(
        row,
        signal,
      )) as ManualProofreadDecision;
      if (
        !value ||
        value.decision_id !== row.decision_id ||
        value.part_asset_id !== asset ||
        value.block_id !== row.block_id ||
        !["replace", "document-edit", "resolve-suspect", "no-body"].includes(
          value.action,
        ) ||
        typeof value.draft_sha256 !== "string" ||
        !/^[a-f0-9]{64}$/u.test(value.draft_sha256) ||
        !Array.isArray(value.raw_ref) ||
        typeof value.reason !== "string" ||
        !value.reason.trim() ||
        !Number.isSafeInteger(value.page) ||
        value.page < 0 ||
        (["replace", "document-edit"].includes(value.action)
          ? typeof value.text !== "string"
          : value.text !== null)
      )
        fail();
      for (const ref of value.raw_ref)
        if (
          !Array.isArray(ref) ||
          ref.length !== 2 ||
          ref.some((n) => !Number.isSafeInteger(n) || n < 0)
        )
          fail();
      decisions.push(value);
    }
    return {
      current: state.current,
      manual_revision: state.manual_revision,
      last_manual_edit: state.last_manual_edit,
      decisions,
    };
  }
  private async write(
    kind: Parameters<typeof artifactReference>[0],
    bytes: Uint8Array,
    expected: ArtifactRef,
  ): Promise<LocatedProofreadArtifact> {
    if (
      bytes.length !== expected.byte_size ||
      (await sha256(bytes)) !== expected.sha256
    )
      fail();
    const reference =
      (await this.database.locateArtifact(expected))?.reference ??
      artifactReference(kind, expected);
    const stage = await this.files.stage({
      maxBytes: Math.max(1, expected.byte_size),
    });
    try {
      await stage.write(bytes);
      const saved = await this.files.publish(stage, reference);
      if (saved.sha256 !== expected.sha256 || saved.size !== expected.byte_size)
        fail();
      return { ...expected, reference };
    } finally {
      await stage.discard();
    }
  }
  async publish(
    value: Output,
    manualRevision: number,
    signal?: AbortSignal,
    edit?: {
      decision: ManualProofreadDecision;
      actor: string;
      expected_proofread_id: string;
      replaced_scopes: readonly string[];
    },
  ) {
    if (
      value.blocks.bytes.length > 32 * 1024 * 1024 ||
      value.markdown.bytes.length > 8 * 1024 * 1024 ||
      value.resources.length > 4096 ||
      value.resources.some((r) => r.bytes.length > 32 * 1024 * 1024) ||
      value.resources.reduce((sum, r) => sum + r.bytes.length, 0) >
        128 * 1024 * 1024
    )
      fail("proofread-output-limit");
    const output = structuredClone(value);
    const v = await parseProofreadVersion(output.version);
    const drafts = canonicalJsonBytes(output.drafts);
    const versionBytes = canonicalJsonBytes(v);
    if (
      drafts.length > 32 * 1024 * 1024 ||
      versionBytes.length > 32 * 1024 * 1024
    )
      fail("proofread-output-limit");
    const parsedBlocks = parseProofreadBlocksV1(
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(output.blocks.bytes),
      ),
      v.resources.map((r) => r.reference),
    );
    const rendered = renderBlocks(parsedBlocks.blocks, v.resources);
    const expectedResources = canonicalJsonBytes(v.resources);
    const actualResources = canonicalJsonBytes(
      output.resources.map((r) => ({
        reference: r.reference,
        artifact: r.artifact,
      })),
    );
    if (
      !Buffer.from(rendered.markdown).equals(
        Buffer.from(output.markdown.bytes),
      ) ||
      !Buffer.from(expectedResources).equals(Buffer.from(actualResources))
    )
      fail();
    if (
      (await sha256(output.blocks.bytes)) !== v.blocks.sha256 ||
      (await sha256(output.markdown.bytes)) !== v.markdown.sha256 ||
      output.blocks.bytes.length !== v.blocks.byte_size ||
      output.markdown.bytes.length !== v.markdown.byte_size
    )
      fail();
    check(signal);
    return this.files.withWrite(async () => {
      const manual_edit = edit
        ? {
            actor: edit.actor,
            expected_proofread_id: edit.expected_proofread_id,
            replaced_scopes: edit.replaced_scopes,
            decision: {
              decision_id: edit.decision.decision_id,
              block_id: edit.decision.block_id,
              manifest: await this.write(
                "proofread-decision",
                canonicalJsonBytes(edit.decision),
                await artifact(canonicalJsonBytes(edit.decision)),
              ),
            },
          }
        : undefined;
      // Runtime measurements never overwrite an existing immutable manifest.
      const existing = await this.byId(v.proofread_id, signal);
      if (existing) {
        await this.load(existing.proofread_id, signal);
        const row = await this.database.proofread<Row>(
          "get",
          v.proofread_id,
          signal,
        );
        const manifest = {
          ...(await artifact(canonicalJsonBytes(existing))),
          reference: String(row.manifest_reference),
        };
        const r = await this.database.proofread<{
          published: boolean;
          revision: number;
        }>(
          "publish",
          {
            version: existing,
            manual_revision: manualRevision,
            manifest,
            resources: [],
            ...(manual_edit ? { manual_edit } : {}),
          },
          signal,
        );
        return { ...r, version: existing };
      }
      const resources: ProofreadPublication["resources"][number][] = [];
      for (const [kind, name, item] of [
        ["blocks", "proofread-blocks", output.blocks],
        ["markdown", "proofread-markdown", output.markdown],
      ] as const) {
        const saved = await this.write(name, item.bytes, item.artifact);
        resources.push({ ...saved, kind, logical_reference: "" });
      }
      resources.push({
        ...(await this.write(
          "proofread-drafts",
          drafts,
          await artifact(drafts),
        )),
        kind: "drafts",
        logical_reference: "",
      });
      for (const r of output.resources)
        resources.push({
          ...(await this.write("parser-resource", r.bytes, r.artifact)),
          kind: "image",
          logical_reference: r.reference,
        });
      const bytes = versionBytes,
        manifest = await this.write(
          "proofread-manifest",
          bytes,
          await artifact(bytes),
        );
      check(signal);
      const r = await this.database.proofread<{
        published: boolean;
        revision: number;
      }>(
        "publish",
        {
          version: v,
          manual_revision: manualRevision,
          manifest,
          resources,
          ...(manual_edit ? { manual_edit } : {}),
        },
        signal,
      );
      return { ...r, version: v };
    });
  }
  async decide(
    decision: ManualProofreadDecision,
    context: Omit<
      ProofreadDecisionPublication,
      "manifest" | "decision_id" | "block_id" | "part_asset_id" | "scope_key"
    >,
    signal?: AbortSignal,
  ) {
    const bytes = canonicalJsonBytes(decision);
    check(signal);
    return this.files.withWrite(async () => {
      const manifest = await this.write(
        "proofread-decision",
        bytes,
        await artifact(bytes),
      );
      return this.database.proofread<{
        decision_id: string;
        manual_revision: number;
      }>(
        "decide",
        {
          ...context,
          decision_id: decision.decision_id,
          part_asset_id: decision.part_asset_id,
          block_id: decision.block_id,
          scope_key:
            decision.action === "resolve-suspect"
              ? `suspect:${decision.suspect_id}`
              : decision.action === "no-body"
                ? `page:${decision.page}:body`
                : `block:${decision.block_id}:text`,
          manifest,
        },
        signal,
      );
    });
  }
  revoke(
    value: {
      part_asset_id: string;
      decision_id: string;
      expected_manual_revision: number;
      actor: string;
    },
    signal?: AbortSignal,
  ) {
    return this.database.proofread<{ manual_revision: number }>(
      "revoke",
      value,
      signal,
    );
  }
}
