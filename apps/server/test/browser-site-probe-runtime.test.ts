import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, writeFile, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { verifyInstalledCloakRuntime } from "../src/configuration/cloak-runtime.js";
import { createBrowserSiteProbe } from "../src/browser/site-probe.js";
import { createApplication } from "../src/bootstrap/application.js";
import {
  ConfigurationProbeSession,
  TypeScriptConfigurationOwner,
} from "../src/configuration/owner.js";

describe.runIf(!!process.env.SCIRETRIEVER_CLOAK_BUNDLE)(
  "verified Browser Site probe on loopback",
  () => {
    it("rejects enabled Browser configuration without a fixed Profile before probing", async () => {
      const home = await mkdtemp(
        join(tmpdir(), "sciretriever-site-no-profile-"),
      );
      const directory = join(home, ".sciretriever");
      await mkdir(directory, { mode: 0o700 });
      await writeFile(
        join(directory, "config.toml"),
        "[browser]\nenabled = true\n",
        {
          mode: 0o600,
        },
      );
      try {
        await expect(
          ConfigurationProbeSession.create(
            new TypeScriptConfigurationOwner(home),
          ),
        ).rejects.toMatchObject({ code: "configuration-boundary" });
        await expect(lstat(join(home, "profile"))).rejects.toMatchObject({
          code: "ENOENT",
        });
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    });
    it("assembles the formal Application Browser owner from the verified bundle without launching it", async () => {
      const home = await mkdtemp(join(tmpdir(), "sciretriever-browser-entry-"));
      const directory = join(home, ".sciretriever");
      await mkdir(directory, { mode: 0o700 });
      await writeFile(
        join(directory, "config.toml"),
        '[browser]\nenabled = true\nprofile = "synthetic"\n',
        { mode: 0o600 },
      );
      let application:
        | Awaited<ReturnType<typeof createApplication>>
        | undefined;
      try {
        application = await createApplication(home, {
          executionSchema: "upgrade-synthetic",
        });
        expect(application.browserHost()).not.toBeNull();
        expect(
          application.acquisition.statuses.find(
            (status) => status.source_name === "browser",
          ),
        ).toMatchObject({ ready: true });
        await expect(lstat(join(home, "profile"))).rejects.toMatchObject({
          code: "ENOENT",
        });
      } finally {
        await application?.close();
        await rm(home, { recursive: true, force: true });
      }
    }, 60_000);

    it("loads only the selected top-level homepage and blocks automatic PDF requests", async () => {
      const runtime = await verifyInstalledCloakRuntime(
        process.env.SCIRETRIEVER_CLOAK_BUNDLE!,
      );
      const requests: string[] = [];
      const server = createServer((request, response) => {
        requests.push(request.url ?? "");
        response.writeHead(200, { "content-type": "text/html" });
        response.end(
          '<title>Fixture</title><a href="/paper.pdf">PDF</a>' +
            '<iframe src="/paper.pdf"></iframe>' +
            '<img src="/paper.pdf">' +
            '<script>fetch("/paper.pdf");location.href="/paper.pdf"</script>' +
            '<meta http-equiv="refresh" content="0;url=/paper.pdf">',
        );
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      try {
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("fixture");
        const site = createBrowserSiteProbe(runtime, {
          fixture: `http://127.0.0.1:${address.port}/`,
        });
        await site.probe("fixture");
        expect(requests).toContain("/");
        expect(requests).toEqual(["/"]);
        const count = requests.length;
        await expect(site.probe("other")).rejects.toBeDefined();
        expect(requests).toHaveLength(count);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }, 60_000);

    it("reports a close failure during cancellation instead of passing the probe", async () => {
      const runtime = await verifyInstalledCloakRuntime(
        process.env.SCIRETRIEVER_CLOAK_BUNDLE!,
      );
      const controller = new AbortController();
      const closeFailure = new Error("synthetic host close failure");
      let rejectOpen: ((reason: Error) => void) | undefined;
      let closes = 0;
      const site = createBrowserSiteProbe(
        runtime,
        { fixture: "http://127.0.0.1:1/" },
        undefined,
        () => ({
          start: async () => undefined,
          openPage: () => {
            queueMicrotask(() => controller.abort());
            return new Promise<never>((_resolve, reject) => {
              rejectOpen = reject;
            });
          },
          close: () => {
            closes += 1;
            rejectOpen?.(new Error("page closed"));
            return Promise.reject(closeFailure);
          },
        }),
      );
      await expect(
        site.probe("fixture", controller.signal),
      ).rejects.toMatchObject({
        code: "browser-site-probe-failed",
      });
      expect(closes).toBe(1);
    });
  },
);
