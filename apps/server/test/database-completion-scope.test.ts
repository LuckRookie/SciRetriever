import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  parseAsset,
  parseLibraryQuery,
  parseLiterature,
  parseLiteratureId,
  parseMetaLiteratureId,
  parseMetadataObservation,
  sha256,
  type DatabaseCompletionReport,
  type LibraryQuery,
  type VersionRole,
} from "@sciretriever/contracts";
import { createApplication } from "../src/bootstrap/application.js";
import { DatabaseCompletionService } from "../src/entry/database-completion.js";
import {
  selectLiteratures,
  type LiteratureSelector,
} from "../src/entry/selectors.js";
import type { PdfAcquisitionPort } from "../src/entry/pdf-acquisition.js";
import { EntryPdfAcquisitionService } from "../src/entry/pdf-acquisition.js";
import { PublicAcquisitionRegistry } from "../src/acquisition/sources/public.js";
import {
  CatalogWriteAdmission,
  WriteAdmissionError,
} from "../src/storage/write-admission.js";
import { CandidateAcceptanceError } from "../src/acquisition/candidate-acceptance.js";
import { FIXTURE_LITERATURE } from "../src/workbench/synthetic-fixture.js";

const id = (n: number) =>
  `00000000-0000-4000-9000-${String(n).padStart(12, "0")}`;
const literatureId = (n: number) => parseLiteratureId(id(n));
const metaId = (n: number) => parseMetaLiteratureId(id(10_000 + n));
const query = (values: Partial<LibraryQuery> = {}) =>
  parseLibraryQuery({
    text: null,
    title: null,
    author: null,
    author_orcids: [],
    identifiers: [],
    publication_year_from: null,
    publication_year_to: null,
    venue: null,
    publisher: null,
    document_types: [],
    languages: [],
    keywords: [],
    version_roles: [],
    statuses: [],
    missing_steps: [],
    needs_manual_pdf: null,
    discovery_run_ids: [],
    ...values,
  });

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "sciretriever-completion-scope-"));
  const app = await createApplication(home, {
    executionSchema: "upgrade-synthetic",
  });
  const put = async (
    n: number,
    meta = n,
    role: VersionRole = "published",
    title = `Scope paper ${n}`,
  ) => {
    const literature = parseLiterature({
      ...FIXTURE_LITERATURE,
      literature_id: literatureId(n),
      meta_literature_id: metaId(meta),
      version_role: role,
      metadata: {
        ...FIXTURE_LITERATURE.metadata,
        title,
        identifiers: [{ namespace: "doi", value: `10.1000/scope.${n}` }],
      },
    });
    await app.database.putLiterature(literature);
    return literature;
  };
  const publishPdf = async (n: number) => {
    const bytes = Buffer.from(`%PDF-1.4\nsynthetic-scope-${n}\n%%EOF\n`);
    const staged = await app.files.stage({ maxBytes: bytes.length });
    await staged.write(bytes);
    const path = `objects/scope-${n}.pdf`;
    await app.files.publish(staged, path);
    const asset = parseAsset({
      asset_id: randomUUID(),
      sha256: await sha256(bytes),
      size_bytes: bytes.length,
      media_type: "application/pdf",
      path,
    });
    await app.database.putLiteratureAsset({
      literature_asset_id: randomUUID(),
      literature_id: literatureId(n),
      asset,
      role: "primary-pdf",
      source_url: null,
      provenance: {
        provenance_id: randomUUID(),
        source_kind: "user",
        source_name: "scope-fixture",
        source_record_id: null,
        observed_at: "2026-09-16T00:00:00Z",
        input_sha256: asset.sha256,
        parameters_sha256: null,
      },
    });
    return {
      kind: "acquired" as const,
      literature_id: literatureId(n),
      receipt: {
        receipt_id: `scope-${n}`,
        literature_id: literatureId(n),
        asset_id: asset.asset_id,
        sha256: asset.sha256,
        reference: asset.path,
        created: true,
      },
    };
  };
  const discovery = async (n: number) => {
    const literature = await app.database.getLiterature(id(n));
    const observation = parseMetadataObservation({
      observation_id: randomUUID(),
      metadata: literature!.metadata,
      version_role: literature!.version_role,
      provenance: {
        provenance_id: randomUUID(),
        source_kind: "metadata-provider",
        source_name: "scope-fixture",
        source_record_id: `scope-${n}`,
        observed_at: "2026-09-16T00:00:00Z",
        input_sha256: "a".repeat(64),
        parameters_sha256: null,
      },
      version_links: [],
      declared_keywords: [],
      reference_texts: [],
      reference_count: null,
      cited_by_count: null,
      asset_hints: [],
    });
    await app.observations.publish(observation);
    const facts = await app.database.currentFacts(id(n));
    await app.observations.accept(
      observation.observation_id,
      id(n),
      facts!.metadata_snapshot.revision,
      facts!.metadata_snapshot.sha256,
    );
    await app.database.putDiscovery({
      run: {
        discovery_run_id: id(20_000),
        kind: "topic",
        status: "COMPLETED",
        started_at: "2026-09-16T00:00:00Z",
        query: "scope",
        year_from: null,
        year_to: null,
      },
      providers: [],
      source_results: [],
      results: [{ meta_literature_id: literature!.meta_literature_id }],
      topic_causes: [
        {
          meta_literature_id: literature!.meta_literature_id,
          metadata_observation_id: observation.observation_id,
          actual_literature_id: id(n),
        },
      ],
      citation_causes: [],
    });
  };
  const service = (acquire: PdfAcquisitionPort["acquire"]) =>
    new DatabaseCompletionService({
      library: app.library,
      database: app.database,
      writes: app.writes,
      completion: null,
      acquisition: { acquire },
    });
  return {
    app,
    put,
    publishPdf,
    discovery,
    service,
    close: async () => {
      await app.close();
      await rm(home, { recursive: true, force: true });
    },
  };
}

function partitions(report: DatabaseCompletionReport) {
  return [
    report.completed,
    report.failed,
    report.skipped,
    report.notStarted,
    report.interrupted,
  ].flatMap((items) => items.map((item) => item.target));
}

describe("database completion scope and cancellation", () => {
  it("passes a frozen copy of runFrozen targets to the feedback callback", async () => {
    const env = await fixture();
    try {
      await env.put(1);
      const frozen = [
        {
          target: {
            kind: "literature" as const,
            literature_id: literatureId(1),
          },
          candidates: [literatureId(1)],
          clear_exhaustion: false,
        },
      ];
      const acquire = vi.fn<PdfAcquisitionPort["acquire"]>(() =>
        env.publishPdf(1),
      );
      const feedback: Array<{
        arrayFrozen: boolean;
        targetFrozen: boolean;
        distinct: boolean;
        mutationSucceeded: boolean;
      }> = [];
      const report = await env
        .service(acquire)
        .runFrozen(frozen, "ASSET_READY", {
          on_scope: (targets) => {
            feedback.push({
              arrayFrozen: Object.isFrozen(targets),
              targetFrozen: Object.isFrozen(targets[0]),
              distinct: targets[0] !== frozen[0]!.target,
              mutationSucceeded: Reflect.set(
                targets[0]!,
                "literature_id",
                literatureId(2),
              ),
            });
          },
        });
      expect(feedback).toEqual([
        {
          arrayFrozen: true,
          targetFrozen: true,
          distinct: true,
          mutationSucceeded: false,
        },
      ]);
      expect(acquire).toHaveBeenCalledTimes(1);
      expect(acquire.mock.calls[0]?.[0].literature_id).toBe(literatureId(1));
      expect(partitions(report)).toEqual([
        { kind: "literature", literature_id: literatureId(1) },
      ]);
      expect(frozen[0]?.target.literature_id).toBe(literatureId(1));
    } finally {
      await env.close();
    }
  });

  it("keeps query matches and sibling members distinct in one immutable selection snapshot", async () => {
    const env = await fixture();
    try {
      await env.put(1, 1, "preprint", "Needle paper");
      await env.put(2, 1, "published", "Sibling paper");
      await env.put(3, 3, "preprint", "Needle paper");
      await env.put(4, 3, "published", "Unrelated sibling");
      const read = vi.spyOn(env.app.database, "librarySnapshot");
      const snapshot = await env.app.library.selectionSnapshot(
        query({
          text: "Needle",
          identifiers: [{ namespace: "doi", value: "10.1000/scope.1" }],
        }),
      );
      expect(
        snapshot.matches.map((item) => item.literature.literature_id),
      ).toEqual([id(1)]);
      expect(
        snapshot.members.map((item) => item.literature.literature_id),
      ).toEqual([id(1), id(2)]);
      // Splitting membership and matches across two reads would permit a mixed snapshot.
      expect(read).toHaveBeenCalledTimes(1);
      expect(Object.isFrozen(snapshot)).toBe(true);
      expect(Object.isFrozen(snapshot.matches)).toBe(true);
      expect(Object.isFrozen(snapshot.members)).toBe(true);
      expect(
        await env.app.library.selectionSnapshot(query({ text: "absentword" })),
      ).toEqual({ matches: [], members: [] });
    } finally {
      vi.restoreAllMocks();
      await env.close();
    }
  });

  it.each([
    "all-pending",
    "query",
    "discovery-run",
    "meta-literatures",
    "import-report",
  ] as const)(
    "excludes a satisfied Meta even when %s only matches its unfinished version",
    async (kind) => {
      const env = await fixture();
      try {
        await env.put(1, 1, "preprint", "Needle version");
        await env.put(2, 1, "published", "Other version");
        await env.publishPdf(2);
        if (kind === "discovery-run") await env.discovery(1);
        const selector: LiteratureSelector =
          kind === "query"
            ? { kind, query: query({ text: "Needle" }) }
            : kind === "discovery-run"
              ? { kind, discovery_run_id: id(20_000) }
              : kind === "all-pending"
                ? { kind }
                : { kind, meta_literature_ids: [metaId(1)] };
        const acquire = vi.fn<PdfAcquisitionPort["acquire"]>(async () => ({
          kind: "exhausted",
        }));
        const report = await env
          .service(acquire)
          .run({ selector, goal: "ASSET_READY" });
        expect(report.end).toEqual({ kind: "finished" });
        expect(partitions(report)).toEqual([]);
        expect(acquire).not.toHaveBeenCalled();
        expect(await env.app.database.hasAutomaticPdfExhaustion(id(1))).toBe(
          false,
        );
      } finally {
        await env.close();
      }
    },
  );

  it("freezes all versions from the query snapshot without expanding ordinary search or export selectors", async () => {
    const env = await fixture();
    try {
      await env.put(1, 1, "preprint", "Needle version");
      await env.put(2, 1, "published", "Other version");
      await env.put(3, 3, "published", "Unrelated version");
      const selector = {
        kind: "query" as const,
        query: query({ text: "Needle" }),
      };
      expect(
        (await selectLiteratures(env.app.library, selector)).items.map(
          (item) => item.literature.literature_id,
        ),
      ).toEqual([id(1)]);
      const calls: string[] = [];
      const report = await env
        .service(async (request) => {
          calls.push(request.literature_id);
          return env.publishPdf(Number(request.literature_id.slice(-12)));
        })
        .run({ selector, goal: "ASSET_READY" });
      expect(calls).toEqual([id(2)]);
      expect(report.completed).toEqual([
        {
          target: { kind: "meta-literature", meta_literature_id: metaId(1) },
          literature_id: id(2),
        },
      ]);
      expect(
        (await selectLiteratures(env.app.library, selector)).items.map(
          (item) => item.literature.literature_id,
        ),
      ).toEqual([id(1)]);
    } finally {
      await env.close();
    }
  });

  it("does not retry exhausted versions in broad scopes and only clears an explicit retry", async () => {
    const env = await fixture();
    try {
      await env.put(1, 1, "published");
      await env.put(2, 1, "preprint");
      await env.app.database.setAutomaticPdfExhaustion(id(1));
      const calls: string[] = [];
      const acquire: PdfAcquisitionPort["acquire"] = async (request) => {
        calls.push(request.literature_id);
        expect(
          await env.app.database.hasAutomaticPdfExhaustion(
            request.literature_id,
          ),
        ).toBe(false);
        return { kind: "exhausted" };
      };
      const service = env.service(acquire);
      const report = await service.run({
        selector: {
          kind: "meta-literatures",
          meta_literature_ids: [metaId(1)],
        },
        goal: "ASSET_READY",
      });
      expect(calls).toEqual([id(2)]);
      expect(report.skipped).toMatchObject([
        { reason: "manual-pdf-required", literature_ids: [id(1), id(2)] },
      ]);
      const pending = await service.run({
        selector: { kind: "all-pending" },
        goal: "ASSET_READY",
      });
      expect(partitions(pending)).toEqual([]);
      const retry = await service.run({
        selector: { kind: "literatures", literature_ids: [literatureId(1)] },
        goal: "ASSET_READY",
      });
      expect(calls).toEqual([id(2), id(1)]);
      expect(retry.skipped).toHaveLength(1);
    } finally {
      await env.close();
    }
  });

  it.each([
    "all-pending",
    "query",
    "discovery-run",
    "meta-literatures",
    "import-report",
    "literatures",
  ] as const)(
    "freezes a pre-cancelled %s scope without starting acquisition or clearing facts",
    async (kind) => {
      const env = await fixture();
      try {
        await env.put(1);
        await env.put(2);
        if (kind === "discovery-run") await env.discovery(1);
        if (kind === "literatures")
          await env.app.database.setAutomaticPdfExhaustion(id(1));
        const selector: LiteratureSelector =
          kind === "query"
            ? { kind, query: query() }
            : kind === "discovery-run"
              ? { kind, discovery_run_id: id(20_000) }
              : kind === "literatures"
                ? {
                    kind,
                    literature_ids: [
                      literatureId(2),
                      literatureId(1),
                      literatureId(2),
                    ],
                  }
                : kind === "all-pending"
                  ? { kind }
                  : {
                      kind,
                      meta_literature_ids: [metaId(2), metaId(1), metaId(2)],
                    };
        const acquire = vi.fn<PdfAcquisitionPort["acquire"]>();
        const controller = new AbortController();
        controller.abort();
        const report = await env
          .service(acquire)
          .run(
            { selector, goal: "ASSET_READY" },
            { signal: controller.signal },
          );
        expect(report.end).toEqual({ kind: "interrupted" });
        expect(partitions(report)).toEqual(
          report.notStarted.map((item) => item.target),
        );
        expect(report.notStarted).toHaveLength(
          kind === "discovery-run" ? 1 : 2,
        );
        if (kind === "literatures") {
          expect(report.notStarted.map((item) => item.target)).toEqual([
            { kind: "literature", literature_id: id(2) },
            { kind: "literature", literature_id: id(1) },
          ]);
          expect(await env.app.database.hasAutomaticPdfExhaustion(id(1))).toBe(
            true,
          );
        }
        if (kind === "meta-literatures" || kind === "import-report")
          expect(report.notStarted.map((item) => item.target)).toEqual([
            { kind: "meta-literature", meta_literature_id: metaId(2) },
            { kind: "meta-literature", meta_literature_id: metaId(1) },
          ]);
        expect(acquire).not.toHaveBeenCalled();
      } finally {
        await env.close();
      }
    },
  );

  it("does not start an invalid explicit scope or add a sibling to an explicit Literature", async () => {
    const env = await fixture();
    try {
      await env.put(1, 1, "preprint");
      await env.put(2, 1, "published");
      const acquire = vi.fn<PdfAcquisitionPort["acquire"]>(async () => ({
        kind: "exhausted",
      }));
      const service = env.service(acquire);
      await expect(
        service.run({
          selector: {
            kind: "literatures",
            literature_ids: [literatureId(1), literatureId(999)],
          },
          goal: "ASSET_READY",
        }),
      ).rejects.toMatchObject({ code: "literature-not-found" });
      expect(acquire).not.toHaveBeenCalled();
      const report = await service.run({
        selector: { kind: "literatures", literature_ids: [literatureId(1)] },
        goal: "ASSET_READY",
      });
      expect(
        acquire.mock.calls.map(([request]) => request.literature_id),
      ).toEqual([id(1)]);
      expect(report.skipped[0]?.target).toEqual({
        kind: "literature",
        literature_id: id(1),
      });
    } finally {
      await env.close();
    }
  });

  it("keeps frozen membership and candidate order while re-reading changed facts", async () => {
    const env = await fixture();
    try {
      await env.put(1, 1, "published");
      await env.put(2, 1, "accepted-manuscript");
      await env.put(3, 1, "preprint");
      await env.put(4, 4, "published");
      const calls: string[] = [];
      const report = await env
        .service(async (request) => {
          calls.push(request.literature_id);
          if (request.literature_id === id(1)) {
            await env.put(2, 1, "other", "Updated metadata");
            await env.put(3, 1, "published");
            await env.put(5, 1, "published");
            await env.put(6);
            await env.publishPdf(4);
            return { kind: "exhausted" };
          }
          expect(request.detail.literature.metadata.title).toBe(
            "Updated metadata",
          );
          return env.publishPdf(2);
        })
        .run({ selector: { kind: "all-pending" }, goal: "ASSET_READY" });
      expect(calls).toEqual([id(1), id(2)]);
      expect(partitions(report)).toHaveLength(2);
      expect(report.completed).toMatchObject([{ literature_id: id(2) }]);
      expect(report.skipped).toMatchObject([
        {
          target: { meta_literature_id: metaId(4) },
          reason: "already-satisfied",
          literature_ids: [id(4)],
        },
      ]);
      expect((await env.app.library.detail(id(5))).primary_pdf).toBeNull();
      expect((await env.app.library.detail(id(6))).primary_pdf).toBeNull();
    } finally {
      await env.close();
    }
  });

  it("honours cancellation after a detail read without acquiring or clearing exhaustion", async () => {
    const env = await fixture();
    try {
      await env.put(1);
      await env.app.database.setAutomaticPdfExhaustion(id(1));
      const controller = new AbortController();
      const detail = env.app.library.detail.bind(env.app.library);
      vi.spyOn(env.app.library, "detail").mockImplementation(async (value) => {
        const result = await detail(value);
        controller.abort();
        return result;
      });
      const acquire = vi.fn<PdfAcquisitionPort["acquire"]>(async () => ({
        kind: "exhausted",
      }));
      const report = await env.service(acquire).run(
        {
          selector: {
            kind: "literatures",
            literature_ids: [literatureId(1)],
          },
          goal: "ASSET_READY",
        },
        { signal: controller.signal },
      );
      expect(report.interrupted).toHaveLength(1);
      expect(report.skipped).toEqual([]);
      expect(acquire).not.toHaveBeenCalled();
      expect(await env.app.database.hasAutomaticPdfExhaustion(id(1))).toBe(
        true,
      );
    } finally {
      vi.restoreAllMocks();
      await env.close();
    }
  });

  it.each([
    new WriteAdmissionError("write-admission-closed"),
    new CandidateAcceptanceError("candidate-receipt-conflict"),
  ])(
    "preserves committed facts and reports a storage/receipt failure despite a concurrent abort: %s",
    async (failure) => {
      const env = await fixture();
      try {
        await env.put(1);
        await env.put(2);
        await env.put(3);
        const controller = new AbortController();
        const report = await env
          .service(async (request) => {
            if (request.literature_id === id(1)) return env.publishPdf(1);
            controller.abort();
            throw failure;
          })
          .run(
            {
              selector: {
                kind: "literatures",
                literature_ids: [
                  literatureId(1),
                  literatureId(2),
                  literatureId(3),
                ],
              },
              goal: "ASSET_READY",
            },
            { signal: controller.signal },
          );
        expect(report.end).toMatchObject({
          kind: "failed",
          failure: { code: "pdf-acquisition-storage-failed" },
        });
        expect(report.completed).toHaveLength(1);
        expect(report.failed).toHaveLength(1);
        expect(report.interrupted).toEqual([]);
        expect(report.notStarted).toHaveLength(1);
        expect(partitions(report)).toHaveLength(3);
        expect(
          (await env.app.library.detail(id(1))).primary_pdf,
        ).not.toBeNull();
        expect(await env.app.database.hasAutomaticPdfExhaustion(id(2))).toBe(
          false,
        );
      } finally {
        await env.close();
      }
    },
  );

  it.each(["run", "runFrozen"] as const)(
    "releases catalog admission during %s acquisition while preserving the frozen scope",
    async (method) => {
      const env = await fixture();
      const competitor = new CatalogWriteAdmission(env.app.writes.catalogPath);
      try {
        await env.put(1);
        const controller = new AbortController();
        const service = env.service(async () => {
          await expect(
            competitor.run(async () => undefined),
          ).resolves.toBeUndefined();
          await env.put(2);
          controller.abort();
          return { kind: "cancelled" };
        });
        const request = {
          selector: { kind: "all-pending" as const },
          goal: "ASSET_READY" as const,
        };
        const report =
          method === "run"
            ? await service.run(request, { signal: controller.signal })
            : await service.runFrozen(
                await service.freezeRequest(request),
                request.goal,
                { signal: controller.signal },
              );
        expect(report.end).toEqual({ kind: "interrupted" });
        expect(report.interrupted).toHaveLength(1);
        expect(partitions(report)).toHaveLength(1);
        await expect(
          competitor.run(async () => undefined),
        ).resolves.toBeUndefined();
      } finally {
        await competitor.close();
        await env.close();
      }
    },
  );

  it.each(["locator", "browser"] as const)(
    "preserves storage failure through the real %s acquisition adapter after abort",
    async (channel) => {
      const env = await fixture();
      try {
        await env.put(1);
        await env.put(2);
        const controller = new AbortController();
        const failure = new WriteAdmissionError("write-admission-security");
        const fail = async (): Promise<never> => {
          controller.abort();
          throw failure;
        };
        const source = {
          source_name: channel === "browser" ? "browser" : "fixture",
          ready: true,
          discover: channel === "browser" ? async () => [] : fail,
        };
        const acquisition = new EntryPdfAcquisitionService({
          registry: new PublicAcquisitionRegistry(
            [source],
            [source.source_name],
          ),
          network_budget: env.app.networkBudget,
          transfers: env.app.execution!.transfers,
          acceptance: env.app.execution!.acceptance,
          browser_host: () => ({
            deliverCandidate: fail,
            close: async () => undefined,
          }),
        });
        const report = await env
          .service(acquisition.acquire.bind(acquisition))
          .run(
            {
              selector: {
                kind: "literatures",
                literature_ids: [literatureId(1), literatureId(2)],
              },
              goal: "ASSET_READY",
            },
            { signal: controller.signal },
          );
        expect(report.end).toMatchObject({
          kind: "failed",
          failure: { code: "pdf-acquisition-storage-failed" },
        });
        expect(report.failed).toHaveLength(1);
        expect(report.notStarted).toHaveLength(1);
        expect(report.interrupted).toEqual([]);
        expect(await env.app.database.hasAutomaticPdfExhaustion(id(1))).toBe(
          false,
        );
      } finally {
        await env.close();
      }
    },
  );
});
