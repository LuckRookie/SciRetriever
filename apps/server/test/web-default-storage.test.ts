import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { startProductionWorkbench } from "../src/bootstrap/workbench.js";
import { runCli } from "../src/cli/main.js";
import { TypeScriptConfigurationOwner } from "../src/configuration/owner.js";
import { createMcpServer } from "../src/mcp/server.js";
import { inspectCatalogSchema } from "../src/storage/sqlite/catalog-schema.js";
import { SqliteWorker } from "../src/storage/sqlite/worker.js";
import { FIXTURE_LITERATURE } from "../src/workbench/synthetic-fixture.js";

const assets = new Map([
  ["/", { contentType: "text/html", body: "<main>Workbench</main>" }],
]);
const open = (home: string) =>
  startProductionWorkbench({
    home,
    port: 0,
    assets,
    applicationOptions: { browserHost: () => null, metadata: {} },
  });

describe("Web default storage", () => {
  it("shares the persisted library with CLI and MCP and reopens existing facts", async () => {
    const home = await mkdtemp(
      join(tmpdir(), "sciretriever-web-default-shared-"),
    );
    let web: Awaited<ReturnType<typeof open>> | undefined;
    const mcp = createMcpServer({ home });
    const client = new Client({ name: "fixture", version: "1" });
    try {
      web = await open(home);
      await web.application.database.putLiterature(FIXTURE_LITERATURE);
      const configuration = join(home, ".sciretriever", "config.toml");
      const saved = await readFile(configuration);
      const catalog = join(home, ".sciretriever", "catalog.sqlite");
      expect(await inspectCatalogSchema(catalog)).toMatchObject({
        status: "ready",
        schema_version: 10,
      });
      expect((await stat(catalog)).mode & 0o777).toBe(0o600);
      expect((await stat(configuration)).mode & 0o777).toBe(0o600);
      const cli = await runCli(
        ["literature", "show", FIXTURE_LITERATURE.literature_id],
        { home },
      );
      expect(cli.code).toBe(0);
      expect(cli.value).toMatchObject({
        literature: { literature_id: FIXTURE_LITERATURE.literature_id },
      });
      const [serverTransport, clientTransport] =
        InMemoryTransport.createLinkedPair();
      await mcp.connect(serverTransport);
      await client.connect(clientTransport);
      const result = await client.callTool({
        name: "read_literature",
        arguments: { literature_id: FIXTURE_LITERATURE.literature_id },
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        result: {
          literature: { literature_id: FIXTURE_LITERATURE.literature_id },
        },
      });
      await web.close();
      web = await open(home);
      expect(
        (await web.application.library.detail(FIXTURE_LITERATURE.literature_id))
          .literature.literature_id,
      ).toBe(FIXTURE_LITERATURE.literature_id);
      expect(await readFile(configuration)).toEqual(saved);
    } finally {
      await client.close();
      await mcp.close();
      await web?.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  it("honors custom locations and creates only a missing catalog without altering configuration", async () => {
    const home = await mkdtemp(join(tmpdir(), "sciretriever-web-custom-"));
    let web: Awaited<ReturnType<typeof open>> | undefined;
    try {
      const owner = new TypeScriptConfigurationOwner(home);
      const paths = {
        catalog_path: join(home, "chosen.sqlite"),
        artifact_root: join(home, "chosen-assets"),
      };
      await owner.publish(
        `[paths]\ncatalog_path=${JSON.stringify(paths.catalog_path)}\nartifact_root=${JSON.stringify(paths.artifact_root)}\n`,
        "missing",
        ["paths"],
      );
      const before = await readFile(join(home, ".sciretriever", "config.toml"));
      web = await open(home);
      expect(web.application.configuration.paths).toEqual(paths);
      expect(await inspectCatalogSchema(paths.catalog_path)).toMatchObject({
        schema_version: 10,
      });
      expect(
        await readFile(join(home, ".sciretriever", "config.toml")),
      ).toEqual(before);
      await expect(
        stat(join(home, ".sciretriever", "catalog.sqlite")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await web?.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  it.each(["corrupt", "v1", "symlink"] as const)(
    "refuses an existing %s catalog without overwriting or upgrading it",
    async (kind) => {
      const home = await mkdtemp(join(tmpdir(), "sciretriever-web-refused-"));
      try {
        const directory = join(home, ".sciretriever");
        await mkdir(directory, { mode: 0o700 });
        const catalog = join(directory, "catalog.sqlite");
        let original = catalog;
        if (kind === "v1") {
          const worker = new SqliteWorker(catalog);
          try {
            await worker.putLiterature(FIXTURE_LITERATURE);
          } finally {
            await worker.close();
          }
        } else if (kind === "symlink") {
          original = join(home, "untouched.sqlite");
          await writeFile(original, "unrelated bytes");
          await symlink(original, catalog);
        } else await writeFile(catalog, "not a database");
        const before = await readFile(original);
        await expect(open(home)).rejects.toMatchObject({
          code:
            kind === "v1" ? "migration-target-v1" : "migration-target-unknown",
        });
        expect(await readFile(original)).toEqual(before);
        await expect(stat(join(directory, "artifacts"))).rejects.toMatchObject({
          code: "ENOENT",
        });
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    },
  );

  it("rejects malformed settings without replacing them or creating a catalog", async () => {
    const home = await mkdtemp(join(tmpdir(), "sciretriever-web-malformed-"));
    try {
      const directory = join(home, ".sciretriever");
      await mkdir(directory, { mode: 0o700 });
      const configuration = join(directory, "config.toml");
      await writeFile(configuration, "invalid = [", { mode: 0o600 });
      await expect(open(home)).rejects.toThrow();
      expect(await readFile(configuration, "utf8")).toBe("invalid = [");
      await expect(
        stat(join(directory, "catalog.sqlite")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
