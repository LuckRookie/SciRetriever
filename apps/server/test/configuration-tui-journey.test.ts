import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runCli } from "../src/cli/main.js";
import {
  ConfigurationProbeError,
  ConfigurationProbeSession,
  TypeScriptConfigurationOwner,
  type ConfigurationProbeRequest,
  type ConfigurationProbeResult,
} from "../src/configuration/owner.js";
import { runRichConfigurationCenter } from "../src/cli/config-ui.js";

const promptState = vi.hoisted(() => ({
  selections: [] as string[],
  inputs: [] as string[],
  confirmations: [] as boolean[],
  checkboxChoices: [] as string[],
}));

vi.mock("@inquirer/prompts", () => ({
  select: vi.fn(async () => {
    const value = promptState.selections.shift();
    if (value === undefined) throw new Error("missing synthetic selection");
    return value;
  }),
  confirm: vi.fn(async () => promptState.confirmations.shift() ?? false),
  input: vi.fn(async () => promptState.inputs.shift() ?? ""),
  password: vi.fn(async () => ""),
  checkbox: vi.fn(
    async (options: { choices: readonly { value: string }[] }) => {
      promptState.checkboxChoices = options.choices.map((c) => c.value);
      return [];
    },
  ),
}));

async function* input(text: string): AsyncIterable<Uint8Array> {
  yield Buffer.from(text);
}

describe("TypeScript configuration center", () => {
  it("creates a fresh probe session after saving ordinary configuration", async () => {
    const home = await mkdtemp(
      join(tmpdir(), "sciretriever-tui-refresh-probe-"),
    );
    const owner = new TypeScriptConfigurationOwner(home);
    const output: string[] = [];
    const endpoint = "http://127.0.0.1:8000/health";
    const health = vi.fn(async () => ({
      status: "healthy" as const,
      version: "3.4.4" as const,
      protocol_version: 2 as const,
      profile: null,
    }));
    const probeFactory = vi.fn(() =>
      ConfigurationProbeSession.create(owner, {
        browser_site_factory: async () => null,
        parser_health: {
          endpoint,
          origin: "http://127.0.0.1:8000",
          health,
        },
      }),
    );
    try {
      promptState.selections = [
        "parse",
        "setup",
        "loopback",
        "parse",
        "test",
        "quit",
      ];
      promptState.inputs = ["http://127.0.0.1:8000", "synthetic-parser"];
      promptState.confirmations = [true];
      await expect(
        runRichConfigurationCenter({
          owner,
          probeFactory,
          theme: "mono",
          write: (text) => output.push(text),
        }),
      ).resolves.toBe(0);

      expect((await owner.read()).configuration.parsing).toMatchObject({
        base_url: "http://127.0.0.1:8000",
        connection_mode: "loopback",
        model_identity: "synthetic-parser",
      });
      expect(probeFactory).toHaveBeenCalledTimes(1);
      expect(health).toHaveBeenCalledTimes(1);
      expect(output.join("\n")).toContain("PASSED");
    } finally {
      promptState.selections = [];
      promptState.inputs = [];
      promptState.confirmations = [];
      await rm(home, { recursive: true, force: true });
    }
  });

  it("dispatches Rich TUI Parse and Browser probes without persisting their outcomes", async () => {
    const home = await mkdtemp(join(tmpdir(), "sciretriever-tui-probes-"));
    const owner = new TypeScriptConfigurationOwner(home);
    const output: string[] = [];
    const result = (
      request: ConfigurationProbeRequest,
      outcome: "passed" | "failed",
    ): ConfigurationProbeResult => ({
      owner: request.owner,
      target: request.target,
      outcome,
      method: "POST",
      endpoint: "http://127.0.0.1:1",
      provider: null,
      model: request.owner === "browser-model" ? "vision" : null,
      checks: ["synthetic-probe"],
      reason: outcome === "passed" ? "probe-passed" : "probe-failed",
      action: outcome === "passed" ? "none" : "retry-later",
      network_performed: true,
      browser_launched: false,
      authentication: "not-attempted",
      article_entitlement: "not-proven",
      persisted: false,
      limitations: [],
      results: [],
      execution: {
        owner: request.owner,
        target: request.target,
        code: outcome === "passed" ? "probe-passed" : "probe-failed",
        elapsed_ms: 1,
        next_action: outcome === "passed" ? "none" : "retry-later",
        network: "may-have-run",
        may_consume_quota: false,
      },
    });
    let probe: ConfigurationProbeSession | undefined;
    try {
      await owner.publish(
        '[providers.fixture]\napi = "openai-responses"\nbase_url = "http://127.0.0.1:1/v1"\n[models."fixture/vision"]\nimage = true\nstream = false\n[browser]\nenabled = true\nmodel = "fixture/vision"\nprofile = "fixture"\n[parsing]\nbase_url = "http://127.0.0.1:1"\nconnection_mode = "loopback"\nmodel_identity = "fixture"\n',
        "missing",
        ["providers", "models", "browser", "parsing"],
      );
      const before = await readFile(
        join(home, ".sciretriever/config.toml"),
        "utf8",
      );
      probe = await ConfigurationProbeSession.create(owner, {
        browser_site_factory: async () => null,
      });
      const run = vi.spyOn(probe, "run");
      run
        .mockImplementationOnce(async (request) => result(request, "passed"))
        .mockImplementationOnce(async (request) => result(request, "failed"))
        .mockRejectedValueOnce(
          new ConfigurationProbeError("configuration-test-cancelled"),
        );
      promptState.selections = [
        "parse",
        "test",
        "browser",
        "test-model",
        "parse",
        "test",
        "quit",
      ];
      await expect(
        runRichConfigurationCenter({
          owner,
          probe,
          theme: "mono",
          write: (text) => output.push(text),
        }),
      ).resolves.toBe(0);
      expect(run).toHaveBeenNthCalledWith(
        1,
        { owner: "parse", target: null, image: false },
        { authorized: true },
      );
      expect(run).toHaveBeenNthCalledWith(
        2,
        { owner: "browser-model", target: null, image: true },
        { authorized: true },
      );
      expect(run).toHaveBeenCalledTimes(3);
      expect(output.join("\n")).toContain("Outcome   PASSED");
      expect(output.join("\n")).toContain("Outcome   failed");
      expect(output.join("\n")).toContain(
        "configuration probe did not complete",
      );
      expect(
        await readFile(join(home, ".sciretriever/config.toml"), "utf8"),
      ).toBe(before);
      await expect(
        readFile(join(home, "catalog.sqlite")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      probe?.close();
      promptState.selections = [];
      promptState.inputs = [];
      promptState.confirmations = [];
      await rm(home, { recursive: true, force: true });
    }
  });

  it("navigates every area offline and renders shared readiness", async () => {
    const home = await mkdtemp(join(tmpdir(), "sciretriever-tui-navigation-"));
    const stdout: string[] = [];
    const stderr: string[] = [];
    try {
      const result = await runCli(["config"], {
        home,
        stdin: input("m\ns\nd\np\na\nb\ni\nt\nq\n"),
        stdout: (text) => stdout.push(text),
        stderr: (text) => stderr.push(text),
      });
      expect(result.code).toBe(0);
      // Plain result pages stay on stdout.
      const screen = stdout.join("");
      for (const area of [
        "Models",
        "Search",
        "Download",
        "Parse",
        "Analyze",
        "Browser",
        "Status",
        "Theme",
        "Quit",
      ])
        expect(screen).toContain(area);
      expect(screen).toContain('"network_performed": false');
      expect(screen).toContain('"browser_launched": false');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("uses local status for non-interactive invocations without creating a catalog", async () => {
    const home = await mkdtemp(join(tmpdir(), "sciretriever-tui-status-"));
    try {
      const output: string[] = [];
      const result = await runCli(["config", "status", "--json"], {
        home,
        stdout: (text) => output.push(text),
      });
      expect(result.code).toBe(0);
      expect(result.value).toMatchObject({
        network_performed: false,
        browser_launched: false,
      });
      expect(JSON.parse(output.join(""))).toMatchObject({
        network_performed: false,
        browser_launched: false,
      });
      await expect(
        readFile(join(home, "catalog.sqlite")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("keeps status on stdout and reports an unconfirmed probe only on stderr", async () => {
    const home = await mkdtemp(join(tmpdir(), "sciretriever-tui-human-"));
    try {
      const statusOutput: string[] = [];
      const status = await runCli(["config", "status"], {
        home,
        stdout: (text) => statusOutput.push(text),
      });
      expect(status.code).toBe(0);
      expect(statusOutput.join("")).toContain("Readiness");
      expect(statusOutput.join("")).toContain("network_performed=false");
      expect(statusOutput.join("")).not.toContain('"network_performed"');

      // Without a usable confirmation no probe runs: stdout stays empty and
      // the reason is a stderr diagnostic instead of a result.
      const testOutput: string[] = [];
      const diagnosis: string[] = [];
      const probe = await runCli(["config", "test", "parse"], {
        home,
        stdout: (text) => testOutput.push(text),
        stderr: (text) => diagnosis.push(text),
      });
      expect(probe.code).toBe(3);
      expect(probe.value).toMatchObject({
        owner: "parse",
        outcome: "blocked",
        reason: "parser-configuration-incomplete",
        network_performed: false,
      });
      expect(testOutput.join("")).toBe("");
      expect(diagnosis.join("")).toContain("parser-configuration-incomplete");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("falls back to a deterministic status page on stdout and diagnostics on stderr", async () => {
    const home = await mkdtemp(join(tmpdir(), "sciretriever-tui-plain-"));
    try {
      const stdout: string[] = [];
      const stderr: string[] = [];
      const result = await runCli(["config"], {
        home,
        stdout: (text) => stdout.push(text),
        stderr: (text) => stderr.push(text),
      });
      expect(result.code).toBe(0);
      expect(stdout.join("")).toContain("SciRetriever configuration center");
      expect(stdout.join("")).toContain("Choose M/S/D/P/A/B/N/I/T/Q.");
      expect(stderr.join("")).toBe("");

      // An invalid menu selection is a diagnostic: stderr, never a re-render
      // of the result page.
      const invalidStdout: string[] = [];
      const invalid: string[] = [];
      await runCli(["config"], {
        home,
        stdin: input("z\nq\n"),
        stdout: (text) => invalidStdout.push(text),
        stderr: (text) => invalid.push(text),
      });
      expect(invalid.join("")).toContain("Choose M/S/D/P/A/B/N/I/T/Q.");
      expect(
        invalidStdout.join("").match(/SciRetriever configuration center/gu),
      ).toHaveLength(1);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("supports local status navigation through the same TS owner", async () => {
    const home = await mkdtemp(join(tmpdir(), "sciretriever-tui-theme-"));
    const owner = new TypeScriptConfigurationOwner(home);
    try {
      expect((await owner.status()).network_performed).toBe(false);
      const stdout: string[] = [];
      await runCli(["config"], {
        home,
        stdin: input("i\nq\n"),
        stdout: (text) => stdout.push(text),
      });
      expect(stdout.join("")).toContain("Status");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

it("preserves legacy hint IDs on read and offers only standalone PDF adapters on explicit custom editing", async () => {
  const home = await mkdtemp(join(tmpdir(), "sciretriever-tui-source-choice-")),
    owner = new TypeScriptConfigurationOwner(home);
  try {
    await owner.publish(
      '[sources.acquisition]\nmode="custom"\nproviders=["crossref","wiley"]\n',
      "missing",
      ["sources"],
    );
    await owner.status();
    expect(
      (await owner.read()).configuration.sources.acquisition.providers,
    ).toEqual(["crossref", "wiley"]);
    promptState.selections = ["download", "custom", "back", "quit"];
    promptState.confirmations = [true];
    const output: string[] = [];
    expect(
      await runRichConfigurationCenter({
        owner,
        theme: "mono",
        write: (t) => output.push(t),
      }),
    ).toBe(0);
    expect(promptState.checkboxChoices).toEqual([
      "arxiv",
      "europe-pmc",
      "unpaywall",
      "elsevier",
      "wiley",
      "core",
      "sci-hub",
    ]);
    expect(output.join("\n")).toContain("Proposed configuration changes");
    expect(
      (await owner.read()).configuration.sources.acquisition.providers,
    ).toEqual([]);
  } finally {
    promptState.selections = [];
    promptState.confirmations = [];
    promptState.checkboxChoices = [];
    await rm(home, { recursive: true, force: true });
  }
});
