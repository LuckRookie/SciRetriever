import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { parseLibrarySearchRequest } from "@sciretriever/contracts";
import { initializeCurrentCatalog } from "../src/storage/sqlite/catalog-layout.js";
import { SqliteWorker } from "../src/storage/sqlite/worker.js";
import { LiteratureQueryService } from "../src/literature/query.js";
import { createQueryApplication } from "../src/bootstrap/application.js";
import { startQueryOnlyHttp } from "../src/workbench/http.js";

it(
  "skips cancelled queued commands, acknowledges cancellation and leaves the worker usable",
  { timeout: 0 },
  async () => {
    const home = await mkdtemp(join(tmpdir(), "sciretriever-query-cancel-"));
    const path = join(home, "catalog.sqlite");
    const db = new DatabaseSync(path);
    initializeCurrentCatalog(db);
    db.exec("PRAGMA foreign_keys=ON;BEGIN");
    for (let n = 0; n < 6000; n++) {
      const id = `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
      db.prepare("INSERT INTO meta_literatures VALUES(?,?)").run(id, id);
      db.prepare("INSERT INTO literatures VALUES(?,?,'published')").run(id, id);
      db.prepare(
        "INSERT INTO literature_metadata(literature_id,metadata_revision,metadata_sha256,title) VALUES(?,1,?,'Synthetic')",
      ).run(id, "a".repeat(64));
    }
    db.exec("COMMIT");
    db.close();
    const replies: Promise<{ cancelled?: boolean }>[] = [];
    const post = Worker.prototype.postMessage;
    const spy = vi
      .spyOn(Worker.prototype, "postMessage")
      .mockImplementation(function (
        this: Worker,
        message: unknown,
        ...args: Parameters<Worker["postMessage"]> extends [unknown, ...infer R]
          ? R
          : never
      ) {
        const m = message as { id: number; cancellation?: SharedArrayBuffer };
        if (m.cancellation)
          replies.push(
            new Promise((resolve) => {
              const listener = (reply: { id: number; cancelled?: boolean }) => {
                if (reply.id === m.id) {
                  this.off("message", listener);
                  resolve(reply);
                }
              };
              this.on("message", listener);
            }),
          );
        return Reflect.apply(post, this, [message, ...args]);
      });
    const worker = new SqliteWorker(path, undefined, { readOnly: true });
    const service = new LiteratureQueryService(worker);
    try {
      // Startup is queued first; every following cancelled query must be acknowledged without work.
      const startup = worker.queryPreflight();
      const controllers = Array.from(
        { length: 8 },
        () => new AbortController(),
      );
      const cancelled = controllers.map((c) =>
        service.counts({}, c.signal).catch((e) => e),
      );
      controllers.forEach((c) => c.abort());
      expect((await startup).status).toBe("ready");
      for (const error of await Promise.all(cancelled))
        expect(error.name).toBe("AbortError");
      expect((await service.counts({})).total).toBe(6000);
      const active = new AbortController();
      const pending = service.counts({}, active.signal).catch((e) => e);
      // This is a cancellation stimulus, not an elapsed-time acceptance threshold.
      const timer = setTimeout(() => active.abort(), 1);
      const error = await pending;
      clearTimeout(timer);
      expect(error.name).toBe("AbortError");
      const acknowledgements = await Promise.all(replies);
      expect(acknowledgements).toHaveLength(9);
      expect(acknowledgements.every((r) => r.cancelled === true)).toBe(true);
      // Cancelled work neither poisons the cache nor leaves an open read transaction.
      expect(
        (
          await worker.libraryCounts(
            parseLibrarySearchRequest({ query: {} }).query,
            null,
          )
        ).total,
      ).toBe(6000);
      await expect(
        service.search({ query: { text: "---" } }, AbortSignal.abort()),
      ).rejects.toMatchObject({ name: "AbortError" });
    } finally {
      spy.mockRestore();
      await worker.close();
      await rm(home, { recursive: true, force: true });
    }
  },
);

it.each(["search", "library-counts", "library-exact-count"])(
  "propagates an HTTP disconnect through %s to the query signal",
  { timeout: 0 },
  async (route) => {
    const home = await mkdtemp(join(tmpdir(), "sciretriever-http-cancel-"));
    const db = new DatabaseSync(join(home, "catalog.sqlite"));
    initializeCurrentCatalog(db);
    db.close();
    const app = await createQueryApplication(home);
    if (!app.query) throw new Error("Synthetic query unavailable");
    const web = await startQueryOnlyHttp({ application: app });
    let started!: () => void;
    const begin = new Promise<void>((r) => {
      started = r;
    });
    let ended!: () => void;
    const end = new Promise<void>((r) => {
      ended = r;
    });
    const method =
      route === "search"
        ? "search"
        : route === "library-counts"
          ? "counts"
          : "exactCount";
    const spy = vi
      .spyOn(app.query, method)
      .mockImplementation(async (...[, signal]) => {
        expect(signal).toBeDefined();
        started();
        await new Promise<void>((_resolve, reject) =>
          signal!.addEventListener(
            "abort",
            () => {
              ended();
              reject(new DOMException("Cancelled", "AbortError"));
            },
            { once: true },
          ),
        );
        throw new Error("Cancelled query cannot return a result");
      });
    try {
      const controller = new AbortController();
      const pending = fetch(web.origin + "/api/v1/query/" + route, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          protocol_version: 1,
          request:
            route === "library-exact-count"
              ? { kind: "counts", query: {} }
              : { query: {} },
        }),
        signal: controller.signal,
      }).catch((e) => e);
      await begin;
      controller.abort();
      await end;
      expect((await pending).name).toBe("AbortError");
    } finally {
      spy.mockRestore();
      await web.close();
      await app.close();
      await rm(home, { recursive: true, force: true });
    }
  },
);
