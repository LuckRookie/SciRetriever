import {
  latestBrowserObservationMessage,
  browserModelToolCallId,
} from "./browser-model-fixture.js";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createReadStream } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  parseLiteratureId,
  parseMetadataObservation,
  type WorkbenchObservation,
} from "@sciretriever/contracts";
import { describe, expect, it, vi } from "vitest";
import * as pdfAcceptance from "../src/acquisition/pdf-acceptance.js";
import {
  createApplication,
  type Application,
} from "../src/bootstrap/application.js";
import { verifyInstalledCloakRuntime } from "../src/configuration/cloak-runtime.js";
import { exportArtifact } from "../src/entry/artifact-export.js";
import { BrowserNetworkProxy } from "../src/network/browser-proxy.js";
import { NetworkBudgetCoordinator } from "../src/network/budget.js";
import { resolveBrowserDestination } from "../src/network/policy.js";
import { FIXTURE_LITERATURE } from "../src/workbench/synthetic-fixture.js";

const MIB = 1024 * 1024;
type Scenario = "slow" | "interrupt-recover" | "cancel" | "fetch";
const sampleCases: [Scenario, number][] = [
  ["slow", 17],
  ["interrupt-recover", 17],
  ["cancel", 17],
  ["fetch", 17],
];
// The complete 513 MiB Browser sample is an explicit live-matrix run, outside ordinary Full.
if (process.env.SCIRETRIEVER_BROWSER_513_MIB === "1")
  sampleCases.push(["slow", 513]);

/** Generate every byte of a valid one-page PDF, including an unused uncompressed stream. */
async function* pdfChunks(mib: number): AsyncIterable<Buffer> {
  const streamBytes = mib * MIB;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 10 10] >>",
  ];
  let head = "%PDF-1.7\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(head));
    head += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  offsets.push(Buffer.byteLength(head));
  head += `4 0 obj\n<< /Length ${streamBytes} >>\nstream\n`;
  const end = "\nendstream\nendobj\n";
  const xref = Buffer.byteLength(head) + streamBytes + Buffer.byteLength(end);
  yield Buffer.from(head);
  const chunk = Buffer.alloc(MIB, 0x61);
  for (let offset = 0; offset < streamBytes; offset += chunk.length)
    yield chunk;
  yield Buffer.from(
    `${end}xref\n0 5\n0000000000 65535 f \n${offsets
      .slice(1)
      .map((offset) => `${String(offset).padStart(10, "0")} 00000 n `)
      .join(
        "\n",
      )}\ntrailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`,
  );
}

interface SourceTransfer {
  readonly path: string;
  readonly started_ms: number;
  written_bytes: number;
  finished_ms: number | null;
  closed_ms: number | null;
  interrupted: boolean;
  readonly session_header_preserved: boolean;
}

async function startFixture(scenario: Scenario, mib: number) {
  const transfers: SourceTransfer[] = [];
  const requests: string[] = [];
  const operations = new Set<Promise<void>>();
  const failures: unknown[] = [];
  const pump = async (
    response: ServerResponse,
    transfer: SourceTransfer,
  ): Promise<void> => {
    const controller = new AbortController();
    const signal = controller.signal;
    response.once("finish", () => {
      transfer.finished_ms = performance.now();
    });
    response.once("close", () => {
      transfer.closed_ms = performance.now();
      controller.abort();
    });
    response.writeHead(200, {
      "content-type": "application/pdf",
      "content-disposition": "attachment; filename=generated.pdf",
      // Deliberately omit Content-Length. Every write obeys HTTP backpressure.
    });
    try {
      let index = 0;
      for await (const chunk of pdfChunks(mib)) {
        if (signal.aborted) return;
        if (index > 0 && index <= mib) {
          await delay(
            scenario === "slow" || scenario === "fetch"
              ? Math.ceil(30_600 / mib)
              : 250,
            undefined,
            { signal },
          );
          if (
            (scenario === "slow" || scenario === "fetch") &&
            index === Math.floor(mib / 2)
          )
            await delay(4000, undefined, { signal });
        }
        if (signal.aborted) return;
        transfer.written_bytes += chunk.length;
        if (!response.write(chunk)) await once(response, "drain", { signal });
        index++;
        if (transfer.path === "/interrupted.pdf" && index === 4) {
          // Stop a real source connection after several native progress events.
          await delay(750, undefined, { signal });
          transfer.interrupted = true;
          response.destroy();
          return;
        }
      }
      response.end();
    } catch (error) {
      if (!signal.aborted) {
        failures.push(error);
        response.destroy();
      }
    }
  };
  const server = createServer((request, response) => {
    requests.push(request.url ?? "");
    if (request.url === "/article") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(
        `<title>Generated large PDF article</title><main><h1>Generated large PDF article</h1>${
          scenario === "interrupt-recover"
            ? '<a href="/interrupted.pdf" download>Interrupted PDF</a><br><a href="/download.pdf" download>Recover PDF</a>'
            : scenario === "fetch"
              ? "<button onclick=\"fetch('/download.pdf', {headers: {'x-fixture-session': 'synthetic'}}).then(response => response.text()).catch(() => {})\">Download PDF</button>"
              : '<a href="/download.pdf" download>Download PDF</a>'
        }</main>`,
      );
      return;
    }
    if (request.url !== "/download.pdf" && request.url !== "/interrupted.pdf") {
      response.writeHead(404);
      response.end();
      return;
    }
    const transfer: SourceTransfer = {
      path: request.url,
      started_ms: performance.now(),
      written_bytes: 0,
      finished_ms: null,
      closed_ms: null,
      interrupted: false,
      session_header_preserved:
        request.headers["x-fixture-session"] === "synthetic",
    };
    transfers.push(transfer);
    const operation = pump(response, transfer);
    operations.add(operation);
    void operation.finally(() => operations.delete(operation));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    port: address.port,
    transfers,
    requests,
    failures,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await Promise.all(operations);
    },
  };
}

function vanished(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ESRCH")
  );
}

/** Read only numeric process relationships and RSS, never command lines or environments. */
async function processTreeRss(): Promise<{ rss: number; descendants: number }> {
  const pending = [process.pid];
  const seen = new Set<number>();
  let rss = 0;
  for (let index = 0; index < pending.length; index++) {
    const pid = pending[index]!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    try {
      const status = await readFile(`/proc/${pid}/status`, "utf8");
      rss += Number(/^VmRSS:\s+(\d+)\s+kB$/mu.exec(status)?.[1] ?? 0) * 1024;
      const tasks = await readdir(`/proc/${pid}/task`);
      for (const task of tasks) {
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
  return { rss, descendants: Math.max(0, seen.size - 1) };
}

/** Only fixture-owned directories are traversed; symlinks are never followed. */
async function fileSizes(
  directory: string,
  include: (path: string) => boolean,
): Promise<{ logical: number; allocated: number }> {
  let logical = 0;
  let allocated = 0;
  try {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        const nested = await fileSizes(path, include);
        logical += nested.logical;
        allocated += nested.allocated;
      } else if (entry.isFile() && include(path)) {
        try {
          const status = await lstat(path);
          if (status.isFile()) {
            logical += status.size;
            allocated += status.blocks * 512;
          }
        } catch (error) {
          if (!vanished(error)) throw error;
        }
      }
    }
  } catch (error) {
    if (!vanished(error)) throw error;
  }
  return { logical, allocated };
}

async function startSamples(app: Application, nativeDirectories: Set<string>) {
  const initial = await processTreeRss();
  const measurements = {
    sample_interval_ms: 100,
    sample_count: 0,
    node_rss_initial: process.memoryUsage().rss,
    node_rss_sampled_peak: process.memoryUsage().rss,
    process_tree_rss_initial: initial.rss,
    process_tree_rss_sampled_peak: initial.rss,
    peak_descendant_count: initial.descendants,
    temporary_logical_sampled_peak: 0,
    temporary_allocated_sampled_peak: 0,
  };
  let running: Promise<void> | undefined;
  let failure: unknown;
  const sample = async () => {
    const tree = await processTreeRss();
    measurements.node_rss_sampled_peak = Math.max(
      measurements.node_rss_sampled_peak,
      process.memoryUsage().rss,
    );
    measurements.process_tree_rss_sampled_peak = Math.max(
      measurements.process_tree_rss_sampled_peak,
      tree.rss,
    );
    measurements.peak_descendant_count = Math.max(
      measurements.peak_descendant_count,
      tree.descendants,
    );
    const native = await Promise.all(
      [...nativeDirectories].map((directory) =>
        fileSizes(directory, () => true),
      ),
    );
    const storage = await fileSizes(
      app.files.root,
      (path) =>
        path.includes("/.staging/") ||
        /\/.sciretriever-publication-[^/]+$/u.test(path),
    );
    const logical = native.reduce((sum, item) => sum + item.logical, 0);
    const allocated = native.reduce((sum, item) => sum + item.allocated, 0);
    measurements.temporary_logical_sampled_peak = Math.max(
      measurements.temporary_logical_sampled_peak,
      logical + storage.logical,
    );
    measurements.temporary_allocated_sampled_peak = Math.max(
      measurements.temporary_allocated_sampled_peak,
      allocated + storage.allocated,
    );
    measurements.sample_count++;
  };
  await sample();
  const timer = setInterval(() => {
    if (running) return;
    running = sample()
      .catch((error: unknown) => {
        failure = error;
      })
      .finally(() => {
        running = undefined;
      });
  }, measurements.sample_interval_ms);
  return {
    measurements,
    stop: async () => {
      clearInterval(timer);
      await running;
      if (failure !== undefined) throw failure;
      await sample();
    },
  };
}

describe.runIf(!!process.env.SCIRETRIEVER_CLOAK_BUNDLE)(
  "large PDF through production Cloak, shared resources and formal Completion",
  () => {
    it.each(sampleCases)(
      "handles the unknown-length %s %i MiB sample with bounded file handoff",
      async (scenario, mib) => {
        const home = await mkdtemp(
          join(tmpdir(), "sciretriever-large-browser-production-"),
        );
        const evidenceDirectory = await mkdtemp(
          join(tmpdir(), "sciretriever-large-browser-evidence-"),
        );
        const runtime = await verifyInstalledCloakRuntime(
          process.env.SCIRETRIEVER_CLOAK_BUNDLE!,
        );
        const fixture = await startFixture(scenario, mib);
        const budget = new NetworkBudgetCoordinator();
        const resolver = () => ["127.0.0.1"];
        const policy = {
          allowed_schemes: ["http"] as const,
          allowed_classes: ["loopback"] as const,
          allowed_addresses: ["127.0.0.1"],
          allowed_ports: [{ scheme: "http" as const, port: fixture.port }],
        };
        const proxy = new BrowserNetworkProxy({
          resolver,
          policy,
          coordinator: budget,
          limits: {
            maxConcurrency: 4,
            maxHostConcurrency: 4,
            maxResponseBytes: Math.max(64, mib + 1) * MIB,
            maxRedirects: 0,
            maxRetries: 0,
          },
        });
        const controller = new AbortController();
        const nativeDirectories = new Set<string>();
        const progress: {
          transfer_id: string;
          received_bytes: number;
          at: number;
        }[] = [];
        const intakeChunks: { byte_size: number; at: number }[] = [];
        const calls: {
          session_id: string;
          article_id: string;
          link: string;
          at: number;
        }[] = [];
        const readerChecks: { started_ms: number; elapsed_ms: number }[] = [];
        const acceptPdfFile = pdfAcceptance.acceptPdfFile;
        const reader = vi
          .spyOn(pdfAcceptance, "acceptPdfFile")
          .mockImplementation(async (...args) => {
            const at = performance.now();
            try {
              return await acceptPdfFile(...args);
            } finally {
              readerChecks.push({
                started_ms: at,
                elapsed_ms: performance.now() - at,
              });
            }
          });
        let app: Application | undefined;
        let pending:
          | ReturnType<NonNullable<Application["databaseCompletion"]>["run"]>
          | undefined;
        let samples: Awaited<ReturnType<typeof startSamples>> | undefined;
        let report: Awaited<NonNullable<typeof pending>> | undefined;
        let passed = false;
        const started = performance.now();
        const inputHash = createHash("sha256");
        let inputSize = 0;
        for await (const chunk of pdfChunks(mib)) {
          inputHash.update(chunk);
          inputSize += chunk.length;
        }
        const expectedHash = inputHash.digest("hex");
        try {
          await mkdir(join(home, ".sciretriever"), { mode: 0o700 });
          await writeFile(
            join(home, ".sciretriever", "config.toml"),
            '[providers.fixture]\napi = "openai-chat-completions"\nbase_url = "http://127.0.0.1:9/v1"\n[models."fixture/browser-model"]\nimage = true\nstream = false\n[browser]\nenabled = true\nmodel = "fixture/browser-model"\nprofile = "synthetic"\n[sources.acquisition]\nmode = "custom"\nproviders = []\n',
            { mode: 0o600 },
          );
          app = await createApplication(home, {
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
            agentTransportFactory:
              () =>
              async ({ body, onDispatched }) => {
                onDispatched?.();
                const wire = JSON.parse(new TextDecoder().decode(body)) as {
                  messages: { content: { type: string; text?: string }[] }[];
                };
                const text = latestBrowserObservationMessage(wire).content.find(
                  (part) => part.type === "text",
                )?.text;
                if (!text) throw new Error("observation unavailable");
                const observation = JSON.parse(text) as WorkbenchObservation;
                const link =
                  scenario === "interrupt-recover"
                    ? fixture.transfers.length === 0
                      ? "Interrupted PDF"
                      : "Recover PDF"
                    : "Download PDF";
                const target = observation.elements.find(
                  (element) => element.name === link,
                );
                calls.push({
                  session_id: observation.session_id,
                  article_id: observation.article_id,
                  link,
                  at: performance.now(),
                });
                const action = target
                  ? {
                      kind: "click-element",
                      element_id: target.element_id,
                      revision: observation.observation_revision,
                    }
                  : { kind: "stop", reason: "budget" };
                return {
                  status: 200,
                  headers: [],
                  body: Buffer.from(
                    JSON.stringify({
                      model: "browser-model",
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
                  ),
                };
              },
          });
          const resources = app.execution!.transfers.resources;
          const collector = app.execution!.transfers;
          const append = collector.append.bind(collector);
          vi.spyOn(collector, "append").mockImplementation(
            async (transferId, bytes) => {
              intakeChunks.push({
                byte_size: bytes.length,
                at: performance.now(),
              });
              return append(transferId, bytes);
            },
          );
          const updateNative = resources.updateNative.bind(resources);
          vi.spyOn(resources, "updateNative").mockImplementation(
            async (transferId, directory, bytes) => {
              nativeDirectories.add(directory);
              progress.push({
                transfer_id: transferId,
                received_bytes: bytes,
                at: performance.now(),
              });
              await updateNative(transferId, directory, bytes);
            },
          );
          const receipts = vi.spyOn(app.database, "prepareReceipt");
          await app.database.putLiterature(FIXTURE_LITERATURE);
          await app.observations.publish({
            ...parseMetadataObservation({
              source_type: null,
              source_type_mapping_version: null,
              observation_id: "00000000-0000-0000-0000-000000000111",
              provenance: {
                provenance_id: "00000000-0000-0000-0000-000000000112",
                source_kind: "metadata-provider",
                source_name: "fixture",
                source_record_id: "generated-large-article",
                observed_at: "2026-10-05T00:00:00Z",
                input_sha256: "a".repeat(64),
                parameters_sha256: null,
              },
              metadata: FIXTURE_LITERATURE.metadata,
              version_role: "published",
              version_links: [],
              asset_hints: [
                {
                  url: `${fixture.origin}/article`,
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
            literature_id: FIXTURE_LITERATURE.literature_id,
          });
          samples = await startSamples(app, nativeDirectories);
          pending = app.databaseCompletion!.run(
            {
              selector: {
                kind: "literatures",
                literature_ids: [
                  parseLiteratureId(FIXTURE_LITERATURE.literature_id),
                ],
              },
              goal: "ASSET_READY",
            },
            { signal: controller.signal },
          );
          void pending.catch(() => undefined);
          if (scenario === "cancel") {
            await expect
              .poll(() => resources.snapshot().native_bytes, {
                timeout: 30_000,
              })
              .toBeGreaterThan(0);
            expect(fixture.transfers[0]?.finished_ms).toBeNull();
            controller.abort();
          }
          report = await pending;
          await expect
            .poll(() => resources.snapshot().temporary_bytes, {
              timeout: 20_000,
            })
            .toBe(0);
          const id = FIXTURE_LITERATURE.literature_id;
          const facts = (await app.database.currentFacts(id))!;
          const candidates = await app.database.listCandidates(id);
          expect(await app.database.hasAutomaticPdfExhaustion(id)).toBe(false);
          if (scenario === "cancel") {
            expect(report.completed).toEqual([]);
            expect(report.interrupted).toHaveLength(1);
            expect(facts.primary_asset).toBeNull();
            expect(candidates).toEqual([]);
            expect(receipts).not.toHaveBeenCalled();
            expect(readerChecks).toEqual([]);
            await expect
              .poll(() => fixture.transfers[0]?.closed_ms, { timeout: 20_000 })
              .not.toBeNull();
            const partial = fixture.transfers[0]!;
            expect(partial.finished_ms).toBeNull();
            expect(partial.written_bytes).toBeGreaterThan(0);
            expect(partial.written_bytes).toBeLessThan(inputSize);
            const stoppedAt = partial.written_bytes;
            await delay(600);
            expect(partial.written_bytes).toBe(stoppedAt);
          } else {
            expect(report.completed, JSON.stringify(report)).toHaveLength(1);
            expect(facts.primary_asset).toMatchObject({
              sha256: expectedHash,
              size_bytes: inputSize,
            });
            expect(candidates).toHaveLength(1);
            expect(candidates[0]).toMatchObject({
              sha256: expectedHash,
              size_bytes: inputSize,
              capture: { session_id: calls[0]!.session_id, article_id: id },
            });
            expect(
              await app.execution!.transfers.recover(
                candidates[0]!.transfer_id,
              ),
            ).toEqual(candidates[0]);
            for (const [intent] of receipts.mock.calls) {
              expect(
                await app.database.getReceiptResult(intent.receipt_id),
              ).toMatchObject({ sha256: expectedHash, literature_id: id });
            }
            expect(receipts).toHaveBeenCalled();
            expect(readerChecks).toHaveLength(2);
            const detail = await app.library.detail(id);
            expect(detail.primary_pdf?.article_identity_status).toBe(
              "unverified",
            );
            await mkdir(join(home, "exports"));
            const target = join(home, "exports", "large.pdf");
            await exportArtifact(
              app.literatureArtifacts,
              facts.primary_asset,
              target,
            );
            const hash = createHash("sha256");
            let size = 0;
            for await (const chunk of createReadStream(target, {
              highWaterMark: MIB,
            })) {
              hash.update(chunk);
              size += chunk.length;
            }
            expect({ size, sha256: hash.digest("hex") }).toEqual({
              size: inputSize,
              sha256: expectedHash,
            });
            const completedSource = fixture.transfers.at(-1)!;
            expect(completedSource.written_bytes).toBe(inputSize);
            expect(completedSource.finished_ms).not.toBeNull();
            if (scenario === "slow" || scenario === "fetch") {
              expect(
                completedSource.finished_ms! - completedSource.started_ms,
              ).toBeGreaterThan(30_000);
              expect(calls).toHaveLength(1);
              if (scenario === "fetch") {
                expect(completedSource.session_header_preserved).toBe(true);
                expect(fixture.transfers).toHaveLength(1);
                expect(intakeChunks.length).toBeGreaterThan(17);
                expect(
                  intakeChunks.every((item) => item.byte_size <= 65536),
                ).toBe(true);
                expect(intakeChunks[0]!.at).toBeLessThan(
                  completedSource.finished_ms!,
                );
              } else {
                expect(
                  progress.filter((item) => item.received_bytes > 0).length,
                ).toBeGreaterThan(10);
              }
            } else {
              expect(fixture.transfers.map((item) => item.path)).toEqual([
                "/interrupted.pdf",
                "/download.pdf",
              ]);
              expect(fixture.transfers[0]!.interrupted).toBe(true);
              expect(fixture.transfers[0]!.finished_ms).toBeNull();
              expect(calls.map((item) => item.link)).toEqual([
                "Interrupted PDF",
                "Recover PDF",
              ]);
              expect(new Set(calls.map((item) => item.session_id)).size).toBe(
                1,
              );
              expect(
                fixture.requests.filter((path) => path === "/article"),
              ).toHaveLength(1);
            }
          }
          for (const directory of nativeDirectories)
            expect(await fileSizes(directory, () => true)).toEqual({
              logical: 0,
              allocated: 0,
            });
          expect(
            await fileSizes(join(app.files.root, ".staging"), () => true),
          ).toEqual({ logical: 0, allocated: 0 });
          expect(fixture.failures).toEqual([]);
          if (scenario === "fetch") expect(nativeDirectories.size).toBe(0);
          else expect(nativeDirectories.size).toBeGreaterThan(0);
          expect(samples.measurements.peak_descendant_count).toBeGreaterThan(0);
          passed = true;
        } finally {
          controller.abort();
          await app?.close();
          await pending?.catch(() => undefined);
          await samples?.stop();
          reader.mockRestore();
          await proxy.close();
          budget.close();
          await fixture.close();
          await writeFile(
            join(evidenceDirectory, "evidence.json"),
            JSON.stringify(
              {
                scenario,
                passed,
                cloak_version: runtime.version,
                playwright_version: "1.55.0",
                generated_stream_mib: mib,
                actual_complete_bytes: inputSize,
                expected_sha256: expectedHash,
                elapsed_ms: performance.now() - started,
                calls,
                source_transfers: fixture.transfers,
                source_requests: fixture.requests,
                native_progress: progress,
                intake_chunks: intakeChunks,
                pdf_reader_checks: readerChecks,
                report,
                temporary_resource_snapshot:
                  app?.execution?.transfers.resources.snapshot(),
                measured_resources: samples?.measurements,
                sample_limits: [
                  "100 ms target sampling can miss short peaks and skips overlapping samples",
                  "RSS is the sum of current Node and all observable descendants, including Cloak and a transient PDF reader; shared pages may be counted more than once",
                  "Processes that are reparented or exit between reads may escape the process-tree sample",
                  "Disk samples stat fixture-owned native originals, Storage staging and publication temporary files; durable candidates, assets and exports are excluded",
                  "Native progress/accounting follows real CDP events and may lag writes by about 500 ms; the ledger peak records reservations and confirmed writes",
                ],
                transport:
                  "all PDF bytes generated and served through backpressure-aware chunks, no sparse transport or whole-file body",
              },
              null,
              2,
            ),
          );
          process.stdout.write(
            `Large Browser ${mib} MiB ${scenario} evidence: ${evidenceDirectory}\n`,
          );
          await rm(home, { recursive: true, force: true });
        }
      },
      240_000,
    );
  },
);
