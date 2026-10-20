import { expect, it } from "vitest";
import {
  type WorkbenchStaticAsset,
  startWorkbenchHttp,
} from "../src/workbench/http.js";
import { ProductionWorkbenchSession } from "../src/workbench/production-session.js";
import {
  workbenchLogin,
  workbenchTestAccess,
} from "./workbench-auth-fixture.js";

it("authenticates the root React entry before granting the workbench cookie and rejects retired entry routes", async () => {
  const session = new ProductionWorkbenchSession(null, undefined);
  const html = { contentType: "text/html", body: "React fixture" };
  const assets = new Map<string, WorkbenchStaticAsset>([
    ["/", html],
    [
      "/assets/app-123.js",
      { contentType: "text/javascript", body: "export {};" },
    ],
  ]);
  const server = await startWorkbenchHttp({
    session,
    assets,
    access: workbenchTestAccess,
  });
  try {
    const unauthenticated = await fetch(
      `${server.origin}/?view=web&session=test-session`,
      { redirect: "manual" },
    );
    expect(unauthenticated.status).toBe(303);
    expect(unauthenticated.headers.get("location")).toBe(
      "/auth?next=%2F%3Fview%3Dweb%26session%3Dtest-session",
    );
    expect(unauthenticated.headers.has("set-cookie")).toBe(false);
    expect((await fetch(`${server.origin}/assets/app-123.js`)).status).toBe(
      401,
    );
    const auth = await workbenchLogin(server.origin);
    let grantedCookie = auth;
    for (const path of [
      "/",
      "/?view=gallery",
      "/?view=archive",
      "/?view=tags&tag=synthetic-tag",
      "/?view=snapshots&snapshot=synthetic-snapshot&processor=summary",
      "/?view=lib&reader=pdf&page=1&region=%5B0,0,1000,1000%5D",
      "/?view=lib&inspect=1",
      "/?view=lib&query=%7B%22document_type%22%3A%22article%22%7D",
      "/?view=lib&reader=doc&from=syn&artifact=fixed-synthesis",
      "/?view=lab",
      "/?view=ins&scope=all",
      "/?view=web&session=test-session&article=test-article",
      ...[
        "paths",
        "sources",
        "models",
        "parser",
        "cred",
        "status",
        "advanced",
        "appearance",
        "archive",
      ].map((setting) => `/?view=set&setting=${setting}`),
    ]) {
      const response = await fetch(server.origin + path, {
        headers: { Cookie: auth },
        redirect: "manual",
      });
      expect(response.status, path).toBe(200);
      expect(response.headers.has("location"), path).toBe(false);
      expect(await response.text(), path).toBe("React fixture");
      const browserCookie = response.headers
        .getSetCookie()
        .map((value) => value.split(";")[0])
        .join("; ");
      expect(browserCookie).not.toBe("");
      grantedCookie = `${auth}; ${browserCookie}`;
      const attached = await fetch(`${server.origin}/api/clients`, {
        method: "POST",
        headers: {
          Cookie: `${auth}; ${browserCookie}`,
          Origin: server.origin,
          "X-Workbench-Init": "1",
          "Content-Type": "application/json",
        },
        body: "{}",
      });
      expect(attached.status, path).toBe(201);
      const client = (await attached.json()) as {
        client_id: string;
        csrf: string;
      };
      expect(
        (
          await fetch(
            `${server.origin}/api/clients/disconnect?client_id=${client.client_id}`,
            {
              method: "POST",
              headers: {
                Cookie: grantedCookie,
                Origin: server.origin,
                "X-Workbench-Csrf": client.csrf,
                "Content-Type": "application/json",
              },
              body: "{}",
            },
          )
        ).status,
      ).toBe(200);
    }
    for (const query of [
      "view=web&session=%2Fetc%2Fpasswd",
      "view=web&article=bad%20id",
      "view=set&setting=unknown",
      "view=set&setting=storage",
      "view=set&setting=credentials",
      "view=gallery&view=lib",
      "scope=unknown",
      "from=unknown",
      "redirect=https://example.com",
      "unknown=x",
      "page=-1",
      "region=%5B-1,0,2000,3%5D",
      "processor=unknown",
      "snapshot=bad%20id",
    ]) {
      const response = await fetch(`${server.origin}/?${query}`, {
        headers: { Cookie: auth },
      });
      expect(response.status, query).toBe(400);
      expect(await response.json()).toEqual({ code: "invalid-ui-location" });
      expect(response.headers.has("set-cookie")).toBe(false);
    }
    expect(
      await (await fetch(server.origin, { headers: { Cookie: auth } })).text(),
    ).toBe("React fixture");
    const staticResponse = await fetch(`${server.origin}/assets/app-123.js`, {
      headers: { Cookie: grantedCookie },
    });
    expect(staticResponse.status).toBe(200);
    expect(await staticResponse.text()).toBe("export {};");
    for (const path of [
      "/next",
      "/next/",
      "/next/index.html",
      "/next/query",
      "/next/assets/app-123.js",
    ]) {
      const response = await fetch(server.origin + path, {
        headers: { Cookie: grantedCookie },
        redirect: "manual",
      });
      expect(response.status, path).toBe(404);
      expect(response.headers.has("location"), path).toBe(false);
      expect(response.headers.has("set-cookie"), path).toBe(false);
    }
  } finally {
    await server.close();
    await session.close();
  }
});
