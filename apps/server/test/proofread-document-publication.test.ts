import { describe, it, expect } from "vitest";
import {
  parseDocumentReadRequest,
  parseDocumentReadResult,
  parseEvidenceRef,
} from "@sciretriever/contracts";
import { coreProcessingFixture } from "./core-processing-fixture.js";
import { createQueryApplication } from "../src/bootstrap/application.js";
import { executeQuery } from "../src/entry/query-operations.js";

describe("proofread document publication", () => {
  it("publishes a fixed corrected version, reads page evidence and reopens it without reprocessing", async () => {
    const e = await coreProcessingFixture();
    try {
      await e.app.documentProcessing.parseDocuments(e.rawParseRequest);
      const corrected = await e.app.proofreading!.build({
        asset_id: e.asset.asset_id,
      });
      const request = {
        literature_id: e.rawParseRequest.literature_id,
        asset_id: e.asset.asset_id,
        proofread_id: corrected.version.proofread_id,
        expected_default_revision: null,
      };
      const first = await e.app.proofreadDocuments.publish(request);
      expect(first).toMatchObject({
        published: true,
        default_updated: true,
        default_revision: 1,
        index_status: "updated",
        document: {
          schema_version: 2,
          builder_version: "proofread-blocks-v1",
          proofread_id: corrected.version.proofread_id,
        },
      });
      expect(first.document).not.toHaveProperty("parser_result_sha256");
      expect(await e.app.proofreadDocuments.publish(request)).toEqual({
        ...first,
        published: false,
        index_status: "unchanged",
      });
      const id = first.document.document_version_id;
      const segments = await e.app.documentRead.segments({
        document_version_id: id,
        section_id: null,
        limit: 200,
        cursor: null,
      });
      expect(segments.capabilities).toMatchObject({ page: true, bbox: true });
      expect(segments.segments[0]).toMatchObject({
        page: 1,
        source: "parser",
        basis: "text-layer",
      });
      parseDocumentReadResult(
        "segments",
        segments,
        parseDocumentReadRequest("segments", {
          document_version_id: id,
          section_id: null,
          limit: 200,
          cursor: null,
        }),
      );
      const sliceRequest = parseDocumentReadRequest("slice", {
        document_version_id: id,
        selector: {
          kind: "segment",
          segment_id: segments.segments[0]!.segment_id,
        },
        max_bytes: 65536,
        continuation: null,
      });
      const slice = parseDocumentReadResult(
        "slice",
        await e.app.documentRead.slice(sliceRequest),
        sliceRequest,
      );
      const evidence = slice.evidence[0]!;
      expect(evidence).toMatchObject({
        page_region: { scheme: "page-region-v1", page: 1 },
      });
      expect(await e.app.documentRead.resolveEvidence(evidence)).toMatchObject({
        text: slice.text,
        location: {
          page: 1,
          source: "parser",
          basis: "text-layer",
        },
      });
      await expect(
        e.app.documentRead.resolveEvidence({
          ...evidence,
          page_region: {
            ...(evidence.target_kind === "document"
              ? evidence.page_region
              : null),
            page: 2,
          },
        }),
      ).rejects.toMatchObject({ code: "document-integrity" });
      parseEvidenceRef(evidence);
      await e.reopen();
      const query = await createQueryApplication(e.home);
      try {
        expect(
          await executeQuery(query, "document-evidence", {
            evidence,
            max_bytes: 65536,
            continuation: null,
          }),
        ).toMatchObject({ text: slice.text, location: { page: 1 } });
      } finally {
        await query.close();
      }
      expect(e.modelCalls).toBe(0);
      expect(e.parseCalls).toBe(2);
    } finally {
      await e.close();
    }
  }, 0);
});

it("keeps a published version after CAS loss, rejects stale raw inputs, and returns fixed draft corrections with bounded continuation", async () => {
  const e = await coreProcessingFixture();
  try {
    await e.app.documentProcessing.parseDocuments(e.rawParseRequest);
    const first = await e.app.proofreading!.build({
      asset_id: e.asset.asset_id,
    });
    const request = {
      literature_id: e.rawParseRequest.literature_id,
      asset_id: e.asset.asset_id,
      proofread_id: first.version.proofread_id,
      expected_default_revision: null,
    };
    const a = await e.app.proofreadDocuments.publish(request);
    e.setText("# Revised\n\nA second synthetic finding.");
    await e.app.documentProcessing.parseDocuments({
      ...e.rawParseRequest,
      force: true,
    });
    await expect(e.app.proofreadDocuments.publish(request)).rejects.toThrow();
    const next = await e.app.proofreading!.build({
      asset_id: e.asset.asset_id,
    });
    const b = await e.app.proofreadDocuments.publish({
      ...request,
      proofread_id: next.version.proofread_id,
    });
    expect(b).toMatchObject({
      published: true,
      default_updated: false,
      default_revision: 1,
    });
    expect(
      (
        await e.app.documentRead.default({
          literature_id: e.rawParseRequest.literature_id,
          asset_id: e.asset.asset_id,
          asset_sha256: e.asset.sha256,
        })
      ).default?.document_version_id,
    ).toBe(a.document.document_version_id);
    const reader = await createQueryApplication(e.home);
    try {
      expect(
        await executeQuery(reader, "document-parts", {
          literature_id: e.rawParseRequest.literature_id,
          offset: 0,
          limit: 10,
        }),
      ).toMatchObject({
        total: 1,
        parts: [
          {
            role: "main",
            default: { document_version_id: a.document.document_version_id },
            proofread: { proofread_id: next.version.proofread_id },
          },
        ],
        next_offset: null,
      });
      const segments = await e.app.documentRead.segments({
        document_version_id: b.document.document_version_id,
        section_id: null,
        limit: 20,
        cursor: null,
      });
      let continuation: string | null = null,
        text = "";
      do {
        const page = await e.app.documentRead.corrections({
          document_version_id: b.document.document_version_id,
          segment_id: segments.segments.find((s) => s.kind === "text")!
            .segment_id,
          max_bytes: 127,
          continuation,
        });
        expect(Buffer.byteLength(page.text)).toBeLessThanOrEqual(127);
        text += page.text;
        continuation = page.continuation;
      } while (continuation);
      expect(JSON.parse(text)).toMatchObject({
        draft: { text: expect.stringContaining("synthetic") },
        block: {
          text: expect.stringContaining("synthetic"),
          text_source: "parser",
          basis: "text-layer",
        },
      });
    } finally {
      await reader.close();
    }
    const published = await e.app.proofreadDocuments.publish({
      ...request,
      proofread_id: next.version.proofread_id,
      expected_default_revision: 1,
    });
    expect(published).toMatchObject({
      published: false,
      default_updated: true,
      default_revision: 2,
    });
    expect(published.index_status).toBe("updated");
    const query = await createQueryApplication(e.home);
    try {
      const result = await query.context!.search({
        query: "synthetic",
        scope: { kind: "library" },
        kinds: ["document"],
        versions: { kind: "default" },
        budget: { max_items: 20, max_bytes: 16384, token_limit: null },
        continuation: null,
      });
      expect(JSON.stringify(result)).toContain('"page-region-v1"');
      expect(JSON.stringify(result)).toContain(b.document.document_version_id);
      expect(JSON.stringify(result)).not.toContain(
        a.document.document_version_id,
      );
    } finally {
      await query.close();
    }
  } finally {
    await e.close();
  }
}, 30000);

it("lists and reads a supplementary PDF independently from the main default", async () => {
  const { randomUUID } = await import("node:crypto");
  const { sha256, parseAsset } = await import("@sciretriever/contracts");
  const { workbenchPdf } = await import(
    "../src/workbench/synthetic-fixture.js"
  );
  const e = await coreProcessingFixture();
  try {
    const bytes = workbenchPdf("10.1000/supplement"),
      stage = await e.app.files.stage({ maxBytes: bytes.length });
    await stage.write(bytes);
    const path = "objects/supplement.pdf";
    await e.app.files.publish(stage, path);
    const asset = parseAsset({
      asset_id: randomUUID(),
      sha256: await sha256(bytes),
      size_bytes: bytes.length,
      media_type: "application/pdf",
      path,
    });
    await e.app.database.putLiteratureAsset({
      literature_asset_id: randomUUID(),
      literature_id: e.rawParseRequest.literature_id,
      asset,
      role: "supplementary-pdf",
      source_url: null,
      provenance: {
        provenance_id: randomUUID(),
        source_kind: "user",
        source_name: "fixture",
        source_record_id: null,
        observed_at: "2026-10-20T00:00:00Z",
        input_sha256: asset.sha256,
        parameters_sha256: null,
      },
    });
    await e.app.documentProcessing.parseDocuments({
      ...e.rawParseRequest,
      asset_id: asset.asset_id,
      asset_sha256: asset.sha256,
    });
    const p = await e.app.proofreading!.build({ asset_id: asset.asset_id });
    const published = await e.app.proofreadDocuments.publish({
      literature_id: e.rawParseRequest.literature_id,
      asset_id: asset.asset_id,
      proofread_id: p.version.proofread_id,
      expected_default_revision: null,
    });
    const q = await createQueryApplication(e.home);
    try {
      expect(
        await executeQuery(q, "document-parts", {
          literature_id: e.rawParseRequest.literature_id,
          offset: 0,
          limit: 1,
        }),
      ).toMatchObject({
        total: 2,
        parts: [{ role: "main", default: null }],
        next_offset: 1,
      });
      expect(
        await executeQuery(q, "document-parts", {
          literature_id: e.rawParseRequest.literature_id,
          offset: 1,
          limit: 1,
        }),
      ).toMatchObject({
        parts: [
          {
            role: "supplementary",
            default: {
              document_version_id: published.document.document_version_id,
            },
          },
        ],
        next_offset: null,
      });
    } finally {
      await q.close();
    }
    expect(e.modelCalls).toBe(0);
  } finally {
    await e.close();
  }
});

it("exposes publication and part reads through CLI/MCP without opening a parser or model", async () => {
  const { runCli } = await import("../src/cli/main.js");
  const { createMcpServer } = await import("../src/mcp/server.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import(
    "@modelcontextprotocol/sdk/inMemory.js"
  );
  const e = await coreProcessingFixture();
  const server = createMcpServer({
    maintenance: true,
    applicationFactory: async () => e.app,
    queryFactory: () => createQueryApplication(e.home),
  });
  const client = new Client({ name: "fixture", version: "1" });
  try {
    await e.app.documentProcessing.parseDocuments(e.rawParseRequest);
    const proofread = await e.app.proofreading!.build({
      asset_id: e.asset.asset_id,
    });
    const input = {
      literature_id: e.rawParseRequest.literature_id,
      asset_id: e.asset.asset_id,
      proofread_id: proofread.version.proofread_id,
      expected_default_revision: null,
    };
    const stdout: string[] = [];
    expect(
      (
        await runCli(
          ["document", "publish-proofread", "--request", "-", "--json"],
          {
            home: e.home,
            stdout: (s) => stdout.push(s),
            stdin: (async function* () {
              yield Buffer.from(JSON.stringify(input));
            })(),
          },
        )
      ).code,
    ).toBe(0);
    const publication = JSON.parse(stdout.join(""));
    expect(publication).toMatchObject({
      published: true,
      index_status: "updated",
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    await client.connect(b);
    const result = await client.callTool({
      name: "document_read",
      arguments: {
        operation: "parts",
        request: {
          literature_id: e.rawParseRequest.literature_id,
          offset: 0,
          limit: 20,
        },
      },
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      result: {
        parts: [
          {
            default: {
              document_version_id: publication.document.document_version_id,
            },
          },
        ],
      },
    });
    expect(
      (
        await client.callTool({
          name: "document_publish_proofread",
          arguments: input,
        })
      ).isError,
    ).not.toBe(true);
    const docId = publication.document.document_version_id;
    const segment = (
      await e.app.documentRead.segments({
        document_version_id: docId,
        section_id: null,
        limit: 1,
        cursor: null,
      })
    ).segments[0]!;
    const corrections = await client.callTool({
      name: "document_read",
      arguments: {
        operation: "corrections",
        request: {
          document_version_id: docId,
          segment_id: segment.segment_id,
          max_bytes: 65536,
          continuation: null,
        },
      },
    });
    expect(corrections.isError).not.toBe(true);
    const envelope = corrections.structuredContent as {
      result: { text: string };
    };
    expect(JSON.parse(envelope.result.text)).toMatchObject({
      block_id: segment.segment_id,
      draft: expect.any(Object),
      block: { basis: "text-layer" },
      page_image: { asset_id: e.asset.asset_id, page: 0 },
    });
    const correctionOutput: string[] = [];
    const cliRead = await runCli(
      ["document", "corrections", "--request", "-", "--json"],
      {
        home: e.home,
        stdout: (s) => correctionOutput.push(s),
        stdin: (async function* () {
          yield Buffer.from(
            JSON.stringify({
              document_version_id: docId,
              segment_id: segment.segment_id,
              max_bytes: 65536,
              continuation: null,
            }),
          );
        })(),
      },
    );
    expect(cliRead.code).toBe(0);
    expect(JSON.parse(correctionOutput.join(""))).toEqual({
      protocol_version: 1,
      result: envelope.result,
    });
    expect(e.modelCalls).toBe(0);
    expect(e.parseCalls).toBe(2);
  } finally {
    await client.close();
    await server.close();
    await e.close();
  }
}, 30000);

it("preserves a valid default if index rebuilding fails and refuses work after close", async () => {
  const { ProofreadDocumentService } = await import(
    "../src/document/proofread-publication.js"
  );
  const e = await coreProcessingFixture();
  const service = new ProofreadDocumentService(
    e.app.database,
    e.app.files,
    async () => {
      throw new Error("synthetic index failure");
    },
  );
  try {
    await e.app.documentProcessing.parseDocuments(e.rawParseRequest);
    const proofread = await e.app.proofreading!.build({
      asset_id: e.asset.asset_id,
    });
    const input = {
      literature_id: e.rawParseRequest.literature_id,
      asset_id: e.asset.asset_id,
      proofread_id: proofread.version.proofread_id,
      expected_default_revision: null,
    };
    const receipt = await service.publish(input);
    expect(receipt).toMatchObject({
      published: true,
      default_updated: true,
      index_status: "failed",
    });
    expect(
      await e.app.documentRead.describe({
        document_version_id: receipt.document.document_version_id,
      }),
    ).toMatchObject({ capabilities: { page: true } });
    await service.close();
    await expect(service.publish(input)).rejects.toMatchObject({
      code: "document-cancelled",
    });
  } finally {
    await service.close();
    await e.close();
  }
});

it("counts proofread source verification bytes and does not load drafts or images twice during a document read", async () => {
  const { vi } = await import("vitest");
  const { sha256 } = await import("@sciretriever/contracts");
  const { SqliteDocumentStorage } = await import("../src/document/storage.js");
  const e = await coreProcessingFixture();
  try {
    const image = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6Pp0AAAAASUVORK5CYII=",
      "base64",
    );
    e.setText("# Figure\n\n![Fixture](images/fixture.png)\n");
    e.setResources([
      {
        reference: "images/fixture.png",
        content: {
          artifact: {
            sha256: await sha256(image),
            byte_size: image.length,
            media_type: "image/png",
          },
          bytes: image,
        },
      },
    ]);
    await e.app.documentProcessing.parseDocuments(e.rawParseRequest);
    const proofread = await e.app.proofreading!.build({
      asset_id: e.asset.asset_id,
    });
    const publication = await e.app.proofreadDocuments.publish({
      literature_id: e.rawParseRequest.literature_id,
      asset_id: e.asset.asset_id,
      proofread_id: proofread.version.proofread_id,
      expected_default_revision: null,
    });
    const snapshot = (await e.app.database.documentVersion(
      publication.document.document_version_id,
    ))!;
    const row = await e.app.database.proofread<{ manifest_size: number }>(
      "get",
      proofread.version.proofread_id,
    );
    const resources = await e.app.database.proofread<
      { kind: string; artifact_reference: string }[]
    >("resources", proofread.version.proofread_id);
    const spy = vi.spyOn(e.app.files, "withVerified");
    try {
      const storage = new SqliteDocumentStorage(e.app.database, e.app.files);
      let charged = 0;
      await storage.withVerifiedDocument(
        snapshot.version.document_version_id,
        async () => {},
        undefined,
        (n) => {
          charged += n;
        },
      );
      const paths = spy.mock.calls.map((args) => args[0]);
      expect(paths).not.toContain(
        resources.find((r) => r.kind === "drafts")!.artifact_reference,
      );
      expect(
        paths.filter(
          (path) =>
            path ===
            resources.find((r) => r.kind === "image")!.artifact_reference,
        ),
      ).toHaveLength(1);
      expect(charged).toBe(
        snapshot.version.source_material_ref.byte_size +
          snapshot.version.markdown.byte_size +
          snapshot.version.structure.byte_size +
          snapshot.version.resources.reduce(
            (n, r) => n + r.artifact.byte_size,
            0,
          ) +
          row.manifest_size +
          proofread.version.blocks.byte_size,
      );
      let remaining = charged - proofread.version.blocks.byte_size;
      await expect(
        storage.withVerifiedDocument(
          snapshot.version.document_version_id,
          async () => {},
          undefined,
          (n) => {
            remaining -= n;
            if (remaining < 0) throw new Error("synthetic verification budget");
          },
        ),
      ).rejects.toThrow("synthetic verification budget");
    } finally {
      spy.mockRestore();
    }
  } finally {
    await e.close();
  }
});

it("reuses an identical corrected representation across proofreading method revisions while retaining the published source binding", async () => {
  const { proofreadIdentity } = await import("@sciretriever/contracts");
  const { SqliteProofreadStorage } = await import(
    "../src/storage/proofread.js"
  );
  const e = await coreProcessingFixture();
  try {
    await e.app.documentProcessing.parseDocuments(e.rawParseRequest);
    const first = await e.app.proofreading!.build({
      asset_id: e.asset.asset_id,
    });
    const request = {
      literature_id: e.rawParseRequest.literature_id,
      asset_id: e.asset.asset_id,
      proofread_id: first.version.proofread_id,
      expected_default_revision: null,
    };
    const published = await e.app.proofreadDocuments.publish(request);
    const storage = new SqliteProofreadStorage(e.app.database, e.app.files),
      output = await storage.load(first.version.proofread_id);
    const {
      proofread_id: _id,
      content_sha256: _hash,
      ...base
    } = output.version;
    void _id;
    void _hash;
    const input = {
      ...base,
      method: { ...base.method, clean: "synthetic-equivalent-method" },
    };
    const version = { ...input, ...(await proofreadIdentity(input)) };
    expect(version.proofread_id).not.toBe(first.version.proofread_id);
    expect(version.content_sha256).toBe(first.version.content_sha256);
    await storage.publish({ ...output, version }, 0);
    const again = await e.app.proofreadDocuments.publish({
      ...request,
      proofread_id: version.proofread_id,
      expected_default_revision: 1,
    });
    expect(again).toMatchObject({
      published: false,
      default_updated: true,
      default_revision: 1,
      index_status: "unchanged",
      document: published.document,
    });
    expect(
      (await e.app.archive.status(e.rawParseRequest.literature_id)).parts[0],
    ).toMatchObject({
      proofread_id: version.proofread_id,
      document_version_id: published.document.document_version_id,
    });
    e.setText("A genuinely changed corrected body.");
    await e.app.documentProcessing.parseDocuments({
      ...e.rawParseRequest,
      force: true,
    });
    await e.app.proofreading!.build({ asset_id: e.asset.asset_id });
    expect(
      (await e.app.archive.status(e.rawParseRequest.literature_id)).parts[0]!
        .document_version_id,
    ).toBeNull();
  } finally {
    await e.close();
  }
});
