import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import {
  parseDeviceConnectionCode,
  type DevicePurpose,
} from "@sciretriever/contracts";
import { createApplication } from "../src/bootstrap/application.js";
import { createMetadataOperations } from "../src/entry/metadata-operations.js";
import { deviceBusinessRoutes } from "../src/bootstrap/device-routes.js";
import { startWorkbenchHttp } from "../src/workbench/http.js";
import { ProductionWorkbenchSession } from "../src/workbench/production-session.js";
import { importInterface } from "../src/workbench/import-http.js";
import {
  FIXTURE_LITERATURE,
  workbenchPdf,
} from "../src/workbench/synthetic-fixture.js";
import {
  workbenchLogin,
  workbenchTestAccess,
} from "./workbench-auth-fixture.js";

it("describes metadata-only creation and idempotent, immutable data sequences", () => {
  const docs = importInterface(["records"]);
  expect(
    docs.endpoints.find((endpoint) => endpoint.operation === "create")?.request,
  ).toContain("metadata_only?:boolean");
  expect(docs.semantics.join(" ")).toContain(
    "Repeating a sequence with identical data is idempotent; different data is rejected with intake-data-conflict",
  );
  expect(docs.semantics.join(" ")).not.toContain("replaces that part");
});

it("shares the exact import handlers between authenticated Web and import-purpose devices without granting other purposes", async () => {
  const home = await mkdtemp(join(tmpdir(), "sciretriever-import-http-")),
    app = await createApplication(home, {
      indexRefreshIntervalMs: null,
      importSessions: { maintain: false },
    }),
    session = new ProductionWorkbenchSession(null, undefined);
  const server = await startWorkbenchHttp({
    session,
    assets: new Map([
      ["/", { contentType: "text/html", body: "fixture" }],
      ["/auth", { contentType: "text/html", body: "login" }],
    ]),
    access: workbenchTestAccess,
    importBibliography: createMetadataOperations(app).importBibliography,
    devices: {
      service: app.deviceConnections,
      routes: deviceBusinessRoutes(app),
    },
  });
  const token = async (purpose: DevicePurpose) => {
    const pairing = await app.deviceConnections.create({
      address: server.origin,
      name: "Synthetic importer",
      purposes: [purpose],
    });
    const response = await app.deviceConnections.exchange(
      {
        pairing_code: parseDeviceConnectionCode(pairing.connection_code)
          .pairing_code,
      },
      `synthetic-${purpose}`,
    );
    return response.token;
  };
  const send = (
    path: string,
    request: unknown,
    headers: Record<string, string>,
  ) =>
    fetch(server.origin + path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Sciretriever-Protocol-Version": "1",
        ...headers,
      },
      body: JSON.stringify({ protocol_version: 1, request }),
    });
  try {
    const auth = await workbenchLogin(server.origin),
      root = await fetch(server.origin, { headers: { Cookie: auth } }),
      cookie =
        auth +
        "; " +
        root.headers
          .getSetCookie()
          .map((v) => v.split(";")[0])
          .join("; ");
    const attached = await fetch(server.origin + "/api/clients", {
      method: "POST",
      headers: {
        Cookie: cookie,
        Origin: server.origin,
        "X-Workbench-Init": "1",
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    const grant = (await attached.json()) as {
      client_id: string;
      csrf: string;
    };
    const webHeaders = {
        Cookie: cookie,
        Origin: server.origin,
        "X-Workbench-Csrf": grant.csrf,
      },
      web = (path: string, request: unknown) =>
        send(path + "?client_id=" + grant.client_id, request, webHeaders);
    const importToken = await token("intake"),
      deviceHeaders = {
        Authorization: `Bearer ${importToken}`,
        Origin: "chrome-extension://synthetic",
      };
    const parent = (await app.folders.manage({
      operation: "create",
      request: { parent_id: null, name: "User folder", position: null },
    })) as { folder_id: string };
    await app.folders.manage({
      operation: "create",
      request: { parent_id: parent.folder_id, name: "Child", position: null },
    });
    const expectedFolders = await app.folders.query({
      operation: "list",
      request: {},
    });
    for (const response of [
      await send("/api/v1/intake/folders", {}, deviceHeaders),
      await web("/api/v1/intake/folders", {}),
    ]) {
      expect(response.status).toBe(200);
      expect((await response.json()).result).toEqual(expectedFolders);
    }
    for (const purpose of ["read", "operate"] as const)
      expect(
        (
          await send(
            "/api/v1/intake/folders",
            {},
            {
              Authorization: `Bearer ${await token(purpose)}`,
            },
          )
        ).status,
      ).toBe(403);
    expect((await send("/api/v1/intake/folders", {}, {})).status).toBe(401);
    for (const contentType of [
      "application/json; charset=utf-8",
      "Application/JSON; CHARSET=UTF-8",
      'application/json; charset="UTF-8"',
    ]) {
      const response = await send(
        "/api/v1/intake/batches/list",
        {},
        { ...deviceHeaders, "Content-Type": contentType },
      );
      expect(response.status).toBe(200);
      await response.json();
      expect(
        (
          await send(
            `/api/v1/intake/batches/list?client_id=${grant.client_id}`,
            {},
            { ...webHeaders, "Content-Type": contentType },
          )
        ).status,
      ).toBe(200);
    }
    for (const contentType of [
      "text/plain",
      "application/json; charset=gbk",
      "application/json; foo=bar",
      "application/json; charset=utf-8; charset=utf-8",
    ]) {
      const response = await send(
        "/api/v1/intake/batches/list",
        {},
        { ...deviceHeaders, "Content-Type": contentType },
      );
      expect(response.status).toBe(415);
      expect((await response.json()).code).toBe("content-type-unsupported");
      const webResponse = await send(
        `/api/v1/intake/batches/list?client_id=${grant.client_id}`,
        {},
        { ...webHeaders, "Content-Type": contentType },
      );
      expect(webResponse.status).toBe(415);
      expect((await webResponse.json()).code).toBe("content-type-unsupported");
    }
    for (const p of ["read", "operate"] as const)
      expect(
        (
          await send(
            "/api/v1/intake/batches/list",
            {},
            { Authorization: `Bearer ${await token(p)}` },
          )
        ).status,
      ).toBe(403);
    expect((await send("/api/v1/intake/batches", {}, {})).status).toBe(401);
    expect(
      (
        await send(
          "/api/v1/intake/batches/list?client_id=" + grant.client_id,
          {},
          { ...webHeaders, Origin: "https://outside.invalid" },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await send(
          "/api/v1/intake/batches/list?client_id=" + grant.client_id,
          {},
          { ...webHeaders, "X-Workbench-Csrf": "wrong" },
        )
      ).status,
    ).toBe(403);
    const local = await web("/api/v1/intake/batches", {
      format: "records",
      source: {
        system: "synthetic",
        library_id: "1",
        identity: "local",
        name: "local",
      },
      scope: "local",
    });
    expect(local.status).toBe(400);
    expect((await local.json()).code).toBe("intake-local-identity-required");
    for (const mode of ["web", "device"] as const) {
      const call = (path: string, request: unknown) =>
        mode === "web"
          ? web(path, request)
          : send(path, request, deviceHeaders);
      const created = await call("/api/v1/intake/batches", {
        format: "records",
        source: {
          system: "synthetic",
          library_id: randomUUID(),
          identity: "global",
          name: mode,
        },
        scope: "single item",
      });
      expect(created.status).toBe(200);
      const sid = (await created.json()).result.batch.batch_id as string,
        base = `/api/v1/intake/batches/${sid}`;
      const response = await call(base + "/data", {
        sequence: 0,
        data: {
          records: [
            {
              external_id: mode,
              metadata: {
                ...FIXTURE_LITERATURE.metadata,
                title: mode,
                identifiers: [
                  { namespace: "doi", value: `10.5555/http-${mode}` },
                ],
              },
              files: [
                {
                  external_id: `pdf-${mode}`,
                  file_name: "synthetic.pdf",
                  media_type: "application/pdf",
                  preferred: true,
                },
              ],
            },
          ],
        },
      });
      expect(response.status).toBe(200);
      const preview = await call(base + "/preview", {});
      expect(preview.status).toBe(200);
      expect((await preview.json()).result.summary.files.upload).toBe(1);
      expect((await call(base + "/confirm", {})).status).toBe(200);
      await vi.waitFor(
        async () =>
          expect(
            (await (await call(base + "/files", {})).json()).result.items,
          ).toHaveLength(1),
        { timeout: 20_000 },
      );
      const missing = await call(base + "/files", {}),
        file = (await missing.json()).result.items[0] as { file_id: string };
      const uploaded = await fetch(
        server.origin +
          base +
          `/files/${file.file_id}/bytes` +
          (mode === "web" ? "?client_id=" + grant.client_id : ""),
        {
          method: "POST",
          headers: {
            ...(mode === "web" ? webHeaders : deviceHeaders),
            "Content-Type": "application/pdf",
            "X-Sciretriever-Protocol-Version": "1",
          },
          body: new Uint8Array(workbenchPdf()),
        },
      );
      expect(uploaded.status).toBe(200);
      expect((await uploaded.json()).result.file.status).toBe("uploaded");
      const report = await call(base + "/report", {});
      expect(report.status).toBe(200);
      const result = (await report.json()).result;
      expect(result.batch.state).toBe("finished");
      expect(result.summary.records.created).toBe(1);
      expect(result.summary.files.uploaded).toBe(1);
      expect((await call(base + "/finish", {})).status).toBe(200);
    }
    const fileKeys = new Set<string>();
    for (const mode of ["web", "device"] as const) {
      const call = (path: string, request: unknown) =>
        mode === "web"
          ? web(path, request)
          : send(path, request, deviceHeaders);
      const response = await call("/api/v1/intake/batches", {
        format: "bibtex",
        source: null,
        file_name: "batch-fixture.bib",
        scope: "uploaded file",
      });
      expect(response.status).toBe(200);
      const s = (await response.json()).result.batch;
      expect(s.source).toEqual({
        system: "file",
        library_id: "",
        identity: "adhoc",
        name: "batch-fixture.bib",
      });
      fileKeys.add(s.batch_id);
      const base = `/api/v1/intake/batches/${s.batch_id}`;
      expect(
        (
          await call(base + "/data", {
            sequence: 0,
            data: "@article{same,title={HTTP one-off source}}",
          })
        ).status,
      ).toBe(200);
      const preview = (await (await call(base + "/preview", {})).json()).result;
      expect(preview.summary.records).toMatchObject(
        mode === "web"
          ? { created: 1, matched: 0 }
          : { created: 0, matched: 1 },
      );
      expect((await call(base + "/confirm", {})).status).toBe(200);
      await vi.waitFor(
        async () =>
          expect(
            (await (await call(base + "/status", {})).json()).result.batch
              .state,
          ).toBe("finished"),
        { timeout: 20_000 },
      );
      expect(
        (await (await call(base + "/report", {})).json()).result.batch.state,
      ).toBe("finished");
    }
    expect(fileKeys.size).toBe(2);
    const legacy = await fetch(
      `${server.origin}/api/import?client_id=${grant.client_id}`,
      {
        method: "POST",
        headers: { ...webHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({
          format: "bibtex",
          file_name: "legacy-attachments.bib",
          content:
            "@article{legacy,title={Legacy attached paper},file={Full Text PDF:files/123/never-read.pdf:application/pdf}}",
        }),
      },
    );
    expect(legacy.status).toBe(200);
    expect(await legacy.json()).toEqual({
      report: {
        format: "bibtex",
        intake_batch_id: expect.any(String),
        items: [
          {
            record_index: 0,
            disposition: "created",
            literature_id: expect.any(String),
            meta_literature_id: expect.any(String),
            reason: null,
          },
        ],
      },
    });
    const legacySession = (await app.importSessions.list()).items.find(
      (s) => s.request.file_name === "legacy-attachments.bib",
    )!;
    expect(legacySession).toMatchObject({
      state: "finished",
      progress: null,
    });
    expect(legacySession.request.metadata_only).toBe(true);
    expect(
      (await app.importSessions.missingFiles(legacySession.batch_id)).items,
    ).toEqual([]);
    const docs = await fetch(server.origin + "/api/v1/intake/instructions", {
      headers: deviceHeaders,
    });
    expect(docs.status).toBe(200);
    const reference = (await docs.json()).result;
    expect(reference.endpoints).toHaveLength(20);
    expect(reference.endpoints).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "POST",
          path: "/api/v1/intake/literatures/:literature_id/pdf",
        }),
      ]),
    );
    expect(reference.formats).toContain("records");
    expect(reference.formats).toContain("web-page");
    expect(reference.model).toContain("WebPageData");
    expect(JSON.stringify(reference)).not.toMatch(
      /\bsessions?\b|\/api\/v1\/(?:import|capture)/u,
    );
    expect((await web("/api/v1/intake/batches/list", {})).status).toBe(200);
    const oversized = await fetch(
      server.origin + "/api/v1/intake/batches/list",
      {
        method: "POST",
        headers: {
          ...deviceHeaders,
          "Content-Type": "application/json",
          "X-Sciretriever-Protocol-Version": "1",
        },
        body: " ".repeat(8 * 1024 * 1024 + 1),
      },
    );
    expect(oversized.status).toBe(413);
    expect((await oversized.json()).code).toBe("intake-request-too-large");
    // Ownership is independent of the source namespace, and includes file
    // routes before receiving any bytes. A fresh connection is a new owner.
    const make = async (call: typeof web, scope: string) => {
      const response = await call("/api/v1/intake/batches", {
        format: "records",
        source: null,
        scope,
      });
      expect(response.status).toBe(200);
      return (await response.json()).result.batch.batch_id as string;
    };
    const ownerId = await make(
      (path, input) => send(path, input, deviceHeaders),
      "device A",
    );
    const webId = await make(web, "Web owner");
    const otherHeaders = { Authorization: `Bearer ${await token("intake")}` };
    const otherId = await make(
      (path, input) => send(path, input, otherHeaders),
      "device B",
    );
    for (const id of [ownerId, webId, randomUUID()]) {
      const base = `/api/v1/intake/batches/${id}`;
      for (const [suffix, input] of [
        ["status", {}],
        ["preview", {}],
        ["confirm", {}],
        ["files", {}],
        ["data", { sequence: 0, data: { records: [] } }],
        ["report", {}],
        ["finish", {}],
        ["cancel", {}],
        [`files/${randomUUID()}/hash`, { sha256: "a".repeat(64) }],
      ] as const) {
        const denied = await send(`${base}/${suffix}`, input, otherHeaders);
        expect(denied.status, suffix).toBe(404);
        expect((await denied.json()).code).toBe("intake-batch-missing");
      }
      const bytes = await fetch(
        server.origin + base + `/files/${randomUUID()}/bytes`,
        {
          method: "POST",
          headers: {
            ...otherHeaders,
            "Content-Type": "application/pdf",
            "X-Sciretriever-Protocol-Version": "1",
          },
          body: new Uint8Array(workbenchPdf()),
        },
      );
      expect(bytes.status).toBe(404);
      expect((await bytes.json()).code).toBe("intake-batch-missing");
    }
    const ownPage = (
      await (
        await send("/api/v1/intake/batches/list", { limit: 1 }, otherHeaders)
      ).json()
    ).result;
    expect(ownPage.items.map((s: { batch_id: string }) => s.batch_id)).toEqual([
      otherId,
    ]);
    expect(ownPage.next_cursor).toBeNull();
    const badCursor = await send(
      "/api/v1/intake/batches/list",
      { cursor: ownerId },
      otherHeaders,
    );
    expect(badCursor.status).toBe(404);
    expect((await badCursor.json()).code).toBe("intake-batch-missing");
    const all = (await (await web("/api/v1/intake/batches/list", {})).json())
      .result;
    expect(all.items.map((s: { batch_id: string }) => s.batch_id)).toEqual(
      expect.arrayContaining([ownerId, webId, otherId]),
    );
    expect(
      (await web(`/api/v1/intake/batches/${ownerId}/status`, {})).status,
    ).toBe(200);
    expect(
      (
        await send(
          `/api/v1/intake/batches/${ownerId}/status`,
          {},
          deviceHeaders,
        )
      ).status,
    ).toBe(200);
    const reconnected = { Authorization: `Bearer ${await token("intake")}` };
    expect(
      (await send(`/api/v1/intake/batches/${ownerId}/status`, {}, reconnected))
        .status,
    ).toBe(404);
  } finally {
    await server.close();
    await session.close();
    await app.close();
    await rm(home, { recursive: true, force: true });
  }
}, 30000);
