import { expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  DEVICE_PURPOSES,
  parseDeviceConnectionCode,
} from "@sciretriever/contracts";
import { startWorkbenchHttp } from "../src/workbench/http.js";
import { ProductionWorkbenchSession } from "../src/workbench/production-session.js";
import { deviceBusinessRoutes } from "../src/bootstrap/device-routes.js";
import { createTaskOperations } from "../src/entry/task-operations.js";
import { SdkTransportAdapter } from "../src/mcp/transport.js";
import { runCli } from "../src/cli/main.js";
import {
  workbenchLogin,
  workbenchTestAccess,
} from "./workbench-auth-fixture.js";
import {
  withdrawalFixture,
  withdrawalRecord,
} from "./intake-withdrawal-fixture.js";

it("requires Web login, client, Origin and CSRF for all three routes; every device purpose and MCP/CLI are refused", async () => {
  const f = await withdrawalFixture(),
    screen = new ProductionWorkbenchSession(null, undefined);
  const server = await startWorkbenchHttp({
    session: screen,
    tasks: createTaskOperations(f.app)!,
    access: workbenchTestAccess,
    assets: new Map([["/", { contentType: "text/html", body: "offline" }]]),
    devices: {
      service: f.app.deviceConnections,
      routes: deviceBusinessRoutes(f.app),
    },
  });
  const client = new Client({ name: "withdrawal-boundary", version: "1" });
  let transport: StreamableHTTPClientTransport | undefined;
  try {
    const b = await f.batch([withdrawalRecord("web-only")]);
    const paths = [
      `/batches/${b.id}/withdrawal/preview`,
      `/batches/${b.id}/withdraw`,
      `/batches/${b.id}/restore`,
    ];
    const body = JSON.stringify({ protocol_version: 1, request: {} });
    const post = (path: string, headers: Record<string, string>, suffix = "") =>
      fetch(server.origin + "/api/v1/intake" + path + suffix, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Sciretriever-Protocol-Version": "1",
          ...headers,
        },
        body,
      });
    for (const purpose of DEVICE_PURPOSES) {
      const pairing = await f.app.deviceConnections.create({
        address: server.origin,
        name: "Synthetic purpose " + purpose,
        purposes: [purpose],
      });
      const { token } = await f.app.deviceConnections.exchange(
        {
          pairing_code: parseDeviceConnectionCode(pairing.connection_code)
            .pairing_code,
        },
        randomUUID(),
      );
      for (const path of paths) {
        const response = await post(path, { Authorization: `Bearer ${token}` });
        expect(response.status).toBe(403);
        expect(await response.json()).toMatchObject({
          code: "device-purpose-forbidden",
        });
      }
    }
    const allPurposes = await f.app.deviceConnections.create({
      address: server.origin,
      name: "Synthetic full-purpose MCP",
      purposes: [...DEVICE_PURPOSES],
    });
    const { token: allToken } = await f.app.deviceConnections.exchange(
      {
        pairing_code: parseDeviceConnectionCode(allPurposes.connection_code)
          .pairing_code,
      },
      randomUUID(),
    );
    transport = new StreamableHTTPClientTransport(
      new URL("/mcp", server.origin),
      {
        requestInit: { headers: { Authorization: `Bearer ${allToken}` } },
        reconnectionOptions: {
          maxRetries: 0,
          initialReconnectionDelay: 1000,
          maxReconnectionDelay: 1000,
          reconnectionDelayGrowFactor: 1,
        },
      },
    );
    await client.connect(new SdkTransportAdapter(transport));
    const tools = (await client.listTools()).tools;
    expect(tools.some((tool) => /withdraw|restore/u.test(tool.name))).toBe(
      false,
    );
    expect(
      await client.callTool({
        name: "intake_withdraw",
        arguments: { batch_id: b.id },
      }),
    ).toMatchObject({ isError: true });
    let output = "";
    expect(
      (
        await runCli(["intake", "withdraw", b.id], {
          home: f.home,
          stdout: (value) => {
            output += value;
          },
          stderr: (value) => {
            output += value;
          },
        })
      ).code,
    ).not.toBe(0);
    expect(JSON.parse(output)).toEqual({ code: "invalid-command-input" });
    for (const path of paths) {
      const response = await post(path, {});
      expect(response.status).toBe(401);
      await response.arrayBuffer();
    }
    const login = await workbenchLogin(server.origin),
      root = await fetch(server.origin, { headers: { Cookie: login } });
    const cookie =
      login +
      "; " +
      root.headers
        .getSetCookie()
        .map((value) => value.split(";")[0])
        .join("; ");
    await root.arrayBuffer();
    const attached = await fetch(server.origin + "/api/clients", {
      method: "POST",
      headers: {
        Cookie: cookie,
        Origin: server.origin,
        "Content-Type": "application/json",
        "X-Workbench-Init": "1",
      },
      body: "{}",
    });
    expect(attached.status).toBe(201);
    const grant = (await attached.json()) as {
      client_id: string;
      csrf: string;
    };
    const suffix = "?client_id=" + grant.client_id;
    for (const path of paths) {
      const response = await post(
        path,
        { Cookie: cookie, Origin: server.origin },
        suffix,
      );
      expect(response.status).toBe(403);
      await response.arrayBuffer();
      const wrongOrigin = await post(
        path,
        {
          Cookie: cookie,
          Origin: "https://other.invalid",
          "X-Workbench-Csrf": grant.csrf,
        },
        suffix,
      );
      expect(wrongOrigin.status).toBe(403);
      await wrongOrigin.arrayBuffer();
    }
    const headers = {
      Cookie: cookie,
      Origin: server.origin,
      "X-Workbench-Csrf": grant.csrf,
    };
    for (const path of paths) {
      const missingClient = await post(path, headers);
      expect(missingClient.status).toBe(401);
      expect(await missingClient.json()).toEqual({ code: "client-required" });
    }
    const preview = await post(paths[0]!, headers, suffix);
    expect(preview.status).toBe(200);
    expect(await preview.json()).toMatchObject({
      protocol_version: 1,
      result: {
        batch: { batch_id: b.id },
        withdrawal: { remove: { literatures: 1 }, registered: false },
      },
    });
    const withdrawn = await post(paths[1]!, headers, suffix);
    expect(withdrawn.status).toBe(200);
    expect(await withdrawn.json()).toMatchObject({
      result: {
        batch: { state: "withdrawn" },
        withdrawal: { by: "web", remove: { literatures: 1 } },
      },
    });
    const restored = await post(paths[2]!, headers, suffix);
    expect(restored.status).toBe(200);
    expect(await restored.json()).toMatchObject({
      result: {
        batch: { state: "finished" },
        restoration: { by: "web", restore: { literatures: 1 } },
      },
    });
  } finally {
    await client.close();
    await transport?.close();
    await server.close();
    await screen.close();
    await f.close();
  }
});
