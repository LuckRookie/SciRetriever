import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseConfigurationReadiness } from "@sciretriever/contracts";
import { createApplication } from "../src/bootstrap/application.js";
import { parseConfiguration } from "../src/configuration/index.js";
import {
  ConfigurationOwnerError,
  TypeScriptConfigurationOwner,
} from "../src/configuration/owner.js";

it("assembles adapters from the TS owner's saved snapshot and reloads on restart", async () => {
  const home = await mkdtemp(join(tmpdir(), "sciretriever-owner-assembly-"));
  const owner = new TypeScriptConfigurationOwner(home);
  let application: Awaited<ReturnType<typeof createApplication>> | undefined;
  try {
    const payload =
      '[providers.fixture]\napi = "openai-responses"\nbase_url = "https://fixture.example.test/v1"\n[models."fixture/first"]\nimage = false\n[models."fixture/second"]\nimage = false\n[analyze]\nmodel = "fixture/first"\n';
    const baseline = await owner.publish(payload, "missing", [
      "providers",
      "models",
      "analyze",
    ]);
    await owner.credential(
      {
        namespace: "model",
        target: "fixture",
        kind: "set",
        value: "synthetic-assembly-key",
      },
      baseline.revision,
    );
    application = await createApplication(home, { configurationOwner: owner });
    expect(application.agents.identity("analysis").model).toBe("first");
    await owner.publish(
      payload.replace('model = "fixture/first"', 'model = "fixture/second"'),
      baseline.revision,
      ["analyze"],
    );
    expect(application.agents.identity("analysis").model).toBe("first");
    await application.close();
    application = await createApplication(home, { configurationOwner: owner });
    expect(application.agents.identity("analysis").model).toBe("second");
    await application.close();
    application = undefined;
    await writeFile(
      join(home, ".sciretriever/config.toml"),
      "[browser]\nunknown = true\n",
      { mode: 0o600 },
    );
    const stages: string[] = [];
    await expect(
      createApplication(home, {
        configurationOwner: owner,
        afterStage: (stage) => {
          stages.push(stage);
        },
      }),
    ).rejects.toMatchObject({ code: "configuration-boundary" });
    expect(stages).toEqual(["home"]);
  } finally {
    await application?.close();
    await rm(home, { recursive: true, force: true });
  }
});

it("rejects unknown readiness fields, invalid states, duplicate rows and secret metadata", () => {
  const row = {
    owner: "browser",
    target: "model",
    state: "blocked",
    code: "browser-model-unavailable",
    next_action: "select-model",
  };
  const safe = {
    version: 1,
    network_performed: false,
    browser_launched: false,
    items: [row],
    credentials: { models: [], sources: [], mineru: false },
  };
  expect(parseConfigurationReadiness(safe)).toEqual(safe);
  for (const input of [
    { ...safe, path: "/private/home" },
    { ...safe, network_performed: true },
    { ...safe, items: [{ ...row, state: "success" }] },
    { ...safe, items: [row, row] },
    {
      ...safe,
      credentials: {
        ...safe.credentials,
        models: [{ target: "fixture", present: true, key_hash: "private" }],
      },
    },
  ])
    expect(() => parseConfigurationReadiness(input)).toThrow();
});

describe("TypeScript configuration owner", () => {
  it("reads defaults and validates/diffs a synthetic draft without publishing it", async () => {
    const home = await mkdtemp(join(tmpdir(), "sciretriever-config-owner-"));
    const owner = new TypeScriptConfigurationOwner(home);
    try {
      const initial = await owner.read();
      expect(initial).toEqual({
        revision: "missing",
        configuration: parseConfiguration(""),
      });
      const payload = '[browser]\nenabled = true\nprofile = "synthetic"\n';
      expect(owner.validate(payload)).toEqual(parseConfiguration(payload));
      expect(
        (await owner.diff(payload, initial.revision)).changed_fields,
      ).toEqual(["browser.enabled", "browser.profile"]);
      expect((await owner.read()).revision).toBe("missing");
      await mkdir(join(home, ".sciretriever"), {
        recursive: true,
        mode: 0o700,
      });
      const path = join(home, ".sciretriever/config.toml");
      await writeFile(
        path,
        "# private-comment-marker\n[browser]\nenabled = false\n",
        { mode: 0o600 },
      );
      const existing = await owner.read();
      expect(existing.revision).toMatch(/^[0-9a-f]{64}$/u);
      expect(JSON.stringify(existing)).not.toContain("private-comment-marker");
      await expect(owner.diff(payload, initial.revision)).rejects.toMatchObject(
        {
          code: "configuration-conflict",
        },
      );
      expect(
        (await owner.diff(payload, existing.revision)).changed_fields,
      ).toEqual(["browser.enabled", "browser.profile"]);
      expect(await readFile(path, "utf8")).toContain("enabled = false");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("rejects invalid, oversized and cancelled operations without reflecting input", async () => {
    const home = await mkdtemp(join(tmpdir(), "sciretriever-config-owner-"));
    const owner = new TypeScriptConfigurationOwner(home);
    try {
      for (const payload of [
        '[browser]\nunknown = "synthetic-private-marker"',
        '[analyze]\nmodel = "missing/model"',
        '[providers.foo]\napi_key = "synthetic-private-marker"',
        "x".repeat(1_048_577),
      ])
        expect(() => owner.validate(payload)).toThrow(ConfigurationOwnerError);
      expect((await owner.read()).revision).toBe("missing");
      const abort = new AbortController();
      abort.abort();
      await expect(owner.read(abort.signal)).rejects.toMatchObject({
        code: "configuration-cancelled",
        message: "configuration owner operation failed",
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

it("retains unrelated text and admits only one TS writer per baseline", async () => {
  const home = await mkdtemp(
    join(tmpdir(), "sciretriever-config-owner-write-"),
  );
  const firstOwner = new TypeScriptConfigurationOwner(home);
  const secondOwner = new TypeScriptConfigurationOwner(home);
  try {
    await firstOwner.publish('[browser]\nprofile = "first"\n', "missing", [
      "browser",
    ]);
    const file = join(home, ".sciretriever/config.toml");
    const currentText = await readFile(file, "utf8");
    await writeFile(
      file,
      currentText.replace(
        '["library"]',
        '# retained synthetic comment\n["library"]',
      ),
      { mode: 0o600 },
    );
    await chmod(file, 0o600);
    const baseline = await firstOwner.read();
    const attempts = await Promise.allSettled([
      firstOwner.publish('[browser]\nprofile = "one"\n', baseline.revision, [
        "browser",
      ]),
      secondOwner.publish('[browser]\nprofile = "two"\n', baseline.revision, [
        "browser",
      ]),
    ]);
    expect(attempts.filter((item) => item.status === "fulfilled")).toHaveLength(
      1,
    );
    expect(attempts.filter((item) => item.status === "rejected")).toHaveLength(
      1,
    );
    const final = await firstOwner.read();
    expect(["one", "two"]).toContain(final.configuration.browser.profile);
    expect(final.configuration.library.max_input_bytes).toBeGreaterThan(0);
    expect(await readFile(file, "utf8")).toContain(
      "retained synthetic comment",
    );
    await expect(
      firstOwner.publish('[browser]\nprofile = "late"\n', baseline.revision, [
        "browser",
      ]),
    ).rejects.toMatchObject({ code: "configuration-conflict" });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

it("returns offline presence-only readiness and manages origin-bound model credentials", async () => {
  const home = await mkdtemp(
    join(tmpdir(), "sciretriever-config-owner-credential-"),
  );
  const owner = new TypeScriptConfigurationOwner(home);
  try {
    const empty = await owner.status();
    expect(empty.network_performed).toBe(false);
    expect(empty.browser_launched).toBe(false);
    expect(
      empty.items
        .filter((item) => item.owner === "acquisition")
        .every((item) => item.state === "unavailable"),
    ).toBe(true);
    const payload =
      '[providers.fixture]\napi = "openai-responses"\nbase_url = "https://model.example.test/v1"\n';
    const initial = await owner.publish(payload, "missing", ["providers"]);
    const secret = "synthetic-owner-credential-do-not-emit";
    const configured = await owner.credential(
      { namespace: "model", target: "fixture", kind: "set", value: secret },
      initial.revision,
    );
    expect(configured.credentials.models).toEqual([
      { target: "fixture", present: true },
    ]);
    expect(JSON.stringify(configured)).not.toContain(secret);
    expect(JSON.stringify(configured)).not.toContain(home);
    const path = join(home, ".sciretriever/credentials.toml");
    const original = await readFile(path);
    await owner.credential(
      { namespace: "model", target: "fixture", kind: "set", value: "" },
      initial.revision,
    );
    expect(await readFile(path)).toEqual(original);
    const changed = await owner.publish(
      payload.replace("model.example.test", "other.example.test"),
      initial.revision,
      ["providers"],
    );
    expect(
      (await owner.status()).items.find(
        (item) => item.owner === "model-provider",
      )?.state,
    ).toBe("blocked");
    await expect(
      owner.credential(
        { namespace: "model", target: "fixture", kind: "remove" },
        initial.revision,
      ),
    ).rejects.toMatchObject({ code: "configuration-conflict" });
    const removed = await owner.credential(
      { namespace: "model", target: "fixture", kind: "remove" },
      changed.revision,
    );
    expect(removed.credentials.models[0]?.present).toBe(false);
    expect((await readFile(path, "utf8")).includes(secret)).toBe(false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

it("preserves source fields and binds MinerU credentials to the configured origin", async () => {
  const home = await mkdtemp(
    join(tmpdir(), "sciretriever-source-parser-credentials-"),
  );
  const owner = new TypeScriptConfigurationOwner(home);
  try {
    const source = { namespace: "source" as const, target: "elsevier" };
    const first = await owner.credential(
      {
        ...source,
        kind: "set",
        fields: {
          api_key: "synthetic-api-value",
          institution_token: "synthetic-institution-value",
        },
      },
      "missing",
    );
    expect(
      first.credentials.sources.find((item) => item.target === "elsevier")
        ?.present,
    ).toBe(true);
    const path = join(home, ".sciretriever/credentials.toml");
    const original = await readFile(path);
    await owner.credential(
      { ...source, kind: "set", fields: { api_key: " " } },
      "missing",
    );
    expect(await readFile(path)).toEqual(original);
    await owner.credential(
      { ...source, kind: "set", fields: { api_key: "synthetic-replacement" } },
      "missing",
    );
    const changed = await readFile(path, "utf8");
    expect(changed).toContain("synthetic-institution-value");
    expect(changed).not.toContain("synthetic-api-value");
    const removed = await owner.credential(
      { ...source, kind: "remove" },
      "missing",
    );
    expect(
      removed.credentials.sources.find((item) => item.target === "elsevier")
        ?.present,
    ).toBe(false);
    const parser =
      '[parsing]\nbase_url = "https://parser.example.test"\nconnection_mode = "remote"\nmodel_identity = "fixture"\nremote_upload_authorized = true\n';
    const configured = await owner.publish(parser, "missing", ["parsing"]);
    const secret = "synthetic-parser-token-do-not-emit";
    const ready = await owner.credential(
      { namespace: "mineru", target: "mineru", kind: "set", value: secret },
      configured.revision,
    );
    expect(ready.credentials.mineru).toBe(true);
    expect(JSON.stringify(ready)).not.toContain(secret);
    const replacement = await owner.publish(
      parser.replace("parser.example.test", "other.example.test"),
      configured.revision,
      ["parsing"],
    );
    expect(
      (await owner.status()).items.find((item) => item.owner === "parsing")
        ?.state,
    ).toBe("blocked");
    const empty = await owner.credential(
      { namespace: "mineru", target: "mineru", kind: "remove" },
      replacement.revision,
    );
    expect(empty.credentials.mineru).toBe(false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
