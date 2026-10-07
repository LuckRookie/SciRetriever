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
  parseLiterature,
  parseMetadataObservation,
  type WorkbenchObservation,
} from "@sciretriever/contracts";
import { expect, it, vi } from "vitest";
import {
  createApplication,
  type Application,
} from "../src/bootstrap/application.js";
import { verifyInstalledCloakRuntime } from "../src/configuration/cloak-runtime.js";
import { exportArtifact } from "../src/entry/artifact-export.js";
import { BrowserNetworkProxy } from "../src/network/browser-proxy.js";
import { NetworkBudgetCoordinator } from "../src/network/budget.js";
import { resolveBrowserDestination } from "../src/network/policy.js";
import {
  FIXTURE_LITERATURE,
  workbenchPdf,
} from "../src/workbench/synthetic-fixture.js";

const MIB = 1024 * 1024;
const LARGE_MIB = 17;

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/** Same complete, uncompressed one-page PDF as the independent large sample. */
async function* pdfChunks(): AsyncIterable<Buffer> {
  const streamBytes = LARGE_MIB * MIB;
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

function vanished(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ESRCH")
  );
}

/** Read numeric process relationships and RSS only, never cmdline or environ. */
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
  return { rss, descendants: Math.max(0, seen.size - 1) };
}

/** Traverse only fixture-owned directories, without following symlinks. */
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
  const resources = app.execution!.transfers.resources;
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
    samples: [] as {
      at_ms: number;
      node_rss: number;
      process_tree_rss: number;
      descendants: number;
      ledger: ReturnType<typeof resources.snapshot>;
    }[],
  };
  let running: Promise<void> | undefined;
  let failure: unknown;
  const sample = async () => {
    const tree = await processTreeRss();
    const nodeRss = process.memoryUsage().rss;
    measurements.node_rss_sampled_peak = Math.max(
      measurements.node_rss_sampled_peak,
      nodeRss,
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
    measurements.temporary_logical_sampled_peak = Math.max(
      measurements.temporary_logical_sampled_peak,
      native.reduce((sum, item) => sum + item.logical, storage.logical),
    );
    measurements.temporary_allocated_sampled_peak = Math.max(
      measurements.temporary_allocated_sampled_peak,
      native.reduce((sum, item) => sum + item.allocated, storage.allocated),
    );
    measurements.samples.push({
      at_ms: performance.now(),
      node_rss: nodeRss,
      process_tree_rss: tree.rss,
      descendants: tree.descendants,
      ledger: resources.snapshot(),
    });
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

it.runIf(!!process.env.SCIRETRIEVER_CLOAK_BUNDLE)(
  "publishes two articles through real model HTTP while a 17 MiB production Browser stream remains active, then publishes and exports all three",
  async () => {
    const home = await mkdtemp(
      join(tmpdir(), "sciretriever-large-mixed-browser-production-"),
    );
    const evidenceDirectory = await mkdtemp(
      join(tmpdir(), "sciretriever-large-mixed-browser-evidence-"),
    );
    const models = gate();
    const smallPublished = gate();
    const controller = new AbortController();
    const inputHash = createHash("sha256");
    let largeSize = 0;
    for await (const chunk of pdfChunks()) {
      inputHash.update(chunk);
      largeSize += chunk.length;
    }
    const largeHash = inputHash.digest("hex");
    const papers = (["a", "b", "c"] as const).map((name, index) => {
      const bytes =
        name === "a"
          ? undefined
          : workbenchPdf(`10.1000/large-mixed-${name}`, "published");
      return {
        name,
        literature: parseLiterature({
          ...FIXTURE_LITERATURE,
          literature_id: `00000000-0000-0000-0000-00000000930${index}`,
          meta_literature_id: `10000000-0000-0000-0000-00000000930${index}`,
          metadata: {
            ...FIXTURE_LITERATURE.metadata,
            title: `Large mixed article ${name}`,
            identifiers: [
              { namespace: "doi", value: `10.1000/large-mixed-${name}` },
            ],
          },
        }),
        bytes,
        byte_size: bytes?.length ?? largeSize,
        sha256: bytes
          ? createHash("sha256").update(bytes).digest("hex")
          : largeHash,
      };
    });
    const requests: { host: string; path: string; at_ms: number }[] = [];
    const sourceTransfers: {
      article: string;
      started_ms: number;
      written_bytes: number;
      finished_ms: number | null;
      closed_ms: number | null;
    }[] = [];
    const fixtureFailures: { boundary: string; name: string }[] = [];
    const operations = new Set<Promise<void>>();
    const pump = async (
      response: ServerResponse,
      paper: (typeof papers)[number],
    ) => {
      const source = {
        article: paper.name,
        started_ms: performance.now(),
        written_bytes: 0,
        finished_ms: null as number | null,
        closed_ms: null as number | null,
      };
      sourceTransfers.push(source);
      const sourceController = new AbortController();
      const signal = sourceController.signal;
      response.once("finish", () => {
        source.finished_ms = performance.now();
      });
      response.once("close", () => {
        source.closed_ms = performance.now();
        sourceController.abort();
      });
      response.writeHead(200, {
        "content-type": "application/pdf",
        "content-disposition": `attachment; filename=${paper.name}.pdf`,
        // Unknown-length response, with every PDF byte actually generated.
      });
      try {
        const chunks = paper.name === "a" ? pdfChunks() : [paper.bytes!];
        let index = 0;
        for await (const chunk of chunks) {
          if (signal.aborted) return;
          if (paper.name === "a" && index > 0 && index <= LARGE_MIB) {
            await delay(Math.ceil(30_600 / LARGE_MIB), undefined, { signal });
            if (index === Math.floor(LARGE_MIB / 2))
              await delay(4000, undefined, { signal });
          }
          // Keep EOF deterministic if the two small publications are slow. The
          // preceding 17 MiB still flows in real chunks throughout the sample.
          if (paper.name === "a" && index === LARGE_MIB + 1)
            await smallPublished.promise;
          if (signal.aborted) return;
          source.written_bytes += chunk.length;
          if (!response.write(chunk)) await once(response, "drain", { signal });
          index++;
        }
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
      requests.push({
        host,
        path: request.url ?? "",
        at_ms: performance.now(),
      });
      const paper = papers.find(
        (item) => host === `${item.name}-publisher.test`,
      );
      if (paper && request.url === "/article") {
        response.writeHead(200, { "content-type": "text/html" });
        response.end(
          `<title>${paper.literature.metadata.title}</title><main><h1>${paper.literature.metadata.title}</h1><p>Institutional access available.</p><a href="/paper.pdf" download>Download PDF</a></main>`,
        );
      } else if (paper && request.url === "/paper.pdf") {
        const operation = pump(response, paper);
        operations.add(operation);
        void operation.finally(() => operations.delete(operation));
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
      article_id: string;
      session_id: string;
      path: string;
      at_ms: number;
      end_ms: number | null;
      action: string | null;
    }[] = [];
    let activeModels = 0;
    let peakModels = 0;
    const handleModel = async (
      request: IncomingMessage,
      response: ServerResponse,
    ) => {
      if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
        response.writeHead(404);
        response.end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request)
        chunks.push(Buffer.from(chunk as Uint8Array));
      const wire = JSON.parse(Buffer.concat(chunks).toString()) as {
        messages: { content: { type: string; text?: string }[] }[];
      };
      const raw = wire.messages[1]!.content.find(
        (part) => part.type === "text",
      )!.text!;
      const observation = JSON.parse(raw) as WorkbenchObservation;
      const paper = papers.find(
        (item) => item.literature.literature_id === observation.article_id,
      )!;
      const call = {
        article: paper.name,
        article_id: observation.article_id,
        session_id: observation.session_id,
        path: request.url,
        at_ms: performance.now(),
        end_ms: null as number | null,
        action: null as string | null,
      };
      calls.push(call);
      peakModels = Math.max(peakModels, ++activeModels);
      try {
        if (paper.name !== "a") await models.promise;
        const pdf = observation.elements.find(
          (element) => element.name === "Download PDF",
        );
        const first =
          calls.filter((item) => item.article === paper.name).length === 1;
        const action =
          pdf && !(paper.name !== "a" && first)
            ? {
                kind: "click-element",
                element_id: pdf.element_id,
                revision: observation.observation_revision,
              }
            : {
                kind: "wait-for-change",
                timeout_ms: 100,
                revision: observation.observation_revision,
              };
        call.action = action.kind;
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
        call.end_ms = performance.now();
      } finally {
        activeModels--;
      }
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
        maxResponseBytes: 64 * MIB,
        maxRedirects: 0,
        maxRetries: 0,
      },
    });
    const runtime = await verifyInstalledCloakRuntime(
      process.env.SCIRETRIEVER_CLOAK_BUNDLE!,
    );
    const nativeDirectories = new Set<string>();
    const nativeProgress: {
      transfer_id: string;
      received_bytes: number;
      at_ms: number;
    }[] = [];
    let app: Application | undefined;
    let pending:
      | ReturnType<NonNullable<Application["databaseCompletion"]>["run"]>
      | undefined;
    let report: Awaited<NonNullable<typeof pending>> | undefined;
    let samples: Awaited<ReturnType<typeof startSamples>> | undefined;
    let modelOverlap:
      | {
          at_ms: number;
          active_models: number;
          a_written_bytes: number;
          ledger: unknown;
        }
      | undefined;
    let smallPublications:
      | {
          at_ms: number;
          a_written_bytes: number;
          ledger: unknown;
          articles: string[];
        }
      | undefined;
    let passed = false;
    const started = performance.now();
    try {
      await mkdir(join(home, ".sciretriever"), { mode: 0o700 });
      await writeFile(
        join(home, ".sciretriever", "config.toml"),
        `[providers.fixture]\napi = "openai-chat-completions"\nbase_url = "http://127.0.0.1:${modelPort}/v1"\n[models."fixture/browser"]\nimage = true\nstream = false\n[browser]\nenabled = true\nmodel = "fixture/browser"\nprofile = "large-mixed-fixture"\n[sources.acquisition]\nmode = "custom"\nproviders = []\n`,
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
        // The normal model runtime and HTTP transport reach the loopback server.
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
            observation_id: `00000000-0000-0000-0000-00000000940${index}`,
            provenance: {
              provenance_id: `00000000-0000-0000-0000-00000000950${index}`,
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
      samples = await startSamples(app, nativeDirectories);
      pending = app.databaseCompletion!.run(
        {
          selector: {
            kind: "literatures",
            literature_ids: papers.map(
              (paper) => paper.literature.literature_id,
            ),
          },
          goal: "ASSET_READY",
        },
        { signal: controller.signal },
      );
      void pending.catch(() => undefined);
      await expect
        .poll(() => calls.filter((call) => call.article !== "a").length, {
          timeout: 30_000,
        })
        .toBe(2);
      await expect
        .poll(() => resources.snapshot().native_bytes, { timeout: 30_000 })
        .toBeGreaterThanOrEqual(2 * MIB);
      const sourceA = sourceTransfers.find((source) => source.article === "a")!;
      expect(sourceA.finished_ms).toBeNull();
      expect(activeModels).toBe(2);
      modelOverlap = {
        at_ms: performance.now(),
        active_models: activeModels,
        a_written_bytes: sourceA.written_bytes,
        ledger: resources.snapshot(),
      };
      models.release();
      await expect
        .poll(
          async () => {
            const facts = await Promise.all(
              papers
                .slice(1)
                .map((paper) =>
                  app!.database.currentFacts(paper.literature.literature_id),
                ),
            );
            return facts.filter((item) => Boolean(item?.primary_asset)).length;
          },
          { timeout: 45_000 },
        )
        .toBe(2);
      expect(sourceA.finished_ms).toBeNull();
      expect(
        (await app.database.currentFacts(papers[0]!.literature.literature_id))!
          .primary_asset,
      ).toBeNull();
      smallPublications = {
        at_ms: performance.now(),
        a_written_bytes: sourceA.written_bytes,
        ledger: resources.snapshot(),
        articles: papers.slice(1).map((paper) => paper.name),
      };
      smallPublished.release();
      report = await pending;
      expect(report.completed, JSON.stringify(report)).toHaveLength(3);
      expect(peakModels).toBe(2);
      expect(sourceA.finished_ms! - sourceA.started_ms).toBeGreaterThan(30_000);
      expect(sourceA.written_bytes).toBe(largeSize);
      expect(modelOverlap.at_ms).toBeGreaterThan(sourceA.started_ms);
      expect(smallPublications.at_ms).toBeLessThan(sourceA.finished_ms!);
      expect(calls.filter((call) => call.article === "a")).toHaveLength(1);
      await mkdir(join(home, "exports"));
      for (const paper of papers) {
        const facts = (await app.database.currentFacts(
          paper.literature.literature_id,
        ))!;
        expect(facts.primary_asset).toMatchObject({
          sha256: paper.sha256,
          size_bytes: paper.byte_size,
        });
        const candidates = await app.database.listCandidates(
          paper.literature.literature_id,
        );
        expect(candidates).toHaveLength(1);
        expect(candidates[0]).toMatchObject({
          sha256: paper.sha256,
          size_bytes: paper.byte_size,
          capture: {
            article_id: paper.literature.literature_id,
            session_id: calls.find((call) => call.article === paper.name)!
              .session_id,
          },
        });
        expect(
          await app.execution!.transfers.recover(candidates[0]!.transfer_id),
        ).toEqual(candidates[0]);
        expect(
          (await app.library.detail(paper.literature.literature_id)).primary_pdf
            ?.article_identity_status,
        ).toBe("unverified");
        expect(
          await app.database.hasAutomaticPdfExhaustion(
            paper.literature.literature_id,
          ),
        ).toBe(false);
        const target = join(home, "exports", `${paper.name}.pdf`);
        await exportArtifact(
          app.literatureArtifacts,
          facts.primary_asset!,
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
        expect({ byte_size: size, sha256: hash.digest("hex") }).toEqual({
          byte_size: paper.byte_size,
          sha256: paper.sha256,
        });
        expect(
          requests.filter(
            (request) =>
              request.host === `${paper.name}-publisher.test` &&
              request.path === "/paper.pdf",
          ),
        ).toHaveLength(1);
        if (paper.name !== "a") {
          const turns = calls.filter((call) => call.article === paper.name);
          expect(turns).toHaveLength(2);
          expect(turns[1]!.at_ms).toBeGreaterThan(sourceA.started_ms);
          expect(turns[1]!.at_ms).toBeLessThan(smallPublications.at_ms);
          expect(turns[1]!.at_ms - turns[0]!.end_ms!).toBeGreaterThanOrEqual(
            5000,
          );
          expect(turns[1]!.action).toBe("click-element");
        }
      }
      await expect
        .poll(() => resources.snapshot().temporary_bytes, { timeout: 10_000 })
        .toBe(0);
      for (const directory of nativeDirectories)
        expect(await fileSizes(directory, () => true)).toEqual({
          logical: 0,
          allocated: 0,
        });
      expect(
        await fileSizes(join(app.files.root, ".staging"), () => true),
      ).toEqual({ logical: 0, allocated: 0 });
      expect(samples.measurements.peak_descendant_count).toBeGreaterThan(0);
      expect(fixtureFailures).toEqual([]);
      passed = true;
    } finally {
      models.release();
      smallPublished.release();
      controller.abort();
      await app?.close();
      await pending?.catch(() => undefined);
      await samples?.stop();
      vi.restoreAllMocks();
      await proxy.close();
      budget.close();
      origin.closeAllConnections();
      model.closeAllConnections();
      await Promise.all([
        new Promise<void>((resolve) => origin.close(() => resolve())),
        new Promise<void>((resolve) => model.close(() => resolve())),
      ]);
      await Promise.all(operations);
      await writeFile(
        join(evidenceDirectory, "evidence.json"),
        JSON.stringify(
          {
            passed,
            cloak_version: runtime.version,
            playwright_version: "1.55.0",
            elapsed_ms: performance.now() - started,
            peak_model_requests: peakModels,
            calls,
            source_requests: requests,
            source_transfers: sourceTransfers,
            native_progress: nativeProgress,
            model_overlap: modelOverlap,
            small_publications_during_a_download: smallPublications,
            report,
            files: papers.map((paper) => ({
              article: paper.name,
              sha256: paper.sha256,
              byte_size: paper.byte_size,
            })),
            temporary_resource_snapshot:
              app?.execution?.transfers.resources.snapshot(),
            measured_resources: samples?.measurements,
            fixture_failures: fixtureFailures,
            sample_limits: [
              "100 ms target sampling can miss short peaks and skips overlapping samples",
              "RSS sums current Node and observable descendants, including Cloak and PDF readers; shared pages may be counted more than once",
              "Reparented processes or processes exiting between reads may escape the process-tree sample",
              "Disk stats include fixture native originals, staging and publication temporary files; durable candidates, assets and exports are excluded",
              "Native CDP progress/accounting can lag actual writes by about 500 ms; the owner ledger retains reservation and confirmed-write peaks",
              "A emits all 17 MiB through real paced, backpressure-aware chunks; only its final trailer/EOF can wait for B and C publication",
            ],
            model_transport:
              "production OpenAI-compatible HTTP transport against a loopback fixture, without agentTransportFactory injection",
          },
          null,
          2,
        ),
      );
      process.stdout.write(
        `Large mixed Browser evidence: ${evidenceDirectory}\n`,
      );
      await rm(home, { recursive: true, force: true });
    }
  },
  150_000,
);
