import {
  parseDocumentReadResult,
  sha256,
  type DocumentMaterialRef,
  type DocumentReadingRef,
  type DocumentResource,
  type DocumentReadOperation,
  type DocumentReadRequestMap,
  type DocumentReadResultMap,
  type EvidenceRef,
  type LiteratureDetail,
} from "@sciretriever/contracts";
import type { ReadingContext } from "./contract.js";
import type { FixedSource } from "./source.js";
import { READER_PROBE, probeCountKey } from "./probe.js";

const operations: Record<DocumentReadOperation, string> = {
  default: "document-default",
  describe: "document-describe",
  outline: "document-outline",
  segments: "document-segments",
  resources: "document-resources",
  slice: "document-slice",
  resource: "document-resource",
  material: "material-evidence",
  evidence: "evidence-resolve",
};
/**
 * Session memory (spec 5.1), cleared when the page closes. A document version
 * never changes, so its reads are kept by version; verified PDF bytes are kept
 * by asset SHA-256. Both evict the least recently used entry first.
 */
const versionReads = new Map<string, { value: unknown; size: number }>();
let versionReadSize = 0;
const VERSION_READ_LIMIT = 64 * 1024 * 1024;
const versionBound = new Set<DocumentReadOperation>([
  "describe",
  "outline",
  "segments",
  "resources",
  "slice",
]);
function remember<V>(
  cache: Map<string, { value: V; size: number }>,
  key: string,
  value: V,
  size: number,
  limit: number,
  used: number,
): number {
  if (size > limit) return used;
  const previous = cache.get(key);
  if (previous) {
    cache.delete(key);
    used -= previous.size;
  }
  cache.set(key, { value, size });
  used += size;
  for (const [old, entry] of cache) {
    if (used <= limit) break;
    cache.delete(old);
    used -= entry.size;
  }
  return used;
}
export async function readDocument<K extends DocumentReadOperation>(
  ctx: ReadingContext,
  kind: K,
  request: DocumentReadRequestMap[K],
): Promise<DocumentReadResultMap[K]> {
  const key =
    versionBound.has(kind) &&
    typeof (request as { document_version_id?: unknown })
      .document_version_id === "string"
      ? JSON.stringify([kind, request])
      : null;
  const cached = key ? versionReads.get(key) : undefined;
  if (key && cached) {
    versionReads.delete(key);
    versionReads.set(key, cached);
    return cached.value as DocumentReadResultMap[K];
  }
  const reply = await ctx.api.query(operations[kind], request, ctx.signal);
  const value = parseDocumentReadResult(kind, reply.result, request);
  if (key)
    versionReadSize = remember(
      versionReads,
      key,
      value as unknown,
      JSON.stringify(reply.result).length * 2,
      VERSION_READ_LIMIT,
      versionReadSize,
    );
  return value;
}
/** Drops a read its caller rejected, so a retry asks the server again. */
export function forgetDocumentRead<K extends DocumentReadOperation>(
  kind: K,
  request: DocumentReadRequestMap[K],
) {
  const key = JSON.stringify([kind, request]),
    entry = versionReads.get(key);
  if (!entry) return;
  versionReads.delete(key);
  versionReadSize -= entry.size;
}
const pdfBytes = new Map<
  string,
  { value: Uint8Array<ArrayBuffer>; size: number }
>();
let pdfBytesSize = 0;
const PDF_BYTES_LIMIT = 256 * 1024 * 1024;
export async function resolveReadingSources(
  ctx: ReadingContext,
  detail: LiteratureDetail,
  source: FixedSource | null,
  mode: "pdf" | "doc",
) {
  const params = new URL(location.href).searchParams,
    id = detail.literature.literature_id;
  let document: DocumentReadingRef | null = null,
    material: DocumentMaterialRef | null = null;
  if (source?.kind === "document" || params.has("document")) {
    const version =
      source?.kind === "document"
        ? source.document_version_id
        : params.get("document")!;
    document = (
      await readDocument(ctx, "describe", { document_version_id: version })
    ).document;
    material = document.source_material_ref;
    if (
      material.literature_id !== id ||
      (source?.kind === "document" &&
        (document.representation_sha256 !== source.representation_sha256 ||
          material.asset_id !== source.asset_id ||
          material.asset_sha256 !== source.asset_sha256))
    )
      throw new Error("固定文档与原来源不匹配，未使用默认材料替代。");
  } else if (source?.kind === "result") {
    throw new Error(
      "请从固定处理结果的证据打开原文，不能以当前默认材料替代历史输入。",
    );
  } else {
    const assetId = params.get("asset") ?? detail.primary_pdf?.asset.asset_id;
    const expectedHash =
      params.get("assetHash") ?? detail.primary_pdf?.asset.sha256;
    if (assetId) {
      const result = await readDocument(ctx, "material", {
        literature_id: id,
        asset_id: assetId,
      });
      if (result.evidence.target_kind !== "material")
        throw new Error("原始材料回执无效");
      material = result.evidence.material;
      if (!expectedHash || material.asset_sha256 !== expectedHash)
        throw new Error("固定 PDF 与来源 hash 不匹配");
    }
  }
  if (material && material.literature_id !== id)
    throw new Error("固定材料不属于当前文献");
  if (mode === "doc" && material && !document) {
    const current = await readDocument(ctx, "default", {
      literature_id: id,
      asset_id: material.asset_id,
      asset_sha256: material.asset_sha256,
    });
    if (current.default)
      document = (
        await readDocument(ctx, "describe", {
          document_version_id: current.default.document_version_id,
        })
      ).document;
  }
  if (material && document) {
    const original = document.source_material_ref;
    if (
      original.literature_id !== material.literature_id ||
      original.asset_id !== material.asset_id ||
      original.asset_sha256 !== material.asset_sha256 ||
      original.byte_size !== material.byte_size ||
      original.media_type !== material.media_type
    )
      throw new Error("固定文档与原始材料不匹配，未打开其他来源。");
  }
  return { material, document };
}
/** `progress` hears the bytes as they arrive, then the start of the hash check (spec 6.3). */
export async function readPdfBytes(
  ctx: ReadingContext,
  material: DocumentMaterialRef,
  progress?: (step: "download" | "verify", done: number, total: number) => void,
): Promise<Uint8Array<ArrayBuffer>> {
  if (
    material.media_type !== "application/pdf" ||
    material.byte_size < 1 ||
    material.byte_size > 256 * 1024 * 1024
  )
    throw new Error("PDF 超过受控读取上限或材料类型不符");
  // Callers may hand their copy to PDF.js, which detaches it; the cache keeps its own.
  const cached = pdfBytes.get(material.asset_sha256);
  if (cached && cached.value.byteLength === material.byte_size) {
    pdfBytes.delete(material.asset_sha256);
    pdfBytes.set(material.asset_sha256, cached);
    return cached.value.slice();
  }
  if (READER_PROBE) probeCountKey("pdfRequests", material.asset_sha256);
  const response = await ctx.api.fetch("/api/v1/query/material-bytes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      protocol_version: 1,
      request: {
        literature_id: material.literature_id,
        asset_id: material.asset_id,
        asset_sha256: material.asset_sha256,
      },
    }),
    signal: ctx.signal,
  });
  if (
    !response.ok ||
    response.headers.get("Content-Type")?.split(";")[0] !== "application/pdf" ||
    response.headers.get("x-sciretriever-asset-id") !== material.asset_id ||
    response.headers.get("x-sciretriever-asset-sha256") !==
      material.asset_sha256 ||
    response.headers.get("x-sciretriever-byte-size") !==
      String(material.byte_size)
  )
    throw new Error("PDF 响应与固定材料不一致");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("PDF 响应无字节");
  const bytes = new Uint8Array(material.byte_size);
  let offset = 0;
  try {
    for (;;) {
      ctx.signal.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) break;
      if (offset + chunk.value.byteLength > bytes.length)
        throw new Error("PDF 响应超过声明大小");
      bytes.set(chunk.value, offset);
      offset += chunk.value.byteLength;
      progress?.("download", offset, bytes.length);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  if (READER_PROBE && offset === bytes.length)
    probeCountKey("pdfHashes", material.asset_sha256);
  progress?.("verify", 0, 1);
  if (
    offset !== bytes.length ||
    (await sha256(bytes)) !== material.asset_sha256
  )
    throw new Error("PDF 完整性校验失败");
  ctx.signal.throwIfAborted();
  pdfBytesSize = remember(
    pdfBytes,
    material.asset_sha256,
    bytes,
    bytes.byteLength,
    PDF_BYTES_LIMIT,
    pdfBytesSize,
  );
  return bytes.slice();
}

/** One whole picture of a fixed document version, checked against its header and hash. */
export async function readResourceBytes(
  ctx: ReadingContext,
  document: DocumentReadingRef,
  resource: DocumentResource,
): Promise<Uint8Array<ArrayBuffer>> {
  const response = await ctx.api.fetch(
    "/api/v1/query/document-resource-bytes",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        protocol_version: 1,
        request: {
          document_version_id: document.document_version_id,
          resource_id: resource.resource_id,
        },
      }),
      signal: ctx.signal,
    },
  );
  // A refused read shows the reader's general "unreadable" message.
  if (!response.ok) throw new Error("document-resource-unavailable");
  const header = (name: string) => response.headers.get(name);
  if (
    header("Content-Type")?.split(";")[0] !== resource.artifact.media_type ||
    header("x-sciretriever-document-version-id") !==
      document.document_version_id ||
    header("x-sciretriever-representation-sha256") !==
      document.representation_sha256 ||
    header("x-sciretriever-resource-id") !== resource.resource_id ||
    header("x-sciretriever-resource-sha256") !== resource.artifact.sha256 ||
    header("x-sciretriever-byte-size") !== String(resource.artifact.byte_size)
  )
    throw new Error("图片响应与固定文档不一致");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("图片响应无字节");
  const bytes = new Uint8Array(resource.artifact.byte_size);
  let offset = 0;
  try {
    for (;;) {
      ctx.signal.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) break;
      if (offset + chunk.value.byteLength > bytes.length)
        throw new Error("图片响应超过声明大小");
      bytes.set(chunk.value, offset);
      offset += chunk.value.byteLength;
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  // A stream cut short by a failed end-of-read check never shows as a picture.
  if (
    offset !== bytes.length ||
    (await sha256(bytes)) !== resource.artifact.sha256
  )
    throw new Error("图片完整性校验失败");
  ctx.signal.throwIfAborted();
  return bytes;
}

export interface EvidencePageCursor {
  continuation: string | null;
  expectedStart: number | null;
}
/** Continuations are bound both to the evidence identity and the preceding byte range. */
export async function readEvidencePage(
  ctx: ReadingContext,
  evidence: EvidenceRef,
  cursor: EvidencePageCursor,
) {
  const result = await readDocument(ctx, "evidence", {
    evidence,
    max_bytes: 65536,
    continuation: cursor.continuation,
  });
  if (
    cursor.expectedStart !== null &&
    result.actual_range?.start_utf8 !== cursor.expectedStart
  )
    throw new Error("证据续读范围不连续，已读取内容仍保留。");
  return result;
}
export function nextEvidencePage(
  result: DocumentReadResultMap["evidence"],
): EvidencePageCursor | null {
  return result.continuation
    ? {
        continuation: result.continuation,
        expectedStart: result.actual_range?.end_utf8 ?? null,
      }
    : null;
}
