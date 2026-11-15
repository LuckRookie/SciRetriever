import {
  canonicalJsonBytes,
  parseArtifactRef,
  parseAssetId,
  parseRawBlocksV1,
  parseRawParse,
  sha256,
  type RawParse,
  type RawParseSourceProfile,
  type ArtifactRef,
} from "@sciretriever/contracts";
import type {
  StagedRawParseOutput,
  StagedParserArtifact,
} from "../parsing/ports.js";
import { parserMarkdownReferences } from "../parsing/markdown-resources.js";
import { TypeScriptParserArtifactRules } from "../parsing/artifact-rules.js";
import type { SqliteWorker } from "./sqlite/worker.js";
import type { FileStore } from "./files/store.js";
import { artifactReference } from "./artifact-layout.js";
import { createLogger } from "../logging/index.js";
import type { RawParsePublication } from "./sqlite/raw-parsing-engine.js";

type Row = Record<string, unknown>;
function fail(): never {
  throw Object.assign(new Error("raw parsing integrity check failed"), {
    code: "raw-parse-integrity",
  });
}
function same(a: unknown, b: unknown): boolean {
  return Buffer.from(canonicalJsonBytes(a)).equals(
    Buffer.from(canonicalJsonBytes(b)),
  );
}
export interface StoredRawParseStatus {
  readonly profile: RawParseSourceProfile;
  readonly result: RawParse | null;
  readonly last_failure_code: string | null;
  readonly last_parameters_sha256: string | null;
}
export class SqliteRawParseStorage {
  recordAttempt(value: import("../parsing/raw-service.js").RawParseAttempt) {
    return this.work(() => this.database.rawParse("attempt", value));
  }
  private closed = false;
  private readonly active = new Set<Promise<unknown>>();
  constructor(
    private readonly database: SqliteWorker,
    private readonly files: FileStore,
    private readonly onDefaultChanged?: () => Promise<unknown>,
  ) {}
  async close() {
    this.closed = true;
    await Promise.allSettled([...this.active]);
  }
  private async work<T>(fn: () => Promise<T>): Promise<T> {
    if (this.closed) fail();
    const p = Promise.resolve().then(fn);
    this.active.add(p);
    try {
      return await p;
    } finally {
      this.active.delete(p);
    }
  }
  private async bytes(
    reference: string,
    artifact: ArtifactRef,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    return this.files.withVerified(
      reference,
      artifact,
      async (chunks) => {
        const parts: Uint8Array[] = [];
        for await (const p of chunks) parts.push(p);
        return Buffer.concat(parts);
      },
      { maxBytes: 32 * 1024 * 1024, ...(signal ? { signal } : {}) },
    );
  }
  private async snapshot(
    id: string,
    signal?: AbortSignal,
  ): Promise<{
    result: RawParse;
    artifacts: ReadonlyMap<
      string,
      { reference: string; artifact: ArtifactRef }
    >;
  } | null> {
    const row = await this.database.rawParse<Row | null>("get", id, signal);
    if (!row) return null;
    const artifact = parseArtifactRef({
      sha256: row.manifest_sha256,
      byte_size: row.manifest_size,
      media_type: row.manifest_media_type,
    });
    const result = await parseRawParse(
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          await this.bytes(String(row.manifest_reference), artifact, signal),
        ),
      ),
    );
    if (
      result.raw_parse_id !== id ||
      result.result_sha256 !== row.result_sha256 ||
      result.source_asset_id !== row.source_asset_id ||
      result.source_sha256 !== row.source_sha256 ||
      result.profile !== row.profile ||
      result.parameters_sha256 !== row.parameters_sha256
    )
      fail();
    const rows = await this.database.rawParse<Row[]>("resources", id, signal);
    const expected = [
      { kind: "markdown", reference: "", artifact: result.markdown },
      ...(result.blocks
        ? [{ kind: "blocks", reference: "", artifact: result.blocks }]
        : []),
      ...(result.private_content_list
        ? [
            {
              kind: "private-content-list",
              reference: "",
              artifact: result.private_content_list,
            },
          ]
        : []),
      ...result.resources.map((r) => ({ kind: "image", ...r })),
    ];
    if (expected.length !== rows.length) fail();
    const byKey = new Map(
      rows.map((r) => [`${String(r.kind)}\0${String(r.reference)}`, r]),
    );
    const artifacts = new Map<
      string,
      { reference: string; artifact: ArtifactRef }
    >();
    for (const a of expected) {
      const key = `${a.kind}\0${a.reference}`;
      const r = byKey.get(key);
      if (
        !r ||
        !same(a.artifact, {
          sha256: r.sha256,
          byte_size: r.byte_size,
          media_type: r.media_type,
        })
      )
        fail();
      artifacts.set(key, {
        reference: String(r.artifact_reference),
        artifact: a.artifact,
      });
    }
    return { result, artifacts };
  }
  private async read(id: string, signal?: AbortSignal) {
    return (await this.snapshot(id, signal))?.result ?? null;
  }
  byId(id: string, signal?: AbortSignal) {
    return this.work(() => this.read(parseAssetId(id), signal));
  }
  current(
    assetId: string,
    signal?: AbortSignal,
  ): Promise<readonly StoredRawParseStatus[]> {
    return this.work(async () => {
      const rows = await this.database.rawParse<Row[]>(
        "current",
        parseAssetId(assetId),
        signal,
      );
      return Promise.all(
        rows.map(async (r) => ({
          profile: r.profile as RawParseSourceProfile,
          result:
            r.raw_parse_id === null
              ? null
              : await this.read(String(r.raw_parse_id), signal),
          last_failure_code:
            r.last_failure_code === null ? null : String(r.last_failure_code),
          last_parameters_sha256:
            r.last_parameters_sha256 === null
              ? null
              : String(r.last_parameters_sha256),
        })),
      );
    });
  }
  readArtifact(
    id: string,
    kind: "blocks" | "markdown" | "private-content-list" | "image",
    reference = "",
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    return this.work(async () => {
      const snapshot = await this.snapshot(parseAssetId(id), signal);
      const value = snapshot?.artifacts.get(`${kind}\0${reference}`);
      if (!value) fail();
      return this.bytes(value.reference, value.artifact, signal);
    });
  }
  /** One verified manifest/closure per load; image count never multiplies catalog reads. */
  async load(id: string, signal?: AbortSignal): Promise<StagedRawParseOutput> {
    const value = await this.loadSource(id, signal);
    if (!value.blocks || !value.private_content_list) fail();
    return {
      ...value,
      blocks: value.blocks,
      private_content_list: value.private_content_list,
    };
  }
  loadSource(id: string, signal?: AbortSignal) {
    return this.work(async () => {
      const snapshot = await this.snapshot(parseAssetId(id), signal);
      if (!snapshot) fail();
      const { result, artifacts } = snapshot;
      const load = async (
        kind: string,
        reference = "",
      ): Promise<StagedParserArtifact> => {
        const value = artifacts.get(`${kind}\0${reference}`);
        if (!value) fail();
        return {
          artifact: value.artifact,
          bytes: await this.bytes(value.reference, value.artifact, signal),
        };
      };
      const blocks = result.blocks ? await load("blocks") : null,
        markdown = await load("markdown"),
        private_content_list = result.private_content_list
          ? await load("private-content-list")
          : null;
      const resources: StagedRawParseOutput["resources"][number][] = [];
      let total = 0;
      for (const r of result.resources) {
        total += r.artifact.byte_size;
        if (total > 128 * 1024 * 1024) fail();
        resources.push({
          reference: r.reference,
          content: await load("image", r.reference),
        });
      }
      return { result, blocks, markdown, private_content_list, resources };
    });
  }
  private async write(
    kind: Parameters<typeof artifactReference>[0],
    content: StagedParserArtifact,
  ) {
    const ref = parseArtifactRef(content.artifact);
    if (
      content.bytes.length !== ref.byte_size ||
      (await sha256(content.bytes)) !== ref.sha256
    )
      fail();
    const reference =
      (await this.database.locateArtifact(ref))?.reference ??
      artifactReference(kind, ref);
    const stage = await this.files.stage({ maxBytes: ref.byte_size });
    try {
      await stage.write(content.bytes);
      const published = await this.files.publish(stage, reference);
      if (published.sha256 !== ref.sha256 || published.size !== ref.byte_size)
        fail();
      return { ...ref, reference };
    } finally {
      await stage.discard();
    }
  }
  publish(
    value:
      | StagedRawParseOutput
      | {
          readonly result: RawParse;
          readonly blocks: null;
          readonly private_content_list: null;
          readonly markdown: StagedParserArtifact;
          readonly resources: StagedRawParseOutput["resources"];
        },
    signal?: AbortSignal,
  ): Promise<{ readonly result: RawParse; readonly published: boolean }> {
    return this.work(async () => {
      const output = structuredClone(value);
      const result = await parseRawParse(output.result);
      const resources = output.resources
        .map((r) => ({ reference: r.reference, artifact: r.content.artifact }))
        .sort((a, b) =>
          a.reference < b.reference ? -1 : a.reference > b.reference ? 1 : 0,
        );
      if (
        !same(result.markdown, output.markdown.artifact) ||
        !same(result.blocks, output.blocks?.artifact ?? null) ||
        !same(
          result.private_content_list,
          output.private_content_list?.artifact ?? null,
        ) ||
        !same(result.resources, resources)
      )
        fail();
      const blockReferences: string[] = [];
      if (output.blocks) {
        const blocks = parseRawBlocksV1(
          JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(
              output.blocks.bytes,
            ),
          ),
          result.resources.map((r) => r.reference),
        );
        if (blocks.page_count !== result.page_count) fail();
        for (const b of blocks.blocks) {
          if (b.image_ref) blockReferences.push(b.image_ref);
          if (b.html) blockReferences.push(...parserMarkdownReferences(b.html));
        }
      }
      // Conversion has already checked embedded table resources; these declared references
      // are also verified against immutable bytes before any catalog publication.
      await new TypeScriptParserArtifactRules().validate(
        output,
        signal,
        blockReferences,
      );
      return this.files.withWrite(async () => {
        if (signal?.aborted)
          throw Object.assign(new Error("raw parsing cancelled"), {
            code: "parser-cancelled",
          });
        const refs: RawParsePublication["resources"][number][] = [];
        for (const [kind, name, bytes] of [
          ["blocks", "raw-parse-blocks", output.blocks],
          [
            "private-content-list",
            "raw-parse-private",
            output.private_content_list,
          ],
          ["markdown", "parser-markdown", output.markdown],
        ] as const)
          if (bytes) {
            const a = await this.write(name, bytes);
            refs.push({
              ...a,
              kind,
              reference: "",
              artifact_reference: a.reference,
            });
          }
        for (const r of output.resources) {
          const a = await this.write("parser-resource", r.content);
          refs.push({
            ...a,
            kind: "image",
            reference: r.reference,
            artifact_reference: a.reference,
          });
        }
        const bytes = canonicalJsonBytes(result);
        const manifest = await this.write("raw-parse-manifest", {
          bytes,
          artifact: {
            sha256: await sha256(bytes),
            byte_size: bytes.length,
            media_type: "application/json",
          },
        });
        const reply = await this.database.rawParse<{
          published: boolean;
          default_changed: boolean;
        }>("publish", { result, manifest, resources: refs });
        if (reply.default_changed && this.onDefaultChanged) {
          try {
            await this.onDefaultChanged();
          } catch {
            createLogger("raw-parsing-storage").warn(
              "Default text changed but index refresh could not be scheduled",
            );
          }
        }
        return { result, published: reply.published };
      }, signal);
    });
  }
  failure(
    source: Pick<
      RawParse,
      "source_asset_id" | "source_sha256" | "profile" | "parameters_sha256"
    >,
    code: string,
    signal?: AbortSignal,
  ) {
    return this.work(() =>
      this.database.rawParse("failure", { ...source, code }, signal),
    );
  }
  pin(rawParseId: string, proofreadId: string, signal?: AbortSignal) {
    return this.work(() =>
      this.database.rawParse(
        "pin",
        {
          raw_parse_id: parseAssetId(rawParseId),
          proofread_id: parseAssetId(proofreadId),
        },
        signal,
      ),
    );
  }
  retire(rawParseId: string, signal?: AbortSignal) {
    return this.work(() =>
      this.database.rawParse("retire", parseAssetId(rawParseId), signal),
    );
  }
}
