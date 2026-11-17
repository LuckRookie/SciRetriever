import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir, loadavg, cpus, hostname, availableParallelism } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import type { LibraryCounts, LibrarySearchPage } from "@sciretriever/contracts";
import {
  catalogRows,
  catalogSnapshot,
  directoryBytes,
  scaleDataset,
  scalePaperCount,
  ScaleProcess,
  sourceLog,
} from "./scale-fixture.js";

interface Target {
  target_id: string;
  literature_id: string;
  stage: string;
  ordinal: number;
}
interface JobState {
  job: { job_id: string; status: string; selector: unknown };
  targets: Target[];
  storage_failures?: number;
}
interface PdfFact {
  literature_id: string;
  asset_id: string;
  sha256: string;
  relative_path: string;
}
const childScript = fileURLToPath(
  new URL("./scale-process-fixture.ts", import.meta.url),
);
const selector = { kind: "query", query: {}, sort: "title-desc", limit: null };
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

describe.runIf(!!process.env.SCIRETRIEVER_SCALE_RECORDS)(
  "scale collection mechanics (explicit offline run)",
  () => {
    it(
      "keeps identity, files and frozen jobs across a crash and one storage failure, then reads without side effects",
      { timeout: 0 },
      async () => {
        const home = await mkdtemp(join(tmpdir(), "sciretriever-scale-"));
        const reportDirectory =
          process.env.SCIRETRIEVER_SCALE_REPORT ?? join(home, "report");
        await mkdir(reportDirectory, { recursive: true });
        const dataset = scaleDataset(
          Number(process.env.SCIRETRIEVER_SCALE_RECORDS),
        );
        const datasetFile = join(home, "dataset.json"),
          catalog = join(home, "catalog.sqlite");
        const logFile = join(home, "source-requests.jsonl");
        const report: Record<string, unknown> = {
          status: "running",
          seed: dataset.seed,
          records: dataset.papers,
          expected: dataset.expected,
          environment: {
            node: process.version,
            host: hostname(),
            cpu_count: cpus().length,
            available_parallelism: availableParallelism(),
            load_start: loadavg(),
            commit: execFileSync("git", ["rev-parse", "HEAD"], {
              encoding: "utf8",
            }).trim(),
          },
          isolation: {
            home,
            catalog,
            source: "loopback child process",
            server: "built dist child process",
            public_source_cooldown_ms: 0,
            http_deadline_ms: 20_000,
            timing_excludes: [
              "dataset-generation",
              "source-PDF-generation",
              "process-startup",
              "restart-startup",
            ],
            external_cost: 0,
          },
          phases: {},
          failures: [],
        };
        const phases = report.phases as Record<string, unknown>;
        let source: ScaleProcess | undefined,
          backend: ScaleProcess | undefined,
          peakRss = 0;
        const measure = async <T>(
          name: string,
          papers: number | ((result: T) => number),
          operation: () => Promise<T>,
        ) => {
          const start = performance.now();
          const result = await operation();
          const elapsed = performance.now() - start;
          const paperCount =
            typeof papers === "number" ? papers : papers(result);
          phases[name] = {
            wall_ms: elapsed,
            papers: paperCount,
            papers_per_minute: (paperCount * 60_000) / elapsed,
          };
          report.current_stage = name;
          await writeFile(
            join(reportDirectory, "scale-report.json"),
            JSON.stringify(report, null, 2) + "\n",
          );
          return result;
        };
        const startSource = async (port = 0) => {
          source = new ScaleProcess(
            childScript,
            ["source", home, datasetFile, String(port)],
            home,
            join(reportDirectory, "source.log"),
          );
          return ((await source.event("ready")).result as { port: number })
            .port;
        };
        const startBackend = async (port: number) => {
          backend = new ScaleProcess(
            childScript,
            ["server", home, datasetFile, String(port)],
            home,
            join(reportDirectory, "server.log"),
          );
          await backend.event("ready");
        };
        const counts = () =>
          catalogRows<{ meta: number; literature: number }>(
            catalog,
            "SELECT (SELECT count(*) FROM meta_literatures) meta,(SELECT count(*) FROM literatures) literature",
          )[0]!;
        const pdfs = () =>
          catalogRows<PdfFact>(
            catalog,
            "SELECT r.literature_id,r.asset_id,a.sha256,a.relative_path FROM literature_assets r JOIN assets a USING(asset_id) WHERE r.role='primary-pdf' ORDER BY r.literature_id,r.asset_id",
          );
        const facts = () =>
          catalogRows<Record<string, unknown>>(
            catalog,
            "SELECT lo.literature_id,o.observation_id,o.provenance_id,p.source_name,p.source_record_id,p.input_sha256 FROM literature_metadata_observations lo JOIN metadata_observations o USING(observation_id) JOIN provenances p USING(provenance_id) ORDER BY lo.literature_id,o.observation_id",
          );
        const keysByTitle = new Map(
          dataset.versions.map((v) => [v.title, v.key]),
        );
        keysByTitle.set(dataset.sentinel.metadata.title!, "sentinel");
        const keysById = new Map<string, string>();
        const requestKey = (target: Target) => {
          if (!keysById.size)
            for (const row of catalogRows<{
              literature_id: string;
              title: string;
            }>(
              catalog,
              "SELECT literature_id,title FROM literature_metadata",
            )) {
              const key = keysByTitle.get(row.title);
              if (!key)
                throw new Error(
                  "catalog contains a paper outside the generated data",
                );
              keysById.set(row.literature_id, key);
            }
          const key = keysById.get(target.literature_id);
          if (!key)
            throw new Error("frozen target does not name a generated version");
          return key;
        };
        const papersIn = (targets: readonly Target[]) =>
          scalePaperCount(dataset, targets.map(requestKey));
        try {
          await writeFile(datasetFile, JSON.stringify(dataset));
          await writeFile(join(home, "scale.bib"), dataset.bibliography);
          await mkdir(join(home, ".sciretriever"), { mode: 0o700 });
          await writeFile(
            join(home, ".sciretriever/config.toml"),
            '[execution]\nmax_concurrency = 4\n[sources.acquisition]\nmode = "custom"\nproviders = []\n',
            { mode: 0o600 },
          );
          const port = await startSource();
          await startBackend(port);
          const imported = await measure("bibliography", dataset.papers, () =>
            backend!.call("import"),
          );
          expect(counts()).toEqual({
            meta: dataset.expected.meta,
            literature: dataset.papers,
          });
          const discovery = await measure(
            "discovery",
            scalePaperCount(
              dataset,
              dataset.discovery.map((o) => o.provenance.source_record_id!),
            ),
            () =>
              backend!.call<{
                accepted_count: number;
                matched_count: number;
                status: string;
              }>("discovery"),
          );
          expect(discovery.status).toBe("COMPLETED");
          expect(discovery.accepted_count).toBe(
            dataset.expected.literature - dataset.papers,
          );
          expect(discovery.matched_count).toBe(dataset.expected.second_source);
          expect(counts()).toEqual({
            meta: dataset.expected.meta,
            literature: dataset.expected.literature,
          });
          const discoveredFacts = facts();
          expect(
            (await sourceLog(logFile)).some((r) =>
              ["lookup", "pdf"].includes(r.kind),
            ),
          ).toBe(false);
          expect(
            catalogRows<{ n: number }>(
              catalog,
              "SELECT count(*) n FROM execution_jobs",
            )[0]!.n,
          ).toBe(0);
          const repeated = await measure("reimport", dataset.papers, () =>
            backend!.call("import"),
          );
          expect(counts()).toEqual({
            meta: dataset.expected.meta,
            literature: dataset.expected.literature,
          });
          const retainedFacts = new Set(
            facts().map((value) => JSON.stringify(value)),
          );
          for (const fact of discoveredFacts)
            expect(retainedFacts.has(JSON.stringify(fact))).toBe(true);
          report.intake = { imported, discovery, repeated };
          const initialCounts = await backend!
            .call<LibraryCounts>("open-reader")
            .then(() => backend!.call<LibraryCounts>("counts"));
          expect(initialCounts.full_text).toEqual({
            total: dataset.papers,
            obtained: 0,
            missing: dataset.papers,
            exhausted: 0,
          });
          const jobs: { id: string; targets: Target[] }[] = [];
          const ids = catalogRows<{ literature_id: string }>(
            catalog,
            "SELECT literature_id FROM literature_metadata ORDER BY title,literature_id",
          ).map((v) => v.literature_id);
          await measure("freeze", dataset.papers, async () => {
            for (let n = 0; n < ids.length; n += 10000) {
              const selected = ids.slice(n, n + 10000);
              const job = await backend!.call<{ job_id: string }>("create", {
                kind: "acquire-pdf",
                idempotency_key: `scale-first-${n}`,
                selector: { kind: "literatures", literature_ids: selected },
              });
              const snapshot = await backend!.call<JobState>("state", {
                job_id: job.job_id,
              });
              expect(snapshot.targets.map((t) => t.literature_id)).toEqual(
                selected,
              );
              expect(snapshot.targets.length).toBeLessThanOrEqual(10000);
              jobs.push({ id: job.job_id, targets: snapshot.targets });
            }
          });
          report.frozen_scopes = jobs.map((job) => ({
            job_id: job.id,
            count: job.targets.length,
            literature_ids_sha256: createHash("sha256")
              .update(JSON.stringify(job.targets.map((v) => v.literature_id)))
              .digest("hex"),
          }));
          await backend!.call("discovery", { sentinel: true });
          expect(counts()).toEqual({
            meta: dataset.expected.meta + 1,
            literature: dataset.expected.literature + 1,
          });
          const sentinel = catalogRows<{ literature_id: string }>(
            catalog,
            "SELECT literature_id FROM literature_metadata WHERE title='Scale scope sentinel'",
          )[0]!.literature_id;
          for (const job of jobs) {
            const current = await backend!.call<JobState>("state", {
              job_id: job.id,
            });
            expect(current.targets).toEqual(job.targets);
            expect(
              current.targets.some((t) => t.literature_id === sentinel),
            ).toBe(false);
          }
          const metadataBefore = facts();
          const immutableBefore = catalogSnapshot(catalog);
          const crashJob = jobs[0]!,
            threshold = Math.min(
              crashJob.targets.length - 1,
              Math.floor(ids.length * 0.4),
            );
          const startAcquisition = performance.now();
          const interrupted = backend!
            .call("run", { job_id: crashJob.id, checkpoint: threshold })
            .then(
              () => "unexpected completion",
              () => "killed",
            );
          await backend!.event(
            "checkpoint",
            Math.max(60_000, dataset.papers * 1000),
          );
          const checkpointAt = performance.now();
          const beforeCrash = await backend!.call<JobState>("state", {
            job_id: crashJob.id,
          });
          const completed = beforeCrash.targets.filter(
            (t) => t.stage === "completed" || t.stage === "skipped",
          );
          expect(completed.length).toBeGreaterThanOrEqual(threshold);
          expect(completed.length).toBeLessThanOrEqual(threshold + 4);
          const durablePdfs = clone(pdfs()),
            durableRequests = await sourceLog(logFile);
          const settledKeys = new Set(completed.map(requestKey));
          peakRss = Math.max(peakRss, backend!.rss);
          await backend!.stop("SIGKILL");
          expect(await interrupted).toBe("killed");
          await source!.stop("SIGKILL");
          const firstLegMs = checkpointAt - startAcquisition;
          expect(pdfs()).toEqual(durablePdfs);
          expect(facts()).toEqual(metadataBefore);
          await startSource(port);
          await startBackend(port);
          const recovered = await backend!.call<{
            recovery: { recovered_jobs: number; recovered_attempts: number };
          }>("stats");
          expect(recovered.recovery.recovered_jobs).toBeGreaterThanOrEqual(1);
          const restartState = await backend!.call<JobState>("state", {
            job_id: crashJob.id,
          });
          if (!["queued", "running"].includes(restartState.job.status))
            await backend!.call("control", {
              job_id: crashJob.id,
              action: "resume",
            });
          await measure(
            "acquisition_after_restart",
            papersIn(
              jobs
                .flatMap((job) => job.targets)
                .filter(
                  (t) =>
                    !completed.some((done) => done.target_id === t.target_id),
                ),
            ),
            async () => {
              for (const job of jobs)
                await backend!.call("run", { job_id: job.id });
            },
          );
          const requestsAfterResume = await sourceLog(logFile);
          expect(
            requestsAfterResume.filter((r) => settledKeys.has(r.key)),
          ).toEqual(durableRequests.filter((r) => settledKeys.has(r.key)));
          for (const fact of durablePdfs) expect(pdfs()).toContainEqual(fact);
          expect(facts()).toEqual(metadataBefore);
          report.crash = {
            threshold,
            settled: completed.length,
            fraction: completed.length / ids.length,
            accepted_files_preserved: durablePdfs.length,
            recovered: recovered.recovery,
            finished_targets_not_repeated: completed.length,
            first_leg_wall_ms: firstLegMs,
            papers: papersIn(completed),
            papers_per_minute: (papersIn(completed) * 60_000) / firstLegMs,
          };

          // A second whole-library task excludes every normal miss, but includes
          // transient failures and the later sentinel. Inject failure into its first
          // immutable PDF publication, then explicitly retry the durable task.
          const preview = await backend!.call<{
            counts: {
              skipped_unavailable: number;
              skipped_has_pdf: number;
              process: number;
            };
          }>("selection", selector);
          expect(preview.counts.skipped_unavailable).toBe(
            dataset.expected.exhausted_versions,
          );
          const exhaustedIds = catalogRows<{ literature_id: string }>(
            catalog,
            "SELECT literature_id FROM automatic_pdf_acquisition_exhaustions",
          ).map((v) => v.literature_id);
          const transientIds = dataset.versions
            .filter((v) => ["retry-pdf", "temporary"].includes(v.outcome))
            .map((v) => v.key);
          const exhaustedKeys = new Set(
            exhaustedIds.map((literature_id) =>
              requestKey({
                literature_id,
                target_id: "",
                stage: "",
                ordinal: 0,
              }),
            ),
          );
          expect(transientIds.some((id) => exhaustedKeys.has(id))).toBe(false);
          const supplement = await backend!.call<{ job_id: string }>("create", {
            kind: "acquire-pdf",
            idempotency_key: "scale-second",
            selector,
          });
          const frozenSecond = await backend!.call<JobState>("state", {
            job_id: supplement.job_id,
          });
          expect(frozenSecond.targets.length).toBeLessThanOrEqual(10000);
          expect(
            frozenSecond.targets.every(
              (t) => !exhaustedIds.includes(t.literature_id),
            ),
          ).toBe(true);
          expect(
            frozenSecond.targets.some((t) => t.literature_id === sentinel),
          ).toBe(true);
          const requestsBeforeSecond = await sourceLog(logFile);
          await backend!.call("arm-storage");
          const storageRun = await measure(
            "storage_failure",
            (state: JobState) =>
              papersIn(
                state.targets.filter((target) =>
                  ["completed", "skipped", "failed"].includes(target.stage),
                ),
              ),
            () => backend!.call<JobState>("run", { job_id: supplement.job_id }),
          );
          expect(storageRun.storage_failures).toBe(1);
          expect(storageRun.job.status).toBe("failed");
          expect(storageRun.targets.some((t) => t.stage === "failed")).toBe(
            true,
          );
          const failedStorageIds = storageRun.targets
            .filter((t) => t.stage === "failed")
            .map((t) => t.literature_id);
          const exhaustedAfterStorage = catalogRows<{ literature_id: string }>(
            catalog,
            "SELECT literature_id FROM automatic_pdf_acquisition_exhaustions",
          );
          expect(
            exhaustedAfterStorage.some((row) =>
              failedStorageIds.includes(row.literature_id),
            ),
          ).toBe(false);
          const afterStorage = clone(pdfs());
          await backend!.call("control", {
            job_id: supplement.job_id,
            action: "retry",
          });
          const retryState = await backend!.call<JobState>("state", {
            job_id: supplement.job_id,
          });
          await measure(
            "supplement_retry",
            papersIn(
              retryState.targets.filter((target) => target.stage === "queued"),
            ),
            () => backend!.call("run", { job_id: supplement.job_id }),
          );
          for (const fact of afterStorage) expect(pdfs()).toContainEqual(fact);
          const finalRequests = await sourceLog(logFile);
          for (const jobId of [
            ...jobs.map((job) => job.id),
            supplement.job_id,
          ]) {
            const state = await backend!.call<JobState>("state", {
              job_id: jobId,
            });
            expect(state.job.status).toBe("completed");
            expect(
              state.targets.every((target) =>
                ["completed", "skipped"].includes(target.stage),
              ),
            ).toBe(true);
          }
          expect(finalRequests.filter((r) => exhaustedKeys.has(r.key))).toEqual(
            requestsBeforeSecond.filter((r) => exhaustedKeys.has(r.key)),
          );
          const failures = catalogRows<{
            failure_code: string;
            failure_reason: string;
            failure_retryable: number;
          }>(
            catalog,
            "SELECT failure_code,failure_reason,failure_retryable FROM execution_attempts WHERE failure_code IS NOT NULL",
          );
          expect(
            failures.some(
              (f) => f.failure_code === "pdf-acquisition-storage-failed",
            ),
          ).toBe(true);
          report.faults = {
            storage_failures: 1,
            failure_attempts: failures,
            later_scope_excludes_exhausted: exhaustedIds.length,
            supplement_targets: frozenSecond.targets.length,
            source_restarted: true,
          };

          await measure("index_flush", dataset.papers, () =>
            backend!.call("flush"),
          );
          // Reopen a query-only application after all writers and refresh work settle.
          await backend!.call("open-reader");
          const beforeReads = catalogSnapshot(catalog),
            networkBefore = await sourceLog(logFile);
          const measuredReads: Record<string, number> = {};
          const read = async <T>(
            name: string,
            operation: string,
            input: unknown = {},
          ) => {
            const start = performance.now(),
              value = await backend!.call<T>(operation, input);
            measuredReads[name] = performance.now() - start;
            return value;
          };
          const finalCounts = await read<LibraryCounts>("counts_ms", "counts");
          const page = await read<LibrarySearchPage>(
            "first_page_ms",
            "search",
            { query: {}, sort: "title-desc", limit: 50, cursor: null },
          );
          const filtered = await read<LibrarySearchPage>(
            "missing_pdf_ms",
            "search",
            {
              query: { has_primary_pdf: false },
              sort: "title-desc",
              limit: 50,
              cursor: null,
            },
          );
          expect(finalCounts.full_text).toEqual({
            total: dataset.papers + 1,
            obtained: dataset.expected.obtained,
            missing: dataset.papers + 1 - dataset.expected.obtained,
            exhausted: dataset.expected.exhausted + 1,
          });
          expect(finalCounts.full_text.total).toBe(
            finalCounts.full_text.obtained + finalCounts.full_text.missing,
          );
          expect(finalCounts.with_primary_pdf).toBe(
            dataset.expected.with_primary_pdf,
          );
          expect(finalCounts.total).toBe(dataset.expected.literature + 1);
          expect(page.total_count).toBe(dataset.expected.literature + 1);
          expect(page.items).toHaveLength(Math.min(50, page.total_count));
          expect(filtered.total_count).toBe(
            dataset.expected.literature + 1 - dataset.expected.with_primary_pdf,
          );
          expect(catalogSnapshot(catalog)).toEqual(beforeReads);
          expect(await sourceLog(logFile)).toEqual(networkBefore);
          const stats = await backend!.call<{
            forbidden_egress: number;
            storage_failures: number;
          }>("stats");
          expect(stats).toMatchObject({
            forbidden_egress: 0,
            storage_failures: 1,
          });
          expect(facts()).toEqual(metadataBefore);
          const saved = pdfs();
          expect(saved).toHaveLength(dataset.expected.with_primary_pdf);
          for (const file of saved) {
            const digest = createHash("sha256");
            for await (const chunk of createReadStream(
              join(home, "artifacts", file.relative_path),
            ))
              digest.update(chunk);
            expect(digest.digest("hex")).toBe(file.sha256);
          }
          expect(catalogRows(catalog, "PRAGMA foreign_key_check")).toEqual([]);
          const immutableAfter = catalogSnapshot(catalog);
          for (const table of Object.keys(immutableBefore).filter(
            (name) =>
              name.startsWith("metadata_observation") ||
              [
                "literatures",
                "meta_literatures",
                "literature_metadata_observations",
              ].includes(name),
          )) {
            expect(immutableAfter[table]).toEqual(immutableBefore[table]);
          }
          for (const table of [
            "raw_parses",
            "raw_parse_attempts",
            "processor_results",
          ]) {
            expect(immutableAfter[table]!.rows).toBe(0);
          }
          expect(
            catalogRows<{ n: number }>(
              catalog,
              "SELECT coalesce(sum(used_model_calls),0) n FROM execution_budgets",
            )[0]!.n,
          ).toBe(0);
          report.reads = {
            timings: measuredReads,
            counts: finalCounts,
            page_items: page.items.length,
            filtered_total: filtered.total_count,
            source_requests_added: 0,
            tasks_added: 0,
            catalog_changed: false,
          };
          report.invariants = {
            exact_identity: true,
            reimport_adds_zero: true,
            sources_preserved: true,
            frozen_scope: true,
            crash_preserves_files: true,
            finished_work_not_repeated: true,
            transient_is_not_exhausted: true,
            normal_misses_skipped_on_supplement: true,
            sha256_verified_files: saved.length,
            read_only_queries: true,
            external_requests: 0,
          };
          report.source = {
            requests: finalRequests.length,
            lookups: finalRequests.filter((r) => r.kind === "lookup").length,
            downloads: finalRequests.filter((r) => r.kind === "pdf").length,
          };
          report.disk = {
            catalog_bytes: (await stat(catalog)).size,
            wal_bytes: await stat(`${catalog}-wal`)
              .then((value) => value.size)
              .catch((error: NodeJS.ErrnoException) => {
                if (error.code === "ENOENT") return 0;
                throw error;
              }),
            artifact_bytes: await directoryBytes(join(home, "artifacts")),
          };
          report.status = "passed";
        } catch (error) {
          report.status = "failed";
          report.failures = [
            error instanceof Error ? error.stack : String(error),
          ];
          throw error;
        } finally {
          peakRss = Math.max(peakRss, backend?.rss ?? 0);
          if (backend?.child.connected) {
            const closing = backend.call("close").catch(() => undefined);
            let timer: ReturnType<typeof setTimeout> | undefined;
            await Promise.race([
              closing,
              new Promise((resolve) => {
                timer = setTimeout(resolve, 20_000);
              }),
            ]);
            clearTimeout(timer);
          }
          await backend?.stop();
          await source?.stop();
          report.server_peak_rss_bytes = peakRss;
          (report.environment as Record<string, unknown>).load_end = loadavg();
          await writeFile(
            join(reportDirectory, "scale-report.json"),
            JSON.stringify(report, null, 2) + "\n",
          );
          await writeFile(
            join(reportDirectory, "source-requests.jsonl"),
            await readFile(logFile).catch(() => Buffer.from("")),
          );
          // Failed runs retain the isolated state for diagnosis; successful runs keep
          // the report and remove only their own synthetic home outside the report.
          if (report.status === "passed" && !reportDirectory.startsWith(home))
            await rm(home, { recursive: true, force: true });
        }
      },
    );
  },
);
