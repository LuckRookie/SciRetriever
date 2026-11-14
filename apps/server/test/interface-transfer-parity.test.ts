import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { parseLiterature } from "@sciretriever/contracts";
import { describe, expect, it, vi } from "vitest";
import { createMcpServer } from "../src/mcp/server.js";
import { PdfUploads } from "../src/mcp/pdf-upload.js";
import { readLibraryArtifact } from "../src/entry/library-transfer.js";
import { runCli } from "../src/cli/main.js";
import { createQueryApplication } from "../src/bootstrap/application.js";
import { startQueryOnlyHttp } from "../src/workbench/http.js";
import {
  FIXTURE_LITERATURE,
  workbenchPdf,
} from "../src/workbench/synthetic-fixture.js";
import { coreProcessingFixture } from "./core-processing-fixture.js";

async function connect(host: ReturnType<typeof createMcpServer>) {
  const [server, transport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "transfer-parity", version: "1" });
  await host.connect(server);
  await client.connect(transport);
  return client;
}
const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
async function* input(value: unknown) {
  yield Buffer.from(JSON.stringify(value));
}

describe("bounded machine material transfer", () => {
  it("publishes MCP chunks through the shared PDF owner and reads identical bytes and bibliography via CLI/Web", async () => {
    const env = await coreProcessingFixture();
    const literature = parseLiterature({
      ...FIXTURE_LITERATURE,
      literature_id: "00000000-0000-0000-0000-000000000081",
      meta_literature_id: "00000000-0000-0000-0000-000000000082",
      metadata: {
        ...FIXTURE_LITERATURE.metadata,
        identifiers: [{ namespace: "doi", value: "10.5555/transfer-parity" }],
      },
    });
    await env.app.database.putLiterature(literature);
    const bytes = Buffer.from(workbenchPdf("10.5555/transfer-parity"));
    const host = createMcpServer({
      maintenance: true,
      home: env.home,
      applicationFactory: async () => env.app,
    });
    const client = await connect(host);
    const query = await createQueryApplication(env.home);
    const web = await startQueryOnlyHttp({ application: query });
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      return (result.structuredContent as { result: Record<string, unknown> })
        .result;
    };
    try {
      const descriptor = {
        literature_id: literature.literature_id,
        sha256: hash(bytes),
        byte_size: bytes.length,
      };
      const { upload_id } = await call("begin_pdf_upload", descriptor);
      const first = {
        upload_id,
        offset: 0,
        bytes_base64: bytes.subarray(0, 200).toString("base64"),
      };
      await call("append_pdf_upload", first);
      expect(await call("append_pdf_upload", first)).toEqual({
        received_bytes: 200,
      });
      expect(
        (
          await client.callTool({
            name: "commit_pdf_upload",
            arguments: { upload_id },
          })
        ).isError,
      ).toBe(true);
      expect(
        (await env.app.library.detail(literature.literature_id)).primary_pdf,
      ).toBeNull();
      await call("append_pdf_upload", {
        upload_id,
        offset: 200,
        bytes_base64: bytes.subarray(200).toString("base64"),
      });
      await call("commit_pdf_upload", { upload_id });
      const detail = await env.app.library.detail(literature.literature_id);
      expect(detail.primary_pdf?.asset.sha256).toBe(descriptor.sha256);
      expect(detail.primary_pdf?.article_identity_status).toBe("unverified");
      expect(
        (
          await client.callTool({
            name: "commit_pdf_upload",
            arguments: { upload_id },
          })
        ).isError,
      ).toBe(true);
      const request = {
        literature_id: literature.literature_id,
        kind: "primary-pdf",
        expected_sha256: null,
        offset: 0,
        max_bytes: 200,
      };
      const chunk = await call("read_artifact_chunk", request);
      expect(Buffer.from(chunk.bytes_base64 as string, "base64")).toEqual(
        bytes.subarray(0, 200),
      );
      expect(chunk).toMatchObject({
        sha256: descriptor.sha256,
        next_offset: 200,
        byte_size: bytes.length,
      });
      const chunks = [Buffer.from(chunk.bytes_base64 as string, "base64")];
      let offset = 200;
      while (offset < bytes.length) {
        const cli = await runCli(
          ["literature", "artifact-chunk", "--request", "-"],
          {
            home: env.home,
            stdin: input({
              ...request,
              expected_sha256: descriptor.sha256,
              offset,
            }),
          },
        );
        expect(cli.code).toBe(0);
        const part = (
          cli.value as {
            result: { bytes_base64: string; next_offset: number | null };
          }
        ).result;
        chunks.push(Buffer.from(part.bytes_base64, "base64"));
        offset = part.next_offset ?? bytes.length;
      }
      expect(Buffer.concat(chunks)).toEqual(bytes);
      const refusal = await client.callTool({
        name: "read_artifact_chunk",
        arguments: { ...request, expected_sha256: "0".repeat(64) },
      });
      expect(refusal.structuredContent).toMatchObject({
        result: { failure: { code: "artifact-changed" } },
      });
      const path = join(env.home, "export.pdf");
      expect(
        (
          await runCli(
            ["export", "pdf", literature.literature_id, "--path", path],
            { home: env.home },
          )
        ).code,
      ).toBe(0);
      expect(await readFile(path)).toEqual(bytes);
      const response = await fetch(web.origin + "/api/v1/query/read", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          protocol_version: 1,
          request: { literature_id: literature.literature_id },
        }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        detail: { primary_pdf: { asset: { sha256: descriptor.sha256 } } },
      });
      const raw = await fetch(web.origin + "/api/v1/query/artifact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          protocol_version: 1,
          request: {
            literature_id: literature.literature_id,
            kind: "primary-pdf",
          },
        }),
      });
      expect(raw.status).toBe(200);
      expect(Buffer.from(await raw.arrayBuffer())).toEqual(bytes);
      const bibliography = {
        literature_ids: [literature.literature_id],
        format: "csl-json",
      };
      const mcp = await call("export_bibliography", bibliography);
      const cli = await runCli(
        ["literature", "bibliography", "--request", "-"],
        { home: env.home, stdin: input(bibliography) },
      );
      expect(cli.code).toBe(0);
      expect(cli.value).toEqual({ protocol_version: 1, result: mcp });
      expect(JSON.parse(mcp.text as string)).toHaveLength(1);
      expect(env.parseCalls).toBe(0);
      expect(env.modelCalls).toBe(0);
    } finally {
      await client.close();
      await host.close();
      await web.close();
      await query.close();
      await env.close();
    }
  }, 30000);
  it("refuses paths, unavailable write tools and cross-connection upload handles", async () => {
    const factory = vi.fn();
    const first = createMcpServer({
      maintenance: true,
      applicationFactory: factory,
    });
    const second = createMcpServer({
      maintenance: true,
      applicationFactory: factory,
    });
    const readonly = createMcpServer({ applicationFactory: factory });
    const clients = await Promise.all([first, second, readonly].map(connect));
    try {
      const args = {
        literature_id: FIXTURE_LITERATURE.literature_id,
        sha256: "a".repeat(64),
        byte_size: 4,
      };
      const result = await clients[0]!.callTool({
        name: "begin_pdf_upload",
        arguments: args,
      });
      const { upload_id } = (
        result.structuredContent as { result: { upload_id: string } }
      ).result;
      expect(
        (
          await clients[1]!.callTool({
            name: "append_pdf_upload",
            arguments: { upload_id, offset: 0, bytes_base64: "AAAAAA==" },
          })
        ).isError,
      ).toBe(true);
      expect(
        (
          await clients[0]!.callTool({
            name: "begin_pdf_upload",
            arguments: { ...args, path: "/etc/passwd" },
          })
        ).isError,
      ).toBe(true);
      expect(
        (
          await clients[2]!.callTool({
            name: "begin_pdf_upload",
            arguments: args,
          })
        ).isError,
      ).toBe(true);
      expect(factory).not.toHaveBeenCalled();
    } finally {
      for (const client of clients) await client.close();
      for (const host of [first, second, readonly]) await host.close();
    }
  });
  it("propagates cancellation between catalog lookup and verified byte reading", async () => {
    const env = await coreProcessingFixture();
    const query = await createQueryApplication(env.home);
    const controller = new AbortController();
    const detail = query.query!.detail.bind(query.query);
    const lookup = vi
      .spyOn(query.query!, "detail")
      .mockImplementationOnce(async (id) => {
        const result = await detail(id);
        controller.abort();
        return result;
      });
    try {
      await expect(
        readLibraryArtifact(
          query,
          {
            literature_id: env.parseRequest.literature_id,
            kind: "primary-pdf",
            expected_sha256: null,
            offset: 0,
            max_bytes: 100,
          },
          controller.signal,
        ),
      ).rejects.toMatchObject({ code: "transfer-cancelled" });
      expect(env.parseCalls).toBe(0);
    } finally {
      lookup.mockRestore();
      await query.close();
      await env.close();
    }
  });
  it("bounds spool handles without a file-size ceiling, expires them and refuses a wrong digest before opening the writer", async () => {
    const uploads = new PdfUploads();
    const factory = vi.fn();
    try {
      const large = {
        literature_id: FIXTURE_LITERATURE.literature_id,
        sha256: "a".repeat(64),
        byte_size: 64 * 1024 * 1024,
      };
      uploads.begin(large);
      uploads.begin(large);
      uploads.begin(large);
      uploads.begin(large);
      expect(() => uploads.begin(large)).toThrowError(
        expect.objectContaining({ code: "upload-budget" }),
      );
      const now = vi
        .spyOn(Date, "now")
        .mockReturnValue(Date.now() + 11 * 60 * 1000);
      const upload = uploads.begin({ ...large, byte_size: 4 });
      now.mockRestore();
      uploads.append({
        upload_id: upload.upload_id,
        offset: 0,
        bytes_base64: "AAAAAA==",
      });
      await expect(
        uploads.commit(
          { upload_id: upload.upload_id },
          factory,
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ code: "upload-integrity" });
      expect(factory).not.toHaveBeenCalled();
      uploads.close();
      expect(() =>
        uploads.append({
          upload_id: upload.upload_id,
          offset: 0,
          bytes_base64: "AAAAAA==",
        }),
      ).toThrowError(expect.objectContaining({ code: "upload-unavailable" }));
    } finally {
      vi.restoreAllMocks();
      uploads.close();
    }
  });
});
