import { describe, expect, it } from "vitest";
import { BrowserCaptureBatch } from "../src/browser/capture-batch.js";
import type { DurableCandidate } from "@sciretriever/contracts";

function item(id: string) {
  return {
    transfer_id: id,
    candidate: {
      transfer_id: id,
      article_id: "article-1",
      source_name: "browser",
      source_record_id: null,
      state: "durable-ready",
      reference: `objects/${id}.pdf`,
      sha256: id.padEnd(64, "0").slice(0, 64),
      size_bytes: 4,
      media_type: "application/pdf",
      capture: null,
    } as unknown as DurableCandidate,
    accepted: true,
  } as const;
}

describe("BrowserCaptureBatch", () => {
  it("keeps captures in operation order and resolves a late waiter", async () => {
    const batch = new BrowserCaptureBatch(2);
    const signal = new AbortController().signal;
    const waiting = batch.next(signal);
    expect(batch.add(item("first"))).toBe(true);
    expect(batch.add(item("first"))).toBe(false);
    await expect(waiting).resolves.toMatchObject({ transfer_id: "first" });
    expect(batch.add(item("second"))).toBe(true);
    expect(batch.hasCandidate()).toBe(true);
    await expect(batch.next(signal)).resolves.toMatchObject({
      transfer_id: "second",
    });
  });

  it("rejects overflow and returns unconsumed candidates on close", async () => {
    const batch = new BrowserCaptureBatch(1);
    expect(batch.add(item("first"))).toBe(true);
    expect(batch.add(item("overflow"))).toBe(false);
    expect(batch.close().map(({ transfer_id }) => transfer_id)).toEqual([
      "first",
    ]);
    expect(batch.add(item("late"))).toBe(false);
    await expect(batch.next(new AbortController().signal)).resolves.toBeNull();
  });
});
