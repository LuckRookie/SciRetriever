import { expect, it } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import {
  parseArtifactRef,
  analysisInputSha256,
  parseProvenance,
  sha256,
} from "@sciretriever/contracts";
import { createApplication } from "../src/bootstrap/application.js";
import { TypeScriptConfigurationOwner } from "../src/configuration/owner.js";
import { TypeScriptParserArtifactRules } from "../src/parsing/artifact-rules.js";
import { ParsingFailure } from "../src/parsing/ports.js";
import {
  FIXTURE_LITERATURE,
  workbenchPdf,
} from "../src/workbench/synthetic-fixture.js";
const lit = FIXTURE_LITERATURE.literature_id;
const draft =
  "# 研究背景与目标\n\nThe fixture studies spectroscopy.\n\n# 研究方法\n\n未提供\n\n# 数据\n\n未提供\n\n# 结论与局限性\n\n未提供\n\n# 参考文献\n\n1. Fixture reference.\n";
async function fixture(
  mode:
    | "retry"
    | "parser-failure"
    | "model-failure"
    | "unusable"
    | "wait-model" = "retry",
) {
  const home = await mkdtemp(join(tmpdir(), "sciretriever-completion-"));
  let modelEntered: () => void = () => {};
  const modelStarted = new Promise<void>((r) => {
    modelEntered = r;
  });
  let calls = 0,
    parses = 0;
  const http = createServer(async (req, res) => {
    for await (const part of req) void part;
    calls++;
    modelEntered();
    if (mode === "wait-model") return;
    if (mode === "model-failure") {
      res.writeHead(503);
      res.end("unavailable");
      return;
    }
    const result =
      mode === "unusable" || calls === 1
        ? { outcome: "no_usable_content", metadata: null }
        : calls === 2
          ? { outcome: "usable", metadata: FIXTURE_LITERATURE.metadata }
          : { markdown: draft };
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        model: "model",
        choices: [
          {
            finish_reason: "stop",
            message: { content: JSON.stringify(result) },
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
  const owner = new TypeScriptConfigurationOwner(home);
  await owner.publish(
    `[providers.fixture]\napi = "openai-chat-completions"\nbase_url = "http://127.0.0.1:${address.port}/v1"\n[models."fixture/model"]\nstream = false\n[analyze]\nmodel = "fixture/model"\nmetadata_max_output_tokens = 2048\ncontent_max_output_tokens = 4096\nmax_input_bytes = 1048576\nmax_chunk_bytes = 1048576\nmax_chunk_count = 1\nmax_total_llm_requests = 2\nmax_total_output_tokens = 6144\n`,
    "missing",
    ["providers", "models", "analyze"],
  );
  const app = await createApplication(home, {
    configurationOwner: owner,
    executionSchema: "upgrade-synthetic",
    parsing: {
      rules: new TypeScriptParserArtifactRules(),
      parser: {
        parse: async (request) => {
          parses++;
          if (mode === "parser-failure")
            throw new ParsingFailure("parser-unavailable");
          const bytes = Buffer.from(
            `# ${FIXTURE_LITERATURE.metadata.title}\n\nThe fixture studies spectroscopy.\n\n# References\n\n1. Fixture reference.\n`,
          );
          return {
            source_asset_id: request.source_asset_id,
            source_sha256: request.source_sha256,
            page_count: 1,
            markdown: {
              bytes,
              artifact: parseArtifactRef({
                sha256: await sha256(bytes),
                byte_size: bytes.length,
                media_type: "text/markdown",
              }),
            },
            resources: [],
            provenance: {
              provenance: parseProvenance({
                provenance_id: `00000000-0000-0000-0000-${String(100 + parses).padStart(12, "0")}`,
                source_kind: "parser",
                source_name: "fixture",
                source_record_id: null,
                observed_at: "2026-09-10T00:00:00Z",
                input_sha256: request.source_sha256,
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
  const bad = workbenchPdf(),
    good = Buffer.concat([bad, Buffer.from("\n% alternate fixture\n")]);
  for (const [id, bytes] of [
    ["first", bad],
    ["duplicate", bad],
    ["next", good],
  ] as const) {
    await app.execution!.transfers.begin(id, undefined, {
      session_id: "fixture-session",
      article_id: lit,
      page_id: "fixture-page",
      document_generation: 1,
      source_url: "https://fixture.invalid/paper",
      captured_at: "2026-09-10T00:00:00Z",
    });
    await app.execution!.transfers.append(id, bytes);
    await app.execution!.transfers.complete(id);
  }
  return {
    app,
    home,
    modelStarted,
    bad,
    good,
    get calls() {
      return calls;
    },
    get parses() {
      return parses;
    },
    close: async () => {
      await app.close();
      await new Promise<void>((res, reject) =>
        http.close((e) => (e ? reject(e) : res())),
      );
      await rm(home, { recursive: true, force: true });
    },
  };
}
it("runs Candidate publication → parsing → actual loopback Analysis → cleanup → next PDF → content/query and restart", async () => {
  const env = await fixture();
  let reopened: Awaited<ReturnType<typeof createApplication>> | undefined;
  try {
    const result = await env.app.completion!.complete({
      literature_id: lit,
      transfer_ids: ["first", "duplicate", "next"],
    });
    expect(result.outcome).toBe("content_ready");
    expect(result.attempts).toEqual([
      { transfer_id: "first", outcome: "no_usable_content" },
      { transfer_id: "duplicate", outcome: "duplicate_input" },
      { transfer_id: "next", outcome: "content_accepted" },
    ]);
    expect(env.parses).toBe(2);
    expect(env.calls).toBe(3);
    const detail = await env.app.library.detail(lit);
    expect(detail.primary_pdf!.asset.sha256).toBe(await sha256(env.good));
    expect(detail.content!.provenance.input_sha256).toBe(
      await analysisInputSha256(
        await sha256(env.good),
        detail.parser_result!.result_sha256,
        detail.content!.metadata_sha256,
      ),
    );
    expect(
      (await env.app.library.search({ query: { text: "spectroscopy" } }))
        .total_count,
    ).toBe(1);
    expect(await env.app.database.getCandidate("first")).toBeNull();
    await expect(
      readFile(
        join(env.app.files.root, `.candidates/${await sha256(env.bad)}.bin`),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
    const repeated = await env.app.completion!.complete({
      literature_id: lit,
      transfer_ids: ["first", "next"],
    });
    expect(repeated.outcome).toBe("content_ready");
    expect(repeated.attempts).toEqual([]);
    expect(env.calls).toBe(3);
    expect(env.parses).toBe(2);
    await env.app.close();
    reopened = await createApplication(env.home, {
      executionSchema: "upgrade-synthetic",
    });
    expect(await reopened.library.detail(lit)).toEqual(detail);
    expect(await reopened.execution!.publisher.reconcile()).toEqual([]);
  } finally {
    await reopened?.close();
    await env.close();
  }
}, 30000);
it.each(["parser-failure", "model-failure"] as const)(
  "retains the current PDF and stops on %s without trying the next candidate",
  async (mode) => {
    const env = await fixture(mode);
    try {
      await expect(
        env.app.completion!.complete({
          literature_id: lit,
          transfer_ids: ["first", "next"],
        }),
      ).rejects.toBeInstanceOf(Error);
      const detail = await env.app.library.detail(lit);
      expect(detail.primary_pdf!.asset.sha256).toBe(await sha256(env.bad));
      expect(detail.content).toBeNull();
      expect(detail.parser_result === null).toBe(mode === "parser-failure");
      expect(env.parses).toBe(1);
      expect(await env.app.database.getCandidate("first")).not.toBeNull();
      expect(await env.app.database.getCandidate("next")).not.toBeNull();
    } finally {
      await env.close();
    }
  },
  30000,
);
it("returns only supplied-list exhaustion and allows a fresh invocation to rediscover the same hash", async () => {
  const env = await fixture("unusable");
  try {
    const result = await env.app.completion!.complete({
      literature_id: lit,
      transfer_ids: ["first", "duplicate", "missing"],
    });
    expect(result.outcome).toBe("supplied_candidates_exhausted");
    expect(result.attempts.map((a) => a.outcome)).toEqual([
      "no_usable_content",
      "duplicate_input",
      "candidate_missing",
    ]);
    expect((await env.app.library.detail(lit)).literature.status).toBe(
      "UNREVIEWED",
    );
    expect(env.calls).toBe(1);
    await env.app.execution!.transfers.begin("rediscovered", undefined, {
      session_id: "second-session",
      article_id: lit,
      page_id: "second-page",
      document_generation: 1,
      source_url: "https://fixture.invalid/paper",
      captured_at: "2026-09-10T00:00:00Z",
    });
    await env.app.execution!.transfers.append("rediscovered", env.bad);
    await env.app.execution!.transfers.complete("rediscovered");
    expect(
      (
        await env.app.completion!.complete({
          literature_id: lit,
          transfer_ids: ["rediscovered"],
        })
      ).attempts.map((a) => a.outcome),
    ).toEqual(["no_usable_content"]);
    expect(env.calls).toBe(2);
  } finally {
    await env.close();
  }
}, 30000);
it("uses an already published current PDF and skips its duplicate in the supplied list", async () => {
  const env = await fixture();
  try {
    const current = await env.app.database.currentFacts(lit);
    await env.app.execution!.acceptance.accept({
      literature_id: lit,
      transfer_id: "first",
      receipt_id: "preexisting",
      metadata_snapshot: current!.metadata_snapshot,
    });
    const result = await env.app.completion!.complete({
      literature_id: lit,
      transfer_ids: ["duplicate", "next"],
    });
    expect(result.outcome).toBe("content_ready");
    expect(result.attempts).toEqual([
      { transfer_id: null, outcome: "no_usable_content" },
      { transfer_id: "duplicate", outcome: "duplicate_input" },
      { transfer_id: "next", outcome: "content_accepted" },
    ]);
    expect(env.parses).toBe(2);
    expect(env.calls).toBe(3);
  } finally {
    await env.close();
  }
}, 30000);
it("rejects overlapping work for the same Literature and shutdown cancels the pending model while preserving its PDF", async () => {
  const env = await fixture("wait-model");
  try {
    const pending = env.app.completion!.complete({
      literature_id: lit,
      transfer_ids: ["first", "next"],
    });
    const rejected = expect(pending).rejects.toBeInstanceOf(Error);
    await env.modelStarted;
    await expect(
      env.app.completion!.complete({
        literature_id: lit,
        transfer_ids: ["next"],
      }),
    ).rejects.toMatchObject({ code: "completion-active" });
    await env.app.completion!.close();
    await rejected;
    expect(env.calls).toBe(1);
    expect(env.parses).toBe(1);
    expect((await env.app.library.detail(lit)).primary_pdf!.asset.sha256).toBe(
      await sha256(env.bad),
    );
    await expect(
      env.app.completion!.complete({ literature_id: lit, transfer_ids: [] }),
    ).rejects.toMatchObject({ code: "completion-closed" });
  } finally {
    await env.close();
  }
}, 30000);
it("rejects malformed and pre-cancelled commands before publishing any primary asset", async () => {
  const env = await fixture();
  try {
    await expect(
      env.app.completion!.complete({
        literature_id: lit,
        transfer_ids: ["../invalid"],
      }),
    ).rejects.toMatchObject({ code: "completion-command" });
    await expect(
      env.app.completion!.complete({
        literature_id: lit,
        transfer_ids: Array.from({ length: 1001 }, () => "first"),
      }),
    ).rejects.toMatchObject({ code: "completion-command" });
    await expect(
      env.app.completion!.complete(
        { literature_id: lit, transfer_ids: ["first"] },
        AbortSignal.abort(),
      ),
    ).rejects.toMatchObject({ code: "completion-cancelled" });
    expect(env.calls).toBe(0);
    expect(env.parses).toBe(0);
    expect((await env.app.library.detail(lit)).primary_pdf).toBeNull();
  } finally {
    await env.close();
  }
}, 30000);
it("preserves differing and missing identity evidence as uncertain without invoking Parser or Analysis", async () => {
  const env = await fixture();
  try {
    for (const [transferId, identifier] of [
      ["wrong-identity", "10.5555/other.paper"],
      ["uncertain-identity", "unknown"],
    ] as const) {
      await env.app.execution!.transfers.begin(transferId, undefined, {
        session_id: "identity-session",
        article_id: lit,
        page_id: "identity-page",
        document_generation: 1,
        source_url: "https://fixture.invalid/paper",
        captured_at: "2026-09-10T00:00:00Z",
      });
      await env.app.execution!.transfers.append(
        transferId,
        workbenchPdf(identifier),
      );
      await env.app.execution!.transfers.complete(transferId);
    }
    const result = await env.app.completion!.complete({
      literature_id: lit,
      transfer_ids: ["wrong-identity", "uncertain-identity"],
    });
    expect(result.outcome).toBe("supplied_candidates_exhausted");
    expect(result.attempts.map((a) => a.outcome)).toEqual([
      "candidate_uncertain",
      "candidate_uncertain",
    ]);
    expect(env.calls).toBe(0);
    expect(env.parses).toBe(0);
    expect((await env.app.library.detail(lit)).primary_pdf).toBeNull();
  } finally {
    await env.close();
  }
}, 30000);
