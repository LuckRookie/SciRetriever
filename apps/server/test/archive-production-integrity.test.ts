import { expect, it, vi } from "vitest";
import { processorFixture } from "./processor-fixture.js";
import { ProcessorArchiveSource } from "../src/analysis/processor-archive.js";
import { SqliteAnnotationStorage } from "../src/storage/structure-annotations.js";
import { archiveFixture } from "./archive-fixture.js";
import { createQueryApplication } from "../src/bootstrap/application.js";
import { executeQuery } from "../src/entry/query-operations.js";
import { executeMaintenance } from "../src/entry/maintenance-operations.js";
import { ArchiveTextError } from "../src/archive/text-source.js";
import { SqliteArchiveTextStorage } from "../src/storage/archive-text.js";
import { parseArchiveUsageEstimateV2 } from "@sciretriever/contracts";
import { PDF_PAGES_METHOD } from "../src/proofread/pdf-pages.js";
import { startQueryOnlyHttp } from "../src/workbench/http.js";
import { createMcpServer } from "../src/mcp/server.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import * as bootstrap from "../src/bootstrap/application.js";
import { runCli } from "../src/cli/main.js";

it("reads all retained V2 segments as fixed processor evidence", async () => {
  const e = await processorFixture();
  try {
    await e.build(e.parseRequest);
    const source = new ProcessorArchiveSource(
        e.app.archive,
        e.app.snapshots,
        new SqliteAnnotationStorage(e.app.database, e.app.files),
        e.app.documentRead,
      ),
      signal = new AbortController().signal,
      reads = { parts: "main" as const, roles: "all" as const };
    const input = await source.input(
      e.parseRequest.literature_id,
      reads,
      signal,
    );
    if (input.kind !== "archive-document") throw new Error("fixture not ready");
    const segments = await source.segments(input, reads, signal);
    expect(segments.map((s) => s.text).join("\n")).toContain(
      "A synthetic finding.",
    );
    for (const s of segments) {
      if (s.citation.kind !== "document")
        throw new Error("fixture citation missing");
      const read = await e.app.documentRead.resolveEvidence(
        s.citation.evidence,
      );
      if (!("text" in read)) throw new Error("document text missing");
      expect(read.text).toContain(s.text);
    }
    const run = await e.app.processors!.runBatch({
      schema_version: 1,
      idempotency_key: "arranged-summary",
      name: "Arranged summary",
      processor: { id: "summary", version: "2" },
      spec: {},
      inputs: [
        { kind: "literature", literature_id: e.parseRequest.literature_id },
      ],
    });
    expect(run.failures).toEqual([]);
  } finally {
    await e.close();
  }
}, 30000);

it("starts the production six-step workflow through CLI with only external adapters faked", async () => {
  const e = await archiveFixture();
  let opened: Awaited<ReturnType<typeof e.openAnother>> | undefined;
  try {
    await e.app.documentProcessing.parseDocuments(e.rawParseRequest);
    opened = await e.openAnother();
    // Keep the full application graph; select the same isolated fake transports
    // as the HTTP/MCP fixtures instead of opening real external adapters.
    const factory = vi
      .spyOn(bootstrap, "createApplication")
      .mockResolvedValueOnce(opened);
    let out = "";
    try {
      expect(
        (
          await runCli(
            [
              "archive",
              "build",
              e.id,
              "--idempotency-key",
              "cli-arranged",
              "--json",
            ],
            {
              home: e.home,
              stdout: (t) => {
                out += t;
              },
            },
          )
        ).code,
      ).toBe(0);
    } finally {
      factory.mockRestore();
    }
    expect(JSON.parse(out)).toHaveProperty("job");
    const state = await e.app.archive.status(e.id);
    expect(state.status).toBe("READY");
    expect(state.parts[0]!.steps.map((s) => s.step).sort()).toEqual([
      "arrange",
      "layers",
      "metadata",
      "proofread",
      "references",
      "render",
      "tags",
      "translate",
    ]);
    expect(e.parseCalls).toBe(2);
  } finally {
    await opened?.close();
    await e.close();
  }
}, 30000);

it("starts the V2 workflow over HTTP/MCP, exposes obsolete codes, and enforces concurrent edit CAS without models", async () => {
  const e = await archiveFixture();
  let q: Awaited<ReturnType<typeof createQueryApplication>> | undefined,
    http: Awaited<ReturnType<typeof startQueryOnlyHttp>> | undefined;
  try {
    await e.app.documentProcessing.parseDocuments(e.rawParseRequest);
    q = await createQueryApplication(e.home);
    http = await startQueryOnlyHttp({
      application: q,
      maintenance: e.app.maintenance!,
      assets: new Map([["/", { contentType: "text/html", body: "fixture" }]]),
      archiveOperation: (op, value, signal) =>
        executeMaintenance(e.app, op, value, signal),
    });
    const root = await fetch(http.origin),
      cookie = root.headers
        .getSetCookie()
        .map((v) => v.split(";")[0])
        .join("; ");
    await root.arrayBuffer();
    const session = await fetch(`${http.origin}/api/v1/maintenance/session`, {
        headers: { Cookie: cookie },
      }),
      grant = (await session.json()) as { csrf: string };
    const origin = http.origin;
    const post = (name: string, request: unknown) =>
      fetch(`${origin}/api/v1/maintenance/${name}`, {
        method: "POST",
        headers: {
          Cookie: cookie,
          Origin: origin,
          "X-SciRetriever-Csrf": grant.csrf,
          "X-SciRetriever-Protocol-Version": "1",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ protocol_version: 1, request }),
      });
    const build = (key: string) => ({
      operation: "build",
      request: {
        schema_version: 2,
        selector: { kind: "literatures", literature_ids: [e.id] },
        mode: "full",
        from_step: null,
        idempotency_key: key,
      },
    });
    const response = await post("archive", build("http-arranged"));
    expect(response.status).toBe(200);
    const receipt = (await response.json()) as {
      result: { job: { job_id: string } };
    };
    expect(
      (await e.app.processingTasks!.run(receipt.result.job.job_id)).failures,
    ).toEqual([]);
    const obsolete = await post("document-annotate", {
      document_version_id: (await e.app.archive.status(e.id)).parts[0]!
        .document_version_id,
    });
    expect(obsolete.status).toBe(422);
    expect(await obsolete.json()).toMatchObject({
      code: "archive-contract-obsolete",
    });
    const store = e.app.archiveText!.storage,
      state = await store.state(e.asset.asset_id),
      current = (await store.load(String(state.current!.proofread_id)))!,
      leaf = current.bundle.leaves.find(
        (l) => l.destination.kind === "assigned" && l.leaf.type === "text",
      )!,
      calls = e.modelCalls;
    const edit = {
      schema_version: 2,
      literature_id: e.id,
      asset_id: e.asset.asset_id,
      expected_proofread_id: current.version.proofread_id,
      expected_arrangement_id: current.version.arrangement_id,
      expected_manual_revision: 0,
      changes: [
        {
          kind: "assign",
          leaf_id: leaf.leaf.leaf_id,
          target: { role: "methods" },
          presentation: { kind: "content" },
        },
      ],
    };
    const raced = await Promise.all([
      post("archive-arrangement-edit", edit),
      post("archive-arrangement-edit", {
        ...edit,
        changes: [{ ...edit.changes[0], target: { role: "end-matter" } }],
      }),
    ]);
    expect(raced.map((r) => r.status).sort()).toEqual([200, 409]);
    for (const r of raced) await r.arrayBuffer();
    expect(e.modelCalls).toBe(calls);
    const server = createMcpServer({
        maintenance: true,
        applicationFactory: async () => e.app,
        queryFactory: () => createQueryApplication(e.home),
      }),
      client = new Client({ name: "arranged-interface", version: "1" }),
      [a, b] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(a);
      await client.connect(b);
      const result = await client.callTool({
        name: "archive_manage",
        arguments: build("mcp-arranged"),
      });
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      const job = (
        result.structuredContent as { result: { job: { job_id: string } } }
      ).result.job;
      expect((await e.app.processingTasks!.run(job.job_id)).failures).toEqual(
        [],
      );
      expect((await e.app.archive.status(e.id)).status).toBe("READY");
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    await http?.close();
    await q?.close();
    await e.close();
  }
}, 30000);

it("reports an unrepresentable historical role instead of silently treating it as an empty complete read", async () => {
  const e = await archiveFixture();
  try {
    await e.app.documentProcessing.parseDocuments(e.rawParseRequest);
    await e.submit("new-role-base");
    const calls = e.modelCalls,
      run = await e.app.processors!.runBatch({
        schema_version: 1,
        idempotency_key: "historical-role-on-new",
        name: "Role gap",
        processor: { id: "labels", version: "2" },
        spec: {
          question: "What is reported?",
          answer_type: "string",
          reads: { parts: "main", roles: ["body"] },
        },
        inputs: [{ kind: "literature", literature_id: e.id }],
      });
    expect(run.failures).toEqual([]);
    expect(e.modelCalls).toBe(calls);
    const id = (run.results[0] as { result: { result_id: string } }).result
        .result_id,
      stored = (await e.app.processorRead!.byId(id))!;
    expect(stored.result.coverage[0]!.parts).toContainEqual(
      expect.objectContaining({
        outcome: "incomplete",
        gaps: ["structure-role-unavailable"],
      }),
    );
  } finally {
    await e.close();
  }
}, 30000);

it("records paid usage after checkpoint failure and accepts a new raw source without replaying old leaf IDs", async () => {
  const e = await archiveFixture();
  try {
    await e.app.documentProcessing.parseDocuments(e.rawParseRequest);
    const fault = vi
      .spyOn(e.app.archiveText!.storage, "publish")
      .mockRejectedValueOnce(new ArchiveTextError("publication-conflict"));
    const failed = await e.submit("checkpoint-conflict");
    expect(failed.failures).toHaveLength(1);
    const failedPart = (await e.app.archive.status(e.id)).parts[0]!,
      receipt = failedPart.steps.find((s) => s.step === "arrange")!;
    expect(receipt.status).toBe("failed");
    expect(receipt.calls).toBeGreaterThan(0);
    expect(receipt.usage).toMatchObject({
      calls: receipt.calls,
      input_tokens: receipt.calls * 100,
      output_tokens: receipt.calls * 50,
      usage_complete: true,
    });
    fault.mockRestore();
    expect((await e.submit("checkpoint-retry")).failures).toEqual([]);
    e.setText(
      "# Abstract\n\nFixture Author studies spectroscopy.\n\n# Introduction\n\nA wholly new synthetic body.\n\n# References\n\n[1] Example synthetic reference.\n",
    );
    await e.app.documentProcessing.parseDocuments({
      ...e.rawParseRequest,
      force: true,
    });
    expect((await e.submit("changed-source")).failures).toEqual([]);
    const part = (await e.app.archive.status(e.id)).parts[0]!,
      output = (await new SqliteArchiveTextStorage(
        e.app.database,
        e.app.files,
      ).load(part.proofread_id!))!;
    expect(
      output.bundle.leaves.map((l) => l.corrected_text).join("\n"),
    ).toContain("A wholly new synthetic body.");
  } finally {
    vi.restoreAllMocks();
    await e.close();
  }
}, 30000);

it("estimates no-history and partial text reuse without running a model or creating a task", async () => {
  const e = await archiveFixture({ pageMethod: PDF_PAGES_METHOD });
  try {
    await e.app.documentProcessing.parseDocuments(e.rawParseRequest);
    const request = {
      kind: "archive",
      request: { selector: { kind: "literatures", literature_ids: [e.id] } },
    };
    const read = async () => {
      const q = await createQueryApplication(e.home);
      try {
        return parseArchiveUsageEstimateV2(
          await executeQuery(q, "usage-estimate", request),
        );
      } finally {
        await q.close();
      }
    };
    const initial = await read();
    expect(initial).toMatchObject({
      schema_version: 2,
      total_pdf_pages: 1,
      reused_count: 0,
      no_hard_limit: true,
      available: false,
      total: { calls: null, input_tokens: null, output_tokens: null },
    });
    // Translation is estimated by the primary PDF's pages (ADR 0068).
    expect(initial.components.map((c) => c.step)).toEqual([
      "arrange",
      "proofread",
      "render",
      "translate",
      "layers",
      "metadata",
      "references",
      "tags",
    ]);
    expect(
      initial.components.find((c) => c.step === "translate"),
    ).toMatchObject({
      unit: "page",
      units: 1,
      basis: "unknown",
      unknown_code: "no-matching-history",
    });
    expect(e.modelCalls).toBe(0);
    await e.app.archiveText!.arrange(e.asset.asset_id, "full");
    const arranged = (await e.app.archiveText!.storage.state(e.asset.asset_id))
      .current!;
    const draft = (await e.app.archiveText!.storage.load(
      String(arranged.proofread_id),
    ))!;
    await executeMaintenance(e.app, "proofread-build", {
      schema_version: 2,
      asset_id: e.asset.asset_id,
      arrangement_id: draft.version.arrangement_id,
      retry_page_indexes: null,
    });
    const calls = e.modelCalls,
      jobs = await e.app.jobs!.listJobs(),
      partial = await read();
    expect(partial).toMatchObject({
      reused_count: 0,
      expected_proofread_pages: 0,
      page_basis: "accepted-arrangement",
    });
    for (const step of ["arrange", "proofread"])
      expect(partial.components.find((c) => c.step === step)).toMatchObject({
        units: 0,
        calls: { median: 0, p90: 0 },
      });
    expect(e.modelCalls).toBe(calls);
    expect(await e.app.jobs!.listJobs()).toEqual(jobs);
    await e.submit("complete-estimate");
    const complete = await read();
    expect(complete).toMatchObject({
      reused_count: 1,
      available: true,
      total: { calls: { median: 0, p90: 0 } },
    });
    expect(
      complete.components.find((c) => c.step === "translate"),
    ).toMatchObject({ units: 0, sample_count: 1, basis: "matching-history" });
    const part = (await e.app.archive.status(e.id)).parts[0]!,
      before = e.modelCalls;
    expect(
      await executeMaintenance(e.app, "document-annotate", {
        schema_version: 2,
        document_version_id: part.document_version_id,
        arrangement_id: draft.version.arrangement_id,
      }),
    ).toMatchObject({ structure_satisfied: true, usage: { calls: 0 } });
    expect(e.modelCalls).toBe(before);
  } finally {
    await e.close();
  }
}, 30000);

it("bounds Unicode arrangement windows, pins continuations and rejects filter drift", async () => {
  const e = await archiveFixture();
  try {
    const body = 'A synthetic payload 😀 with "quoted" text. '.repeat(500);
    e.setText(`# Introduction\n\n${body}\n`);
    await e.app.documentProcessing.parseDocuments(e.rawParseRequest);
    await e.app.archiveText!.arrange(e.asset.asset_id, "full");
    const request = {
      schema_version: 2,
      asset_id: e.asset.asset_id,
      proofread_id: null,
      kind: "leaves",
      visibility: "kept",
      drop_reason: null,
      page_index: null,
      limit: 1,
      max_bytes: 1024,
    };
    let cursor: string | null = null,
      text = "",
      windows = 0;
    do {
      const page = await e.app.archiveArrangement.read({ ...request, cursor });
      if (!("text" in page) || !("next_cursor" in page))
        throw new Error("missing query window");
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(1024);
      text += page.text;
      cursor = page.next_cursor;
      windows++;
      if (windows === 1 && cursor)
        await expect(
          e.app.archiveArrangement.read({
            ...request,
            visibility: "all",
            cursor,
          }),
        ).rejects.toMatchObject({ code: "query-cursor-stale" });
    } while (cursor);
    expect(windows).toBeGreaterThan(3);
    const leaves = JSON.parse(text) as { leaf: { original_text: string } }[];
    expect(leaves.map((l) => l.leaf.original_text).join("\n")).toContain(
      body.trim(),
    );
  } finally {
    await e.close();
  }
}, 30000);
