import {
  parseProvenance,
  parseAssetId,
  parseParserResult,
  parserResultSha256,
} from "@sciretriever/contracts";
import { correctedDocumentFixture } from "./corrected-document-fixture.js";
import { describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { coreProcessingFixture } from "./core-processing-fixture.js";
import { rawParseArchive } from "./raw-parse-fixture.js";
import { convertMinerURawArchive } from "../src/parsing/backends/mineru/archive.js";
import { SqliteRawParseStorage } from "../src/storage/raw-parsing.js";
import { SqliteWorker } from "../src/storage/sqlite/worker.js";
import { stageLegacyRawParse } from "../src/parsing/legacy-raw.js";
import { TypeScriptConfigurationOwner } from "../src/configuration/owner.js";

async function fixture() {
  const f = await coreProcessingFixture();
  const original = await correctedDocumentFixture(f.app).parseDocuments(
    f.parseRequest,
  );
  await f.app.close();
  const catalog = join(f.home, "catalog.sqlite");
  try {
    await f.reopen();
    const store = new SqliteRawParseStorage(f.app.database, f.app.files);
    const output = (profile: "pipeline" | "vlm-engine", text?: string) =>
      convertMinerURawArchive(
        rawParseArchive(profile, text ? { markdown: text } : {}),
        {
          source_asset_id: f.asset.asset_id,
          source_sha256: f.asset.sha256,
          model_identity: `synthetic-${profile}`,
          profile,
        },
      );
    return {
      f,
      store,
      catalog,
      original,
      output,
      async close() {
        await store.close();
        await f.close();
      },
    };
  } catch (error) {
    await f.close();
    throw error;
  }
}
describe("raw parsing catalog and immutable publication", () => {
  it("loads many images with a single manifest read and still rejects corrupted resource bytes", async () => {
    const e = await fixture();
    try {
      const resources = Array.from({ length: 20 }, (_, index) => ({
        name: `images/synthetic-${index}.png`,
        bytes: Buffer.concat([
          Buffer.from("89504e470d0a1a0a", "hex"),
          Buffer.from([index]),
        ]),
      }));
      const staged = await convertMinerURawArchive(
        rawParseArchive("pipeline", {
          resources,
          markdown: resources.map((r) => `![](${r.name})`).join("\n"),
        }),
        {
          source_asset_id: e.f.asset.asset_id,
          source_sha256: e.f.asset.sha256,
          model_identity: "synthetic-pipeline",
          profile: "pipeline",
        },
      );
      await e.store.publish(staged);
      const calls = vi.spyOn(e.f.app.database, "rawParse");
      const reads = vi.spyOn(e.f.app.files, "withVerified");
      expect(
        structuredClone(await e.store.load(staged.result.raw_parse_id)),
      ).toEqual(structuredClone(staged));
      expect(calls.mock.calls.map((c) => c[0])).toEqual(["get", "resources"]);
      expect(reads.mock.calls).toHaveLength(resources.length + 4);
      calls.mockRestore();
      reads.mockRestore();
      const last = staged.resources.at(-1)!;
      const located = await e.f.app.database.locateArtifact(
        last.content.artifact,
      );
      const path = join(e.f.app.files.root, located!.reference);
      await writeFile(path, Buffer.alloc(last.content.bytes.length));
      await expect(e.store.load(staged.result.raw_parse_id)).rejects.toThrow();
      await writeFile(path, last.content.bytes);
    } finally {
      vi.restoreAllMocks();
      await e.close();
    }
  });
  it("registers existing Markdown without inventing blocks, model identity or page sizes", async () => {
    const e = await fixture();
    try {
      const material = (
        await e.f.app.documentRead.describe({
          document_version_id: e.original.document.document_version_id,
        })
      ).document.source_material_ref;
      const before = await e.f.app.documentRead.default({
        literature_id: material.literature_id,
        asset_id: material.asset_id,
        asset_sha256: material.asset_sha256,
      });
      const raw = (await e.store.current(e.f.asset.asset_id)).find(
        (r) => r.profile === "vlm-engine",
      )!.result!;
      const core = {
        source_asset_id: parseAssetId(raw.source_asset_id),
        source_sha256: raw.source_sha256,
        page_count: raw.page_count,
        markdown: raw.markdown,
        resources: raw.resources,
        provenance: {
          parser_version: "fixture",
          mode: null,
          model_identity: null,
          provenance: parseProvenance({
            provenance_id: "00000000-0000-0000-0000-000000000911",
            source_kind: "parser" as const,
            source_name: "fixture",
            source_record_id: null,
            observed_at: "2026-10-20T00:00:00Z",
            input_sha256: raw.source_sha256,
            parameters_sha256: raw.parameters_sha256,
          }),
        },
      };
      const legacy = await parseParserResult({
        ...core,
        result_sha256: await parserResultSha256(core),
      });
      const staged = await stageLegacyRawParse(
        legacy,
        async (artifact, signal) => {
          const located = await e.f.app.database.locateArtifact(artifact);
          if (!located) throw new Error("Missing synthetic artifact");
          return e.f.app.files.withVerified(
            located.reference,
            artifact,
            async (chunks) => {
              const pieces: Uint8Array[] = [];
              for await (const piece of chunks) pieces.push(piece);
              return Buffer.concat(pieces);
            },
            { maxBytes: 32 * 1024 * 1024, ...(signal ? { signal } : {}) },
          );
        },
      );
      await e.store.publish(staged);
      expect(staged.result).toMatchObject({
        profile: "vlm-engine-markdown-only",
        blocks: null,
        private_content_list: null,
        page_sizes: [],
        model_identity: null,
      });
      expect(
        await e.f.app.documentRead.default({
          literature_id: material.literature_id,
          asset_id: material.asset_id,
          asset_sha256: material.asset_sha256,
        }),
      ).toEqual(before);
      expect(e.f.parseCalls).toBe(2);
      expect(e.f.modelCalls).toBe(0);
      expect(
        (await new TypeScriptConfigurationOwner(e.f.home).status()).items
          .filter((r) => r.owner === "parsing")
          .map((r) => r.target),
      ).toEqual(["mineru", "mineru:pipeline", "mineru:vlm-engine"]);
    } finally {
      await e.close();
    }
  });
  it("retains each profile, reports failures independently, deduplicates bytes and protects pinned old versions", async () => {
    const e = await fixture();
    try {
      const first = await e.output("pipeline");
      expect((await e.store.publish(first)).published).toBe(true);
      expect((await e.store.publish(first)).published).toBe(false);
      const vlm = await e.output("vlm-engine");
      await e.store.publish(vlm);
      await e.store.failure(vlm.result, "parser-unavailable");
      const states = await e.store.current(e.f.asset.asset_id);
      expect(states).toHaveLength(2);
      expect(states.find((r) => r.profile === "pipeline")).toMatchObject({
        result: first.result,
        last_failure_code: null,
      });
      expect(states.find((r) => r.profile === "vlm-engine")).toMatchObject({
        result: vlm.result,
        last_failure_code: "parser-unavailable",
      });
      await e.store.publish(vlm);
      expect(
        (await e.store.current(e.f.asset.asset_id)).find(
          (r) => r.profile === "vlm-engine",
        )?.last_failure_code,
      ).toBeNull();
      const proofread = "00000000-0000-0000-0000-000000000991";
      await e.store.pin(first.result.raw_parse_id, proofread);
      const second = await e.output(
        "pipeline",
        "# Replacement synthetic source\n\nNew immutable bytes.\n",
      );
      await e.store.publish(second);
      expect(await e.store.byId(first.result.raw_parse_id)).toEqual(
        first.result,
      );
      await expect(
        e.store.retire(first.result.raw_parse_id),
      ).rejects.toMatchObject({ code: "raw-parse-in-use" });
      await expect(
        e.store.retire(second.result.raw_parse_id),
      ).rejects.toMatchObject({ code: "raw-parse-in-use" });
      expect(
        Buffer.from(
          await e.store.readArtifact(first.result.raw_parse_id, "markdown"),
        ).toString(),
      ).toContain("67%");
      const reader = new SqliteWorker(e.catalog, undefined, { readOnly: true });
      try {
        expect(
          await reader.rawParse("get", first.result.raw_parse_id),
        ).toBeTruthy();
        await expect(
          reader.rawParse("retire", first.result.raw_parse_id),
        ).rejects.toMatchObject({ code: "read-only" });
      } finally {
        await reader.close();
      }
    } finally {
      await e.close();
    }
  });
  it("refuses changed staged bytes, source identity and persisted content", async () => {
    const e = await fixture();
    try {
      const value = await e.output("pipeline");
      const before = await e.store.current(e.f.asset.asset_id);
      const bad = structuredClone(value);
      bad.markdown.bytes[0] = 0;
      await expect(e.store.publish(bad)).rejects.toThrow();
      expect(await e.store.current(e.f.asset.asset_id)).toEqual(before);
      await e.store.publish(value);
      const located = await e.f.app.database.locateArtifact(
        value.result.markdown,
      );
      expect(located).toBeTruthy();
      const path = join(e.f.app.files.root, located!.reference);
      const bytes = await readFile(path);
      await writeFile(path, Buffer.alloc(bytes.length));
      await expect(
        e.store.readArtifact(value.result.raw_parse_id, "markdown"),
      ).rejects.toThrow();
      await writeFile(path, bytes);
    } finally {
      await e.close();
    }
  });
});
