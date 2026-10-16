import {
  mkdir,
  mkdtemp,
  rename,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  ConfigurationBoundaryError,
  configurationPath,
  loadConfiguration,
  parseToml,
  parseConfiguration,
  effectiveBrowserConcurrency,
} from "../src/configuration/index.js";
import { NetworkBudgetCoordinator } from "../src/network/budget.js";
import {
  ProbeRequestError,
  readOnlyProbeRequest,
} from "../src/network/probe.js";

function rejects(value: string | Uint8Array): void {
  expect(() => parseConfiguration(value)).toThrow(ConfigurationBoundaryError);
}

const modelConfiguration = `
[providers.openai]
api = "openai-responses"
base_url = "https://api.openai.com/v1"

[models."openai/vision-model"]
image = true
stream = false

[analyze]
model = "openai/vision-model"
`;

describe("ordinary configuration boundary", () => {
  it("supports TOML dotted keys and rejects trailing commas in inline tables", () => {
    expect(parseToml('paths.catalog_path = "catalog.db"\n')).toEqual({
      paths: { catalog_path: "catalog.db" },
    });
    expect(() => parseToml('paths = { catalog_path = "catalog.db", }')).toThrow(
      ConfigurationBoundaryError,
    );
    expect(() => parseToml('paths..catalog_path = "catalog.db"')).toThrow(
      ConfigurationBoundaryError,
    );
  });
  it("loads an empty document with the product defaults", () => {
    const configuration = parseConfiguration("");
    expect(configuration.paths).toEqual({
      catalog_path: null,
      artifact_root: null,
    });
    expect(configuration.sources.metadata).toMatchObject({
      mode: "auto",
      providers: [],
      limit: 500,
    });
    expect(configuration.sources.acquisition).toMatchObject({
      mode: "auto",
      providers: [],
    });
    expect(configuration.execution.max_concurrency).toBe(4);
    expect(configuration.library.max_input_bytes).toBe(67_108_864);
    expect(configuration.browser).toMatchObject({
      enabled: false,
      max_concurrency: 5,
      policy_overrides: [],
    });
  });

  it("allows partial sections and applies defaults to omitted fields", () => {
    const configuration = parseConfiguration(
      `[sources.metadata]\nlimit = 12\n`,
    );
    expect(configuration.sources.metadata).toMatchObject({
      mode: "auto",
      providers: [],
      limit: 12,
    });
    expect(configuration.parsing).toEqual({
      base_url: null,
      connection_mode: null,
      model_identity: null,
      remote_upload_authorized: false,
    });
  });

  it("parses provider, model, source, parser and Browser selections", () => {
    const configuration = parseConfiguration(`${modelConfiguration}
[sources.metadata]
mode = "custom"
providers = ["crossref", "arxiv"]

[parsing]
base_url = "http://127.0.0.1:8000"
connection_mode = "loopback"
model_identity = "mineru-3.4.4-vlm"

[browser]
model = "openai/vision-model"
enabled = true
profile = "institutional-access"
policy_overrides = [{ rate_limit_group = "browser-generic", minimum_start_interval = 2.5 }]
`);
    expect(configuration.models["openai/vision-model"]).toEqual({
      reasoning: "default",
      image: true,
      stream: false,
    });
    expect(configuration.sources.metadata.providers).toEqual([
      "crossref",
      "arxiv",
    ]);
    expect(configuration.parsing.connection_mode).toBe("loopback");
    expect(
      configuration.browser.policy_overrides[0]?.minimum_start_interval,
    ).toBe(2.5);
  });

  it("handles comments, quoted brackets, and multiline arrays without changing values", () => {
    const configuration = parseConfiguration(`
[sources.metadata]
mode = "custom"
providers = [
  "crossref", # first
  "arxiv",
]
[providers.test]
api = "openai-chat-completions"
base_url = "https://example.invalid/v1"
[models."test/name[with]brackets"]
`);
    expect(configuration.sources.metadata.providers).toEqual([
      "crossref",
      "arxiv",
    ]);
    expect(configuration.models["test/name[with]brackets"]).toEqual({
      reasoning: "default",
      image: false,
      stream: true,
    });
  });

  it("rejects unknown sections, nested keys, duplicate keys, malformed values and bad references", () => {
    rejects(`[unknown]\nvalue = true`);
    rejects(`[sources.metadata]\nunknown = true`);
    rejects(`[sources.metadata]\nlimit = 1\nlimit = 2`);
    rejects(`[sources.metadata]\nproviders = ["crossref"`);
    rejects(`[browser]\nenabled = "true"`);
    rejects(`[models."missing/name"]\nimage = true`);
    rejects(
      `[providers.openai]\napi = "unsupported"\nbase_url = "https://example.invalid"`,
    );
    rejects(`[analyze]\nmodel = "missing/name"`);
    rejects(`
[providers.openai]
api = "openai-responses"
base_url = "https://api.openai.com/v1"
[models."openai/text-model"]
image = false
[browser]
model = "openai/text-model"
`);
  });

  it("rejects unsafe URLs, parser mode mismatches, invalid policy shape and budget violations", () => {
    rejects(
      `[providers.openai]\napi = "openai-responses"\nbase_url = "http://10.0.0.1"`,
    );
    rejects(
      `[parsing]\nconnection_mode = "remote"\nbase_url = "http://127.0.0.1:8000"`,
    );
    rejects(`[parsing]\nbase_url = "http://127.0.0.1:8000"`);
    rejects(`[parsing]\nbase_url = "https://127.0.0.1:8443"`);
    rejects(`[parsing]\nremote_upload_authorized = true`);
    rejects(
      `[providers.openai]\napi = "openai-responses"\nbase_url = "https://api.openai.com/a/../v1"`,
    );
    rejects(
      `[providers.openai]\napi = "openai-responses"\nbase_url = "https://api.openai.com/a/%2e%2e/v1"`,
    );
    rejects(`[browser]\nenabled = true`);
    rejects(
      `[browser]\npolicy_overrides = [{ rate_limit_group = "other", minimum_start_interval = 2 }]`,
    );
    rejects(
      `[browser]\npolicy_overrides = [{ rate_limit_group = "browser-generic" }]`,
    );

    rejects(`[browser]\nmax_concurrency = 0`);
    expect(() =>
      parseConfiguration(
        `[analyze]\nmax_input_bytes = 10\nmax_chunk_bytes = 11\nmax_total_llm_requests = 1`,
      ),
    ).not.toThrow();
  });

  it("preserves configured Browser capacity while exposing its effective session and worker bounds", () => {
    for (const [configured, effective] of [
      [1, 1],
      [5, 5],
      [8, 8],
      [100, 8],
    ] as const) {
      const browser = parseConfiguration(
        `[browser]\nmax_concurrency = ${configured}`,
      ).browser;
      expect(browser.max_concurrency).toBe(configured);
      expect(effectiveBrowserConcurrency(browser)).toEqual({
        configured_sessions: configured,
        effective_sessions: effective,
        decision_workers: Math.min(2, effective),
        limiting_reason: configured > 8 ? "runtime-session-cap" : null,
      });
    }
    const serial = parseConfiguration(
      '[browser]\npolicy_overrides = [{ rate_limit_group = "browser-generic", max_concurrency = 1 }]',
    ).browser;
    expect(effectiveBrowserConcurrency(serial)).toMatchObject({
      configured_sessions: 5,
      effective_sessions: 1,
      decision_workers: 1,
      limiting_reason: "explicit-serial-policy",
    });
  });

  it("uses only the injected fixed home and treats a missing file as empty configuration", async () => {
    const home = await mkdtemp(join(tmpdir(), "sciretriever-configuration-"));
    const directory = join(home, ".sciretriever");
    await mkdir(directory, { mode: 0o700 });
    expect(configurationPath(home)).toBe(join(directory, "config.toml"));
    expect((await loadConfiguration(home)).execution.max_concurrency).toBe(4);
    await writeFile(
      join(directory, "config.toml"),
      "[execution]\nmax_concurrency = 7\n",
      { mode: 0o600 },
    );
    expect((await loadConfiguration(home)).execution.max_concurrency).toBe(7);
  });

  it("fails closed for a configuration symlink and a file replaced during descriptor read", async () => {
    const home = await mkdtemp(join(tmpdir(), "sciretriever-configuration-"));
    const directory = join(home, ".sciretriever");
    await mkdir(directory, { mode: 0o700 });
    const path = join(directory, "config.toml");
    const target = join(home, "outside.toml");
    await writeFile(target, "[execution]\nmax_concurrency = 9\n");
    await symlink(target, path);
    await expect(loadConfiguration(home)).rejects.toBeInstanceOf(
      ConfigurationBoundaryError,
    );
    await rename(target, join(home, "outside-old.toml"));
    await unlink(path);
    await writeFile(path, "[execution]\nmax_concurrency = 4\n", {
      mode: 0o600,
    });
    const replacement = join(directory, "replacement.toml");
    await writeFile(replacement, "[execution]\nmax_concurrency = 9\n", {
      mode: 0o600,
    });
    await expect(
      loadConfiguration(home, { beforeRead: () => rename(path, replacement) }),
    ).rejects.toBeInstanceOf(ConfigurationBoundaryError);
  });
  it("rejects a file larger than the bounded input", async () => {
    const home = await mkdtemp(join(tmpdir(), "sciretriever-configuration-"));
    const directory = join(home, ".sciretriever");
    await mkdir(directory, { mode: 0o700 });
    await writeFile(join(directory, "config.toml"), "x".repeat(1_048_577), {
      mode: 0o600,
    });
    await expect(loadConfiguration(home)).rejects.toBeInstanceOf(
      ConfigurationBoundaryError,
    );
  });
});

describe("read-only probe request boundary", () => {
  const coordinator = new NetworkBudgetCoordinator();
  it("admits one https endpoint and refuses unsigned or credential-bearing shapes", async () => {
    await expect(
      readOnlyProbeRequest({
        url: "http://example.test/models",
        coordinator,
      }),
    ).rejects.toBeInstanceOf(ProbeRequestError);
    await expect(
      readOnlyProbeRequest({
        url: "https://user:secret@example.test/models",
        coordinator,
      }),
    ).rejects.toBeInstanceOf(ProbeRequestError);
    await expect(
      readOnlyProbeRequest({
        url: "https://example.test/models?signature=abc",
        coordinator,
      }),
    ).rejects.toBeInstanceOf(ProbeRequestError);
    await expect(
      readOnlyProbeRequest({
        url: "https://example.test/models",
        headers: [["authorization", "Bearer synthetic"]],
        coordinator,
      }),
    ).rejects.toBeInstanceOf(ProbeRequestError);
    await expect(
      readOnlyProbeRequest({
        url: "https://example.test/models",
        credential_headers: [["x-custom-token", "synthetic"]],
        coordinator,
      }),
    ).rejects.toBeInstanceOf(ProbeRequestError);
    await expect(
      readOnlyProbeRequest({
        url: "https://example.test/models",
        credential_headers: [["authorization", "line\nbreak"]],
        coordinator,
      }),
    ).rejects.toBeInstanceOf(ProbeRequestError);
    await expect(
      readOnlyProbeRequest({
        url: "https://example.test/models",
        coordinator,
        maxResponseBytes: 2_000_000,
      }),
    ).rejects.toBeInstanceOf(ProbeRequestError);
  });
});
