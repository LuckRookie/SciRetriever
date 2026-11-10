import {
  ContractValidationError,
  IMPORT_LIMITS,
  parseImportData,
  importObject,
  importInteger,
  importString,
  type ImportAdapter,
  type ImportAdapterResult,
} from "@sciretriever/contracts";
import {
  bibliographyRecordIds,
  decodeBibliography,
  type BibliographyInputFormat,
} from "./bibliography-import.js";

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
      // Only the internal adhoc facade supplies already decoded records. It
      // preserves codec failures and byte encodings without reparsing new text.
      if (typeof value !== "string") {
        const r = importObject(value, ["legacy_decoded"]);
        if (!Array.isArray(r.legacy_decoded))
          throw new ContractValidationError();
        return {
          groups: [],
          excluded: [],
          items: r.legacy_decoded.map((value) => {
            const item = importObject(value, [
              "record_index",
              "record",
              "reason",
            ]);
            return {
              record_index: importInteger(
                item.record_index,
                IMPORT_LIMITS.records,
              ),
              record:
                item.record === null
                  ? null
                  : parseImportData({ records: [item.record] }).records[0]!,
              reason:
                item.reason === null ? null : importString(item.reason, 128),
            };
          }),
        };
      }
      if (typeof value !== "string") throw new ContractValidationError();
      const bytes = Buffer.from(value),
        keys = bibliographyRecordIds(bytes, format);
      let id = 0;
      const deterministicId = () =>
        `00000000-0000-4000-8000-${String(++id).padStart(12, "0")}`;
      const decoded = decodeBibliography(bytes, format, {
        maxInputBytes: IMPORT_LIMITS.request_bytes,
        observationId: deterministicId,
        provenanceId: deterministicId,
        observedAt: () => "1970-01-01T00:00:00Z",
      });
      return {
        groups: [],
        excluded: [],
        items: decoded.items.map((item) => ({
          record_index: item.record_index,
          reason: item.reason,
          record:
            item.observation === null
              ? null
              : {
                  external_id:
                    keys[item.record_index] ??
                    `${sequence}:${item.record_index}`,
                  metadata: item.observation.metadata,
                  source_type: item.observation.source_type,
                  groups: [],
                  user_tags: [],
                  files: [],
                  annotations: [],
                },
        })),
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
    ...additional,
  ];
  const result = new Map<string, ImportAdapter>();
  for (const adapter of adapters) {
    if (result.has(adapter.format)) throw new Error("Duplicate import adapter");
    result.set(adapter.format, adapter);
  }
  return result;
}
