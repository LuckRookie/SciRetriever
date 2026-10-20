import { SCHEMA_VERSION } from "../src/storage/sqlite/schema.js";
import { correctedDocumentFixture } from "./corrected-document-fixture.js";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { reactWorkbenchAssets } from "./react-workbench-fixture.js";
import { chromium } from "playwright";
import {
  parseAsset,
  parseProvenance,
  sha256,
  type ArtifactRef,
} from "@sciretriever/contracts";
import {
  createParserFixtureApplication as createApplication,
  type Application,
} from "./parser-application-fixture.js";
import { createQueryApplication } from "../src/bootstrap/application.js";
import { startQueryOnlyWorkbench } from "../src/bootstrap/workbench.js";
import { TypeScriptParserArtifactRules } from "../src/parsing/artifact-rules.js";
import type { ParserBackend } from "./parser-fixture-types.js";
import { DocumentReadError } from "../src/document/read.js";
import {
  FIXTURE_LITERATURE,
  workbenchPdf,
} from "../src/workbench/synthetic-fixture.js";

const id = (n: number) =>
  `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const lit = FIXTURE_LITERATURE.literature_id;
const figure = Buffer.from("89504e470d0a1a0a00", "hex");
const artifact = (bytes: Uint8Array, media_type: string): ArtifactRef => ({
  sha256: createHash("sha256")
    .update(bytes)
    .digest("hex") as ArtifactRef["sha256"],
  byte_size: bytes.length,
  media_type,
});

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "sciretriever-document-read-"));
  let app: Application | undefined;
  let markdown = "# 标题\nαβ evidence\n![figure](fig.png)\n";
  let calls = 0;
  const backend: ParserBackend = {
    parse: async (request) => {
      calls++;
      const bytes = Buffer.from(markdown);
      return {
        source_asset_id: request.source_asset_id,
        source_sha256: request.source_sha256,
        page_count: 1,
        markdown: { artifact: artifact(bytes, "text/markdown"), bytes },
        resources: [
          {
            reference: "fig.png",
            content: { artifact: artifact(figure, "image/png"), bytes: figure },
          },
        ],
        provenance: {
          provenance: parseProvenance({
            provenance_id: id(800 + calls),
            source_kind: "parser",
            source_name: "fixture",
            source_record_id: null,
            observed_at: "2026-09-29T00:00:00Z",
            input_sha256: request.source_sha256,
            parameters_sha256: "a".repeat(64),
          }),
          parser_version: "fixture",
          mode: null,
          model_identity: null,
        },
      };
    },
  };
  try {
    app = await createApplication(home, {
      parsing: { parser: backend, rules: new TypeScriptParserArtifactRules() },
    });
    await app.database.putLiterature(FIXTURE_LITERATURE);
    const pdf = workbenchPdf();
    const stage = await app.files.stage();
    await stage.write(pdf);
    await app.files.publish(stage, "objects/source.pdf");
    const asset = parseAsset({
      asset_id: id(810),
      sha256: await sha256(pdf),
      size_bytes: pdf.length,
      media_type: "application/pdf",
      path: "objects/source.pdf",
    });
    await app.database.putLiteratureAsset({
      literature_asset_id: id(811),
      literature_id: lit,
      asset,
      role: "primary-pdf",
      source_url: null,
      provenance: {
        provenance_id: id(812),
        source_kind: "asset-provider",
        source_name: "fixture",
        source_record_id: null,
        observed_at: "2026-09-29T00:00:00Z",
        input_sha256: asset.sha256,
        parameters_sha256: null,
      },
    });
    const request = (
      mode: "reuse-current" | "reparse",
      revision: number | null = null,
    ) => ({
      literature_id: lit,
      asset_id: asset.asset_id,
      asset_sha256: asset.sha256,
      mode,
      expected_default_revision: revision,
    });
    return {
      home,
      asset,
      request,
      get app() {
        return app!;
      },
      setMarkdown(value: string) {
        markdown = value;
      },
      get calls() {
        return calls;
      },
      async reopen() {
        await app?.close();
        app = undefined;
        app = await createApplication(home, {
          parsing: {
            parser: backend,
            rules: new TypeScriptParserArtifactRules(),
          },
        });
      },
      async close() {
        await app?.close();
        await rm(home, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await app?.close();
    await rm(home, { recursive: true, force: true });
    throw error;
  }
}

const queryPageAssets = () => reactWorkbenchAssets("query");

async function segmentId(app: Application, version: string, ordinal: number) {
  return (
    await app.documentRead.segments({
      document_version_id: version,
      section_id: null,
      limit: 200,
      cursor: null,
    })
  ).segments[ordinal]!.segment_id;
}
describe("bounded document and material reading", () => {
  it("creates and resolves file evidence without parser or document version", async () => {
    const env = await fixture();
    let query: Awaited<ReturnType<typeof createQueryApplication>> | undefined;
    try {
      await env.app.close();
      query = await createQueryApplication(env.home);
      expect(query.readiness.schema_version).toBe(SCHEMA_VERSION);
      const result = await query.documentRead!.materialEvidence({
        literature_id: lit,
        asset_id: env.asset.asset_id,
      });
      expect(result.evidence).toMatchObject({
        target_kind: "material",
        content_sha256: env.asset.sha256,
      });
      expect(
        await query.documentRead!.resolveEvidence(result.evidence),
      ).toMatchObject({ granularity: "file" });
      await expect(
        query.documentRead!.default({
          literature_id: lit,
          asset_id: env.asset.asset_id,
          asset_sha256: env.asset.sha256,
        }),
      ).resolves.toMatchObject({ default: null });
      expect(env.calls).toBe(0);
    } finally {
      await query?.close();
      await env.close();
    }
  });

  it("streams a selected original PDF by stable IDs and hash, and waits for active reads on close", async () => {
    const env = await fixture();
    let query: Awaited<ReturnType<typeof createQueryApplication>> | undefined;
    try {
      const supplementary = Buffer.concat([
        workbenchPdf(),
        Buffer.from("\n% supplementary\n"),
      ]);
      const stage = await env.app.files.stage();
      await stage.write(supplementary);
      await env.app.files.publish(stage, "objects/supplementary.pdf");
      const extra = parseAsset({
        asset_id: id(820),
        sha256: await sha256(supplementary),
        size_bytes: supplementary.length,
        media_type: "application/pdf",
        path: "objects/supplementary.pdf",
      });
      await env.app.database.putLiteratureAsset({
        literature_asset_id: id(821),
        literature_id: lit,
        asset: extra,
        role: "supplementary-pdf",
        source_url: null,
        provenance: parseProvenance({
          provenance_id: id(822),
          source_kind: "asset-provider",
          source_name: "fixture",
          source_record_id: null,
          observed_at: "2026-09-29T00:00:00Z",
          input_sha256: extra.sha256,
          parameters_sha256: null,
        }),
      });
      await env.app.close();
      query = await createQueryApplication(env.home);
      const selected = {
        literature_id: lit,
        asset_id: extra.asset_id,
        asset_sha256: extra.sha256,
      };
      const read = await query.documentRead!.withMaterialBytes(
        selected,
        async (material, chunks) => {
          expect(material.asset_id).toBe(extra.asset_id);
          const parts: Uint8Array[] = [];
          for await (const chunk of chunks) parts.push(chunk);
          return Buffer.concat(parts);
        },
      );
      expect(read).toEqual(supplementary);
      expect(await sha256(read)).toBe(extra.sha256);
      await expect(
        query.documentRead!.withMaterialBytes(
          { ...selected, asset_sha256: env.asset.sha256 },
          async () => null,
        ),
      ).rejects.toMatchObject({ code: "material-stale" });
      await expect(
        query.documentRead!.withMaterialBytes(
          { ...selected, asset_id: id(999) },
          async () => null,
        ),
      ).rejects.toMatchObject({ code: "material-missing" });
      const cancelled = new AbortController();
      await expect(
        query.documentRead!.withMaterialBytes(
          selected,
          async (_material, chunks) => {
            for await (const chunk of chunks) {
              void chunk;
              cancelled.abort();
            }
          },
          cancelled.signal,
        ),
      ).rejects.toMatchObject({ code: "document-cancelled" });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let entered!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const active = query.documentRead!.withMaterialBytes(
        selected,
        async (_material, chunks) => {
          entered();
          await gate;
          for await (const chunk of chunks) void chunk;
        },
      );
      await started;
      let closed = false;
      const closing = query.documentRead!.close().then(() => {
        closed = true;
      });
      await Promise.resolve();
      expect(closed).toBe(false);
      await expect(
        query.documentRead!.withMaterialBytes(selected, async () => null),
      ).rejects.toMatchObject({ code: "document-closed" });
      release();
      await active;
      await closing;
      await query.close();
      query = await createQueryApplication(env.home);
      await expect(
        query.documentRead!.withMaterialBytes(
          selected,
          async (_material, chunks) => {
            for await (const chunk of chunks) void chunk;
            await writeFile(
              join(env.home, "artifacts/objects/supplementary.pdf"),
              Buffer.alloc(supplementary.length, 0),
            );
          },
        ),
      ).rejects.toMatchObject({ code: "document-integrity" });
    } finally {
      await query?.close();
      await env.close();
    }
  });

  it("reads bounded Unicode slices, pinned D1 evidence after D2, and verified resources", async () => {
    const env = await fixture();
    let query: Awaited<ReturnType<typeof createQueryApplication>> | undefined;
    try {
      await env.reopen();
      const d1 = await correctedDocumentFixture(env.app).parseDocuments(
        env.request("reparse"),
      );
      query = await createQueryApplication(env.home);
      const reader = query.documentRead!;
      expect(
        await reader.describe({
          document_version_id: d1.document.document_version_id,
        }),
      ).toMatchObject({
        section_count: 1,
        segment_count: 3,
        resource_count: 1,
      });
      const outline = await reader.outline({
        document_version_id: d1.document.document_version_id,
        limit: 1,
        cursor: null,
      });
      expect(outline.sections[0]?.title).toBe("标题");
      const chunks: string[] = [];
      let continuation: string | null = null;
      let last: Awaited<ReturnType<typeof reader.slice>>;
      do {
        last = await reader.slice({
          document_version_id: d1.document.document_version_id,
          selector: { kind: "section", section_id: "s1" },
          max_bytes: 7,
          continuation,
        });
        chunks.push(last.text);
        continuation = last.continuation;
      } while (continuation);
      expect(chunks.join("")).toBe("# 标题\n\nαβ evidence\n\n![](fig.png)\n\n");
      expect(last!.truncated).toBe(false);
      expect(last!.actual_range?.end_utf8).toBe(
        Buffer.byteLength(chunks.join("")),
      );
      await expect(
        reader.slice({
          document_version_id: d1.document.document_version_id,
          selector: { kind: "section", section_id: "s1" },
          max_bytes: 0,
          continuation: null,
        }),
      ).rejects.toMatchObject({ code: "document-invalid" });
      const segment = await reader.slice({
        document_version_id: d1.document.document_version_id,
        selector: {
          kind: "segment",
          segment_id: await segmentId(
            env.app,
            d1.document.document_version_id,
            1,
          ),
        },
        max_bytes: 64,
        continuation: null,
      });
      expect(segment.text).toBe("αβ evidence\n\n");
      expect(segment.evidence).toHaveLength(1);
      expect(await reader.resolveEvidence(segment.evidence[0])).toMatchObject({
        text: "αβ evidence\n\n",
      });
      const resources = await reader.resources({
        document_version_id: d1.document.document_version_id,
        limit: 1,
        cursor: null,
      });
      expect(resources.resources[0]?.reference).toBe("fig.png");
      const resource = await reader.resource({
        document_version_id: d1.document.document_version_id,
        resource_id: "r1",
        max_bytes: 64,
        continuation: null,
      });
      expect(Buffer.from(resource.bytes_base64!, "base64")).toEqual(figure);
      const firstResource = await reader.resource({
        document_version_id: d1.document.document_version_id,
        resource_id: "r1",
        max_bytes: 4,
        continuation: null,
      });
      expect(firstResource.actual_range).toEqual({
        start_byte: 0,
        end_byte: 4,
      });
      expect(firstResource.truncated).toBe(true);
      const rest = await reader.resource({
        document_version_id: d1.document.document_version_id,
        resource_id: "r1",
        max_bytes: 64,
        continuation: firstResource.continuation,
      });
      expect(
        Buffer.concat([
          Buffer.from(firstResource.bytes_base64!, "base64"),
          Buffer.from(rest.bytes_base64!, "base64"),
        ]),
      ).toEqual(figure);
      env.setMarkdown("# 新标题\nnew result\n![figure](fig.png)\n");
      const d2 = await correctedDocumentFixture(env.app).parseDocuments(
        env.request("reparse", d1.default_revision),
      );
      expect(d2.document.document_version_id).not.toBe(
        d1.document.document_version_id,
      );
      await expect(
        reader.slice({
          document_version_id: d2.document.document_version_id,
          selector: { kind: "section", section_id: "s1" },
          max_bytes: 7,
          continuation: (
            await reader.slice({
              document_version_id: d1.document.document_version_id,
              selector: { kind: "section", section_id: "s1" },
              max_bytes: 7,
              continuation: null,
            })
          ).continuation,
        }),
      ).rejects.toMatchObject({ code: "document-invalid" });
      expect(await reader.resolveEvidence(segment.evidence[0])).toMatchObject({
        text: "αβ evidence\n\n",
      });
      const protectedArtifact = await env.app.database.locateArtifact(
        d1.document.structure,
      );
      expect(protectedArtifact).not.toBeNull();
      await expect(
        env.app.artifactReclaimer.reclaim([
          {
            reference: protectedArtifact!.reference,
            artifact: d1.document.structure,
          },
        ]),
      ).resolves.toMatchObject({
        deleted: [],
        preserved: [protectedArtifact!.reference],
      });
    } finally {
      await query?.close();
      await env.close();
    }
  });

  it("serves query-only HTTP with the same material evidence and rejects cross-origin input", async () => {
    const env = await fixture();
    let workbench:
      | Awaited<ReturnType<typeof startQueryOnlyWorkbench>>
      | undefined;
    try {
      await env.app.close();
      workbench = await startQueryOnlyWorkbench({
        home: env.home,
        assets: new Map(),
      });
      const request = () =>
        fetch(`${workbench!.origin}/api/v1/query/material-evidence`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            protocol_version: 1,
            request: { literature_id: lit, asset_id: env.asset.asset_id },
          }),
        });
      const response = await request();
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        protocol_version: 1,
        result: { evidence: { target_kind: "material" } },
      });
      const bytesRequest = (asset_id: string, asset_sha256: string) =>
        fetch(`${workbench!.origin}/api/v1/query/material-bytes`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            protocol_version: 1,
            request: { literature_id: lit, asset_id, asset_sha256 },
          }),
        });
      const original = await bytesRequest(env.asset.asset_id, env.asset.sha256);
      expect(original.status).toBe(200);
      expect(original.headers.get("x-sciretriever-asset-sha256")).toBe(
        env.asset.sha256,
      );
      const pdf = Buffer.from(await original.arrayBuffer());
      expect(pdf).toEqual(Buffer.from(workbenchPdf()));
      expect(await sha256(pdf)).toBe(env.asset.sha256);
      const stale = await bytesRequest(env.asset.asset_id, "f".repeat(64));
      expect(stale.status).toBe(409);
      expect(await stale.json()).toMatchObject({ code: "material-stale" });
      const missing = await bytesRequest(id(999), env.asset.sha256);
      expect(missing.status).toBe(404);
      expect(await missing.json()).toMatchObject({ code: "material-missing" });
      const denied = await fetch(
        `${workbench.origin}/api/v1/query/material-evidence`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: "https://other.example",
          },
          body: JSON.stringify({
            protocol_version: 1,
            request: { literature_id: lit, asset_id: env.asset.asset_id },
          }),
        },
      );
      expect(denied.status).toBe(403);
    } finally {
      await workbench?.close();
      await env.close();
    }
  });

  it("invalidates warmed schema checks after external DDL changes", async () => {
    const env = await fixture();
    let raw: DatabaseSync | undefined;
    try {
      await env.reopen();
      const receipt = await correctedDocumentFixture(env.app).parseDocuments(
        env.request("reparse"),
      );
      const request = {
        document_version_id: receipt.document.document_version_id,
      };
      const first = await env.app.documentRead.describe(request);
      expect(await env.app.documentRead.describe(request)).toEqual(first);
      raw = new DatabaseSync(join(env.home, "catalog.sqlite"));
      raw.exec(
        "CREATE INDEX unexpected_document_index ON literatures(meta_literature_id)",
      );
      await expect(
        env.app.documentRead.describe(request),
      ).rejects.toBeInstanceOf(Error);
      raw.exec("DROP INDEX unexpected_document_index");
      expect(await env.app.documentRead.describe(request)).toEqual(first);
    } finally {
      raw?.close();
      await env.close();
    }
  });

  it("separates invalid locators, unsupported schemes and corrupt resource bytes", async () => {
    const env = await fixture();
    let query: Awaited<ReturnType<typeof createQueryApplication>> | undefined;
    try {
      await env.reopen();
      const receipt = await correctedDocumentFixture(env.app).parseDocuments(
        env.request("reparse"),
      );
      query = await createQueryApplication(env.home);
      const reader = query.documentRead!;
      const version = receipt.document.document_version_id;
      await expect(
        reader.slice({
          document_version_id: version,
          selector: { kind: "segment", segment_id: "p999" },
          max_bytes: 100,
          continuation: null,
        }),
      ).rejects.toMatchObject({ code: "document-invalid" });
      await expect(
        reader.slice({
          document_version_id: version,
          selector: {
            kind: "segment",
            segment_id: await segmentId(env.app, version, 1),
          },
          max_bytes: -1,
          continuation: null,
        }),
      ).rejects.toMatchObject({ code: "document-invalid" });
      const first = await reader.slice({
        document_version_id: version,
        selector: { kind: "section", section_id: "s1" },
        max_bytes: 7,
        continuation: null,
      });
      await expect(
        reader.slice({
          document_version_id: version,
          selector: { kind: "section", section_id: "s1" },
          max_bytes: 7,
          continuation: first.continuation!.slice(0, -1) + "A",
        }),
      ).rejects.toMatchObject({ code: "document-invalid" });
      const full = await reader.slice({
        document_version_id: version,
        selector: {
          kind: "segment",
          segment_id: await segmentId(env.app, version, 1),
        },
        max_bytes: 100,
        continuation: null,
      });
      await expect(
        reader.resolveEvidence({
          ...full.evidence[0],
          locator_scheme: "page-v1",
        }),
      ).rejects.toMatchObject({ code: "document-unsupported" });
      await expect(
        reader.resolveEvidence({
          ...full.evidence[0],
          representation_sha256: "f".repeat(64),
        }),
      ).rejects.toMatchObject({ code: "document-integrity" });
      await expect(
        reader.resolveEvidence({
          ...full.evidence[0],
          content_sha256: "f".repeat(64),
        }),
      ).rejects.toMatchObject({ code: "document-integrity" });
      const material = await reader.materialEvidence({
        literature_id: lit,
        asset_id: env.asset.asset_id,
      });
      await expect(
        reader.resolveEvidence({
          ...material.evidence,
          content_sha256: "f".repeat(64),
        }),
      ).rejects.toMatchObject({ code: "document-integrity" });
      const snapshot = await env.app.database.documentVersion(version);
      const path = snapshot!.resource_artifact_paths["fig.png"]!;
      await reader.withReadScope(() =>
        reader.describe({ document_version_id: version }),
      );
      await writeFile(join(env.app.files.root, path), Buffer.from("tampered"));
      await expect(
        reader.withReadScope(() =>
          reader.describe({ document_version_id: version }),
        ),
      ).rejects.toMatchObject({ code: "document-integrity" });
      await expect(
        reader.resource({
          document_version_id: version,
          resource_id: "r1",
          max_bytes: 64,
          continuation: null,
        }),
      ).rejects.toMatchObject({ code: "document-integrity" });
    } finally {
      await query?.close();
      await env.close();
    }
  });

  it("copies requests, rejects malformed cursors, and accepts equivalent selector key order", async () => {
    const env = await fixture();
    let query: Awaited<ReturnType<typeof createQueryApplication>> | undefined;
    try {
      await env.reopen();
      env.setMarkdown(
        `# ${"长".repeat(300)}\nfirst line\nsecond line\n![figure](fig.png)\n`,
      );
      const receipt = await correctedDocumentFixture(env.app).parseDocuments(
        env.request("reparse"),
      );
      query = await createQueryApplication(env.home);
      const reader = query.documentRead!;
      const version = receipt.document.document_version_id;
      const outline = await reader.outline({
        document_version_id: version,
        limit: 1,
        cursor: null,
      });
      expect(Buffer.byteLength(outline.sections[0]!.title)).toBeLessThanOrEqual(
        512,
      );
      expect(outline.sections[0]!.title_truncated).toBe(true);
      expect(outline.gaps).toContain("outline-title-truncated");

      const selector = { kind: "section", section_id: "s1" };
      const mutable = {
        document_version_id: version,
        selector,
        max_bytes: 12,
        continuation: null,
      };
      const firstPending = reader.slice(mutable);
      selector.section_id = "invalid";
      mutable.max_bytes = -1;
      const first = await firstPending;
      expect(first.selector).toEqual({ kind: "section", section_id: "s1" });
      expect(first.continuation).not.toBeNull();
      await expect(
        reader.slice({
          document_version_id: version,
          selector: { kind: "section", section_id: "s1" },
          max_bytes: 12,
          continuation: Buffer.from("null").toString("base64url"),
        }),
      ).rejects.toMatchObject({ code: "document-invalid" });

      const cursor = JSON.parse(
        Buffer.from(first.continuation!, "base64url").toString("utf8"),
      ) as Record<string, unknown>;
      cursor.selector = { section_id: "s1", kind: "section" };
      const core = { ...cursor };
      delete core.checksum;
      cursor.checksum = createHash("sha256")
        .update(JSON.stringify(core))
        .digest("hex");
      const reordered = Buffer.from(JSON.stringify(cursor)).toString(
        "base64url",
      );
      await expect(
        reader.slice({
          document_version_id: version,
          selector: { kind: "section", section_id: "s1" },
          max_bytes: 12,
          continuation: reordered,
        }),
      ).resolves.toMatchObject({
        selector: { kind: "section", section_id: "s1" },
      });
    } finally {
      await query?.close();
      await env.close();
    }
  });

  it("pages dense segment evidence and reports only reliable resource context", async () => {
    const env = await fixture();
    let query: Awaited<ReturnType<typeof createQueryApplication>> | undefined;
    try {
      await env.reopen();
      const lines = Array.from(
        { length: 90 },
        (_, index) => `line ${index}\n`,
      ).join("");
      env.setMarkdown(
        `# Heading\n${lines}fig.png is mentioned here\n\`![fake](fig.png)\`\n\\![escaped](fig.png)\n<!--\n![comment](fig.png)\n-->\n![indirect][ref]\n[ref]: fig.png\n`,
      );
      const receipt = await correctedDocumentFixture(env.app).parseDocuments(
        env.request("reparse"),
      );
      query = await createQueryApplication(env.home);
      const reader = query.documentRead!;
      const version = receipt.document.document_version_id;
      const selector = { kind: "section" as const, section_id: "s1" };
      let continuation: string | null = null;
      let combined = "";
      let pages = 0;
      do {
        const part = await reader.slice({
          document_version_id: version,
          selector,
          max_bytes: 65536,
          continuation,
        });
        expect(part.evidence.length).toBeLessThanOrEqual(32);
        if (pages === 0) expect(part.gaps).toContain("evidence-page-limit");
        combined += part.text;
        continuation = part.continuation;
        pages++;
      } while (continuation);
      expect(pages).toBeGreaterThan(2);
      expect(combined).toContain(lines);
      const missing = await reader.slice({
        document_version_id: version,
        selector: { kind: "resource-context", resource_id: "r1" },
        max_bytes: 100,
        continuation: null,
      });
      expect(missing.actual_range).toBeNull();
      expect(missing.gaps).toContain("resource-context-unavailable");
      env.setMarkdown(
        "# Heading\n\\![escaped](fig.png)\n<!--\n![comment](fig.png)\n-->\n![real](fig.png)\n",
      );
      const next = await correctedDocumentFixture(env.app).parseDocuments(
        env.request("reparse", 1),
      );
      const context = await reader.slice({
        document_version_id: next.document.document_version_id,
        selector: { kind: "resource-context", resource_id: "r1" },
        max_bytes: 100,
        continuation: null,
      });
      expect(context.text).toBe("![real](fig.png)\n");
      const stop = new AbortController();
      stop.abort();
      await expect(
        reader.slice(
          {
            document_version_id: version,
            selector,
            max_bytes: 65536,
            continuation: null,
          },
          stop.signal,
        ),
      ).rejects.toMatchObject({ code: "document-cancelled" });
    } finally {
      await query?.close();
      await env.close();
    }
  });

  it("shows the same fixed version and Unicode text to a human query reader", async () => {
    const env = await fixture();
    let workbench:
      | Awaited<ReturnType<typeof startQueryOnlyWorkbench>>
      | undefined;
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    try {
      await env.reopen();
      env.setMarkdown(
        `# 标题\n${"αβ evidence ".repeat(1000)}\n![figure](fig.png)\n`,
      );
      const receipt = await correctedDocumentFixture(env.app).parseDocuments(
        env.request("reparse"),
      );
      workbench = await startQueryOnlyWorkbench({
        home: env.home,
        assets: await queryPageAssets(),
      });
      browser = await chromium.launch({
        executablePath:
          process.env.SCIRETRIEVER_BROWSER_EXECUTABLE ??
          "/home/duanjw/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome",
        headless: true,
      });
      const page = await browser.newPage();
      const failures: string[] = [];
      page.on("pageerror", (error) => failures.push(error.message));
      await page.goto(
        `${workbench.origin}/?literature=${lit}&reader=doc&document=${receipt.document.document_version_id}`,
      );
      const article = page.locator(".reading-article");
      await expect
        .poll(() => article.textContent(), { timeout: 10000 })
        .toContain("标题");
      await expect.poll(() => article.textContent()).toContain("αβ evidence");
      await expect
        .poll(async () => (await article.textContent())?.length ?? 0)
        .toBeGreaterThan(8192);
      await page
        .locator(".reader-information")
        .getByRole("button", { name: "技术详情", exact: true })
        .click();
      expect(await page.locator(".reader-information").innerText()).toContain(
        receipt.document.document_version_id,
      );
      expect(failures).toEqual([]);
      expect("jobs" in workbench.application).toBe(false);
    } finally {
      await browser?.close();
      await workbench?.close();
      await env.close();
    }
  }, 60000);

  it("keeps unheaded text reachable and ignores late or mismatched browser read replies", async () => {
    const env = await fixture();
    let workbench:
      | Awaited<ReturnType<typeof startQueryOnlyWorkbench>>
      | undefined;
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    try {
      await env.reopen();
      env.setMarkdown(
        `${"introduction without heading ".repeat(400)}\nsecond paragraph\n![figure](fig.png)\n`,
      );
      const receipt = await correctedDocumentFixture(env.app).parseDocuments(
        env.request("reparse"),
      );
      workbench = await startQueryOnlyWorkbench({
        home: env.home,
        assets: await queryPageAssets(),
      });
      browser = await chromium.launch({
        executablePath:
          process.env.SCIRETRIEVER_BROWSER_EXECUTABLE ??
          "/home/duanjw/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome",
        headless: true,
      });
      const page = await browser.newPage();
      const failures: string[] = [];
      page.on("pageerror", (error) => failures.push(error.message));
      const url = `${workbench.origin}/?literature=${lit}&reader=doc`;
      await page.route("**/material-evidence", async (route) => {
        const response = await route.fetch();
        const value = await response.json();
        value.result.evidence.material.asset_sha256 = "f".repeat(64);
        await route.fulfill({ response, json: value });
      });
      await page.goto(url);
      await expect
        .poll(() => page.locator("main").innerText(), { timeout: 10000 })
        .toMatch(/不匹配|无法|invalid|validation failed/);
      expect(await page.locator(".reading-article").count()).toBe(0);
      await page.unroute("**/material-evidence");
      await page.route("**/document-default", async (route) => {
        const response = await route.fetch();
        const value = await response.json();
        value.result.material.asset_id = id(999);
        await route.fulfill({ response, json: value });
      });
      await page.reload();
      await expect
        .poll(() => page.locator("main").innerText(), { timeout: 10000 })
        .toMatch(/不匹配|无法|invalid|validation failed/);
      expect(await page.locator(".reading-article").count()).toBe(0);
      await page.unroute("**/document-default");
      await page.route("**/document-describe", async (route) => {
        const response = await route.fetch();
        const value = await response.json();
        value.result.document.source_material_ref.asset_id = id(999);
        await route.fulfill({ response, json: value });
      });
      await page.reload();
      await expect
        .poll(() => page.locator("main").innerText())
        .toContain("固定文档与原始材料不匹配");
      expect(await page.locator(".reading-article").count()).toBe(0);
      await page.unroute("**/document-describe");
      await page.reload();
      await expect
        .poll(() => page.locator(".reading-article").textContent(), {
          timeout: 10000,
        })
        .toContain("introduction without heading");
      await page.getByRole("button", { name: "显示目录", exact: true }).click();
      expect(await page.locator(".reader-outline button").count()).toBe(0);
      await page
        .locator(".reader-information")
        .getByRole("button", { name: "技术详情", exact: true })
        .click();
      expect(await page.locator(".reader-information").innerText()).toContain(
        receipt.document.document_version_id,
      );
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let delayed = false;
      await page.route("**/document-slice", async (route) => {
        const response = await route.fetch();
        delayed = true;
        await gate;
        await route.fulfill({ response }).catch(() => undefined);
      });
      await page.reload();
      await expect.poll(() => delayed).toBe(true);
      await page.getByRole("tab", { name: "PDF", exact: true }).click();
      release();
      await page.unroute("**/document-slice");
      await page
        .locator('.reading-pdf-page[data-rendered="true"]')
        .first()
        .waitFor();
      expect(await page.locator(".reading-article").count()).toBe(0);
      expect(new URL(page.url()).searchParams.get("reader")).toBe("pdf");
      await page.route("**/document-slice", async (route) => {
        const response = await route.fetch();
        const value = await response.json();
        value.result.document.document_version_id = id(999);
        await route.fulfill({ response, json: value });
      });
      await page.getByRole("tab", { name: "全文", exact: true }).click();
      await expect
        .poll(() => page.locator(".reading-status").innerText())
        .toMatch(/无法|invalid|失败|validation failed/);
      expect(await page.locator(".reading-article section").count()).toBe(0);
      await page.unroute("**/document-slice");
      await page.route("**/document-resource", async (route) => {
        const response = await route.fetch();
        const value = await response.json();
        value.result.bytes_base64 = Buffer.from(figure.subarray(0, 5)).toString(
          "base64",
        );
        value.result.actual_range = { start_byte: 0, end_byte: 5 };
        value.result.truncated = false;
        value.result.continuation = null;
        await route.fulfill({ response, json: value });
      });
      await page.reload();
      await page.locator(".reading-resource").scrollIntoViewIfNeeded();
      await expect
        .poll(() => page.locator(".reading-resource").innerText())
        .toMatch(/无法|失败|暂不可读/);
      expect(await page.locator(".reading-resource img").count()).toBe(0);
      await page.unroute("**/document-resource");
      let resourcePages = 0;
      let resourceBase:
        | {
            result: {
              resources: Record<string, unknown>[];
              document: unknown;
              total: number;
              next_cursor: string | null;
            };
          }
        | undefined;
      await page.route("**/document-resources", async (route) => {
        if (!resourceBase) resourceBase = await (await route.fetch()).json();
        const base = resourceBase!;
        const original = base.result.resources[0];
        const request = route.request().postDataJSON() as {
          request: { cursor: string | null };
        };
        const indexes =
          request.request.cursor === null
            ? Array.from({ length: 50 }, (_, index) => index + 1)
            : [51];
        resourcePages++;
        await route.fulfill({
          status: 200,
          json: {
            protocol_version: 1,
            result: {
              ...base.result,
              resources: indexes.map((index) => ({
                ...original,
                resource_id: `r${index}`,
                reference: `fig-${index}.png`,
              })),
              total: 51,
              next_cursor: request.request.cursor === null ? "next" : null,
            },
          },
        });
      });
      // The second synthetic cursor is not a real server cursor. Reuse the first
      // validated page as the resource descriptor source for this pagination probe.
      await page.reload();
      await page
        .getByRole("button", { name: "文档资源（51）", exact: true })
        .click();
      expect(await page.locator(".reader-resources button").count()).toBe(51);
      expect(
        await page.locator(".reader-resources button").last().innerText(),
      ).toBe("fig-51.png");
      expect(resourcePages).toBe(2);
      await page.unroute("**/document-resources");
      expect(failures).toEqual([]);
    } finally {
      await browser?.close();
      await workbench?.close();
      await env.close();
    }
  }, 60000);
  it("settles an in-flight fixed-version read before closing its SQLite and FileStore owners", async () => {
    const env = await fixture();
    try {
      await env.reopen();
      const receipt = await correctedDocumentFixture(env.app).parseDocuments(
        env.request("reparse"),
      );
      const real = env.app.database.documentVersion.bind(env.app.database);
      let entered!: () => void;
      let release!: () => void;
      const ready = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      vi.spyOn(env.app.database, "documentVersion").mockImplementation(
        async (version) => {
          const snapshot = await real(version);
          entered();
          await gate;
          return snapshot;
        },
      );
      const pending = env.app.documentRead.describe({
        document_version_id: receipt.document.document_version_id,
      });
      await ready;
      const closing = env.app.close();
      expect(env.app.close()).toBe(closing);
      const settled = await Promise.race([
        closing.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 20)),
      ]);
      expect(settled).toBe(false);
      release();
      await expect(pending).resolves.toMatchObject({ segment_count: 3 });
      await closing;
      await expect(
        env.app.documentRead.describe({
          document_version_id: receipt.document.document_version_id,
        }),
      ).rejects.toMatchObject({ code: "document-closed" });
      const stopped = new AbortController();
      stopped.abort();
      await expect(
        env.app.documentRead.describe(
          { document_version_id: receipt.document.document_version_id },
          stopped.signal,
        ),
      ).rejects.toMatchObject({ code: "document-closed" });
    } finally {
      vi.restoreAllMocks();
      await env.close();
    }
  });
  it("passes a query HTTP disconnect to the read signal without dispatching maintenance", async () => {
    const env = await fixture();
    let workbench:
      | Awaited<ReturnType<typeof startQueryOnlyWorkbench>>
      | undefined;
    try {
      await env.reopen();
      const receipt = await correctedDocumentFixture(env.app).parseDocuments(
        env.request("reparse"),
      );
      workbench = await startQueryOnlyWorkbench({
        home: env.home,
        assets: new Map(),
      });
      const reader = workbench.application.documentRead!;
      let entered!: () => void;
      const ready = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let observed: AbortSignal | undefined;
      vi.spyOn(reader, "describe").mockImplementation(
        async (_value, signal) => {
          observed = signal;
          entered();
          await new Promise<void>((_resolve, reject) =>
            signal?.addEventListener(
              "abort",
              () => reject(new DocumentReadError("document-cancelled")),
              { once: true },
            ),
          );
          throw new Error("unexpected read continuation");
        },
      );
      const stop = new AbortController();
      const pending = fetch(
        `${workbench.origin}/api/v1/query/document-describe`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: stop.signal,
          body: JSON.stringify({
            protocol_version: 1,
            request: {
              document_version_id: receipt.document.document_version_id,
            },
          }),
        },
      );
      await ready;
      stop.abort();
      await expect(pending).rejects.toBeDefined();
      await vi.waitFor(() => expect(observed?.aborted).toBe(true));
      expect("maintenance" in workbench.application).toBe(false);
    } finally {
      vi.restoreAllMocks();
      await workbench?.close();
      await env.close();
    }
  });
});
