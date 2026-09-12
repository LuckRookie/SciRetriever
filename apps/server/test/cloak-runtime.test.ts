import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadCloakIdentity,
  verifyInstalledCloakRuntime,
} from "../src/configuration/cloak-runtime.js";
import { BrowserHost } from "../src/browser/host.js";
import { BrowserNetworkProxy } from "../src/network/browser-proxy.js";
import { NetworkBudgetCoordinator } from "../src/network/budget.js";
import { resolveDestination } from "../src/network/policy.js";

it("creates a fixed private identity, reuses it and refuses adoption or tampering", async () => {
  const profile = await mkdtemp(join(tmpdir(), "sciretriever-cloak-identity-"));
  const legacy = await mkdtemp(join(tmpdir(), "sciretriever-legacy-profile-"));
  try {
    const identity = await loadCloakIdentity(profile);
    expect(await loadCloakIdentity(profile)).toEqual(identity);
    const bytes = await readFile(join(profile, "identity-manifest.json"));
    await writeFile(
      join(profile, "identity-manifest.json"),
      bytes.toString().replace('"locale":"en-US"', '"locale":"fr-FR"'),
    );
    await expect(loadCloakIdentity(profile)).rejects.toBeDefined();
    await writeFile(join(legacy, "Preferences"), "synthetic legacy profile");
    await expect(loadCloakIdentity(legacy)).rejects.toBeDefined();
  } finally {
    await rm(profile, { recursive: true, force: true });
    await rm(legacy, { recursive: true, force: true });
  }
});

/** Explicit local runtime selection; CI without the operator binary reports this journey skipped. */
describe.runIf(!!process.env.SCIRETRIEVER_CLOAK_BUNDLE)(
  "installed CloakBrowser runtime",
  () => {
    it("runs a headed loopback journey and reuses the fixed Profile after cold restart", async () => {
      const runtime = await verifyInstalledCloakRuntime(
        process.env.SCIRETRIEVER_CLOAK_BUNDLE!,
      );
      const profile = await mkdtemp(
        join(tmpdir(), "sciretriever-cloak-journey-"),
      );
      const server = createServer((_request, response) => {
        response.writeHead(200, { "content-type": "text/html" });
        response.end(
          '<title>Cloak fixture</title><button>Verify</button><output>pending</output><script>document.querySelector("button").onclick=()=>{const count=Number(localStorage.count||0)+1;localStorage.count=String(count);document.querySelector("output").textContent=[navigator.platform,navigator.webdriver,screen.width,screen.height,count].join("|")}</script>',
        );
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("fixture");
      const resolver = () => ["127.0.0.1"];
      const policy = {
        allowed_schemes: ["http"] as const,
        allowed_classes: ["loopback"] as const,
        allowed_addresses: ["127.0.0.1"],
        allowed_ports: [{ scheme: "http" as const, port: address.port }],
      };
      const proxy = new BrowserNetworkProxy({
        resolver,
        policy,
        coordinator: new NetworkBudgetCoordinator(),
        limits: {
          maxConcurrency: 4,
          maxHostConcurrency: 4,
          maxResponseBytes: 1000000,
          maxRedirects: 0,
          maxRetries: 0,
        },
      });
      const connection = await proxy.start();
      try {
        let firstIdentity: Uint8Array | undefined;
        for (const count of [1, 2]) {
          const host = new BrowserHost({
            profile,
            runtime,
            proxy: connection,
            admitNavigation: async (url) =>
              (await resolveDestination(url, resolver, policy)).url.url,
          });
          try {
            await host.start();
            const page = await host.openPage(
              `http://127.0.0.1:${address.port}/`,
            );
            const observation = await page.snapshot();
            const button = observation.elements!.find(
              (element) => element.name === "Verify",
            )!;
            await page.apply(
              {
                kind: "click-element",
                element_id: button.element_id,
                revision: 1,
              },
              observation.document_generation!,
              () => true,
            );
            expect((await page.snapshot()).text).toContain(
              `Linux x86_64|false|1920|1080|${count}`,
            );
            const identity = await readFile(
              join(profile, "identity-manifest.json"),
            );
            if (firstIdentity) expect(identity).toEqual(firstIdentity);
            else firstIdentity = identity;
          } finally {
            await host.close();
          }
        }
      } finally {
        await proxy.close();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await rm(profile, { recursive: true, force: true });
      }
    }, 60000);
  },
);
