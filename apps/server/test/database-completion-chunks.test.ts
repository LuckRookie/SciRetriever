import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  parseAsset,
  parseLiterature,
  parseLiteratureId,
  parseMetaLiteratureId,
  sha256,
  type DatabaseCompletionReport,
} from "@sciretriever/contracts";
import { createApplication } from "../src/bootstrap/application.js";
import { DatabaseCompletionService } from "../src/entry/database-completion.js";
import { LiteratureCompletionService } from "../src/entry/literature-completion.js";
import { ContentAnalysisService } from "../src/entry/content-analysis.js";
import { ParsingFailure } from "../src/parsing/ports.js";
import { AnalysisFailure } from "../src/analysis/service.js";
import { ContentAcceptanceError } from "../src/literature/content.js";
import { WriteAdmissionError } from "../src/storage/write-admission.js";
import {
  FIXTURE_LITERATURE,
  workbenchPdf,
} from "../src/workbench/synthetic-fixture.js";
import { setup, proposal, lit } from "./content-fixture.js";

const id = (n: number) =>
  parseLiteratureId(`00000000-0000-4000-9000-${String(n).padStart(12, "0")}`);
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const exhausted = (literature_id: string) => ({
  outcome: "supplied_candidates_exhausted" as const,
  literature_id,
  attempts: [],
});
function targets(report: DatabaseCompletionReport): string[] {
  return [
    report.completed,
    report.failed,
    report.skipped,
    report.interrupted,
    report.notStarted,
  ].flatMap((partition) =>
    partition.map(({ target }) => {
      if (target.kind !== "literature")
        throw new Error("fixture expected concrete targets");
      return target.literature_id;
    }),
  );
}
async function fixture(count: number) {
  const home = await mkdtemp(join(tmpdir(), "sciretriever-completion-chunks-"));
  await mkdir(join(home, ".sciretriever"), { mode: 0o700 });
  await writeFile(
    join(home, ".sciretriever", "config.toml"),
    "[execution]\nmax_concurrency = 2\n",
    { mode: 0o600 },
  );
  const acquisitionResolver = vi.fn(async () => {
    throw new Error(
      "Completion fixture forbids external acquisition resolution",
    );
  });
  const discoverDoiLanding = vi.fn(async () => []);
  const app = await createApplication(home, {
    executionSchema: "upgrade-synthetic",
    acquisitionAssembly: {
      resolver: acquisitionResolver,
      doiLandingSource: {
        source_name: "doi-landing",
        ready: true,
        discover: discoverDoiLanding,
      },
    },
  });
  const ids = Array.from({ length: count }, (_, n) => id(n + 1));
  for (const literature_id of ids) {
    await app.database.putLiterature(
      parseLiterature({
        ...FIXTURE_LITERATURE,
        literature_id,
        meta_literature_id: parseMetaLiteratureId(randomUUID()),
      }),
    );
  }
  return {
    app,
    ids,
    acquisitionResolver,
    discoverDoiLanding,
    request: {
      selector: { kind: "literatures" as const, literature_ids: ids },
      goal: "CONTENT_READY" as const,
    },
    service: (
      complete: LiteratureCompletionService["complete"],
      max_concurrency = 3,
    ) =>
      new DatabaseCompletionService({
        library: app.library,
        database: app.database,
        writes: app.writes,
        completion: { complete },
        acquisition: null,
        max_concurrency,
      }),
    close: async () => {
      await app.close();
      await rm(home, { recursive: true, force: true });
    },
  };
}

describe("bounded database completion operations", () => {
  it("refills independent PDF targets with one stable Browser epoch and immediate progress", async () => {
    const env = await fixture(4);
    const slow = deferred();
    const slowStarted = deferred();
    const requests: {
      id: string;
      operation: string | undefined;
      generation: number | undefined;
    }[] = [];
    const finished: string[] = [];
    const fastFinished = deferred();
    const service = new DatabaseCompletionService({
      library: env.app.library,
      database: env.app.database,
      writes: env.app.writes,
      completion: null,
      max_concurrency: 2,
      acquisition: {
        acquire: async (request) => {
          // Establish the fixture's slow-first scenario explicitly: concurrent
          // catalog detail reads are allowed to reach acquisition out of order.
          if (request.literature_id !== env.ids[0]) await slowStarted.promise;
          requests.push({
            id: request.literature_id,
            operation: request.operation_id,
            generation: request.generation,
          });
          if (request.literature_id === env.ids[0]) {
            slowStarted.resolve();
            await slow.promise;
          }
          expect(request.signal.aborted).toBe(false);
          return { kind: "exhausted" };
        },
      },
    });
    const pending = service.run(
      { ...env.request, goal: "ASSET_READY" },
      {
        on_progress: (event) => {
          if (event.state === "skipped") {
            finished.push(event.literature_id!);
            if (finished.length === 3) fastFinished.resolve();
          }
        },
      },
    );
    try {
      await fastFinished.promise;
      expect(finished).toEqual(env.ids.slice(1));
      expect(requests.map((x) => x.id)).toEqual(env.ids);
      expect(new Set(requests.map((x) => x.operation)).size).toBe(1);
      expect(requests.every((x) => x.operation && x.generation === 0)).toBe(
        true,
      );
      slow.resolve();
      const report = await pending;
      expect(targets(report)).toEqual(env.ids);
      expect(report.end.kind).toBe("finished");
    } finally {
      slowStarted.resolve();
      slow.resolve();
      await pending;
      await env.close();
    }
  });

  it("uses the configured bound in the production Application object graph", async () => {
    const env = await fixture(5);
    const release = deferred();
    const read = env.app.library.detail.bind(env.app.library);
    const detail = vi
      .spyOn(env.app.library, "detail")
      .mockImplementation(async (value) => {
        await release.promise;
        return read(value);
      });
    const pending = env.app.databaseCompletion!.run(env.request);
    try {
      await vi.waitFor(() => expect(detail).toHaveBeenCalledTimes(2));
      release.resolve();
      const report = await pending;
      // Production CONTENT_READY still admits the automatic PDF route. The
      // injected source gives each synthetic DOI an offline exhaustion, keeping
      // this object-graph check independent of the real doi.org download path.
      expect(env.discoverDoiLanding).toHaveBeenCalledTimes(5);
      expect(env.acquisitionResolver).not.toHaveBeenCalled();
      expect(report.failed.map((item) => item.failure.code)).not.toContain(
        "content-completion-unavailable",
      );
      expect(
        report.completed.length +
          report.failed.length +
          report.skipped.length +
          report.interrupted.length +
          report.notStarted.length,
      ).toBe(5);
      expect(report.interrupted).toEqual([]);
      expect(report.notStarted).toEqual([]);
      expect(report.end.kind).toBe("finished");
    } finally {
      release.resolve();
      await pending;
      detail.mockRestore();
      await env.close();
    }
  });

  it("bounds independent PDF flows while every target obtains exactly one exhaustion fact", async () => {
    const env = await fixture(7);
    const release = deferred();
    const calls: string[] = [];
    let active = 0,
      peak = 0,
      started = 0;
    const service = new DatabaseCompletionService({
      library: env.app.library,
      database: env.app.database,
      writes: env.app.writes,
      completion: null,
      max_concurrency: 3,
      acquisition: {
        acquire: async (request) => {
          calls.push(request.literature_id);
          peak = Math.max(peak, ++active);
          await release.promise;
          active--;
          return { kind: "exhausted" };
        },
      },
    });
    const pending = service.run(
      { ...env.request, goal: "ASSET_READY" },
      {
        on_progress: (event) => {
          if (event.state === "started") started++;
        },
      },
    );
    try {
      await vi.waitFor(() => expect(calls).toHaveLength(3));
      expect(started).toBe(3);
      expect(active).toBe(3);
      release.resolve();
      const report = await pending;
      expect(peak).toBe(3);
      expect(calls).toEqual(env.ids);
      expect(report.skipped).toHaveLength(7);
      expect(targets(report).sort()).toEqual([...env.ids].sort());
      for (const literatureId of env.ids)
        expect(
          await env.app.database.hasAutomaticPdfExhaustion(literatureId),
        ).toBe(true);
    } finally {
      release.resolve();
      await pending;
      await env.close();
    }
  });
  it.each([7, 65])(
    "caps active work and keeps frozen order across %i targets",
    async (count) => {
      const env = await fixture(count);
      const first = deferred();
      const rest = deferred();
      const calls: string[] = [];
      let active = 0,
        peak = 0;
      const fastFinished = deferred();
      let finished = 0;
      const service = env.service(async ({ literature_id }) => {
        calls.push(literature_id);
        peak = Math.max(peak, ++active);
        try {
          if (literature_id === env.ids[0]) await first.promise;
          else if (
            env.ids.slice(1, 3).includes(parseLiteratureId(literature_id))
          )
            await rest.promise;
          return exhausted(literature_id);
        } finally {
          active--;
        }
      });
      const pending = service.run(env.request, {
        on_progress: (event) => {
          if (event.state !== "started" && ++finished === count - 1)
            fastFinished.resolve();
        },
      });
      try {
        await vi.waitFor(() => expect(calls).toHaveLength(3));
        rest.resolve();
        await fastFinished.promise;
        expect(active).toBe(1);
        // The slow first target stays active while the other slots drain all
        // remaining work, including what used to belong to later chunks.
        expect(calls).toHaveLength(count);
        expect(new Set(calls)).toEqual(new Set(env.ids));
        first.resolve();
        const report = await pending;
        expect(peak).toBe(3);
        expect(active).toBe(0);
        expect(report.failed.map((item) => item.literature_id)).toEqual(
          env.ids,
        );
        expect(new Set(targets(report)).size).toBe(count);
        expect(report.end.kind).toBe("finished");
      } finally {
        first.resolve();
        rest.resolve();
        await pending;
        await env.close();
      }
    },
  );

  it("keeps report order while a slow detail read does not block later targets", async () => {
    const env = await fixture(7);
    const release = deferred();
    const original = env.app.library.detail.bind(env.app.library);
    const detail = vi
      .spyOn(env.app.library, "detail")
      .mockImplementation(async (id) => {
        if (id === env.ids[3]) await release.promise;
        return original(id);
      });
    const calls: string[] = [];
    const service = env.service(async ({ literature_id }) => {
      calls.push(literature_id);
      return exhausted(literature_id);
    });
    const pending = service.run(env.request);
    try {
      await vi.waitFor(() => expect(calls).toHaveLength(6));
      expect(new Set(calls)).toEqual(
        new Set(env.ids.filter((id) => id !== env.ids[3])),
      );
      release.resolve();
      const report = await pending;
      expect(calls[6]).toBe(env.ids[3]);
      expect(report.failed.map((item) => item.literature_id)).toEqual(env.ids);
    } finally {
      release.resolve();
      await pending;
      detail.mockRestore();
      await env.close();
    }
  });

  it("partitions running and unstarted targets after cancellation and drains before returning", async () => {
    const env = await fixture(8);
    const stop = new AbortController();
    let active = 0;
    const service = env.service(async (_command, signal) => {
      active++;
      await new Promise<void>((resolve) =>
        signal!.addEventListener("abort", () => resolve(), { once: true }),
      );
      active--;
      throw new DOMException("fixture cancelled", "AbortError");
    });
    const pending = service.run(env.request, { signal: stop.signal });
    try {
      await vi.waitFor(() => expect(active).toBe(3));
      stop.abort();
      const report = await pending;
      expect(active).toBe(0);
      expect(report.interrupted.map((item) => item.literature_id)).toEqual(
        env.ids.slice(0, 3),
      );
      expect(report.notStarted).toHaveLength(5);
      expect(targets(report).sort()).toEqual([...env.ids].sort());
      expect(report.end.kind).toBe("interrupted");
    } finally {
      stop.abort();
      await pending;
      await env.close();
    }
  });

  it("does no work for a pre-cancelled operation and stops refilling after cancellation", async () => {
    const env = await fixture(5);
    const secondStarted = deferred();
    const complete = vi.fn(
      async (
        { literature_id }: { literature_id: string },
        signal?: AbortSignal,
      ) => {
        if (literature_id === env.ids[1]) {
          secondStarted.resolve();
          await new Promise<void>((resolve) =>
            signal!.addEventListener("abort", () => resolve(), { once: true }),
          );
          throw new DOMException("fixture cancelled", "AbortError");
        }
        await secondStarted.promise;
        return exhausted(literature_id);
      },
    );
    const service = env.service(complete, 2);
    try {
      const pre = await service.run(env.request, {
        signal: AbortSignal.abort(),
      });
      expect(pre.notStarted).toHaveLength(5);
      expect(complete).not.toHaveBeenCalled();
      const stop = new AbortController();
      let finished = 0;
      const report = await service.run(env.request, {
        signal: stop.signal,
        on_progress: (event) => {
          if (event.state === "failed" && ++finished === 1) stop.abort();
        },
      });
      expect(complete).toHaveBeenCalledTimes(2);
      expect(report.failed).toHaveLength(1);
      expect(report.notStarted).toHaveLength(3);
      expect(report.interrupted).toHaveLength(1);
      expect(targets(report).sort()).toEqual([...env.ids].sort());
    } finally {
      await env.close();
    }
  });

  it("stops siblings on a shared failure, preserves its cause and waits for cleanup", async () => {
    const env = await fixture(7);
    const fail = deferred();
    const cleanup = deferred();
    let started = 0,
      aborted = 0,
      returned = false;
    const service = env.service(async ({ literature_id }, signal) => {
      started++;
      if (literature_id === env.ids[1]) {
        await fail.promise;
        throw new WriteAdmissionError("write-admission-conflict");
      }
      await new Promise<void>((resolve) =>
        signal!.addEventListener("abort", () => resolve(), { once: true }),
      );
      aborted++;
      await cleanup.promise;
      throw new DOMException("fixture cancelled", "AbortError");
    });
    const pending = service.run(env.request).then((report) => {
      returned = true;
      return report;
    });
    try {
      await vi.waitFor(() => expect(started).toBe(3));
      fail.resolve();
      await vi.waitFor(() => expect(aborted).toBe(2));
      expect(returned).toBe(false);
      cleanup.resolve();
      const report = await pending;
      expect(report.end).toMatchObject({
        kind: "failed",
        failure: { code: "completion-storage-failed" },
      });
      expect(report.failed.map((item) => item.literature_id)).toEqual([
        env.ids[1],
      ]);
      expect(report.interrupted).toHaveLength(2);
      expect(report.notStarted).toHaveLength(4);
      expect(targets(report).sort()).toEqual([...env.ids].sort());
    } finally {
      fail.resolve();
      cleanup.resolve();
      await pending;
      await env.close();
    }
  });

  it.each([
    [new ParsingFailure("parser-unavailable"), "parsing"],
    [new AnalysisFailure("analysis-model"), "analysis"],
  ] as const)(
    "isolates %s without stopping other chunks",
    async (error, stage) => {
      const env = await fixture(5);
      const calls: string[] = [];
      try {
        const report = await env
          .service(async ({ literature_id }) => {
            calls.push(literature_id);
            if (literature_id === env.ids[0]) throw error;
            return exhausted(literature_id);
          }, 2)
          .run(env.request);
        expect(calls).toEqual(env.ids);
        expect(report.failed[0]).toMatchObject({ stage });
        expect(report.end.kind).toBe("finished");
      } finally {
        await env.close();
      }
    },
  );

  it("keeps mixed acquisition, parsing and analysis failures isolated while preserving committed facts", async () => {
    const env = await setup(true);
    const literatureIds = [11, 12, 13, 14, 15].map(id);
    const [acquisitionId, parsingId, analysisId, completedId, exhaustedId] =
      literatureIds as [
        (typeof literatureIds)[number],
        (typeof literatureIds)[number],
        (typeof literatureIds)[number],
        (typeof literatureIds)[number],
        (typeof literatureIds)[number],
      ];
    try {
      for (const literature_id of literatureIds)
        await env.app.database.putLiterature(
          parseLiterature({
            ...FIXTURE_LITERATURE,
            literature_id,
            meta_literature_id: parseMetaLiteratureId(randomUUID()),
          }),
        );

      const analysis = new ContentAnalysisService(
        {
          analyzeContent: async (literatureId) => {
            const prepared = await proposal(
              await env.app.library.detail(literatureId),
              80,
            );
            return {
              outcome: "proposal",
              proposal: prepared.value,
              markdownBytes: prepared.bytes,
            };
          },
        },
        env.app.literatureContent,
      );
      const completion = new LiteratureCompletionService(
        env.app.library,
        env.app.database,
        env.app.execution!.acceptance,
        env.app.parsing!,
        analysis,
      );
      const scriptedCompletion: Pick<LiteratureCompletionService, "complete"> =
        {
          complete: async (command, signal, commit) => {
            if (command.literature_id === parsingId)
              throw new ParsingFailure("parser-unavailable");
            if (command.literature_id === analysisId)
              throw new AnalysisFailure("analysis-model");
            return completion.complete(command, signal, commit);
          },
        };
      const publishPdf = async (
        literatureId: (typeof literatureIds)[number],
      ) => {
        const bytes = Buffer.concat([
          workbenchPdf(),
          Buffer.from(`\n% mixed-${literatureId}\n`),
        ]);
        const staged = await env.app.files.stage({ maxBytes: bytes.length });
        await staged.write(bytes);
        const path = `objects/mixed-${literatureId}.pdf`;
        await env.app.files.publish(staged, path);
        const asset = parseAsset({
          asset_id: randomUUID(),
          sha256: await sha256(bytes),
          size_bytes: bytes.length,
          media_type: "application/pdf",
          path,
        });
        await env.app.database.putLiteratureAsset({
          literature_asset_id: randomUUID(),
          literature_id: literatureId,
          asset,
          role: "primary-pdf",
          source_url: null,
          provenance: {
            provenance_id: randomUUID(),
            source_kind: "asset-provider",
            source_name: "mixed-completion-fixture",
            source_record_id: null,
            observed_at: "2026-09-16T00:00:00Z",
            input_sha256: asset.sha256,
            parameters_sha256: null,
          },
        });
        return {
          kind: "acquired" as const,
          literature_id: literatureId,
          receipt: {
            receipt_id: `mixed-${literatureId}`,
            literature_id: literatureId,
            asset_id: asset.asset_id,
            sha256: asset.sha256,
            reference: asset.path,
            created: true,
          },
        };
      };
      const service = new DatabaseCompletionService({
        library: env.app.library,
        database: env.app.database,
        writes: env.app.writes,
        completion: scriptedCompletion,
        acquisition: {
          acquire: async ({ literature_id }) => {
            if (literature_id === acquisitionId)
              return {
                kind: "route-failure",
                failure: {
                  code: "candidate-download-failed",
                  source: "mixed-fixture",
                  reason: "The synthetic acquisition route failed.",
                  retryable: true,
                },
              };
            if (literature_id === exhaustedId) return { kind: "exhausted" };
            return publishPdf(literature_id);
          },
        },
        automatic_pdf_for_content: true,
        max_concurrency: 5,
      });

      const report = await service.run({
        selector: { kind: "literatures", literature_ids: literatureIds },
        goal: "CONTENT_READY",
      });

      expect(report.completed.map((item) => item.literature_id)).toEqual([
        completedId,
      ]);
      expect(
        report.failed.map((item) => [
          item.literature_id,
          item.stage,
          item.failure.code,
        ]),
      ).toEqual([
        [acquisitionId, "acquisition", "pdf-route-delivery-failed"],
        [parsingId, "parsing", "completion-parsing-failed"],
        [analysisId, "analysis", "completion-analysis-failed"],
      ]);
      expect(report.skipped).toMatchObject([
        {
          target: { literature_id: exhaustedId },
          reason: "manual-pdf-required",
        },
      ]);
      expect(report.interrupted).toEqual([]);
      expect(report.notStarted).toEqual([]);
      expect(report.end.kind).toBe("finished");
      expect(targets(report).sort()).toEqual([...literatureIds].sort());

      expect(
        (await env.app.library.detail(parsingId)).primary_pdf,
      ).not.toBeNull();
      expect(
        (await env.app.library.detail(analysisId)).primary_pdf,
      ).not.toBeNull();
      expect(
        (await env.app.library.detail(completedId)).content,
      ).not.toBeNull();
      expect(
        await env.app.database.hasAutomaticPdfExhaustion(exhaustedId),
      ).toBe(true);
      expect(
        await env.app.database.hasAutomaticPdfExhaustion(acquisitionId),
      ).toBe(false);
    } finally {
      await env.close();
    }
  });

  it.each([
    new ParsingFailure("parser-publication"),
    new ContentAcceptanceError("content-publication"),
  ])(
    "keeps publication failure %s when cancellation races it",
    async (error) => {
      const env = await fixture(4);
      const stop = new AbortController();
      try {
        const report = await env
          .service(async () => {
            stop.abort();
            throw error;
          }, 1)
          .run(env.request, { signal: stop.signal });
        expect(report.end).toMatchObject({
          kind: "failed",
          failure: { code: "completion-storage-failed" },
        });
        expect(report.failed).toHaveLength(1);
        expect(report.notStarted).toHaveLength(3);
      } finally {
        await env.close();
      }
    },
  );

  it("does not let progress sink failures change results or strand workers", async () => {
    const env = await fixture(5);
    try {
      const report = await env
        .service(async ({ literature_id }) => exhausted(literature_id))
        .run(env.request, {
          on_progress: () => {
            throw new Error("fixture sink failed");
          },
        });
      expect(report.failed).toHaveLength(5);
      expect(report.end.kind).toBe("finished");
    } finally {
      await env.close();
    }
  });

  it("automatically acquires a missing PDF before CONTENT_READY completion", async () => {
    const env = await setup(true);
    const second = id(2);
    const transferId = "auto-content-transfer";
    const bytes = workbenchPdf();
    const stop = new AbortController();
    let acquisitions = 0;
    try {
      await env.app.database.putLiterature(
        parseLiterature({
          ...FIXTURE_LITERATURE,
          literature_id: second,
          meta_literature_id: parseMetaLiteratureId(randomUUID()),
        }),
      );
      await env.app.execution!.transfers.begin(transferId, undefined, {
        session_id: "automatic-content-session",
        article_id: second,
        page_id: "automatic-content-page",
        document_generation: 1,
        source_url: "https://fixture.invalid/automatic-content",
        captured_at: "2026-09-16T00:00:00Z",
      });
      await env.app.execution!.transfers.append(transferId, bytes);
      await env.app.execution!.transfers.complete(transferId);

      const analysis = new ContentAnalysisService(
        {
          analyzeContent: async (literatureId) => {
            const prepared = await proposal(
              await env.app.library.detail(literatureId),
              61,
            );
            return {
              outcome: "proposal",
              proposal: prepared.value,
              markdownBytes: prepared.bytes,
            };
          },
        },
        env.app.literatureContent,
      );
      const completion = new LiteratureCompletionService(
        env.app.library,
        env.app.database,
        env.app.execution!.acceptance,
        env.app.parsing!,
        analysis,
      );
      const accepted = vi.spyOn(env.app.execution!.acceptance, "accept");
      const complete = vi.spyOn(completion, "complete");
      const service = new DatabaseCompletionService({
        library: env.app.library,
        database: env.app.database,
        writes: env.app.writes,
        completion,
        acquisition: {
          acquire: async (request) => {
            acquisitions += 1;
            const receipt = await env.app.execution!.acceptance.accept(
              {
                literature_id: request.literature_id,
                transfer_id: transferId,
                receipt_id: "automatic-content-receipt",
                metadata_snapshot: request.metadata_snapshot,
              },
              request.signal,
            );
            return {
              kind: "acquired" as const,
              literature_id: request.literature_id,
              receipt,
            };
          },
        },
        automatic_pdf_for_content: true,
        max_concurrency: 1,
      });

      const report = await service.run(
        {
          selector: { kind: "literatures", literature_ids: [second] },
          goal: "CONTENT_READY",
        },
        { signal: stop.signal },
      );
      const detail = await env.app.library.detail(second);
      expect(acquisitions).toBe(1);
      expect(accepted).toHaveBeenCalledTimes(1);
      expect(complete).toHaveBeenCalledWith(
        { literature_id: second, transfer_ids: [] },
        expect.any(AbortSignal),
        expect.any(Function),
      );
      expect(detail.primary_pdf).not.toBeNull();
      expect(detail.parser_result).not.toBeNull();
      expect(detail.content).not.toBeNull();
      expect(report.completed).toMatchObject([{ literature_id: second }]);
      expect(report.failed).toEqual([]);
      expect(report.skipped).toEqual([]);
      expect(report.end.kind).toBe("finished");
    } finally {
      stop.abort();
      await env.close();
    }
  });

  it("rejects invalid bounds before touching the database", async () => {
    const env = await fixture(0);
    try {
      for (const bound of [0, -1, 65, 1.5, NaN, Infinity])
        expect(() =>
          env.service(
            async ({ literature_id }) => exhausted(literature_id),
            bound,
          ),
        ).toThrow("completion concurrency is invalid");
    } finally {
      await env.close();
    }
  });
});

it.each([false, true])(
  "serializes actual publications and disposes prepared work when cancelled=%s",
  async (cancel) => {
    const env = await setup(true);
    const hold = deferred();
    const stop = new AbortController();
    const app = env.app;
    const second = id(2);
    const secondLiterature = parseLiterature({
      ...FIXTURE_LITERATURE,
      literature_id: second,
      meta_literature_id: parseMetaLiteratureId(randomUUID()),
    });
    await app.database.putLiterature(secondLiterature);
    const pdf = Buffer.concat([
      workbenchPdf(),
      Buffer.from("\n% second input\n"),
    ]);
    const stage = await app.files.stage();
    await stage.write(pdf);
    const path = "objects/second.pdf";
    await app.files.publish(stage, path);
    const asset = parseAsset({
      asset_id: randomUUID(),
      sha256: await sha256(pdf),
      size_bytes: pdf.length,
      media_type: "application/pdf",
      path,
    });
    await app.database.putLiteratureAsset({
      literature_asset_id: randomUUID(),
      literature_id: second,
      asset,
      role: "primary-pdf",
      source_url: null,
      provenance: {
        provenance_id: randomUUID(),
        source_kind: "user",
        source_name: "fixture",
        source_record_id: null,
        observed_at: "2026-09-16T00:00:00Z",
        input_sha256: asset.sha256,
        parameters_sha256: null,
      },
    });
    let writes = 0,
      peak = 0,
      analyses = 0;
    const accept = app.literatureContent.accept.bind(app.literatureContent);
    const publish = app.parsing!.commitCurrentPrimary.bind(app.parsing!);
    const prepared = vi.spyOn(app.parsing!, "prepareCurrentPrimary");
    const discarded = vi.spyOn(app.parsing!, "discardPrepared");
    vi.spyOn(app.literatureContent, "accept").mockImplementation(
      async (...args) => {
        peak = Math.max(peak, ++writes);
        try {
          const accepted = await accept(...args);
          await hold.promise;
          return accepted;
        } finally {
          writes--;
        }
      },
    );
    const publications = vi
      .spyOn(app.parsing!, "commitCurrentPrimary")
      .mockImplementation(async (...args) => {
        peak = Math.max(peak, ++writes);
        try {
          return await publish(...args);
        } finally {
          writes--;
        }
      });
    const analysis = new ContentAnalysisService(
      {
        analyzeContent: async (literatureId) => {
          analyses++;
          const p = await proposal(
            await app.library.detail(literatureId),
            literatureId === lit ? 50 : 51,
          );
          return {
            outcome: "proposal",
            proposal: p.value,
            markdownBytes: p.bytes,
          };
        },
      },
      app.literatureContent,
    );
    const completion = new LiteratureCompletionService(
      app.library,
      app.database,
      app.execution!.acceptance,
      app.parsing!,
      analysis,
    );
    const service = new DatabaseCompletionService({
      library: app.library,
      database: app.database,
      writes: app.writes,
      completion,
      acquisition: null,
      max_concurrency: 2,
    });
    const pending = service.run(
      {
        selector: { kind: "literatures", literature_ids: [lit, second] },
        goal: "CONTENT_READY",
      },
      { signal: stop.signal },
    );
    try {
      await vi.waitFor(() => expect(writes).toBe(1));
      await vi.waitFor(() => expect(prepared).toHaveResolved());
      await vi.waitFor(async () =>
        expect((await app.library.detail(lit)).content).not.toBeNull(),
      );
      expect(publications).not.toHaveBeenCalled();
      if (cancel) stop.abort();
      hold.resolve();
      const report = await pending;
      expect(report.completed.map((item) => item.literature_id)).toEqual([
        lit,
        ...(cancel ? [] : [second]),
      ]);
      expect(report.end.kind).toBe(cancel ? "interrupted" : "finished");
      expect(analyses).toBe(cancel ? 1 : 2);
      expect(peak).toBe(1);
      expect(writes).toBe(0);
      expect(discarded).toHaveBeenCalledTimes(1);
      const detail = await app.library.detail(second);
      expect(detail.primary_pdf).not.toBeNull();
      if (cancel) {
        expect(report.interrupted.map((item) => item.literature_id)).toEqual([
          second,
        ]);
        expect(detail.parser_result).toBeNull();
        expect(detail.content).toBeNull();
        expect(publications).not.toHaveBeenCalled();
      } else expect(detail.content).not.toBeNull();
    } finally {
      hold.resolve();
      await pending;
      await completion.close();
      await analysis.close();
      vi.restoreAllMocks();
      await env.close();
    }
  },
);
