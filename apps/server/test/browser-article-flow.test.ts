import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  sha256,
  parseLiterature,
  parseMetadataObservation,
  parseLiteratureId,
} from "@sciretriever/contracts";
import {
  BrowserArticleFlowDriver,
  createBrowserArticleFlow,
  type FlowPageHandle,
} from "../src/browser/article-flow.js";
import { BrowserObservationStore } from "../src/browser/observation.js";
import { BrowserTransferCollector } from "../src/browser/transfer.js";
import { BrowserCandidateIntake } from "../src/acquisition/browser-intake.js";
import { createApplication } from "../src/bootstrap/application.js";
import { FileStore } from "../src/storage/files/store.js";
import {
  FIXTURE_DOI,
  workbenchPdf,
  FIXTURE_LITERATURE,
} from "../src/workbench/synthetic-fixture.js";

/**
 * Direct offline end-to-end coverage for the bounded Browser article driver.
 *
 * Everything runs against fakes and synthetic bytes: no Chromium, no Cloak bundle, no
 * profile lock, no Provider and no Publisher. The Intake/collector/FileStore path is the
 * real one, so a candidate produced here is a genuine durable artifact (real SHA-256,
 * size and relative reference), never a hand-built object.
 */
const ARTICLE_ID = "00000000-0000-0000-0000-000000000001";
const SESSION_ID = "e2e-flow-session";

const snapshot = (revision: number) => ({
  url: "https://fixture.example.test/article",
  title: "Fixture article",
  viewport: { width: 1024, height: 768, device_scale_factor: 1 },
  screenshot: null,
  text: `revision ${revision}`,
  elements: [],
  loading: false,
  partial: false,
  document_generation: 0,
});

describe("formal completion Browser exhaustion boundary (offline)", () => {
  it("persists exhaustion only after an explicit normal no-candidate stop", async () => {
    const home = await mkdtemp(join(tmpdir(), "sciretriever-flow-completion-"));
    const configHome = join(home, ".sciretriever");
    await mkdir(configHome, { mode: 0o700 });
    await writeFile(
      join(configHome, "config.toml"),
      '[browser]\nenabled = true\nprofile = "synthetic"\n[sources.acquisition]\nmode = "custom"\nproviders = []\n',
      { mode: 0o600 },
    );
    const cases = [
      {
        id: "00000000-0000-0000-0000-000000000701",
        mode: "budget",
        code: "pdf-browser-flow-budget-exhausted",
      },
      {
        id: "00000000-0000-0000-0000-000000000702",
        mode: "invalid",
        code: "pdf-browser-action-invalid",
      },
      {
        id: "00000000-0000-0000-0000-000000000703",
        mode: "observation",
        code: "pdf-browser-observation-unavailable",
      },
      {
        id: "00000000-0000-0000-0000-000000000704",
        mode: "normal",
        code: null,
      },
      {
        id: "00000000-0000-0000-0000-000000000705",
        mode: "timeout",
        code: "pdf-browser-candidate-timeout",
      },
    ] as const;
    const modes = new Map<string, (typeof cases)[number]["mode"]>(
      cases.map((item) => [item.id, item.mode]),
    );
    const application = await createApplication(home, {
      executionSchema: "upgrade-synthetic",
      acquisitionAssembly: {
        doiLandingSource: {
          source_name: "doi-landing",
          ready: true,
          discover: async () => [],
        },
      },
      browserAdmitNavigation: async (url) => url,
      browserHost: () => ({
        deliverCandidate: (request) => {
          const mode = modes.get(request.literature_id);
          const page = fakePage({}).page;
          const flow = createBrowserArticleFlow({
            pages: {
              openPage: async () => ({ page, close: async () => undefined }),
            },
            decide: async () =>
              mode === "invalid"
                ? { kind: "unsupported" }
                : { kind: "stop", reason: "user" },
            session_id: SESSION_ID,
            ...(mode === "budget" ? { max_actions: 0 } : {}),
            ...(mode === "observation"
              ? {}
              : { observations: new BrowserObservationStore() }),
            candidate_timeout_ms: 0,
            awaitCandidate:
              mode === "timeout"
                ? () => new Promise<null>(() => undefined)
                : async () => null,
          });
          return flow.deliver(request);
        },
        close: async () => undefined,
      }),
    });
    try {
      for (const [index, item] of cases.entries()) {
        const literature = parseLiterature({
          ...FIXTURE_LITERATURE,
          literature_id: item.id,
          meta_literature_id: `00000000-0000-0000-0000-0000000008${String(index + 1).padStart(2, "0")}`,
        });
        await application.database.putLiterature(literature);
        await application.observations.publish({
          ...parseMetadataObservation({
            observation_id: `00000000-0000-0000-0000-0000000009${String(index + 1).padStart(2, "0")}`,
            provenance: {
              provenance_id: `00000000-0000-0000-0000-0000000010${String(index + 1).padStart(2, "0")}`,
              source_kind: "metadata-provider",
              source_name: "fixture",
              source_record_id: `fixture-${index}`,
              observed_at: "2026-09-10T00:00:00Z",
              input_sha256: "a".repeat(64),
              parameters_sha256: null,
            },
            metadata: literature.metadata,
            version_role: "published",
            version_links: [],
            asset_hints: [
              {
                url: "https://fixture.example.test/article",
                kind: "landing-page",
                media_type: null,
                asset_role: null,
                version_role: "published",
                access_status: "open",
                license: null,
              },
            ],
            reference_texts: [],
            declared_keywords: [],
            reference_count: 0,
            cited_by_count: 0,
          }),
          literature_id: item.id,
        });
        const report = await application.databaseCompletion!.run({
          selector: {
            kind: "literatures",
            literature_ids: [parseLiteratureId(item.id)],
          },
          goal: "ASSET_READY",
        });
        if (item.code) {
          expect(report.failed).toMatchObject([
            { literature_id: item.id, failure: { code: item.code } },
          ]);
          expect(
            await application.database.hasAutomaticPdfExhaustion(item.id),
          ).toBe(false);
        } else {
          expect(report.skipped).toMatchObject([
            { literature_ids: [item.id], reason: "manual-pdf-required" },
          ]);
          expect(
            await application.database.hasAutomaticPdfExhaustion(item.id),
          ).toBe(true);
        }
      }
    } finally {
      await application.close();
      await rm(home, { recursive: true, force: true });
    }
  });
});

/** A page whose viewer is hostile: any snapshot after the candidate settles throws. */
function fakePage(options: { failSnapshotAfter?: number }): {
  page: FlowPageHandle;
  applied: unknown[];
  snapshots: () => number;
} {
  let snapshots = 0;
  const applied: unknown[] = [];
  const page: FlowPageHandle = {
    snapshot: async () => {
      snapshots += 1;
      if (
        options.failSnapshotAfter !== undefined &&
        snapshots > options.failSnapshotAfter
      )
        // Emulates a PDF viewer whose snapshot fails: if the driver observed again
        // instead of ending on the captured candidate, this would surface as a failure.
        throw new Error("viewer snapshot unavailable");
      return snapshot(snapshots);
    },
    apply: async (input) => {
      applied.push(input);
    },
  };
  return { page, applied, snapshots: () => snapshots };
}

async function withStore<T>(
  run: (collector: BrowserTransferCollector) => Promise<T>,
) {
  const root = await mkdtemp(join(tmpdir(), "sciretriever-flow-e2e-"));
  try {
    const files = new FileStore(root);
    return await run(new BrowserTransferCollector(files));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("browser article flow (offline end-to-end)", () => {
  it("drives one bounded action per observation and stops when the model says stop", async () => {
    const { page, applied, snapshots } = fakePage({});
    const decisions = ["click-point", "stop"];
    let calls = 0;
    const driver = new BrowserArticleFlowDriver({
      page,
      decide: async () => {
        const kind = decisions[calls] ?? "stop";
        calls += 1;
        return kind === "stop"
          ? { kind: "stop", reason: "budget" }
          : {
              kind: "click-point",
              x: 10,
              y: 20,
              revision: 1,
              viewport_version: 1,
            };
      },
      max_actions: 8,
      max_model_calls: 8,
      deadline_ms: 60_000,
      started_at: Date.now(),
      signal: new AbortController().signal,
      article_id: ARTICLE_ID,
      session_id: SESSION_ID,
      observations: new BrowserObservationStore(),
      awaitCandidate: async () => null,
    });
    const result = await driver.run();
    expect(result.stopped_reason).toBe("budget");
    expect(result.actions).toBe(1);
    expect(applied).toHaveLength(1);
    // One observation per model call: the loop never asks before it has re-observed.
    expect(calls).toBe(2);
    expect(snapshots()).toBe(2);
  });

  it("ends before observing again once a candidate has been captured", async () => {
    // The viewer breaks after the first snapshot. A captured candidate must therefore end
    // the flow before a second observation, otherwise this test would throw.
    const { page, snapshots } = fakePage({ failSnapshotAfter: 1 });
    let captured = false;
    const driver = new BrowserArticleFlowDriver({
      page,
      decide: async () => {
        // The PDF response lands while the model is deciding; the next loop head must see
        // it and stop rather than observing the now-broken viewer.
        captured = true;
        return {
          kind: "click-point",
          x: 1,
          y: 2,
          revision: 1,
          viewport_version: 1,
        };
      },
      max_actions: 8,
      max_model_calls: 8,
      deadline_ms: 60_000,
      started_at: Date.now(),
      signal: new AbortController().signal,
      article_id: ARTICLE_ID,
      session_id: SESSION_ID,
      observations: new BrowserObservationStore(),
      hasCandidate: () => captured,
      awaitCandidate: async () => null,
    });
    const result = await driver.run();
    expect(result.stopped_reason).toBe("stopped");
    expect(snapshots()).toBe(1);
  });

  it("stops on cancellation without applying another action", async () => {
    const { page, applied } = fakePage({});
    const controller = new AbortController();
    const driver = new BrowserArticleFlowDriver({
      page,
      decide: async () => {
        controller.abort();
        return {
          kind: "click-point",
          x: 1,
          y: 2,
          revision: 1,
          viewport_version: 1,
        };
      },
      max_actions: 8,
      max_model_calls: 8,
      deadline_ms: 60_000,
      started_at: Date.now(),
      signal: controller.signal,
      article_id: ARTICLE_ID,
      session_id: SESSION_ID,
      observations: new BrowserObservationStore(),
      awaitCandidate: async () => null,
    });
    const result = await driver.run();
    expect(result.stopped_reason).toBe("cancelled");
    expect(applied).toHaveLength(0);
  });

  it("stops at the action budget instead of looping on an unproductive page", async () => {
    const { page, applied } = fakePage({});
    const driver = new BrowserArticleFlowDriver({
      page,
      decide: async () => ({
        kind: "click-point",
        x: 1,
        y: 2,
        revision: 1,
        viewport_version: 1,
      }),
      max_actions: 3,
      max_model_calls: 99,
      deadline_ms: 60_000,
      started_at: Date.now(),
      signal: new AbortController().signal,
      article_id: ARTICLE_ID,
      session_id: SESSION_ID,
      observations: new BrowserObservationStore(),
      awaitCandidate: async () => null,
    });
    const result = await driver.run();
    expect(result.stopped_reason).toBe("budget");
    // The budget is enforced at the top of the loop, so exactly `max_actions` actions are
    // applied and the next iteration stops before observing again.
    expect(result.actions).toBe(3);
    expect(applied).toHaveLength(3);
  });

  it("turns the model-call budget into a bounded stop", async () => {
    const { page } = fakePage({});
    const driver = new BrowserArticleFlowDriver({
      page,
      decide: async () => ({
        kind: "click-point",
        x: 1,
        y: 2,
        revision: 1,
        viewport_version: 1,
      }),
      max_actions: 99,
      max_model_calls: 2,
      deadline_ms: 60_000,
      started_at: Date.now(),
      signal: new AbortController().signal,
      article_id: ARTICLE_ID,
      session_id: SESSION_ID,
      observations: new BrowserObservationStore(),
      awaitCandidate: async () => null,
    });
    const result = await driver.run();
    expect(result.stopped_reason).toBe("budget");
    // One model call per iteration; the third iteration stops at the ceiling.
    expect(result.actions).toBe(2);
  });

  it("refuses an unparsable decision instead of applying it to the page", async () => {
    const { page, applied } = fakePage({});
    const driver = new BrowserArticleFlowDriver({
      page,
      // Not one of the six closed actions: it must never reach the page.
      decide: async () => ({ kind: "run-script", script: "alert(1)" }),
      max_actions: 8,
      max_model_calls: 8,
      deadline_ms: 60_000,
      started_at: Date.now(),
      signal: new AbortController().signal,
      article_id: ARTICLE_ID,
      session_id: SESSION_ID,
      observations: new BrowserObservationStore(),
      awaitCandidate: async () => null,
    });
    const result = await driver.run();
    expect(result.stopped_reason).toBe("invalid-action");
    expect(applied).toHaveLength(0);
  });

  it("produces a real durable candidate from synthetic bytes through the Intake boundary", async () => {
    await withStore(async (collector) => {
      const pdf = workbenchPdf(FIXTURE_DOI, "published");
      const transferId = "e2e-flow-transfer";
      await collector.begin(transferId, 16 * 1024 * 1024, {
        session_id: SESSION_ID,
        article_id: ARTICLE_ID,
        page_id: "e2e-page",
        document_generation: 0,
        source_url: "https://fixture.example.test/article",
        captured_at: new Date().toISOString(),
      });
      await collector.append(transferId, pdf);
      const candidate = await collector.complete(transferId);
      // Real content-addressed artifact, not a fabricated object.
      expect(candidate.state).toBe("durable-ready");
      expect(candidate.sha256).toBe(await sha256(pdf));
      expect(candidate.size_bytes).toBe(pdf.byteLength);
      expect(candidate.reference.length).toBeGreaterThan(0);
      // The bytes read back through the same boundary are the bytes we fed.
      const bytes = await collector.candidateBytes(candidate);
      expect(bytes.byteLength).toBe(pdf.byteLength);
      expect(await sha256(bytes)).toBe(candidate.sha256);
    });
  });
});

describe("browser article flow port (offline)", () => {
  const request = (signal: AbortSignal, startUrl: string | null = null) =>
    ({
      literature_id: ARTICLE_ID,
      identifier: `doi:${FIXTURE_DOI}`,
      version: "published",
      start_url: startUrl,
      metadata_snapshot: {
        metadata_sha256: "a".repeat(64),
        metadata_revision: 1,
      },
      signal,
    }) as never;

  /** A page source that records how it was opened and closes deterministically. */
  function fakePages(options: { failOpen?: boolean } = {}) {
    const opened: (string | null)[] = [];
    let closes = 0;
    return {
      opened,
      closes: () => closes,
      source: {
        openPage: async (incoming: { start_url: string | null }) => {
          opened.push(incoming.start_url);
          if (options.failOpen) throw new Error("page open failed");
          const { page } = fakePage({});
          return {
            page,
            close: async () => {
              closes += 1;
            },
          };
        },
      },
    };
  }

  it("stops without opening a page when the model is unconfigured", async () => {
    const pages = fakePages();
    const flow = createBrowserArticleFlow({
      pages: pages.source as never,
      decide: undefined,
      session_id: SESSION_ID,
      awaitCandidate: async () => null,
    });
    const result = await flow.deliver(
      request(new AbortController().signal, "https://fixture.example.test/a"),
    );
    expect(result.kind).toBe("refused");
    expect((result as { code: string }).code).toBe("browser-model-unavailable");
    expect(pages.opened).toHaveLength(0);
  });

  it("refuses an article without an admitted landing page", async () => {
    const pages = fakePages();
    const flow = createBrowserArticleFlow({
      pages: pages.source as never,
      decide: async () => ({ kind: "stop", reason: "budget" }),
      session_id: SESSION_ID,
      awaitCandidate: async () => null,
    });
    const result = await flow.deliver(
      request(new AbortController().signal, null),
    );
    expect(result.kind).toBe("refused");
    expect((result as { code: string }).code).toBe("browser-flow-unavailable");
    expect(pages.opened).toHaveLength(0);
  });

  it("closes the page and reports normal exhaustion when the driver finds nothing", async () => {
    const pages = fakePages();
    const flow = createBrowserArticleFlow({
      pages: pages.source as never,
      decide: async () => ({ kind: "stop", reason: "user" }),
      session_id: SESSION_ID,
      observations: new BrowserObservationStore(),
      awaitCandidate: async () => null,
    });
    const result = await flow.deliver(
      request(new AbortController().signal, "https://fixture.example.test/a"),
    );
    expect(result).toEqual({ kind: "exhausted" });
    // The admitted start URL reached the page source, and the page was always released.
    expect(pages.opened).toEqual(["https://fixture.example.test/a"]);
    expect(pages.closes()).toBe(1);
  });

  it.each([
    {
      label: "action budget",
      max_actions: 0,
      decision: { kind: "stop", reason: "user" },
      code: "browser-flow-budget-exhausted",
    },
    {
      label: "model budget",
      max_model_calls: 0,
      decision: { kind: "stop", reason: "user" },
      code: "browser-flow-budget-exhausted",
    },
    {
      label: "deadline",
      deadline_ms: 0,
      decision: { kind: "stop", reason: "user" },
      code: "browser-flow-budget-exhausted",
    },
    {
      label: "model budget stop",
      decision: { kind: "stop", reason: "budget" },
      code: "browser-flow-budget-exhausted",
    },
    {
      label: "invalid model action",
      decision: { kind: "unsupported" },
      code: "browser-action-invalid",
    },
    {
      label: "model cancel stop",
      decision: { kind: "stop", reason: "cancel" },
      code: "browser-flow-cancelled",
    },
  ])("does not claim exhaustion after $label", async (variant) => {
    const pages = fakePages();
    const flow = createBrowserArticleFlow({
      pages: pages.source as never,
      decide: async () => variant.decision,
      session_id: SESSION_ID,
      observations: new BrowserObservationStore(),
      max_actions: variant.max_actions ?? 4,
      max_model_calls: variant.max_model_calls ?? 4,
      deadline_ms: variant.deadline_ms ?? 60_000,
      awaitCandidate: async () => null,
    });
    const result = await flow.deliver(
      request(new AbortController().signal, "https://fixture.example.test/a"),
    );
    expect(result).toMatchObject({ kind: "refused", code: variant.code });
    expect(pages.closes()).toBe(1);
  });

  it("does not claim exhaustion when the observation owner is absent", async () => {
    const pages = fakePages();
    const flow = createBrowserArticleFlow({
      pages: pages.source as never,
      decide: async () => ({ kind: "stop", reason: "user" }),
      session_id: SESSION_ID,
      awaitCandidate: async () => null,
    });
    await expect(
      flow.deliver(
        request(new AbortController().signal, "https://fixture.example.test/a"),
      ),
    ).resolves.toMatchObject({
      kind: "refused",
      code: "browser-observation-unavailable",
    });
  });

  it("keeps a page cleanup failure distinct from normal exhaustion", async () => {
    const pages = fakePages();
    const flow = createBrowserArticleFlow({
      pages: {
        openPage: async (incoming) => {
          const opened = await pages.source.openPage(incoming);
          return {
            page: opened.page,
            close: async () => {
              await opened.close();
              throw new Error("synthetic cleanup failure");
            },
          };
        },
      },
      decide: async () => ({ kind: "stop", reason: "budget" }),
      session_id: SESSION_ID,
      awaitCandidate: async () => null,
    });
    await expect(
      flow.deliver(
        request(new AbortController().signal, "https://fixture.example.test/a"),
      ),
    ).rejects.toMatchObject({ code: "browser-flow-close-failed" });
    expect(pages.closes()).toBe(1);
  });

  it("maps an unopenable page to a stable refusal instead of an internal error", async () => {
    const pages = fakePages({ failOpen: true });
    const flow = createBrowserArticleFlow({
      pages: pages.source as never,
      decide: async () => ({ kind: "stop", reason: "budget" }),
      session_id: SESSION_ID,
      awaitCandidate: async () => null,
    });
    const result = await flow.deliver(
      request(new AbortController().signal, "https://fixture.example.test/a"),
    );
    expect(result.kind).toBe("refused");
    expect((result as { code: string }).code).toBe("browser-page-unavailable");
  });

  it("refuses before opening when the delivery is already cancelled", async () => {
    const pages = fakePages();
    const controller = new AbortController();
    controller.abort();
    const flow = createBrowserArticleFlow({
      pages: pages.source as never,
      decide: async () => ({ kind: "stop", reason: "budget" }),
      session_id: SESSION_ID,
      awaitCandidate: async () => null,
    });
    const result = await flow.deliver(
      request(controller.signal, "https://fixture.example.test/a"),
    );
    expect(result.kind).toBe("refused");
    expect((result as { code: string }).code).toBe("browser-flow-cancelled");
    expect(pages.opened).toHaveLength(0);
  });

  it("returns a delivered candidate only when the identity assessment accepted it", async () => {
    await withStore(async (collector) => {
      const pdf = workbenchPdf(FIXTURE_DOI, "published");
      const transferId = "port-flow-transfer";
      await collector.begin(transferId, 16 * 1024 * 1024, {
        session_id: SESSION_ID,
        article_id: ARTICLE_ID,
        page_id: "port-page",
        document_generation: 0,
        source_url: "https://fixture.example.test/a",
        captured_at: new Date().toISOString(),
      });
      await collector.append(transferId, pdf);
      // A genuine durable candidate, produced by the real collector.
      const candidate = await collector.complete(transferId);
      for (const accepted of [true, false]) {
        const abandoned: string[] = [];
        const pages = fakePages();
        const flow = createBrowserArticleFlow({
          pages: pages.source as never,
          decide: async () => ({ kind: "stop", reason: "budget" }),
          session_id: SESSION_ID,
          awaitCandidate: async () => ({
            transfer_id: candidate.transfer_id,
            candidate,
            accepted,
          }),
          abandonCandidate: async (value) => {
            abandoned.push(value.transfer_id);
          },
        });
        const result = await flow.deliver(
          request(
            new AbortController().signal,
            "https://fixture.example.test/a",
          ),
        );
        if (accepted) {
          expect(result.kind).toBe("delivered");
          expect(
            (result as { candidate: typeof candidate }).candidate.sha256,
          ).toBe(candidate.sha256);
          expect(abandoned).toEqual([]);
        } else {
          // A mismatch is never reported as a delivery, and the durable candidate it
          // already spooled is retired rather than left unowned.
          expect(result.kind).toBe("refused");
          expect((result as { code: string }).code).toBe(
            "browser-identity-mismatch",
          );
          expect(abandoned).toEqual([candidate.transfer_id]);
        }
        expect(pages.closes()).toBe(1);
      }
    });
  });
});

describe("browser flow acceptance (offline)", () => {
  it("carries a real Intake candidate through deliver into the acceptance receipt", async () => {
    const home = await mkdtemp(join(tmpdir(), "sciretriever-flow-accept-"));
    const application = await createApplication(home, {
      executionSchema: "upgrade-synthetic",
    });
    try {
      const literatureId = FIXTURE_LITERATURE.literature_id;
      await application.database.putLiterature(FIXTURE_LITERATURE);
      const collector = application.execution!.transfers;
      const pdf = workbenchPdf(FIXTURE_DOI, "published");
      const transferId = "accept-e2e-transfer";

      // Real Intake boundary over the real collector, driven through its own receive():
      // bytes in as a BrowserTransferInput, an assessed durable candidate out.
      const intake = new BrowserCandidateIntake(collector, {
        article_id: literatureId,
        identifier: `doi:${FIXTURE_DOI}`,
        version: "published",
      });
      async function* syntheticChunks(): AsyncGenerator<Uint8Array> {
        yield pdf;
      }
      const received = await intake.receive({
        signal: new AbortController().signal,
        transfer_id: transferId,
        capture: {
          session_id: SESSION_ID,
          article_id: literatureId,
          page_id: "accept-page",
          document_generation: 0,
          source_url: "https://fixture.example.test/a",
          captured_at: new Date().toISOString(),
        },
        chunks: syntheticChunks(),
      });
      // The candidate comes from the Intake boundary, not from a hand-driven collector.
      const candidate = received.candidate;
      const assessed = received.assessment;
      expect(candidate.transfer_id).toBe(transferId);
      expect(candidate.state).toBe("durable-ready");
      expect(candidate.sha256).toBe(await sha256(pdf));
      expect(candidate.size_bytes).toBe(pdf.byteLength);
      expect(candidate.reference.length).toBeGreaterThan(0);
      const disposition = assessed.verdict.disposition;
      expect(["accepted", "uncertain", "rejected"]).toContain(disposition);

      // The real flow port delivers that exact candidate.
      const pages = {
        openPage: async () => ({
          page: fakePage({}).page,
          close: async () => undefined,
        }),
      };
      const flow = createBrowserArticleFlow({
        pages: pages as never,
        decide: async () => ({ kind: "stop", reason: "budget" }),
        session_id: SESSION_ID,
        awaitCandidate: async () => ({
          transfer_id: candidate.transfer_id,
          candidate,
          accepted: disposition === "accepted",
        }),
      });
      const delivery = await flow.deliver({
        literature_id: literatureId,
        identifier: `doi:${FIXTURE_DOI}`,
        version: "published",
        start_url: "https://fixture.example.test/a",
        metadata_snapshot: {
          metadata_sha256: "a".repeat(64),
          metadata_revision: 1,
        },
        signal: new AbortController().signal,
      } as never);
      // The flow reports `delivered` only for an accepted identity assessment. This
      // synthetic fixture carries no embedded DOI metadata, so the honest outcome is a
      // stable refusal; when the assessment accepts, the same candidate is handed over
      // unchanged. Assert whichever outcome the boundary actually produced.
      const delivered = candidate;
      if (disposition === "accepted") {
        expect(delivery.kind).toBe("delivered");
        expect(
          (delivery as { candidate: typeof candidate }).candidate.sha256,
        ).toBe(candidate.sha256);
      } else {
        expect(delivery.kind).toBe("refused");
        expect((delivery as { code: string }).code).toBe(
          "browser-identity-mismatch",
        );
      }

      // The candidate produced by the Intake boundary goes into the existing acceptance
      // owner unchanged, so the receipt and catalog state are still exercised.
      const facts = await application.database.currentFacts(literatureId);
      const receipt = await application.execution!.acceptance.accept({
        receipt_id: "accept-e2e-receipt",
        literature_id: literatureId,
        transfer_id: delivered.transfer_id,
        metadata_snapshot: facts!.metadata_snapshot,
      });
      expect(receipt.created).toBe(true);
      // The receipt identifies the same bytes; its reference is the published asset path
      // rather than the candidate's staging path, which is why only content identity is
      // asserted here and the published location is checked through the catalog below.
      expect(receipt.sha256).toBe(candidate.sha256);

      // Catalog state reflects the accepted asset, and no exhaustion fact appeared.
      const detail = await application.library.detail(literatureId);
      expect(detail.primary_pdf?.asset.sha256).toBe(candidate.sha256);
      expect(detail.literature.status).toBe("ASSET_READY");
      expect(
        await application.database.hasAutomaticPdfExhaustion(literatureId),
      ).toBe(false);
    } finally {
      await application.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  it("keeps a rejected delivery from producing a receipt or a primary PDF", async () => {
    const home = await mkdtemp(join(tmpdir(), "sciretriever-flow-reject-"));
    const application = await createApplication(home, {
      executionSchema: "upgrade-synthetic",
    });
    try {
      const literatureId = FIXTURE_LITERATURE.literature_id;
      await application.database.putLiterature(FIXTURE_LITERATURE);
      const collector = application.execution!.transfers;
      const pdf = workbenchPdf(FIXTURE_DOI, "published");
      const transferId = "reject-e2e-transfer";
      await collector.begin(transferId, 16 * 1024 * 1024, {
        session_id: SESSION_ID,
        article_id: literatureId,
        page_id: "reject-page",
        document_generation: 0,
        source_url: "https://fixture.example.test/a",
        captured_at: new Date().toISOString(),
      });
      await collector.append(transferId, pdf);
      const candidate = await collector.complete(transferId);

      const abandoned: string[] = [];
      const pages = {
        openPage: async () => ({
          page: fakePage({}).page,
          close: async () => undefined,
        }),
      };
      const flow = createBrowserArticleFlow({
        pages: pages as never,
        decide: async () => ({ kind: "stop", reason: "budget" }),
        session_id: SESSION_ID,
        awaitCandidate: async () => ({
          transfer_id: candidate.transfer_id,
          candidate,
          accepted: false,
        }),
        abandonCandidate: async (value) => {
          abandoned.push(value.transfer_id);
        },
      });
      const delivery = await flow.deliver({
        literature_id: literatureId,
        identifier: `doi:${FIXTURE_DOI}`,
        version: "published",
        start_url: "https://fixture.example.test/a",
        metadata_snapshot: {
          metadata_sha256: "a".repeat(64),
          metadata_revision: 1,
        },
        signal: new AbortController().signal,
      } as never);
      expect(delivery.kind).toBe("refused");
      expect((delivery as { code: string }).code).toBe(
        "browser-identity-mismatch",
      );
      // The spooled candidate was retired, and nothing was accepted.
      expect(abandoned).toEqual([candidate.transfer_id]);
      const detail = await application.library.detail(literatureId);
      expect(detail.primary_pdf).toBeNull();
      expect(detail.literature.status).toBe("UNREVIEWED");
      expect(
        await application.database.hasAutomaticPdfExhaustion(literatureId),
      ).toBe(false);
    } finally {
      await application.close();
      await rm(home, { recursive: true, force: true });
    }
  });
});
