import { motionOptions } from "./next-workspace-fixture.js";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "vite";
import { chromium } from "playwright";
import { expect, it, vi } from "vitest";
import { startWorkbenchHttp } from "../../server/src/workbench/http.js";
import { ProductionWorkbenchSession } from "../../server/src/workbench/production-session.js";
import {
  workbenchTestAccess,
  WORKBENCH_TEST_PASSWORD,
} from "../../server/test/workbench-auth-fixture.js";

it("keeps normal login and the workbench grant in Vite development and refreshes a component without losing its state", async () => {
  const root = await mkdtemp(join(tmpdir(), "sciretriever-react-hmr-"));
  const session = new ProductionWorkbenchSession(null, undefined);
  const backend = await startWorkbenchHttp({
    session,
    access: workbenchTestAccess,
    assets: new Map([
      ["/", { contentType: "text/html", body: "authenticated bootstrap" }],
    ]),
  });
  vi.stubEnv("SCIRETRIEVER_WEB_API_ORIGIN", backend.origin);
  let dev: Awaited<ReturnType<typeof createServer>> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    await symlink(
      resolve("apps/web/node_modules"),
      join(root, "node_modules"),
      "dir",
    );
    await writeFile(
      join(root, "index.html"),
      '<!doctype html><div id="root"></div><script type="module" src="/main.jsx"></script>',
    );
    await writeFile(
      join(root, "main.jsx"),
      'import React from "react"; import { createRoot } from "react-dom/client"; import App from "./App.jsx"; createRoot(document.getElementById("root")).render(<App/>);',
    );
    const component = (version: string) =>
      `import React, {useState} from "react"; export default function App(){const [count,setCount]=useState(0);return <><h1>${version}</h1><button onClick={()=>setCount(count+1)}>Count {count}</button></>}`;
    await writeFile(join(root, "App.jsx"), component("Version one"));
    dev = await createServer({
      configFile: resolve("apps/web/vite.config.mjs"),
      root,
      server: { port: 0 },
      logLevel: "error",
    });
    await dev.listen();
    const address = dev.httpServer?.address();
    if (!address || typeof address === "string")
      throw new Error("Development server address unavailable");
    const origin = `http://127.0.0.1:${address.port}`;
    const blocked = await fetch(origin, { redirect: "manual" });
    expect(blocked.status).toBe(303);
    expect(blocked.headers.get("location")).toContain("/auth?next=");
    browser = await chromium.launch({
      ...(process.env.SCIRETRIEVER_BROWSER_EXECUTABLE
        ? { executablePath: process.env.SCIRETRIEVER_BROWSER_EXECUTABLE }
        : {}),
      headless: true,
    });
    const page = await browser.newPage(motionOptions());
    const logged = await page.request.post(`${origin}/auth/login`, {
      headers: { Origin: origin, "X-Workbench-Init": "1" },
      data: { password: WORKBENCH_TEST_PASSWORD },
    });
    expect(logged.status()).toBe(200);
    await page.goto(origin);
    await page.getByRole("heading", { name: "Version one" }).waitFor();
    const attached = await page.request.post(`${origin}/api/clients`, {
      headers: { Origin: origin, "X-Workbench-Init": "1" },
      data: {},
    });
    expect(attached.status()).toBe(201);
    await page.getByRole("button", { name: "Count 0" }).click();
    await writeFile(join(root, "App.jsx"), component("Version two"));
    await page.getByRole("heading", { name: "Version two" }).waitFor();
    expect(await page.getByRole("button", { name: "Count 1" }).count()).toBe(1);
    for (const path of ["/next", "/next/", "/next/index.html"])
      expect((await page.request.get(origin + path)).status()).toBe(404);
  } finally {
    await browser?.close();
    await dev?.close();
    await backend.close();
    await session.close();
    await rm(root, { recursive: true, force: true });
    vi.unstubAllEnvs();
  }
}, 60000);
