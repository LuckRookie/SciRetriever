import { sha256, type DocumentMaterialRef } from "@sciretriever/contracts";
import type { ReadingContext } from "./contract.js";
import { READER_PROBE, probeAddKey, probeCountKey } from "./probe.js";
import { remember } from "./session-cache.js";

/**
 * A fixed PDF read by ranges (ADR 0065 section 6 rule 6; reading-experience
 * 5.1, 6.3): PDF.js asks for the parts it needs, so the first page shows
 * before the whole file is in; the rest arrives in the background and the
 * whole SHA-256 is checked once. One loader per asset SHA-256 serves every
 * reader of it, so the bytes are downloaded and hashed once; ranges never
 * overlap. A failed check stops every reader of it, drops the session copy
 * and makes the next open bypass the browser cache.
 */
export const PDF_BLOCK = 64 * 1024;
/** Background requests take up to 2 MB at a time, only while no reader waits. */
const FILL_BLOCKS = 32;
/** An unchecked loader nobody reads keeps what arrived this long, for a reader coming back. */
const LINGER_MS = 10_000;
const PDF_LIMIT = 256 * 1024 * 1024;
const REFETCH_KEY = "sciretriever.pdf-refetch";
const REFETCH_LIMIT = 64;

/** The bytes or the response do not match the record of the fixed material. */
export class PdfMismatchError extends Error {
  constructor(readonly detail: string) {
    super("文件与记录不一致");
    this.name = "PdfMismatchError";
  }
}
/** The bytes could not be read (network, refusal); nothing says they are wrong. */
export class PdfReadError extends Error {
  constructor(readonly detail: string) {
    super("PDF 未能读取完整");
    this.name = "PdfReadError";
  }
}
/** What the reader says when a PDF stops showing: the problem and what can be done. */
export function pdfProblem(error: unknown): {
  message: string;
  retained: string;
  detail: string;
} {
  if (error instanceof PdfMismatchError)
    return {
      message:
        "文件与记录不一致：这份 PDF 的内容与库中的记录不符，已停止显示。",
      retained:
        "重试会重新下载这份 PDF；仍不一致时，库中的文件可能已损坏，需要重新获取 PDF。",
      detail: error.detail,
    };
  return {
    message: "PDF 未能读取完整，已停止显示。",
    retained: "可以重试。",
    detail:
      error instanceof PdfReadError
        ? error.detail
        : error instanceof Error
          ? error.message
          : String(error),
  };
}

/** Verified bytes, by asset SHA-256, at most 256 MB (spec 5.1). */
const verifiedBytes = new Map<
  string,
  { value: Uint8Array<ArrayBuffer>; size: number }
>();
let verifiedSize = 0;
const loaders = new Map<string, Loader>();

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;
function store(): Store | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}
/**
 * Assets whose last check failed: their next reads bypass the browser cache
 * (`cache: "reload"`), which the immutable responses would otherwise serve.
 * Kept in local storage too, so a reload of the page does not take the
 * cached bytes again; cleared once a check passes.
 */
const refetchNow = new Set<string>();
function refetchList(storage: Store): string[] {
  try {
    const value: unknown = JSON.parse(storage.getItem(REFETCH_KEY) ?? "[]");
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}
function mustRefetch(hash: string): boolean {
  if (refetchNow.has(hash)) return true;
  const storage = store();
  return !!storage && refetchList(storage).includes(hash);
}
function markRefetch(hash: string, on: boolean) {
  if (on) refetchNow.add(hash);
  else refetchNow.delete(hash);
  const storage = store();
  if (!storage) return;
  try {
    const list = refetchList(storage).filter((item) => item !== hash);
    if (on) list.push(hash);
    list.splice(0, Math.max(0, list.length - REFETCH_LIMIT));
    if (list.length) storage.setItem(REFETCH_KEY, JSON.stringify(list));
    else storage.removeItem(REFETCH_KEY);
  } catch {
    // Storage refused: this session still refetches.
  }
}

function deferred() {
  let resolve!: () => void, reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  // Every reader handles the outcome itself; an unread failure is not unhandled.
  promise.catch(() => undefined);
  return { promise, resolve, reject };
}
export function materialBytesPath(material: DocumentMaterialRef): string {
  return `/api/v1/query/material-bytes/${[
    material.literature_id,
    material.asset_id,
    material.asset_sha256,
  ]
    .map(encodeURIComponent)
    .join("/")}`;
}
/** A response's headers against the fixed material and the range asked for; null when they match. */
export function responseMismatch(
  response: Response,
  material: DocumentMaterialRef,
  start: number,
  end: number,
): string | null {
  const header = (name: string) => response.headers.get(name);
  if (response.status !== 200 && response.status !== 206)
    return `HTTP ${response.status}`;
  if (header("Content-Type")?.split(";")[0]?.trim() !== "application/pdf")
    return `Content-Type ${header("Content-Type") ?? "缺失"}`;
  for (const [name, value] of [
    ["X-Sciretriever-Asset-Id", material.asset_id],
    ["X-Sciretriever-Asset-Sha256", material.asset_sha256],
    ["X-Sciretriever-Byte-Size", String(material.byte_size)],
  ] as const)
    if (header(name) !== value)
      return `${name} 为 ${header(name) ?? "缺失"}，记录为 ${value}`;
  const etag = header("ETag");
  if (etag !== null && etag !== `"${material.asset_sha256}"`)
    return `ETag 为 ${etag}`;
  if (response.status === 206) {
    const expected = `bytes ${start}-${end - 1}/${material.byte_size}`;
    if (header("Content-Range") !== expected)
      return `Content-Range 为 ${header("Content-Range") ?? "缺失"}，请求的是 ${expected}`;
  } else if (header("Content-Range") !== null)
    return "整份响应带有 Content-Range";
  return null;
}

class Loader {
  readonly blocks: number;
  /** 1 for each block of `PDF_BLOCK` bytes that is in `buffer`. */
  readonly have: Uint8Array;
  missing: number;
  /** Blocks being downloaded, each to the request that brings it. */
  readonly pending = new Map<number, Promise<void>>();
  /** Requests a reader waits for; the background fill waits for none. */
  foreground = 0;
  private readonly idle: (() => void)[] = [];
  state: "loading" | "verifying" | "verified" | "failed" = "loading";
  failure: Error | null = null;
  readonly outcome = deferred();
  users = 0;
  controller = new AbortController();
  private wantFill = false;
  private filling = false;
  private linger: ReturnType<typeof setTimeout> | undefined;
  private counted = false;
  /** The last check of this asset failed: read past the browser cache. */
  private readonly refetch: boolean;

  constructor(
    readonly material: DocumentMaterialRef,
    private readonly fetch: ReadingContext["api"]["fetch"],
    readonly buffer: Uint8Array<ArrayBuffer>,
    verified: boolean,
  ) {
    this.blocks = Math.ceil(material.byte_size / PDF_BLOCK);
    this.have = new Uint8Array(this.blocks).fill(verified ? 1 : 0);
    this.missing = verified ? 0 : this.blocks;
    this.refetch = !verified && mustRefetch(material.asset_sha256);
    if (verified) {
      this.state = "verified";
      this.outcome.resolve();
    }
  }
  get size() {
    return this.material.byte_size;
  }
  private get hash() {
    return this.material.asset_sha256;
  }
  acquire() {
    clearTimeout(this.linger);
    this.linger = undefined;
    this.users++;
    if (this.controller.signal.aborted) this.controller = new AbortController();
    if (this.wantFill) this.fill();
  }
  release() {
    if (--this.users > 0) return;
    if (this.state !== "loading") return this.drop();
    // Nobody reads it: requests under way stop (spec 5.3); what arrived stays a while.
    this.controller.abort();
    this.linger = setTimeout(() => this.drop(), LINGER_MS);
  }
  private drop() {
    clearTimeout(this.linger);
    this.linger = undefined;
    if (loaders.get(this.hash) === this) loaders.delete(this.hash);
    this.controller.abort();
  }
  async read(begin: number, end: number): Promise<Uint8Array<ArrayBuffer>> {
    if (
      !Number.isInteger(begin) ||
      !Number.isInteger(end) ||
      begin < 0 ||
      begin >= end ||
      end > this.size
    )
      throw new RangeError("PDF 读取范围无效");
    const first = Math.floor(begin / PDF_BLOCK),
      last = Math.floor((end - 1) / PDF_BLOCK);
    for (;;) {
      if (this.failure) throw this.failure;
      this.controller.signal.throwIfAborted();
      const waits = new Set<Promise<void>>();
      let run = -1;
      for (let block = first; block <= last + 1; block++) {
        const absent =
          block <= last && !this.have[block] && !this.pending.has(block);
        if (absent) {
          if (run < 0) run = block;
          continue;
        }
        if (run >= 0) {
          waits.add(this.fetchRun(run, block - 1, true));
          run = -1;
        }
        if (block <= last && !this.have[block])
          waits.add(this.pending.get(block)!);
      }
      if (!waits.size) break;
      await Promise.all(waits);
    }
    if (this.failure) throw this.failure;
    return this.buffer.slice(begin, end);
  }
  /** Downloads the rest in the background, then checks the whole SHA-256 once. */
  fill() {
    this.wantFill = true;
    if (this.filling || this.state !== "loading" || this.users === 0) return;
    this.filling = true;
    const signal = this.controller.signal;
    void (async () => {
      let cursor = 0;
      while (this.state === "loading" && this.missing > 0 && !signal.aborted) {
        // Readers go first: the next part is asked for only while none waits.
        while (this.foreground > 0)
          await new Promise<void>((wake) => this.idle.push(wake));
        if (signal.aborted) break;
        while (
          cursor < this.blocks &&
          (this.have[cursor] || this.pending.has(cursor))
        )
          cursor++;
        if (cursor >= this.blocks) {
          // What is left is under way: wait for it and look again.
          if (!this.pending.size) break;
          await Promise.race(this.pending.values()).catch(() => undefined);
          cursor = 0;
          continue;
        }
        let last = cursor;
        while (
          last + 1 < this.blocks &&
          last + 1 - cursor < FILL_BLOCKS &&
          !this.have[last + 1] &&
          !this.pending.has(last + 1)
        )
          last++;
        await this.fetchRun(cursor, last, false);
      }
    })()
      .catch(() => undefined)
      .finally(() => {
        this.filling = false;
        // Stopped by a release and taken up again meanwhile.
        if (this.users > 0 && this.state === "loading" && this.missing > 0)
          this.fill();
      });
  }
  private fetchRun(a: number, b: number, foreground: boolean): Promise<void> {
    const start = a * PDF_BLOCK,
      end = Math.min((b + 1) * PDF_BLOCK, this.size);
    if (foreground) this.foreground++;
    const run: Promise<void> = this.download(start, end)
      .then((whole) => {
        if (this.state !== "loading") return;
        const [from, to] = whole ? [0, this.blocks - 1] : [a, b];
        for (let block = from; block <= to; block++)
          if (!this.have[block]) {
            this.have[block] = 1;
            this.missing--;
          }
        if (this.missing === 0) void this.verify();
      })
      .finally(() => {
        for (let block = a; block <= b; block++)
          if (this.pending.get(block) === run) this.pending.delete(block);
        if (foreground && --this.foreground === 0)
          for (const wake of this.idle.splice(0)) wake();
      });
    for (let block = a; block <= b; block++) this.pending.set(block, run);
    return run;
  }
  /** One range [start, end); true when the server sent the whole file instead (RFC 9110). */
  private async download(
    start: number,
    end: number,
    attempt = 0,
  ): Promise<boolean> {
    const signal = this.controller.signal;
    if (READER_PROBE) {
      // One download of the asset however many ranges it takes (spec 8.2).
      if (!this.counted) probeCountKey("pdfRequests", this.hash);
      probeCountKey("pdfRanges", this.hash);
    }
    this.counted = true;
    const again = (detail: string) => {
      if (signal.aborted) throw signal.reason;
      if (attempt === 0) return this.download(start, end, 1);
      throw this.fail(new PdfReadError(detail));
    };
    let response: Response;
    try {
      response = await this.fetch(materialBytesPath(this.material), {
        headers: { Range: `bytes=${start}-${end - 1}` },
        signal,
        ...(this.refetch ? { cache: "reload" as const } : {}),
      });
    } catch (error) {
      return again(String(error));
    }
    if (!response.ok && response.status !== 416) {
      void response.body?.cancel().catch(() => undefined);
      if (response.status >= 500) return again(`HTTP ${response.status}`);
      throw this.fail(new PdfReadError(`HTTP ${response.status}`));
    }
    const mismatch = responseMismatch(response, this.material, start, end);
    if (mismatch) {
      void response.body?.cancel().catch(() => undefined);
      throw this.fail(new PdfMismatchError(mismatch));
    }
    const whole = response.status === 200,
      into = whole ? 0 : start,
      length = whole ? this.size : end - start;
    const reader = response.body?.getReader();
    if (!reader) throw this.fail(new PdfMismatchError("响应没有字节"));
    let offset = 0,
      done = false;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        if (offset + chunk.value.byteLength > length)
          throw this.fail(
            new PdfMismatchError(`响应超过请求的 ${length} 字节`),
          );
        this.buffer.set(chunk.value, into + offset);
        offset += chunk.value.byteLength;
        if (READER_PROBE)
          probeAddKey("pdfBytes", this.hash, chunk.value.byteLength);
      }
      done = true;
    } catch (error) {
      if (error instanceof PdfMismatchError) throw error;
      return again(String(error));
    } finally {
      if (!done) void reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    if (offset !== length)
      throw this.fail(
        new PdfMismatchError(`响应为 ${offset} 字节，请求的是 ${length} 字节`),
      );
    return whole;
  }
  private async verify() {
    if (this.state !== "loading") return;
    this.state = "verifying";
    if (READER_PROBE) probeCountKey("pdfHashes", this.hash);
    let actual: string;
    try {
      actual = await sha256(this.buffer);
    } catch (error) {
      this.fail(new PdfReadError(String(error)));
      return;
    }
    if (this.state !== "verifying") return;
    if (actual !== this.hash) {
      this.fail(
        new PdfMismatchError(
          `SHA-256 记录为 ${this.hash}，下载的内容为 ${actual}`,
        ),
      );
      return;
    }
    this.state = "verified";
    verifiedSize = remember(
      verifiedBytes,
      this.hash,
      this.buffer,
      this.size,
      PDF_LIMIT,
      verifiedSize,
    );
    if (this.refetch) markRefetch(this.hash, false);
    this.outcome.resolve();
    if (this.users === 0) this.drop();
  }
  /** Stops every reader of this asset; a mismatch is not taken from the browser cache again. */
  private fail(error: Error): Error {
    if (this.state !== "loading" && this.state !== "verifying") return error;
    this.state = "failed";
    this.failure = error;
    if (loaders.get(this.hash) === this) loaders.delete(this.hash);
    const cached = verifiedBytes.get(this.hash);
    if (cached) {
      verifiedBytes.delete(this.hash);
      verifiedSize -= cached.size;
    }
    if (error instanceof PdfMismatchError) markRefetch(this.hash, true);
    this.outcome.reject(error);
    this.controller.abort(error);
    return error;
  }
}

/** One reader's hold on a fixed PDF; released with its context or by `release`. */
export interface PdfSource {
  readonly size: number;
  /** Its whole SHA-256 was checked (now or earlier in this session). */
  readonly verified: boolean;
  /** A copy of the checked bytes, or null before the check passed. */
  verifiedCopy(): Uint8Array<ArrayBuffer> | null;
  /** The checked file to download, or null before the check passed. */
  file(): Blob | null;
  /** Bytes [begin, end), downloading only the blocks no one has asked for yet. */
  read(begin: number, end: number): Promise<Uint8Array<ArrayBuffer>>;
  /** Starts downloading the rest in the background, and then the check. */
  complete(): void;
  /** The whole checked file (a copy); starts the rest if needed. */
  whole(): Promise<Uint8Array<ArrayBuffer>>;
  /** Resolves once the whole SHA-256 matched; rejects when it or a response did not, or a read failed. */
  readonly checked: Promise<void>;
  release(): void;
}
export function openPdfSource(
  ctx: ReadingContext,
  material: DocumentMaterialRef,
): PdfSource {
  if (
    material.media_type !== "application/pdf" ||
    material.byte_size < 1 ||
    material.byte_size > PDF_LIMIT
  )
    throw new Error("PDF 超过受控读取上限或材料类型不符");
  ctx.signal.throwIfAborted();
  const hash = material.asset_sha256;
  let loader = loaders.get(hash);
  if (!loader) {
    const cached = verifiedBytes.get(hash);
    if (cached && cached.value.byteLength === material.byte_size) {
      verifiedSize = remember(
        verifiedBytes,
        hash,
        cached.value,
        cached.size,
        PDF_LIMIT,
        verifiedSize,
      );
      loader = new Loader(material, ctx.api.fetch, cached.value, true);
    } else
      loader = new Loader(
        material,
        ctx.api.fetch,
        new Uint8Array(material.byte_size),
        false,
      );
    loaders.set(hash, loader);
  }
  if (loader.size !== material.byte_size)
    throw new PdfMismatchError("同一 SHA-256 的材料大小不同");
  const held = loader;
  held.acquire();
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    ctx.signal.removeEventListener("abort", release);
    held.release();
  };
  ctx.signal.addEventListener("abort", release, { once: true });
  return {
    size: held.size,
    get verified() {
      return held.state === "verified";
    },
    verifiedCopy: () =>
      held.state === "verified" ? held.buffer.slice() : null,
    file: () =>
      held.state === "verified"
        ? new Blob([held.buffer], { type: "application/pdf" })
        : null,
    read: (begin, end) =>
      released
        ? Promise.reject(new DOMException("PDF 读取已释放", "AbortError"))
        : held.read(begin, end),
    complete: () => {
      if (!released) held.fill();
    },
    whole: async () => {
      if (!released) held.fill();
      await held.outcome.promise;
      ctx.signal.throwIfAborted();
      return held.buffer.slice();
    },
    checked: held.outcome.promise,
    release,
  };
}
/** The whole checked PDF (a copy), as for a region preview. */
export async function readPdfBytes(
  ctx: ReadingContext,
  material: DocumentMaterialRef,
): Promise<Uint8Array<ArrayBuffer>> {
  const source = openPdfSource(ctx, material);
  try {
    return await source.whole();
  } finally {
    source.release();
  }
}
/**
 * The PDF view is wanted (cold open): its first and last blocks, which PDF.js
 * reads first (header, cross-reference), come in alongside the text's reads.
 */
export function prefetchPdf(
  ctx: ReadingContext,
  material: DocumentMaterialRef,
): void {
  let source: PdfSource;
  try {
    source = openPdfSource(ctx, material);
  } catch {
    return;
  }
  if (source.verified) return source.release();
  const tail = Math.floor((source.size - 1) / PDF_BLOCK) * PDF_BLOCK;
  void Promise.all([
    source.read(0, Math.min(PDF_BLOCK, source.size)),
    source.read(tail, source.size),
  ])
    .catch(() => undefined)
    .finally(() => source.release());
}
