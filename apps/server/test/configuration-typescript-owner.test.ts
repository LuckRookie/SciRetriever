import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ConfigurationOwnerError,
  TypeScriptConfigurationOwner,
} from "../src/configuration/owner.js";

describe("TypeScript configuration owner", () => {
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
});
