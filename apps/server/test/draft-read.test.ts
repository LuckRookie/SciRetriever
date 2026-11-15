import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { expect, it, vi } from "vitest";
import {
  canonicalJsonBytes,
  DRAFT_ROLE_COVERAGE_NOTE,
  parseDeviceConnectionCode,
  parseDocumentDraftDifferencesRequest,
  parseDocumentDraftDifferencesResult,
  parseDocumentReadRequest,
  parseDocumentReadResult,
  parseDraftContent,
  sha256,
  type DevicePurpose,
  type DocumentReadOperation,
  type DocumentReadRequestMap,
} from "@sciretriever/contracts";
import { coreProcessingFixture } from "./core-processing-fixture.js";
import { imageBytes } from "./archive-text-fixture.js";
import { DocumentReadService } from "../src/document/read.js";
import { SqliteDocumentStorage } from "../src/document/storage.js";
import { createQueryApplication } from "../src/bootstrap/application.js";
import { deviceBusinessRoutes } from "../src/bootstrap/device-routes.js";
import { runCli } from "../src/cli/main.js";
import { createMcpServer } from "../src/mcp/server.js";
import { SdkTransportAdapter } from "../src/mcp/transport.js";
import { startWorkbenchHttp } from "../src/workbench/http.js";
import { ProductionWorkbenchSession } from "../src/workbench/production-session.js";
import {
  workbenchLogin,
  workbenchTestAccess,
} from "./workbench-auth-fixture.js";

const source =
  "# Synthetic draft\n\nA synthetic value 50 is measured.\n\nA stable finding.\n\n![Synthetic image](images/draft.png)\n";
async function fixture(differs = true) {
  const f = await coreProcessingFixture({
    offline: true,
    textLayer: (text) => (differs ? text.replace("50", "60") : text),
  });
  try {
    f.setText(source);
    f.setResources([
      {
        reference: "images/draft.png",
        content: {
          bytes: imageBytes,
          artifact: {
            sha256: await sha256(imageBytes),
            byte_size: imageBytes.length,
            media_type: "image/png",
          },
        },
      },
    ]);
    const receipt = await f.app.documentProcessing.parseDocuments({
      ...f.rawParseRequest,
      profiles: ["vlm-engine"],
    });
    expect(receipt.draft).toMatchObject({ status: "formed" });
    if (receipt.draft.status !== "formed")
      throw new Error("Synthetic draft not formed");
    const id = receipt.draft.document_version_id;
    const snapshot = (await f.app.database.documentVersion(id))!;
    if (snapshot.version.schema_version !== 3)
      throw new Error("Synthetic draft required");
    const contentPath = join(
      f.app.files.root,
      snapshot.draft_content_artifact_path!,
    );
    const content = parseDraftContent(
      JSON.parse(await readFile(contentPath, "utf8")),
    );
    return {
      ...f,
      get app() {
        return f.app;
      },
      get parseCalls() {
        return f.parseCalls;
      },
      get modelCalls() {
        return f.modelCalls;
      },
      id,
      snapshot: { ...snapshot, version: snapshot.version },
      contentPath,
      content,
    };
  } catch (error) {
    await f.close();
    throw error;
  }
}

function checked<K extends DocumentReadOperation>(
  kind: K,
  result: unknown,
  request: unknown,
) {
  return parseDocumentReadResult(
    kind,
    result,
    parseDocumentReadRequest(kind, request),
  );
}

it("reads the known draft, three bases, roles, images and evidence without invoking parse, pages, publication or models", async () => {
  const f = await fixture();
  const reader = f.app.documentRead;
  const parseCalls = f.parseCalls,
    modelCalls = f.modelCalls;
  const pages = vi
    .spyOn(f.app.archiveText!.pdf, "inspect")
    .mockRejectedValue(new Error("Synthetic page tools unavailable"));
  const publish = vi.spyOn(f.app.draftDocuments, "publish");
  const raw = vi
    .spyOn(f.app.rawParseStorage!, "loadSource")
    .mockRejectedValue(new Error("Raw blocks forbidden while reading"));
  try {
    const describeRequest = { document_version_id: f.id };
    const described = checked(
      "describe",
      await reader.describe(describeRequest),
      describeRequest,
    );
    expect(described).toMatchObject({
      text_level: "draft",
      draft_summary: {
        differs_segments: 1,
        differences: 1,
        image_only_pages: 0,
      },
    });
    const outlineRequest = { ...describeRequest, limit: 200, cursor: null };
    const outline = checked(
      "outline",
      await reader.outline(outlineRequest),
      outlineRequest,
    );
    expect(outline.text_level).toBe("draft");
    expect(outline.sections).toEqual([
      expect.objectContaining({
        title: "Synthetic draft",
        role: null,
        role_source: null,
      }),
    ]);
    const segmentsRequest = { ...outlineRequest, section_id: null };
    const segments = checked(
      "segments",
      await reader.segments(segmentsRequest),
      segmentsRequest,
    );
    expect(segments.text_level).toBe("draft");
    expect(segments.segments.map((s) => s.basis)).toEqual([
      "text-layer-match",
      "text-layer-differs",
      "text-layer-match",
      "no-text-layer",
    ]);
    expect(segments.segments.every((s) => s.page === 1)).toBe(true);
    const roleSegments = [];
    let cursor: string | null = null;
    do {
      const request: DocumentReadRequestMap["segments"] = {
        ...segmentsRequest,
        section_id: outline.sections[0]!.section_id,
        roles: ["references"],
        limit: 1,
        cursor,
      };
      const page = checked("segments", await reader.segments(request), request);
      expect(page.coverage_note).toBe(DRAFT_ROLE_COVERAGE_NOTE);
      roleSegments.push(...page.segments);
      cursor = page.next_cursor;
    } while (cursor);
    expect(roleSegments).toEqual(segments.segments);
    const textSegment = segments.segments[1]!;
    const sliceRequest = {
      document_version_id: f.id,
      selector: { kind: "segment", segment_id: textSegment.segment_id },
      max_bytes: 65536,
      continuation: null,
    };
    const slice = checked(
      "slice",
      await reader.slice(sliceRequest),
      sliceRequest,
    );
    expect(slice).toMatchObject({
      text_level: "draft",
      text: "A synthetic value 50 is measured.",
      locations: [
        expect.objectContaining({ page: 1, basis: "text-layer-differs" }),
      ],
    });
    expect(slice.evidence).toHaveLength(1);
    const evidenceRequest = {
      evidence: slice.evidence[0]!,
      max_bytes: 65536,
      continuation: null,
    };
    const resolved = checked(
      "evidence",
      await reader.resolveEvidence(evidenceRequest),
      evidenceRequest,
    );
    expect(resolved).toMatchObject({
      text: slice.text,
      text_level: "draft",
      location: { basis: "text-layer-differs", page: 1 },
    });
    const resources = checked(
      "resources",
      await reader.resources(outlineRequest),
      outlineRequest,
    );
    expect(resources.text_level).toBe("draft");
    expect(resources.resources).toHaveLength(1);
    const resourceId = resources.resources[0]!.resource_id;
    const resourceRequest = {
      document_version_id: f.id,
      resource_id: resourceId,
      max_bytes: 65536,
      continuation: null,
    };
    const resource = checked(
      "resource",
      await reader.resource(resourceRequest),
      resourceRequest,
    );
    expect(resource.text_level).toBe("draft");
    expect(Buffer.from(resource.bytes_base64!, "base64")).toEqual(
      Buffer.from(imageBytes),
    );
    const streamed = await reader.withResourceBytes(
      { document_version_id: f.id, resource_id: resourceId },
      async (_v, _r, chunks) => {
        const parts = [];
        for await (const chunk of chunks) parts.push(Buffer.from(chunk));
        return Buffer.concat(parts);
      },
    );
    expect(streamed).toEqual(Buffer.from(imageBytes));
    expect(f.parseCalls).toBe(parseCalls);
    expect(f.modelCalls).toBe(modelCalls);
    expect(pages).not.toHaveBeenCalled();
    expect(raw).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks();
    await f.close();
  }
}, 30_000);

it("keeps grades and evidence bound to fixed non-default versions while the internal corrected-only port stays closed", async () => {
  const f = await fixture(false);
  try {
    const segment = (
      await f.app.documentRead.segments({
        document_version_id: f.id,
        section_id: null,
        limit: 200,
        cursor: null,
      })
    ).segments[1]!;
    const selected = {
      document_version_id: f.id,
      selector: { kind: "segment", segment_id: segment.segment_id },
      max_bytes: 65536,
      continuation: null,
    };
    const evidence = (await f.app.documentRead.slice(selected)).evidence[0]!;
    const proofread = await f.app.proofreading!.build({
      asset_id: f.asset.asset_id,
    });
    expect(proofread.version).toMatchObject({ status: "complete" });
    const published = await f.app.proofreadDocuments.publish({
      literature_id: f.parseRequest.literature_id,
      asset_id: f.asset.asset_id,
      proofread_id: proofread.version.proofread_id,
      expected_default_revision: 1,
    });
    expect(published.default_updated).toBe(true);
    const current = await f.app.documentRead.default({
      literature_id: f.parseRequest.literature_id,
      asset_id: f.asset.asset_id,
      asset_sha256: f.asset.sha256,
    });
    expect(current.default!.document_version_id).toBe(
      published.document.document_version_id,
    );
    const request = {
      document_version_id: published.document.document_version_id,
    };
    expect(
      checked("describe", await f.app.documentRead.describe(request), request),
    ).toMatchObject({ text_level: "proofread" });
    expect(await f.app.documentRead.describe(request)).not.toHaveProperty(
      "draft_summary",
    );
    const proofreadSegments = await f.app.documentRead.segments({
      ...request,
      section_id: null,
      limit: 200,
      cursor: null,
    });
    expect(proofreadSegments.text_level).toBe("proofread");
    expect(
      proofreadSegments.segments.every(
        (s) =>
          "basis" in s &&
          ["text-layer", "image-only", "manual"].includes(s.basis),
      ),
    ).toBe(true);
    expect(
      await f.app.documentRead.describe({ document_version_id: f.id }),
    ).toMatchObject({ text_level: "draft" });
    expect(
      await f.app.documentRead.resolveEvidence({
        evidence,
        max_bytes: 65536,
        continuation: null,
      }),
    ).toMatchObject({
      text_level: "draft",
      text: "A synthetic value 50 is measured.",
      document: { document_version_id: f.id },
    });
    await expect(
      f.app.documentRead.draftDifferences({
        ...request,
        segment_id: segment.segment_id,
        max_bytes: 65536,
        continuation: null,
      }),
    ).rejects.toMatchObject({ code: "document-unsupported" });
    await expect(
      f.app.documentRead.corrections({
        document_version_id: f.id,
        segment_id: segment.segment_id,
        max_bytes: 65536,
        continuation: null,
      }),
    ).rejects.toMatchObject({ code: "document-unsupported" });
    const consume = vi.fn(async () => "not-called");
    await expect(
      f.app.documentRead.withReadScope(async () => {
        await f.app.documentRead.describe({ document_version_id: f.id });
        return f.app.documentRead.withVerifiedVersion(f.id, consume);
      }),
    ).rejects.toMatchObject({ code: "document-unsupported" });
    expect(consume).not.toHaveBeenCalled();
    f.setText(
      source
        .replace("Synthetic draft", "Replacement draft")
        .replace("50", "55"),
    );
    const next = await f.app.documentProcessing.parseDocuments({
      ...f.rawParseRequest,
      profiles: ["vlm-engine"],
      force: true,
    });
    expect(next.draft).toMatchObject({
      status: "formed",
      default_text_level: "draft",
    });
    expect(await f.app.documentRead.describe(request)).toMatchObject({
      text_level: "proofread",
    });
    const oldText = proofreadSegments.segments.find((s) => s.kind === "text")!;
    expect(
      await f.app.documentRead.slice({
        ...request,
        selector: { kind: "segment", segment_id: oldText.segment_id },
        max_bytes: 65536,
        continuation: null,
      }),
    ).toMatchObject({
      text_level: "proofread",
      text: "A synthetic value 50 is measured.\n\n",
    });
  } finally {
    await f.close();
  }
}, 30_000);

it("reads the saved canonical differences losslessly with bounded UTF-8 pages and rejects cross-selector/version cursors", async () => {
  const f = await fixture();
  try {
    const reader = f.app.documentRead;
    const segments = (
      await reader.segments({
        document_version_id: f.id,
        section_id: null,
        limit: 200,
        cursor: null,
      })
    ).segments;
    const selected = {
      document_version_id: f.id,
      segment_id: segments[1]!.segment_id,
      max_bytes: 65536,
      continuation: null,
    };
    const full = parseDocumentDraftDifferencesResult(
      await reader.draftDifferences(selected),
      parseDocumentDraftDifferencesRequest(selected),
    );
    expect(full).toMatchObject({
      text_level: "draft",
      basis: "text-layer-differs",
      location: { page: 1, basis: "text-layer-differs" },
    });
    expect(JSON.parse(full.text)).toEqual([
      {
        leaf_id: selected.segment_id,
        page_index: 0,
        kind: "mismatch",
        parsed: "50",
        text_layer: "60",
        other_page_index: null,
      },
    ]);
    expect(Buffer.from(full.text)).toEqual(
      Buffer.from(
        canonicalJsonBytes(f.content.leaves.flatMap((l) => l.differences)),
      ),
    );
    let continuation: string | null = null,
      text = "",
      start = 0;
    do {
      const request = { ...selected, max_bytes: 7, continuation };
      const result = parseDocumentDraftDifferencesResult(
        await reader.draftDifferences(request),
        request,
      );
      expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(7);
      expect(result.actual_range.start_utf8).toBe(start);
      text += result.text;
      start = result.actual_range.end_utf8;
      continuation = result.continuation;
    } while (continuation);
    expect(text).toBe(full.text);
    const first = await reader.draftDifferences({ ...selected, max_bytes: 7 });
    await expect(
      reader.draftDifferences({
        ...selected,
        segment_id: segments[0]!.segment_id,
        continuation: first.continuation,
      }),
    ).rejects.toMatchObject({ code: "document-invalid" });
    const slice = await reader.slice({
      document_version_id: f.id,
      selector: { kind: "segment", segment_id: selected.segment_id },
      max_bytes: 7,
      continuation: null,
    });
    await expect(
      reader.draftDifferences({
        ...selected,
        continuation: slice.continuation,
      }),
    ).rejects.toMatchObject({ code: "document-invalid" });
    const cursor = JSON.parse(
      Buffer.from(first.continuation!, "base64url").toString(),
    );
    cursor.next++;
    await expect(
      reader.draftDifferences({
        ...selected,
        continuation: Buffer.from(JSON.stringify(cursor)).toString("base64url"),
      }),
    ).rejects.toMatchObject({ code: "document-invalid" });
    expect(
      await reader.draftDifferences({
        ...selected,
        segment_id: segments[0]!.segment_id,
      }),
    ).toMatchObject({ text: "[]", total_bytes: 2, continuation: null });
    await expect(
      reader.draftDifferences({ ...selected, segment_id: "absent" }),
    ).rejects.toMatchObject({ code: "document-invalid" });
    for (const max_bytes of [0, 65537])
      await expect(
        reader.draftDifferences({ ...selected, max_bytes }),
      ).rejects.toMatchObject({ code: "document-invalid" });
    f.setText(source.replace("50", "55"));
    const next = await f.app.documentProcessing.parseDocuments({
      ...f.rawParseRequest,
      profiles: ["vlm-engine"],
      force: true,
    });
    if (next.draft.status !== "formed")
      throw new Error("Second synthetic draft missing");
    const nextSegment = (
      await reader.segments({
        document_version_id: next.draft.document_version_id,
        section_id: null,
        limit: 200,
        cursor: null,
      })
    ).segments[1]!;
    await expect(
      reader.draftDifferences({
        ...selected,
        document_version_id: next.draft.document_version_id,
        segment_id: nextSegment.segment_id,
        continuation: first.continuation,
      }),
    ).rejects.toMatchObject({ code: "document-invalid" });
  } finally {
    await f.close();
  }
}, 30_000);

/** Two accepted PDF pages; the parser and page inspections remain synthetic ports. */
function twoPagePdf() {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R >>",
    "",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>",
    "",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  for (const [index, text] of [
    [3, "first clause value"],
    [5, "last clause value"],
  ] as const) {
    const stream = `BT /F1 12 Tf 40 740 Td (${text}) Tj ET`;
    objects[index] =
      `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`;
  }
  let body = "%PDF-1.4\n";
  const offsets = objects.map((object, i) => {
    const offset = Buffer.byteLength(body);
    body += `${i + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = Buffer.byteLength(body);
  return Buffer.from(
    body +
      `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
      offsets
        .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
        .join("") +
      `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`,
  );
}
it("organizes merged multi-page leaf differences in saved order and never splits a Unicode character", async () => {
  const f = await coreProcessingFixture({
    offline: true,
    sourcePdf: twoPagePdf(),
    pageCount: 2,
    pageText: (page) =>
      page === 0
        ? "first clause value αβ continues"
        : "last clause value γδ ends.",
  });
  try {
    f.setText("first clause value ζη continues last clause value θλ ends.");
    const receipt = await f.app.documentProcessing.parseDocuments({
      ...f.rawParseRequest,
      profiles: ["vlm-engine"],
    });
    expect(receipt.draft).toMatchObject({ status: "formed" });
    if (receipt.draft.status !== "formed")
      throw new Error("Merged synthetic draft missing");
    const id = receipt.draft.document_version_id;
    const segments = await f.app.documentRead.segments({
      document_version_id: id,
      section_id: null,
      limit: 200,
      cursor: null,
    });
    expect(segments.segments).toHaveLength(1);
    expect(segments.segments[0]).toMatchObject({
      page: 1,
      continuation_regions: [expect.objectContaining({ page: 2 })],
      basis: "text-layer-differs",
    });
    const request = {
      document_version_id: id,
      segment_id: segments.segments[0]!.segment_id,
      max_bytes: 65536,
      continuation: null,
    };
    const whole = await f.app.documentRead.draftDifferences(request);
    const differences = JSON.parse(whole.text);
    expect(
      differences.map((d: { page_index: number }) => d.page_index),
    ).toEqual([0, 1]);
    expect(differences.map((d: { parsed: string }) => d.parsed)).toEqual([
      "αβ",
      "γδ",
    ]);
    let continuation: string | null = null,
      text = "";
    do {
      const result = await f.app.documentRead.draftDifferences({
        ...request,
        max_bytes: 5,
        continuation,
      });
      expect(result.text).not.toContain("\ufffd");
      expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(5);
      text += result.text;
      continuation = result.continuation;
    } while (continuation);
    expect(text).toBe(whole.text);
  } finally {
    await f.close();
  }
}, 30_000);

it("counts draft content in cold and warm verification budgets, invalidates content fingerprints and rechecks delivered images", async () => {
  const f = await fixture();
  const storage = new SqliteDocumentStorage(f.app.database, f.app.files);
  const reader = new DocumentReadService(f.app.database, storage);
  try {
    const v = f.snapshot.version;
    const expectedBytes =
      v.source_material_ref.byte_size +
      v.markdown.byte_size +
      v.structure.byte_size +
      v.draft_content.byte_size +
      v.resources.reduce((sum, r) => sum + r.artifact.byte_size, 0);
    for (let n = 0; n < 2; n++) {
      let bytes = 0;
      await reader.withReadScope(
        () => reader.describe({ document_version_id: f.id }),
        (size) => {
          bytes += size;
        },
      );
      expect(bytes).toBe(expectedBytes);
    }
    await expect(
      reader.withReadScope(
        () => reader.describe({ document_version_id: f.id }),
        (size) => {
          if (size > 0) throw new Error("Synthetic read budget exceeded");
        },
      ),
    ).rejects.toMatchObject({ code: "document-integrity" });
    const imagePath = join(
      f.app.files.root,
      Object.values(f.snapshot.resource_artifact_paths)[0]!,
    );
    const savedImage = await readFile(imagePath);
    await reader.withReadScope(async () => {
      await reader.describe({ document_version_id: f.id });
      const corrupt = Buffer.from(savedImage);
      corrupt[corrupt.length - 1] = corrupt[corrupt.length - 1]! ^ 1;
      await writeFile(imagePath, corrupt);
      // The operation-local proof is already warm; delivered bytes still pass their own hash check.
      await expect(
        reader.withResourceBytes(
          {
            document_version_id: f.id,
            resource_id: v.resources[0]!.resource_id,
          },
          async (_v, _r, chunks) => {
            for await (const chunk of chunks) void chunk;
          },
        ),
      ).rejects.toMatchObject({ code: "document-integrity" });
    });
    await writeFile(imagePath, savedImage);
    await reader.describe({ document_version_id: f.id });
    const content = await readFile(f.contentPath);
    content[content.length - 2] = content[content.length - 2]! ^ 1;
    await writeFile(f.contentPath, content);
    await expect(
      reader.describe({ document_version_id: f.id }),
    ).rejects.toMatchObject({ code: "document-integrity" });
    await expect(
      reader.draftDifferences({
        document_version_id: f.id,
        segment_id: f.content.leaves[1]!.leaf_id,
        max_bytes: 65536,
        continuation: null,
      }),
    ).rejects.toMatchObject({ code: "document-integrity" });
  } finally {
    await reader.close();
    await f.close();
  }
}, 30_000);

async function* stdin(value: unknown) {
  yield Buffer.from(JSON.stringify(value));
}
it("returns identical draft differences through Web, CLI and MCP, while refusing direct device queries and non-read MCP purposes", async () => {
  const f = await fixture();
  const query = await createQueryApplication(f.home);
  const screen = new ProductionWorkbenchSession(null, undefined);
  const http = await startWorkbenchHttp({
    session: screen,
    access: workbenchTestAccess,
    assets: new Map([["/", { contentType: "text/html", body: "synthetic" }]]),
    query: { application: query },
    devices: {
      service: f.app.deviceConnections,
      routes: deviceBusinessRoutes(f.app, query),
    },
  });
  const host = createMcpServer({
    home: f.home,
    sharedApplications: true,
    applicationFactory: async () => f.app,
    queryFactory: async () => query,
  });
  const [serverTransport, clientTransport] =
    InMemoryTransport.createLinkedPair();
  const local = new Client({ name: "synthetic-draft-stdio", version: "1" });
  const remote = new Client({ name: "synthetic-draft-http", version: "1" });
  const operator = new Client({
    name: "synthetic-draft-operator",
    version: "1",
  });
  remote.onerror = () => {};
  operator.onerror = () => {};
  try {
    const request = {
      document_version_id: f.id,
      segment_id: f.content.leaves[1]!.leaf_id,
      max_bytes: 17,
      continuation: null,
    };
    const expected = await f.app.documentRead.draftDifferences(request);
    const cli = await runCli(
      ["document", "draft-differences", "--request", "-", "--json"],
      { home: f.home, stdin: stdin(request) },
    );
    expect(cli.code).toBe(0);
    expect(cli.value).toEqual({ protocol_version: 1, result: expected });
    await host.connect(serverTransport);
    await local.connect(clientTransport);
    const args = { operation: "draft-differences", request };
    const stdio = await local.callTool({
      name: "document_read",
      arguments: args,
    });
    expect(stdio.isError).not.toBe(true);
    expect(stdio.structuredContent).toEqual(cli.value);
    const cookie = await workbenchLogin(http.origin);
    const home = await fetch(http.origin, { headers: { Cookie: cookie } });
    const cookies = `${cookie}; ${home.headers.get("set-cookie")!.split(";")[0]!}`;
    const created = await fetch(http.origin + "/api/clients", {
      method: "POST",
      headers: {
        Cookie: cookies,
        Origin: http.origin,
        "Content-Type": "application/json",
        "X-Workbench-Init": "1",
      },
      body: "{}",
    });
    const client = (await created.json()) as {
      client_id: string;
      csrf: string;
    };
    const path = "/api/v1/query/document-draft-differences";
    const web = await fetch(
      `${http.origin}${path}?client_id=${client.client_id}`,
      {
        method: "POST",
        headers: {
          Cookie: cookies,
          Origin: http.origin,
          "Content-Type": "application/json",
          "X-Workbench-CSRF": client.csrf,
        },
        body: JSON.stringify({ protocol_version: 1, request }),
      },
    );
    expect(web.status).toBe(200);
    expect(await web.json()).toEqual(cli.value);
    const pair = async (purposes: DevicePurpose[]) => {
      const code = await f.app.deviceConnections.create({
        address: http.origin,
        name: "Synthetic draft device",
        purposes,
      });
      return f.app.deviceConnections.exchange(
        {
          pairing_code: parseDeviceConnectionCode(code.connection_code)
            .pairing_code,
        },
        "synthetic-peer",
      );
    };
    const read = await pair(["read"]);
    const post = (secret?: string, suffix = path, input: unknown = request) =>
      fetch(http.origin + suffix, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
        },
        body: JSON.stringify({ protocol_version: 1, request: input }),
      });
    const device = await post(read.token);
    expect(device.status).toBe(403);
    expect(await device.json()).toMatchObject({
      code: "device-purpose-forbidden",
    });
    const operate = await pair(["operate"]);
    const intake = await pair(["intake"]);
    for (const paired of [operate, intake]) {
      const forbidden = await post(paired.token);
      expect(forbidden.status).toBe(403);
      expect(await forbidden.json()).toMatchObject({
        code: "device-purpose-forbidden",
      });
    }
    expect((await post()).status).toBe(401);
    expect(
      (
        await post(read.token, "/api/v1/query/document-describe", {
          document_version_id: f.id,
        })
      ).status,
    ).toBe(403);
    const invalid = await fetch(
      `${http.origin}${path}?client_id=${client.client_id}`,
      {
        method: "POST",
        headers: {
          Cookie: cookies,
          Origin: http.origin,
          "Content-Type": "application/json",
          "X-Workbench-CSRF": client.csrf,
        },
        body: JSON.stringify({
          protocol_version: 1,
          request: { ...request, max_bytes: 65537 },
        }),
      },
    );
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ code: "document-invalid" });
    const transport = new StreamableHTTPClientTransport(
      new URL("/mcp", http.origin),
      { requestInit: { headers: { Authorization: `Bearer ${read.token}` } } },
    );
    await remote.connect(new SdkTransportAdapter(transport));
    const rpc = await remote.callTool({
      name: "document_read",
      arguments: args,
    });
    expect(rpc.isError).not.toBe(true);
    expect(rpc.structuredContent).toEqual(cli.value);
    const operatorTransport = new StreamableHTTPClientTransport(
      new URL("/mcp", http.origin),
      {
        requestInit: { headers: { Authorization: `Bearer ${operate.token}` } },
      },
    );
    await operator.connect(new SdkTransportAdapter(operatorTransport));
    expect(
      (await operator.listTools()).tools.some(
        (tool) => tool.name === "document_read",
      ),
    ).toBe(false);
    const denied = await operator.callTool({
      name: "document_read",
      arguments: args,
    });
    expect(denied.isError).toBe(true);
    expect(denied.structuredContent).toMatchObject({
      result: { failure: { code: "device-purpose-forbidden" } },
    });
    const intakeCall = await fetch(http.origin + "/mcp", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${intake.token}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "document_read", arguments: args },
      }),
    });
    expect(intakeCall.status).toBe(403);
    expect(await intakeCall.json()).toMatchObject({
      code: "device-purpose-forbidden",
    });
    expect(f.modelCalls).toBe(0);
    expect(f.parseCalls).toBe(1);
  } finally {
    await operator.close();
    await remote.close();
    await local.close();
    await host.close();
    await http.close();
    await screen.close();
    await query.close();
    await f.close();
  }
}, 60_000);
