import { expect, it } from "vitest";
import { parseDurableCandidate } from "../src/index.js";

it("round-trips large file candidates without encoding a process resource cap in the durable format", () => {
  const candidate = {
    capture: null,
    source_name: "browser",
    source_record_id: null,
    transfer_id: "large-transfer",
    state: "durable-ready",
    reference: `.candidates/${"a".repeat(64)}.bin`,
    size_bytes: 512 * 1024 * 1024 + 1,
    sha256: "a".repeat(64),
  };
  expect(parseDurableCandidate(JSON.parse(JSON.stringify(candidate)))).toEqual(
    candidate,
  );
  for (const invalid of [0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, Infinity])
    expect(() =>
      parseDurableCandidate({ ...candidate, size_bytes: invalid }),
    ).toThrow();
});
