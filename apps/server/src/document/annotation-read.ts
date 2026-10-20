import {
  annotationRecord,
  annotationInteger,
  parseAssetId,
  canonicalJsonBytes,
} from "@sciretriever/contracts";
import { createHash } from "node:crypto";
import { SqliteAnnotationStorage } from "../storage/structure-annotations.js";
import { AnnotationError } from "./annotations.js";
/** Bounded fixed-version JSON stream. A continuation pins the annotation even if current changes. */
export class AnnotationReadService {
  constructor(private readonly storage: SqliteAnnotationStorage) {}
  async read(value: unknown, signal?: AbortSignal) {
    const r = annotationRecord(value, [
      "document_version_id",
      "annotation_id",
      "field",
      "max_bytes",
      "continuation",
    ]);
    const document = parseAssetId(r.document_version_id),
      max = annotationInteger(r.max_bytes, 4, 65536);
    if (!["all", "figures", "references"].includes(String(r.field)))
      throw new AnnotationError("annotation-invalid");
    if (
      r.annotation_id !== null &&
      (typeof r.annotation_id !== "string" ||
        !/^[a-f0-9]{64}$/u.test(r.annotation_id))
    )
      throw new AnnotationError("annotation-invalid");
    let id = r.annotation_id as string | null,
      offset = 0;
    if (r.continuation !== null) {
      if (
        typeof r.continuation !== "string" ||
        r.continuation.length > 1024 ||
        !/^[A-Za-z0-9_-]+$/u.test(r.continuation)
      )
        throw new AnnotationError("annotation-invalid");
      let decoded: unknown;
      try {
        decoded = JSON.parse(
          new TextDecoder("utf8", { fatal: true }).decode(
            Buffer.from(r.continuation, "base64url"),
          ),
        );
      } catch {
        throw new AnnotationError("annotation-invalid");
      }
      const c = annotationRecord(decoded, [
        "document",
        "annotation",
        "field",
        "offset",
        "digest",
      ]);
      const { digest, ...body } = c;
      if (
        c.document !== document ||
        c.field !== r.field ||
        typeof c.annotation !== "string" ||
        !/^[a-f0-9]{64}$/u.test(c.annotation) ||
        (id !== null && id !== c.annotation) ||
        digest !==
          createHash("sha256").update(canonicalJsonBytes(body)).digest("hex")
      )
        throw new AnnotationError("annotation-invalid");
      id = c.annotation;
      offset = annotationInteger(c.offset, 1);
    }
    const a = id
      ? await this.storage.byId(id, signal)
      : await this.storage.current(document, signal);
    if (!a) throw new AnnotationError("annotation-missing");
    if (a.document_version_id !== document)
      throw new AnnotationError("annotation-invalid");
    const data =
      r.field === "figures"
        ? a.figures.map((f) => ({ ...f, page: f.page + 1 }))
        : r.field === "references"
          ? a.references
          : a;
    const bytes = Buffer.from(canonicalJsonBytes(data));
    if (offset >= bytes.length && offset !== 0)
      throw new AnnotationError("annotation-invalid");
    if (offset > 0 && (bytes[offset]! & 0xc0) === 0x80)
      throw new AnnotationError("annotation-invalid");
    let end = Math.min(offset + max, bytes.length);
    while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
    const body = {
      document,
      annotation: a.annotation_id,
      field: r.field,
      offset: end,
    };
    return {
      document_version_id: document,
      annotation_id: a.annotation_id,
      manual_revision: a.manual_revision,
      field: r.field,
      text: new TextDecoder("utf8", { fatal: true }).decode(
        bytes.subarray(offset, end),
      ),
      continuation:
        end < bytes.length
          ? Buffer.from(
              JSON.stringify({
                ...body,
                digest: createHash("sha256")
                  .update(canonicalJsonBytes(body))
                  .digest("hex"),
              }),
            ).toString("base64url")
          : null,
    };
  }
}
