import {
  parseMetadataTaskRequest,
  type MetadataTaskRequest,
} from "@sciretriever/contracts";
import {
  MetadataProgressError,
  MetadataSourceRun,
} from "../application/jobs/metadata-progress.js";
import { MetadataProviderFailure } from "../metadata/ports.js";
import type { MetadataRegistry } from "../metadata/registry.js";
import type { LiteratureIdentityService } from "../literature/identity.js";
import type { LiteratureQueryService } from "../literature/query.js";
import type { ExecutionRepository } from "../storage/execution/repository.js";
import type {
  TopicDiscoveryService,
  CitationDiscoveryService,
} from "./discovery.js";
import { sourceProblem } from "../providers/shared/source-problem.js";
import type { SqliteWorker } from "../storage/sqlite/worker.js";
import { writeMetadataItems } from "./metadata-write.js";

function presentDiscoveryReport(
  report:
    | Awaited<ReturnType<TopicDiscoveryService["run"]>>
    | Awaited<ReturnType<CitationDiscoveryService["run"]>>,
) {
  return {
    ...report,
    source_results: report.source_results.map(({ failure, ...row }) => ({
      ...row,
      problem: failure ? sourceProblem(failure.code, "metadata") : null,
    })),
  };
}

export async function executeMetadataTask(
  ports: {
    registry: MetadataRegistry;
    identity: LiteratureIdentityService;
    library: LiteratureQueryService;
    database: SqliteWorker;
    repository: ExecutionRepository;
    topic: TopicDiscoveryService;
    citations: CitationDiscoveryService;
  },
  value: MetadataTaskRequest,
  signal: AbortSignal,
  jobId: string,
  targetId: string,
): Promise<Record<string, unknown>> {
  const request = parseMetadataTaskRequest(value),
    source_run = new MetadataSourceRun(ports.repository, jobId, targetId);
  if (request.kind === "topic")
    return {
      ...presentDiscoveryReport(
        await ports.topic.run({
          query: request.query,
          year_from: request.year_from,
          year_to: request.year_to,
          providers: request.providers.map((p) => ({
            provider_name: p.source,
            scan_limit: p.scan_limit,
          })),
          signal,
          source_run,
        }),
      ),
    };
  if (request.kind === "citation")
    return {
      ...presentDiscoveryReport(
        await ports.citations.run({
          seed_literature_ids: request.seed_literature_ids,
          direction: request.direction,
          max_depth: request.max_depth,
          result_limit: request.result_limit,
          providers: request.providers.map((p) => ({
            provider_name: p.source,
            scan_limit: p.scan_limit,
          })),
          signal,
          source_run,
        }),
      ),
    };
  let calls = 0,
    errors = 0,
    matched = 0,
    interrupted = false;
  for (const literatureId of request.literature_ids) {
    if (signal.aborted) {
      interrupted = true;
      break;
    }
    const detail = await ports.library.detail(literatureId);
    for (const provider of request.providers.map((p) => ({
      provider_name: p.source,
      scan_limit: p.scan_limit,
    }))) {
      if (signal.aborted) {
        interrupted = true;
        break;
      }
      const record = await source_run.begin(
          provider.provider_name,
          "lookup",
          literatureId,
        ),
        key = {
          record_id:
            detail.metadata_observations.find(
              (o) => o.provenance.source_name === provider.provider_name,
            )?.provenance.source_record_id ?? null,
          identifiers: detail.literature.metadata.identifiers,
        };
      calls++;
      let result;
      try {
        result = await record.run(() =>
          ports.registry.service.lookupProvider(
            {
              provider_name: provider.provider_name,
              scan_limit: provider.scan_limit,
              key,
            },
            signal,
            () => record.returned(1),
          ),
        );
      } catch (error) {
        if (error instanceof MetadataProgressError) throw error;
        if (signal.aborted) {
          await record.finish("cancelled");
          interrupted = true;
          break;
        }
        errors++;
        await record.failure(
          error instanceof MetadataProviderFailure
            ? error.failure.code
            : "metadata-source-failed",
          error,
        );
        continue;
      }
      if (result.outcome === "INTERRUPTED" || signal.aborted) {
        await record.finish("cancelled");
        interrupted = true;
        break;
      }
      let hit = false;
      await writeMetadataItems(
        ports.database,
        result.observations,
        async (observation) => {
          const matches =
            observation.provenance.source_name === provider.provider_name &&
            ((key.record_id !== null &&
              key.record_id === observation.provenance.source_record_id) ||
              key.identifiers.some((i) =>
                observation.metadata.identifiers.some(
                  (other) =>
                    i.namespace === other.namespace && i.value === other.value,
                ),
              ));
          if (!matches) {
            await record.rejected();
            return;
          }
          hit = true;
          const decision = await ports.identity.observe(observation);
          if (decision.disposition !== "accepted") {
            await record.rejected();
            return;
          }
          await record.observed(decision.meta_literature_id, decision.created);
          await record.included(decision.meta_literature_id);
        },
      );
      if (hit) matched++;
      if (result.failure) {
        errors++;
        await record.failure(result.failure.code);
      } else await record.finish(hit ? "hit" : "miss");
    }
  }
  return {
    kind: "lookup",
    status: interrupted
      ? "INTERRUPTED"
      : errors === calls && errors > 0
        ? "FAILED"
        : errors
          ? "PARTIAL"
          : "COMPLETED",
    literature_count: request.literature_ids.length,
    matched_count: matched,
  };
}
