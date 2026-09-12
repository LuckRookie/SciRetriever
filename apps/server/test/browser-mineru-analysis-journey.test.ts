import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { TypeScriptConfigurationOwner } from "../src/configuration/owner.js";
import { startSyntheticWorkbench } from "../src/bootstrap/workbench.js";
import { verifyInstalledCloakRuntime } from "../src/configuration/cloak-runtime.js";
import { FIXTURE_LITERATURE } from "../src/workbench/synthetic-fixture.js";

const bundle = process.env.SCIRETRIEVER_CLOAK_BUNDLE;

async function mineruArchive(): Promise<Buffer> {
  const fixtureRoot = resolve("tests/fixtures/parsing/mineru");
  const middle = JSON.parse(
    await readFile(join(fixtureRoot, "document_middle.json"), "utf8"),
  ) as { pdf_info: unknown[] };
  const content = JSON.parse(
    await readFile(join(fixtureRoot, "document_content_list.json"), "utf8"),
  ) as unknown[];
  return zip([
    {
      name: "document.md",
      bytes: await readFile(join(fixtureRoot, "document.md")),
    },
    {
      name: "document_middle.json",
      bytes: Buffer.from(
        JSON.stringify({ ...middle, pdf_info: middle.pdf_info.slice(0, 1) }),
      ),
    },
    {
      name: "document_model.json",
      bytes: await readFile(join(fixtureRoot, "document_model.json")),
    },
    {
      name: "document_content_list.json",
      bytes: Buffer.from(JSON.stringify(content.slice(0, 1))),
    },
    {
      name: "images/figure.png",
      bytes: Buffer.from(
        await readFile(join(fixtureRoot, "figure.png.base64"), "utf8"),
        "base64",
      ),
    },
    {
      name: "private/debug.json",
      bytes: Buffer.from("PRIVATE-ARCHIVE-SENTINEL"),
    },
  ]);
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1)
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zip(entries: readonly { name: string; bytes: Uint8Array }[]): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const header = Buffer.alloc(30 + name.length);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x800, 6);
    header.writeUInt32LE(crc32(entry.bytes), 14);
    header.writeUInt32LE(entry.bytes.length, 18);
    header.writeUInt32LE(entry.bytes.length, 22);
    header.writeUInt16LE(name.length, 26);
    name.copy(header, 30);
    local.push(header, Buffer.from(entry.bytes));
    const directory = Buffer.alloc(46 + name.length);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(0x800, 8);
    directory.writeUInt32LE(crc32(entry.bytes), 16);
    directory.writeUInt32LE(entry.bytes.length, 20);
    directory.writeUInt32LE(entry.bytes.length, 24);
    directory.writeUInt16LE(name.length, 28);
    directory.writeUInt32LE(offset, 42);
    name.copy(directory, 46);
    central.push(directory);
    offset += header.length + entry.bytes.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(Buffer.concat(central).length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...central, end]);
}

async function startMineru(): Promise<{
  readonly origin: string;
  readonly calls: string[];
  close(): Promise<void>;
}> {
  const archive = await mineruArchive();
  const calls: string[] = [];
  const server = createServer(async (request, response) => {
    calls.push(`${request.method} ${request.url}`);
    for await (const _chunk of request) void _chunk;
    if (request.url === "/health") {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          status: "healthy",
          version: "3.4.4",
          protocol_version: 2,
        }),
      );
      return;
    }
    if (request.url === "/tasks" && request.method === "POST") {
      response.statusCode = 202;
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({ task_id: "browser-mineru", status: "pending" }),
      );
      return;
    }
    if (request.url === "/tasks/browser-mineru") {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({ task_id: "browser-mineru", status: "completed" }),
      );
      return;
    }
    if (request.url === "/tasks/browser-mineru/result") {
      response.setHeader("content-type", "application/zip");
      response.end(archive);
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  await new Promise<void>((resolveServer) =>
    server.listen(0, "127.0.0.1", resolveServer),
  );
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("MinerU fixture unavailable");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    calls,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolveClose, reject) =>
        server.close((error) => (error ? reject(error) : resolveClose())),
      );
    },
  };
}

it.skipIf(!bundle)(
  "runs Browser capture through the actual MinerU HTTP bridge and Analysis before Library query",
  async () => {
    const home = await mkdtemp(
      join(tmpdir(), "sciretriever-browser-mineru-analysis-"),
    );
    const mineru = await startMineru();
    let modelCalls = 0;
    const model = createServer(async (request, response) => {
      for await (const _chunk of request) void _chunk;
      modelCalls++;
      const value =
        modelCalls === 1
          ? { outcome: "usable", metadata: FIXTURE_LITERATURE.metadata }
          : {
              markdown:
                "# 研究背景与目标\n\nBrowser MinerU Analysis journey.\n\n# 研究方法\n\nLoopback fixture.\n\n# 数据\n\n未提供\n\n# 结论与局限性\n\n未提供\n\n# 参考文献\n\n未提供\n",
            };
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          model: "journey-model",
          choices: [
            {
              finish_reason: "stop",
              message: { content: JSON.stringify(value) },
            },
          ],
          usage: { prompt_tokens: 20, completion_tokens: 30 },
        }),
      );
    });
    await new Promise<void>((resolveServer) =>
      model.listen(0, "127.0.0.1", resolveServer),
    );
    const address = model.address();
    if (!address || typeof address === "string")
      throw new Error("model fixture unavailable");
    const owner = new TypeScriptConfigurationOwner(home);
    await owner.publish(
      `[providers.fixture]\napi = "openai-chat-completions"\nbase_url = "http://127.0.0.1:${address.port}/v1"\n[models."fixture/journey-model"]\nstream = false\n[analyze]\nmodel = "fixture/journey-model"\nmetadata_max_output_tokens = 2048\ncontent_max_output_tokens = 4096\nmax_input_bytes = 1048576\nmax_chunk_bytes = 1048576\nmax_chunk_count = 1\nmax_total_llm_requests = 2\nmax_total_output_tokens = 6144\n[parsing]\nbase_url = "${mineru.origin}"\nconnection_mode = "loopback"\nmodel_identity = "operator-vlm-model@fixture-revision"\n`,
      "missing",
      ["providers", "models", "analyze", "parsing"],
    );
    const browserRuntime = await verifyInstalledCloakRuntime(bundle!);
    let workbench:
      | Awaited<ReturnType<typeof startSyntheticWorkbench>>
      | undefined;
    try {
      workbench = await startSyntheticWorkbench({
        home,
        runtime: browserRuntime,
        assets: new Map(),
        configurationOwner: owner,
      });
      const client = workbench.session.attach();
      workbench.session.takeover(
        client,
        workbench.session.view().control.epoch,
      );
      const observation = workbench.session.view().observation!;
      const download = observation.elements.find(
        (element) => element.name === "Download PDF",
      );
      if (!download) throw new Error("download action unavailable");
      await workbench.session.command(client, {
        session_id: observation.session_id,
        page_id: observation.page_id,
        document_generation: observation.document_generation,
        observation_revision: observation.observation_revision,
        viewport_revision: observation.viewport_revision,
        control_epoch: workbench.session.view().control.epoch,
        request_id: "browser-mineru-download",
        input: {
          kind: "click-element",
          element_id: download.element_id,
          revision: observation.observation_revision,
        },
      });
      await expect
        .poll(() => workbench!.session.view().candidates.length, {
          timeout: 15000,
        })
        .toBe(1);
      const candidate = workbench.session.view().candidates[0]!;
      await workbench.session.acceptCandidate(client, {
        session_id: workbench.session.id,
        control_epoch: workbench.session.view().control.epoch,
        transfer_id: candidate.transfer_id,
        sha256: candidate.sha256,
      });
      const completion = await workbench.application.completion!.complete({
        literature_id: FIXTURE_LITERATURE.literature_id,
        transfer_ids: [],
      });
      expect(completion.outcome).toBe("content_ready");
      const detail = await workbench.application.library.detail(
        FIXTURE_LITERATURE.literature_id,
      );
      expect(detail.literature.status).toBe("CONTENT_READY");
      expect(detail.parser_result?.provenance.provenance.source_name).toBe(
        "mineru",
      );
      expect(detail.parser_result?.provenance.model_identity).toBe(
        "operator-vlm-model@fixture-revision",
      );
      expect(detail.content?.sections[0]?.markdown).toContain(
        "Browser MinerU Analysis journey",
      );
      expect(detail.content?.provenance.source_name).toBe(
        "fixture/journey-model",
      );
      expect(modelCalls).toBe(2);
      expect(mineru.calls).toEqual([
        "GET /health",
        "POST /tasks",
        "GET /tasks/browser-mineru",
        "GET /tasks/browser-mineru/result",
      ]);
      expect(
        await workbench.application.library.search({
          query: { text: "Browser MinerU Analysis" },
          limit: 10,
          sort: "relevance",
          cursor: null,
        }),
      ).toMatchObject({
        items: [
          { literature: { literature_id: FIXTURE_LITERATURE.literature_id } },
        ],
      });
    } finally {
      await workbench?.close();
      model.closeAllConnections();
      await new Promise<void>((resolveClose, reject) =>
        model.close((error) => (error ? reject(error) : resolveClose())),
      );
      await mineru.close();
      await rm(home, { recursive: true, force: true });
    }
  },
  120_000,
);
