import { documentRepresentationHash } from "../src/document/contract.js";
import { expect, it, vi } from "vitest";
import {
  parseArchiveTextStop,
  parseArtifactRef,
} from "@sciretriever/contracts";
import { ArchiveTextError } from "../src/archive/text-source.js";
import { archiveFixture, archiveModel } from "./archive-fixture.js";
import { createQueryApplication } from "../src/bootstrap/application.js";
import { executeQuery } from "../src/entry/query-operations.js";
import { executeMaintenance } from "../src/entry/maintenance-operations.js";
import { SqliteArchiveTextStorage } from "../src/storage/archive-text.js";
import { SqliteDocumentStorage } from "../src/document/storage.js";
import { renderArrangement } from "../src/archive/render.js";
import { startQueryOnlyWorkbench } from "../src/bootstrap/workbench.js";
import { runCli } from "../src/cli/main.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/mcp/server.js";
import { documentIdentity } from "../src/document/proofread-publication.js";

it("arranges a 160-section synthetic document with one request (ADR 0048)", async () => {
  const e = await archiveFixture();
  try {
    e.setText(
      "# Original document\n\n" +
        Array.from(
          { length: 160 },
          (_, i) =>
            `## Section ${i}\n\nParagraph ${i} 中文 α🙂. ${"A reported observation with conditions. ".repeat(3)}\n\n`,
        ).join(""),
    );
    await e.app.documentProcessing.parseDocuments(e.rawParseRequest);
    const calls = e.modelCalls,
      result = await e.app.archiveText!.arrange(e.asset.asset_id, "full"),
      output = (await new SqliteArchiveTextStorage(
        e.app.database,
        e.app.files,
      ).load(result.proofread_id))!;
    expect(output.bundle.arrangement!.leaves).toHaveLength(321);
    // A version arranged by an older workflow or break rule is never reused as this one.
    expect(output.version.method.arrange).toBe(
      "arrangement-operations-v2/arrangement-single-pass-v2/paragraph-break-v3",
    );
    // Every block in one request; no paragraph ends mid-sentence, so no break request.
    expect(result.usage.calls).toBe(1);
    expect(e.modelCalls - calls).toBe(1);
    expect(result.usage).toMatchObject({
      input_tokens: 100,
      output_tokens: 50,
      usage_complete: true,
    });
  } finally {
    await e.close();
  }
}, 30000);

it("publishes the six-step X workflow, excludes dropped text from fixed documents, and gives metadata the whole paper", async () => {
  const e = await archiveFixture();
  let fragments: { fragment_id: string; role: string; text: string }[] = [];
  try {
    e.setText(
      "DROP_HEADER Publisher interface.\n\nBIBLIOGRAPHY DOI: 10.1000/fixture.\n\n# Abstract\n\nFixture Author studies spectroscopy.\n\n# Introduction\n\nRetained synthetic body.\n\n# References\n\n[1] Example synthetic reference.\n",
    );
    e.setModel((input) => {
      if (input.method === "archive-metadata-dsh-v2")
        fragments = input.fragments as typeof fragments;
      return archiveModel(input);
    });
    await e.app.documentProcessing.parseDocuments(e.rawParseRequest);
    const run = await e.submit("v2-production");
    expect(run.failures).toEqual([]);
    const state = await e.app.archive.status(e.id),
      part = state.parts[0]!;
    expect(state.status).toBe("READY");
    expect(part.steps.map((s) => s.step).sort()).toEqual([
      "arrange",
      "metadata",
      "proofread",
      "references",
      "render",
      "tags",
    ]);
    const output = (await new SqliteArchiveTextStorage(
      e.app.database,
      e.app.files,
    ).load(part.proofread_id!))!;
    expect(output.version.schema_version).toBe(2);
    expect(
      output.bundle.leaves.filter((l) => l.destination.kind === "dropped"),
    ).toHaveLength(2);
    // Metadata reads kept and dropped text alike, citing short fragment IDs.
    expect(
      fragments.some(
        (f) =>
          f.role === "dropped:bibliography" && f.text.includes("BIBLIOGRAPHY"),
      ),
    ).toBe(true);
    expect(
      fragments.some(
        (f) => f.role.startsWith("dropped:") && f.text.includes("DROP_HEADER"),
      ),
    ).toBe(true);
    expect(
      fragments.some((f) => f.text.includes("Retained synthetic body.")),
    ).toBe(true);
    expect(fragments.map((f) => f.fragment_id)).toEqual(
      fragments.map((_, i) => `f${i + 1}`),
    );
    await new SqliteDocumentStorage(
      e.app.database,
      e.app.files,
    ).withVerifiedDocument(
      part.document_version_id!,
      async (_v, markdown, structure) => {
        expect(Buffer.from(markdown).toString()).toContain(
          "Retained synthetic body.",
        );
        expect(Buffer.from(markdown).toString()).not.toMatch(
          /DROP_HEADER|BIBLIOGRAPHY/u,
        );
        expect(structure.segments).toHaveLength(
          output.bundle.leaves.filter((l) => l.destination.kind === "assigned")
            .length,
        );
      },
    );
    const events = await e.app.jobs!.listEvents(run.job.job_id, -1, 1000);
    expect(
      events.filter(
        (v) =>
          v.kind === "archive-progress" &&
          (v.payload as { phase: string }).phase === "completed",
      ),
    ).toHaveLength(6);
    expect(
      events.filter(
        (v) =>
          v.kind === "archive-progress" &&
          (v.payload as { phase: string }).phase === "page-accepted",
      ),
    ).toHaveLength(1);
    expect(
      JSON.stringify(events.filter((v) => v.kind === "archive-progress")),
    ).not.toMatch(/DROP_HEADER|BIBLIOGRAPHY/u);
    // Task detail keeps each step's own status; metadata output carries a status of its own.
    const detail = (await e.app.database.review("task-run", {
      job_id: run.job.job_id,
    })) as {
      items: {
        archive?: {
          steps: { step: string; status: string; source_map?: unknown }[];
        };
      }[];
    };
    const steps = detail.items[0]!.archive!.steps;
    expect(Object.fromEntries(steps.map((s) => [s.step, s.status]))).toEqual({
      arrange: "done",
      proofread: "done",
      render: "done",
      metadata: "done",
      references: "done",
      tags: "done",
    });
    expect(steps.some((s) => s.source_map !== undefined)).toBe(false);
  } finally {
    await e.close();
  }
}, 30000);

it("publishes under the part's one document identity and refuses a render whose version did not become the default", async () => {
  // A paper first built by the old flow kept its old default when X used another document ID.
  const e = await archiveFixture();
  try {
    await e.app.documentProcessing.parseDocuments(e.rawParseRequest);
    await e.submit("document-identity");
    const part = (await e.app.archive.status(e.id)).parts[0]!;
    await new SqliteDocumentStorage(
      e.app.database,
      e.app.files,
    ).withVerifiedDocument(part.document_version_id!, async (v) => {
      expect(v.document_id).toBe(documentIdentity(e.id, e.asset.asset_id));
    });
    // A new manual revision whose own render is held back, then rendered against a stale default.
    const storage = e.app.archiveText!.storage,
      old = (await storage.load(part.proofread_id!))!,
      text = renderArrangement(
        old.bundle,
        old.version.resources,
      ).markdown.toString();
    const fault = vi
      .spyOn(e.app.archiveText!, "render")
      .mockRejectedValueOnce(new ArchiveTextError("source-integrity"));
    const saved = await e.app.archiveArrangement.save(
      {
        schema_version: 2,
        literature_id: e.id,
        asset_id: e.asset.asset_id,
        proofread_id: old.version.proofread_id,
        expected_arrangement_id: old.version.arrangement_id,
        expected_manual_revision: 0,
        markdown: text.replace(
          "A complete synthetic study.",
          "A checked synthetic study.",
        ),
      },
      "fixture-human",
    );
    fault.mockRestore();
    await expect(
      e.app.archiveText!.render(e.id, e.asset.asset_id, undefined, {
        proofread_id: saved.proofread_id!,
        default_revision: 99,
      }),
    ).rejects.toMatchObject({ code: "publication-conflict" });
  } finally {
    await e.close();
  }
}, 30000);

it("restores and locks a dropped leaf atomically, leaves the previous fixed version readable, and never calls models on edit", async () => {
  const e = await archiveFixture();
  try {
    e.setText(
      "DROP_HEADER Recoverable note.\n\n# Abstract\n\nFixture Author studies spectroscopy.\n\n# Introduction\n\nRetained synthetic body.\n\n# References\n\n[1] Example synthetic reference.\n",
    );
    await e.app.documentProcessing.parseDocuments(e.rawParseRequest);
    await e.submit("before-restore");
    const part = (await e.app.archive.status(e.id)).parts[0]!,
      storage = new SqliteArchiveTextStorage(e.app.database, e.app.files),
      old = (await storage.load(part.proofread_id!))!,
      leaf = old.bundle.leaves.find((l) => l.destination.kind === "dropped")!,
      calls = e.modelCalls;
    const request = {
      schema_version: 2,
      literature_id: e.id,
      asset_id: e.asset.asset_id,
      expected_proofread_id: old.version.proofread_id,
      expected_arrangement_id: old.version.arrangement_id,
      expected_manual_revision: 0,
      changes: [
        {
          kind: "restore",
          leaf_id: leaf.leaf.leaf_id,
          target: { role: "end-matter" },
          presentation: { kind: "content" },
        },
      ],
    };
    const edited = await e.app.archiveArrangement.edit(
      request,
      "fixture-human",
    );
    expect(edited.pending_page_indexes).toEqual([0]);
    expect(e.modelCalls).toBe(calls);
    await expect(
      e.app.archiveArrangement.edit(request, "fixture-human"),
    ).rejects.toMatchObject({ code: "publication-conflict" });
    const saved = (await storage.load(edited.proofread_id))!;
    expect(
      saved.bundle.arrangement!.destinations.find(
        (d) => d.leaf_id === leaf.leaf.leaf_id,
      ),
    ).toMatchObject({
      locked: true,
      destination: { kind: "assigned", target: { role: "end-matter" } },
    });
    await e.app.documentRead.describe({
      document_version_id: part.document_version_id!,
    });
    await e.submit("after-restore");
    const current = (await e.app.archive.status(e.id)).parts[0]!,
      complete = (await storage.load(current.proofread_id!))!;
    expect(complete.version.status).toBe("complete");
    expect(
      renderArrangement(
        complete.bundle,
        complete.version.resources,
      ).markdown.toString(),
    ).toContain("Recoverable note.");
    expect(
      complete.bundle.arrangement!.destinations.find(
        (d) => d.leaf_id === leaf.leaf.leaf_id,
      )!.locked,
    ).toBe(true);
  } finally {
    await e.close();
  }
}, 30000);

it("maps a unique paragraph edit to a locked leaf correction, refuses unanchored Markdown, and preserves the edit on resume", async () => {
  const e = await archiveFixture();
  try {
    await e.app.documentProcessing.parseDocuments(e.rawParseRequest);
    await e.submit("before-manual-text");
    const part = (await e.app.archive.status(e.id)).parts[0]!,
      storage = new SqliteArchiveTextStorage(e.app.database, e.app.files),
      old = (await storage.load(part.proofread_id!))!,
      text = renderArrangement(
        old.bundle,
        old.version.resources,
      ).markdown.toString(),
      calls = e.modelCalls;
    const request = {
      schema_version: 2,
      literature_id: e.id,
      asset_id: e.asset.asset_id,
      proofread_id: part.proofread_id,
      expected_arrangement_id: old.version.arrangement_id,
      expected_manual_revision: 0,
      markdown: text.replace(
        "A complete synthetic study.",
        "A checked synthetic study.",
      ),
      actor: "untrusted-body",
    };
    const result = await e.app.archiveArrangement.save(
      request,
      "fixture-human",
    );
    expect(result).toMatchObject({
      saved: true,
      changed: true,
      rebuild: { status: "done" },
    });
    expect(e.modelCalls).toBe(calls);
    const saved = (await storage.load(result.proofread_id!))!;
    expect(saved.version.pages.flatMap((p) => p.corrections)).toContainEqual(
      expect.objectContaining({
        source: "manual",
        operation: expect.objectContaining({
          replacement: "A checked synthetic study.",
        }),
      }),
    );
    const conflict = await e.app.archiveArrangement.save(
      {
        ...request,
        proofread_id: saved.version.proofread_id,
        expected_arrangement_id: saved.version.arrangement_id,
        expected_manual_revision: 1,
        markdown: "unanchored new document",
      },
      "fixture-human",
    );
    expect(conflict).toMatchObject({
      saved: false,
      conflict: { status: "mapping-conflict" },
    });
    await e.submit("after-manual-text");
    const current = (await e.app.archive.status(e.id)).parts[0]!,
      after = (await storage.load(current.proofread_id!))!;
    expect(
      renderArrangement(
        after.bundle,
        after.version.resources,
      ).markdown.toString(),
    ).toContain("A checked synthetic study.");
  } finally {
    await e.close();
  }
}, 30000);

it("shares arrangement queries across HTTP, CLI and MCP and rejects obsolete archive writes before creating jobs", async () => {
  const e = await archiveFixture();
  let web: Awaited<ReturnType<typeof startQueryOnlyWorkbench>> | undefined;
  try {
    e.setText(
      "# Original document\n\nRetained unheaded text.\n\n# References\n\n[1] Example synthetic reference.\n",
    );
    await e.app.documentProcessing.parseDocuments(e.rawParseRequest);
    await e.submit("interface-base");
    const part = (await e.app.archive.status(e.id)).parts[0]!,
      request = {
        schema_version: 2,
        asset_id: e.asset.asset_id,
        proofread_id: part.proofread_id,
        kind: "summary",
      };
    const before = await e.app.jobs!.listJobs();
    await expect(
      executeMaintenance(e.app, "archive", {
        operation: "build",
        request: {
          selector: { kind: "literatures", literature_ids: [e.id] },
          mode: "full",
          from_step: null,
          idempotency_key: "obsolete",
        },
      }),
    ).rejects.toMatchObject({ code: "archive-contract-obsolete" });
    expect(await e.app.jobs!.listJobs()).toEqual(before);
    const q = await createQueryApplication(e.home);
    let expected: unknown;
    try {
      expected = await executeQuery(q, "archive-arrangement", request);
    } finally {
      await q.close();
    }
    web = await startQueryOnlyWorkbench({ home: e.home, assets: new Map() });
    const response = await fetch(
      `${web.origin}/api/v1/query/archive-arrangement`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-SciRetriever-Protocol-Version": "1",
        },
        body: JSON.stringify({ protocol_version: 1, request }),
      },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      protocol_version: 1,
      result: expected,
    });
    let out = "";
    const result = await runCli(["archive", "arrangement", "--request", "-"], {
      home: e.home,
      stdin: (async function* () {
        yield Buffer.from(JSON.stringify(request));
      })(),
      stdout: (value) => {
        out += value;
      },
    });
    expect(result.code).toBe(0);
    expect(JSON.parse(out).result).toEqual(expected);
    const server = createMcpServer({ home: e.home }),
      client = new Client({ name: "archive-v2", version: "1" }),
      [a, b] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(a);
      await client.connect(b);
      const result = await client.callTool({
        name: "archive_arrangement",
        arguments: request,
      });
      expect(result.isError).not.toBe(true);
      expect(JSON.stringify(result)).toContain("arranged-v2");
      for (const operation of ["describe", "outline"] as const) {
        const request = {
          document_version_id: part.document_version_id!,
          ...(operation === "outline" ? { limit: 200, cursor: null } : {}),
        };
        const expected =
          operation === "describe"
            ? await e.app.documentRead.describe(request)
            : await e.app.documentRead.outline(request);
        const http = await fetch(
          web!.origin + "/api/v1/query/document-" + operation,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-SciRetriever-Protocol-Version": "1",
            },
            body: JSON.stringify({ protocol_version: 1, request }),
          },
        );
        expect(http.status).toBe(200);
        expect(await http.json()).toEqual({
          protocol_version: 1,
          result: expected,
        });
        let text = "";
        expect(
          (
            await runCli(["document", operation, "--request", "-"], {
              home: e.home,
              stdin: (async function* () {
                yield Buffer.from(JSON.stringify(request));
              })(),
              stdout: (s) => {
                text += s;
              },
            })
          ).code,
        ).toBe(0);
        expect(JSON.parse(text).result).toEqual(expected);
        const mcp = await client.callTool({
          name: "document_read",
          arguments: { operation, request },
        });
        expect(mcp.isError).not.toBe(true);
        expect(mcp.structuredContent).toEqual({
          protocol_version: 1,
          result: expected,
        });
        if (operation === "describe")
          expect(expected).toHaveProperty("layout.schema_version", 1);
        else
          expect(expected).toHaveProperty(
            "sections",
            expect.arrayContaining([
              expect.objectContaining({
                title: null,
                role: "additional",
                title_truncated: false,
              }),
            ]),
          );
      }
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    await web?.close();
    await e.close();
  }
}, 30000);

it("retains an accepted manual text decision after render failure, returns a typed stop and repairs deterministically", async () => {
  const e = await archiveFixture();
  try {
    await e.app.documentProcessing.parseDocuments(e.rawParseRequest);
    await e.submit("before-render-fault");
    const part = (await e.app.archive.status(e.id)).parts[0]!,
      storage = e.app.archiveText!.storage,
      old = (await storage.load(part.proofread_id!))!,
      text = renderArrangement(
        old.bundle,
        old.version.resources,
      ).markdown.toString(),
      calls = e.modelCalls;
    const fault = vi
      .spyOn(e.app.archiveText!, "render")
      .mockRejectedValueOnce(new ArchiveTextError("source-integrity"));
    const saved = await e.app.archiveArrangement.save(
      {
        schema_version: 2,
        literature_id: e.id,
        asset_id: e.asset.asset_id,
        proofread_id: old.version.proofread_id,
        expected_arrangement_id: old.version.arrangement_id,
        expected_manual_revision: 0,
        markdown: text.replace(
          "A complete synthetic study.",
          "A checked synthetic study.",
        ),
      },
      "fixture-human",
    );
    expect(saved).toMatchObject({
      saved: true,
      changed: true,
      rebuild: {
        status: "failed",
        stop: { code: "render-failed", step: "render", scope: "part" },
      },
    });
    const rebuild = saved.rebuild as { stop: unknown };
    expect(parseArchiveTextStop(rebuild.stop).code).toBe("render-failed");
    const current = await storage.state(e.asset.asset_id);
    expect(current.manual_revision).toBe(1);
    expect(current.current!.proofread_id).toBe(saved.proofread_id);
    const output = (await storage.load(saved.proofread_id!))!;
    expect(
      output.bundle.leaves.some(
        (l) =>
          l.text_source === "manual" &&
          l.corrected_text === "A checked synthetic study.",
      ),
    ).toBe(true);
    await e.app.documentRead.describe({
      document_version_id: part.document_version_id,
    });
    fault.mockRestore();
    expect(
      await e.app.archiveText!.render(e.id, e.asset.asset_id),
    ).toMatchObject({
      structure_satisfied: true,
      index_status: "scheduled",
      usage: { calls: 0 },
    });
    expect(e.modelCalls).toBe(calls);
  } finally {
    vi.restoreAllMocks();
    await e.close();
  }
}, 30000);

it("publishes a new layout from the same accepted proofread without overwriting historical Markdown or calling a model", async () => {
  const e = await archiveFixture();
  try {
    e.setText(
      "# Original document\n\nA complete synthetic study.\n\n# References\n\n[1] Example synthetic reference.\n",
    );
    await e.app.documentProcessing.parseDocuments(e.rawParseRequest);
    await e.submit("layout-republication");
    const part = (await e.app.archive.status(e.id)).parts[0]!,
      output = (await e.app.archiveText!.storage.load(part.proofread_id!))!;
    const old = renderArrangement(
        output.bundle,
        output.version.resources,
        "arranged-leaves-v2",
      ),
      storage = e.app.archiveText!.storage;
    const markdown = await storage.write(
        "proofread-markdown",
        old.markdown,
        "text/markdown",
      ),
      structure = await storage.write("document-structure", old.bytes);
    await e.app.database.proofread("render-resources", {
      proofread_id: part.proofread_id,
      manual_revision: 0,
      resources: [{ ...markdown, kind: "markdown", logical_reference: "" }],
    });
    const material = (await e.app.database.documentMaterial(
      e.id,
      e.asset.asset_id,
    ))!;
    const ref = (a: typeof markdown) =>
      parseArtifactRef({
        sha256: a.sha256,
        byte_size: a.byte_size,
        media_type: a.media_type,
      });
    const representation = {
      source_material_ref: material.material,
      proofread_id: part.proofread_id!,
      proofread_content_sha256: output.version.content_sha256,
      builder_version: "arranged-leaves-v2" as const,
      locator_scheme: "utf8-segment-v1" as const,
      markdown: ref(markdown),
      structure: ref(structure),
      resources: [],
    };
    const oldId = "00000000-0000-4000-8000-000000000071",
      current = (await e.app.database.documentDefault(
        e.id,
        e.asset.asset_id,
        e.asset.sha256,
      ))!;
    await e.app.database.commitDocumentVersion({
      version: {
        schema_version: 2,
        document_id: documentIdentity(e.id, e.asset.asset_id),
        document_version_id: oldId,
        representation_sha256: await documentRepresentationHash(representation),
        ...representation,
      },
      source_artifact_path: material.path,
      markdown_artifact_path: markdown.reference,
      structure_artifact_path: structure.reference,
      resource_artifact_paths: {},
      expected_default_revision: current.revision,
      expected_manual_revision: 0,
    });
    const calls = e.modelCalls,
      published = await e.app.archiveText!.render(e.id, e.asset.asset_id);
    expect(published.document_version_id).not.toBe(oldId);
    expect(published.proofread_id).toBe(part.proofread_id);
    expect(e.modelCalls).toBe(calls);
    const documents = new SqliteDocumentStorage(e.app.database, e.app.files);
    await documents.withVerifiedDocument(oldId, async (_v, bytes) =>
      expect(Buffer.from(bytes)).toEqual(old.markdown),
    );
    await documents.withVerifiedDocument(
      published.document_version_id,
      async (v, bytes, structure) => {
        expect(v.builder_version).toBe("source-order-leaves-v3");
        expect(Buffer.from(bytes).toString()).not.toContain("## 附加章节");
        expect(structure).toHaveProperty("layout.schema_version", 1);
      },
    );
    const resources = await e.app.database.proofread<
      { kind: string; reference: string; sha256: string }[]
    >("resources", part.proofread_id);
    expect(resources.filter((r) => r.kind === "markdown")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reference: "", sha256: markdown.sha256 }),
        expect.objectContaining({
          reference: expect.stringContaining("render/source-order-leaves-v3/"),
        }),
      ]),
    );
  } finally {
    await e.close();
  }
}, 30000);

it("revalidates arrangement inputs when PDF geometry changes without changing raw bytes or model settings", async () => {
  const e = await archiveFixture();
  try {
    await e.app.documentProcessing.parseDocuments(e.rawParseRequest);
    const pipeline = e.app.archiveText!,
      first = await pipeline.arrange(e.asset.asset_id, "full"),
      source = await pipeline.source(e.asset.asset_id, "full");
    const inspect = pipeline.pdf.inspect.bind(pipeline.pdf),
      size = source.raw.page_sizes[0]!;
    vi.spyOn(pipeline.pdf, "inspect").mockImplementation(async (...args) =>
      (await inspect(...args)).map((p) => ({
        ...p,
        layout: {
          width: size[0],
          height: size[1],
          items: [
            {
              bbox: [10, 10, 100, 20] as const,
              font_size: 10,
              font: "Synthetic",
              length: 12,
            },
          ],
        },
      })),
    );
    const calls = e.modelCalls,
      second = await pipeline.arrange(e.asset.asset_id, "full");
    expect(second).not.toHaveProperty("reused", true);
    expect(second.proofread_id).not.toBe(first.proofread_id);
    expect(e.modelCalls).toBe(calls + 1);
  } finally {
    await e.close();
  }
}, 30000);
