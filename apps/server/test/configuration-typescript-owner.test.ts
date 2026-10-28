import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadCredentialBundle } from "../src/configuration/credentials.js";
import { configurationPath } from "../src/configuration/index.js";
import {
  ConfigurationOwnerError,
  ConfigurationProbeSession,
  TypeScriptConfigurationOwner,
  fixedConfigurationHome,
} from "../src/configuration/owner.js";
import { assembleMetadataRegistry } from "../src/metadata/assembly.js";
import { NetworkBudgetCoordinator } from "../src/network/budget.js";
import type { MetadataTransport } from "../src/providers/shared/metadata-transport.js";

describe("TypeScript configuration owner", () => {
  it("persists default storage paths without creating a database and leaves them stable", async () => {
    const home = await mkdtemp(join(tmpdir(), "sciretriever-default-paths-"));
    try {
      const owner = new TypeScriptConfigurationOwner(home);
      const saved = await owner.ensureStoragePaths();
      expect(saved.configuration.paths).toEqual({
        catalog_path: join(home, ".sciretriever", "catalog.sqlite"),
        artifact_root: join(home, ".sciretriever", "artifacts"),
      });
      expect(saved.revision).not.toBe("missing");
      expect((await owner.ensureStoragePaths()).revision).toBe(saved.revision);
      expect(existsSync(saved.configuration.paths.catalog_path!)).toBe(false);
      expect(existsSync(saved.configuration.paths.artifact_root!)).toBe(false);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it.each(["catalog_path", "artifact_root"] as const)(
    "fills only the missing path while preserving custom %s and other settings",
    async (field) => {
      const home = await mkdtemp(join(tmpdir(), "sciretriever-partial-paths-"));
      try {
        const owner = new TypeScriptConfigurationOwner(home);
        await owner.read();
        const custom = join(home, "custom-location");
        const settings =
          '# Keep the source policy.\n[sources.metadata]\nmode="custom"\nproviders=[]\n';
        await writeFile(
          configurationPath(home),
          `[paths]\n${field}=${JSON.stringify(custom)}\n${settings}`,
          { mode: 0o600 },
        );
        const saved = await owner.ensureStoragePaths();
        expect(saved.configuration.paths[field]).toBe(custom);
        expect(Object.values(saved.configuration.paths).every(Boolean)).toBe(
          true,
        );
        expect(saved.configuration.sources.metadata).toMatchObject({
          mode: "custom",
          providers: [],
        });
        expect(await readFile(configurationPath(home), "utf8")).toContain(
          settings,
        );
        const bytes = await readFile(configurationPath(home));
        await owner.ensureStoragePaths();
        expect(await readFile(configurationPath(home))).toEqual(bytes);
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    },
  );

  it("reads, validates, diffs and publishes without a Python process", async () => {
    const home = await mkdtemp(join(tmpdir(), "sciretriever-ts-owner-"));
    try {
      const owner = new TypeScriptConfigurationOwner(home);
      const initial = await owner.read();
      expect(initial.revision).toBe("missing");
      const payload = '[browser]\nprofile = "synthetic"\n';
      expect(owner.validate(payload).browser.profile).toBe("synthetic");
      await expect(
        owner.diff(payload, initial.revision),
      ).resolves.toMatchObject({
        revision: "missing",
        changed_fields: ["browser.profile"],
      });
      const published = await owner.publish(payload, initial.revision, [
        "browser",
      ]);
      expect(published.revision).toMatch(/^[0-9a-f]{64}$/u);
      expect(published.configuration.browser.profile).toBe("synthetic");
      expect(published.configuration.library.max_input_bytes).toBe(67_108_864);
      await expect(owner.diff(payload, initial.revision)).rejects.toMatchObject(
        {
          code: "configuration-conflict",
        },
      );
      await expect(
        readFile(join(home, ".sciretriever/config.toml"), "utf8"),
      ).resolves.toContain('"profile" = "synthetic"');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("exposes local readiness and rejects cancelled or invalid operations", async () => {
    const home = await mkdtemp(join(tmpdir(), "sciretriever-ts-owner-"));
    try {
      const owner = new TypeScriptConfigurationOwner(home);
      const readiness = await owner.status();
      expect(readiness.network_performed).toBe(false);
      expect(readiness.browser_launched).toBe(false);
      expect(readiness.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            owner: "storage",
            target: "catalog",
            state: "ready",
          }),
        ]),
      );
      const controller = new AbortController();
      controller.abort();
      expect(() => owner.validate("", controller.signal)).toThrow(
        ConfigurationOwnerError,
      );
      expect(() => owner.validate("[browser]\nunknown = true\n")).toThrow(
        ConfigurationOwnerError,
      );
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("preserves comments and unselected sections during a section publish", async () => {
    const home = await mkdtemp(join(tmpdir(), "sciretriever-ts-owner-merge-"));
    try {
      const owner = new TypeScriptConfigurationOwner(home);
      await owner.publish(
        '[browser]\nprofile = "before"\n[parsing]\nbase_url = "http://localhost:8000"\nconnection_mode = "loopback"\nmodel_identity = "fixture"\n',
        "missing",
        ["browser", "parsing"],
      );
      const configPath = join(home, ".sciretriever/config.toml");
      const current = await readFile(configPath, "utf8");
      await writeFile(
        configPath,
        current.replace('["parsing"]', '# preserved comment\n["parsing"]'),
        "utf8",
      );
      await chmod(configPath, 0o600);
      const baseline = (await owner.read()).revision;
      await owner.publish('[browser]\nprofile = "after"\n', baseline, [
        "browser",
      ]);
      const merged = await readFile(configPath, "utf8");
      expect(merged).toContain("# preserved comment");
      expect(merged).toContain('["parsing"]');
      expect(merged).toContain('"model_identity" = "fixture"');
      expect(merged).toContain('"profile" = "after"');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("removes obsolete proofreading budgets during explicit publication and preserves unrelated settings", async () => {
    const home = await mkdtemp(
      join(tmpdir(), "sciretriever-ts-owner-proofread-"),
    );
    try {
      const owner = new TypeScriptConfigurationOwner(home);
      const initial = await owner.read();
      const proofread = {
        ...initial.configuration.proofread,
        max_calls_per_document: 23,
      };
      const published = await owner.publishConfiguration(
        { ...initial.configuration, proofread },
        initial.revision,
        ["proofread"],
      );
      expect(published.configuration.proofread).toEqual({
        model: proofread.model,
        max_concurrent_pages: proofread.max_concurrent_pages,
      });
      await expect(
        owner.publishConfiguration(
          {
            ...published.configuration,
            proofread: { ...proofread, max_value_check_calls: 9 },
          },
          published.revision,
          ["proofread"],
        ),
      ).rejects.toThrow();
      await owner.publishConfiguration(
        published.configuration,
        published.revision,
        ["tags"],
      );
      expect(
        (await new TypeScriptConfigurationOwner(home).read()).configuration
          .proofread,
      ).toEqual({
        model: proofread.model,
        max_concurrent_pages: proofread.max_concurrent_pages,
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("roundtrips hyphenated Web of Science and Sci-Hub source tables atomically", async () => {
    const home = await mkdtemp(
      join(tmpdir(), "sciretriever-ts-owner-sources-"),
    );
    try {
      const owner = new TypeScriptConfigurationOwner(home);
      const initial = await owner.read();
      const candidate = {
        ...initial.configuration,
        sources: {
          ...initial.configuration.sources,
          metadata: {
            ...initial.configuration.sources.metadata,
            mode: "custom" as const,
            providers: ["web-of-science"],
            web_of_science: {
              product: "expanded",
              database: "WOS-Synthetic",
              edition: "2026",
            },
          },
          acquisition: {
            ...initial.configuration.sources.acquisition,
            mode: "custom" as const,
            providers: ["sci-hub"],
            sci_hub: { urls: ["https://sci-hub.example"] },
          },
        },
      };
      const published = await owner.publishConfiguration(
        candidate,
        initial.revision,
        ["sources"],
      );
      expect(published.configuration.sources).toMatchObject({
        metadata: {
          web_of_science: {
            product: "expanded",
            database: "WOS-Synthetic",
            edition: "2026",
          },
        },
        acquisition: {
          sci_hub: { urls: ["https://sci-hub.example"] },
        },
      });
      const path = join(home, ".sciretriever/config.toml");
      const bytes = await readFile(path, "utf8");
      expect(bytes).toContain('["sources"."metadata"."web-of-science"]');
      expect(bytes).toContain('["sources"."acquisition"."sci-hub"]');
      expect(bytes).not.toContain('["sources"."metadata"."web_of_science"]');
      expect(bytes).not.toContain('["sources"."acquisition"."sci_hub"]');

      const roundtrip = await owner.publishConfiguration(
        published.configuration,
        published.revision,
        ["sources"],
      );
      expect(roundtrip.configuration.sources).toEqual(
        published.configuration.sources,
      );
      const invalid = {
        ...roundtrip.configuration,
        sources: {
          ...roundtrip.configuration.sources,
          metadata: {
            ...roundtrip.configuration.sources.metadata,
            providers: ["not-a-supported-source"],
          },
        },
      };
      await expect(
        owner.publishConfiguration(invalid, roundtrip.revision, ["sources"]),
      ).rejects.toMatchObject({ code: "configuration-invalid" });
      expect((await owner.read()).configuration.sources).toEqual(
        roundtrip.configuration.sources,
      );
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("owns origin-bound model, source, and MinerU credential edits atomically", async () => {
    const home = await mkdtemp(
      join(tmpdir(), "sciretriever-ts-owner-credentials-"),
    );
    try {
      const owner = new TypeScriptConfigurationOwner(home);
      const payload =
        '[providers.fixture]\napi = "openai-responses"\nbase_url = "https://model.example.test/v1"\n[parsing]\nbase_url = "https://parser.example.test/v1"\nconnection_mode = "remote"\nmodel_identity = "fixture"\nremote_upload_authorized = true\n';
      const published = await owner.publish(payload, "missing", [
        "providers",
        "parsing",
      ]);
      const secret = "synthetic-secret-never-returned";
      const configured = await owner.credential(
        { namespace: "model", target: "fixture", kind: "set", value: secret },
        published.revision,
      );
      expect(configured.credentials.models).toEqual([
        { target: "fixture", present: true },
      ]);
      expect(JSON.stringify(configured)).not.toContain(secret);
      const path = join(home, ".sciretriever/credentials.toml");
      const original = await readFile(path, "utf8");
      await owner.credential(
        { namespace: "model", target: "fixture", kind: "set", value: " " },
        published.revision,
      );
      expect(await readFile(path, "utf8")).toBe(original);
      const parserReady = await owner.credential(
        {
          namespace: "mineru",
          target: "mineru",
          kind: "set",
          value: "synthetic-parser-secret",
        },
        published.revision,
      );
      expect(parserReady.credentials.mineru).toBe(true);
      const sourceReady = await owner.credential(
        {
          namespace: "source",
          target: "elsevier",
          kind: "set",
          fields: { api_key: "source-key", institution_token: "institution" },
        },
        published.revision,
      );
      expect(
        sourceReady.credentials.sources.find(
          (item) => item.target === "elsevier",
        ),
      ).toEqual({ target: "elsevier", present: true });
      const changed = await owner.publish(
        payload.replace("model.example.test", "other.example.test"),
        published.revision,
        ["providers"],
      );
      await expect(
        owner.credential(
          { namespace: "model", target: "fixture", kind: "remove" },
          published.revision,
        ),
      ).rejects.toMatchObject({ code: "configuration-conflict" });
      const removed = await owner.credential(
        { namespace: "model", target: "fixture", kind: "remove" },
        changed.revision,
      );
      expect(removed.credentials.models).toEqual([
        { target: "fixture", present: false },
      ]);
      expect((await readFile(path, "utf8")).includes(secret)).toBe(false);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("keeps the production configuration identity fixed to the user home", async () => {
    const home = await mkdtemp(join(tmpdir(), "sciretriever-ts-owner-home-"));
    const previous = process.env.SCIRETRIEVER_HOME;
    process.env.SCIRETRIEVER_HOME = home;
    try {
      const { configurationHome } = await import("../src/cli/main.js");
      // Neither the environment variable nor the working directory selects the
      // production configuration; only an explicit owner seam does.
      expect(fixedConfigurationHome()).toBe(homedir());
      expect(configurationHome()).toBe(homedir());
      expect(configurationHome({ home })).toBe(home);
      expect(new TypeScriptConfigurationOwner().home).toBe(homedir());
      expect(configurationPath()).toBe(
        join(homedir(), ".sciretriever", "config.toml"),
      );
      expect(configurationPath()).not.toContain(home);
      const owner = new TypeScriptConfigurationOwner(home);
      await owner.publish('[browser]\nprofile = "synthetic"\n', "missing", [
        "browser",
      ]);
      expect((await owner.read()).configuration.browser.profile).toBe(
        "synthetic",
      );
    } finally {
      if (previous === undefined) delete process.env.SCIRETRIEVER_HOME;
      else process.env.SCIRETRIEVER_HOME = previous;
      await rm(home, { recursive: true, force: true });
    }
  });

  it("uses credentials inside the probe without returning them and without Storage effects", async () => {
    const home = await mkdtemp(join(tmpdir(), "sciretriever-ts-owner-probe-"));
    const secret = "synthetic-probe-owner-secret";
    try {
      const owner = new TypeScriptConfigurationOwner(home);
      const published = await owner.publish(
        '[sources.metadata]\nmode = "custom"\nproviders = ["core"]\n[browser]\nenabled = false\n',
        "missing",
        ["sources", "browser"],
      );
      await owner.credential(
        {
          namespace: "source",
          target: "core",
          kind: "set",
          fields: { api_key: secret },
        },
        published.revision,
      );
      const credentials = await loadCredentialBundle(home);
      const seen: string[] = [];
      const transport: MetadataTransport = {
        request: async (_url, options) => {
          seen.push(JSON.stringify(options?.headers ?? {}));
          return { totalHits: 0, offset: 0, limit: 100, results: [] };
        },
      };
      const metadata = assembleMetadataRegistry(
        (await owner.read()).configuration,
        credentials,
        new NetworkBudgetCoordinator(),
        { transportFactory: () => transport },
      );
      const session = await ConfigurationProbeSession.create(owner, {
        metadata,
        now: () => 1_000,
      });
      try {
        const result = await session.run(
          { owner: "search", target: "core", image: false },
          { authorized: true },
        );
        expect(result).toMatchObject({
          outcome: "passed",
          network_performed: true,
          method: "GET",
          endpoint: "https://api.core.ac.uk",
          article_entitlement: "not-proven",
          persisted: false,
          execution: { elapsed_ms: 0, may_consume_quota: true },
        });
        // The credential reaches the provider request but never the result.
        expect(seen.join("")).toContain(secret);
        expect(JSON.stringify(result)).not.toContain(secret);
        const repeated = await session.run(
          { owner: "search", target: "core", image: false },
          { authorized: true },
        );
        expect(repeated).toEqual(result);
        expect(existsSync(join(home, "catalog.sqlite"))).toBe(false);
        expect(existsSync(join(home, "artifacts"))).toBe(false);
      } finally {
        session.close();
      }
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("rejects an unknown probe owner instead of widening it to the aggregate probe", async () => {
    const home = await mkdtemp(
      join(tmpdir(), "sciretriever-ts-owner-probe-input-"),
    );
    const owner = new TypeScriptConfigurationOwner(home);
    const session = await ConfigurationProbeSession.create(owner);
    try {
      await expect(
        session.run(
          { owner: "unknown-owner", target: null, image: false } as never,
          { authorized: true },
        ),
      ).rejects.toMatchObject({ code: "configuration-probe-invalid" });
      expect(existsSync(join(home, "catalog.sqlite"))).toBe(false);
    } finally {
      session.close();
      await rm(home, { recursive: true, force: true });
    }
  });
});
