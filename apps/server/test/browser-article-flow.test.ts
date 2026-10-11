import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  sha256,
  parseLiterature,
  parseMetadataObservation,
  parseLiteratureId,
  parseLiteratureCurrentFacts,
} from "@sciretriever/contracts";
import {
  BrowserArticleFlowDriver,
  BrowserArticleOpenError,
  createBrowserArticleFlow,
  type BrowserArticleFlowOptions,
  type BrowserArticleFlowFactoryOptions,
  type FlowPageHandle,
} from "../src/browser/article-flow.js";
import { BrowserObservationStore } from "../src/browser/observation.js";
import { BrowserArticleClock } from "../src/browser/article-session.js";
import type { BrowserArticleExecution } from "../src/browser/article-session.js";
import { BrowserHostNavigationError } from "../src/browser/host.js";
import { admitBrowserArticleRequest } from "../src/browser/production-host.js";
import type { BrowserDeliveryRequest } from "../src/browser/boundary.js";
import { BrowserTransferCollector } from "../src/browser/transfer.js";
import { BrowserCaptureBatch } from "../src/browser/capture-batch.js";
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
const METADATA_SNAPSHOT = parseLiteratureCurrentFacts({
  literature: FIXTURE_LITERATURE,
  metadata_snapshot: { revision: 1, sha256: "a".repeat(64) },
  primary_asset: null,
}).metadata_snapshot;
const FLOW_IDENTITY = Object.freeze({
  session_id: SESSION_ID,
  operation_id: "test-operation",
  generation: 0,
  literature_id: ARTICLE_ID,
  metadata_snapshot: METADATA_SNAPSHOT,
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function cooperativeDriver(
  overrides: Partial<BrowserArticleFlowOptions> = {},
  withPage = true,
) {
  return new BrowserArticleFlowDriver({
    identity: FLOW_IDENTITY,
    ...(withPage ? { page: fakePage({}).page } : {}),
    decide: undefined,
    max_actions: 100,
    max_model_calls: 50,
    deadline_ms: 300_000,
    started_at: 0,
    signal: new AbortController().signal,
    session_id: SESSION_ID,
    article_id: ARTICLE_ID,
    observations: new BrowserObservationStore(),
    awaitCandidate: async () => null,
    dispatch_tracking: "transport",
    ...overrides,
  });
}

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
      {
        id: "00000000-0000-0000-0000-000000000706",
        mode: "resource",
        code: "pdf-browser-download-temporary-quota",
      },
      {
        id: "00000000-0000-0000-0000-000000000707",
        mode: "reader",
        code: "pdf-reader-unavailable",
      },
      {
        id: "00000000-0000-0000-0000-000000000708",
        mode: "transfer-stop",
        code: "pdf-browser-transfer-failed",
      },
      {
        id: "00000000-0000-0000-0000-000000000709",
        mode: "rate-limit",
        code: "pdf-browser-rate-limited",
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
          if (mode === "rate-limit")
            return Promise.resolve({
              kind: "refused" as const,
              code: "browser-rate-limited",
              reason: "Platform returned HTTP 429.",
              retryable: false as const,
            });
          const page = fakePage({}).page;
          const flow = createBrowserArticleFlow({
            pages: {
              openPage: async () => ({ page, close: async () => undefined }),
            },
            onSession: (execution) => {
              if (
                ["resource", "reader", "transfer-stop"].includes(mode ?? "")
              ) {
                execution.transferStarted("failed-file-attempt");
                execution.transferFailed(
                  "failed-file-attempt",
                  mode === "resource"
                    ? "browser-download-temporary-quota"
                    : mode === "reader"
                      ? "pdf-reader-unavailable"
                      : "browser-transfer-failed",
                );
                if (mode === "transfer-stop") execution.setNetworkAccess(true);
              }
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
            {
              literature_id: item.id,
              failure: {
                code: item.code,
                retryable: item.mode === "rate-limit",
              },
            },
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

async function captureFixture(
  collector: BrowserTransferCollector,
  transferId: string,
) {
  await collector.begin(transferId, 16 * 1024 * 1024, {
    session_id: SESSION_ID,
    article_id: ARTICLE_ID,
    page_id: "fixture-page",
    document_generation: 0,
    source_url: "https://fixture.example.test/article",
    captured_at: new Date().toISOString(),
  });
  await collector.append(transferId, workbenchPdf(FIXTURE_DOI, "published"));
  return {
    transfer_id: transferId,
    candidate: await collector.complete(transferId),
    accepted: true,
  };
}

describe("browser article flow (offline end-to-end)", () => {
  it("suppresses repeated clicks but continues observing an unchanged challenge", async () => {
    let snapshots = 0;
    const applied: unknown[] = [];
    const page: FlowPageHandle = {
      snapshot: async () => ({
        url: "https://fixture.example.test/challenge",
        title: "Just a moment...",
        text: "Please verify you are human",
        viewport: { width: 1024, height: 768, device_scale_factor: 1 },
        screenshot: new Uint8Array([snapshots++]),
        elements: [],
        loading: false,
        partial: false,
        document_generation: snapshots,
      }),
      apply: async (input) => {
        applied.push(input);
      },
    };
    const driver = new BrowserArticleFlowDriver({
      identity: FLOW_IDENTITY,
      page,
      decide: async (observation) => ({
        kind: "click-point",
        x: 320,
        y: 240,
        revision: observation.observation_revision,
        viewport_version: observation.viewport_revision,
      }),
      max_actions: 8,
      max_model_calls: 8,
      deadline_ms: 60_000,
      started_at: Date.now(),
      signal: new AbortController().signal,
      article_id: ARTICLE_ID,
      session_id: SESSION_ID,
      observations: new BrowserObservationStore(),
      awaitCandidate: async () => null,
      action_cooldown_ms: 0,
    });
    await expect(driver.run()).resolves.toEqual({
      actions: 1,
      stopped_reason: "budget",
    });
    expect(
      applied.filter(
        (action) => (action as { kind: string }).kind === "click-point",
      ),
    ).toHaveLength(1);
  });

  it("re-observes after a stale action instead of failing the Browser flow", async () => {
    let snapshots = 0;
    let decisions = 0;
    const applied: unknown[] = [];
    const page: FlowPageHandle = {
      snapshot: async () => {
        snapshots += 1;
        return {
          ...snapshot(snapshots),
          document_generation: snapshots,
        };
      },
      apply: async (input) => {
        applied.push(input);
        if (applied.length === 1)
          throw Object.assign(new Error("stale"), {
            code: "browser-page-stale-action",
          });
      },
    };
    const driver = new BrowserArticleFlowDriver({
      identity: FLOW_IDENTITY,
      page,
      decide: async (observation) => {
        decisions += 1;
        return decisions === 1
          ? {
              kind: "click-point",
              x: 120,
              y: 80,
              revision: observation.observation_revision,
              viewport_version: observation.viewport_revision,
            }
          : { kind: "stop", reason: "user" };
      },
      max_actions: 4,
      max_model_calls: 4,
      deadline_ms: 60_000,
      started_at: Date.now(),
      signal: new AbortController().signal,
      article_id: ARTICLE_ID,
      session_id: SESSION_ID,
      observations: new BrowserObservationStore(),
      awaitCandidate: async () => null,
      action_cooldown_ms: 0,
    });

    await expect(driver.run()).resolves.toEqual({
      actions: 1,
      stopped_reason: "stopped",
    });
    expect(snapshots).toBe(2);
    expect(applied).toHaveLength(1);
  });

  it("re-observes after a settling transition instead of surfacing a flow failure", async () => {
    let snapshots = 0;
    const page: FlowPageHandle = {
      snapshot: async () => {
        snapshots += 1;
        if (snapshots === 1)
          throw Object.assign(new Error("transition"), {
            code: "browser-page-transition",
          });
        return snapshot(snapshots);
      },
      apply: async () => undefined,
    };
    const driver = new BrowserArticleFlowDriver({
      identity: FLOW_IDENTITY,
      page,
      decide: async () => ({ kind: "stop", reason: "user" }),
      max_actions: 4,
      max_model_calls: 2,
      deadline_ms: 60_000,
      started_at: Date.now(),
      signal: new AbortController().signal,
      article_id: ARTICLE_ID,
      session_id: SESSION_ID,
      observations: new BrowserObservationStore(),
      awaitCandidate: async () => null,
      action_cooldown_ms: 0,
    });

    await expect(driver.run()).resolves.toEqual({
      actions: 1,
      stopped_reason: "stopped",
    });
    expect(snapshots).toBe(2);
  });

  it("uses screenshot-bound click-point then waits for a challenge page to change", async () => {
    let phase = 0;
    const applied: unknown[] = [];
    const page: FlowPageHandle = {
      snapshot: async () => {
        phase += 1;
        return {
          url: "https://fixture.example.test/article",
          title: phase === 1 ? "Just a moment..." : "Fixture article",
          text:
            phase === 1
              ? "Checking your browser. Please verify you are human."
              : "Download PDF",
          viewport: { width: 1024, height: 768, device_scale_factor: 1 },
          screenshot: new Uint8Array([1, 2, 3]),
          elements: [],
          loading: false,
          partial: false,
          document_generation: phase,
        };
      },
      apply: async (input) => {
        applied.push(input);
      },
    };
    const frames: number[] = [];
    const decisions: string[] = [];
    const driver = new BrowserArticleFlowDriver({
      identity: FLOW_IDENTITY,
      page,
      decide: async (observation, frame) => {
        frames.push(frame?.byteLength ?? 0);
        decisions.push(observation.page_state);
        if (observation.page_state === "CHALLENGE")
          return {
            kind: "click-point",
            x: 320,
            y: 240,
            revision: observation.observation_revision,
            viewport_version: observation.viewport_revision,
          };
        if (decisions.length === 2)
          return {
            kind: "wait-for-change",
            timeout_ms: 50,
            revision: observation.observation_revision,
          };
        return { kind: "stop", reason: "user" };
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
      action_cooldown_ms: 0,
    });
    const result = await driver.run();
    expect(result).toEqual({ actions: 3, stopped_reason: "stopped" });
    expect(decisions).toEqual(["CHALLENGE", "NORMAL", "NORMAL"]);
    expect(frames).toEqual([3, 3, 3]);
    expect(applied).toMatchObject([
      {
        kind: "click-point",
        x: 320,
        y: 240,
      },
      {
        kind: "wait-for-change",
        timeout_ms: 15_000,
      },
      {
        kind: "wait-for-change",
        timeout_ms: 50,
      },
    ]);
  });

  it("holds the page for the PDF hand-off after a visible PDF action", async () => {
    const applied: unknown[] = [];
    const page: FlowPageHandle = {
      snapshot: async () => ({
        ...snapshot(1),
        elements: [
          {
            element_id: "pdf",
            role: "tab",
            name: "PDF",
            editable: false,
          },
        ],
      }),
      apply: async (input) => {
        applied.push(input);
      },
    };
    let decisions = 0;
    const driver = new BrowserArticleFlowDriver({
      identity: FLOW_IDENTITY,
      page,
      decide: async () => {
        decisions += 1;
        return decisions === 1
          ? { kind: "click-element", element_id: "pdf", revision: 1 }
          : { kind: "stop", reason: "user" };
      },
      max_actions: 4,
      max_model_calls: 2,
      deadline_ms: 60_000,
      started_at: Date.now(),
      signal: new AbortController().signal,
      article_id: ARTICLE_ID,
      session_id: SESSION_ID,
      observations: new BrowserObservationStore(),
      awaitCandidate: async () => null,
      action_cooldown_ms: 0,
    });

    await expect(driver.run()).resolves.toEqual({
      actions: 2,
      stopped_reason: "stopped",
    });
    expect(applied).toMatchObject([
      { kind: "click-element", element_id: "pdf" },
      { kind: "wait-for-change", timeout_ms: 30_000 },
    ]);
  });

  it("paces an automatic action before requesting the next model decision", async () => {
    const events: string[] = [];
    const page: FlowPageHandle = {
      snapshot: async () => ({
        ...snapshot(events.filter((item) => item === "snapshot").length + 1),
        screenshot: new Uint8Array([1]),
      }),
      apply: async (input) => {
        events.push(`apply:${input.kind}`);
      },
    };
    let calls = 0;
    const driver = new BrowserArticleFlowDriver({
      identity: FLOW_IDENTITY,
      page,
      decide: async () => {
        events.push("decide");
        calls += 1;
        return calls === 1
          ? { kind: "go-back", revision: 1 }
          : { kind: "stop", reason: "user" };
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
      action_cooldown_ms: 0,
    });
    await expect(driver.run()).resolves.toMatchObject({
      actions: 2,
      stopped_reason: "stopped",
    });
    expect(events).toEqual([
      "decide",
      "apply:go-back",
      "apply:wait-for-change",
      "decide",
    ]);
  });

  it("drives one bounded action per observation and stops when the model says stop", async () => {
    const { page, applied, snapshots } = fakePage({});
    const decisions = ["click-point", "stop"];
    let calls = 0;
    const driver = new BrowserArticleFlowDriver({
      identity: FLOW_IDENTITY,
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
      action_cooldown_ms: 0,
    });
    const result = await driver.run();
    expect(result.stopped_reason).toBe("budget");
    expect(result.actions).toBe(2);
    expect(applied).toHaveLength(2);
    expect(applied[1]).toMatchObject({ kind: "wait-for-change" });
    // One observation per model call: the loop never asks before it has re-observed.
    expect(calls).toBe(2);
    expect(snapshots()).toBe(2);
  });

  it("ends before observing again once a valid candidate has been captured", async () => {
    await withStore(async (collector) => {
      const candidate = await captureFixture(
        collector,
        "captured-during-decision",
      );
      const { page, snapshots } = fakePage({ failSnapshotAfter: 1 });
      let captured = false;
      const driver = new BrowserArticleFlowDriver({
        identity: FLOW_IDENTITY,
        page,
        decide: async () => {
          captured = true;
          return { kind: "go-back", revision: 1 };
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
        awaitCandidate: async () => candidate,
      });
      const result = await driver.run();
      expect(result).toMatchObject({ stopped_reason: "stopped", actions: 0 });
      expect(snapshots()).toBe(1);
      expect(await driver.candidate()).toBe(candidate);
    });
  });

  it("stops on cancellation without applying another action", async () => {
    const { page, applied } = fakePage({});
    const controller = new AbortController();
    const driver = new BrowserArticleFlowDriver({
      identity: FLOW_IDENTITY,
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
      action_cooldown_ms: 0,
    });
    const result = await driver.run();
    expect(result.stopped_reason).toBe("cancelled");
    expect(applied).toHaveLength(0);
  });

  it("stops at the action budget instead of looping on an unproductive page", async () => {
    const { page, applied } = fakePage({});
    const driver = new BrowserArticleFlowDriver({
      identity: FLOW_IDENTITY,
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
      action_cooldown_ms: 0,
    });
    const result = await driver.run();
    expect(result.stopped_reason).toBe("budget");
    // The budget is enforced at the top of the loop, so exactly `max_actions` actions are
    // applied and the next iteration stops before observing again.
    expect(result.actions).toBe(3);
    expect(
      applied.filter(
        (value) => (value as { kind: string }).kind !== "wait-for-change",
      ),
    ).toHaveLength(3);
  });

  it("turns the model-call budget into a bounded stop", async () => {
    const { page } = fakePage({});
    const driver = new BrowserArticleFlowDriver({
      identity: FLOW_IDENTITY,
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
      action_cooldown_ms: 0,
    });
    const result = await driver.run();
    expect(result.stopped_reason).toBe("budget");
    // Feedback waits do not consume the Agent action counter.
    expect(result.actions).toBe(2);
  });

  it("refuses an unparsable decision instead of applying it to the page", async () => {
    const { page, applied } = fakePage({});
    const driver = new BrowserArticleFlowDriver({
      identity: FLOW_IDENTITY,
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
      action_cooldown_ms: 0,
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

const request = (
  signal: AbortSignal,
  startUrl: string | null = null,
): BrowserDeliveryRequest => ({
  literature_id: ARTICLE_ID,
  identifier: `doi:${FIXTURE_DOI}`,
  version: "published",
  start_url: startUrl,
  metadata_snapshot: METADATA_SNAPSHOT,
  signal,
});

describe("browser article flow port (offline)", () => {
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
      action_cooldown_ms: 0,
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
      action_cooldown_ms: 0,
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
    let decidedTarget: unknown;
    const flow = createBrowserArticleFlow({
      pages: pages.source as never,
      decide: async (_observation, _frame, _signal, _guidance, target) => {
        decidedTarget = target;
        return { kind: "stop", reason: "user" };
      },
      session_id: SESSION_ID,
      observations: new BrowserObservationStore(),
      awaitCandidate: async () => null,
      action_cooldown_ms: 0,
    });
    const result = await flow.deliver(
      request(new AbortController().signal, "https://fixture.example.test/a"),
    );
    expect(result).toEqual({ kind: "exhausted" });
    expect(decidedTarget).toEqual({
      literature_id: ARTICLE_ID,
      identifier: `doi:${FIXTURE_DOI}`,
      version: "published",
    });
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
      action_cooldown_ms: 0,
    });
    const result = await flow.deliver(
      request(new AbortController().signal, "https://fixture.example.test/a"),
    );
    expect(result).toMatchObject({ kind: "refused", code: variant.code });
    expect(pages.closes()).toBe(1);
  });

  it("reports a challenge budget instead of normal exhaustion", async () => {
    let snapshots = 0;
    const page: FlowPageHandle = {
      snapshot: async () => ({
        url: "https://fixture.example.test/challenge",
        title: "Just a moment...",
        text: "Please verify you are human",
        viewport: { width: 1024, height: 768, device_scale_factor: 1 },
        screenshot: new Uint8Array([snapshots++]),
        elements: [],
        loading: false,
        partial: false,
        document_generation: snapshots,
      }),
      apply: async () => undefined,
    };
    const flow = createBrowserArticleFlow({
      pages: {
        openPage: async () => ({ page, close: async () => undefined }),
      },
      decide: async (observation) => ({
        kind: "click-point",
        x: 320,
        y: 240,
        revision: observation.observation_revision,
        viewport_version: observation.viewport_revision,
      }),
      session_id: SESSION_ID,
      max_model_calls: 3,
      observations: new BrowserObservationStore(),
      awaitCandidate: async () => null,
      action_cooldown_ms: 0,
    });
    await expect(
      flow.deliver(
        request(new AbortController().signal, "https://fixture.example.test/a"),
      ),
    ).resolves.toMatchObject({
      kind: "refused",
      code: "browser-flow-budget-exhausted",
    });
  });

  it("does not claim exhaustion when the observation owner is absent", async () => {
    const pages = fakePages();
    const flow = createBrowserArticleFlow({
      pages: pages.source as never,
      decide: async () => ({ kind: "stop", reason: "user" }),
      session_id: SESSION_ID,
      awaitCandidate: async () => null,
      action_cooldown_ms: 0,
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
      action_cooldown_ms: 0,
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
      action_cooldown_ms: 0,
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
      action_cooldown_ms: 0,
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
            "browser-candidate-rejected",
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
      expect(assessed.accepted).toBe(true);

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
          accepted: assessed.accepted,
        }),
      });
      const delivery = await flow.deliver({
        literature_id: literatureId,
        identifier: `doi:${FIXTURE_DOI}`,
        version: "published",
        start_url: "https://fixture.example.test/a",
        metadata_snapshot: METADATA_SNAPSHOT,
        signal: new AbortController().signal,
      } as never);
      const delivered = candidate;
      expect(delivery.kind).toBe("delivered");
      if (delivery.kind !== "delivered")
        throw new Error("expected file delivery");
      expect(delivery.candidate.sha256).toBe(candidate.sha256);

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
      expect(detail.primary_pdf?.article_identity_status).toBe("unverified");
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
        metadata_snapshot: METADATA_SNAPSHOT,
        signal: new AbortController().signal,
      } as never);
      expect(delivery.kind).toBe("refused");
      expect((delivery as { code: string }).code).toBe(
        "browser-candidate-rejected",
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

  it("hands off an admitted operation-batch candidate without another decision", async () => {
    const batch = new BrowserCaptureBatch();
    const captured = {
      transfer_id: "batch-transfer",
      candidate: {} as never,
      accepted: true,
    };
    expect(batch.add(captured)).toBe(true);
    let decisions = 0;
    const controller = new AbortController();
    const driver = new BrowserArticleFlowDriver({
      identity: FLOW_IDENTITY,
      page: fakePage({}).page,
      decide: async () => {
        decisions += 1;
        return { kind: "stop", reason: "user" };
      },
      max_actions: 4,
      max_model_calls: 4,
      deadline_ms: 10_000,
      started_at: Date.now(),
      signal: controller.signal,
      article_id: ARTICLE_ID,
      session_id: SESSION_ID,
      observations: new BrowserObservationStore(),
      hasCandidate: () => batch.hasCandidate(),
      awaitCandidate: (signal) => batch.next(signal),
    });
    await expect(driver.run()).resolves.toMatchObject({
      stopped_reason: "stopped",
    });
    expect(decisions).toBe(0);
    await expect(driver.candidate()).resolves.toMatchObject({
      transfer_id: "batch-transfer",
    });
  });
});

it("keeps an admitted candidate when the viewer fails and drains only real pending captures", async () => {
  let available = false;
  let drained = 0;
  const candidate = {
    transfer_id: "ready",
    accepted: true,
    candidate: {} as never,
  };
  const flow = createBrowserArticleFlow({
    pages: {
      openPage: async () => ({
        page: {
          snapshot: async () => {
            available = true;
            throw new Error("viewer closed");
          },
          apply: async () => undefined,
          settleCaptures: async () => {
            drained++;
          },
        },
        close: async () => undefined,
      }),
    },
    decide: async () => ({ kind: "stop", reason: "user" }),
    observations: new BrowserObservationStore(),
    session_id: SESSION_ID,
    hasCandidate: () => available,
    awaitCandidate: async () => candidate,
  });
  expect(
    await flow.deliver(
      request(new AbortController().signal, "https://fixture.example.test/a"),
    ),
  ).toMatchObject({ kind: "delivered" });
  expect(drained).toBe(1);
});

it("preserves a real throttle without waiting on an empty candidate queue", async () => {
  const flow = createBrowserArticleFlow({
    pages: {
      openPage: async () => ({
        page: {
          snapshot: async () => {
            throw Object.assign(new Error("throttled"), {
              code: "browser-rate-limited",
            });
          },
          apply: async () => undefined,
          settleCaptures: async () => undefined,
        },
        close: async () => undefined,
      }),
    },
    decide: async () => ({ kind: "stop", reason: "user" }),
    observations: new BrowserObservationStore(),
    session_id: SESSION_ID,
    hasCandidate: () => false,
    awaitCandidate: async () => {
      throw new Error("Must not wait on an empty queue");
    },
  });
  expect(
    await flow.deliver(
      request(new AbortController().signal, "https://fixture.example.test/a"),
    ),
  ).toMatchObject({ kind: "refused", code: "browser-rate-limited" });
});

it("does not dispatch a model action that finishes after the article deadline", async () => {
  let now = 100;
  const { page, applied } = fakePage({});
  const driver = new BrowserArticleFlowDriver({
    identity: FLOW_IDENTITY,
    page,
    decide: async () => {
      now = 1000;
      return { kind: "go-back", revision: 1 };
    },
    observations: new BrowserObservationStore(),
    session_id: SESSION_ID,
    article_id: ARTICLE_ID,
    signal: new AbortController().signal,
    max_actions: 10,
    max_model_calls: 10,
    now: () => now,
    started_at: 100,
    deadline_ms: 500,
    awaitCandidate: async () => null,
  });
  expect(await driver.run()).toMatchObject({ stopped_reason: "budget" });
  expect(applied).toEqual([]);
});

it("returns rejected coordinate feedback without dispatching or recording a false click", async () => {
  let calls = 0;
  const { page, applied } = fakePage({});
  const driver = new BrowserArticleFlowDriver({
    identity: FLOW_IDENTITY,
    page,
    decide: async (
      _observation,
      _frame,
      _signal,
      _guidance,
      _target,
      history,
      feedback,
    ) => {
      if (++calls === 1)
        return {
          kind: "click-point",
          x: 4500,
          y: 5700,
          revision: 1,
          viewport_version: 1,
        };
      expect(feedback?.join(" ")).toContain("1024 x 768");
      expect(history).toEqual([]);
      return { kind: "stop", reason: "user" };
    },
    observations: new BrowserObservationStore(),
    session_id: SESSION_ID,
    article_id: ARTICLE_ID,
    signal: new AbortController().signal,
    max_actions: 5,
    max_model_calls: 3,
    started_at: Date.now(),
    deadline_ms: 5000,
    action_cooldown_ms: 0,
    awaitCandidate: async () => null,
  });
  expect(await driver.run()).toMatchObject({ stopped_reason: "stopped" });
  expect(applied).toEqual([]);
  expect(calls).toBe(2);
});

it("does not turn an Agent stop on HTTP 202 into normal PDF exhaustion", async () => {
  const flow = createBrowserArticleFlow({
    pages: {
      openPage: async () => ({
        page: {
          snapshot: async () => ({
            ...snapshot(1),
            http_status: 202,
            title: "",
            text: "Please enable JavaScript",
          }),
          apply: async () => undefined,
          settleCaptures: async () => undefined,
        },
        close: async () => undefined,
      }),
    },
    decide: async () => ({ kind: "stop", reason: "user" }),
    session_id: SESSION_ID,
    observations: new BrowserObservationStore(),
    hasCandidate: () => false,
    awaitCandidate: async () => null,
  });
  expect(
    await flow.deliver(
      request(new AbortController().signal, "https://fixture.example.test/a"),
    ),
  ).toMatchObject({
    kind: "refused",
    code: "browser-agent-stopped",
    reason: expect.stringContaining("HTTP 202"),
  });
});

describe("cooperative Browser article lifecycle", () => {
  it.each([
    ["budget", "plain-error"],
    ["budget", "typed-cancelled-error"],
    ["cancelled", "typed-cancelled-error"],
  ] as const)(
    "closes an initial page open without changing its owner's lifetime signal (%s / %s)",
    async (reason, failure) => {
      vi.useFakeTimers();
      const owner = new AbortController();
      const entered = deferred<void>();
      let openingSignal: AbortSignal | undefined;
      const decide = vi.fn(
        async () => ({ kind: "stop", reason: "user" }) as const,
      );
      const flow = createBrowserArticleFlow({
        session_id: SESSION_ID,
        deadline_ms: 50,
        now: () => Date.now(),
        decide,
        pages: {
          openPage: async (incoming) => {
            openingSignal = incoming.signal;
            entered.resolve();
            return new Promise<never>((_resolve, reject) => {
              incoming.signal.addEventListener(
                "abort",
                () =>
                  reject(
                    failure === "typed-cancelled-error"
                      ? new BrowserArticleOpenError("browser-flow-cancelled")
                      : new Error("Synthetic initial navigation closed"),
                  ),
                { once: true },
              );
            });
          },
        },
      });
      const delivery = flow.deliver(
        request(owner.signal, "http://127.0.0.1/pending"),
      );
      try {
        await entered.promise;
        if (reason === "budget") await vi.advanceTimersByTimeAsync(51);
        else owner.abort();
        await expect(delivery).resolves.toMatchObject({
          kind: "refused",
          code:
            reason === "budget"
              ? "browser-flow-budget-exhausted"
              : "browser-flow-cancelled",
        });
        expect(openingSignal?.aborted).toBe(true);
        expect(owner.signal.aborted).toBe(reason === "cancelled");
        expect(decide).not.toHaveBeenCalled();
      } finally {
        owner.abort();
        await delivery;
        vi.useRealTimers();
      }
    },
  );

  it("closes a late page handle after its initial opening budget already expired", async () => {
    vi.useFakeTimers();
    const owner = new AbortController();
    const entered = deferred<void>();
    const latePage = deferred<{
      page: FlowPageHandle;
      close: () => Promise<void>;
    }>();
    const close = vi.fn(async () => undefined);
    const decide = vi.fn(
      async () => ({ kind: "stop", reason: "user" }) as const,
    );
    let openingSignal: AbortSignal | undefined;
    const flow = createBrowserArticleFlow({
      session_id: SESSION_ID,
      deadline_ms: 50,
      now: () => Date.now(),
      decide,
      pages: {
        openPage: async (incoming) => {
          openingSignal = incoming.signal;
          entered.resolve();
          return latePage.promise;
        },
      },
    });
    const delivery = flow.deliver(
      request(owner.signal, "http://127.0.0.1/pending"),
    );
    try {
      await entered.promise;
      await vi.advanceTimersByTimeAsync(51);
      expect(openingSignal?.aborted).toBe(true);
      expect(close).not.toHaveBeenCalled();
      latePage.resolve({ page: fakePage({}).page, close });
      await expect(delivery).resolves.toMatchObject({
        kind: "refused",
        code: "browser-flow-budget-exhausted",
      });
      expect(close).toHaveBeenCalledOnce();
      expect(owner.signal.aborted).toBe(false);
      expect(decide).not.toHaveBeenCalled();
    } finally {
      latePage.resolve({ page: fakePage({}).page, close });
      owner.abort();
      await delivery;
      vi.useRealTimers();
    }
  });

  it.each([
    "browser-navigation-failed",
    "browser-runtime-lost",
    "browser-page-closed",
    "browser-page-crashed",
    "browser-session-cleanup-failed",
    "pdf-reader-unavailable",
  ])(
    "preserves stable opening failure %s without exposing the original error text",
    async (code) => {
      const flow = createBrowserArticleFlow({
        session_id: SESSION_ID,
        decide: async () => ({ kind: "stop", reason: "user" }),
        pages: {
          openPage: async () => {
            throw Object.assign(
              new Error("Synthetic private transport detail"),
              { code },
            );
          },
        },
      });
      const result = await flow.deliver(
        request(new AbortController().signal, "https://fixture.example.test/a"),
      );
      expect(result).toMatchObject({ kind: "refused", code });
      expect(JSON.stringify(result)).not.toContain("private transport detail");
    },
  );

  it("ends a second real throttle without another URL retry or a new model call", async () => {
    const firstEntered = deferred<void>();
    const secondEntered = deferred<void>();
    const retry = vi.fn(async () => true);
    const driver = cooperativeDriver({
      page: { ...fakePage({}).page, retryRateLimit: retry },
      decide: async (_o, _f, _s, _g, _t, _h, _feedback, lifecycle) => {
        lifecycle!.onDispatched();
        if (driver.clock.snapshot().model_calls === 1) firstEntered.resolve();
        else secondEntered.resolve();
        return new Promise<never>(() => {});
      },
    });
    const first = driver.step();
    await firstEntered.promise;
    driver.rateLimited();
    await first;
    driver.setNetworkAccess(true);
    const second = driver.step();
    await secondEntered.promise;
    driver.rateLimited();
    expect(await second).toMatchObject({
      kind: "terminal",
      result: { kind: "refused", code: "browser-rate-limited" },
    });
    expect(retry).toHaveBeenCalledOnce();
    expect(driver.clock.snapshot()).toMatchObject({
      model_calls: 2,
      actions: 0,
    });
    await driver.close({ kind: "retained", code: "browser-rate-limited" });
  });

  it("cancels immediately while feedback and pacing are pending", async () => {
    vi.useFakeTimers();
    try {
      const feedback = deferred<void>();
      const driver = cooperativeDriver({
        page: {
          snapshot: async () => snapshot(1),
          apply: async (input) => {
            if (input.kind === "wait-for-change") await feedback.promise;
          },
        },
        decide: async (_o, _f, _s, _g, _t, _h, _feedback, lifecycle) => {
          lifecycle!.onDispatched();
          return { kind: "go-back", revision: 1 };
        },
      });
      expect(await driver.step()).toMatchObject({ kind: "waiting" });
      await vi.advanceTimersByTimeAsync(1_000);
      driver.cancel();
      expect(await driver.step()).toMatchObject({
        kind: "terminal",
        result: { kind: "refused", code: "browser-flow-cancelled" },
      });
      expect(driver.clock.snapshot()).toMatchObject({
        active_elapsed_ms: 1_000,
        model_calls: 1,
        actions: 1,
      });
      expect(vi.getTimerCount()).toBe(0);
      feedback.resolve();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(driver.clock.snapshot().model_calls).toBe(1);
      await driver.close({ kind: "cancelled" });
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    "browser-download-temporary-quota",
    "browser-download-disk-reserve",
    "browser-download-disk-unavailable",
    "file-staging",
    "pdf-reader-unavailable",
    "pdf-reader-timeout",
    "pdf-reader-resource-limit",
  ])(
    "ends a local file failure %s without dispatching another model call",
    async (code) => {
      const decide = vi.fn(async () => ({ kind: "stop", reason: "user" }));
      const driver = cooperativeDriver({ decide });
      driver.transferStarted("local-file-attempt");
      driver.transferFailed("local-file-attempt", code);
      expect(await driver.step()).toMatchObject({
        kind: "terminal",
        result: {
          kind: "refused",
          code: code === "file-staging" ? "browser-file-staging" : code,
        },
      });
      expect(decide).not.toHaveBeenCalled();
      expect(driver.clock.snapshot()).toMatchObject({
        model_calls: 0,
        actions: 0,
      });
      await driver.close({ kind: "retained", code });
    },
  );

  it("delivers a later valid candidate after a recoverable transfer failure", async () => {
    await withStore(async (collector) => {
      const source = new BrowserCaptureBatch(1);
      const driver = cooperativeDriver({
        hasCandidate: () => source.hasCandidate(),
        awaitCandidate: (signal) => source.next(signal),
      });
      driver.transferStarted("interrupted-attempt");
      driver.transferFailed("interrupted-attempt", "browser-transfer-failed");
      expect(driver.phase()).toBe("ready");
      driver.setNetworkAccess(true);
      const captured = await captureFixture(collector, "retry-valid-candidate");
      driver.transferStarted(captured.transfer_id);
      driver.transferCompleted(captured.transfer_id);
      expect(source.add(captured)).toBe(true);
      driver.candidateReady();
      expect(await driver.step()).toMatchObject({
        kind: "candidate",
        candidate: captured.candidate,
        lease: driver,
      });
      await driver.close({ kind: "retained", code: "delivered" });
      expect(await collector.candidateBytes(captured.candidate)).toEqual(
        workbenchPdf(FIXTURE_DOI, "published"),
      );
    });
  });

  it("parks a real throttle and retries the retained URL once after platform readmission", async () => {
    let calls = 0;
    const entered = deferred<void>();
    const answer = deferred<unknown>();
    const retry = vi.fn(async () => true);
    const ended = deferred<void>();
    const driver = cooperativeDriver(
      {
        decide: async (_o, _f, _s, _g, _t, _h, feedback, lifecycle) => {
          lifecycle!.onDispatched();
          if (++calls === 1) {
            entered.resolve();
            return answer.promise;
          }
          expect(feedback?.join(" ")).toContain("browser-rate-limited");
          return { kind: "stop", reason: "user" };
        },
        onNetworkEnded: () => {
          ended.resolve();
        },
      },
      false,
    );
    driver.attachPage({
      page: { ...fakePage({}).page, retryRateLimit: retry },
      stopNetwork: async () => undefined,
    });
    const first = driver.step();
    await entered.promise;
    driver.rateLimited();
    driver.rateLimited();
    expect(await first).toMatchObject({ kind: "waiting" });
    await ended.promise;
    await driver.changed(new AbortController().signal);
    driver.setNetworkAccess(true);
    expect(await driver.step()).toMatchObject({
      kind: "terminal",
      result: { kind: "exhausted" },
    });
    expect(retry).toHaveBeenCalledTimes(1);
    expect(calls).toBe(2);
    answer.resolve({ kind: "go-back", revision: 1 });
    await driver.close({ kind: "retained", code: "exhausted" });
  });

  it("keeps the article root when a popup's download starts after the next observation", async () => {
    const viewerEntered = deferred<void>();
    const viewerAnswer = deferred<unknown>();
    let articleObservations = 0;
    let viewerObservations = 0;
    let calls = 0;
    const viewer: FlowPageHandle = {
      snapshot: async () => {
        viewerObservations++;
        return snapshot(2);
      },
      apply: async () => undefined,
    };
    const root: FlowPageHandle = {
      snapshot: async () => {
        articleObservations++;
        return snapshot(1);
      },
      apply: async () => undefined,
      successor: async () => viewer,
    };
    const driver = cooperativeDriver({
      page: root,
      action_cooldown_ms: 0,
      decide: async (_o, _f, _s, _g, _t, _h, feedback, lifecycle) => {
        lifecycle!.onDispatched();
        calls++;
        if (calls === 1) return { kind: "go-back", revision: 1 };
        if (calls === 2) {
          viewerEntered.resolve();
          return viewerAnswer.promise;
        }
        expect(feedback?.join(" ")).toContain("browser-popup-transfer-failed");
        return { kind: "stop", reason: "user" };
      },
    });
    await driver.step();
    await driver.changed(new AbortController().signal);
    const pending = driver.step();
    await viewerEntered.promise;
    driver.transferStarted("popup-transfer");
    expect(await pending).toMatchObject({ kind: "suspended" });
    driver.transferFailed("popup-transfer", "browser-popup-transfer-failed");
    driver.setNetworkAccess(true);
    expect(await driver.step()).toMatchObject({ kind: "terminal" });
    expect(articleObservations).toBe(2);
    expect(viewerObservations).toBe(1);
    expect(driver.clock.snapshot()).toMatchObject({
      model_calls: 3,
      actions: 2,
    });
    viewerAnswer.resolve({ kind: "go-back", revision: 2 });
    await driver.close({
      kind: "retained",
      code: "browser-popup-transfer-failed",
    });
  });
  it("charges inference only after the transport dispatch, even after a long model queue", async () => {
    vi.useFakeTimers();
    try {
      const entered = deferred<void>();
      const permit = deferred<void>();
      const sent = deferred<void>();
      const answer = deferred<unknown>();
      const driver = cooperativeDriver({
        decide: async (_o, _f, _s, _g, _t, _h, _feedback, lifecycle) => {
          entered.resolve();
          await permit.promise;
          lifecycle!.onDispatched();
          sent.resolve();
          return answer.promise;
        },
      });
      const step = driver.step();
      await entered.promise;
      await vi.advanceTimersByTimeAsync(600_000);
      expect(driver.clock.snapshot()).toMatchObject({
        active_elapsed_ms: 0,
        model_calls: 0,
        active: false,
      });
      permit.resolve();
      await sent.promise;
      await vi.advanceTimersByTimeAsync(2_000);
      answer.resolve({ kind: "stop", reason: "user" });
      expect(await step).toMatchObject({
        kind: "terminal",
        result: { kind: "exhausted" },
      });
      expect(driver.clock.snapshot()).toMatchObject({
        active_elapsed_ms: 2_000,
        model_calls: 1,
        actions: 1,
      });
      await driver.close({ kind: "retained", code: "no-candidate" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("revokes a late model action at transfer start and resumes the same page with remaining usage", async () => {
    vi.useFakeTimers();
    try {
      const entered = deferred<void>();
      const answer = deferred<unknown>();
      const { page, applied, snapshots } = fakePage({});
      let calls = 0;
      const driver = cooperativeDriver({
        page,
        decide: async (_o, _f, _s, _g, _t, _h, feedback, lifecycle) => {
          lifecycle!.onDispatched();
          if (++calls === 1) {
            entered.resolve();
            return answer.promise;
          }
          expect(feedback?.join(" ")).toContain("browser-transfer-failed");
          return { kind: "stop", reason: "user" };
        },
      });
      const first = driver.step();
      await entered.promise;
      await vi.advanceTimersByTimeAsync(1_000);
      driver.transferStarted("main-transfer");
      driver.transferStarted("main-transfer");
      expect(await first).toEqual({
        kind: "suspended",
        transfer_id: "main-transfer",
      });
      answer.resolve({ kind: "go-back", revision: 1 });
      await vi.advanceTimersByTimeAsync(600_000);
      expect(applied).toEqual([]);
      expect(driver.clock.snapshot()).toMatchObject({
        active_elapsed_ms: 1_000,
        model_calls: 1,
        actions: 0,
      });
      driver.transferFailed("other-transfer", "ignored");
      expect(driver.phase()).toBe("downloading");
      driver.transferFailed("main-transfer", "browser-transfer-failed");
      driver.setNetworkAccess(true);
      expect(await driver.step()).toMatchObject({
        kind: "terminal",
        result: { kind: "refused", code: "browser-transfer-failed" },
      });
      expect(snapshots()).toBe(2);
      expect(driver.clock.snapshot()).toMatchObject({
        remaining_ms: 299_000,
        model_calls: 2,
        actions: 1,
      });
      await driver.close({ kind: "retained", code: "no-candidate" });
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([1_000, 5_100])(
    "overlaps pacing with feedback arriving at %i ms",
    async (feedbackMs) => {
      vi.useFakeTimers();
      try {
        const changed = deferred<void>();
        let calls = 0;
        const driver = cooperativeDriver({
          page: {
            snapshot: async () => snapshot(calls + 1),
            apply: async (input) => {
              if (input.kind === "wait-for-change") await changed.promise;
            },
          },
          decide: async (_o, _f, _s, _g, _t, _h, _feedback, lifecycle) => {
            lifecycle!.onDispatched();
            return ++calls === 1
              ? { kind: "go-back", revision: 1 }
              : { kind: "stop", reason: "user" };
          },
        });
        expect(await driver.step()).toMatchObject({ kind: "waiting" });
        await vi.advanceTimersByTimeAsync(Math.min(4_999, feedbackMs));
        if (feedbackMs < 5_000) changed.resolve();
        await vi.advanceTimersByTimeAsync(4_999 - Math.min(4_999, feedbackMs));
        expect(await driver.step()).toMatchObject({ kind: "waiting" });
        expect(calls).toBe(1);
        await vi.advanceTimersByTimeAsync(Math.max(1, feedbackMs - 4_999));
        changed.resolve();
        await vi.advanceTimersByTimeAsync(0);
        expect(await driver.step()).toMatchObject({ kind: "terminal" });
        expect(calls).toBe(2);
        expect(driver.clock.snapshot()).toMatchObject({
          active_elapsed_ms: Math.max(5_000, feedbackMs),
          actions: 2,
        });
        await driver.close({ kind: "retained", code: "no-candidate" });
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("does not lose a transfer event between a yielded step and waiter registration", async () => {
    const controller = new AbortController();
    const driver = cooperativeDriver({
      automatic: {
        canDecide: () => false,
        controlEpoch: () => 0,
        guidance: () => [],
      },
    });
    expect(await driver.step()).toMatchObject({
      kind: "waiting",
      reason: "human-control",
    });
    driver.transferStarted("between-step-and-wait");
    await driver.changed(controller.signal);
    expect(await driver.step()).toEqual({
      kind: "suspended",
      transfer_id: "between-step-and-wait",
    });
    let woke = false;
    const waiting = driver.changed(controller.signal).then(() => {
      woke = true;
    });
    await Promise.resolve();
    expect(woke).toBe(false);
    driver.transferCompleted("between-step-and-wait");
    await waiting;
    expect(woke).toBe(true);
    expect(driver.phase()).toBe("validating");
    await driver.close({ kind: "cancelled" });
  });

  it("rearms the hard active budget after a platform queue excludes a pending action", async () => {
    vi.useFakeTimers();
    try {
      const entered = deferred<void>();
      const action = deferred<void>();
      const clock = new BrowserArticleClock({
        budget: {
          active_ms: 2_000,
          max_actions: 100,
          max_model_calls: 50,
          min_decision_interval_ms: 5_000,
        },
      });
      const driver = cooperativeDriver({
        clock,
        page: {
          snapshot: async () => snapshot(1),
          apply: async () => {
            entered.resolve();
            await action.promise;
          },
        },
        decide: async (_o, _f, _s, _g, _t, _h, _feedback, lifecycle) => {
          lifecycle!.onDispatched();
          return { kind: "go-back", revision: 1 };
        },
      });
      const step = driver.step();
      await entered.promise;
      await vi.advanceTimersByTimeAsync(1_000);
      const queue = clock.exclude();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(clock.remaining().deadline_ms).toBe(1_000);
      queue();
      await vi.advanceTimersByTimeAsync(999);
      expect(clock.remaining().deadline_ms).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(await step).toMatchObject({
        kind: "terminal",
        result: { kind: "refused", code: "browser-flow-budget-exhausted" },
      });
      action.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(clock.snapshot()).toMatchObject({
        active_elapsed_ms: 2_000,
        actions: 1,
      });
      await driver.close({ kind: "retained", code: "budget" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("hands off a valid candidate immediately and reports cleanup failure only on its idempotent lease close", async () => {
    await withStore(async (collector) => {
      const candidate = await captureFixture(
        collector,
        "leased-valid-candidate",
      );
      const source = new BrowserCaptureBatch();
      let closes = 0;
      const networkOutcomes: string[] = [];
      const driver = cooperativeDriver(
        {
          hasCandidate: () => source.hasCandidate(),
          awaitCandidate: (signal) => source.next(signal),
          onNetworkEnded: (_identity, outcome) => {
            networkOutcomes.push(outcome.kind);
          },
          close: async () => {
            closes += 1;
            throw new Error("owned close could not confirm its writers ended");
          },
        },
        false,
      );
      driver.attachPage({
        page: fakePage({}).page,
        stopNetwork: async () => {
          throw new Error("controlled close failed");
        },
      });
      driver.transferStarted(candidate.transfer_id);
      driver.transferCompleted(candidate.transfer_id);
      expect(source.add(candidate)).toBe(true);
      driver.candidateReady();
      driver.candidateReady();
      expect(await driver.step()).toMatchObject({
        kind: "candidate",
        candidate: candidate.candidate,
        lease: driver,
      });
      expect(driver.clock.snapshot()).toMatchObject({
        actions: 0,
        model_calls: 0,
      });
      const firstClose = driver.close({
        kind: "retained",
        code: "publication-failed",
      });
      expect(driver.close({ kind: "cancelled" })).toBe(firstClose);
      await expect(firstClose).rejects.toMatchObject({
        code: "browser-flow-close-failed",
      });
      expect(await collector.candidateBytes(candidate.candidate)).toEqual(
        workbenchPdf(FIXTURE_DOI, "published"),
      );
      expect(networkOutcomes).toEqual([]);
      expect(closes).toBe(1);
      expect(driver.phase()).toBe("closed");
    });
  });

  it("waits for a confirmed owned close before superseding a failed cooperative network stop", async () => {
    const stopError = Object.assign(
      new Error("synthetic renderer stop failure"),
      {
        code: "browser-protocol",
      },
    );
    const ownedClosed = deferred<void>();
    const closeEntered = deferred<void>();
    const close = vi.fn(async () => {
      closeEntered.resolve();
      await ownedClosed.promise;
    });
    const ended = vi.fn();
    const driver = cooperativeDriver({ close, onNetworkEnded: ended }, false);
    driver.attachPage({
      page: fakePage({}).page,
      stopNetwork: async () => {
        throw stopError;
      },
    });
    driver.transferStarted("owned-close-transfer");
    driver.transferFailed("owned-close-transfer", "pdf-reader-unavailable");
    const terminal = await driver.step();
    expect(terminal).toMatchObject({
      kind: "terminal",
      result: { kind: "refused", code: "pdf-reader-unavailable" },
    });
    const pending = driver.close({ kind: "cancelled" });
    let settled = false;
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await closeEntered.promise;
    expect(
      driver.close({ kind: "retained", code: "ignored-later-outcome" }),
    ).toBe(pending);
    expect(settled).toBe(false);
    expect(driver.phase()).toBe("closing");
    expect(ended).not.toHaveBeenCalled();
    ownedClosed.resolve();
    await expect(pending).resolves.toBeUndefined();
    expect(close).toHaveBeenCalledOnce();
    expect(driver.phase()).toBe("closed");
    expect(await driver.step()).toEqual(terminal);
  });

  it("retains the failed stop and owned-close causes when owned writers cannot be confirmed ended", async () => {
    const stopError = new Error("synthetic renderer stop failure");
    const ownedError = new Error("synthetic owned writer still active");
    const close = vi.fn(async () => {
      throw ownedError;
    });
    const driver = cooperativeDriver({ close }, false);
    driver.attachPage({
      page: fakePage({}).page,
      stopNetwork: async () => {
        throw stopError;
      },
    });
    const pending = driver.close({ kind: "cancelled" });
    await expect(pending).rejects.toMatchObject({
      code: "browser-flow-close-failed",
      cause: { errors: [stopError, ownedError] },
    });
    expect(driver.close({ kind: "cancelled" })).toBe(pending);
    await expect(driver.close({ kind: "cancelled" })).rejects.toMatchObject({
      code: "browser-flow-close-failed",
      cause: { errors: [stopError, ownedError] },
    });
    expect(close).toHaveBeenCalledOnce();
  });

  it("retains an unconfirmed network-stop error when no owned close is available", async () => {
    const stopError = new Error("synthetic renderer stop failure");
    const driver = cooperativeDriver({}, false);
    driver.attachPage({
      page: fakePage({}).page,
      stopNetwork: async () => {
        throw stopError;
      },
    });
    await expect(driver.close({ kind: "cancelled" })).rejects.toMatchObject({
      code: "browser-flow-close-failed",
      cause: stopError,
    });
  });

  it("locks the first network outcome across duplicate events and permits a later attempt", async () => {
    const ended: string[] = [];
    const driver = cooperativeDriver(
      {
        onNetworkEnded: (_identity, outcome) => {
          ended.push(outcome.kind);
        },
      },
      false,
    );
    driver.attachPage({
      page: fakePage({}).page,
      stopNetwork: async () => undefined,
    });
    driver.transferStarted("failed-attempt");
    driver.transferFailed("failed-attempt", "browser-transfer-failed");
    driver.candidateRejected("browser-candidate-excluded");
    await Promise.resolve();
    await Promise.resolve();
    expect(ended).toEqual(["failure"]);
    driver.setNetworkAccess(true);
    driver.transferStarted("second-attempt");
    driver.transferCompleted("second-attempt");
    driver.candidateReady();
    await Promise.resolve();
    await Promise.resolve();
    expect(ended).toEqual(["failure", "completed"]);
    await driver.close({ kind: "cancelled" });
    expect(ended).toEqual(["failure", "completed"]);
  });
});

describe("Browser entry preparation before the first model dispatch", () => {
  const first = "https://fixture.example.test/article?version=1";
  const alternate = "https://other.example.test/article?version=1";

  function preparationFixture(
    options: {
      status?: number;
      initialFailure?: boolean;
      entries?: readonly string[];
      deadline?: number;
    } = {},
  ) {
    const controller = new AbortController();
    let url = first;
    let status = options.status ?? 404;
    let execution!: BrowserArticleExecution;
    const navigate = vi.fn(async (next: string) => {
      expect(execution.preparationTarget?.()).toBe(next);
      expect(execution.clock.snapshot().model_calls).toBe(0);
      url = next;
      status = 200;
    });
    const settle = vi.fn(async () => undefined);
    const page: FlowPageHandle = {
      snapshot: async () => ({ ...snapshot(1), url, http_status: status }),
      apply: async () => undefined,
      navigate,
      navigationUrl: () => url,
      settleCaptures: settle,
      ...(options.initialFailure
        ? { initial_navigation_failure: { recoverable: true } }
        : {}),
    };
    const close = vi.fn(async () => undefined);
    const opened = vi.fn(async () => ({ page, close }));
    const decide = vi.fn(
      async () => ({ kind: "stop", reason: "user" }) as const,
    );
    const registered = vi.fn((value: BrowserArticleExecution) => {
      execution = value;
    });
    const flow = createBrowserArticleFlow({
      session_id: SESSION_ID,
      pages: { openPage: opened },
      observations: new BrowserObservationStore(),
      onSession: registered,
      now: () => Date.now(),
      ...(options.deadline ? { deadline_ms: options.deadline } : {}),
      decide,
    });
    return {
      controller,
      page,
      navigate,
      settle,
      close,
      opened,
      decide,
      registered,
      execution: () => execution,
      setPage: (next: string, nextStatus: number) => {
        url = next;
        status = nextStatus;
      },
      deliver: () =>
        flow.deliver({
          ...request(controller.signal, first),
          start_urls: options.entries ?? [first, alternate],
        }),
    };
  }

  it.each(["http-404", "transport-failure"])(
    "recovers %s inside one clock and one page with five-second pacing",
    async (failure) => {
      vi.useFakeTimers();
      const fixture = preparationFixture({
        initialFailure: failure === "transport-failure",
      });
      const delivery = fixture.deliver();
      try {
        await vi.advanceTimersByTimeAsync(4_999);
        expect(fixture.navigate).not.toHaveBeenCalled();
        expect(fixture.decide).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(fixture.navigate).toHaveBeenCalledExactlyOnceWith(alternate);
        expect(fixture.decide).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(5_000);
        expect(await delivery).toEqual({ kind: "exhausted" });
        expect(fixture.registered).toHaveBeenCalledOnce();
        expect(fixture.opened).toHaveBeenCalledOnce();
        expect(fixture.close).toHaveBeenCalledOnce();
        expect(fixture.decide).toHaveBeenCalledOnce();
        expect(fixture.execution().clock.snapshot()).toMatchObject({
          model_calls: 1,
          actions: 1,
          active_elapsed_ms: 10_000,
        });
        expect(fixture.execution().preparationTarget?.()).toBeNull();
      } finally {
        fixture.controller.abort();
        await delivery;
        vi.useRealTimers();
      }
    },
  );

  it.each([403, 202, 200])(
    "hands HTTP %i to the model without trying another entry",
    async (status) => {
      const fixture = preparationFixture({ status });
      await fixture.deliver();
      expect(fixture.navigate).not.toHaveBeenCalled();
      expect(fixture.decide).toHaveBeenCalledOnce();
    },
  );

  it("remembers redirect destinations and keeps meaningful query variants distinct", async () => {
    vi.useFakeTimers();
    const second = "https://fixture.example.test/article?version=2";
    const doi = "https://doi.org/10.5555/synthetic";
    const fixture = preparationFixture({
      entries: [first, doi, second, alternate],
    });
    fixture.setPage(second, 404);
    fixture.navigate.mockImplementation(async (next) => {
      fixture.setPage(next === doi ? first : next, next === doi ? 410 : 200);
    });
    const delivery = fixture.deliver();
    try {
      await vi.runAllTimersAsync();
      expect(await delivery).toEqual({ kind: "exhausted" });
      expect(fixture.navigate.mock.calls.map(([url]) => url)).toEqual([
        doi,
        alternate,
      ]);
      expect(fixture.decide).toHaveBeenCalledOnce();
    } finally {
      fixture.controller.abort();
      await delivery;
      vi.useRealTimers();
    }
  });

  it("does not collapse distinct query entries or loop back to a failed landing", async () => {
    vi.useFakeTimers();
    const second = "https://fixture.example.test/article?version=2";
    const doi = "https://doi.org/10.5555/synthetic";
    const fixture = preparationFixture({
      entries: [first, second, doi, first],
    });
    fixture.navigate.mockImplementation(async () => {
      fixture.setPage(first, 410);
    });
    const delivery = fixture.deliver();
    try {
      await vi.runAllTimersAsync();
      expect(await delivery).toMatchObject({
        kind: "refused",
        code: "browser-navigation-failed",
      });
      expect(fixture.navigate.mock.calls.map(([url]) => url)).toEqual([
        second,
        doi,
      ]);
      expect(fixture.decide).not.toHaveBeenCalled();
    } finally {
      fixture.controller.abort();
      await delivery;
      vi.useRealTimers();
    }
  });

  it("settles a late initial PDF capture without navigating or calling the model", async () => {
    await withStore(async (collector) => {
      const candidate = await captureFixture(collector, "entry-initial-pdf");
      let captured = false;
      const decide = vi.fn(async () => ({ kind: "stop", reason: "user" }));
      const navigate = vi.fn(async () => undefined);
      const flow = createBrowserArticleFlow({
        session_id: SESSION_ID,
        action_cooldown_ms: 0,
        decide,
        hasCandidate: () => captured,
        awaitCandidate: async () => (captured ? candidate : null),
        pages: {
          openPage: async () => ({
            page: {
              ...fakePage({}).page,
              initial_navigation_failure: { recoverable: false },
              settleCaptures: async () => {
                captured = true;
              },
              navigate,
            },
            close: async () => undefined,
          }),
        },
      });
      expect(
        await flow.deliver({
          ...request(new AbortController().signal, first),
          start_urls: [first, alternate],
        }),
      ).toMatchObject({ kind: "delivered", candidate: candidate.candidate });
      expect(navigate).not.toHaveBeenCalled();
      expect(decide).not.toHaveBeenCalled();
    });
  });

  it("parks when capture starts during settlement and never changes its page", async () => {
    const settled = deferred<void>();
    const page: FlowPageHandle = {
      ...fakePage({}).page,
      initial_navigation_failure: { recoverable: true },
      settleCaptures: () => settled.promise,
      navigate: vi.fn(async () => undefined),
    };
    const driver = cooperativeDriver({
      page,
      start_url: first,
      start_urls: [first, alternate],
      decide: vi.fn(async () => ({ kind: "stop", reason: "user" })),
    });
    const step = driver.step();
    driver.transferStarted("pending-initial-pdf");
    expect(await step).toEqual({
      kind: "suspended",
      transfer_id: "pending-initial-pdf",
    });
    settled.resolve();
    expect(page.navigate).not.toHaveBeenCalled();
    expect(driver.clock.snapshot().model_calls).toBe(0);
    await driver.close({ kind: "cancelled" });
  });

  it("retains cancellation, active-time and rate-limit stops during preparation", async () => {
    for (const stop of ["cancel", "budget", "rate-limit"] as const) {
      vi.useFakeTimers();
      const fixture = preparationFixture({
        deadline: stop === "budget" ? 3_000 : 300_000,
      });
      if (stop === "rate-limit")
        fixture.navigate.mockRejectedValue(
          Object.assign(new Error("Limited"), { code: "browser-rate-limited" }),
        );
      const delivery = fixture.deliver();
      try {
        await vi.advanceTimersByTimeAsync(1);
        if (stop === "cancel") fixture.controller.abort();
        await vi.runAllTimersAsync();
        expect(await delivery).toMatchObject({
          kind: "refused",
          code:
            stop === "cancel"
              ? "browser-flow-cancelled"
              : stop === "budget"
                ? "browser-flow-budget-exhausted"
                : "browser-rate-limited",
        });
        expect(fixture.decide).not.toHaveBeenCalled();
        expect(fixture.navigate).toHaveBeenCalledTimes(
          stop === "rate-limit" ? 1 : 0,
        );
      } finally {
        fixture.controller.abort();
        await delivery;
        vi.useRealTimers();
      }
    }
  });

  it("does not switch to an alternate after the first actual model dispatch", async () => {
    let status = 200;
    const navigate = vi.fn(async () => undefined);
    const decide = vi.fn(async (observation) => {
      if (status === 200)
        return { kind: "go-back", revision: observation.observation_revision };
      return { kind: "stop", reason: "user" };
    });
    const driver = cooperativeDriver({
      page: {
        snapshot: async () => ({ ...snapshot(1), http_status: status }),
        apply: async () => {
          status = 404;
        },
        navigate,
      },
      start_url: first,
      start_urls: [first, alternate],
      dispatch_tracking: "test-seam",
      action_cooldown_ms: 0,
      decide,
    });
    await driver.run();
    expect(decide).toHaveBeenCalledTimes(2);
    expect(navigate).not.toHaveBeenCalled();
    await driver.close({ kind: "retained", code: "tested" });
  });

  it("keeps the original entry after an initial throttle is readmitted and retried", async () => {
    const navigate = vi.fn(async () => undefined);
    const retry = vi.fn(async () => true);
    const driver = cooperativeDriver({
      page: {
        ...fakePage({}).page,
        initial_navigation_failure: { recoverable: false },
        navigate,
        retryRateLimit: retry,
      },
      start_url: first,
      start_urls: [first, alternate],
      decide: async (_o, _f, _s, _g, _t, _h, _feedback, lifecycle) => {
        lifecycle!.onDispatched();
        return { kind: "stop", reason: "user" };
      },
    });
    driver.rateLimited();
    driver.setNetworkAccess(true);
    expect(await driver.step()).toMatchObject({
      kind: "terminal",
      result: { kind: "exhausted" },
    });
    expect(retry).toHaveBeenCalledOnce();
    expect(navigate).not.toHaveBeenCalled();
    expect(driver.clock.snapshot().model_calls).toBe(1);
    await driver.close({ kind: "retained", code: "tested" });
  });

  it("ends a hung preparation observation at the article's active-time boundary", async () => {
    vi.useFakeTimers();
    const pending = deferred<ReturnType<typeof snapshot>>();
    const decide = vi.fn(async () => ({ kind: "stop", reason: "user" }));
    const driver = cooperativeDriver({
      page: { ...fakePage({}).page, snapshot: () => pending.promise },
      start_url: first,
      start_urls: [first, alternate],
      now: () => Date.now(),
      deadline_ms: 3_000,
      decide,
    });
    try {
      const step = driver.step();
      await vi.advanceTimersByTimeAsync(3_000);
      expect(await step).toMatchObject({
        kind: "terminal",
        result: { kind: "refused", code: "browser-flow-budget-exhausted" },
      });
      pending.resolve(snapshot(1));
      expect(decide).not.toHaveBeenCalled();
    } finally {
      pending.resolve(snapshot(1));
      await driver.close({ kind: "retained", code: "tested" });
      vi.useRealTimers();
    }
  });

  it("recovers a second explicit transport failure without creating another page", async () => {
    vi.useFakeTimers();
    const third = "https://third.example.test/article";
    const fixture = preparationFixture({ entries: [first, alternate, third] });
    fixture.navigate.mockRejectedValueOnce(
      new BrowserHostNavigationError(
        new Error("Synthetic connection failure"),
        true,
      ),
    );
    const delivery = fixture.deliver();
    try {
      await vi.runAllTimersAsync();
      expect(await delivery).toEqual({ kind: "exhausted" });
      expect(fixture.navigate.mock.calls.map(([url]) => url)).toEqual([
        alternate,
        third,
      ]);
      expect(fixture.opened).toHaveBeenCalledOnce();
    } finally {
      fixture.controller.abort();
      await delivery;
      vi.useRealTimers();
    }
  });

  it("validates every admitted entry while preserving the legacy single entry", () => {
    const base = request(new AbortController().signal, first);
    expect(admitBrowserArticleRequest(base)).toMatchObject({
      ok: true,
      request: { start_url: first },
    });
    for (const invalid of [
      "https://name:password@fixture.invalid/a",
      "file:///a",
      first + "#fragment",
      "invalid",
    ]) {
      expect(
        admitBrowserArticleRequest({ ...base, start_urls: [first, invalid] }),
      ).toMatchObject({
        ok: false,
        refusal: { code: "browser-start-url-invalid" },
      });
    }
    expect(
      admitBrowserArticleRequest({ ...base, start_urls: [alternate, first] })
        .ok,
    ).toBe(false);
    expect(admitBrowserArticleRequest({ ...base, start_urls: [] }).ok).toBe(
      false,
    );
    expect(
      admitBrowserArticleRequest({
        ...base,
        start_url: "invalid",
        start_urls: [first],
      }).ok,
    ).toBe(false);
    const admitted = admitBrowserArticleRequest({
      ...base,
      start_urls: [first, alternate, first],
    });
    expect(admitted).toMatchObject({
      ok: true,
      request: { start_urls: [first, alternate] },
    });
  });
});

describe("Browser collaboration initialization lifetime", () => {
  type CollaborationHandle = Awaited<
    ReturnType<
      NonNullable<BrowserArticleFlowFactoryOptions["collaboration"]>["open"]
    >
  >;

  it("charges the initial collaborative page observation to the existing article clock", async () => {
    vi.useFakeTimers();
    let execution!: BrowserArticleExecution;
    const flow = createBrowserArticleFlow({
      session_id: SESSION_ID,
      now: () => Date.now(),
      decide: async () => ({ kind: "stop", reason: "user" }),
      onSession: (value) => {
        execution = value;
      },
      pages: {
        openPage: async () => {
          await new Promise((resolve) => setTimeout(resolve, 1_000));
          return { page: fakePage({}).page, close: async () => undefined };
        },
      },
      collaboration: {
        open: async (_request, _page, _deadline, supplied) => {
          expect(supplied).toBe(execution);
          expect(execution.clock.snapshot().active).toBe(true);
          expect(execution.clock.snapshot().active_elapsed_ms).toBe(1_000);
          await new Promise((resolve) => setTimeout(resolve, 2_000));
          return { step: async () => "stopped", close: async () => undefined };
        },
      },
    });
    const delivery = flow.deliver(
      request(
        new AbortController().signal,
        "https://fixture.example.test/article",
      ),
    );
    try {
      await vi.advanceTimersByTimeAsync(3_000);
      expect(await delivery).toEqual({ kind: "exhausted" });
      expect(execution.clock.snapshot()).toMatchObject({
        active_elapsed_ms: 3_000,
        remaining_ms: 297_000,
        model_calls: 0,
        active: false,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["budget", "cancelled"] as const)(
    "ends pending initialization on %s and closes a late handle exactly once",
    async (stop) => {
      vi.useFakeTimers();
      const controller = new AbortController();
      const entered = deferred<void>();
      const pending = deferred<CollaborationHandle>();
      const beforeClose = vi.fn(async () => undefined);
      const close = vi.fn(async () => undefined);
      const registeredClose = vi.fn(async () => undefined);
      const pageClose = vi.fn(async () => undefined);
      const decide = vi.fn(async () => ({ kind: "stop", reason: "user" }));
      const flow = createBrowserArticleFlow({
        session_id: SESSION_ID,
        deadline_ms: 3_000,
        now: () => Date.now(),
        decide,
        pages: {
          openPage: async () => ({ page: fakePage({}).page, close: pageClose }),
        },
        collaboration: {
          registered: () => ({ close: registeredClose }),
          open: async () => {
            entered.resolve();
            return pending.promise;
          },
        },
      });
      const delivery = flow.deliver(
        request(controller.signal, "https://fixture.example.test/article"),
      );
      try {
        await entered.promise;
        if (stop === "budget") await vi.advanceTimersByTimeAsync(3_000);
        else controller.abort();
        expect(await delivery).toMatchObject({
          kind: "refused",
          code:
            stop === "budget"
              ? "browser-flow-budget-exhausted"
              : "browser-flow-cancelled",
        });
        const outcome =
          stop === "budget"
            ? { kind: "retained", code: "browser-flow-budget-exhausted" }
            : { kind: "cancelled" };
        expect(controller.signal.aborted).toBe(stop === "cancelled");
        expect(pageClose).toHaveBeenCalledOnce();
        expect(registeredClose).toHaveBeenCalledExactlyOnceWith(outcome);
        expect(beforeClose).not.toHaveBeenCalled();
        expect(close).not.toHaveBeenCalled();
        expect(decide).not.toHaveBeenCalled();
        pending.resolve({ step: async () => "stopped", beforeClose, close });
        await vi.advanceTimersByTimeAsync(0);
        expect(beforeClose).toHaveBeenCalledExactlyOnceWith(outcome);
        expect(close).toHaveBeenCalledExactlyOnceWith(true, outcome);
        expect(registeredClose).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        pending.resolve({ step: async () => "stopped", beforeClose, close });
        controller.abort();
        await delivery;
        vi.useRealTimers();
      }
    },
  );

  it("deduplicates late-handle cleanup while the owned page is still closing", async () => {
    const controller = new AbortController();
    const entered = deferred<void>();
    const pending = deferred<CollaborationHandle>();
    const closingPage = deferred<void>();
    const pageClosed = deferred<void>();
    const beforeClose = vi.fn(async () => undefined);
    const close = vi.fn(async () => undefined);
    const flow = createBrowserArticleFlow({
      session_id: SESSION_ID,
      decide: async () => ({ kind: "stop", reason: "user" }),
      pages: {
        openPage: async () => ({
          page: fakePage({}).page,
          close: async () => {
            closingPage.resolve();
            await pageClosed.promise;
          },
        }),
      },
      collaboration: {
        registered: () => ({ close: async () => undefined }),
        open: async () => {
          entered.resolve();
          return pending.promise;
        },
      },
    });
    const delivery = flow.deliver(
      request(controller.signal, "https://fixture.example.test/article"),
    );
    await entered.promise;
    controller.abort();
    await closingPage.promise;
    pending.resolve({ step: async () => "stopped", beforeClose, close });
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    pageClosed.resolve();
    expect(await delivery).toMatchObject({
      kind: "refused",
      code: "browser-flow-cancelled",
    });
    expect(beforeClose).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it.each(["before-close", "close"] as const)(
    "reports late %s failure through the registered owner after cancellation already returned",
    async (failure) => {
      const controller = new AbortController();
      const entered = deferred<void>();
      const pending = deferred<CollaborationHandle>();
      const registeredClose = vi.fn(async () => undefined);
      const close = vi.fn(async () => {
        if (failure === "close")
          throw new Error("Synthetic late close failure");
      });
      const flow = createBrowserArticleFlow({
        session_id: SESSION_ID,
        decide: async () => ({ kind: "stop", reason: "user" }),
        pages: {
          openPage: async () => ({
            page: fakePage({}).page,
            close: async () => undefined,
          }),
        },
        collaboration: {
          registered: () => ({ close: registeredClose }),
          open: async () => {
            entered.resolve();
            return pending.promise;
          },
        },
      });
      const delivery = flow.deliver(
        request(controller.signal, "https://fixture.example.test/article"),
      );
      await entered.promise;
      controller.abort();
      expect(await delivery).toMatchObject({
        kind: "refused",
        code: "browser-flow-cancelled",
      });
      pending.resolve({
        step: async () => "stopped",
        beforeClose: async () => {
          if (failure === "before-close")
            throw new Error("Synthetic late beforeClose failure");
        },
        close,
      });
      await vi.waitFor(() =>
        expect(registeredClose).toHaveBeenLastCalledWith({
          kind: "retained",
          code: "browser-flow-close-failed",
        }),
      );
      expect(registeredClose).toHaveBeenCalledTimes(2);
      expect(close).toHaveBeenCalledOnce();
    },
  );
});

describe("capture priority during collaborative initialization", () => {
  type CollaborationHandle = Awaited<
    ReturnType<
      NonNullable<BrowserArticleFlowFactoryOptions["collaboration"]>["open"]
    >
  >;
  const handle = (
    close = vi.fn(async () => undefined),
  ): CollaborationHandle => ({
    automatic: {
      canDecide: () => true,
      controlEpoch: () => 0,
      guidance: () => [],
    },
    step: async () => "stopped",
    close,
  });

  it.each(["download", "candidate", "already-candidate"] as const)(
    "returns the same execution on %s without waiting for the initial observation",
    async (phase) => {
      await withStore(async (collector) => {
        const candidate = await captureFixture(collector, "initialization-pdf");
        vi.useFakeTimers();
        const pending = deferred<CollaborationHandle>();
        const entered = deferred<void>();
        let execution!: BrowserArticleExecution;
        let captured = phase === "already-candidate";
        const close = vi.fn(async () => undefined);
        const decide = vi.fn(async () => ({ kind: "stop", reason: "user" }));
        const flow = createBrowserArticleFlow({
          session_id: SESSION_ID,
          deadline_ms: 1_000,
          now: () => Date.now(),
          decide,
          onSession: (value) => {
            execution = value;
          },
          pages: {
            openPage: async () => ({
              page: fakePage({}).page,
              close: async () => undefined,
            }),
          },
          candidateSource: () => ({
            hasCandidate: () => captured,
            next: async () => (captured ? candidate : null),
          }),
          collaboration: {
            registered: () => ({ close: async () => undefined }),
            open: async () => {
              entered.resolve();
              return pending.promise;
            },
          },
        });
        const opening = flow.open!(
          request(
            new AbortController().signal,
            "https://fixture.example.test/article",
          ),
        );
        try {
          await entered.promise;
          if (phase === "download")
            execution.transferStarted(candidate.transfer_id);
          else if (phase === "candidate") {
            captured = true;
            execution.candidateReady();
          }
          expect(await opening).toBe(execution);
          if (phase === "download") {
            expect(await execution.step()).toEqual({
              kind: "suspended",
              transfer_id: candidate.transfer_id,
            });
            await vi.advanceTimersByTimeAsync(10_000);
            expect(execution.clock.snapshot()).toMatchObject({
              active: false,
              remaining_ms: 1_000,
            });
            execution.transferCompleted(candidate.transfer_id);
            captured = true;
            execution.candidateReady();
          }
          const delivered = await execution.step();
          expect(delivered).toMatchObject({
            kind: "candidate",
            candidate: candidate.candidate,
          });
          expect(execution.clock.snapshot().model_calls).toBe(0);
          expect(decide).not.toHaveBeenCalled();
          await execution.close({ kind: "retained", code: "delivered" });
          expect(close).not.toHaveBeenCalled();
          pending.resolve(handle(close));
          await vi.advanceTimersByTimeAsync(0);
          expect(close).toHaveBeenCalledExactlyOnceWith(false, {
            kind: "retained",
            code: "delivered",
          });
        } finally {
          pending.resolve(handle(close));
          await execution.close({ kind: "cancelled" });
          vi.useRealTimers();
        }
      });
    },
  );

  it.each(["ready", "failed", "budget", "immediate-failure"] as const)(
    "waits for the same initialization after a download failure and handles %s",
    async (completion) => {
      vi.useFakeTimers();
      const pending = deferred<CollaborationHandle>();
      const entered = deferred<void>();
      let execution!: BrowserArticleExecution;
      const decide = vi.fn<
        NonNullable<BrowserArticleFlowFactoryOptions["decide"]>
      >(async (_o, _f, _s, _g, _t, _h, _feedback, lifecycle) => {
        lifecycle!.onDispatched();
        return { kind: "stop", reason: "user" };
      });
      const flow = createBrowserArticleFlow({
        session_id: SESSION_ID,
        deadline_ms: 1_000,
        now: () => Date.now(),
        observations: new BrowserObservationStore(),
        decide,
        onSession: (value) => {
          execution = value;
        },
        pages: {
          openPage: async () => ({
            page: fakePage({}).page,
            close: async () => undefined,
          }),
        },
        candidateSource: () => ({
          hasCandidate: () => false,
          next: async () => null,
        }),
        collaboration: {
          registered: () => ({ close: async () => undefined }),
          open: async () => {
            entered.resolve();
            return pending.promise;
          },
        },
      });
      const opening = flow.open!(
        request(
          new AbortController().signal,
          "https://fixture.example.test/article",
        ),
      );
      try {
        await entered.promise;
        execution.transferStarted("initializing-download");
        if (completion === "immediate-failure")
          execution.transferFailed(
            "initializing-download",
            "browser-download-failed",
          );
        expect(await opening).toBe(execution);
        await vi.advanceTimersByTimeAsync(5_000);
        execution.transferFailed(
          "initializing-download",
          "browser-download-failed",
        );
        execution.setNetworkAccess(true);
        expect(await execution.step()).toEqual({
          kind: "waiting",
          reason: "page",
        });
        expect(decide).not.toHaveBeenCalled();
        expect(execution.clock.snapshot()).toMatchObject({
          active: true,
          model_calls: 0,
          remaining_ms: 1_000,
        });
        if (completion === "ready" || completion === "immediate-failure") {
          await vi.advanceTimersByTimeAsync(200);
          pending.resolve(handle());
          await vi.advanceTimersByTimeAsync(0);
          expect(await execution.step()).toMatchObject({ kind: "terminal" });
          expect(decide).toHaveBeenCalledOnce();
          expect(execution.clock.snapshot()).toMatchObject({
            model_calls: 1,
            active_elapsed_ms: 200,
          });
        } else if (completion === "failed") {
          pending.resolve(
            Promise.reject(
              new BrowserArticleOpenError(
                "browser-collaboration-session-unavailable",
              ),
            ),
          );
          await vi.advanceTimersByTimeAsync(0);
          expect(await execution.step()).toMatchObject({
            kind: "terminal",
            result: {
              kind: "refused",
              code: "browser-collaboration-session-unavailable",
            },
          });
          expect(decide).not.toHaveBeenCalled();
        } else {
          await vi.advanceTimersByTimeAsync(1_000);
          expect(await execution.step()).toMatchObject({
            kind: "terminal",
            result: { kind: "refused", code: "browser-flow-budget-exhausted" },
          });
          expect(decide).not.toHaveBeenCalled();
        }
      } finally {
        pending.resolve(handle());
        await execution.close({ kind: "cancelled" });
        await vi.advanceTimersByTimeAsync(0);
        vi.useRealTimers();
      }
    },
  );
});
