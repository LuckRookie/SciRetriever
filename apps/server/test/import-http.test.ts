import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import {
  parseDeviceConnectionCode,
  type DevicePurpose,
} from "@sciretriever/contracts";
import { createApplication } from "../src/bootstrap/application.js";
import { deviceBusinessRoutes } from "../src/bootstrap/device-routes.js";
import { startWorkbenchHttp } from "../src/workbench/http.js";
import { ProductionWorkbenchSession } from "../src/workbench/production-session.js";
import {
  FIXTURE_LITERATURE,
  workbenchPdf,
} from "../src/workbench/synthetic-fixture.js";
import {
  workbenchLogin,
  workbenchTestAccess,
} from "./workbench-auth-fixture.js";

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
    const importToken = await token("import"),
      deviceHeaders = {
        Authorization: `Bearer ${importToken}`,
        Origin: "chrome-extension://synthetic",
      };
    for (const p of ["read", "operate", "capture"] as const)
      expect(
        (
          await send(
            "/api/v1/import/sessions/list",
            {},
            { Authorization: `Bearer ${await token(p)}` },
          )
        ).status,
      ).toBe(403);
    expect((await send("/api/v1/import/sessions", {}, {})).status).toBe(401);
    expect(
      (
        await send(
          "/api/v1/import/sessions/list?client_id=" + grant.client_id,
          {},
          { ...webHeaders, Origin: "https://outside.invalid" },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await send(
          "/api/v1/import/sessions/list?client_id=" + grant.client_id,
          {},
          { ...webHeaders, "X-Workbench-Csrf": "wrong" },
        )
      ).status,
    ).toBe(403);
    const local = await web("/api/v1/import/sessions", {
      format: "records",
      library: {
        system: "synthetic",
        library_id: "1",
        identity: "local",
        name: "local",
      },
      scope: "local",
    });
    expect(local.status).toBe(400);
    expect((await local.json()).code).toBe("import-local-identity-required");
    for (const mode of ["web", "device"] as const) {
      const call = (path: string, request: unknown) =>
        mode === "web"
          ? web(path, request)
          : send(path, request, deviceHeaders);
      const created = await call("/api/v1/import/sessions", {
        format: "records",
        library: {
          system: "synthetic",
          library_id: randomUUID(),
          identity: "global",
          name: mode,
        },
        scope: "single item",
      });
      expect(created.status).toBe(200);
      const sid = (await created.json()).result.session.session_id as string,
        base = `/api/v1/import/sessions/${sid}`;
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
      expect(result.session.state).toBe("completed");
      expect(result.summary.records.created).toBe(1);
      expect(result.summary.files.uploaded).toBe(1);
      expect((await call(base + "/finish", {})).status).toBe(200);
    }
    const docs = await fetch(server.origin + "/api/v1/import/instructions", {
      headers: deviceHeaders,
    });
    expect(docs.status).toBe(200);
    const reference = (await docs.json()).result;
    expect(reference.endpoints).toHaveLength(13);
    expect(reference.formats).toContain("records");
    expect((await web("/api/v1/import/sessions/list", {})).status).toBe(200);
    const oversized = await fetch(
      server.origin + "/api/v1/import/sessions/list",
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
    expect((await oversized.json()).code).toBe("import-request-too-large");
  } finally {
    await server.close();
    await session.close();
    await app.close();
    await rm(home, { recursive: true, force: true });
  }
}, 30000);
