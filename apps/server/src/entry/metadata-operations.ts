import type { Application } from "../bootstrap/application.js";
import {
  ContractValidationError,
  parseLiteratureId,
} from "@sciretriever/contracts";
import { ProcessingTaskError } from "../application/jobs/processing.js";
import {
  decodeBibliography,
  importBibliography,
  type BibliographyInputFormat,
} from "./bibliography.js";
import { operationRecord as inputRecord } from "./query-operations.js";
export function createMetadataOperations(app: Application) {
  return {
    discovery: async (value: unknown, signal?: AbortSignal) => {
      if (
        value &&
        typeof value === "object" &&
        "kind" in value &&
        value.kind === "citation"
      ) {
        const r = inputRecord(value, [
          "kind",
          "seed_literature_id",
          "direction",
          "scan_limit",
        ]);
        const seed = parseLiteratureId(r.seed_literature_id);
        if (
          !["references", "cited-by"].includes(String(r.direction)) ||
          typeof r.scan_limit !== "number" ||
          !Number.isSafeInteger(r.scan_limit) ||
          r.scan_limit < 1 ||
          r.scan_limit > 10000
        )
          throw new ContractValidationError();
        if (!app.metadata.reference_selection.length)
          throw new ProcessingTaskError("metadata-unavailable");
        return app.citations.run({
          seed_literature_ids: [seed],
          direction: r.direction as "references" | "cited-by",
          max_depth: 1,
          result_limit: r.scan_limit,
          providers: app.metadata.reference_selection.map((provider_name) => ({
            provider_name,
            scan_limit: r.scan_limit as number,
          })),
          ...(signal ? { signal } : {}),
        });
      }
      const r = inputRecord(
        value,
        ["query"],
        ["scan_limit", "year_from", "year_to"],
      );
      if (
        typeof r.query !== "string" ||
        !r.query.trim() ||
        r.query.length > 8192
      )
        throw new ContractValidationError();
      const limit =
        r.scan_limit ?? app.configuration.sources.metadata.limit ?? 500;
      if (
        typeof limit !== "number" ||
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > 10000
      )
        throw new ContractValidationError();
      const year = (value: unknown): number | null => {
        if (value === undefined || value === null) return null;
        if (
          typeof value !== "number" ||
          !Number.isSafeInteger(value) ||
          value < 1 ||
          value > 9999
        )
          throw new ContractValidationError();
        return value;
      };
      const from = year(r.year_from),
        to = year(r.year_to);
      if (from !== null && to !== null && from > to)
        throw new ContractValidationError();
      if (!app.metadata.topic_selection.length)
        throw new ProcessingTaskError("metadata-unavailable");
      return app.discovery.run({
        query: r.query,
        year_from: from,
        year_to: to,
        providers: app.metadata.topic_selection.map((provider_name) => ({
          provider_name,
          scan_limit: limit,
        })),
        ...(signal ? { signal } : {}),
      });
    },
    importBibliography: async (value: unknown) => {
      const r = inputRecord(value, ["format", "content"]);
      if (
        typeof r.content !== "string" ||
        !["bibtex", "biblatex", "ris", "csl-json"].includes(r.format as string)
      )
        throw new ContractValidationError();
      return importBibliography(
        decodeBibliography(
          new TextEncoder().encode(r.content),
          r.format as BibliographyInputFormat,
        ),
        app.identity,
      );
    },
  };
}
