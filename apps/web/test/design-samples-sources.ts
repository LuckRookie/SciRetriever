import { randomUUID } from "node:crypto";
import type { LiteratureId } from "@sciretriever/contracts";
import type { Application } from "../../server/src/bootstrap/application.js";
import { sourceProblem } from "../../server/src/providers/shared/source-problem.js";

/**
 * Acquisition tasks for plan 17 · 03, written as the same per-source task events
 * production records; their summaries come from the production reducer, so the
 * charts, tables and statistics are checked against real aggregation, not a copy.
 * Nothing runs: the jobs stay queued and no source is contacted.
 */
export async function seedSourceResultTasks(
  app: Application,
  papers: readonly string[],
) {
  const at = "2026-10-28T02:00:00.000Z";
  const event = (job: string, kind: string, payload: unknown) =>
    app.jobs!.appendEvent({
      event_id: randomUUID(),
      job_id: job,
      sequence: -1,
      kind,
      payload,
      created_at: new Date().toISOString(),
    });
  const stage = (source: string) =>
    ({
      elsevier: "publisher-api",
      wiley: "publisher-api",
      core: "general-api",
      "doi-landing": "public-web",
      "sci-hub": "public-web",
      browser: "browser",
    })[source] ?? "direct";

  // Ten papers, mirroring the page spec: Elsevier 3, Wiley 2, Browser 2, three not obtained.
  const pdfPapers = papers.slice(1, 11) as LiteratureId[];
  const pdf = await app.jobService!.create({
    target_kind: "selector",
    selector: { kind: "literatures", literature_ids: pdfPapers },
    goal: "pdf",
    policy_version: "design-sample",
    policy: { mode: "never", max_retries: 0 },
    idempotency_key: "design-source-results-pdf",
  });
  const targets = await app.jobs!.listTargets(pdf.job_id, 100);
  type Try = [source: string, result: string, extra?: Record<string, unknown>];
  const plans: [tries: Try[], channel: string | null][] = [
    [[["elsevier", "hit"]], "elsevier"],
    [[["elsevier", "hit"]], "elsevier"],
    [[["elsevier", "hit"]], "elsevier"],
    [
      [
        ["elsevier", "miss"],
        ["wiley", "hit"],
      ],
      "wiley",
    ],
    [
      [
        ["elsevier", "miss"],
        ["wiley", "hit"],
      ],
      "wiley",
    ],
    [
      [
        ["elsevier", "miss"],
        [
          "wiley",
          "failed",
          {
            code: "publisher-fulltext-forbidden",
            problem: {
              display: "no-fulltext-permission",
              technical_details: {
                diagnostics: [
                  { code: "publisher-fulltext-forbidden", scope: "pdf" },
                ],
              },
            },
          },
        ],
        ["doi-landing", "miss"],
        ["browser", "escalated"],
        ["browser", "hit"],
      ],
      "browser",
    ],
    [
      [
        ["elsevier", "miss"],
        ["doi-landing", "miss"],
        ["browser", "escalated"],
        ["browser", "hit"],
      ],
      "browser",
    ],
    [
      [
        ["elsevier", "miss"],
        ["wiley", "cooldown"],
        ["sci-hub", "miss"],
      ],
      null,
    ],
    [
      [
        [
          "elsevier",
          "failed",
          {
            code: "candidate-download-failed",
            problem: sourceProblem("candidate-download-failed", "pdf"),
          },
        ],
        ["sci-hub", "miss"],
      ],
      null,
    ],
    [[["sci-hub", "miss"]], null],
  ];
  for (const [index, [tries, channel]] of plans.entries()) {
    const target = targets[index]!,
      literature = String(target.literature_id),
      attempt_id = randomUUID();
    for (const [source, result, extra] of tries)
      await event(pdf.job_id, "acquisition-attempt", {
        target_id: target.target_id,
        attempt_id,
        literature_id: literature,
        attempt: {
          stage: stage(source),
          source,
          started_at: at,
          finished_at: at,
          requested: !["escalated", "cooldown", "not-enabled"].includes(result),
          result,
          ...extra,
        },
      });
    await event(pdf.job_id, "pdf-source-result", {
      target_id: target.target_id,
      result: {
        schema_version: 1,
        literature_id: literature,
        finished_at: at,
        result: channel ? "obtained" : "not-obtained",
        source: channel,
        stage: channel ? stage(channel) : null,
        receipt_id: channel ? `design-receipt-${index}` : null,
        technical_details: { diagnostics: [] },
      },
    });
  }

  const metadataTask = async (
    key: string,
    query: string,
    sources: readonly string[],
  ) => {
    const job = await app.processingTasks!.submit({
      schema_version: 1,
      idempotency_key: key,
      operations: [
        {
          operation: "acquire-metadata",
          request: {
            kind: "topic",
            query,
            year_from: null,
            year_to: null,
            providers: sources.map((source) => ({ source, scan_limit: 200 })),
          },
        },
      ],
    });
    const target = (await app.jobs!.listTargets(job.job_id, 1))[0]!;
    const progress = (
      record: string,
      source: string,
      phase: string,
      extra: Record<string, unknown> = {},
    ) =>
      event(job.job_id, "metadata-source", {
        target_id: target.target_id,
        progress: {
          schema_version: 1,
          record_id: record,
          source,
          purpose: "topic-search",
          role: "primary",
          unit_id: "topic",
          at,
          phase,
          ...extra,
        },
      });
    return { job, progress };
  };
  const ids = (from: number, n: number) =>
    Array.from(
      { length: n },
      (_, i) => `00000000-0000-4000-8000-${String(from + i).padStart(12, "0")}`,
    );
  // Finished topic discovery: three sources overlap, two found nothing usable.
  const finished = await metadataTask(
    "design-source-results-topic",
    "sulfide electrolyte humidity",
    ["openalex", "crossref", "semantic-scholar", "web-of-science", "core"],
  );
  const found: [string, number, number, string[]][] = [
    ["openalex", 32, 0, ids(1, 26)],
    ["crossref", 27, 2, ids(12, 21)],
    ["semantic-scholar", 18, 1, ids(20, 14)],
  ];
  for (const [source, returned, rejected, results] of found) {
    await finished.progress(source, source, "started");
    await finished.progress(source, source, "requested");
    await finished.progress(source, source, "returned", { count: returned });
    if (rejected)
      await finished.progress(source, source, "rejected", { count: rejected });
    for (const [n, id] of results.entries()) {
      await finished.progress(source, source, "observed", {
        result_id: id,
        disposition: n % 3 ? "created" : "matched",
      });
      await finished.progress(source, source, "included", {
        result_id: id,
        disposition: "related",
      });
    }
    await finished.progress(source, source, "finished", {
      result: "hit",
      problem: null,
    });
  }
  await finished.progress("wos", "web-of-science", "started");
  await finished.progress("wos", "web-of-science", "finished", {
    result: "unavailable",
    problem: sourceProblem("metadata-source-credential-missing", "metadata"),
  });
  await finished.progress("core", "core", "started");
  await finished.progress("core", "core", "requested");
  await finished.progress("core", "core", "finished", {
    result: "error",
    problem: sourceProblem("metadata-provider-authorization", "metadata"),
  });
  // Running discovery: one source has returned a first page, another is still waiting.
  const running = await metadataTask(
    "design-source-results-running",
    "solid electrolyte interphase",
    ["openalex", "crossref"],
  );
  await running.progress("r-openalex", "openalex", "started");
  await running.progress("r-openalex", "openalex", "requested");
  await running.progress("r-openalex", "openalex", "returned", { count: 12 });
  for (const id of ids(60, 9)) {
    await running.progress("r-openalex", "openalex", "observed", {
      result_id: id,
      disposition: "created",
    });
    await running.progress("r-openalex", "openalex", "included", {
      result_id: id,
      disposition: "related",
    });
  }
  await running.progress("r-crossref", "crossref", "started");
  await running.progress("r-crossref", "crossref", "requested");
  return {
    pdfTask: pdf.job_id,
    metadataTask: finished.job.job_id,
    metadataRunningTask: running.job.job_id,
  };
}
