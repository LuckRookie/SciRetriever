import { RawParsingService } from "../src/parsing/raw-service.js";
import { acceptPdf } from "../src/acquisition/pdf-acceptance.js";
import { executeQuery } from "../src/entry/query-operations.js";
import { describe, expect, it, vi } from "vitest";
import {
  parseRawParseProfile,
  type RawParseProfile,
} from "@sciretriever/contracts";
import { coreProcessingFixture } from "./core-processing-fixture.js";
import { rawParseArchive } from "./raw-parse-fixture.js";
import {
  createApplication,
  createQueryApplication,
  type Application,
} from "../src/bootstrap/application.js";
import type { MinerUHttpTransport } from "../src/parsing/backends/mineru/http.js";
import { ParsingFailure } from "../src/parsing/ports.js";

async function fixture(archiveProfile?: "pipeline" | "vlm-engine") {
  const f = await coreProcessingFixture(
    archiveProfile ? { archiveProfile } : {},
  );
  await f.app.close();
  const calls: RawParseProfile[] = [];
  let hook: (
    profile: RawParseProfile,
    signal?: AbortSignal,
  ) => Promise<Uint8Array> = async (p) => rawParseArchive(p);
  const transport: MinerUHttpTransport = {
    request: async (_, input) => {
      const profile = parseRawParseProfile(
        input.headers["x-sciretriever-profile"],
      );
      calls.push(profile);
      const body = await hook(profile, input.signal);
      return {
        status: 200,
        headers: [["content-type", "application/zip"]],
        body,
      };
    },
  };
  let app: Application | undefined;
  const open = () =>
    createApplication(f.home, {
      typescriptParserRuntime: {
        baseUrl: "http://127.0.0.1:9",
        modelIdentity: "synthetic-model",
        transport,
      },
    });
  try {
    app = await open();
    return {
      f,
      calls,
      get app() {
        return app!;
      },
      setHook(fn: typeof hook) {
        hook = fn;
      },
      async reopen() {
        await app!.close();
        app = await open();
      },
      async close() {
        await app!.close();
        await f.close();
      },
    };
  } catch (e) {
    await app?.close();
    await f.close();
    throw e;
  }
}

describe("explicit deployment-profile parsing service", () => {
  it("does not parse during acquisition/startup and publishes only raw results", async () => {
    const e = await fixture();
    try {
      expect(e.calls).toEqual([]);
      expect(await e.app.rawParseStorage!.current(e.f.asset.asset_id)).toEqual(
        [],
      );
      const result = await e.app.rawParsing!.parseCurrentPrimary(
        e.f.parseRequest.literature_id,
      );
      expect(result.map((r) => [r.profile, r.status])).toEqual([
        ["vlm-engine", "published"],
      ]);
      expect(
        await e.app.library.detail(e.f.parseRequest.literature_id),
      ).not.toHaveProperty("parser_result");
      const receipt = await e.app.documentProcessing.parseDocuments({
        literature_id: e.f.parseRequest.literature_id,
        asset_id: e.f.asset.asset_id,
        asset_sha256: e.f.asset.sha256,
      });
      expect(receipt.profiles.map((p) => p.status)).toEqual(["reused"]);
      expect(
        await e.app.documentRead.default({
          literature_id: receipt.literature_id,
          asset_id: receipt.asset_id,
          asset_sha256: receipt.asset_sha256,
        }),
      ).toMatchObject({ default: null });
      expect(e.calls).toEqual(["vlm-engine"]);
      await e.reopen();
      const reused = await e.app.rawParsing!.parseCurrentPrimary(
        e.f.parseRequest.literature_id,
      );
      expect(reused.map((r) => r.status)).toEqual(["reused"]);
      expect(reused.map((r) => r.result?.raw_parse_id)).toEqual(
        result.map((r) => r.result?.raw_parse_id),
      );
      expect(e.calls).toEqual(["vlm-engine"]);
    } finally {
      await e.close();
    }
  });
  it("keeps the successful profile and retries only the failed profile", async () => {
    const e = await fixture();
    try {
      e.setHook(async (p) => {
        if (p === "vlm-engine") throw new ParsingFailure("parser-unavailable");
        return rawParseArchive(p);
      });
      expect(
        (
          await e.app.rawParsing!.parseAsset(e.f.asset.asset_id, [
            "pipeline",
            "vlm-engine",
          ])
        ).map((r) => r.status),
      ).toEqual(["published", "failed"]);
      expect(
        (await e.app.rawParseStorage!.current(e.f.asset.asset_id)).find(
          (r) => r.profile === "vlm-engine",
        ),
      ).toMatchObject({
        result: null,
        last_failure_code: "parser-unavailable",
      });
      e.setHook(async (p) => rawParseArchive(p));
      expect(
        (
          await e.app.rawParsing!.parseAsset(e.f.asset.asset_id, [
            "pipeline",
            "vlm-engine",
          ])
        ).map((r) => r.status),
      ).toEqual(["reused", "published"]);
      expect(e.calls.filter((p) => p === "pipeline")).toHaveLength(1);
      expect(e.calls.filter((p) => p === "vlm-engine")).toHaveLength(2);
    } finally {
      await e.close();
    }
  });
  it("serializes overlapping requests for the same asset/profile without repeating successful work", async () => {
    const e = await fixture();
    try {
      const runs = await Promise.all([
        e.app.rawParsing!.parseAsset(e.f.asset.asset_id, [
          "pipeline",
          "vlm-engine",
        ]),
        e.app.rawParsing!.parseAsset(e.f.asset.asset_id, [
          "pipeline",
          "vlm-engine",
        ]),
      ]);
      expect(runs.flat().filter((r) => r.status === "published")).toHaveLength(
        2,
      );
      expect(runs.flat().filter((r) => r.status === "reused")).toHaveLength(2);
      expect(e.calls.sort()).toEqual(["pipeline", "vlm-engine"]);
    } finally {
      await e.close();
    }
  });
  it.each([
    ["wrong backend", { backend: "pipeline" }],
    ["missing v2", { omitV2: true }],
    [
      "unknown type",
      {
        blocks: [
          [{ type: "synthetic_unknown", bbox: [0, 0, 100, 100], content: {} }],
        ],
      },
    ],
  ] as const)(
    "refuses %s for one profile without rolling back the other",
    async (_, options) => {
      const e = await fixture();
      try {
        e.setHook(async (p) =>
          rawParseArchive(p, p === "vlm-engine" ? options : {}),
        );
        const result = await e.app.rawParsing!.parseAsset(e.f.asset.asset_id, [
          "pipeline",
          "vlm-engine",
        ]);
        expect(result[0]).toMatchObject({
          status: "published",
          failure_code: null,
        });
        expect(result[1]).toMatchObject({
          status: "failed",
          result: null,
          failure_code: "parser-structure",
        });
        expect(result[1]!.failure_source_type).toBe(
          "blocks" in options ? "synthetic_unknown" : null,
        );
      } finally {
        await e.close();
      }
    },
  );
  it("cancels a pending profile and preserves already published bytes", async () => {
    const e = await fixture();
    try {
      let entered!: () => void;
      const waiting = new Promise<void>((r) => {
        entered = r;
      });
      e.setHook(async (p, signal) => {
        if (p === "vlm-engine") {
          entered();
          await new Promise<void>((_, reject) => {
            signal!.addEventListener(
              "abort",
              () => reject(new ParsingFailure("parser-cancelled")),
              { once: true },
            );
          });
        }
        return rawParseArchive(p);
      });
      const controller = new AbortController();
      const running = e.app.rawParsing!.parseAsset(
        e.f.asset.asset_id,
        ["pipeline", "vlm-engine"],
        controller.signal,
      );
      await waiting;
      // Background work started here can outlast the 1 s poll default under Full load.
      await expect
        .poll(
          async () =>
            (await e.app.rawParseStorage!.current(e.f.asset.asset_id)).some(
              (s) => s.profile === "pipeline" && s.result !== null,
            ),
          { timeout: 20_000 },
        )
        .toBe(true);
      controller.abort();
      const result = await running;
      expect(result[0]!.status).toBe("published");
      expect(result[1]!.failure_code).toBe("parser-cancelled");
      await e.reopen();
      expect(
        (await e.app.rawParseStorage!.current(e.f.asset.asset_id)).find(
          (s) => s.profile === "pipeline",
        )?.result,
      ).not.toBeNull();
    } finally {
      await e.close();
    }
  });
});

it("public parsing freezes input, reports both outcomes, and never publishes a Document", async () => {
  const e = await fixture();
  try {
    const request = {
      literature_id: e.f.parseRequest.literature_id,
      asset_id: e.f.asset.asset_id,
      asset_sha256: e.f.asset.sha256,
      profiles: ["pipeline", "vlm-engine"],
    };
    e.setHook(async (p) => {
      if (p === "vlm-engine") throw new ParsingFailure("parser-unavailable");
      return rawParseArchive(p);
    });
    const pending = e.app.documentProcessing.parseDocuments(request);
    request.profiles.pop();
    const result = await pending;
    expect(result.profiles.map((p) => p.status)).toEqual([
      "published",
      "failed",
    ]);
    expect(result).not.toHaveProperty("document");
    const job = await e.app.processingTasks!.submit({
      schema_version: 1,
      idempotency_key: "raw-partial-job",
      operations: [
        {
          operation: "parse-documents",
          request: { ...request, profiles: ["pipeline", "vlm-engine"] },
        },
      ],
    });
    const failed = await e.app.processingTasks!.run(job.job_id);
    expect(failed.job.status).toBe("failed");
    expect(failed.partial_results).toHaveLength(1);
    expect(failed.results).toHaveLength(0);
    e.setHook(async (p) => rawParseArchive(p));
    await e.app.processingTasks!.control(job.job_id, "retry");
    const retried = await e.app.processingTasks!.run(job.job_id);
    expect(retried.job.status).toBe("completed");
    expect(retried.results).toHaveLength(1);
    expect(e.calls.filter((p) => p === "pipeline")).toHaveLength(1);
    await e.app.documentProcessing.parseDocuments({
      ...request,
      profiles: ["pipeline"],
      force: true,
    });
    expect(e.calls.filter((p) => p === "pipeline")).toHaveLength(2);
    expect(
      await e.app.library.detail(request.literature_id),
    ).not.toHaveProperty("parser_result");
    const reader = await createQueryApplication(e.f.home);
    try {
      const status = await executeQuery(reader, "document-parsing-status", {
        literature_id: request.literature_id,
        asset_id: request.asset_id,
      });
      expect(status).toMatchObject({
        profiles: [
          {
            profile: "pipeline",
            raw_parse_id: expect.any(String),
            failure_code: null,
          },
          {
            profile: "vlm-engine",
            raw_parse_id: expect.any(String),
            failure_code: null,
          },
          { profile: "vlm-engine-markdown-only" },
        ],
      });
      expect(
        (
          await reader.documentRead!.default({
            literature_id: request.literature_id,
            asset_id: request.asset_id,
            asset_sha256: request.asset_sha256,
          })
        ).default,
      ).toBeNull();
    } finally {
      await reader.close();
    }
    await expect(
      e.app.documentProcessing.parseDocuments({
        ...request,
        asset_sha256: "f".repeat(64),
      }),
    ).rejects.toMatchObject({ code: "material-stale" });
    await expect(
      e.app.documentProcessing.parseDocuments({
        ...request,
        mode: "reuse-current",
      }),
    ).rejects.toBeDefined();
  } finally {
    await e.close();
  }
}, 0);
it("prepares both profiles outside the operation commit queue and publishes each through it", async () => {
  const e = await fixture();
  let arrived = 0,
    release!: () => void;
  const ready = new Promise<void>((r) => {
    release = r;
  });
  try {
    e.setHook(async (profile) => {
      arrived++;
      if (arrived === 2) release();
      await ready;
      return rawParseArchive(profile);
    });
    let commits = 0,
      active = 0,
      max = 0;
    const { CompletionSerialExecutor } = await import(
      "../src/entry/completion-execution.js"
    );
    const queue = new CompletionSerialExecutor(new AbortController().signal);
    const result = await e.app.documentProcessing.parseDocuments(
      e.f.rawParseRequest,
      undefined,
      (action) =>
        queue.run(async () => {
          expect(arrived).toBe(2);
          commits++;
          max = Math.max(max, ++active);
          try {
            return await action();
          } finally {
            active--;
          }
        }),
    );
    expect(result.profiles.map((p) => p.status)).toEqual([
      "published",
      "published",
    ]);
    expect(commits).toBe(2);
    expect(max).toBe(1);
    expect(e.calls).toHaveLength(2);
    const detail = await e.app.library.detail(
      e.f.rawParseRequest.literature_id,
    );
    expect(detail).not.toHaveProperty("parser_result");
    expect(detail).not.toHaveProperty("content");
  } finally {
    await e.close();
  }
}, 30000);
it("reports publication failures separately from parser availability and retries reusable successful profiles", async () => {
  const e = await fixture();
  try {
    const result = await e.app.documentProcessing.parseDocuments(
      e.f.rawParseRequest,
      undefined,
      async () => {
        throw new Error("synthetic-commit-refused");
      },
    );
    expect(result.profiles.map((p) => [p.status, p.failure_code])).toEqual([
      ["failed", "parser-publication"],
      ["failed", "parser-publication"],
    ]);
    expect(
      (await e.app.rawParseStorage!.current(e.f.asset.asset_id)).every(
        (s) => s.result === null,
      ),
    ).toBe(true);
    const retried = await e.app.documentProcessing.parseDocuments(
      e.f.rawParseRequest,
    );
    expect(retried.profiles.map((p) => p.status)).toEqual([
      "published",
      "published",
    ]);
  } finally {
    await e.close();
  }
}, 30000);

it("keeps a published raw parse when attempt persistence fails and reuses it on retry", async () => {
  const e = await fixture();
  try {
    const receipt = vi
      .spyOn(e.app.rawParseStorage!, "recordAttempt")
      .mockRejectedValueOnce(
        new Error("synthetic receipt persistence failure"),
      );
    await expect(
      e.app.rawParsing!.parseAsset(e.f.asset.asset_id, ["vlm-engine"]),
    ).rejects.toMatchObject({ code: "parser-publication" });
    const committed = (
      await e.app.rawParseStorage!.current(e.f.asset.asset_id)
    )[0]!.result!;
    expect(
      (await e.app.rawParseStorage!.load(committed.raw_parse_id)).result,
    ).toEqual(committed);
    const retry = await e.app.rawParsing!.parseAsset(e.f.asset.asset_id, [
      "vlm-engine",
    ]);
    expect(retry[0]).toMatchObject({ status: "reused", result: committed });
    expect(e.calls).toEqual(["vlm-engine"]);
    expect(receipt).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: "reused",
        raw_parse_id: committed.raw_parse_id,
      }),
    );
  } finally {
    await e.close();
  }
});

it("preserves publication failure when a different profile rejects on cancellation", async () => {
  const e = await fixture();
  let service: RawParsingService | undefined;
  try {
    const [seeded] = await e.app.rawParsing!.parseAsset(e.f.asset.asset_id, [
      "vlm-engine",
    ]);
    const staged = await e.app.rawParseStorage!.load(
      seeded!.result!.raw_parse_id,
    );
    service = new RawParsingService(
      {
        asset: (id) => e.app.database.getAsset(id),
        currentFacts: (id) => e.app.database.currentFacts(id),
        withArtifact: (asset, consume, options) =>
          e.app.literatureArtifacts.withArtifact(asset, consume, options),
        inspectPdf: (bytes, signal) => acceptPdf(bytes, 10000, signal),
      },
      {
        identity: async (profile) => {
          if (profile === "pipeline")
            throw new ParsingFailure("parser-cancelled");
          return staged.result;
        },
        parseRaw: async () => staged,
      },
      e.app.rawParseStorage!,
    );
    await expect(
      service.parseAsset(
        e.f.asset.asset_id,
        ["pipeline", "vlm-engine"],
        undefined,
        {
          force: true,
          commit: async () => {
            throw new Error("synthetic publication refusal");
          },
        },
      ),
    ).rejects.toMatchObject({ code: "parser-publication" });
    expect(
      (await e.app.rawParseStorage!.current(e.f.asset.asset_id))[0]?.result
        ?.raw_parse_id,
    ).toBe(seeded!.result!.raw_parse_id);
  } finally {
    await service?.close();
    await e.close();
  }
});

it("uses the configured deployment profile for defaults, completion and read-only status", async () => {
  const e = await fixture("pipeline");
  try {
    const { profiles: _profiles, ...request } = e.f.rawParseRequest;
    void _profiles;
    const receipt = await e.app.documentProcessing.parseDocuments(request);
    expect(receipt.profiles.map((p) => p.profile)).toEqual(["pipeline"]);
    expect(e.calls).toEqual(["pipeline"]);
    expect(await e.app.completion!.isReady(request.literature_id)).toBe(true);
    const query = await createQueryApplication(e.f.home);
    try {
      expect(
        await executeQuery(query, "document-parsing-status", {
          literature_id: request.literature_id,
          asset_id: request.asset_id,
        }),
      ).toMatchObject({
        archive_profile: "pipeline",
        profiles: expect.arrayContaining([
          {
            profile: "pipeline",
            is_archive_profile: true,
            raw_parse_id: receipt.profiles[0]!.raw_parse_id,
            result_sha256: receipt.profiles[0]!.result_sha256,
            failure_code: null,
          },
        ]),
      });
    } finally {
      await query.close();
    }
  } finally {
    await e.close();
  }
});
