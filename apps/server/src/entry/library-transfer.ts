import { createHash } from "node:crypto";
import {
  ContractValidationError,
  parseLiteratureId,
} from "@sciretriever/contracts";
import type { QueryApplication } from "../bootstrap/application.js";
import { prepareBibliographyExport } from "./bibliography-export.js";

export const ARTIFACT_CHUNK_BYTES = 192 * 1024;
export class LibraryTransferError extends Error {
  constructor(
    readonly code:
      | "artifact-not-found"
      | "artifact-changed"
      | "artifact-range"
      | "transfer-cancelled"
      | "query-unavailable",
  ) {
    super("library transfer could not complete");
  }
}
function record(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    throw new ContractValidationError();
  return value as Record<string, unknown>;
}
/** Read only catalog-owned, verified bytes. The fixed hash prevents mixing revisions between chunks. */
export async function readLibraryArtifact(
  q: QueryApplication,
  value: unknown,
  signal?: AbortSignal,
) {
  const r = record(value, [
    "literature_id",
    "kind",
    "expected_sha256",
    "offset",
    "max_bytes",
  ]);
  const id = parseLiteratureId(r.literature_id);
  if (
    (r.kind !== "primary-pdf" && r.kind !== "content-markdown") ||
    !(
      r.expected_sha256 === null ||
      (typeof r.expected_sha256 === "string" &&
        /^[0-9a-f]{64}$/u.test(r.expected_sha256))
    ) ||
    !Number.isSafeInteger(r.offset) ||
    (r.offset as number) < 0 ||
    !Number.isSafeInteger(r.max_bytes) ||
    (r.max_bytes as number) < 1 ||
    (r.max_bytes as number) > ARTIFACT_CHUNK_BYTES ||
    (r.offset !== 0 && r.expected_sha256 === null)
  )
    throw new ContractValidationError();
  if (signal?.aborted) throw new LibraryTransferError("transfer-cancelled");
  if (!q.query || !q.literatureArtifacts)
    throw new LibraryTransferError("query-unavailable");
  const detail = await q.query.detail(id);
  const artifact =
    r.kind === "primary-pdf"
      ? detail.primary_pdf?.asset
      : detail.content?.markdown;
  if (!artifact) throw new LibraryTransferError("artifact-not-found");
  if (r.expected_sha256 !== null && r.expected_sha256 !== artifact.sha256)
    throw new LibraryTransferError("artifact-changed");
  const size =
    "size_bytes" in artifact ? artifact.size_bytes : artifact.byte_size;
  const start = r.offset as number;
  if (start > size) throw new LibraryTransferError("artifact-range");
  const end = Math.min(size, start + (r.max_bytes as number));
  const bytes = Buffer.alloc(end - start);
  let position = 0;
  await q.literatureArtifacts
    .withArtifact(
      artifact,
      async (chunks) => {
        for await (const chunk of chunks) {
          if (signal?.aborted)
            throw new LibraryTransferError("transfer-cancelled");
          const low = Math.max(start, position),
            high = Math.min(end, position + chunk.length);
          if (high > low)
            bytes.set(
              chunk.subarray(low - position, high - position),
              low - start,
            );
          position += chunk.length;
        }
      },
      signal ? { signal } : {},
    )
    .catch((error: unknown) => {
      if (signal?.aborted) throw new LibraryTransferError("transfer-cancelled");
      throw error;
    });
  return {
    literature_id: id,
    kind: r.kind,
    sha256: artifact.sha256,
    byte_size: size,
    media_type: artifact.media_type,
    offset: start,
    next_offset: end < size ? end : null,
    chunk_sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes_base64: bytes.toString("base64"),
  };
}

export async function exportBibliographyRequest(
  q: QueryApplication,
  value: unknown,
) {
  const r = record(value, ["literature_ids", "format"]);
  if (
    !Array.isArray(r.literature_ids) ||
    r.literature_ids.length < 1 ||
    r.literature_ids.length > 100 ||
    typeof r.format !== "string" ||
    !["bibtex", "biblatex", "ris", "csl-json"].includes(r.format)
  )
    throw new ContractValidationError();
  if (!q.query) throw new LibraryTransferError("query-unavailable");
  const prepared = await prepareBibliographyExport(
    q.query,
    {
      kind: "literatures",
      literature_ids: r.literature_ids.map(parseLiteratureId),
    },
    r.format as "bibtex" | "biblatex" | "ris" | "csl-json",
  );
  return {
    format: prepared.format,
    literature_ids: prepared.selected_literature_ids,
    text: Buffer.from(prepared.bytes).toString("utf8"),
    sha256: createHash("sha256").update(prepared.bytes).digest("hex"),
    byte_size: prepared.bytes.byteLength,
  };
}
