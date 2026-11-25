import {
  ContractValidationError,
  IMPORT_LIMITS,
  parseImportData,
  type ImportAdapter,
  type ImportAdapterResult,
} from "@sciretriever/contracts";
import {
  bibliographyRecordInputs,
  decodeBibliography,
  type BibliographyInputFormat,
} from "./bibliography-import.js";
import { bibliographyAttachments } from "./bibliography-attachments.js";
import { webPageAdapter } from "./web-page-adapter.js";
import { lookupAdapter } from "./lookup-adapter.js";
import { zoteroAdapter } from "./zotero-adapter.js";
export { FileClueReader, type FileClues } from "./file-clues.js";

export const nativeImportAdapter: ImportAdapter = {
  format: "records",
  decode(value) {
    const data = parseImportData(value);
    return {
      items: data.records.map((record, record_index) => {
        const valid =
          record.metadata.title !== null ||
          record.metadata.identifiers.some((i) => i.namespace === "doi");
        return {
          external_id: record.external_id,
          record_index,
          record: valid ? record : null,
          reason: valid ? null : "missing-title-or-doi",
        };
      }),
      groups: data.groups,
      excluded: data.excluded,
    };
  },
};
export function bibliographyAdapter(
  format: BibliographyInputFormat,
): ImportAdapter {
  return {
    format,
    decode(value, sequence): ImportAdapterResult {
      if (typeof value !== "string") throw new ContractValidationError();
      const bytes = Buffer.from(value),
        inputs = bibliographyRecordInputs(bytes, format),
        excluded = new Map<string, number>();
      let id = 0;
      const deterministicId = () =>
        `00000000-0000-4000-8000-${String(++id).padStart(12, "0")}`;
      const decoded = decodeBibliography(bytes, format, {
        maxInputBytes: IMPORT_LIMITS.request_bytes,
        observationId: deterministicId,
        provenanceId: deterministicId,
        observedAt: () => "1970-01-01T00:00:00Z",
      });
      const items = decoded.items.map((item) => {
        const input = inputs[item.record_index];
        const attachments = bibliographyAttachments(
          input?.attachment_fields ?? [],
          format === "bibtex" || format === "biblatex",
          sequence,
          item.record_index,
        );
        for (const e of attachments.excluded)
          excluded.set(e.kind, (excluded.get(e.kind) ?? 0) + e.count);
        return {
          record_index: item.record_index,
          reason: item.reason,
          record:
            item.observation === null
              ? null
              : {
                  external_id:
                    input?.external_id ?? `${sequence}:${item.record_index}`,
                  metadata: item.observation.metadata,
                  source_type: item.observation.source_type,
                  groups: [],
                  user_tags: [],
                  files: attachments.files,
                  annotations: [],
                },
        };
      });
      return {
        groups: [],
        excluded: [...excluded].map(([kind, count]) => ({ kind, count })),
        items,
      };
    },
  };
}
/** New formats register pure adapters here; session and authentication remain unchanged. */
export function importAdapters(
  additional: readonly ImportAdapter[] = [],
): ReadonlyMap<string, ImportAdapter> {
  const adapters: ImportAdapter[] = [
    nativeImportAdapter,
    ...(["bibtex", "biblatex", "ris", "csl-json"] as const).map(
      bibliographyAdapter,
    ),
    webPageAdapter,
    lookupAdapter,
    zoteroAdapter,
    ...additional,
  ];
  const result = new Map<string, ImportAdapter>();
  for (const adapter of adapters) {
    if (result.has(adapter.format)) throw new Error("Duplicate import adapter");
    result.set(adapter.format, adapter);
  }
  return result;
}
