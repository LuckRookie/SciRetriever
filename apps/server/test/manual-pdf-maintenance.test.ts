import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parseLiterature, sha256 } from "@sciretriever/contracts";
import {
  createApplication,
  createQueryApplication,
} from "../src/bootstrap/application.js";
import { runCli } from "../src/cli/main.js";
import { CandidatePublicationError } from "../src/acquisition/candidate-publication.js";
import { startMaintenanceWorkbench } from "../src/bootstrap/workbench.js";
import { startWorkbenchHttp } from "../src/workbench/http.js";
import { WorkbenchSession } from "../src/workbench/session.js";
import { SqliteWorker } from "../src/storage/sqlite/worker.js";
import {
  authorizeExecutionSchema,
  SYNTHETIC_CATALOG_MARKER_FILE,
} from "../src/storage/execution/migration-gate.js";
import {
  FIXTURE_LITERATURE,
  workbenchPdf,
} from "../src/workbench/synthetic-fixture.js";

const id = FIXTURE_LITERATURE.literature_id;
const pageAssets = new Map([
  ["/", { contentType: "text/html", body: "<html>maintenance</html>" }],
  ["/query", { contentType: "text/html", body: "<html>query</html>" }],
]);
async function setup() {
  const home = await mkdtemp(join(tmpdir(), "sciretriever-manual-pdf-"));
  let app = await createApplication(home, {
    executionSchema: "upgrade-synthetic",
  });
  await app.database.putLiterature(parseLiterature(FIXTURE_LITERATURE));
  return {
    home,
    get app() {
      return app;
    },
    async restart() {
      await app.close();
      app = await createApplication(home, {
        executionSchema: "upgrade-synthetic",
      });
    },
    async close() {
      await app.close();
      await rm(home, { recursive: true, force: true });
    },
  };
}

describe("shared manual PDF maintenance", () => {
  it("copies explicit bytes, records user provenance and exposes one fact to independent query", async () => {
    const env = await setup();
    const source = join(env.home, "user-paper.pdf");
    const bytes = workbenchPdf();
    try {
      await writeFile(source, bytes);
      const receipt = await env.app.maintenance!.ingestPdf({
        literature_id: id,
        bytes: await readFile(source),
      });
      expect(receipt.sha256).toBe(await sha256(bytes));
      expect(await readFile(source)).toEqual(Buffer.from(bytes));
      const detail = await env.app.library.detail(id);
      expect(detail.primary_pdf?.asset.sha256).toBe(receipt.sha256);
      expect(
        (await env.app.database.getReceiptIntent(receipt.receipt_id))
          ?.source_url,
      ).toBeNull();
      expect(detail.content).toBeNull();
      const intent = await env.app.database.getReceiptIntent(
        receipt.receipt_id,
      );
      expect(intent?.provenance).toMatchObject({
        source_kind: "user",
        source_name: "manual-pdf",
        source_record_id: null,
        input_sha256: receipt.sha256,
      });
      await expect(
        env.app.maintenance!.ingestPdf({ literature_id: id, bytes }),
      ).rejects.toMatchObject({ code: "primary-asset-conflict" });
      const query = await createQueryApplication(env.home);
      try {
        expect((await query.query!.detail(id)).primary_pdf?.asset.sha256).toBe(
          receipt.sha256,
        );
      } finally {
        await query.close();
      }
      await env.restart();
      expect((await env.app.library.detail(id)).primary_pdf?.asset.sha256).toBe(
        receipt.sha256,
      );
    } finally {
      await env.close();
    }
  });

  it("rejects bad and wrong-article files, cancellation and publication failure without a primary fact", async () => {
    const env = await setup();
    const bytes = workbenchPdf();
    try {
      await expect(
        env.app.maintenance!.ingestPdf({
          literature_id: id,
          bytes: Buffer.from("not a PDF"),
        }),
      ).rejects.toBeInstanceOf(Error);
      const wrong = workbenchPdf("10.5555/another.paper");
      await expect(
        env.app.maintenance!.ingestPdf({ literature_id: id, bytes: wrong }),
      ).rejects.toMatchObject({ code: "candidate-uncertain" });
      const stop = new AbortController();
      stop.abort();
      await expect(
        env.app.maintenance!.ingestPdf(
          { literature_id: id, bytes },
          stop.signal,
        ),
      ).rejects.toMatchObject({ code: "manual-pdf-cancelled" });
      expect((await env.app.library.detail(id)).primary_pdf).toBeNull();
      const publish = vi
        .spyOn(env.app.execution!.publisher, "publish")
        .mockRejectedValueOnce(new CandidatePublicationError(false));
      await expect(
        env.app.maintenance!.ingestPdf({ literature_id: id, bytes }),
      ).rejects.toBeInstanceOf(CandidatePublicationError);
      publish.mockRestore();
      expect((await env.app.library.detail(id)).primary_pdf).toBeNull();
      expect((await env.app.database.snapshotCounts()).tables).toMatchObject({
        assets: 0,
        literature_assets: 0,
      });
    } finally {
      await env.close();
    }
  });

  it("routes the existing CLI import through the shared use case", async () => {
    const env = await setup();
    const source = join(env.home, "cli-paper.pdf");
    try {
      await writeFile(source, workbenchPdf());
      await env.app.close();
      const output: string[] = [];
      const result = await runCli(["import", "pdf", id, source], {
        home: env.home,
        json: true,
        stdout: (value) => output.push(value),
      });
      expect(result.code).toBe(0);
      expect(output.join("")).toContain("sha256");
      expect(await sha256(await readFile(source))).toBe(
        await sha256(workbenchPdf()),
      );
      const query = await createQueryApplication(env.home);
      try {
        expect((await query.query!.detail(id)).primary_pdf?.asset.sha256).toBe(
          await sha256(workbenchPdf()),
        );
      } finally {
        await query.close();
      }
    } finally {
      await env.close();
    }
  });

  it("lets CLI import upgrade an isolated v1 catalog but refuses an invalid synthetic marker without changing bytes", async () => {
    const home = await mkdtemp(join(tmpdir(), "sciretriever-manual-v1-"));
    const catalog = join(home, "catalog.sqlite");
    const source = join(home, "paper.pdf");
    const database = new SqliteWorker(catalog);
    try {
      await database.schema();
      await database.putLiterature(parseLiterature(FIXTURE_LITERATURE));
    } finally {
      await database.close();
    }
    try {
      await writeFile(source, workbenchPdf());
      await expect(
        authorizeExecutionSchema("upgrade-synthetic", {
          catalog_path: catalog,
          scope: { user_home: home },
        }),
      ).rejects.toMatchObject({ code: "migration-target-production" });
      await writeFile(join(home, SYNTHETIC_CATALOG_MARKER_FILE), "invalid");
      const before = await sha256(await readFile(catalog));
      expect((await runCli(["import", "pdf", id, source], { home })).code).toBe(
        3,
      );
      expect(await sha256(await readFile(catalog))).toBe(before);
      await rm(join(home, SYNTHETIC_CATALOG_MARKER_FILE));
      expect((await runCli(["import", "pdf", id, source], { home })).code).toBe(
        0,
      );
      const query = await createQueryApplication(home);
      try {
        expect((await query.query!.detail(id)).primary_pdf?.asset.sha256).toBe(
          await sha256(workbenchPdf()),
        );
      } finally {
        await query.close();
      }
      expect(await sha256(await readFile(source))).toBe(
        await sha256(workbenchPdf()),
      );
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("preserves intake and transfer cleanup errors together", async () => {
    const env = await setup();
    try {
      const intakeError = new Error("synthetic append failure");
      const cleanupError = new Error("synthetic discard failure");
      vi.spyOn(env.app.execution!.transfers, "append").mockRejectedValueOnce(
        intakeError,
      );
      vi.spyOn(env.app.execution!.transfers, "discard").mockRejectedValueOnce(
        cleanupError,
      );
      await expect(
        env.app.maintenance!.ingestPdf({
          literature_id: id,
          bytes: workbenchPdf(),
        }),
      ).rejects.toMatchObject({
        errors: [intakeError, cleanupError],
        cause: intakeError,
      });
    } finally {
      await env.close();
    }
  });

  it("exposes an authenticated upload and separate read route without a Browser runtime", async () => {
    const env = await setup();
    await env.app.close();
    const server = await startMaintenanceWorkbench({
      home: env.home,
      assets: new Map([
        ["/", { contentType: "text/html", body: "<html>maintenance</html>" }],
        ["/query", { contentType: "text/html", body: "<html>query</html>" }],
      ]),
    });
    try {
      expect(server.application.browserHost()).toBeNull();
      expect((await fetch(server.origin)).status).toBe(200);
      const root = await fetch(server.origin);
      const cookie = root.headers.get("set-cookie")?.split(";")[0];
      expect(cookie).toBeTruthy();
      expect((await fetch(`${server.origin}/query`)).status).toBe(200);
      const unauthenticated = await fetch(
        `${server.origin}/api/v1/maintenance/ingest-pdf`,
        {
          method: "POST",
          headers: { "Content-Type": "application/pdf", "X-Literature-Id": id },
          body: Buffer.from(workbenchPdf()),
        },
      );
      expect(unauthenticated.status).toBe(403);
      const session = await fetch(
        `${server.origin}/api/v1/maintenance/session`,
        { headers: { Cookie: cookie! } },
      );
      expect(session.status).toBe(200);
      const grant = (await session.json()) as { csrf: string };
      const invalidPath = await fetch(
        `${server.origin}/api/v1/maintenance/ingest-pdf`,
        {
          method: "POST",
          headers: {
            Cookie: cookie!,
            Origin: server.origin,
            "X-Sciretriever-Csrf": grant.csrf,
            "Content-Type": "application/json",
            "X-Sciretriever-Protocol-Version": "1",
            "X-Literature-Id": id,
          },
          body: JSON.stringify({ path: "/etc/passwd" }),
        },
      );
      expect(invalidPath.status).toBe(400);
      const invalidPdf = await fetch(
        `${server.origin}/api/v1/maintenance/ingest-pdf`,
        {
          method: "POST",
          headers: {
            Cookie: cookie!,
            Origin: server.origin,
            "X-Sciretriever-Csrf": grant.csrf,
            "Content-Type": "application/pdf",
            "X-Sciretriever-Protocol-Version": "1",
            "X-Literature-Id": id,
          },
          body: Buffer.from("not a PDF"),
        },
      );
      expect(invalidPdf.status).toBe(400);
      expect(await invalidPdf.json()).toMatchObject({
        code: "manual-pdf-invalid",
      });
      expect(
        (await server.application.library.detail(id)).primary_pdf,
      ).toBeNull();
      const uploaded = await fetch(
        `${server.origin}/api/v1/maintenance/ingest-pdf`,
        {
          method: "POST",
          headers: {
            Cookie: cookie!,
            Origin: server.origin,
            "X-Sciretriever-Csrf": grant.csrf,
            "Content-Type": "application/pdf",
            "X-Sciretriever-Protocol-Version": "1",
            "X-Literature-Id": id,
          },
          body: Buffer.from(workbenchPdf()),
        },
      );
      expect(uploaded.status).toBe(200);
      expect(await uploaded.json()).toMatchObject({
        protocol_version: 1,
        receipt: { sha256: await sha256(workbenchPdf()) },
      });
      const headers = {
        Cookie: cookie!,
        Origin: server.origin,
        "X-Sciretriever-Csrf": grant.csrf,
        "Content-Type": "application/pdf",
        "X-Sciretriever-Protocol-Version": "1",
        "X-Literature-Id": id,
      };
      const conflict = await fetch(
        `${server.origin}/api/v1/maintenance/ingest-pdf`,
        {
          method: "POST",
          headers,
          body: Buffer.from(workbenchPdf()),
        },
      );
      expect(conflict.status).toBe(409);
      expect(await conflict.json()).toMatchObject({
        code: "primary-asset-conflict",
      });
      expect(
        (await server.application.library.detail(id)).primary_pdf?.asset.sha256,
      ).toBe(await sha256(workbenchPdf()));
      const query = await fetch(`${server.origin}/api/v1/query/read`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          protocol_version: 1,
          request: { literature_id: id },
        }),
      });
      expect(query.status).toBe(200);
      expect(await query.json()).toMatchObject({
        detail: {
          primary_pdf: { asset: { sha256: await sha256(workbenchPdf()) } },
        },
      });
    } finally {
      await server.close();
      await env.close();
    }
  });

  it("cancels a received upload when the client disconnects during identity inspection", async () => {
    const env = await setup();
    await env.app.close();
    const server = await startMaintenanceWorkbench({
      home: env.home,
      assets: pageAssets,
    });
    let entered!: () => void;
    let release!: () => void;
    const inspected = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const actual = server.application.library.detail.bind(
      server.application.library,
    );
    vi.spyOn(server.application.library, "detail").mockImplementation(
      async (literatureId) => {
        entered();
        await gate;
        return actual(literatureId);
      },
    );
    try {
      const root = await fetch(server.origin);
      const cookie = root.headers.get("set-cookie")!.split(";")[0]!;
      const session = await fetch(
        `${server.origin}/api/v1/maintenance/session`,
        {
          headers: { Cookie: cookie },
        },
      );
      const grant = (await session.json()) as { csrf: string };
      const stop = new AbortController();
      const upload = fetch(`${server.origin}/api/v1/maintenance/ingest-pdf`, {
        method: "POST",
        headers: {
          Cookie: cookie,
          Origin: server.origin,
          "X-Sciretriever-Csrf": grant.csrf,
          "Content-Type": "application/pdf",
          "X-Sciretriever-Protocol-Version": "1",
          "X-Literature-Id": id,
        },
        body: Buffer.from(workbenchPdf()),
        signal: stop.signal,
      });
      await inspected;
      stop.abort();
      await expect(upload).rejects.toMatchObject({ name: "AbortError" });
      release();
      await vi.waitFor(async () => {
        expect(
          (await server.application.library.detail(id)).primary_pdf,
        ).toBeNull();
        expect(
          (await server.application.database.snapshotCounts()).tables,
        ).toMatchObject({
          literature_assets: 0,
        });
      });
    } finally {
      release();
      await server.close();
      await env.close();
    }
  });

  it("publishes the same close result before a resource can reenter close", async () => {
    const env = await setup();
    await env.app.close();
    const server = await startMaintenanceWorkbench({
      home: env.home,
      assets: pageAssets,
    });
    const actual = server.application.close.bind(server.application);
    let nested: Promise<void> | undefined;
    vi.spyOn(server.application, "close").mockImplementation(() => {
      nested = server.close();
      return actual();
    });
    try {
      const first = server.close();
      expect(server.close()).toBe(first);
      await first;
      expect(nested).toBe(first);
    } finally {
      await server.close();
      await env.close();
    }
  });

  it("reports a failed maintenance close after releasing HTTP and catalog resources", async () => {
    const env = await setup();
    await env.app.close();
    const server = await startMaintenanceWorkbench({
      home: env.home,
      assets: pageAssets,
    });
    const actual = server.application.close.bind(server.application);
    const failure = new Error("synthetic application close failure");
    vi.spyOn(server.application, "close").mockImplementation(async () => {
      await actual();
      throw failure;
    });
    try {
      const closing = server.close();
      expect(server.close()).toBe(closing);
      await expect(closing).rejects.toMatchObject({ errors: [failure] });
      await expect(fetch(server.origin)).rejects.toBeInstanceOf(Error);
      const reopened = await createQueryApplication(env.home);
      await reopened.close();
    } finally {
      await env.close();
    }
  });

  it("uses the same cancellation and conflict rules on the Browser workbench upload route", async () => {
    const env = await setup();
    const session = new WorkbenchSession(
      "article-1",
      {
        id: "page-1",
        title: async () => "Fixture",
        url: () => "http://127.0.0.1/article",
        navigate: async () => {},
        close: async () => {},
        snapshot: async () => ({
          url: "http://127.0.0.1/article",
          title: "Fixture",
          document_generation: 1,
          viewport: { width: 800, height: 600, device_scale_factor: 1 },
          screenshot: new Uint8Array([1, 2]),
        }),
        apply: async () => {},
      },
      {
        max_actions: 10,
        max_model_calls: 2,
        max_retries: 2,
        max_bytes: 10000,
        deadline_ms: 60000,
      },
    );
    await session.refresh();
    const http = await startWorkbenchHttp({
      session,
      maintenance: env.app.maintenance!,
      assets: pageAssets,
    });
    try {
      const root = await fetch(http.origin);
      const cookie = root.headers.get("set-cookie")!.split(";")[0]!;
      const client = await fetch(`${http.origin}/api/clients`, {
        method: "POST",
        headers: {
          Cookie: cookie,
          Origin: http.origin,
          "Content-Type": "application/json",
          "X-Workbench-Init": "1",
        },
        body: "{}",
      });
      const grant = (await client.json()) as {
        client_id: string;
        csrf: string;
      };
      const url = `${http.origin}/api/maintenance/ingest-pdf?client_id=${grant.client_id}`;
      const headers = {
        Cookie: cookie,
        Origin: http.origin,
        "X-Workbench-Csrf": grant.csrf,
        "Content-Type": "application/pdf",
        "X-Sciretriever-Protocol-Version": "1",
        "X-Literature-Id": id,
      };
      let entered!: () => void;
      let release!: () => void;
      const inspected = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const actual = env.app.library.detail.bind(env.app.library);
      vi.spyOn(env.app.library, "detail").mockImplementationOnce(
        async (literatureId) => {
          entered();
          await gate;
          return actual(literatureId);
        },
      );
      const stop = new AbortController();
      const pending = fetch(url, {
        method: "POST",
        headers,
        body: Buffer.from(workbenchPdf()),
        signal: stop.signal,
      });
      await inspected;
      stop.abort();
      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
      release();
      await vi.waitFor(async () => {
        expect((await env.app.library.detail(id)).primary_pdf).toBeNull();
      });
      const invalid = await fetch(url, {
        method: "POST",
        headers,
        body: Buffer.from("not a PDF"),
      });
      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toMatchObject({
        code: "manual-pdf-invalid",
      });
      const accepted = await fetch(url, {
        method: "POST",
        headers,
        body: Buffer.from(workbenchPdf()),
      });
      expect(accepted.status).toBe(200);
      const conflict = await fetch(url, {
        method: "POST",
        headers,
        body: Buffer.from(workbenchPdf()),
      });
      expect(conflict.status).toBe(409);
      expect(await conflict.json()).toMatchObject({
        code: "primary-asset-conflict",
      });
      expect((await env.app.library.detail(id)).primary_pdf?.asset.sha256).toBe(
        await sha256(workbenchPdf()),
      );
    } finally {
      await http.close();
      await env.close();
    }
  });
});
