import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  parseKnowledgeContextBundle,
  parseKnowledgeContextRequest,
  parseLiterature,
} from "@sciretriever/contracts";
import { createQueryApplication } from "../src/bootstrap/application.js";
import { coreProcessingFixture } from "./core-processing-fixture.js";
import { archiveFixture } from "./archive-fixture.js";
import { FIXTURE_LITERATURE } from "../src/workbench/synthetic-fixture.js";
import { runCli } from "../src/cli/main.js";
import { startQueryOnlyHttp } from "../src/workbench/http.js";
import { createMcpServer } from "../src/mcp/server.js";

const id = (n: number) =>
  `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const paper = (n: number, title: string) =>
  parseLiterature({
    ...FIXTURE_LITERATURE,
    literature_id: id(n),
    meta_literature_id: id(n + 1),
    metadata: { ...FIXTURE_LITERATURE.metadata, title },
  });
const request = (limit = 20) =>
  parseKnowledgeContextRequest({
    schema_version: 3,
    query: "synthetic",
    scope: { kind: "library" },
    kinds: ["metadata", "document", "knowledge"],
    versions: { kind: "default" },
    budget: { max_items: limit, max_bytes: 65536, token_limit: null },
    continuation: null,
  });

it("serves stale mixed-context hits and gaps through HTTP, CLI and MCP without scheduling a refresh", async () => {
  const e = await coreProcessingFixture();
  let q: Awaited<ReturnType<typeof createQueryApplication>> | undefined;
  try {
    await e.app.database.putLiterature(paper(30, "synthetic second paper"));
    await e.app.maintenance!.rebuildIndex();
    q = await createQueryApplication(e.home);
    const input = request(),
      before = await q.knowledgeContext!.search(input);
    expect(before.items).toHaveLength(2);
    const db = new DatabaseSync(join(e.home, "catalog.sqlite"));
    try {
      db.exec("UPDATE literature_metadata SET title=title");
    } finally {
      db.close();
    }
    const status = await q.indexRefreshStatus!();
    const stale = await q.knowledgeContext!.search(input);
    expect(stale.coverage).toBe("index-stale");
    expect(stale.items).toEqual(before.items);
    expect(stale.gaps).toContainEqual({
      code: "material-index-stale",
      literature_id: null,
    });
    expect(parseKnowledgeContextBundle(stale, input)).toEqual(stale);
    let output = "";
    const cli = await runCli(["context", "knowledge", "--request", "-"], {
      home: e.home,
      stdin: (async function* () {
        yield Buffer.from(JSON.stringify(input));
      })(),
      stdout: (text) => {
        output += text;
      },
    });
    expect(cli.code).toBe(0);
    expect(output).toContain("索引正在追赶");
    expect(cli.value).toEqual({ protocol_version: 1, result: stale });
    let jsonOutput = "";
    const json = await runCli(["context", "knowledge", "--request", "-"], {
      home: e.home,
      json: true,
      stdin: (async function* () {
        yield Buffer.from(JSON.stringify(input));
      })(),
      stdout: (text) => {
        jsonOutput += text;
      },
    });
    expect(json.code).toBe(0);
    expect(JSON.parse(jsonOutput)).toEqual({
      protocol_version: 1,
      result: stale,
    });
    const web = await startQueryOnlyHttp({ application: q });
    try {
      const response = await fetch(
        `${web.origin}/api/v1/query/knowledge-context`,
        {
          method: "POST",
          headers: {
            Origin: web.origin,
            "Content-Type": "application/json",
            "X-SciRetriever-Protocol-Version": "1",
          },
          body: JSON.stringify({ protocol_version: 1, request: input }),
        },
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        protocol_version: 1,
        result: stale,
      });
    } finally {
      await web.close();
    }
    const server = createMcpServer({ home: e.home }),
      client = new Client({ name: "stale-knowledge", version: "1" }),
      [a, b] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(a);
      await client.connect(b);
      const result = await client.callTool({
        name: "search_context",
        arguments: { kind: "knowledge", request: input },
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toEqual({
        protocol_version: 1,
        result: stale,
      });
    } finally {
      await client.close();
      await server.close();
    }
    expect((await q.indexRefreshStatus!()).request_sequence).toBe(
      status.request_sequence,
    );
    expect(
      (await q.knowledgeContext!.search(request(1))).continuation,
    ).not.toBeNull();
    const refresh = await e.app.maintenance!.refreshIndex!();
    expect(refresh.status, JSON.stringify(refresh)).toBe("updated");
    const after = await q.knowledgeContext!.search(input);
    expect(after.items).toEqual(before.items);
    expect(after.coverage).toBe(before.coverage);
    expect(after.gaps.some((g) => g.code === "material-index-stale")).toBe(
      false,
    );
  } finally {
    await q?.close();
    await e.close();
  }
}, 30000);

it("keeps verified processor results in stale knowledge context and pins result-only continuation pages to the active state", async () => {
  const e = await archiveFixture();
  let q: Awaited<ReturnType<typeof createQueryApplication>> | undefined;
  try {
    await e.app.documentProcessing.parseDocuments(e.rawParseRequest);
    expect((await e.submit("knowledge-stale-ready")).failures).toEqual([]);
    e.setModel((input) => ({
      answer: "synthetic spectroscopy",
      source_ids: [input.segments![0]!.segment_id],
      reason: null,
    }));
    const job = await e.app.processors!.submit({
      schema_version: 1,
      idempotency_key: "knowledge-stale-labels",
      name: "Knowledge context fixture",
      processor: { id: "labels", version: "2" },
      spec: { question: "What is reported?", answer_type: "string" },
      inputs: [{ kind: "literature", literature_id: e.id }],
    });
    await e.app.processingTasks!.run(job.job_id);
    expect((await e.app.processingTasks!.read(job.job_id)).failures).toEqual(
      [],
    );
    await e.app.maintenance!.rebuildIndex();
    q = await createQueryApplication(e.home);
    const input = parseKnowledgeContextRequest({
      ...request(),
      scope: { kind: "literatures", literature_ids: [e.id] },
      kinds: ["metadata", "knowledge"],
    });
    const before = await q.knowledgeContext!.search(input);
    expect(before.coverage).toBe("complete");
    expect(before.items.some((item) => item.kind === "generated-result")).toBe(
      true,
    );
    const calls = e.modelCalls;
    const db = new DatabaseSync(join(e.home, "catalog.sqlite"));
    try {
      db.exec("UPDATE literature_metadata SET title=title");
    } finally {
      db.close();
    }
    const stale = await q.knowledgeContext!.search(input);
    expect(stale.coverage).toBe("index-stale");
    expect(stale.items).toEqual(before.items);
    const result = stale.items.find(
      (item) => item.kind === "generated-result",
    )!;
    expect(result.evidence.length).toBeGreaterThan(0);
    const first = await q.knowledgeContext!.search({
      ...input,
      budget: { ...input.budget, max_items: 1 },
    });
    expect(first.items[0]!.kind).toBe("metadata");
    expect(first.continuation).not.toBeNull();
    const continuation = {
      ...input,
      budget: { ...input.budget, max_items: 1 },
      continuation: first.continuation,
    };
    const second = await q.knowledgeContext!.search(continuation);
    expect(second.items[0]!.kind).toBe("generated-result");
    expect(second.coverage).toBe("index-stale");
    expect(second.gaps).toContainEqual({
      code: "material-index-stale",
      literature_id: null,
    });
    expect(
      (await q.knowledgeContext!.search({ ...input, kinds: ["knowledge"] }))
        .coverage,
    ).toBe("complete");
    expect(e.modelCalls).toBe(calls);
    const refresh = await e.app.maintenance!.refreshIndex!();
    expect(refresh.status, JSON.stringify(refresh)).toBe("updated");
    await expect(
      q.knowledgeContext!.search(continuation),
    ).rejects.toMatchObject({ code: "context-cursor-invalid" });
    const after = await q.knowledgeContext!.search(input);
    expect(after.coverage).toBe("complete");
    expect(after.items).toEqual(before.items);
  } finally {
    await q?.close();
    await e.close();
  }
}, 30000);

it("skips changed source hits, bounds their knowledge-context gaps and rejects a source-phase cursor after refresh", async () => {
  const e = await coreProcessingFixture();
  let q: Awaited<ReturnType<typeof createQueryApplication>> | undefined;
  try {
    for (let n = 100; n < 168; n += 2)
      await e.app.database.putLiterature(
        paper(n, "synthetic synthetic synthetic synthetic"),
      );
    await e.app.database.putLiterature(paper(40, "synthetic surviving"));
    await e.app.maintenance!.rebuildIndex();
    for (let n = 100; n < 168; n += 2)
      await e.app.database.putLiterature(
        paper(n, "newmarker changed metadata"),
      );
    q = await createQueryApplication(e.home);
    const scoped = await q.knowledgeContext!.search({
      ...request(1),
      scope: {
        kind: "literatures",
        literature_ids: [id(100), FIXTURE_LITERATURE.literature_id],
      },
    });
    expect(scoped.gaps).toContainEqual({
      code: "index-stale",
      literature_id: id(100),
    });
    expect(scoped.items[0]!.kind).toBe("metadata");
    const input = request(1),
      stale = await q.knowledgeContext!.search(input);
    expect(stale.coverage).toBe("index-stale");
    expect(stale.items).toHaveLength(1);
    expect(stale.items[0]!.kind).toBe("metadata");
    expect(stale.gaps.length).toBeLessThanOrEqual(32);
    expect(stale.gaps).toContainEqual({
      code: "index-stale",
      literature_id: null,
    });
    expect(stale.gaps).toContainEqual({
      code: "material-index-stale",
      literature_id: null,
    });
    const item = stale.items[0]!;
    if (item.kind !== "metadata") throw Error("expected metadata");
    expect([FIXTURE_LITERATURE.literature_id, id(40)]).toContain(
      item.literature_id,
    );
    expect(stale.continuation).not.toBeNull();
    const refresh = await e.app.maintenance!.refreshIndex!();
    expect(refresh.status, JSON.stringify(refresh)).toBe("updated");
    await expect(
      q.knowledgeContext!.search({
        ...input,
        continuation: stale.continuation,
      }),
    ).rejects.toMatchObject({ code: "context-cursor-invalid" });
    const after = await q.knowledgeContext!.search({
      ...request(),
      query: "newmarker",
    });
    expect(after.items.length).toBeGreaterThan(0);
    expect(after.items.every((item) => item.text.includes("newmarker"))).toBe(
      true,
    );
  } finally {
    await q?.close();
    await e.close();
  }
}, 30000);
