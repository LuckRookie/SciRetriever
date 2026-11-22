/**
 * A fixed PDF read by ranges (reading-experience 5.1, 6.3; ADR 0065 section
 * 6 rule 6): the range requests and their header checks, the background
 * whole-file check and what a failed one invalidates, and a second reader
 * sharing the first one's download.
 */
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocumentMaterialRef } from "@sciretriever/contracts";
import type { ReadingContext } from "../src/reading/contract.js";

type Module = typeof import("../src/reading/pdf-bytes.js");
const BLOCK = 64 * 1024;

function pdf(size: number) {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) bytes[i] = (i * 31 + 7) & 0xff;
  return bytes;
}
const hashOf = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
function materialOf(bytes: Uint8Array): DocumentMaterialRef {
  const sha = hashOf(bytes) as DocumentMaterialRef["asset_sha256"];
  return {
    literature_id: "00000000-0000-4000-8000-000000000001",
    asset_id: "00000000-0000-4000-8000-000000000002",
    asset_sha256: sha,
    media_type: "application/pdf",
    byte_size: bytes.length,
    artifact: {
      sha256: sha,
      byte_size: bytes.length,
      media_type: "application/pdf",
    },
  } as DocumentMaterialRef;
}
interface Call {
  path: string;
  range: string | null;
  cache: RequestCache | undefined;
  signal: AbortSignal | undefined;
  bytes: number;
}
/** The GET route as the server serves it (single ranges, 206), with ways to go wrong. */
function server(
  bytes: Uint8Array,
  material: DocumentMaterialRef,
  options: {
    tamper?: (start: number, body: Uint8Array) => void;
    headers?: Record<string, string>;
    /** Held until released; aborting the request rejects it. */
    hold?: Promise<void>;
    whole?: boolean;
  } = {},
) {
  const calls: Call[] = [];
  const fetch = async (path: string, init: RequestInit = {}) => {
    const range = new Headers(init.headers).get("Range");
    const call: Call = {
      path,
      range,
      cache: init.cache,
      signal: init.signal ?? undefined,
      bytes: 0,
    };
    calls.push(call);
    const aborted = () =>
      new Promise<never>((_, reject) =>
        init.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        ),
      );
    if (options.hold) await Promise.race([options.hold, aborted()]);
    init.signal?.throwIfAborted();
    const match = /^bytes=(\d+)-(\d+)$/u.exec(range ?? "")!;
    const start = options.whole ? 0 : Number(match[1]),
      end = options.whole ? bytes.length - 1 : Number(match[2]);
    const body = bytes.slice(start, end + 1);
    options.tamper?.(start, body);
    call.bytes = body.length;
    return new Response(body, {
      status: options.whole ? 200 : 206,
      headers: {
        "Content-Type": "application/pdf",
        "X-Sciretriever-Asset-Id": material.asset_id,
        "X-Sciretriever-Asset-Sha256": material.asset_sha256,
        "X-Sciretriever-Byte-Size": String(bytes.length),
        ETag: `"${material.asset_sha256}"`,
        ...(options.whole
          ? {}
          : { "Content-Range": `bytes ${start}-${end}/${bytes.length}` }),
        ...options.headers,
      },
    });
  };
  return { calls, fetch };
}
function context(fetch: ReadingContext["api"]["fetch"]) {
  const controller = new AbortController();
  const ctx: ReadingContext = {
    root: {} as HTMLElement,
    signal: controller.signal,
    api: { query: async () => ({}), fetch },
    refresh() {},
  };
  return { ctx, close: () => controller.abort() };
}
function memoryStorage() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
  };
}
/** Large arrays compared as buffers (deep equality is element by element). */
const same = (a: Uint8Array, b: Uint8Array) =>
  Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(
    Buffer.from(b.buffer, b.byteOffset, b.byteLength),
  );
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

let storage: ReturnType<typeof memoryStorage>;
let hashes: ReturnType<typeof vi.fn>;
let m: Module;
beforeEach(async () => {
  vi.resetModules();
  storage = memoryStorage();
  vi.stubGlobal("localStorage", storage);
  hashes = vi.fn();
  vi.doMock("@sciretriever/contracts", async (original) => {
    const actual = await original<typeof import("@sciretriever/contracts")>();
    return {
      ...actual,
      sha256: async (value: Uint8Array) => {
        hashes();
        return actual.sha256(value);
      },
    };
  });
  m = await import("../src/reading/pdf-bytes.js");
});
afterEach(() => {
  vi.doUnmock("@sciretriever/contracts");
  vi.unstubAllGlobals();
});

describe("range requests", () => {
  it("asks for whole blocks of the fixed material's GET route and returns the exact bytes", async () => {
    const bytes = pdf(3 * BLOCK + 100),
      material = materialOf(bytes),
      s = server(bytes, material),
      { ctx } = context(s.fetch);
    const source = m.openPdfSource(ctx, material);
    expect(source.verified).toBe(false);
    expect(await source.read(10, 20)).toEqual(bytes.slice(10, 20));
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]).toMatchObject({
      path: `/api/v1/query/material-bytes/${material.literature_id}/${material.asset_id}/${material.asset_sha256}`,
      range: `bytes=0-${BLOCK - 1}`,
      cache: undefined,
    });
    // Two blocks not yet in: one request; the block already in is not asked again.
    expect(await source.read(BLOCK - 5, 3 * BLOCK + 100)).toEqual(
      bytes.slice(BLOCK - 5, 3 * BLOCK + 100),
    );
    expect(s.calls.map((c) => c.range)).toEqual([
      `bytes=0-${BLOCK - 1}`,
      `bytes=${BLOCK}-${3 * BLOCK + 99}`,
    ]);
    await expect(source.read(0, 3 * BLOCK + 101)).rejects.toThrow(RangeError);
  });

  it("checks every response's identity headers and range against the record", () => {
    const bytes = pdf(1000),
      material = materialOf(bytes);
    const response = (status: number, headers: Record<string, string>) =>
      new Response(null, {
        status,
        headers: {
          "Content-Type": "application/pdf",
          "X-Sciretriever-Asset-Id": material.asset_id,
          "X-Sciretriever-Asset-Sha256": material.asset_sha256,
          "X-Sciretriever-Byte-Size": "1000",
          ETag: `"${material.asset_sha256}"`,
          "Content-Range": "bytes 0-99/1000",
          ...headers,
        },
      });
    const check = (status: number, headers: Record<string, string>) =>
      m.responseMismatch(response(status, headers), material, 0, 100);
    expect(check(206, {})).toBeNull();
    expect(check(206, { "Content-Type": "text/html" })).toContain(
      "Content-Type",
    );
    expect(check(206, { "X-Sciretriever-Asset-Id": "other" })).toContain(
      "X-Sciretriever-Asset-Id",
    );
    expect(
      check(206, { "X-Sciretriever-Asset-Sha256": "0".repeat(64) }),
    ).toContain("X-Sciretriever-Asset-Sha256");
    expect(check(206, { "X-Sciretriever-Byte-Size": "999" })).toContain(
      "X-Sciretriever-Byte-Size",
    );
    expect(check(206, { ETag: '"other"' })).toContain("ETag");
    expect(check(206, { "Content-Range": "bytes 0-199/1000" })).toContain(
      "Content-Range",
    );
    expect(check(206, { "Content-Range": "bytes 0-99/1001" })).toContain(
      "Content-Range",
    );
    // A whole response (RFC 9110 lets a server ignore Range) carries no range.
    expect(check(200, { "Content-Range": "" })).toContain("Content-Range");
    expect(
      m.responseMismatch(
        new Response(null, {
          status: 200,
          headers: {
            "Content-Type": "application/pdf",
            "X-Sciretriever-Asset-Id": material.asset_id,
            "X-Sciretriever-Asset-Sha256": material.asset_sha256,
            "X-Sciretriever-Byte-Size": "1000",
          },
        }),
        material,
        0,
        100,
      ),
    ).toBeNull();
    expect(check(416, {})).toContain("416");
  });

  it("stops at a response that does not match the record", async () => {
    const bytes = pdf(2 * BLOCK),
      material = materialOf(bytes),
      s = server(bytes, material, {
        headers: { "X-Sciretriever-Byte-Size": "1" },
      }),
      { ctx } = context(s.fetch);
    const source = m.openPdfSource(ctx, material);
    await expect(source.read(0, 10)).rejects.toBeInstanceOf(m.PdfMismatchError);
    await expect(source.checked).rejects.toBeInstanceOf(m.PdfMismatchError);
    expect(m.pdfProblem(await source.checked.catch((e) => e)).message).toMatch(
      /^文件与记录不一致/u,
    );
  });

  it("takes a whole response to a range request as the whole file", async () => {
    const bytes = pdf(3 * BLOCK),
      material = materialOf(bytes),
      s = server(bytes, material, { whole: true }),
      { ctx } = context(s.fetch);
    const source = m.openPdfSource(ctx, material);
    expect(await source.read(2 * BLOCK, 2 * BLOCK + 5)).toEqual(
      bytes.slice(2 * BLOCK, 2 * BLOCK + 5),
    );
    await source.checked;
    expect(s.calls).toHaveLength(1);
    expect(source.verified).toBe(true);
  });
});

describe("the whole-file check in the background", () => {
  it("downloads the rest once, without overlap, checks the SHA-256 once and keeps the checked bytes", async () => {
    const size = 70 * BLOCK + 123,
      bytes = pdf(size),
      material = materialOf(bytes),
      s = server(bytes, material),
      { ctx, close } = context(s.fetch);
    const source = m.openPdfSource(ctx, material);
    await source.read(size - 10, size);
    expect(source.file()).toBeNull();
    source.complete();
    await source.checked;
    expect(s.calls.reduce((n, c) => n + c.bytes, 0)).toBe(size);
    // The tail block first, then 2 MB parts in order.
    expect(s.calls.map((c) => c.range)).toEqual([
      `bytes=${70 * BLOCK}-${size - 1}`,
      `bytes=0-${32 * BLOCK - 1}`,
      `bytes=${32 * BLOCK}-${64 * BLOCK - 1}`,
      `bytes=${64 * BLOCK}-${70 * BLOCK - 1}`,
    ]);
    expect(hashes).toHaveBeenCalledTimes(1);
    expect(same(source.verifiedCopy()!, bytes)).toBe(true);
    expect(source.file()?.size).toBe(size);
    close();
    // Opened again in the session: no request and no second hash (spec 5.1).
    const again = m.openPdfSource(context(s.fetch).ctx, material);
    expect(again.verified).toBe(true);
    expect(same(await again.whole(), bytes)).toBe(true);
    expect(s.calls).toHaveLength(4);
    expect(hashes).toHaveBeenCalledTimes(1);
  });

  it("lets a reader's request go before the next background part", async () => {
    const size = 100 * BLOCK,
      bytes = pdf(size),
      material = materialOf(bytes),
      s = server(bytes, material),
      { ctx } = context(s.fetch);
    const source = m.openPdfSource(ctx, material);
    const reading = source.read(90 * BLOCK, 90 * BLOCK + 10);
    source.complete();
    await reading;
    await source.checked;
    expect(s.calls[0]!.range).toBe(`bytes=${90 * BLOCK}-${91 * BLOCK - 1}`);
    expect(s.calls.reduce((n, c) => n + c.bytes, 0)).toBe(size);
  });
});

describe("a failed check", () => {
  it("stops every reader, drops the session copy and reads past the browser cache next time", async () => {
    const bytes = pdf(5 * BLOCK),
      material = materialOf(bytes),
      bad = server(bytes, material, {
        // Same size and headers, one byte different: only the whole hash shows it.
        tamper: (start, body) => {
          if (start === 0) body[100] = body[100]! ^ 1;
        },
      }),
      first = context(bad.fetch);
    const source = m.openPdfSource(first.ctx, material),
      other = m.openPdfSource(context(bad.fetch).ctx, material);
    source.complete();
    const failure = await source.checked.catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(m.PdfMismatchError);
    expect(
      (failure as InstanceType<Module["PdfMismatchError"]>).detail,
    ).toContain(material.asset_sha256);
    await expect(other.checked).rejects.toBe(failure);
    await expect(other.read(0, 10)).rejects.toBe(failure);
    expect(source.verifiedCopy()).toBeNull();
    expect(source.file()).toBeNull();
    expect(bad.calls.every((c) => c.cache === undefined)).toBe(true);
    expect(JSON.parse(storage.map.get("sciretriever.pdf-refetch")!)).toEqual([
      material.asset_sha256,
    ]);
    // The next open downloads again, past the cache, and a pass clears the mark.
    const good = server(bytes, material);
    const retry = m.openPdfSource(context(good.fetch).ctx, material);
    expect(retry.verified).toBe(false);
    retry.complete();
    await retry.checked;
    expect(good.calls.length).toBeGreaterThan(0);
    expect(good.calls.every((c) => c.cache === "reload")).toBe(true);
    expect(storage.map.has("sciretriever.pdf-refetch")).toBe(false);
  });

  it("is remembered across page loads through local storage", async () => {
    const bytes = pdf(BLOCK),
      material = materialOf(bytes);
    storage.setItem(
      "sciretriever.pdf-refetch",
      JSON.stringify([material.asset_sha256]),
    );
    const s = server(bytes, material),
      source = m.openPdfSource(context(s.fetch).ctx, material);
    await source.whole();
    expect(s.calls.map((c) => c.cache)).toEqual(["reload"]);
    expect(storage.map.has("sciretriever.pdf-refetch")).toBe(false);
  });

  it("works where local storage is refused", async () => {
    vi.stubGlobal("localStorage", {
      getItem() {
        throw new Error("refused");
      },
      setItem() {
        throw new Error("refused");
      },
      removeItem() {
        throw new Error("refused");
      },
    });
    const bytes = pdf(BLOCK),
      material = materialOf(bytes),
      bad = server(bytes, material, {
        tamper: (_, body) => {
          body[0] = body[0]! ^ 1;
        },
      });
    const source = m.openPdfSource(context(bad.fetch).ctx, material);
    await expect(source.whole()).rejects.toBeInstanceOf(m.PdfMismatchError);
    const good = server(bytes, material);
    await m.openPdfSource(context(good.fetch).ctx, material).whole();
    expect(good.calls.map((c) => c.cache)).toEqual(["reload"]);
  });
});

describe("sharing and cancelling", () => {
  it("lets a second reader join the first one's download and outlive it", async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => (release = resolve));
    const bytes = pdf(4 * BLOCK),
      material = materialOf(bytes),
      s = server(bytes, material, { hold }),
      one = context(s.fetch),
      two = context(s.fetch);
    const a = m.openPdfSource(one.ctx, material),
      b = m.openPdfSource(two.ctx, material);
    const first = a.read(0, 10),
      second = b.read(5, 20);
    await settle();
    expect(s.calls).toHaveLength(1);
    // The first reader leaves (its tab closed): the download goes on for the second.
    one.close();
    first.catch(() => undefined);
    release();
    expect(await second).toEqual(bytes.slice(5, 20));
    expect(s.calls[0]!.signal?.aborted).toBe(false);
    b.complete();
    await b.checked;
    expect(s.calls.reduce((n, c) => n + c.bytes, 0)).toBe(4 * BLOCK);
    expect(hashes).toHaveBeenCalledTimes(1);
  });

  it("cancels what is under way when its last reader closes", async () => {
    const hold = new Promise<void>(() => undefined);
    const bytes = pdf(4 * BLOCK),
      material = materialOf(bytes),
      s = server(bytes, material, { hold }),
      one = context(s.fetch),
      two = context(s.fetch);
    const a = m.openPdfSource(one.ctx, material),
      b = m.openPdfSource(two.ctx, material);
    a.read(0, 10).catch(() => undefined);
    b.complete();
    await settle();
    one.close();
    expect(s.calls[0]!.signal?.aborted).toBe(false);
    two.close();
    expect(s.calls.every((c) => c.signal?.aborted)).toBe(true);
    expect(hashes).not.toHaveBeenCalled();
  });

  it("reads again after its readers came back", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const bytes = pdf(2 * BLOCK),
        material = materialOf(bytes),
        s = server(bytes, material),
        one = context(s.fetch);
      const a = m.openPdfSource(one.ctx, material);
      await a.read(0, 10);
      one.close();
      // Back within the linger: the block already in is not asked again.
      const b = m.openPdfSource(context(s.fetch).ctx, material);
      await b.whole();
      expect(s.calls.map((c) => c.range)).toEqual([
        `bytes=0-${BLOCK - 1}`,
        `bytes=${BLOCK}-${2 * BLOCK - 1}`,
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});
