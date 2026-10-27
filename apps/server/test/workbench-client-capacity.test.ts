import { expect, it } from "vitest";
import { WorkbenchSession } from "../src/workbench/session.js";
import { ProductionWorkbenchSession } from "../src/workbench/production-session.js";
import { startWorkbenchHttp } from "../src/workbench/http.js";
import {
  workbenchLogin,
  workbenchTestAccess,
} from "./workbench-auth-fixture.js";

function syntheticSession() {
  return new WorkbenchSession(
    "capacity-fixture",
    {
      id: "fixture-page",
      title: async () => "Fixture",
      url: () => "http://127.0.0.1/fixture",
      navigate: async () => undefined,
      close: async () => undefined,
      apply: async () => undefined,
      snapshot: async () => ({
        url: "http://127.0.0.1/fixture",
        title: "Fixture",
        document_generation: 1,
        viewport: { width: 800, height: 600, device_scale_factor: 1 },
        screenshot: null,
      }),
    },
    {
      max_actions: 1,
      max_model_calls: 1,
      max_retries: 1,
      max_bytes: 1024,
      deadline_ms: 60000,
    },
  );
}

it.each(["synthetic", "production"] as const)(
  "reports %s client capacity without closing the workspace, and admits clients after an authenticated detach",
  async (kind) => {
    const session =
      kind === "synthetic"
        ? syntheticSession()
        : new ProductionWorkbenchSession(null, async () => {
            throw new Error("Acquisition must remain offline");
          });
    const server = await startWorkbenchHttp({
      session,
      access: workbenchTestAccess,
      assets: new Map([["/", { contentType: "text/html", body: "Synthetic" }]]),
    });
    try {
      const auth = await workbenchLogin(server.origin);
      const index = await fetch(server.origin, { headers: { Cookie: auth } });
      const cookie =
        auth +
        "; " +
        index.headers
          .getSetCookie()
          .map((v) => v.split(";")[0])
          .join("; ");
      const headers = {
        Cookie: cookie,
        Origin: server.origin,
        "Content-Type": "application/json",
        "X-Workbench-Init": "1",
      };
      const attach = () =>
        fetch(server.origin + "/api/clients", {
          method: "POST",
          headers,
          body: "{}",
        });
      const grants: { client_id: string; csrf: string }[] = [];
      for (let n = 0; n < 16; n++) {
        const response = await attach();
        expect(response.status).toBe(201);
        grants.push(
          (await response.json()) as { client_id: string; csrf: string },
        );
      }
      expect(session.view().control.viewers).toBe(16);
      const rejected = await attach();
      expect(rejected.status).toBe(429);
      expect(await rejected.json()).toEqual({ code: "viewer-limit" });
      const first = grants[0]!;
      const view = await fetch(
        `${server.origin}/api/view?client_id=${first.client_id}`,
        { headers },
      );
      expect(view.status).toBe(200);
      const disconnect = (csrf: string) =>
        fetch(
          `${server.origin}/api/clients/disconnect?client_id=${first.client_id}`,
          {
            method: "POST",
            headers: { ...headers, "X-Workbench-Csrf": csrf },
            body: "{}",
          },
        );
      expect((await disconnect("invalid")).status).toBe(403);
      expect(session.view().control.viewers).toBe(16);
      expect((await disconnect(first.csrf)).status).toBe(200);
      expect(session.view().control.viewers).toBe(15);
      expect((await attach()).status).toBe(201);
      expect(session.view().control.viewers).toBe(16);
      await session.close();
      const closed = await attach();
      expect(closed.status).toBe(409);
      expect(await closed.json()).toEqual({ code: "session-closed" });
    } finally {
      await server.close();
      await session.close();
    }
  },
);
