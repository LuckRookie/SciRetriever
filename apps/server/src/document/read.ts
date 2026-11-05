import type { SqliteAnnotationStorage } from "../storage/structure-annotations.js";
import { segmentLocation, segmentPageRegion, readSegment } from "./location.js";
import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import {
  ContractValidationError,
  parseDocumentReadRequest,
  parseDocumentMaterialBytesRequest,
  parseDocumentSelector,
  documentReadTitle,
  DOCUMENT_READ_MAX_BYTES,
  DOCUMENT_READ_MAX_EVIDENCE,
  parseDocumentMaterialRef,
  parseEvidenceRef,
  sha256,
  type DocumentReadOperation,
  type DocumentReadRequestMap,
  type DocumentMaterialRef,
  type DocumentRef,
  type DocumentStructure,
  type EvidenceRef,
} from "@sciretriever/contracts";
import type { SqliteWorker } from "../storage/sqlite/worker.js";
import { SqliteDocumentStorage } from "./storage.js";

const MAX_MATERIAL_BYTES = 256 * 1024 * 1024;
const decoder = new TextDecoder("utf-8", { fatal: true });

export type { DocumentSelector } from "@sciretriever/contracts";

export class DocumentReadError extends Error {
  constructor(
    readonly code:
      | "document-v3-required"
      | "document-missing"
      | "material-missing"
      | "material-stale"
      | "document-invalid"
      | "document-unsupported"
      | "document-integrity"
      | "document-budget"
      | "document-cancelled"
      | "document-closed",
    options?: ErrorOptions,
  ) {
    super(code, options);
  }
}
function invalid(): never {
  throw new DocumentReadError("document-invalid");
}
function check(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DocumentReadError("document-cancelled");
}
function request<K extends DocumentReadOperation>(
  kind: K,
  value: unknown,
): DocumentReadRequestMap[K] {
  try {
    return parseDocumentReadRequest(kind, value);
  } catch (error) {
    if (error instanceof ContractValidationError) return invalid();
    throw error;
  }
}
function checksum(core: object): string {
  return createHash("sha256").update(JSON.stringify(core)).digest("hex");
}
/** Cursor is an integrity marker, not an authorization token. Every range is revalidated. */
function cursor(
  kind: string,
  version: DocumentRef,
  selector: unknown,
  next: number,
): string {
  const core = {
    kind,
    version: version.document_version_id,
    representation: version.representation_sha256,
    selector,
    next,
  };
  return Buffer.from(
    JSON.stringify({ ...core, checksum: checksum(core) }),
  ).toString("base64url");
}
function cursorPosition(
  value: unknown,
  kind: string,
  version: DocumentRef,
  selector: unknown,
  start: number,
  end: number,
): number {
  if (value === null) return start;
  if (
    typeof value !== "string" ||
    value.length > 1024 ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  )
    invalid();
  let item: Record<string, unknown>;
  try {
    const bytes = Buffer.from(value, "base64url");
    if (bytes.toString("base64url") !== value) invalid();
    const parsed: unknown = JSON.parse(bytes.toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      invalid();
    item = parsed as Record<string, unknown>;
  } catch {
    return invalid();
  }
  const normalizedSelector = (input: unknown): unknown => {
    if (input === null || typeof input === "string") return input;
    try {
      return parseDocumentSelector(input);
    } catch {
      return invalid();
    }
  };
  const actualSelector = normalizedSelector(item.selector);
  const expectedSelector = normalizedSelector(selector);
  const core = {
    kind: item.kind,
    version: item.version,
    representation: item.representation,
    selector: item.selector,
    next: item.next,
  };
  if (
    Object.keys(item).sort().join() !==
      [...Object.keys(core), "checksum"].sort().join() ||
    item.checksum !== checksum(core) ||
    item.kind !== kind ||
    item.version !== version.document_version_id ||
    item.representation !== version.representation_sha256 ||
    JSON.stringify(actualSelector) !== JSON.stringify(expectedSelector) ||
    !Number.isSafeInteger(item.next) ||
    (item.next as number) < start ||
    (item.next as number) >= end
  )
    invalid();
  return item.next as number;
}
function safeEnd(bytes: Uint8Array, start: number, end: number): number {
  for (let at = end; at > start && at >= end - 3; at--) {
    try {
      decoder.decode(bytes.subarray(start, at));
      return at;
    } catch {
      /* try prior UTF-8 boundary */
    }
  }
  return start;
}
function capabilities(document?: DocumentRef) {
  return {
    text: true,
    outline: true,
    resources: true,
    table_context: document?.schema_version === 2,
    figure_caption: document?.schema_version === 2,
    page: document?.schema_version === 2,
    bbox: document?.schema_version === 2,
  } as const;
}
function gaps(document?: DocumentRef) {
  if (document?.schema_version === 2) return [] as const;
  return [
    "table-structure-unavailable",
    "figure-caption-unavailable",
    "page-location-unavailable",
    "bbox-unavailable",
  ] as const;
}
function readingRef(document: DocumentRef) {
  return {
    document_id: document.document_id,
    document_version_id: document.document_version_id,
    representation_sha256: document.representation_sha256,
    source_material_ref: document.source_material_ref,
    locator_scheme: document.locator_scheme,
  };
}
function resourceContext(
  structure: DocumentStructure,
  bytes: Uint8Array,
  reference: string,
) {
  let fence: { marker: string; width: number } | null = null;
  let comment = false;
  let rawHtml = false;
  for (const item of structure.segments) {
    // Corrected segments are blocks, and can contain several Markdown lines.
    const lines = decoder
      .decode(bytes.subarray(item.start_utf8, item.end_utf8))
      .split(/\r?\n/u);
    for (const line of lines) {
      const match = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
      if (fence) {
        if (
          match &&
          match[1]![0] === fence.marker &&
          match[1]!.length >= fence.width &&
          !match[2]!.trim()
        )
          fence = null;
        continue;
      }
      if (match) {
        fence = { marker: match[1]![0]!, width: match[1]!.length };
        continue;
      }
      if (comment) {
        if (line.includes("-->")) comment = false;
        continue;
      }
      if (line.includes("<!--")) {
        comment = !line.includes("-->");
        continue;
      }
      if (rawHtml) {
        if (line.trim() === "") rawHtml = false;
        continue;
      }
      if (/^ {0,3}</u.test(line)) {
        rawHtml = true;
        continue;
      }
      if (/^ {4}|^\t/u.test(line) || /[`~]/u.test(line)) continue;
      const image = /^ {0,3}!\[[^\]\r\n]{0,256}\]\(([^()\s]+)\)[ \t]*$/u.exec(
        line,
      );
      if (image?.[1] === reference) return item;
    }
  }
  return undefined;
}

export class DocumentReadService {
  private readonly verificationScope = new AsyncLocalStorage<{
    bytes: number;
    reserve: ((bytes: number) => void) | undefined;
    versions: Map<
      string,
      {
        version: DocumentRef;
        markdown: Uint8Array;
        structure: DocumentStructure;
      }
    >;
  }>();
  private readonly active = new Set<Promise<unknown>>();
  private stopped = false;
  private closing: Promise<void> | undefined;
  constructor(
    private readonly database: SqliteWorker,
    private readonly storage: SqliteDocumentStorage,
    private readonly annotations: SqliteAnnotationStorage | null = null,
  ) {}

  close(): Promise<void> {
    if (!this.closing) {
      this.stopped = true;
      this.closing = Promise.allSettled([...this.active]).then(() => undefined);
    }
    return this.closing;
  }
  private async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.stopped) throw new DocumentReadError("document-closed");
    const operation = work();
    this.active.add(operation);
    try {
      return await operation;
    } finally {
      this.active.delete(operation);
    }
  }
  /** One logical result read may cite a fixed document many times. Keep only
   * its verified immutable bytes for this operation, never across requests. */
  withReadScope<T>(
    work: () => Promise<T>,
    reserve?: (bytes: number) => void,
  ): Promise<T> {
    if (this.verificationScope.getStore()) return work();
    const scope = {
      bytes: 0,
      reserve,
      versions: new Map<
        string,
        {
          version: DocumentRef;
          markdown: Uint8Array;
          structure: DocumentStructure;
        }
      >(),
    };
    return this.run(() =>
      this.verificationScope.run(scope, async () => {
        try {
          return await work();
        } finally {
          scope.versions.clear();
          scope.bytes = 0;
        }
      }),
    );
  }
  private async version<T>(
    id: string,
    signal: AbortSignal | undefined,
    consume: (
      version: DocumentRef,
      markdown: Uint8Array,
      structure: DocumentStructure,
    ) => Promise<T>,
    reserveVerifiedBytes?: (bytes: number) => void,
  ): Promise<T> {
    check(signal);
    // Budgeted retrieval keeps its own accounting and bypasses this reuse.
    const scope = reserveVerifiedBytes
      ? undefined
      : this.verificationScope.getStore();
    const verified = scope?.versions.get(id);
    if (verified) {
      try {
        const result = await consume(
          verified.version,
          verified.markdown,
          verified.structure,
        );
        check(signal);
        return result;
      } catch (error) {
        if (error instanceof DocumentReadError) throw error;
        throw new DocumentReadError(
          signal?.aborted ? "document-cancelled" : "document-integrity",
          { cause: error },
        );
      }
    }
    if (![15].includes(Number((await this.database.schema()).schema_version)))
      throw new DocumentReadError("document-v3-required");
    let snapshot;
    try {
      snapshot = await this.database.documentVersion(id);
    } catch (error) {
      throw new DocumentReadError("document-integrity", { cause: error });
    }
    if (!snapshot) throw new DocumentReadError("document-missing");
    try {
      const result = await this.storage.withVerifiedDocument(
        id,
        async (version, bytes, structure) => {
          if (
            version.document_version_id !==
              snapshot.version.document_version_id ||
            version.representation_sha256 !==
              snapshot.version.representation_sha256
          )
            throw new Error("document snapshot changed");
          check(signal);
          const weight = bytes.byteLength + version.structure.byte_size;
          if (
            scope &&
            !scope.versions.has(id) &&
            scope.versions.size < 16 &&
            scope.bytes + weight <= 32 * 1024 * 1024
          ) {
            scope.bytes += weight;
            scope.versions.set(id, { version, markdown: bytes, structure });
          }
          return consume(version, bytes, structure);
        },
        signal,
        (bytes) => {
          this.verificationScope.getStore()?.reserve?.(bytes);
          reserveVerifiedBytes?.(bytes);
        },
      );
      check(signal);
      return result;
    } catch (error) {
      if (error instanceof DocumentReadError) throw error;
      if (signal?.aborted)
        throw new DocumentReadError("document-cancelled", { cause: error });
      throw new DocumentReadError("document-integrity", { cause: error });
    }
  }

  /** Internal read port for retrieval: one exact closure verification for selected units. */
  withVerifiedVersion<T>(
    documentVersionId: string,
    consume: (
      version: DocumentRef,
      markdown: Uint8Array,
      structure: DocumentStructure,
    ) => Promise<T>,
    signal?: AbortSignal,
    reserveVerifiedBytes?: (bytes: number) => void,
  ): Promise<T> {
    return this.run(() =>
      this.version(documentVersionId, signal, consume, reserveVerifiedBytes),
    );
  }

  parts(
    literatureId: string,
    offset: number,
    limit: number,
    signal?: AbortSignal,
  ) {
    return this.run(async () => {
      check(signal);
      const value = await this.database.documentParts(
        literatureId,
        offset,
        limit,
      );
      check(signal);
      return value;
    });
  }
  /** Human audit surface; intentionally absent from processor document tools. */
  corrections(value: unknown, signal?: AbortSignal) {
    return this.run(async () => {
      if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        Object.keys(value).sort().join() !==
          "continuation,document_version_id,max_bytes,segment_id"
      )
        invalid();
      const r = value as Record<string, unknown>;
      const selected = request("slice", {
        document_version_id: r.document_version_id,
        selector: { kind: "segment", segment_id: r.segment_id },
        max_bytes: r.max_bytes,
        continuation: r.continuation,
      });
      return this.version(
        selected.document_version_id,
        signal,
        async (document, _bytes, structure) => {
          if (document.schema_version !== 2)
            throw new DocumentReadError("document-unsupported");
          const segment = structure.segments.find(
            (s) => s.segment_id === r.segment_id,
          );
          if (!segment) invalid();
          const corrections = await this.storage.corrections(
            document,
            String(r.segment_id),
            signal,
          );
          // Correction records can exceed a response budget. A fixed-version JSON stream is lossless and resumable.
          const bytes = Buffer.from(JSON.stringify(corrections));
          const start = cursorPosition(
            selected.continuation,
            "corrections",
            document,
            selected.selector,
            0,
            bytes.length,
          );
          const end = safeEnd(
            bytes,
            start,
            Math.min(bytes.length, start + selected.max_bytes),
          );
          if (end <= start) invalid();
          return {
            document: readingRef(document),
            segment_id: r.segment_id,
            location: segmentLocation(segment),
            encoding: "json-utf8",
            text: decoder.decode(bytes.subarray(start, end)),
            actual_range: { start_utf8: start, end_utf8: end },
            total_bytes: bytes.length,
            continuation:
              end < bytes.length
                ? cursor("corrections", document, selected.selector, end)
                : null,
          };
        },
      );
    });
  }
  describe(value: unknown, signal?: AbortSignal) {
    return this.run(async () => {
      const r = request("describe", value);
      const id = r.document_version_id;
      return this.version(id, signal, async (document, _bytes, structure) => ({
        document: readingRef(document),
        capabilities: capabilities(document),
        gaps: gaps(document),
        section_count: structure.sections.length,
        segment_count: structure.segments.length,
        resource_count: document.resources.length,
        long_document:
          "long_document" in structure ? structure.long_document : null,
        ...("layout" in structure && structure.layout
          ? { layout: structure.layout }
          : {}),
      }));
    });
  }
  default(value: unknown, signal?: AbortSignal) {
    return this.run(async () => {
      const r = request("default", value);
      const literature = r.literature_id;
      const asset = r.asset_id;
      check(signal);
      if (![15].includes(Number((await this.database.schema()).schema_version)))
        throw new DocumentReadError("document-v3-required");
      const material = await this.database.documentMaterial(literature, asset);
      if (!material || material.material.asset_sha256 !== r.asset_sha256)
        throw new DocumentReadError("material-missing");
      const current = await this.database.documentDefault(
        literature,
        asset,
        r.asset_sha256,
      );
      check(signal);
      return {
        material: material.material,
        default: current,
        gap: current ? null : "document-missing",
      };
    });
  }
  private async annotation(
    id: string,
    selected: string | null | undefined,
    signal?: AbortSignal,
  ) {
    if (!this.annotations) {
      if (selected) invalid();
      return null;
    }
    const a = selected
      ? await this.annotations.byId(selected, signal)
      : await this.annotations.current(id, signal);
    if (selected && !a) invalid();
    if (a && a.document_version_id !== id) invalid();
    return a;
  }
  outline(value: unknown, signal?: AbortSignal) {
    return this.run(async () => {
      const r = request("outline", value);
      const id = r.document_version_id;
      const limit = r.limit;
      return this.version(id, signal, async (document, _bytes, structure) => {
        const annotation = await this.annotation(id, r.annotation_id, signal);
        const roles = new Map(
          annotation?.sections.map((s) => [s.section_id, s]),
        );
        const selected = annotation?.annotation_id ?? null;
        const start = cursorPosition(
          r.cursor,
          "outline",
          document,
          selected,
          0,
          structure.sections.length + 1,
        );
        const items = structure.sections
          .slice(start, start + limit)
          .map((item) => ({
            ...item,
            ...(roles.has(item.section_id)
              ? {
                  role: roles.get(item.section_id)!.role,
                  role_source: roles.get(item.section_id)!.role_source,
                }
              : {}),
            ...documentReadTitle(item.title),
          }));
        const next = start + items.length;
        return {
          ...(annotation ? { annotation_id: annotation.annotation_id } : {}),
          document: readingRef(document),
          sections: items,
          total: structure.sections.length,
          next_cursor:
            next < structure.sections.length
              ? cursor("outline", document, selected, next)
              : null,
          capabilities: capabilities(document),
          gaps: items.some((item) => item.title_truncated)
            ? [...gaps(document), "outline-title-truncated"]
            : gaps(document),
        };
      });
    });
  }
  segments(value: unknown, signal?: AbortSignal) {
    return this.run(async () => {
      const r = request("segments", value);
      const id = r.document_version_id;
      const limit = r.limit;
      const sectionId = r.section_id;
      return this.version(id, signal, async (document, _bytes, structure) => {
        if (
          sectionId !== null &&
          !structure.sections.some((s) => s.section_id === sectionId)
        )
          invalid();
        const annotation = await this.annotation(id, r.annotation_id, signal);
        if (r.roles?.length && !annotation) invalid();
        const roles = new Map(
          annotation?.segment_roles.map((s) => [s.segment_id, s.role]),
        );
        const selector =
          annotation || r.roles?.length
            ? {
                section_id: sectionId,
                annotation_id: annotation?.annotation_id ?? null,
                roles: r.roles ?? [],
              }
            : sectionId;
        const candidates =
          sectionId === null
            ? structure.segments
            : structure.segments.filter((s) => s.section_id === sectionId);
        const items = r.roles?.length
          ? candidates.filter((s) =>
              r.roles!.some((role) => role === roles.get(s.segment_id)),
            )
          : candidates;
        const start = cursorPosition(
          r.cursor,
          "segments",
          document,
          selector,
          0,
          items.length + 1,
        );
        const page = items.slice(start, start + limit);
        const next = start + page.length;
        return {
          ...(annotation ? { annotation_id: annotation.annotation_id } : {}),
          document: readingRef(document),
          segments: page.map(readSegment),
          total: items.length,
          next_cursor:
            next < items.length
              ? cursor("segments", document, selector, next)
              : null,
          capabilities: capabilities(document),
          gaps: gaps(document),
        };
      });
    });
  }
  resources(value: unknown, signal?: AbortSignal) {
    return this.run(async () => {
      const r = request("resources", value);
      const id = r.document_version_id;
      const limit = r.limit;
      return this.version(id, signal, async (document) => {
        const start = cursorPosition(
          r.cursor,
          "resources",
          document,
          null,
          0,
          document.resources.length + 1,
        );
        const page = document.resources.slice(start, start + limit);
        const next = start + page.length;
        return {
          document: readingRef(document),
          resources: page,
          total: document.resources.length,
          next_cursor:
            next < document.resources.length
              ? cursor("resources", document, null, next)
              : null,
          capabilities: capabilities(document),
          gaps: gaps(document),
        };
      });
    });
  }
  slice(value: unknown, signal?: AbortSignal) {
    return this.run(async () => {
      const r = request("slice", value);
      const id = r.document_version_id;
      const max = r.max_bytes;
      const selector = r.selector;
      const s = selector;
      const selectedId =
        s.kind === "section"
          ? s.section_id
          : s.kind === "segment"
            ? s.segment_id
            : s.kind === "resource-context"
              ? s.resource_id
              : null;
      return this.version(id, signal, async (document, bytes, structure) => {
        const resource =
          s.kind === "resource-context"
            ? document.resources.find((item) => item.resource_id === selectedId)
            : undefined;
        const context = resource
          ? resourceContext(structure, bytes, resource.reference)
          : undefined;
        const selected =
          s.kind === "section"
            ? structure.sections.find((item) => item.section_id === selectedId)
            : s.kind === "segment"
              ? structure.segments.find(
                  (item) => item.segment_id === selectedId,
                )
              : s.kind === "resource-context"
                ? context
                : s.end_utf8 <= bytes.length
                  ? { start_utf8: s.start_utf8, end_utf8: s.end_utf8 }
                  : undefined;
        if (resource && !context)
          return {
            document: readingRef(document),
            selector,
            actual_range: null,
            text: "",
            evidence: [],
            related_resources: [resource],
            truncated: false,
            continuation: null,
            capabilities: capabilities(document),
            gaps: [...gaps(document), "resource-context-unavailable"],
          };
        if (!selected) invalid();
        const start = cursorPosition(
          r.continuation,
          "slice",
          document,
          selector,
          selected.start_utf8,
          selected.end_utf8,
        );
        let end = safeEnd(
          bytes,
          start,
          Math.min(selected.end_utf8, start + max),
        );
        if (end <= start) invalid();
        let evidencePageLimit = false;
        let complete = 0;
        let lastCompleteEnd = start;
        for (let index = 0; index < structure.segments.length; index++) {
          if (index % 256 === 0) {
            check(signal);
            await yieldToEventLoop();
          }
          const item = structure.segments[index]!;
          if (item.end_utf8 <= start) continue;
          if (item.start_utf8 >= end) break;
          if (item.start_utf8 >= start && item.end_utf8 <= end) {
            if (complete === DOCUMENT_READ_MAX_EVIDENCE) {
              end = lastCompleteEnd;
              evidencePageLimit = true;
              break;
            }
            complete++;
            lastCompleteEnd = item.end_utf8;
          }
        }
        if (end <= start) invalid();
        const text = decoder.decode(bytes.subarray(start, end));
        const covered = structure.segments.filter(
          (item) => item.start_utf8 >= start && item.end_utf8 <= end,
        );
        const partialSegment = structure.segments.some(
          (item) =>
            item.start_utf8 < end &&
            item.end_utf8 > start &&
            (item.start_utf8 < start || item.end_utf8 > end),
        );
        const evidence: EvidenceRef[] = [];
        for (const [index, item] of covered.entries()) {
          if (index % 8 === 0) {
            check(signal);
            await yieldToEventLoop();
          }
          evidence.push(
            parseEvidenceRef({
              schema_version: 1,
              target_kind: "document",
              locator_scheme: "utf8-segment-v1",
              document_version_id: document.document_version_id,
              representation_sha256: document.representation_sha256,
              locator: { kind: "segment", segment_id: item.segment_id },
              ...(segmentPageRegion(item)
                ? { page_region: segmentPageRegion(item) }
                : {}),
              content_sha256: await sha256(
                bytes.subarray(item.start_utf8, item.end_utf8),
              ),
            }),
          );
        }
        const truncated = end < selected.end_utf8;
        check(signal);
        return {
          document: readingRef(document),
          selector,
          actual_range: { start_utf8: start, end_utf8: end },
          text,
          evidence,
          ...(document.schema_version === 2
            ? {
                locations: covered.flatMap((s) => {
                  const location = segmentLocation(s);
                  return location ? [location] : [];
                }),
              }
            : {}),
          related_resources: resource ? [resource] : [],
          truncated,
          continuation: truncated
            ? cursor("slice", document, selector, end)
            : null,
          capabilities: capabilities(document),
          gaps: [
            ...gaps(document),
            ...(partialSegment ? ["partial-segment"] : []),
            ...(evidencePageLimit ? ["evidence-page-limit"] : []),
          ],
        };
      });
    });
  }
  resource(value: unknown, signal?: AbortSignal) {
    return this.run(async () => {
      const r = request("resource", value);
      const id = r.document_version_id;
      const resourceId = r.resource_id;
      const max = r.max_bytes;
      return this.version(id, signal, async (document) => {
        const resource = document.resources.find(
          (item) => item.resource_id === resourceId,
        );
        if (!resource) invalid();
        if (
          !/^(image\/(png|jpeg|gif|webp)|text\/plain)$/.test(
            resource.artifact.media_type,
          )
        )
          return {
            document: readingRef(document),
            resource,
            bytes_base64: null,
            actual_range: null,
            truncated: false,
            continuation: null,
            gap: "resource-media-unsupported",
          };
        const start = cursorPosition(
          r.continuation,
          "resource",
          document,
          resourceId,
          0,
          resource.artifact.byte_size,
        );
        const snapshot = await this.database.documentVersion(id);
        const path = snapshot?.resource_artifact_paths[resource.reference];
        if (!path) throw new DocumentReadError("document-integrity");
        const bytes = await this.storage.withVerifiedArtifact(
          path,
          resource.artifact,
          async (chunks) => {
            const parts: Uint8Array[] = [];
            for await (const part of chunks) {
              check(signal);
              parts.push(part);
            }
            return Buffer.concat(parts.map((part) => Buffer.from(part)));
          },
        );
        const end = Math.min(bytes.length, start + max);
        const truncated = end < bytes.length;
        return {
          document: readingRef(document),
          resource,
          bytes_base64: bytes.subarray(start, end).toString("base64"),
          actual_range: { start_byte: start, end_byte: end },
          truncated,
          continuation: truncated
            ? cursor("resource", document, resourceId, end)
            : null,
          gap: null,
        };
      });
    });
  }
  materialEvidence(value: unknown, signal?: AbortSignal) {
    return this.run(async () => {
      const r = request("material", value);
      const literature = r.literature_id;
      const asset = r.asset_id;
      check(signal);
      const located = await this.database.documentMaterial(literature, asset);
      if (!located) throw new DocumentReadError("material-missing");
      if (located.material.byte_size > MAX_MATERIAL_BYTES)
        throw new DocumentReadError("document-unsupported");
      try {
        await this.storage.withVerifiedArtifact(
          located.path,
          located.material.artifact,
          async (chunks) => {
            for await (const chunk of chunks) {
              void chunk;
              check(signal);
            }
          },
        );
      } catch (error) {
        if (error instanceof DocumentReadError) throw error;
        throw new DocumentReadError("document-integrity", { cause: error });
      }
      check(signal);
      return {
        evidence: parseEvidenceRef({
          schema_version: 1,
          target_kind: "material",
          locator_scheme: "material-file-v1",
          material: located.material,
          locator: { kind: "file" },
          content_sha256: located.material.asset_sha256,
        }),
        granularity: "file",
        gaps: ["page-location-unavailable", "field-location-unavailable"],
      };
    });
  }
  withMaterialBytes<T>(
    value: unknown,
    consume: (
      material: DocumentMaterialRef,
      chunks: AsyncIterable<Uint8Array>,
    ) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    return this.run(async () => {
      let selected;
      try {
        selected = parseDocumentMaterialBytesRequest(value);
      } catch (error) {
        if (error instanceof ContractValidationError) return invalid();
        throw error;
      }
      check(signal);
      const located = await this.database.documentMaterial(
        selected.literature_id,
        selected.asset_id,
      );
      if (!located) throw new DocumentReadError("material-missing");
      if (located.material.asset_sha256 !== selected.asset_sha256)
        throw new DocumentReadError("material-stale");
      if (located.material.byte_size > MAX_MATERIAL_BYTES)
        throw new DocumentReadError("document-unsupported");
      let consumerError: unknown;
      try {
        const result = await this.storage.withVerifiedArtifact(
          located.path,
          located.material.artifact,
          async (chunks) => {
            try {
              return await consume(located.material, {
                async *[Symbol.asyncIterator]() {
                  for await (const chunk of chunks) {
                    check(signal);
                    yield chunk;
                  }
                },
              });
            } catch (error) {
              consumerError = error;
              throw error;
            }
          },
          signal,
        );
        check(signal);
        return result;
      } catch (error) {
        if (error instanceof DocumentReadError) throw error;
        if (signal?.aborted)
          throw new DocumentReadError("document-cancelled", { cause: error });
        if (error === consumerError) throw error;
        throw new DocumentReadError("document-integrity", { cause: error });
      }
    });
  }
  resolveEvidence(value: unknown, signal?: AbortSignal) {
    return this.run(async () => {
      const wrapped =
        value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        "evidence" in value
          ? value
          : {
              evidence: value,
              max_bytes: DOCUMENT_READ_MAX_BYTES,
              continuation: null,
            };
      const raw = (wrapped as { evidence: unknown }).evidence;
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        const candidate = raw as Record<string, unknown>;
        const scheme =
          candidate.target_kind === "material"
            ? "material-file-v1"
            : candidate.target_kind === "document"
              ? "utf8-segment-v1"
              : null;
        if (
          candidate.schema_version !== 1 ||
          scheme === null ||
          candidate.locator_scheme !== scheme
        )
          throw new DocumentReadError("document-unsupported");
        if (
          candidate.target_kind === "material" &&
          typeof candidate.content_sha256 === "string" &&
          /^[a-f0-9]{64}$/.test(candidate.content_sha256) &&
          candidate.material &&
          typeof candidate.material === "object" &&
          candidate.content_sha256 !==
            (candidate.material as Record<string, unknown>).asset_sha256
        )
          throw new DocumentReadError("document-integrity");
      }
      const r = request("evidence", wrapped);
      const evidence = r.evidence;
      const maxBytes = r.max_bytes;
      const continuation = r.continuation;
      if (evidence.target_kind === "material") {
        if (continuation !== null) invalid();
        const result = await this.materialEvidenceInner(evidence, signal);
        check(signal);
        return { evidence, ...result };
      }
      return this.version(
        evidence.document_version_id,
        signal,
        async (document, bytes, structure) => {
          if (document.representation_sha256 !== evidence.representation_sha256)
            throw new DocumentReadError("document-integrity");
          const segment = structure.segments.find(
            (item) => item.segment_id === evidence.locator.segment_id,
          );
          if (!segment) invalid();
          const content = bytes.subarray(segment.start_utf8, segment.end_utf8);
          const contentHash = await sha256(content);
          check(signal);
          if (
            evidence.content_sha256 !== null &&
            evidence.content_sha256 !== contentHash
          )
            throw new DocumentReadError("document-integrity");
          if (
            evidence.page_region &&
            JSON.stringify(evidence.page_region) !==
              JSON.stringify(segmentPageRegion(segment))
          )
            throw new DocumentReadError("document-integrity");
          const location = segmentLocation(segment);
          const start = cursorPosition(
            continuation,
            "evidence",
            document,
            evidence.locator,
            segment.start_utf8,
            segment.end_utf8,
          );
          const end = safeEnd(
            bytes,
            start,
            Math.min(segment.end_utf8, start + maxBytes),
          );
          if (end <= start) invalid();
          const truncated = end < segment.end_utf8;
          check(signal);
          return {
            evidence,
            document: readingRef(document),
            granularity: "segment",
            ...(location ? { location } : {}),
            target_range: {
              start_utf8: segment.start_utf8,
              end_utf8: segment.end_utf8,
            },
            actual_range: { start_utf8: start, end_utf8: end },
            text: decoder.decode(bytes.subarray(start, end)),
            content_sha256: contentHash,
            truncated,
            continuation: truncated
              ? cursor("evidence", document, evidence.locator, end)
              : null,
            gaps: gaps(document),
          };
        },
      );
    });
  }
  private async materialEvidenceInner(
    evidence: Extract<EvidenceRef, { target_kind: "material" }>,
    signal?: AbortSignal,
  ) {
    check(signal);
    const located = await this.database.documentMaterial(
      evidence.material.literature_id,
      evidence.material.asset_id,
    );
    if (!located) throw new DocumentReadError("material-missing");
    if (
      JSON.stringify(parseDocumentMaterialRef(located.material)) !==
      JSON.stringify(evidence.material)
    )
      throw new DocumentReadError("document-integrity");
    if (located.material.byte_size > MAX_MATERIAL_BYTES)
      throw new DocumentReadError("document-unsupported");
    try {
      await this.storage.withVerifiedArtifact(
        located.path,
        located.material.artifact,
        async (chunks) => {
          for await (const chunk of chunks) {
            void chunk;
            check(signal);
          }
        },
      );
    } catch (error) {
      if (error instanceof DocumentReadError) throw error;
      throw new DocumentReadError("document-integrity", { cause: error });
    }
    check(signal);
    return {
      material: located.material,
      granularity: "file",
      gaps: ["page-location-unavailable", "field-location-unavailable"],
    };
  }
}
