import { createHash, randomUUID } from "node:crypto";
import {
  ContractValidationError,
  parseLiteratureId,
} from "@sciretriever/contracts";
import type { Application } from "../bootstrap/application.js";
import { operationRecord } from "../entry/query-operations.js";

const FILE_LIMIT = 16 * 1024 * 1024;
const CHUNK_LIMIT = 192 * 1024;
const TTL = 10 * 60 * 1000;
interface Upload {
  literature_id: string;
  sha256: string;
  bytes: Buffer;
  received: number;
  expires: number;
}
export class PdfUploadError extends Error {
  constructor(
    readonly code:
      | "upload-unavailable"
      | "upload-budget"
      | "upload-offset"
      | "upload-integrity",
  ) {
    super("PDF upload rejected");
  }
}
/** Per MCP connection transport buffers; no server file paths or catalog facts. */
export class PdfUploads {
  private readonly pending = new Map<string, Upload>();
  private closed = false;
  private committingBytes = 0;
  private committingCount = 0;
  private readonly timer = setInterval(() => this.expire(), 30000).unref();
  private expire() {
    for (const [id, upload] of this.pending)
      if (upload.expires <= Date.now()) this.pending.delete(id);
  }
  begin(value: unknown) {
    const r = operationRecord(value, ["literature_id", "sha256", "byte_size"]);
    const literature_id = parseLiteratureId(r.literature_id);
    if (
      typeof r.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/u.test(r.sha256) ||
      !Number.isSafeInteger(r.byte_size) ||
      (r.byte_size as number) < 1 ||
      (r.byte_size as number) > FILE_LIMIT
    )
      throw new ContractValidationError();
    this.expire();
    if (this.closed) throw new PdfUploadError("upload-unavailable");
    const size = r.byte_size as number;
    const allocated = [...this.pending.values()].reduce(
      (n, u) => n + u.bytes.length,
      0,
    );
    if (
      this.pending.size + this.committingCount >= 4 ||
      allocated + this.committingBytes + size > 2 * FILE_LIMIT
    )
      throw new PdfUploadError("upload-budget");
    const upload_id = randomUUID();
    const expires = Date.now() + TTL;
    this.pending.set(upload_id, {
      literature_id,
      sha256: r.sha256,
      bytes: Buffer.alloc(size),
      received: 0,
      expires,
    });
    return {
      upload_id,
      max_chunk_bytes: CHUNK_LIMIT,
      expires_at: new Date(expires).toISOString(),
    };
  }
  private get(id: unknown): Upload {
    if (typeof id !== "string") throw new ContractValidationError();
    this.expire();
    const upload = this.pending.get(id);
    if (this.closed || !upload) throw new PdfUploadError("upload-unavailable");
    return upload;
  }
  append(value: unknown) {
    const r = operationRecord(value, ["upload_id", "offset", "bytes_base64"]);
    const upload = this.get(r.upload_id);
    if (
      !Number.isSafeInteger(r.offset) ||
      (r.offset as number) < 0 ||
      typeof r.bytes_base64 !== "string" ||
      r.bytes_base64.length > Math.ceil(CHUNK_LIMIT / 3) * 4
    )
      throw new ContractValidationError();
    const chunk = Buffer.from(r.bytes_base64, "base64");
    if (
      !chunk.length ||
      chunk.length > CHUNK_LIMIT ||
      chunk.toString("base64") !== r.bytes_base64
    )
      throw new ContractValidationError();
    const offset = r.offset as number;
    if (
      offset < upload.received &&
      offset + chunk.length <= upload.received &&
      upload.bytes.subarray(offset, offset + chunk.length).equals(chunk)
    )
      return { received_bytes: upload.received };
    if (
      offset !== upload.received ||
      offset + chunk.length > upload.bytes.length
    )
      throw new PdfUploadError("upload-offset");
    upload.bytes.set(chunk, offset);
    upload.received += chunk.length;
    return { received_bytes: upload.received };
  }
  async commit(
    value: unknown,
    application: () => Promise<Application>,
    signal: AbortSignal,
  ) {
    const r = operationRecord(value, ["upload_id"]);
    const upload = this.get(r.upload_id);
    if (
      upload.received !== upload.bytes.length ||
      createHash("sha256").update(upload.bytes).digest("hex") !== upload.sha256
    )
      throw new PdfUploadError("upload-integrity");
    signal.throwIfAborted();
    // Consume before awaiting: simultaneous commits cannot publish the same buffer twice.
    this.pending.delete(r.upload_id as string);
    this.committingBytes += upload.bytes.length;
    this.committingCount++;
    try {
      const app = await application();
      if (!app.maintenance) throw new PdfUploadError("upload-unavailable");
      return await app.maintenance.ingestPdf(
        { literature_id: upload.literature_id, bytes: upload.bytes },
        signal,
      );
    } finally {
      this.committingBytes -= upload.bytes.length;
      this.committingCount--;
    }
  }
  discard(value: unknown) {
    const r = operationRecord(value, ["upload_id"]);
    if (typeof r.upload_id !== "string") throw new ContractValidationError();
    return { discarded: this.pending.delete(r.upload_id) };
  }
  close() {
    this.closed = true;
    clearInterval(this.timer);
    this.pending.clear();
  }
}
