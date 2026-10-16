import {
  latestBrowserObservationMessage,
  browserModelToolCallId,
} from "./browser-model-fixture.js";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  writeFile,
} from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  parseArtifactRef,
  parseLiterature,
  parseMetadataObservation,
  type WorkbenchObservation,
} from "@sciretriever/contracts";
import { expect, it, vi } from "vitest";
import { CandidateAcceptanceService } from "../src/acquisition/candidate-acceptance.js";
import {
  createApplication,
  createQueryApplication,
  type Application,
} from "../src/bootstrap/application.js";
import type {
  BrowserArticleCloseOutcome,
  BrowserArticleExecution,
} from "../src/browser/article-session.js";
import { verifyInstalledCloakRuntime } from "../src/configuration/cloak-runtime.js";
import { BrowserNetworkProxy } from "../src/network/browser-proxy.js";
import { NetworkBudgetCoordinator } from "../src/network/budget.js";
import { resolveBrowserDestination } from "../src/network/policy.js";
import { acquireFileLock } from "../src/storage/locking.js";
import { FileStore } from "../src/storage/files/store.js";
import { SqliteWorker } from "../src/storage/sqlite/worker.js";
import {
  FIXTURE_LITERATURE,
  workbenchPdf,
} from "../src/workbench/synthetic-fixture.js";

const readerFixture = vi.hoisted(() => ({
  enabled: false,
  children: [] as ChildProcess[],
  events: [] as {
    pid: number | null;
    started_at_ms: number;
    closed_at_ms: number | null;
    exit_code: number | null;
    signal: string | null;
  }[],
}));

// Only the PDF executable is synthetic. The production reader still owns its
// descriptor, abort listener, SIGKILL and awaited close event; PATH is untouched.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (
      command: string,
      args: readonly string[] = [],
      options: SpawnOptions = {},
    ) => {
      if (
        !readerFixture.enabled ||
        command !== "prlimit" ||
        !args.includes("pdfinfo")
      )
        return actual.spawn(command, args, options);
      const child = actual.spawn(
        process.execPath,
        ["-e", "setInterval(() => {}, 1000)"],
        options,
      );
      const event = {
        pid: child.pid ?? null,
        started_at_ms: performance.now(),
        closed_at_ms: null as number | null,
        exit_code: null as number | null,
        signal: null as string | null,
      };
      readerFixture.children.push(child);
      readerFixture.events.push(event);
      child.once("close", (code, signal) => {
        event.closed_at_ms = performance.now();
        event.exit_code = code;
        event.signal = signal;
      });
      return child;
    },
  };
});

it("cancels an Entry PDF reader before Application.close returns after a durable Browser handoff", async () => {
  const home = await mkdtemp(join(tmpdir(), "sciretriever-shutdown-reader-"));
  const evidenceDirectory = await mkdtemp(
    join(tmpdir(), "sciretriever-shutdown-reader-evidence-"),
  );
  const controller = new AbortController();
  let app: Application | undefined;
  let pending:
    | ReturnType<NonNullable<Application["databaseCompletion"]>["run"]>
    | undefined;
  let readerSignal: AbortSignal | undefined;
  let readerFailureCode: unknown;
  let closeRequestedAt: number | undefined;
  let closedAt: number | undefined;
  let readerSignalAbortedAtReturn: boolean | undefined;
  let readerClosedAtReturn: boolean | undefined;
  let retainedCandidateHash: string | undefined;
  let passed = false;
  readerFixture.children.length = 0;
  readerFixture.events.length = 0;
  const acceptance = CandidateAcceptanceService.prototype.accept;
  vi.spyOn(CandidateAcceptanceService.prototype, "accept").mockImplementation(
    async function (this: CandidateAcceptanceService, ...args) {
      readerSignal = args[1];
      try {
        return await acceptance.apply(this, args);
      } catch (error) {
        readerFailureCode =
          error instanceof Error &&
          error.cause instanceof Error &&
          "code" in error.cause
            ? error.cause.code
            : null;
        throw error;
      }
    },
  );
  try {
    await mkdir(join(home, ".sciretriever"), { mode: 0o700 });
    await writeFile(
      join(home, ".sciretriever", "config.toml"),
      '[browser]\nenabled = true\nprofile = "shutdown-reader-fixture"\n[sources.acquisition]\nmode = "custom"\nproviders = []\n',
      { mode: 0o600 },
    );
    app = await createApplication(home, {
      executionSchema: "upgrade-synthetic",
      browserAdmitNavigation: async (url) => url,
      browserHost: () => ({
        deliverCandidate: async () => {
          const candidate = await app!.execution!.transfers.recover(
            "shutdown-reader-transfer",
          );
          if (!candidate) throw new Error("fixture candidate is unavailable");
          return { kind: "delivered", candidate, accepted: true };
        },
        close: async () => undefined,
      }),
    });
    const literature = parseLiterature({
      ...FIXTURE_LITERATURE,
      metadata: { ...FIXTURE_LITERATURE.metadata, identifiers: [] },
    });
    await app.database.putLiterature(literature);
    await app.execution!.transfers.begin(
      "shutdown-reader-transfer",
      undefined,
      {
        session_id: "shutdown-reader-session",
        article_id: literature.literature_id,
        page_id: "shutdown-reader-page",
        document_generation: 1,
        source_url: "https://fixture.invalid/paper.pdf",
        captured_at: "2026-10-05T00:00:00Z",
      },
    );
    await app.execution!.transfers.append(
      "shutdown-reader-transfer",
      workbenchPdf(),
    );
    const candidate = await app.execution!.transfers.complete(
      "shutdown-reader-transfer",
    );
    readerFixture.enabled = true;
    pending = app.databaseCompletion!.run(
      {
        selector: {
          kind: "literatures",
          literature_ids: [literature.literature_id],
        },
        goal: "ASSET_READY",
      },
      { signal: controller.signal },
    );
    void pending.catch(() => undefined);
    await expect
      .poll(() => readerFixture.children.length, { timeout: 5000 })
      .toBe(1);
    expect(readerSignal?.aborted).toBe(false);
    expect(readerFixture.events[0]!.closed_at_ms).toBeNull();
    closeRequestedAt = performance.now();
    await app.close();
    closedAt = performance.now();
    readerSignalAbortedAtReturn = readerSignal?.aborted;
    readerClosedAtReturn = readerFixture.events[0]!.closed_at_ms !== null;
    expect(controller.signal.aborted).toBe(false);
    expect(readerSignal?.aborted).toBe(true);
    expect(readerFixture.events[0]!.signal).toBe("SIGKILL");
    expect(readerFixture.events[0]!.closed_at_ms).not.toBeNull();
    expect(readerFixture.events[0]!.closed_at_ms).toBeLessThanOrEqual(closedAt);
    expect(readerFailureCode).toBe("pdf-reader-cancelled");
    const report = await pending;
    expect(report.interrupted).toHaveLength(1);
    expect(report.failed).toEqual([]);
    const database = new SqliteWorker(join(home, "catalog.sqlite"), undefined, {
      readOnly: true,
    });
    const files = new FileStore(join(home, "artifacts"));
    try {
      expect(await database.getCandidate(candidate.transfer_id)).toEqual(
        candidate,
      );
      expect(
        (await database.currentFacts(literature.literature_id))!.primary_asset,
      ).toBeNull();
      expect(
        await database.hasAutomaticPdfExhaustion(literature.literature_id),
      ).toBe(false);
      retainedCandidateHash = await files.withVerified(
        candidate.reference,
        parseArtifactRef({
          sha256: candidate.sha256,
          byte_size: candidate.size_bytes,
          media_type: "application/pdf",
        }),
        async (chunks) => {
          const hash = createHash("sha256");
          for await (const chunk of chunks) hash.update(chunk);
          return hash.digest("hex");
        },
      );
      expect(retainedCandidateHash).toBe(candidate.sha256);
    } finally {
      await files.close();
      await database.close();
    }
    passed = true;
  } finally {
    // Cleanup is distinct from the tested Application.close boundary. A failing
    // regression can explicitly cancel its caller and still reap its own fixture.
    controller.abort();
    await pending?.catch(() => undefined);
    await app?.close();
    readerFixture.enabled = false;
    vi.restoreAllMocks();
    await writeFile(
      join(evidenceDirectory, "evidence.json"),
      JSON.stringify(
        {
          passed,
          close_requested_at_ms: closeRequestedAt,
          closed_at_ms: closedAt,
          close_duration_ms:
            closedAt !== undefined && closeRequestedAt !== undefined
              ? closedAt - closeRequestedAt
              : null,
          reader_failure_code: readerFailureCode,
          reader_signal_aborted_at_return: readerSignalAbortedAtReturn,
          reader_closed_at_return: readerClosedAtReturn,
          retained_candidate_sha256: retainedCandidateHash,
          reader_events: readerFixture.events,
          resources: app?.execution?.transfers.resources.snapshot(),
        },
        null,
        2,
      ),
    );
    await rm(home, { recursive: true, force: true });
    process.stdout.write(`Shutdown reader evidence: ${evidenceDirectory}\n`);
  }
}, 30_000);

interface OwnedProcess {
  readonly pid: number;
  readonly name: string;
  readonly started: string;
  readonly state: string;
}

function vanished(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ESRCH")
  );
}

// Inspect numeric process ownership and lifetime only, never command line or env.
async function processIdentity(pid: number): Promise<OwnedProcess | null> {
  try {
    const [status, stat] = await Promise.all([
      readFile(`/proc/${pid}/status`, "utf8"),
      readFile(`/proc/${pid}/stat`, "utf8"),
    ]);
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return {
      pid,
      name: /^Name:\s+(.+)$/mu.exec(status)![1]!,
      started: fields[19]!,
      state: fields[0]!,
    };
  } catch (error) {
    if (vanished(error)) return null;
    throw error;
  }
}

async function descendants(): Promise<OwnedProcess[]> {
  const pending = [process.pid];
  const seen = new Set<number>();
  const result: OwnedProcess[] = [];
  for (let index = 0; index < pending.length; index++) {
    const pid = pending[index]!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    const identity = await processIdentity(pid);
    if (!identity) continue;
    if (pid !== process.pid) result.push(identity);
    try {
      for (const task of await readdir(`/proc/${pid}/task`)) {
        try {
          const children = await readFile(
            `/proc/${pid}/task/${task}/children`,
            "utf8",
          );
          for (const child of children.trim().split(/\s+/u))
            if (/^\d+$/u.test(child)) pending.push(Number(child));
        } catch (error) {
          if (!vanished(error)) throw error;
        }
      }
    } catch (error) {
      if (!vanished(error)) throw error;
    }
  }
  return result;
}

async function stillRunning(identity: OwnedProcess): Promise<boolean> {
  const current = await processIdentity(identity.pid);
  return Boolean(
    current &&
      current.started === identity.started &&
      !["Z", "X"].includes(current.state),
  );
}

it.runIf(!!process.env.SCIRETRIEVER_CLOAK_BUNDLE)(
  "closes the production Browser during native writing, model HTTP and WaitForChange without changing a published PDF",
  async () => {
    const home = await mkdtemp(
      join(tmpdir(), "sciretriever-shutdown-production-"),
    );
    const evidenceDirectory = await mkdtemp(
      join(tmpdir(), "sciretriever-shutdown-production-evidence-"),
    );
    const controller = new AbortController();
    const baseline = new Set(
      (await descendants()).map(
        (identity) => `${identity.pid}:${identity.started}`,
      ),
    );
    let releaseModel!: () => void;
    const modelGate = new Promise<void>((resolve) => {
      releaseModel = resolve;
    });
    const papers = (["published", "slow", "waiting", "model"] as const).map(
      (name, index) => ({
        name,
        literature: parseLiterature({
          ...FIXTURE_LITERATURE,
          literature_id: `00000000-0000-0000-0000-00000000990${index}`,
          meta_literature_id: `10000000-0000-0000-0000-00000000990${index}`,
          metadata: {
            ...FIXTURE_LITERATURE.metadata,
            title: `Shutdown article ${name}`,
            identifiers: [
              { namespace: "doi", value: `10.1000/shutdown-${name}` },
            ],
          },
        }),
        bytes: workbenchPdf(`10.1000/shutdown-${name}`, "published"),
      }),
    );
    const fixtureFailures: { boundary: string; name: string }[] = [];
    const slowWriter = {
      started_at_ms: null as number | null,
      closed_at_ms: null as number | null,
      eof_at_ms: null as number | null,
      written_bytes: 0,
    };
    const pumps = new Set<Promise<void>>();
    const pump = async (response: ServerResponse, first: Uint8Array) => {
      const sourceStop = new AbortController();
      const { signal } = sourceStop;
      slowWriter.started_at_ms = performance.now();
      response.once("close", () => {
        slowWriter.closed_at_ms = performance.now();
        sourceStop.abort();
      });
      response.writeHead(200, {
        "content-type": "application/pdf",
        "content-disposition": "attachment; filename=slow.pdf",
        "content-length": 64 * 1024 * 1024,
      });
      try {
        const chunk = Buffer.alloc(32 * 1024, 0x20);
        for (let index = 0; index < 2048; index++) {
          if (signal.aborted) return;
          const bytes = index === 0 ? first : chunk;
          slowWriter.written_bytes += bytes.byteLength;
          if (!response.write(bytes)) await once(response, "drain", { signal });
          await delay(100, undefined, { signal });
        }
        slowWriter.eof_at_ms = performance.now();
        response.end();
      } catch (error) {
        if (!signal.aborted) {
          fixtureFailures.push({
            boundary: "origin",
            name: error instanceof Error ? error.name : "unknown",
          });
          response.destroy();
        }
      }
    };
    const origin = createServer((request, response) => {
      const host = (request.headers.host ?? "").split(":")[0]!;
      const paper = papers.find(
        (item) => host === `${item.name}-publisher.test`,
      );
      if (paper && request.url === "/article") {
        response.writeHead(200, { "content-type": "text/html" });
        response.end(
          `<title>${paper.literature.metadata.title}</title><main><h1>${paper.literature.metadata.title}</h1><a href="/paper.pdf" download>Download PDF</a></main>`,
        );
      } else if (paper && request.url === "/paper.pdf") {
        if (paper.name === "slow") {
          const operation = pump(response, paper.bytes);
          pumps.add(operation);
          void operation.finally(() => pumps.delete(operation));
        } else {
          response.writeHead(200, {
            "content-type": "application/pdf",
            "content-disposition": "attachment; filename=article.pdf",
          });
          response.end(paper.bytes);
        }
      } else {
        response.writeHead(404);
        response.end();
      }
    });
    origin.listen(0, "127.0.0.1");
    await once(origin, "listening");
    const port = (origin.address() as AddressInfo).port;
    const calls: {
      article: string;
      started_at_ms: number;
      ended_at_ms: number | null;
      closed_at_ms: number | null;
    }[] = [];
    const handleModel = async (
      request: IncomingMessage,
      response: ServerResponse,
    ) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request)
        chunks.push(Buffer.from(chunk as Uint8Array));
      const wire = JSON.parse(Buffer.concat(chunks).toString()) as {
        messages: { content: { type: string; text?: string }[] }[];
      };
      const observation = JSON.parse(
        latestBrowserObservationMessage(wire).content.find(
          (part) => part.type === "text",
        )!.text!,
      ) as WorkbenchObservation;
      const paper = papers.find(
        (item) => item.literature.literature_id === observation.article_id,
      )!;
      const call = {
        article: paper.name,
        started_at_ms: performance.now(),
        ended_at_ms: null as number | null,
        closed_at_ms: null as number | null,
      };
      calls.push(call);
      response.once("close", () => {
        call.closed_at_ms = performance.now();
      });
      if (paper.name === "model") await modelGate;
      if (response.destroyed) return;
      const pdf = observation.elements.find(
        (element) => element.name === "Download PDF",
      )!;
      const action =
        paper.name === "published" || paper.name === "slow"
          ? {
              kind: "click-element",
              element_id: pdf.element_id,
              revision: observation.observation_revision,
            }
          : {
              kind: "wait-for-change",
              timeout_ms: 120_000,
              revision: observation.observation_revision,
            };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          model: "browser",
          choices: [
            {
              finish_reason: "tool_calls",
              message: {
                tool_calls: [
                  {
                    id: browserModelToolCallId(),
                    type: "function",
                    function: {
                      name: "browser_action",
                      arguments: JSON.stringify({ action }),
                    },
                  },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
      );
      call.ended_at_ms = performance.now();
    };
    const model = createServer((request, response) => {
      void handleModel(request, response).catch((error: unknown) => {
        fixtureFailures.push({
          boundary: "model",
          name: error instanceof Error ? error.name : "unknown",
        });
        response.destroy();
      });
    });
    model.listen(0, "127.0.0.1");
    await once(model, "listening");
    const modelPort = (model.address() as AddressInfo).port;
    const resolver = () => ["127.0.0.1"];
    const policy = {
      allowed_schemes: ["http"] as const,
      allowed_classes: ["loopback"] as const,
      allowed_addresses: ["127.0.0.1"],
      allowed_ports: [{ scheme: "http" as const, port }],
    };
    const budget = new NetworkBudgetCoordinator();
    const proxy = new BrowserNetworkProxy({
      resolver,
      policy,
      coordinator: budget,
      limits: {
        maxConcurrency: 8,
        maxHostConcurrency: 8,
        maxResponseBytes: 64 * 1024 * 1024,
        maxRedirects: 0,
        maxRetries: 0,
      },
    });
    const runtime = await verifyInstalledCloakRuntime(
      process.env.SCIRETRIEVER_CLOAK_BUNDLE!,
    );
    const executions = new Map<string, BrowserArticleExecution>();
    const removed: {
      session_id: string;
      outcome: BrowserArticleCloseOutcome;
    }[] = [];
    const nativeProgress: {
      transfer_id: string;
      received_bytes: number;
      at_ms: number;
    }[] = [];
    const nativeDirectories = new Set<string>();
    let ownedProcesses: OwnedProcess[] = [];
    let chromePid: number | undefined;
    let app: Application | undefined;
    let pending:
      | ReturnType<NonNullable<Application["databaseCompletion"]>["run"]>
      | undefined;
    let report: Awaited<NonNullable<typeof pending>> | undefined;
    let closeRequestedAt: number | undefined;
    let closedAt: number | undefined;
    let stoppedBytes: number | undefined;
    let runningAtReturn: number[] | undefined;
    let passed = false;
    try {
      await mkdir(join(home, ".sciretriever"), { mode: 0o700 });
      await writeFile(
        join(home, ".sciretriever", "config.toml"),
        `[providers.fixture]\napi = "openai-chat-completions"\nbase_url = "http://127.0.0.1:${modelPort}/v1"\n[models."fixture/browser"]\nimage = true\nstream = false\n[browser]\nenabled = true\nmodel = "fixture/browser"\nprofile = "shutdown-fixture"\n[sources.acquisition]\nmode = "custom"\nproviders = []\n`,
        { mode: 0o600 },
      );
      app = await createApplication(home, {
        executionSchema: "upgrade-synthetic",
        browserRuntime: runtime,
        browserProxy: await proxy.start(),
        browserAdmitNavigation: async (url) =>
          (await resolveBrowserDestination(url, resolver, policy)).url.url,
        acquisitionAssembly: {
          doiLandingSource: {
            source_name: "doi-landing",
            ready: true,
            discover: async () => [],
          },
        },
        browserCollaboration: {
          registered: (execution) => {
            executions.set(execution.identity.literature_id, execution);
          },
          removed: (sessionId, outcome) => {
            removed.push({ session_id: sessionId, outcome });
          },
          open: async () => ({
            step: async () => {
              throw new Error(
                "production must use its normal decision runtime",
              );
            },
            automatic: {
              canDecide: () => true,
              controlEpoch: () => 0,
              guidance: () => [],
            },
            close: async () => undefined,
          }),
          captured: () => undefined,
        },
      });
      const resources = app.execution!.transfers.resources;
      const updateNative = resources.updateNative.bind(resources);
      vi.spyOn(resources, "updateNative").mockImplementation(
        async (transferId, directory, bytes) => {
          nativeDirectories.add(directory);
          nativeProgress.push({
            transfer_id: transferId,
            received_bytes: bytes,
            at_ms: performance.now(),
          });
          await updateNative(transferId, directory, bytes);
        },
      );
      for (const [index, paper] of papers.entries()) {
        await app.database.putLiterature(paper.literature);
        await app.observations.publish({
          ...parseMetadataObservation({
            observation_id: `00000000-0000-0000-0000-00000001000${index}`,
            provenance: {
              provenance_id: `00000000-0000-0000-0000-00000001010${index}`,
              source_kind: "metadata-provider",
              source_name: "fixture",
              source_record_id: paper.name,
              observed_at: "2026-10-05T00:00:00Z",
              input_sha256: "a".repeat(64),
              parameters_sha256: null,
            },
            metadata: paper.literature.metadata,
            version_role: "published",
            version_links: [],
            asset_hints: [
              {
                url: `http://${paper.name}-publisher.test:${port}/article`,
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
          literature_id: paper.literature.literature_id,
        });
      }
      const publishedReport = await app.databaseCompletion!.run({
        selector: {
          kind: "literatures",
          literature_ids: [papers[0]!.literature.literature_id],
        },
        goal: "ASSET_READY",
      });
      expect(publishedReport.completed).toHaveLength(1);
      const publishedBefore = (
        await app.library.detail(papers[0]!.literature.literature_id)
      ).primary_pdf!;
      pending = app.databaseCompletion!.run(
        {
          selector: {
            kind: "literatures",
            literature_ids: papers
              .slice(1)
              .map((paper) => paper.literature.literature_id),
          },
          goal: "ASSET_READY",
        },
        { signal: controller.signal },
      );
      void pending.catch(() => undefined);
      await expect
        .poll(() => slowWriter.written_bytes, { timeout: 30_000 })
        .toBeGreaterThan(128 * 1024);
      await expect
        .poll(
          () => executions.get(papers[2]!.literature.literature_id)?.phase(),
          { timeout: 30_000 },
        )
        .toBe("waiting");
      await expect
        .poll(() => calls.some((call) => call.article === "model"), {
          timeout: 30_000,
        })
        .toBe(true);
      expect(executions.get(papers[1]!.literature.literature_id)?.phase()).toBe(
        "downloading",
      );
      expect(executions.get(papers[3]!.literature.literature_id)?.phase()).toBe(
        "deciding",
      );
      expect(
        calls.find((call) => call.article === "model")?.ended_at_ms,
      ).toBeNull();
      expect(slowWriter.eof_at_ms).toBeNull();
      expect(slowWriter.closed_at_ms).toBeNull();
      await expect
        .poll(() => resources.snapshot().temporary_bytes, { timeout: 5000 })
        .toBeGreaterThan(0);
      expect(nativeProgress.some((event) => event.received_bytes > 0)).toBe(
        true,
      );
      const singleton = await readlink(join(home, "profile", "SingletonLock"));
      chromePid = Number(/-(\d+)$/u.exec(singleton)![1]);
      ownedProcesses = (await descendants()).filter(
        (identity) => !baseline.has(`${identity.pid}:${identity.started}`),
      );
      expect(
        ownedProcesses.some((identity) => identity.pid === chromePid),
      ).toBe(true);
      expect(ownedProcesses.some((identity) => identity.name === "Xvfb")).toBe(
        true,
      );
      closeRequestedAt = performance.now();
      await app.close();
      closedAt = performance.now();
      runningAtReturn = (
        await Promise.all(
          ownedProcesses.map(async (identity) =>
            (await stillRunning(identity)) ? identity.pid : null,
          ),
        )
      ).filter((pid): pid is number => pid !== null);
      expect(runningAtReturn).toEqual([]);
      expect(controller.signal.aborted).toBe(false);
      await expect
        .poll(() => slowWriter.closed_at_ms, { timeout: 5000 })
        .not.toBeNull();
      stoppedBytes = slowWriter.written_bytes;
      await delay(200);
      expect(slowWriter.written_bytes).toBe(stoppedBytes);
      expect(slowWriter.eof_at_ms).toBeNull();
      await expect
        .poll(
          () => calls.find((call) => call.article === "model")?.closed_at_ms,
          {
            timeout: 5000,
          },
        )
        .not.toBeNull();
      expect(
        calls.filter((call) => call.started_at_ms > closeRequestedAt!),
      ).toEqual([]);
      expect(resources.snapshot().temporary_bytes).toBe(0);
      expect(
        [...executions.values()].map((execution) => execution.phase()),
      ).toEqual(["closed", "closed", "closed", "closed"]);
      expect(removed).toHaveLength(4);
      await expect
        .poll(
          async () =>
            (await Promise.all(ownedProcesses.map(stillRunning))).filter(
              Boolean,
            ).length,
          { timeout: 5000 },
        )
        .toBe(0);
      for (const directory of nativeDirectories)
        await expect(readdir(directory)).rejects.toMatchObject({
          code: "ENOENT",
        });
      await expect(
        readlink(join(home, "profile", "SingletonLock")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      const profileLock = await acquireFileLock(
        join(home, "profile"),
        "browser-profile",
      );
      await profileLock.release();
      report = await pending;
      expect(report.completed).toEqual([]);
      expect(report.failed).toEqual([]);
      expect(report.interrupted).toHaveLength(3);
      const query = await createQueryApplication(home);
      try {
        expect(query.readiness.status).toBe("ready");
        const detail = await query.query!.detail(
          papers[0]!.literature.literature_id,
        );
        expect(detail.primary_pdf).toEqual(publishedBefore);
        const hash = await query.literatureArtifacts!.withArtifact(
          detail.primary_pdf!.asset,
          async (chunks) => {
            const value = createHash("sha256");
            for await (const chunk of chunks) value.update(chunk);
            return value.digest("hex");
          },
        );
        expect(hash).toBe(
          createHash("sha256").update(papers[0]!.bytes).digest("hex"),
        );
        for (const paper of papers.slice(1))
          expect(
            (await query.query!.detail(paper.literature.literature_id))
              .primary_pdf,
          ).toBeNull();
      } finally {
        await query.close();
      }
      expect(fixtureFailures).toEqual([]);
      passed = true;
    } finally {
      controller.abort();
      releaseModel();
      await app?.close();
      await pending?.catch(() => undefined);
      vi.restoreAllMocks();
      await proxy.close();
      budget.close();
      origin.closeAllConnections();
      model.closeAllConnections();
      await Promise.all([
        new Promise<void>((resolve) => origin.close(() => resolve())),
        new Promise<void>((resolve) => model.close(() => resolve())),
      ]);
      await Promise.allSettled([...pumps]);
      await writeFile(
        join(evidenceDirectory, "evidence.json"),
        JSON.stringify(
          {
            passed,
            cloak_version: runtime.version,
            close_requested_at_ms: closeRequestedAt,
            closed_at_ms: closedAt,
            close_duration_ms:
              closedAt !== undefined && closeRequestedAt !== undefined
                ? closedAt - closeRequestedAt
                : null,
            slow_writer: slowWriter,
            stopped_writer_bytes: stoppedBytes,
            model_calls: calls,
            native_progress: nativeProgress,
            removed,
            owned_processes: ownedProcesses,
            processes_running_at_return: runningAtReturn,
            chrome_pid: chromePid,
            resources: app?.execution?.transfers.resources.snapshot(),
            report,
            fixture_failures: fixtureFailures,
          },
          null,
          2,
        ),
      );
      await rm(home, { recursive: true, force: true });
      process.stdout.write(`Shutdown Browser evidence: ${evidenceDirectory}\n`);
    }
  },
  90_000,
);
