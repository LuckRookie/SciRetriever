import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli/main.js";
import { TypeScriptConfigurationOwner } from "../src/configuration/owner.js";

describe("TypeScript configuration probe boundary", () => {
  it("routes every explicit owner selector without implicit network or browser effects", async () => {
    const home = await mkdtemp(join(tmpdir(), "sciretriever-probe-journey-"));
    const owner = new TypeScriptConfigurationOwner(home);
    try {
      const payload =
        '[providers.fixture]\napi = "openai-responses"\nbase_url = "https://fixture.example.test/v1"\n[models."fixture/model"]\nimage = true\n[browser]\nenabled = true\nprofile = "synthetic"\nmodel = "fixture/model"\n';
      const snapshot = await owner.publish(payload, "missing", [
        "providers",
        "models",
        "browser",
      ]);
      await owner.credential(
        {
          namespace: "model",
          target: "fixture",
          kind: "set",
          value: "synthetic-probe-key",
        },
        snapshot.revision,
      );
      const commands = [
        ["config", "test", "provider", "--target", "fixture"],
        ["config", "test", "model", "--target", "fixture/model"],
        ["config", "test", "search", "--all"],
        ["config", "test", "download", "--all"],
        ["config", "test", "parse"],
        ["config", "test", "analyze"],
        ["config", "test", "browser", "model"],
        ["config", "test", "browser", "site", "--target", "fixture-site"],
        ["config", "test", "all"],
      ] as const;
      const reports = [];
      for (const command of commands) {
        const result = await runCli(command, { home });
        expect(result.code).toBe(0);
        expect(result.value).toMatchObject({
          network_performed: false,
          browser_launched: false,
        });
        reports.push(result.value);
      }
      expect(reports).toHaveLength(commands.length);
      expect(JSON.stringify(reports)).not.toContain("synthetic-probe-key");
      expect(JSON.stringify(reports)).not.toContain(home);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("rejects incomplete and unknown selectors before external effects", async () => {
    const home = await mkdtemp(join(tmpdir(), "sciretriever-probe-invalid-"));
    try {
      for (const command of [
        ["config", "test"],
        ["config", "test", "unknown"],
        ["config", "test", "provider"],
        ["config", "test", "browser", "site"],
      ])
        await expect(runCli(command, { home })).resolves.toMatchObject({
          code: 2,
        });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
