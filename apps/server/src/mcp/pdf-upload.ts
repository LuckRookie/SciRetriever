import { createHash, randomUUID, type Hash } from "node:crypto";
import {
  closeSync,
  createReadStream,
  mkdtempSync,
  openSync,
  readSync,
  rmSync,
  statfsSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ContractValidationError,
  parseLiteratureId,
} from "@sciretriever/contracts";
import type { Application } from "../bootstrap/application.js";
import { operationRecord } from "../entry/query-operations.js";

const CHUNK_LIMIT = 192 * 1024;
const TTL = 10 * 60 * 1000;
interface Upload {
  literature_id: string;
  sha256: string;
  size: number;
  received: number;
  expires: number;
  directory: string;
  path: string;
  fd: number | null;
  hash: Hash;
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
/** Connection-local disk spools. Memory is bounded by a chunk, independent of PDF size. */
export class PdfUploads {
  private readonly pending = new Map<string, Upload>();
  private readonly stop = new AbortController();
  private committingCount = 0;
  private readonly timer = setInterval(() => this.expire(), 30000).unref();
  private dispose(upload: Upload) {
    if (upload.fd !== null) {
      closeSync(upload.fd);
      upload.fd = null;
    }
    rmSync(upload.directory, { recursive: true, force: true });
  }
  private expire() {
    for (const [id, u] of this.pending)
      if (u.expires <= Date.now()) {
        this.pending.delete(id);
        this.dispose(u);
      }
  }
  begin(value: unknown) {
    const r = operationRecord(value, ["literature_id", "sha256", "byte_size"]);
    const literature_id = parseLiteratureId(r.literature_id);
    if (
      typeof r.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/u.test(r.sha256) ||
      !Number.isSafeInteger(r.byte_size) ||
      (r.byte_size as number) < 1
    )
      throw new ContractValidationError();
    this.expire();
    if (this.stop.signal.aborted)
      throw new PdfUploadError("upload-unavailable");
    if (this.pending.size + this.committingCount >= 4)
      throw new PdfUploadError("upload-budget");
    const directory = mkdtempSync(join(tmpdir(), "sciretriever-mcp-upload-"));
    const path = join(directory, "upload.pdf"),
      upload_id = randomUUID(),
      expires = Date.now() + TTL;
    try {
      const fd = openSync(path, "wx+", 0o600);
      this.pending.set(upload_id, {
        literature_id,
        sha256: r.sha256,
        size: r.byte_size as number,
        received: 0,
        expires,
        directory,
        path,
        fd,
        hash: createHash("sha256"),
      });
    } catch {
      rmSync(directory, { recursive: true, force: true });
      throw new PdfUploadError("upload-unavailable");
    }
    return {
      upload_id,
      max_chunk_bytes: CHUNK_LIMIT,
      expires_at: new Date(expires).toISOString(),
    };
  }
  private get(id: unknown) {
    if (typeof id !== "string") throw new ContractValidationError();
    this.expire();
    const u = this.pending.get(id);
    if (this.stop.signal.aborted || !u)
      throw new PdfUploadError("upload-unavailable");
    return u;
  }
  append(value: unknown) {
    const r = operationRecord(value, ["upload_id", "offset", "bytes_base64"]),
      u = this.get(r.upload_id);
    if (
      !Number.isSafeInteger(r.offset) ||
      (r.offset as number) < 0 ||
      typeof r.bytes_base64 !== "string" ||
      r.bytes_base64.length > Math.ceil(CHUNK_LIMIT / 3) * 4
    )
      throw new ContractValidationError();
    const chunk = Buffer.from(r.bytes_base64, "base64"),
      offset = r.offset as number;
    if (
      !chunk.length ||
      chunk.length > CHUNK_LIMIT ||
      chunk.toString("base64") !== r.bytes_base64
    )
      throw new ContractValidationError();
    if (offset < u.received && offset + chunk.length <= u.received) {
      const previous = Buffer.alloc(chunk.length);
      if (
        readSync(u.fd!, previous, 0, previous.length, offset) ===
          previous.length &&
        previous.equals(chunk)
      )
        return { received_bytes: u.received };
    }
    if (offset !== u.received || offset + chunk.length > u.size)
      throw new PdfUploadError("upload-offset");
    const disk = statfsSync(u.directory, { bigint: true });
    if (disk.bavail * disk.bsize < BigInt(256 * 1024 * 1024 + chunk.length))
      throw new PdfUploadError("upload-budget");
    let written = 0;
    while (written < chunk.length) {
      const n = writeSync(
        u.fd!,
        chunk,
        written,
        chunk.length - written,
        offset + written,
      );
      if (!n) throw new PdfUploadError("upload-unavailable");
      written += n;
    }
    u.hash.update(chunk);
    u.received += chunk.length;
    return { received_bytes: u.received };
  }
  async commit(
    value: unknown,
    application: () => Promise<Application>,
    signal: AbortSignal,
  ) {
    const r = operationRecord(value, ["upload_id"]),
      u = this.get(r.upload_id);
    if (u.received !== u.size || u.hash.copy().digest("hex") !== u.sha256)
      throw new PdfUploadError("upload-integrity");
    signal.throwIfAborted();
    this.pending.delete(r.upload_id as string);
    this.committingCount++;
    closeSync(u.fd!);
    u.fd = null;
    const active = AbortSignal.any([signal, this.stop.signal]);
    try {
      const app = await application();
      if (!app.maintenance) throw new PdfUploadError("upload-unavailable");
      active.throwIfAborted();
      const chunks = (async function* () {
        const stream = createReadStream(u.path, {
          highWaterMark: 64 * 1024,
          signal: active,
        });
        try {
          for await (const chunk of stream) yield chunk as Uint8Array;
        } finally {
          stream.destroy();
        }
      })();
      return await app.maintenance.ingestPdfStream(
        {
          literature_id: u.literature_id,
          chunks,
          size_bytes: u.size,
          sha256: u.sha256,
        },
        active,
      );
    } finally {
      this.dispose(u);
      this.committingCount--;
    }
  }
  discard(value: unknown) {
    const r = operationRecord(value, ["upload_id"]);
    if (typeof r.upload_id !== "string") throw new ContractValidationError();
    const u = this.pending.get(r.upload_id);
    if (!u) return { discarded: false };
    this.pending.delete(r.upload_id);
    this.dispose(u);
    return { discarded: true };
  }
  close() {
    this.stop.abort();
    clearInterval(this.timer);
    for (const u of this.pending.values()) this.dispose(u);
    this.pending.clear();
  }
}
