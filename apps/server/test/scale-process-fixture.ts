// Executed by Node after pnpm build. All business operations use the built server.
import { createServer } from "node:http";
import {
  appendFileSync,
  readFileSync,
  createReadStream,
  mkdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { once } from "node:events";
import { join } from "node:path";
import { parseMetadataObservation } from "@sciretriever/contracts";
import {
  createApplication,
  createQueryApplication,
} from "../dist/bootstrap/application.js";
import { createTaskOperations } from "../dist/entry/task-operations.js";
import { EntryPdfAcquisitionService } from "../dist/entry/pdf-acquisition.js";
import { DatabaseCompletionService } from "../dist/entry/database-completion.js";
import { ExecutionTaskService } from "../dist/application/jobs/service.js";
import { AcquisitionRouteError } from "../dist/acquisition/tiered.js";
import { safeLocator } from "../dist/acquisition/sources/locators.js";
import { workbenchPdf } from "../dist/workbench/synthetic-fixture.js";
import type { ScaleDataset, ScaleMessage } from "./scale-fixture.js";

const [role, home, datasetFile, endpoint] = process.argv.slice(2);
if (!home || !datasetFile || !process.send)
  throw new Error("scale child arguments are required");
const dataset = JSON.parse(readFileSync(datasetFile, "utf8")) as ScaleDataset;
const emit = (value: ScaleMessage) =>
  process.send!({ ...value, rss: process.resourceUsage().maxRSS * 1024 });

if (role === "source") {
  const log = join(home, "source-requests.jsonl"),
    attempts = new Map<string, number>();
  try {
    for (const row of readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)) {
      const request = JSON.parse(row) as { key: string; kind: string };
      if (request.kind === "lookup")
        attempts.set(request.key, (attempts.get(request.key) ?? 0) + 1);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const versions = new Map(dataset.versions.map((v) => [v.key, v]));
  const pdfDirectory = join(home, "source-pdfs");
  mkdirSync(pdfDirectory, { recursive: true, mode: 0o700 });
  // Dataset generation and source startup end before the ready checkpoint.
  // Reuse exactly these bytes after a source-process crash as well.
  for (const version of dataset.versions.filter((v) =>
    ["pdf", "retry-pdf"].includes(v.outcome),
  )) {
    const path = join(pdfDirectory, `${version.key}.pdf`);
    try {
      if (statSync(path).size !== version.bytes)
        throw new Error("scale PDF cache changed");
      continue;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const base = Buffer.from(
      workbenchPdf(version.doi ?? version.key, version.version),
    );
    const offset = base.indexOf("startxref\n");
    // A comment before startxref preserves every original xref offset and EOF.
    const padding = Buffer.alloc(version.bytes - base.length, 120);
    padding[0] = 37;
    padding[padding.length - 1] = 10;
    writeFileSync(
      path,
      Buffer.concat([base.subarray(0, offset), padding, base.subarray(offset)]),
      { mode: 0o600, flag: "wx" },
    );
  }
  const replayBytes = JSON.stringify(dataset.discovery),
    sentinelBytes = JSON.stringify([dataset.sentinel]);
  const server = createServer((request, response) => {
    const url = new URL(request.url!, "http://127.0.0.1"),
      [kind, key = ""] = url.pathname.slice(1).split("/");
    if (kind === "metadata") {
      appendFileSync(
        log,
        JSON.stringify({ kind, key, outcome: "metadata" }) + "\n",
      );
      response.setHeader("content-type", "application/json");
      response.end(key === "sentinel" ? sentinelBytes : replayBytes);
      return;
    }
    const version = versions.get(key);
    if (!version && key !== "sentinel") {
      response.writeHead(404);
      response.end();
      return;
    }
    if (kind === "lookup") {
      const attempt = (attempts.get(key) ?? 0) + 1;
      attempts.set(key, attempt);
      const outcome = version?.outcome ?? "miss";
      const temporary =
        outcome === "temporary" || (outcome === "retry-pdf" && attempt === 1);
      appendFileSync(
        log,
        JSON.stringify({
          kind,
          key,
          outcome: temporary
            ? "temporary"
            : outcome === "miss"
              ? "miss"
              : "pdf",
          attempt,
        }) + "\n",
      );
      response.writeHead(temporary ? 503 : 200, {
        "content-type": "application/json",
      });
      response.end(JSON.stringify({ found: !temporary && outcome !== "miss" }));
      return;
    }
    if (kind === "pdf" && version) {
      appendFileSync(
        log,
        JSON.stringify({ kind, key, outcome: "pdf", bytes: version.bytes }) +
          "\n",
      );
      response.writeHead(200, {
        "content-type": "application/pdf",
        "content-length": version.bytes,
      });
      createReadStream(join(pdfDirectory, `${version.key}.pdf`))
        .on("error", (error) => response.destroy(error))
        .pipe(response);
      return;
    }
    response.writeHead(404);
    response.end();
  });
  server.listen(Number(endpoint ?? 0), "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("scale source address missing");
  emit({ event: "ready", result: { port: address.port } });
} else if (role === "server") {
  const origin = `http://127.0.0.1:${Number(endpoint)}`;
  const loopback = async (path: string, signal?: AbortSignal) => {
    const url = new URL(path, origin);
    if (url.origin !== origin || url.hostname !== "127.0.0.1")
      throw new Error("scale fixture forbids non-loopback HTTP");
    return fetch(url, {
      redirect: "error",
      signal: AbortSignal.any([
        AbortSignal.timeout(20_000),
        ...(signal ? [signal] : []),
      ]),
    });
  };
  let forbiddenEgress = 0;
  const resolver = async () => {
    forbiddenEgress++;
    throw new Error("scale fixture forbids external DNS and connections");
  };
  const source = {
    source_name: "doi-landing",
    ready: true,
    discover: async (
      request: import("../src/acquisition/ports.js").AcquisitionSourceRequest,
      signal?: AbortSignal,
    ) => {
      const title = request.observations
        ?.map((o) => o.metadata.title)
        .find(
          (t) =>
            dataset.versions.some((v) => v.title === t) ||
            t === dataset.sentinel.metadata.title,
        );
      const version = dataset.versions.find((v) => v.title === title);
      const key =
        version?.key ??
        (title === dataset.sentinel.metadata.title ? "sentinel" : null);
      if (!key)
        throw new Error(
          "scale acquisition target is not in the generated data",
        );
      const response = await loopback(`/lookup/${key}`, signal);
      if (response.status === 503)
        throw new AcquisitionRouteError(
          "network-failed",
          "Synthetic temporary source failure",
          true,
        );
      if (!response.ok)
        throw new Error(`scale source returned ${response.status}`);
      const result = (await response.json()) as { found: boolean };
      return result.found
        ? [
            {
              ...safeLocator("doi-landing", `https://scale.invalid/pdf/${key}`),
              source_record_id: key,
            },
          ]
        : [];
    },
    download_candidate: async (
      candidate: import("../src/acquisition/sources/locators.js").SourceCandidate,
      signal?: AbortSignal,
    ) => {
      const response = await loopback(
        `/pdf/${candidate.source_record_id}`,
        signal,
      );
      if (!response.ok)
        throw new Error(`scale PDF returned ${response.status}`);
      return {
        kind: "download" as const,
        locator: {
          namespace: "scale",
          value: candidate.source_record_id!,
          declared_media_type: "application/pdf" as const,
          source_record_id: candidate.source_record_id!,
        },
        bytes: new Uint8Array(await response.arrayBuffer()),
        media_type: "application/pdf",
        safe_source_url: candidate.locator,
        entitlement: "granted" as const,
      };
    },
  };
  const app = await createApplication(home, {
    indexRefreshIntervalMs: null,
    importSessions: { maintain: true },
    metadata: {
      lookup_ports: [],
      reference_query_ports: [],
      topic_search_ports: [
        {
          provider_name: "scale-replay",
          open_topic_search: async (query) => {
            const response = await loopback(
              `/metadata/${query.query === "sentinel" ? "sentinel" : "all"}`,
            );
            const observations = ((await response.json()) as unknown[]).map(
              (value) => parseMetadataObservation(value),
            );
            let position = 0;
            return {
              pull_raw_item: () =>
                position >= observations.length
                  ? null
                  : {
                      raw_item: observations[position++],
                      source_exhausted_after: position === observations.length,
                    },
              convert_raw_item: (raw: unknown) => ({
                observations: [parseMetadataObservation(raw)],
                relations: [],
              }),
            };
          },
        },
      ],
    },
    acquisitionAssembly: { resolver, doiLandingSource: source },
    metadataAssembly: { resolver },
  });
  if (!app.jobs || !app.queue || !app.interventions || !app.execution)
    throw new Error("scale durable runtime missing");
  // Independent per-item transport failures must not impose the public source's
  // 30-second global cooldown on the entire synthetic corpus. This existing
  // constructor policy is test assembly only; all task/publication classes are real.
  const acquisition = new EntryPdfAcquisitionService({
    registry: app.acquisition,
    network_budget: app.networkBudget,
    transfers: app.execution.transfers,
    acceptance: app.execution.acceptance,
    cooldown_ms: 0,
  });
  const completion = new DatabaseCompletionService({
    library: app.library,
    database: app.database,
    writes: app.writes,
    completion: app.completion,
    acquisition,
    max_concurrency: 4,
  });
  const runner = new ExecutionTaskService(
    app.jobs,
    app.queue,
    app.interventions,
    { completion },
  );
  const tasks = createTaskOperations(app)!;
  let reader: Awaited<ReturnType<typeof createQueryApplication>> | undefined;
  let storageArmed = false,
    storageFailures = 0,
    checkpoint = 0,
    settled = 0,
    blockedAtCheckpoint = 0;
  const prepare = app.files.preparePublication.bind(app.files);
  app.files.preparePublication = async (...args) => {
    if (storageArmed && args[1].startsWith("originals/pdf/")) {
      storageArmed = false;
      storageFailures++;
      emit({ event: "storage-failure", result: { target: args[1] } });
      throw Object.assign(
        new Error("Synthetic one-shot file storage failure"),
        { code: "EIO" },
      );
    }
    return prepare(...args);
  };
  const update = app.jobs.updateTarget.bind(app.jobs);
  app.jobs.updateTarget = async (...args) => {
    const result = await update(...args);
    if (["completed", "skipped", "failed"].includes(args[1])) {
      settled++;
      if (checkpoint && settled >= checkpoint) {
        blockedAtCheckpoint++;
        if (blockedAtCheckpoint === 4)
          emit({
            event: "checkpoint",
            result: {
              settled,
              checkpoint,
              blocked_workers: blockedAtCheckpoint,
            },
          });
        // Checkpoint follows the durable settlement. No timing sleep chooses the
        // crash order: all occupied slots wait here until the parent kills us.
        await new Promise<void>(() => {});
      }
    }
    return result;
  };
  const state = async (jobId: string) => ({
    job: await app.jobs!.getJob(jobId),
    targets: await app.jobs!.listTargets(jobId, 10000),
  });
  const execute = async (operation: string, input: Record<string, unknown>) => {
    switch (operation) {
      case "import": {
        const batch = await app.importSessions.create(
          {
            format: "bibtex",
            source: null,
            file_name: "scale.bib",
            scope: "seeded scale bibliography",
          },
          { kind: "local", origin: "cli" },
        );
        // One file / one session, split only at the existing request byte bound.
        const records = dataset.bibliography.split("\n\n"),
          parts: string[] = [];
        for (let n = 0; n < records.length; n += 500)
          parts.push(records.slice(n, n + 500).join("\n\n"));
        for (const [sequence, data] of parts.entries())
          await app.importSessions.putData(batch.batch_id, sequence, data);
        await app.importSessions.confirm(batch.batch_id);
        const result = await app.importSessions.report(batch.batch_id);
        await app.importSessions.finish(batch.batch_id);
        return {
          batch_id: batch.batch_id,
          summary: result.summary,
          parts: parts.length,
        };
      }
      case "discovery":
        return app.discovery.run({
          origin: "cli",
          query: input.sentinel ? "sentinel" : "scale",
          providers: [
            {
              provider_name: "scale-replay",
              scan_limit: input.sentinel ? 1 : dataset.discovery.length + 1,
            },
          ],
        });
      case "create":
        return tasks.create(input);
      case "state":
        return state(String(input.job_id));
      case "run": {
        checkpoint = Number(input.checkpoint ?? 0);
        settled = 0;
        blockedAtCheckpoint = 0;
        const result = await runner.runJob(String(input.job_id), {
          boot_id: app.bootId,
          max_retries: 0,
        });
        return {
          ...(await state(String(input.job_id))),
          results: result,
          storage_failures: storageFailures,
        };
      }
      case "control":
        return app.processingTasks!.control(
          String(input.job_id),
          input.action as "resume" | "retry",
        );
      case "arm-storage":
        storageArmed = true;
        return { armed: true };
      case "selection":
        return app.library.pdfSelection(input);
      case "flush":
        return app.maintenance!.refreshIndex!();
      case "open-reader":
        await reader?.close();
        reader = await createQueryApplication(home);
        return reader.readiness;
      case "counts":
        return reader!.query!.counts({});
      case "search":
        return reader!.query!.search(input);
      case "stats":
        return {
          recovery: app.executionRecovery,
          forbidden_egress: forbiddenEgress,
          storage_failures: storageFailures,
        };
      case "close":
        await reader?.close();
        await acquisition.close();
        await app.close();
        return { closed: true };
      default:
        throw new Error(`unknown scale operation: ${operation}`);
    }
  };
  process.on(
    "message",
    (raw: {
      id: number;
      operation: string;
      input: Record<string, unknown>;
    }) => {
      void execute(raw.operation, raw.input).then(
        (result) => emit({ id: raw.id, result }),
        (error: unknown) =>
          emit({
            id: raw.id,
            error:
              error instanceof Error
                ? `${error.stack}\nCause: ${String(error.cause)}`
                : String(error),
          }),
      );
    },
  );
  const rss = setInterval(() => emit({ event: "rss" }), 500);
  rss.unref();
  emit({
    event: "ready",
    result: { boot_id: app.bootId, catalog: join(home, "catalog.sqlite") },
  });
} else {
  throw new Error("unknown scale process role");
}
