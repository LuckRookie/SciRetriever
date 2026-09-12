import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileStore } from "../src/storage/files/store.js";
import {
  BrowserTransferCollector,
  BrowserTransferError,
} from "../src/browser/transfer.js";
import { BrowserCandidateIntake } from "../src/acquisition/browser-intake.js";
import {
  FIXTURE_DOI,
  workbenchPdf,
} from "../src/workbench/synthetic-fixture.js";

describe("browser transfer durability", () => {
  it("keeps bytes independent of the page and makes completion idempotent", async () => {
    const root = await mkdtemp(join(tmpdir(), "sciretriever-transfer-"));
    const files = new FileStore(root);
    const collector = new BrowserTransferCollector(files);
    await collector.begin("download-1", 16);
    await collector.append("download-1", new Uint8Array([1, 2]));
    await collector.append("download-1", new Uint8Array([3, 4]));
    const candidate = await collector.complete("download-1");
    expect(await collector.complete("download-1")).toEqual(candidate);
    const bytes = await readFile(join(root, candidate.reference));
    expect([...bytes]).toEqual([1, 2, 3, 4]);
    await files.close();
    await rm(root, { recursive: true, force: true });
  });
  it("rejects zero length and over-limit transfers without durable-ready", async () => {
    const root = await mkdtemp(join(tmpdir(), "sciretriever-transfer-"));
    const files = new FileStore(root);
    const collector = new BrowserTransferCollector(files);
    await collector.begin("download-1", 2);
    await expect(
      collector.append("download-1", new Uint8Array()),
    ).rejects.toBeInstanceOf(BrowserTransferError);
    await expect(
      collector.append("download-1", new Uint8Array([1, 2, 3])),
    ).rejects.toBeInstanceOf(BrowserTransferError);
    expect(collector.get("download-1")).toMatchObject({
      state: "capturing",
      received_bytes: 0,
    });
    await collector.discard("download-1");
    expect(collector.get("download-1")).toMatchObject({ state: "discarded" });
    await files.close();
    await rm(root, { recursive: true, force: true });
  });
  it("cancels a slow stream without publishing a partial candidate", async () => {
    const root = await mkdtemp(join(tmpdir(), "sciretriever-transfer-"));
    const files = new FileStore(root);
    const collector = new BrowserTransferCollector(files);
    const intake = new BrowserCandidateIntake(collector, {
      article_id: "article-1",
      identifier: `doi:${FIXTURE_DOI}`,
      version: "published",
    });
    const controller = new AbortController();
    const bytes = workbenchPdf();
    async function* slow(): AsyncIterable<Uint8Array> {
      yield bytes.slice(0, 64);
      await new Promise((resolve) => setTimeout(resolve, 5));
      controller.abort();
      yield bytes.slice(64);
    }
    await expect(
      intake.receive({
        signal: controller.signal,
        transfer_id: "slow-download",
        capture: {
          session_id: "session-1",
          article_id: "article-1",
          page_id: "page-1",
          document_generation: 1,
          source_url: "http://127.0.0.1/article",
          captured_at: "2026-09-12T00:00:00.000Z",
        },
        chunks: slow(),
      }),
    ).rejects.toBeDefined();
    expect(collector.get("slow-download")).toMatchObject({
      state: "discarded",
      received_bytes: 64,
    });
    await files.close();
    await rm(root, { recursive: true, force: true });
  });
});
