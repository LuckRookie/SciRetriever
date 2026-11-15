import { initializeCatalogSchema } from "../src/storage/sqlite/catalog-schema.js";
import { rawParseArchive } from "./raw-parse-fixture.js";
import { parseRawParseProfile } from "@sciretriever/contracts";
import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseAsset,
  parseLibrarySearchRequest,
  parseLiterature,
  parseLiteratureId,
  parseMetaLiteratureId,
  sha256,
} from "@sciretriever/contracts";
import { createApplication } from "../src/bootstrap/application.js";
import { DatabaseCompletionService } from "../src/entry/database-completion.js";
import {
  LiteratureCompletionFailure,
  type LiteratureCompletionService,
} from "../src/entry/literature-completion.js";
import type { CandidatePublicationReceipt } from "@sciretriever/contracts";
import type {
  PdfAcquisitionOutcome,
  PdfAcquisitionPort,
} from "../src/entry/pdf-acquisition.js";
import { EntryPdfAcquisitionService } from "../src/entry/pdf-acquisition.js";
import { AcquisitionRouteError } from "../src/acquisition/tiered.js";
import { WriteAdmissionError } from "../src/storage/write-admission.js";
import { PublicAcquisitionRegistry } from "../src/index.js";
import { TypeScriptConfigurationOwner } from "../src/configuration/owner.js";
import { ParsingFailure } from "../src/parsing/ports.js";
import {
  FIXTURE_LITERATURE,
  workbenchPdf,
} from "../src/workbench/synthetic-fixture.js";
const lit = FIXTURE_LITERATURE.literature_id;
async function fixture(
  mode: "retry" | "parser-failure" | "wait-parser" | "draft-failure" = "retry",
) {
  const home = await mkdtemp(join(tmpdir(), "sciretriever-completion-"));
  const owner = new TypeScriptConfigurationOwner(home);
  await owner.publish(
    '[providers.fixture]\napi="openai-chat-completions"\nbase_url="http://127.0.0.1:9/v1"\n[models."fixture/model"]\nstream=false\n[analyze]\nmodel="fixture/model"\n',
    "missing",
    ["providers", "models", "analyze"],
  );
  await initializeCatalogSchema(join(home, "catalog.sqlite"));
  let calls = 0,
    parses = 0,
    started!: () => void;
  const parserStarted = new Promise<void>((r) => {
    started = r;
  });
  const app = await createApplication(home, {
    configurationOwner: owner,
    proofreadPages: {
      method: "synthetic-completion-pages-1",
      async inspect() {
        if (mode === "draft-failure")
          throw new Error("Synthetic page tools unavailable");
        return [
          {
            page: 0,
            kind: "text-layer",
            text: "Synthetic source\nThe yield was 67%.",
            visible_glyphs: 40,
            hidden_glyphs: 0,
            unmapped_glyphs: 0,
            has_graphics: false,
          },
        ];
      },
      async image() {
        throw new Error("Completion must not render a page image");
      },
    },

    agentTransportFactory: () => async () => {
      calls++;
      throw new Error("Completion must not call a model");
    },
    typescriptParserRuntime: {
      baseUrl: "http://127.0.0.1:9",
      modelIdentity: "synthetic-model",
      transport: {
        request: async (_, input) => {
          parses++;
          started();
          if (mode === "wait-parser")
            await new Promise<void>((_, reject) => {
              if (input.signal?.aborted) reject(new Error("aborted"));
              else
                input.signal?.addEventListener(
                  "abort",
                  () => reject(new Error("aborted")),
                  { once: true },
                );
            });
          if (mode === "parser-failure")
            throw new ParsingFailure("parser-unavailable");
          return {
            status: 200,
            headers: [["content-type", "application/zip"]],
            body: rawParseArchive(
              parseRawParseProfile(input.headers["x-sciretriever-profile"]),
            ),
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
      captured_at: "2026-10-20T00:00:00Z",
    });
    await app.execution!.transfers.append(id, bytes);
    await app.execution!.transfers.complete(id);
  }
  return {
    app,
    home,
    bad,
    good,
    parserStarted,
    get calls() {
      return calls;
    },
    get parses() {
      return parses;
    },
    close: async () => {
      await app.close();
      await rm(home, { recursive: true, force: true });
    },
  };
}
it("accepts one PDF, publishes the deployment raw profile, reuses it and never invokes the old analysis chain", async () => {
  const e = await fixture();
  try {
    const result = await e.app.completion!.complete({
      literature_id: lit,
      transfer_ids: ["first", "duplicate", "next"],
    });
    expect(result.outcome).toBe("parser_results_ready");
    expect(result.attempts).toEqual([
      { transfer_id: "first", outcome: "accepted" },
    ]);
    expect(e.parses).toBe(1);
    expect(e.calls).toBe(0);
    const detail = await e.app.library.detail(lit);
    expect(detail.primary_pdf!.asset.sha256).toBe(await sha256(e.bad));
    expect(detail).not.toHaveProperty("parser_result");
    expect(detail).not.toHaveProperty("content");
    expect(await e.app.completion!.isReady(lit)).toBe(true);
    expect(
      (
        await e.app.documentRead.default({
          literature_id: lit,
          asset_id: detail.primary_pdf!.asset.asset_id,
          asset_sha256: detail.primary_pdf!.asset.sha256,
        })
      ).default,
    ).toMatchObject({
      document_version_id:
        result.outcome === "parser_results_ready"
          ? result.receipt.draft.status === "formed"
            ? result.receipt.draft.document_version_id
            : "missing"
          : "missing",
    });
    expect(result).toMatchObject({
      receipt: { draft: { status: "formed", default_text_level: "draft" } },
    });
    const again = await e.app.completion!.complete({
      literature_id: lit,
      transfer_ids: ["next"],
    });
    expect(again).toMatchObject({
      outcome: "parser_results_ready",
      attempts: [],
      receipt: {
        profiles: [{ profile: "vlm-engine", status: "reused" }],
        draft: { status: "reused", default_changed: false },
      },
    });
    expect(e.parses).toBe(1);
    expect(e.calls).toBe(0);
    await e.app.close();
    const reopened = await createApplication(e.home, {});
    try {
      expect(await reopened.completion!.isReady(lit)).toBe(true);
      expect(await reopened.library.detail(lit)).toEqual(detail);
    } finally {
      await reopened.close();
    }
  } finally {
    await e.close();
  }
}, 30000);
it("reports a draft failure in the per-literature completion receipt without counting it as parsing failure", async () => {
  const e = await fixture("draft-failure");
  try {
    const result = await e.app.completion!.complete({
      literature_id: lit,
      transfer_ids: ["first"],
    });
    expect(result).toMatchObject({
      outcome: "parser_results_ready",
      receipt: {
        profiles: [{ status: "published" }],
        draft: { status: "failed", failure_code: "page-tools-unavailable" },
      },
    });
    expect(await e.app.completion!.isReady(lit)).toBe(true);
    expect(e.calls).toBe(0);
  } finally {
    await e.close();
  }
}, 30_000);
it("retains a valid PDF and all candidates after parser failure without recording automatic acquisition exhaustion", async () => {
  const e = await fixture("parser-failure");
  try {
    const result = await e.app.completion!.complete({
      literature_id: lit,
      transfer_ids: ["first", "next"],
    });
    expect(result).toMatchObject({
      outcome: "parsing_failed",
      receipt: { profiles: [{ profile: "vlm-engine", status: "failed" }] },
    });
    const detail = await e.app.library.detail(lit);
    expect(detail.primary_pdf!.asset.sha256).toBe(await sha256(e.bad));
    expect(detail).not.toHaveProperty("content");
    expect(detail).not.toHaveProperty("parser_result");
    expect(await e.app.database.hasAutomaticPdfExhaustion(lit)).toBe(false);
    expect(await e.app.database.getCandidate("next")).not.toBeNull();
    expect(e.calls).toBe(0);
  } finally {
    await e.close();
  }
}, 30000);
it("treats supplied-list exhaustion as transient feedback and permits a later supplied candidate", async () => {
  const e = await fixture();
  try {
    expect(
      await e.app.completion!.complete({
        literature_id: lit,
        transfer_ids: ["missing"],
      }),
    ).toMatchObject({
      outcome: "supplied_candidates_exhausted",
      attempts: [{ transfer_id: "missing", outcome: "candidate_missing" }],
    });
    expect(await e.app.database.hasAutomaticPdfExhaustion(lit)).toBe(false);
    expect(e.parses).toBe(0);
    expect(
      (
        await e.app.completion!.complete({
          literature_id: lit,
          transfer_ids: ["first"],
        })
      ).outcome,
    ).toBe("parser_results_ready");
  } finally {
    await e.close();
  }
}, 30000);
it("rejects overlapping work and cancels pending profiles on shutdown while preserving the accepted PDF", async () => {
  const e = await fixture("wait-parser");
  try {
    const pending = e.app.completion!.complete({
      literature_id: lit,
      transfer_ids: ["first"],
    });
    const rejected = expect(pending).rejects.toMatchObject({
      code: "completion-cancelled",
    });
    await e.parserStarted;
    await expect(
      e.app.completion!.complete({
        literature_id: lit,
        transfer_ids: ["next"],
      }),
    ).rejects.toMatchObject({ code: "completion-active" });
    await e.app.completion!.close();
    await rejected;
    expect((await e.app.library.detail(lit)).primary_pdf).not.toBeNull();
    expect(e.calls).toBe(0);
    expect(await e.app.database.hasAutomaticPdfExhaustion(lit)).toBe(false);
  } finally {
    await e.close();
  }
}, 30000);
it("rejects malformed and pre-cancelled completion before accepting a PDF", async () => {
  const e = await fixture();
  try {
    await expect(
      e.app.completion!.complete({
        literature_id: lit,
        transfer_ids: ["../invalid"],
      }),
    ).rejects.toMatchObject({ code: "completion-command" });
    await expect(
      e.app.completion!.complete(
        { literature_id: lit, transfer_ids: ["first"] },
        AbortSignal.abort(),
      ),
    ).rejects.toMatchObject({ code: "completion-cancelled" });
    expect((await e.app.library.detail(lit)).primary_pdf).toBeNull();
    expect(e.parses).toBe(0);
  } finally {
    await e.close();
  }
}, 30000);
it("clears an existing exhaustion marker only when a PDF is accepted, even if parsing subsequently fails", async () => {
  const e = await fixture("parser-failure");
  try {
    await e.app.database.setAutomaticPdfExhaustion(lit);
    await e.app.completion!.complete({
      literature_id: lit,
      transfer_ids: ["missing"],
    });
    expect(await e.app.database.hasAutomaticPdfExhaustion(lit)).toBe(true);
    await e.app.completion!.complete({
      literature_id: lit,
      transfer_ids: ["first"],
    });
    expect(await e.app.database.hasAutomaticPdfExhaustion(lit)).toBe(false);
    expect(e.calls).toBe(0);
  } finally {
    await e.close();
  }
}, 30000);

it("refuses a candidate captured for a different article without consuming it", async () => {
  const e = await fixture();
  try {
    const other = "00000000-0000-4000-9000-000000001234";
    await e.app.database.putLiterature(
      parseLiterature({
        ...FIXTURE_LITERATURE,
        literature_id: other,
        meta_literature_id: "00000000-0000-4000-9000-000000001235",
        metadata: { ...FIXTURE_LITERATURE.metadata, identifiers: [] },
      }),
    );
    await expect(
      e.app.completion!.complete({
        literature_id: other,
        transfer_ids: ["first"],
      }),
    ).rejects.toMatchObject({ code: "completion-command" });
    expect((await e.app.library.detail(other)).primary_pdf).toBeNull();
    expect((await e.app.library.detail(lit)).primary_pdf).toBeNull();
    expect(await e.app.database.getCandidate("first")).not.toBeNull();
    expect(e.parses).toBe(0);
    expect(e.calls).toBe(0);
  } finally {
    await e.close();
  }
});

const orchestrationId = (n: number) =>
  `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;

const routeFailure = {
  code: "candidate-download-failed" as const,
  source: "fixture",
  reason:
    "The candidate failed delivery or PDF acceptance; the next candidate remains eligible.",
  retryable: true,
};

const receiptSha256 = await sha256(
  new TextEncoder().encode("completion-receipt"),
);

const publicationReceipt: CandidatePublicationReceipt = {
  receipt_id: "receipt-1",
  literature_id: FIXTURE_LITERATURE.literature_id,
  asset_id: "asset-1",
  sha256: receiptSha256,
  reference: ".candidates/aa.bin",
  created: false,
};

function acquired(literatureId: string): PdfAcquisitionOutcome {
  return {
    kind: "acquired",
    literature_id: parseLiteratureId(literatureId),
    receipt: publicationReceipt,
  };
}

interface ScriptedAcquisition {
  readonly calls: string[];
  readonly port: PdfAcquisitionPort;
}

async function orchestrationFixture(
  metaGroups: readonly (readonly number[])[],
): Promise<{
  readonly app: Awaited<ReturnType<typeof createApplication>>;
  readonly literatures: readonly string[];
  readonly close: () => Promise<void>;
  readonly publishPdf: (literatureId: string, name: string) => Promise<void>;
}> {
  const home = await mkdtemp(join(tmpdir(), "sciretriever-orchestration-"));
  const app = await createApplication(home, {});
  const literatures: string[] = [];
  for (const [groupIndex, group] of metaGroups.entries()) {
    for (const value of group) {
      const literatureId = orchestrationId(value);
      literatures.push(literatureId);
      await app.database.putLiterature(
        parseLiterature({
          ...FIXTURE_LITERATURE,
          literature_id: literatureId,
          meta_literature_id: orchestrationId(10_000 + groupIndex),
          version_role: value % 2 === 0 ? "published" : "preprint",
          metadata: {
            ...FIXTURE_LITERATURE.metadata,
            title: `Orchestration paper ${value}`,
            identifiers: [
              { namespace: "doi", value: `10.1000/orchestration.${value}` },
            ],
          },
        }),
      );
    }
  }
  const publishPdf = async (literatureId: string, name: string) => {
    const bytes = Buffer.from(`%PDF-1.4\nsynthetic-${name}\n%%EOF\n`);
    const stage = await app.files.stage({ maxBytes: bytes.length });
    await stage.write(bytes);
    await app.files.publish(stage, `objects/${name}.pdf`);
    const asset = parseAsset({
      asset_id: orchestrationId(20_000 + name.length),
      sha256: await sha256(bytes),
      size_bytes: bytes.length,
      media_type: "application/pdf",
      path: `objects/${name}.pdf`,
    });
    await app.database.putLiteratureAsset({
      literature_asset_id: orchestrationId(21_000 + name.length),
      literature_id: literatureId,
      asset,
      role: "primary-pdf",
      source_url: null,
      provenance: {
        provenance_id: orchestrationId(22_000 + name.length),
        source_kind: "user",
        source_name: "orchestration-fixture",
        source_record_id: null,
        observed_at: "2026-09-11T00:00:00Z",
        input_sha256: asset.sha256,
        parameters_sha256: null,
      },
    });
  };
  return {
    app,
    literatures,
    publishPdf,
    close: async () => {
      await app.close();
      await rm(home, { recursive: true, force: true });
    },
  };
}

function scriptedAcquisition(
  script: ReadonlyMap<
    string,
    | { readonly kind: "exhausted" }
    | { readonly kind: "route-failure" }
    | { readonly kind: "cancelled" }
    | ((request: { readonly literature_id: string }) => {
        readonly kind: "cancelled";
      })
  >,
): ScriptedAcquisition {
  const calls: string[] = [];
  return {
    calls,
    port: {
      async acquire(request) {
        calls.push(request.literature_id);
        const entry = script.get(request.literature_id);
        if (!entry) throw new Error("acquisition script is missing");
        if (typeof entry === "function") return entry(request);
        if (entry.kind === "route-failure")
          return { kind: "route-failure", failure: routeFailure };
        return entry;
      },
    },
  };
}

function completionService(
  env: Awaited<ReturnType<typeof orchestrationFixture>>,
  acquisition: ScriptedAcquisition["port"],
  completion: Pick<
    LiteratureCompletionService,
    "complete" | "isReady"
  > | null = null,
): DatabaseCompletionService {
  return new DatabaseCompletionService({
    library: env.app.library,
    database: env.app.database,
    writes: env.app.writes,
    completion,
    acquisition,
  });
}

describe("database completion report orchestration", () => {
  it.each(["retry", "draft-failure"] as const)(
    "keeps the real per-literature receipt in the completed report (%s)",
    async (mode) => {
      const env = await fixture(mode);
      const service = new DatabaseCompletionService({
        library: env.app.library,
        database: env.app.database,
        writes: env.app.writes,
        completion: env.app.completion,
        acquisition: null,
      });
      try {
        const report = await service.run({
          selector: {
            kind: "literatures",
            literature_ids: [parseLiteratureId(lit)],
          },
          goal: "PARSER_RESULT_READY",
          transfer_ids: ["first"],
        });
        expect(report.end).toEqual({ kind: "finished" });
        expect(report.failed).toEqual([]);
        expect(report.completed).toHaveLength(1);
        expect(report.completed[0]).toMatchObject({
          literature_id: lit,
          receipt: {
            literature_id: lit,
            profiles: [{ profile: "vlm-engine", status: "published" }],
            draft:
              mode === "retry"
                ? { status: "formed", default_text_level: "draft" }
                : { status: "failed", failure_code: "page-tools-unavailable" },
          },
        });
        expect(env.calls).toBe(0);
        expect(env.parses).toBe(1);
      } finally {
        await env.close();
      }
    },
    30_000,
  );
  it("retries explicit supplied PDFs and excludes its unfinished sibling from broad parsing scopes", async () => {
    const env = await fixture();
    let acquisitions = 0;
    const service = new DatabaseCompletionService({
      library: env.app.library,
      database: env.app.database,
      writes: env.app.writes,
      completion: env.app.completion,
      acquisition: {
        acquire: async () => {
          acquisitions++;
          throw new Error("unexpected fixture acquisition");
        },
      },
    });
    try {
      await env.app.database.setAutomaticPdfExhaustion(lit);
      const explicit = await service.run({
        selector: {
          kind: "literatures",
          literature_ids: [parseLiteratureId(lit)],
        },
        goal: "PARSER_RESULT_READY",
        transfer_ids: ["first", "duplicate", "next"],
      });
      expect(explicit.completed).toMatchObject([{ literature_id: lit }]);
      expect(explicit.failed).toEqual([]);

      expect(await env.app.database.hasAutomaticPdfExhaustion(lit)).toBe(false);
      await env.app.database.putLiterature(
        parseLiterature({
          ...FIXTURE_LITERATURE,
          literature_id: orchestrationId(90_001),
          version_role: "preprint",
          metadata: {
            ...FIXTURE_LITERATURE.metadata,
            title: "Unfinished sibling",
            identifiers: [
              { namespace: "doi", value: "10.1000/scope.unfinished" },
            ],
          },
        }),
      );
      for (const selector of [
        { kind: "all-pending" as const },
        {
          kind: "query" as const,
          query: parseLibrarySearchRequest({
            query: { text: "Unfinished sibling" },
          }).query,
        },
      ]) {
        const report = await service.run({
          selector,
          goal: "PARSER_RESULT_READY",
        });
        expect(report.end).toEqual({ kind: "finished" });
        expect([
          report.completed,
          report.failed,
          report.skipped,
          report.notStarted,
          report.interrupted,
        ]).toMatchObject([[], [], [], [], []]);
      }
      expect(acquisitions).toBe(0);
      expect(env.parses).toBe(1);
      expect(env.calls).toBe(0);
    } finally {
      await env.close();
    }
  });

  it("partitions every frozen target once and commits exhaustion only for a normal route end", async () => {
    const env = await orchestrationFixture([[1], [2], [3], [4], [5]]);
    try {
      const [completedId, skippedId, failedId, interruptedId, notStartedId] =
        env.literatures;
      const controller = new AbortController();
      const acquisition: ScriptedAcquisition["port"] = {
        async acquire(request) {
          if (request.literature_id === completedId)
            return acquired(completedId!);
          if (request.literature_id === skippedId) return { kind: "exhausted" };
          if (request.literature_id === failedId)
            return { kind: "route-failure", failure: routeFailure };
          controller.abort();
          return { kind: "cancelled" };
        },
      };
      const report = await completionService(env, acquisition).run(
        {
          selector: {
            kind: "literatures",
            literature_ids: env.literatures.map(parseLiteratureId),
          },
          goal: "ASSET_READY",
        },
        { signal: controller.signal },
      );
      expect(report.end).toEqual({ kind: "interrupted" });
      expect(report.completed.map((item) => item.literature_id)).toEqual([
        completedId,
      ]);
      expect(report.failed).toMatchObject([
        {
          target: { kind: "literature", literature_id: failedId },
          literature_id: failedId,
          stage: "acquisition",
          failure: { code: "pdf-route-delivery-failed", retryable: true },
        },
      ]);
      expect(report.skipped).toMatchObject([
        {
          target: { kind: "literature", literature_id: skippedId },
          reason: "manual-pdf-required",
          literature_ids: [skippedId],
        },
      ]);
      // Every failure that reaches the report also passed the contract parser's
      // stable-text boundary: no URL, absolute path or secret-like text.
      const failure = report.failed[0]!.failure;
      expect(failure.reason).not.toContain("://");
      expect(JSON.stringify(failure)).not.toMatch(
        /(?:^|[\s(])\/(?:[^\s/]+\/)*[^\s]*/u,
      );
      expect(report.interrupted).toMatchObject([
        {
          target: { kind: "literature", literature_id: interruptedId },
          literature_id: interruptedId,
        },
      ]);
      expect(report.notStarted).toMatchObject([
        { target: { kind: "literature", literature_id: notStartedId } },
      ]);
      expect(
        report.completed.length +
          report.failed.length +
          report.skipped.length +
          report.notStarted.length +
          report.interrupted.length,
      ).toBe(5);
      // Only the normally exhausted route may become a durable fact.
      expect(await env.app.database.hasAutomaticPdfExhaustion(skippedId!)).toBe(
        true,
      );
      expect(await env.app.database.hasAutomaticPdfExhaustion(failedId!)).toBe(
        false,
      );
      expect(
        await env.app.database.hasAutomaticPdfExhaustion(interruptedId!),
      ).toBe(false);
      // Another target's failure never removed this target's committed facts.
      expect(await env.app.database.getLiterature(completedId!)).not.toBeNull();
    } finally {
      await env.close();
    }
  });

  it("clears an exhausted fact only for an explicit retry and reports an already satisfied goal", async () => {
    const env = await orchestrationFixture([[11], [12]]);
    try {
      const [retryId, satisfiedId] = env.literatures;
      await env.publishPdf(satisfiedId!, "satisfied");
      await env.app.database.setAutomaticPdfExhaustion(retryId!);
      const factsSeen: boolean[] = [];
      const acquisition: ScriptedAcquisition["port"] = {
        async acquire(request) {
          factsSeen.push(
            await env.app.database.hasAutomaticPdfExhaustion(
              request.literature_id,
            ),
          );
          return acquired(request.literature_id);
        },
      };
      const report = await completionService(env, acquisition).run({
        selector: {
          kind: "literatures",
          literature_ids: env.literatures.map(parseLiteratureId),
        },
        goal: "ASSET_READY",
      });
      expect(report.end).toEqual({ kind: "finished" });
      expect(factsSeen).toEqual([false]);
      expect(report.completed.map((item) => item.literature_id)).toEqual([
        retryId,
      ]);
      expect(report.skipped).toMatchObject([
        { reason: "already-satisfied", literature_ids: [satisfiedId] },
      ]);
    } finally {
      await env.close();
    }
  });

  it("orders version candidates by completeness and never falls back across versions on an error", async () => {
    const exhaustedFirst = await orchestrationFixture([[22, 21]]);
    try {
      const [versionA, versionB] = exhaustedFirst.literatures;
      const acquisition = scriptedAcquisition(
        new Map([
          [versionA!, { kind: "exhausted" } as const],
          [versionB!, { kind: "route-failure" } as const],
        ]),
      );
      const report = await completionService(
        exhaustedFirst,
        acquisition.port,
      ).run({
        selector: {
          kind: "meta-literatures",
          meta_literature_ids: [parseMetaLiteratureId(orchestrationId(10_000))],
        },
        goal: "ASSET_READY",
      });
      // A normally exhausted candidate advances to the next version; the second
      // version's route failure then ends the target with exactly one failure.
      expect(acquisition.calls).toEqual([versionA, versionB]);
      expect(report.failed).toMatchObject([
        {
          target: { kind: "meta-literature" },
          literature_id: versionB,
          stage: "acquisition",
          failure: { code: "pdf-route-delivery-failed" },
        },
      ]);
      expect(report.skipped).toEqual([]);
      expect(
        await exhaustedFirst.app.database.hasAutomaticPdfExhaustion(versionA!),
      ).toBe(true);
      const failedFirst = await orchestrationFixture([[24, 23]]);
      try {
        const [errorVersion, later] = failedFirst.literatures;
        const errorAcquisition = scriptedAcquisition(
          new Map([
            [errorVersion!, { kind: "route-failure" } as const],
            [later!, { kind: "exhausted" } as const],
          ]),
        );
        const errorReport = await completionService(
          failedFirst,
          errorAcquisition.port,
        ).run({
          selector: {
            kind: "meta-literatures",
            meta_literature_ids: [
              parseMetaLiteratureId(orchestrationId(10_000)),
            ],
          },
          goal: "ASSET_READY",
        });
        // The error did not trigger a cross-version fallback.
        expect(errorAcquisition.calls).toEqual([errorVersion]);
        expect(errorReport.failed).toHaveLength(1);
        expect(errorReport.completed).toEqual([]);
        expect(errorReport.skipped).toEqual([]);
        expect(errorReport.end).toEqual({ kind: "finished" });
      } finally {
        await failedFirst.close();
      }
    } finally {
      await exhaustedFirst.close();
    }
  });

  it("does not freeze a meta scope whose goal is already reached", async () => {
    const env = await orchestrationFixture([[31, 32]]);
    try {
      await env.publishPdf(env.literatures[0]!, "already");
      const acquisition = scriptedAcquisition(new Map());
      const report = await completionService(env, acquisition.port).run({
        selector: {
          kind: "meta-literatures",
          meta_literature_ids: [parseMetaLiteratureId(orchestrationId(10_000))],
        },
        goal: "ASSET_READY",
      });
      expect(acquisition.calls).toEqual([]);
      expect(report.completed).toEqual([]);
      expect(report.failed).toEqual([]);
      expect(report.skipped).toEqual([]);
      expect(report.notStarted).toEqual([]);
      expect(report.interrupted).toEqual([]);
      expect(report.end).toEqual({ kind: "finished" });
    } finally {
      await env.close();
    }
  });

  it("isolates supplied-candidate and stale-input failures without touching other targets", async () => {
    const env = await orchestrationFixture([[41], [42]]);
    try {
      const [cleanedId, staleId] = env.literatures;
      const calls: string[] = [];
      const completion: Pick<
        LiteratureCompletionService,
        "complete" | "isReady"
      > = {
        isReady: async () => false,
        async complete(command) {
          calls.push(command.literature_id);
          if (command.literature_id === cleanedId)
            return {
              outcome: "supplied_candidates_exhausted",
              literature_id: cleanedId!,
              attempts: [
                { transfer_id: "first", outcome: "candidate_missing" },
              ],
            };
          throw new LiteratureCompletionFailure("completion-stale");
        },
      };
      const report = await completionService(
        env,
        scriptedAcquisition(new Map()).port,
        completion,
      ).run({
        selector: {
          kind: "literatures",
          literature_ids: env.literatures.map(parseLiteratureId),
        },
        goal: "PARSER_RESULT_READY",
      });
      expect(calls).toEqual([cleanedId, staleId]);
      expect(report.end).toEqual({ kind: "finished" });
      expect(report.failed).toMatchObject([
        {
          literature_id: cleanedId,
          stage: "acquisition",
          failure: { code: "completion-candidates-exhausted" },
        },
        {
          literature_id: staleId,
          stage: "literature",
          failure: { code: "completion-stale", retryable: true },
        },
      ]);
    } finally {
      await env.close();
    }
  });

  it("stops scheduling after a shared-dependency failure and still reports completed and notStarted targets", async () => {
    const env = await orchestrationFixture([[51], [52], [53]]);
    try {
      const [completedId, blockedId, notStartedId] = env.literatures;
      const acquisition: ScriptedAcquisition["port"] = {
        async acquire(request) {
          if (request.literature_id === completedId)
            return acquired(completedId!);
          throw new WriteAdmissionError("write-admission-closed");
        },
      };
      const report = await completionService(env, acquisition).run({
        selector: {
          kind: "literatures",
          literature_ids: env.literatures.map(parseLiteratureId),
        },
        goal: "ASSET_READY",
      });
      expect(report.completed.map((item) => item.literature_id)).toEqual([
        completedId,
      ]);
      expect(report.failed).toMatchObject([
        {
          literature_id: blockedId,
          stage: "acquisition",
          failure: { code: "pdf-acquisition-storage-failed", retryable: false },
        },
      ]);
      expect(report.notStarted).toMatchObject([
        { target: { kind: "literature", literature_id: notStartedId } },
      ]);
      expect(report.end).toMatchObject({
        kind: "failed",
        failure: { code: "pdf-acquisition-storage-failed" },
      });
      expect(await env.app.database.hasAutomaticPdfExhaustion(blockedId!)).toBe(
        false,
      );
    } finally {
      await env.close();
    }
  });
  it("preserves an exhausted marker for a wide scope without retrying routes", async () => {
    const env = await orchestrationFixture([[61]]);
    try {
      const [literatureId] = env.literatures;
      await env.app.database.setAutomaticPdfExhaustion(literatureId!);
      const markerSeen: boolean[] = [];
      const acquisition: ScriptedAcquisition["port"] = {
        async acquire(request) {
          markerSeen.push(
            await env.app.database.hasAutomaticPdfExhaustion(
              request.literature_id,
            ),
          );
          return { kind: "route-failure", failure: routeFailure };
        },
      };
      const report = await completionService(env, acquisition).run({
        selector: {
          kind: "meta-literatures",
          meta_literature_ids: [parseMetaLiteratureId(orchestrationId(10_000))],
        },
        goal: "ASSET_READY",
      });
      // A wide MetaLiterature selector preserves the fact; only a concrete
      // single-Literature selector may treat the run as an explicit retry.
      expect(markerSeen).toEqual([]);
      expect(
        await env.app.database.hasAutomaticPdfExhaustion(literatureId!),
      ).toBe(true);
      expect(report.failed).toEqual([]);
      expect(report.skipped).toMatchObject([
        { reason: "manual-pdf-required", literature_ids: [literatureId] },
      ]);
    } finally {
      await env.close();
    }
  });
  it("keeps finished when the stop arrives after the last target reached its partition", async () => {
    const env = await orchestrationFixture([[71]]);
    try {
      const [literatureId] = env.literatures;
      const controller = new AbortController();
      const acquisition: ScriptedAcquisition["port"] = {
        async acquire() {
          // The runner already delivered its own outcome; the abort is observed
          // only after that boundary.
          controller.abort();
          return acquired(literatureId!);
        },
      };
      const report = await completionService(env, acquisition).run(
        {
          selector: {
            kind: "literatures",
            literature_ids: [parseLiteratureId(literatureId!)],
          },
          goal: "ASSET_READY",
        },
        { signal: controller.signal },
      );
      // No target was active and none remained unstarted, so this is not a
      // phantom interruption.
      expect(report.end).toEqual({ kind: "finished" });
      expect(report.completed).toHaveLength(1);
      expect(report.interrupted).toEqual([]);
      expect(report.notStarted).toEqual([]);
    } finally {
      await env.close();
    }
  });

  it("interrupts the end only when a target was active or one never started", async () => {
    const active = await orchestrationFixture([[72]]);
    try {
      const [literatureId] = active.literatures;
      const controller = new AbortController();
      const acquisition: ScriptedAcquisition["port"] = {
        async acquire() {
          controller.abort();
          return { kind: "cancelled" };
        },
      };
      const report = await completionService(active, acquisition).run(
        {
          selector: {
            kind: "literatures",
            literature_ids: [parseLiteratureId(literatureId!)],
          },
          goal: "ASSET_READY",
        },
        { signal: controller.signal },
      );
      expect(report.end).toEqual({ kind: "interrupted" });
      expect(report.interrupted).toHaveLength(1);
      expect(report.notStarted).toEqual([]);
    } finally {
      await active.close();
    }

    const pending = await orchestrationFixture([[73], [74]]);
    try {
      const [first, second] = pending.literatures;
      const controller = new AbortController();
      const acquisition: ScriptedAcquisition["port"] = {
        async acquire() {
          controller.abort();
          return acquired(first!);
        },
      };
      const report = await completionService(pending, acquisition).run(
        {
          selector: {
            kind: "literatures",
            literature_ids: pending.literatures.map(parseLiteratureId),
          },
          goal: "ASSET_READY",
        },
        { signal: controller.signal },
      );
      // The schedule stopped before the second frozen target started.
      expect(report.end).toEqual({ kind: "interrupted" });
      expect(report.completed).toHaveLength(1);
      expect(report.interrupted).toEqual([]);
      expect(report.notStarted).toMatchObject([
        { target: { kind: "literature", literature_id: second } },
      ]);
    } finally {
      await pending.close();
    }
  });
});

describe("entry pdf acquisition assistance policy", () => {
  it("keeps pause, notify and cancellation as distinct stable outcomes", async () => {
    const env = await orchestrationFixture([[81]]);
    try {
      const [literatureId] = env.literatures;
      const detail = await env.app.library.detail(literatureId!);
      const facts = await env.app.database.currentFacts(literatureId!);
      const broken = {
        source_name: "broken",
        ready: true,
        async discover() {
          // Explicit provider route failure so the assistance policy applies.
          throw new AcquisitionRouteError(
            "source-discovery-failed",
            "fixture provider failure",
          );
        },
      };
      const ports = {
        registry: new PublicAcquisitionRegistry([broken], ["broken"]),
        network_budget: env.app.networkBudget,
        transfers: env.app.execution!.transfers,
        acceptance: env.app.execution!.acceptance,
        cooldown_ms: 0,
      };
      const request = {
        literature_id: parseLiteratureId(literatureId!),
        detail,
        metadata_snapshot: facts!.metadata_snapshot,
        signal: new AbortController().signal,
      };
      await expect(
        new EntryPdfAcquisitionService({
          ...ports,
          assistance: "pause",
        }).acquire(request),
      ).resolves.toMatchObject({
        kind: "assistance-required",
        failure: { code: "assistance-required", retryable: false },
      });
      await expect(
        new EntryPdfAcquisitionService({
          ...ports,
          assistance: "notify",
        }).acquire(request),
      ).resolves.toMatchObject({
        kind: "policy-skip",
        failure: { code: "assistance-skipped", retryable: false },
      });
      await expect(
        new EntryPdfAcquisitionService({
          ...ports,
          assistance: "never",
        }).acquire(request),
      ).resolves.toMatchObject({
        kind: "route-failure",
        failure: { code: "source-discovery-failed", retryable: true },
      });

      const selector = {
        kind: "literatures" as const,
        literature_ids: [parseLiteratureId(literatureId!)],
      };
      // Action required is a failed target with its own stable code, never a
      // user-controlled stop.
      const actionRequired = await completionService(env, {
        acquire: async () => ({
          kind: "assistance-required",
          failure: {
            code: "assistance-required",
            source: "broken",
            reason:
              "The frozen policy paused this target for operator assistance.",
            retryable: false,
          },
        }),
      }).run({ selector, goal: "ASSET_READY" });
      expect(actionRequired.end).toEqual({ kind: "finished" });
      expect(actionRequired.interrupted).toEqual([]);
      expect(actionRequired.failed).toMatchObject([
        {
          stage: "acquisition",
          failure: { code: "pdf-assistance-required", retryable: false },
        },
      ]);
      expect(
        await env.app.database.hasAutomaticPdfExhaustion(literatureId!),
      ).toBe(false);

      // A notify policy stop is advisory: the eligible target is explicitly not executed
      // (`skipped`/`not-eligible`) instead of being reported as an acquisition failure,
      // and the stable `pdf-assistance-skipped` code travels on the progress record
      // (stderr) instead of being lost.
      const progress: string[] = [];
      const assistanceSkipped = await completionService(env, {
        acquire: async () => ({
          kind: "policy-skip",
          failure: {
            code: "assistance-skipped",
            source: "broken",
            reason:
              "The target was skipped after a non-terminal failure; notification is advisory only.",
            retryable: false,
          },
        }),
      }).run(
        { selector, goal: "ASSET_READY" },
        {
          on_progress: (item) =>
            progress.push(`${item.state}:${item.failure?.code ?? "-"}`),
        },
      );
      expect(assistanceSkipped.skipped).toMatchObject([
        { reason: "not-eligible", literature_ids: [literatureId] },
      ]);
      expect(assistanceSkipped.failed).toEqual([]);
      expect(progress).toContain("skipped:pdf-assistance-skipped");
      expect(
        await env.app.database.hasAutomaticPdfExhaustion(literatureId!),
      ).toBe(false);

      const cancelled = await completionService(env, {
        acquire: async () => ({ kind: "cancelled" }),
      }).run({ selector, goal: "ASSET_READY" });
      expect(cancelled.interrupted).toHaveLength(1);
      expect(cancelled.failed).toEqual([]);
      expect(cancelled.end).toEqual({ kind: "interrupted" });
    } finally {
      await env.close();
    }
  });
  it("treats an unrecognized acquisition exception as an operation failure without an exhaustion fact", async () => {
    const env = await orchestrationFixture([[91]]);
    try {
      const [literatureId] = env.literatures;
      const broken = {
        source_name: "broken",
        ready: true,
        async discover() {
          throw new Error("unclassified provider failure");
        },
      };
      const port = new EntryPdfAcquisitionService({
        registry: new PublicAcquisitionRegistry([broken], ["broken"]),
        network_budget: env.app.networkBudget,
        transfers: env.app.execution!.transfers,
        acceptance: env.app.execution!.acceptance,
        cooldown_ms: 0,
      });
      const report = await completionService(env, port).run({
        selector: {
          kind: "literatures",
          literature_ids: [parseLiteratureId(literatureId!)],
        },
        goal: "ASSET_READY",
      });
      // The unknown exception is a shared-dependency failure: failed target,
      // failed report end, never a skip and never a durable exhaustion fact.
      expect(report.failed).toMatchObject([
        {
          stage: "acquisition",
          failure: { code: "pdf-acquisition-failed", retryable: false },
        },
      ]);
      expect(report.end).toMatchObject({
        kind: "failed",
        failure: { code: "pdf-acquisition-failed" },
      });
      expect(report.skipped).toEqual([]);
      expect(
        await env.app.database.hasAutomaticPdfExhaustion(literatureId!),
      ).toBe(false);
    } finally {
      await env.close();
    }
  });
});
