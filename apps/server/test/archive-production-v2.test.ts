import { expect, it, vi } from "vitest";
import { parseArchiveTextStop } from "@sciretriever/contracts";
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

it("publishes the six-step X workflow, excludes dropped text from fixed documents, and gives metadata bibliography evidence", async () => {
  const e = await archiveFixture();
  let fragments: { role: string; text: string }[] = [];
  try {
    e.setText(
      "DROP_HEADER Publisher interface.\n\nBIBLIOGRAPHY DOI: 10.1000/fixture.\n\n# Abstract\n\nFixture Author studies spectroscopy.\n\n# Introduction\n\nRetained synthetic body.\n\n# References\n\n[1] Example synthetic reference.\n",
    );
    e.setModel((input) => {
      if (input.method === "archive-metadata-dsh-v1")
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
    expect(
      fragments.some(
        (f) => f.role === "bibliography" && f.text.includes("BIBLIOGRAPHY"),
      ),
    ).toBe(true);
    expect(fragments.some((f) => f.text.includes("DROP_HEADER"))).toBe(false);
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
      index_status: "updated",
      usage: { calls: 0 },
    });
    expect(e.modelCalls).toBe(calls);
  } finally {
    vi.restoreAllMocks();
    await e.close();
  }
}, 30000);
