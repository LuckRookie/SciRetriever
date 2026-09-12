import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  canonicalJsonBytes,
  decodeCursor,
  encodeCursor,
  parseStrictJsonObject,
  sha256,
} from "../src/index.js";

const records = JSON.parse(
  readFileSync(
    new URL("../../../tests/fixtures/compat-v1/records.json", import.meta.url),
    "utf8",
  ),
) as Record<string, Record<string, unknown>>;
const manifest = JSON.parse(
  readFileSync(
    new URL("../../../tests/fixtures/compat-v1/manifest.json", import.meta.url),
    "utf8",
  ),
) as { sha256_by_record: Record<string, string> };

describe("canonical bytes and integrity boundaries", () => {
  it("matches the v1 canonical bytes and SHA-256 values", async () => {
    for (const [name, expected] of Object.entries(manifest.sha256_by_record)) {
      const bytes = canonicalJsonBytes(records[name]);
      expect(await sha256(bytes)).toBe(expected);
    }
    expect(
      new TextDecoder().decode(
        canonicalJsonBytes(records.canonical_parameters),
      ),
    ).toBe('{"a":1,"nested":{"a":null,"b":true},"z":"末"}');
  });

  it("sorts nested keys, preserves UTF-8, and rejects non-finite values", () => {
    expect(
      new TextDecoder().decode(
        canonicalJsonBytes({ z: "末", nested: { b: true, a: null }, a: 1 }),
      ),
    ).toBe('{"a":1,"nested":{"a":null,"b":true},"z":"末"}');
    expect(() => canonicalJsonBytes({ value: Number.NaN })).toThrow();
    expect(() => canonicalJsonBytes({ value: Infinity })).toThrow();
  });

  it("rejects duplicate object keys, invalid UTF-8, and non-object JSON", () => {
    expect(() => parseStrictJsonObject('{"a":1,"a":2}')).toThrow();
    expect(() => parseStrictJsonObject('{"outer":{"a":1,"a":2}}')).toThrow();
    expect(() => parseStrictJsonObject(new Uint8Array([0xff]))).toThrow();
    expect(() => parseStrictJsonObject("[]")).toThrow();
    expect(
      parseStrictJsonObject('{"outer":{"a":1},"items":[{"a":2}]}'),
    ).toEqual({
      outer: { a: 1 },
      items: [{ a: 2 }],
    });
  });

  it("binds an opaque cursor to its kind and detects tampering", async () => {
    const cursor = await encodeCursor("library-search", { position: "end" });
    await expect(decodeCursor(cursor, "library-search")).resolves.toEqual({
      position: "end",
    });
    await expect(decodeCursor(cursor, "other-kind")).rejects.toThrow();
    const tampered = `${cursor.slice(0, -1)}${cursor.endsWith("a") ? "b" : "a"}`;
    await expect(decodeCursor(tampered, "library-search")).rejects.toThrow();
  });
});
