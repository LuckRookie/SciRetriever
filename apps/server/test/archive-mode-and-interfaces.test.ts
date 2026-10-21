import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import {
  parseLiterature,
  parseRawParseInput,
  rawParseIdentity,
} from "@sciretriever/contracts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { archiveFixture } from "./archive-fixture.js";
import { SqliteProofreadStorage } from "../src/storage/proofread.js";
import { createQueryApplication } from "../src/bootstrap/application.js";
import { executeQuery } from "../src/entry/query-operations.js";
import { createMcpServer } from "../src/mcp/server.js";
import { runCli } from "../src/cli/main.js";
it("uses the explicitly registered Markdown-only VLM source and exposes read-only CLI/MCP status", async () => {
  const e = await archiveFixture();
  try {
    const { convertMinerURawArchive } = await import(
      "../src/parsing/backends/mineru/archive.js"
    );
    const { rawParseArchive } = await import("./raw-parse-fixture.js");
    const text =
      "# Introduction\n\nFixture Author studies synthetic spectroscopy.\n\n# References\n\n[1] Example synthetic reference.\n";
    e.setText(text);
    const staged = await convertMinerURawArchive(
      rawParseArchive("vlm-engine", { markdown: text }),
      {
        source_asset_id: e.asset.asset_id,
        source_sha256: e.asset.sha256,
        profile: "vlm-engine",
        model_identity: "synthetic",
      },
    );
    const { raw_parse_id: _id, result_sha256: _sha, ...source } = staged.result;
    void _id;
    void _sha;
    const input = parseRawParseInput({
      ...source,
      profile: "vlm-engine-markdown-only",
      blocks: null,
      private_content_list: null,
      page_sizes: [],
    });
    const legacy = { ...input, ...(await rawParseIdentity(input)) };
    await e.app.rawParseStorage!.publish({
      result: legacy,
      markdown: staged.markdown,
      resources: staged.resources,
      blocks: null,
      private_content_list: null,
    });
    expect(
      (await e.app.rawParseStorage!.current(e.asset.asset_id))
        .filter((r) => r.result)
        .map((r) => r.profile),
    ).toEqual(["vlm-engine-markdown-only"]);
    const job = await e.app.processingTasks!.submit({
      schema_version: 1,
      idempotency_key: "legacy-mode",
      operations: [
        {
          operation: "build-archive",
          request: {
            literature_id: e.id,
            mode: "legacy-vlm-markdown",
            from_step: null,
          },
        },
      ],
    });
    await e.app.processingTasks!.run(job.job_id);
    const state = await e.app.archive.status(e.id);
    expect(state.status).toBe("READY");
    expect(e.parseCalls).toBe(0);
    const proof = await new SqliteProofreadStorage(
      e.app.database,
      e.app.files,
    ).byId(state.parts[0]!.proofread_id!);
    expect(proof!.draft_input.raw_parse_id).toBe(legacy.raw_parse_id);
    const q = await createQueryApplication(e.home);
    try {
      expect(
        await executeQuery(q, "archive", {
          operation: "status",
          request: { literature_id: e.id },
        }),
      ).toMatchObject({ status: "READY", mode: "legacy-vlm-markdown" });
    } finally {
      await q.close();
    }
    let out = "";
    expect(
      await runCli(["archive", "status", e.id], {
        home: e.home,
        stdout: (text) => {
          out += text;
        },
      }),
    ).toMatchObject({ code: 0 });
    expect(JSON.parse(out).status).toBe("READY");
    const server = createMcpServer({ home: e.home }),
      client = new Client({ name: "archive-fixture", version: "1" }),
      [a, b] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(a);
      await client.connect(b);
      const response = await client.callTool({
        name: "archive_query",
        arguments: { operation: "status", request: { literature_id: e.id } },
      });
      expect(response.isError).not.toBe(true);
      expect(JSON.stringify(response)).toContain("READY");
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    await e.close();
  }
}, 0);
it("executes archive members concurrently under one existing queue lease", async () => {
  const e = await archiveFixture();
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  try {
    await e.app.documentProcessing.parseDocuments(e.rawParseRequest);
    const first = (await e.app.library.detail(e.id)).literature;
    const second = parseLiterature({
      ...first,
      literature_id: randomUUID(),
      meta_literature_id: randomUUID(),
      metadata: { ...first.metadata, identifiers: [] },
    });
    await e.app.database.putLiterature(second);
    await e.app.database.putLiteratureAsset({
      literature_asset_id: randomUUID(),
      literature_id: second.literature_id,
      asset: e.asset,
      role: "primary-pdf",
      source_url: null,
      provenance: {
        provenance_id: randomUUID(),
        source_kind: "user",
        source_name: "fixture",
        source_record_id: null,
        observed_at: "2026-10-20T00:00:00Z",
        input_sha256: e.asset.sha256,
        parameters_sha256: null,
      },
    });
    let entered = 0,
      notify!: () => void;
    const both = new Promise<void>((r) => {
      notify = r;
    });
    const original = e.app.archiveMetadata.build.bind(e.app.archiveMetadata);
    vi.spyOn(e.app.archiveMetadata, "build").mockImplementation(
      async (v, signal) => {
        entered++;
        if (entered === 2) notify();
        await gate;
        return original(v, signal);
      },
    );
    const job = await e.app.processingTasks!.submit({
      schema_version: 1,
      idempotency_key: "parallel",
      operations: [e.id, second.literature_id].map((literature_id) => ({
        operation: "build-archive",
        request: { literature_id, mode: "full", from_step: null },
      })),
    });
    const run = e.app.processingTasks!.run(job.job_id);
    try {
      await Promise.race([
        both,
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error("archive members did not overlap")),
            3000,
          ),
        ),
      ]);
    } finally {
      release();
      await run;
    }
    const result = await e.app.processingTasks!.read(job.job_id);
    expect(result.failures).toEqual([]);
    expect(result.results).toHaveLength(2);
  } finally {
    release();
    vi.restoreAllMocks();
    await e.close();
  }
}, 0);
