import { ContentAnalysisService } from "../src/entry/content-analysis.js";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import {
  parseAsset,
  parseArtifactRef,
  parseProvenance,
  sha256,
  type LiteratureDetail,
} from "@sciretriever/contracts";
import {
  createApplication,
  type ApplicationOptions,
} from "../src/bootstrap/application.js";
import { createServer } from "node:http";
import {
  FIXTURE_LITERATURE,
  workbenchPdf,
} from "../src/workbench/synthetic-fixture.js";
import { TypeScriptParserArtifactRules } from "../src/parsing/artifact-rules.js";
import {
  AnalysisService,
  type AnalysisLimits,
} from "../src/analysis/service.js";
import { AgentRuntime } from "../src/agents/runtime.js";
import { OpenAIChatAdapter } from "../src/agents/openai.js";
import { DatabaseSync } from "node:sqlite";
import { TypeScriptConfigurationOwner } from "../src/configuration/owner.js";
const id = (n: number) =>
  `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const limits: AnalysisLimits = {
  metadata_max_output_tokens: 2048,
  content_max_output_tokens: 4096,
  max_input_bytes: 1024 * 1024,
  max_chunk_bytes: 1024 * 1024,
  max_chunk_count: 1,
  max_total_llm_requests: 2,
  max_total_output_tokens: 6144,
};
const draft =
  "# 研究背景与目标\n\nThe fixture studies spectroscopy.\n\n# 研究方法\n\n未提供\n\n# 数据\n\n未提供\n\n# 结论与局限性\n\n未提供\n\n# 参考文献\n\n1. Fixture reference.\n";
it("assembles Analysis from the actual configuration owner and refuses incomplete budgets", async () => {
  const home = await mkdtemp(join(tmpdir(), "sciretriever-analysis-assembly-"));
  const owner = new TypeScriptConfigurationOwner(home);
  const payload =
    '[providers.fixture]\napi = "openai-chat-completions"\nbase_url = "https://fixture.example.test/v1"\n[models."fixture/model"]\nstream = false\n[analyze]\nmodel = "fixture/model"\n';
  let app: Awaited<ReturnType<typeof createApplication>> | undefined;
  try {
    const baseline = await owner.publish(payload, "missing", [
      "providers",
      "models",
      "analyze",
    ]);
    await owner.credential(
      {
        namespace: "model",
        target: "fixture",
        kind: "set",
        value: "synthetic-assembly-key",
      },
      baseline.revision,
    );
    await expect(
      createApplication(home, {
        configurationOwner: owner,
        analysisRuntime: {},
      }),
    ).rejects.toMatchObject({ code: "analysis-configuration" });
    await owner.publish(
      payload +
        Object.entries(limits)
          .map(([key, value]) => `${key} = ${value}\n`)
          .join(""),
      baseline.revision,
      ["analyze"],
    );
    app = await createApplication(home, {
      configurationOwner: owner,
    });
    expect(app.analysis).toBeInstanceOf(AnalysisService);
    expect(app.agents.identity("analysis")).toMatchObject({
      provider: "fixture",
      model: "model",
      stream: false,
    });
    await app.close();
    await expect(
      app.analysis!.analyzeContent(FIXTURE_LITERATURE.literature_id),
    ).rejects.toMatchObject({ code: "analysis-cancelled" });
  } finally {
    await app?.close();
    await rm(home, { recursive: true, force: true });
  }
}, 30000);
async function setup(
  configure?: (home: string) => Promise<ApplicationOptions>,
) {
  const home = await mkdtemp(join(tmpdir(), "sciretriever-analysis-"));
  const app = await createApplication(home, {
    ...(await configure?.(home)),
    parsing: {
      rules: new TypeScriptParserArtifactRules(),
      parser: {
        parse: async (r) => {
          const bytes = Buffer.from(
            `# ${FIXTURE_LITERATURE.metadata.title}\n\nThe fixture studies spectroscopy.\n\n# References\n\n1. Fixture reference.\n`,
          );
          return {
            source_asset_id: r.source_asset_id,
            source_sha256: r.source_sha256,
            page_count: 1,
            markdown: {
              artifact: parseArtifactRef({
                sha256: await sha256(bytes),
                byte_size: bytes.length,
                media_type: "text/markdown",
              }),
              bytes,
            },
            resources: [],
            provenance: {
              provenance: parseProvenance({
                provenance_id: id(33),
                source_kind: "parser",
                source_name: "fixture",
                source_record_id: null,
                observed_at: "2026-09-10T00:00:00Z",
                input_sha256: r.source_sha256,
                parameters_sha256: "a".repeat(64),
              }),
              parser_version: "fixture",
              mode: null,
              model_identity: null,
            },
          };
        },
      },
    },
  });
  await app.database.putLiterature(FIXTURE_LITERATURE);
  const pdf = workbenchPdf(),
    stage = await app.files.stage();
  await stage.write(pdf);
  await app.files.publish(stage, "objects/source.pdf");
  const asset = parseAsset({
    asset_id: id(30),
    sha256: await sha256(pdf),
    size_bytes: pdf.length,
    media_type: "application/pdf",
    path: "objects/source.pdf",
  });
  await app.database.putLiteratureAsset({
    literature_asset_id: id(31),
    literature_id: FIXTURE_LITERATURE.literature_id,
    asset,
    role: "primary-pdf",
    source_url: null,
    provenance: {
      provenance_id: id(32),
      source_kind: "asset-provider",
      source_name: "fixture",
      source_record_id: null,
      observed_at: "2026-09-10T00:00:00Z",
      input_sha256: asset.sha256,
      parameters_sha256: null,
    },
  });
  await app.parsing!.commitCurrentPrimary(
    await app.parsing!.prepareCurrentPrimary(FIXTURE_LITERATURE.literature_id),
  );
  return {
    app,
    home,
    close: async () => {
      await app.close();
      await rm(home, { recursive: true, force: true });
    },
  };
}
function agent(
  actions: ((
    request: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<unknown> | unknown)[],
) {
  const calls: Record<string, unknown>[] = [];
  const adapter = new OpenAIChatAdapter({
    provider: "fixture",
    model: "fixture-model",
    endpoint: "https://model.example.test/v1/chat/completions",
    credential: "synthetic-analysis-key",
    transport: async (request) => {
      const body = JSON.parse(Buffer.from(request.body).toString()) as Record<
        string,
        unknown
      >;
      calls.push(body);
      const action = actions.shift();
      if (!action) throw new Error("unexpected model request");
      const result = await action(body, request.signal);
      return {
        status: 200,
        headers: [["content-type", "application/json"]],
        body: Buffer.from(
          JSON.stringify({
            model: "fixture-model",
            choices: [
              {
                message: { content: JSON.stringify(result) },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 20, completion_tokens: 40 },
          }),
        ),
      };
    },
  });
  return {
    calls,
    runtime: new AgentRuntime([
      {
        role: "analysis",
        provider: "fixture",
        model: "fixture-model",
        capabilities: ["structured_text"],
        reasoning: "default",
        stream: false,
        context_window_tokens: 1000000,
        max_output_tokens: 10000,
        adapter,
      },
    ]),
  };
}
function service(
  env: Awaited<ReturnType<typeof setup>>,
  runtime: AgentRuntime,
  override: Partial<AnalysisLimits> = {},
  library?: { detail(id: string): Promise<LiteratureDetail> },
) {
  return new AnalysisService(
    library ?? env.app.library,
    env.app.literatureArtifacts,
    env.app.files,
    runtime,
    {
      limits: { ...limits, ...override },
    },
  );
}
it("runs configured Analysis through actual loopback model HTTP and accepts the canonical result", async () => {
  const requests: {
    headers: Record<string, unknown>;
    body: Record<string, unknown>;
  }[] = [];
  const http = createServer(async (req, res) => {
    const parts: Buffer[] = [];
    for await (const part of req) parts.push(Buffer.from(part as Uint8Array));
    requests.push({
      headers: req.headers,
      body: JSON.parse(Buffer.concat(parts).toString()) as Record<
        string,
        unknown
      >,
    });
    const value =
      requests.length === 1
        ? { outcome: "usable", metadata: FIXTURE_LITERATURE.metadata }
        : { markdown: draft };
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        model: "model",
        choices: [
          {
            finish_reason: "stop",
            message: { content: JSON.stringify(value) },
          },
        ],
        usage: { prompt_tokens: 20, completion_tokens: 40 },
      }),
    );
  });
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  const address = http.address();
  if (!address || typeof address === "string")
    throw new Error("fixture listen failed");
  let env: Awaited<ReturnType<typeof setup>> | undefined;
  try {
    env = await setup(async (home) => {
      const owner = new TypeScriptConfigurationOwner(home);
      await owner.publish(
        `[providers.fixture]\napi = "openai-chat-completions"\nbase_url = "http://127.0.0.1:${address.port}/v1"\n[models."fixture/model"]\nstream = false\n[analyze]\nmodel = "fixture/model"\n` +
          Object.entries(limits)
            .map(([key, value]) => `${key} = ${value}\n`)
            .join(""),
        "missing",
        ["providers", "models", "analyze"],
      );
      // Complete analysis budgets are enough for the Application to assemble
      // the pure TypeScript Analysis owner; no Python runtime is supplied.
      return { configurationOwner: owner };
    });
    expect(requests).toHaveLength(0);
    const result = await env.app.contentAnalysis!.analyzeCurrent(
      FIXTURE_LITERATURE.literature_id,
    );
    if (result.outcome !== "content_accepted")
      throw new Error("missing accepted content");
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request.headers).not.toHaveProperty("authorization");
      expect(request.body.response_format).toMatchObject({
        type: "json_schema",
      });
      expect(request.body.messages).toEqual([
        {
          role: "system",
          content: [{ type: "text", text: expect.any(String) }],
        },
        { role: "user", content: [{ type: "text", text: expect.any(String) }] },
      ]);
    }
    const detail = await env.app.library.detail(
      FIXTURE_LITERATURE.literature_id,
    );
    expect(detail.literature.status).toBe("CONTENT_READY");
    expect(detail.content?.provenance.source_name).toBe("fixture/model");
    expect(result.content).toEqual(detail.content);
  } finally {
    await env?.close();
    http.closeAllConnections();
    await new Promise<void>((r, j) => http.close((e) => (e ? j(e) : r())));
  }
}, 30000);
it("executes both actual Analysis stages through TS AgentRuntime and OpenAI wire adapter, renders canonical Markdown and accepts the proposal", async () => {
  const env = await setup();
  const before = await env.app.library.detail(FIXTURE_LITERATURE.literature_id);
  const a = agent([
    () => ({ outcome: "usable", metadata: before.literature.metadata }),
    () => ({ markdown: draft }),
  ]);
  const s = service(env, a.runtime);
  try {
    const result = await s.analyzeContent(FIXTURE_LITERATURE.literature_id);
    expect(result.outcome).toBe("proposal");
    if (result.outcome !== "proposal") throw new Error("missing proposal");
    expect(a.calls).toHaveLength(2);
    expect(a.calls[0]!.response_format).toMatchObject({
      type: "json_schema",
      json_schema: {
        schema: { properties: { metadata: { anyOf: expect.any(Array) } } },
      },
    });
    expect(Buffer.from(result.markdownBytes).toString()).toContain("# 元数据");
    expect(Buffer.from(result.markdownBytes).toString()).toContain(
      "# 研究背景与目标",
    );
    expect(result.proposal.provenance.source_name).toBe(
      "fixture/fixture-model",
    );
    expect(result.proposal.input_metadata_revision).toBe(
      before.metadata_revision,
    );
    expect(
      (await env.app.library.detail(FIXTURE_LITERATURE.literature_id)).content,
    ).toBeNull();
    const content = await env.app.literatureContent.accept(
      result.proposal,
      result.markdownBytes,
    );
    const detail = await env.app.library.detail(
      FIXTURE_LITERATURE.literature_id,
    );
    expect(detail.content).toEqual(content);
    expect(detail.literature.status).toBe("CONTENT_READY");
    expect(
      (await env.app.library.search({ query: { text: "spectroscopy" } }))
        .total_count,
    ).toBe(1);
  } finally {
    s.close();
    a.runtime.close();
    await env.close();
  }
});
it.each(["metadata", "content", "no-content"] as const)(
  "handles %s responses without publishing an invalid final result",
  async (mode) => {
    const env = await setup();
    const before = await env.app.library.detail(
      FIXTURE_LITERATURE.literature_id,
    );
    const a = agent([
      () =>
        mode === "no-content"
          ? { outcome: "no_usable_content", metadata: null }
          : {
              outcome: "usable",
              metadata: {
                ...before.literature.metadata,
                ...(mode === "metadata" ? { title: "fabricated title" } : {}),
              },
            },
      () => ({ markdown: "# Invalid content\n" }),
    ]);
    const s = service(env, a.runtime);
    try {
      const pending = s.analyzeContent(FIXTURE_LITERATURE.literature_id);
      if (mode === "no-content")
        await expect(pending).resolves.toEqual({
          outcome: "no_usable_content",
          input: {
            literature_id: FIXTURE_LITERATURE.literature_id,
            primary_asset_id: before.primary_pdf!.asset.asset_id,
            primary_pdf_sha256: before.primary_pdf!.asset.sha256,
            parser_result_sha256: before.parser_result!.result_sha256,
            input_metadata_revision: before.metadata_revision,
            input_metadata_sha256: before.metadata_sha256,
          },
        });
      else
        await expect(pending).rejects.toMatchObject({
          code:
            mode === "metadata"
              ? "analysis-metadata-proposal"
              : "analysis-content-draft",
        });
      expect(a.calls).toHaveLength(mode === "content" ? 2 : 1);
      expect(
        await env.app.library.detail(FIXTURE_LITERATURE.literature_id),
      ).toEqual(before);
      if (mode === "no-content") {
        const decision = await pending;
        const cleaned = await env.app.literatureCleanup.cleanup(decision);
        expect(cleaned.outcome).toBe("catalog_cleaned");
        const after = await env.app.library.detail(
          FIXTURE_LITERATURE.literature_id,
        );
        expect(after.primary_pdf).toBeNull();
        expect(after.parser_result).toBeNull();
        expect(after.content).toBeNull();
        expect(after.literature.metadata).toEqual(before.literature.metadata);
      }
    } finally {
      s.close();
      a.runtime.close();
      await env.close();
    }
  },
);
it("rechecks current inputs around the model stages and rejects a changed parser before publication", async () => {
  const env = await setup();
  const before = await env.app.library.detail(FIXTURE_LITERATURE.literature_id);
  const raw = new DatabaseSync(join(env.home, "catalog.sqlite"));
  const a = agent([
    () => ({ outcome: "usable", metadata: before.literature.metadata }),
    () => {
      raw
        .prepare("UPDATE parser_results SET result_sha256=?")
        .run("0".repeat(64));
      return { markdown: draft };
    },
  ]);
  const s = service(env, a.runtime);
  try {
    await expect(
      s.analyzeContent(FIXTURE_LITERATURE.literature_id),
    ).rejects.toThrow();
    expect(a.calls).toHaveLength(2);
    expect(
      (await env.app.database.snapshotCounts()).tables.literature_contents,
    ).toBe(0);
  } finally {
    raw.close();
    s.close();
    a.runtime.close();
    await env.close();
  }
});
it("enforces operation budgets before requesting a model and cancels a pending model call on close", async () => {
  const env = await setup();
  const empty = agent([]);
  const bounded = service(env, empty.runtime, { max_total_llm_requests: 1 });
  let started: () => void = () => {};
  const waiting = new Promise<void>((r) => {
    started = r;
  });
  const a = agent([
    async (_request, signal) => {
      started();
      await new Promise<void>((r) =>
        signal!.addEventListener("abort", () => r(), { once: true }),
      );
      throw new Error("cancelled fixture transport");
    },
  ]);
  const s = service(env, a.runtime);
  try {
    await expect(
      bounded.analyzeContent(FIXTURE_LITERATURE.literature_id),
    ).rejects.toMatchObject({ code: "analysis-content-budget" });
    expect(empty.calls).toHaveLength(0);
    const pending = s.analyzeContent(FIXTURE_LITERATURE.literature_id);
    await Promise.race([
      waiting,
      pending.then(() => {
        throw new Error("unexpected completion");
      }),
    ]);
    s.close();
    await expect(pending).rejects.toMatchObject({ code: "analysis-cancelled" });
    expect(
      (await env.app.library.detail(FIXTURE_LITERATURE.literature_id)).content,
    ).toBeNull();
  } finally {
    bounded.close();
    s.close();
    empty.runtime.close();
    a.runtime.close();
    await env.close();
  }
});

it("runs actual Analysis through Entry into no-content catalog and physical cleanup", async () => {
  const env = await setup();
  const a = agent([() => ({ outcome: "no_usable_content", metadata: null })]);
  const s = service(env, a.runtime);
  const entry = new ContentAnalysisService(
    s,
    env.app.literatureContent,
    env.app.noUsableContent,
  );
  try {
    const before = await env.app.library.detail(
      FIXTURE_LITERATURE.literature_id,
    );
    const result = await entry.analyzeCurrent(FIXTURE_LITERATURE.literature_id);
    expect(result.outcome).toBe("no_usable_content_cleaned");
    if (result.outcome !== "no_usable_content_cleaned")
      throw new Error("unexpected outcome");
    expect(result.reclamation.deleted).toHaveLength(2);
    expect(a.calls).toHaveLength(1);
    for (const ref of result.reclamation.deleted)
      await expect(
        env.app.files.read(ref, 16 * 1024 * 1024),
      ).rejects.toBeInstanceOf(Error);
    const after = await env.app.library.detail(
      FIXTURE_LITERATURE.literature_id,
    );
    expect(after.primary_pdf).toBeNull();
    expect(after.parser_result).toBeNull();
    expect(after.literature.metadata).toEqual(before.literature.metadata);
  } finally {
    await entry.close();
    s.close();
    a.runtime.close();
    await env.close();
  }
});
