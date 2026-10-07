import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { credentialHeader } from "../src/agents/common.js";
import type {
  AgentTransport,
  AgentTransportResponse,
} from "../src/agents/protocol.js";
import { runCli } from "../src/cli/main.js";
import { loadCredentialBundle } from "../src/configuration/credentials.js";
import {
  ConfigurationProbeSession,
  TypeScriptConfigurationOwner,
  providerProbeRequestHeaders,
  type ConfigurationProbeBrowserSite,
  type ConfigurationProbeResult,
  type ConfigurationProbeSeams,
} from "../src/configuration/owner.js";
import { assembleMetadataRegistry } from "../src/metadata/assembly.js";
import { NetworkBudgetCoordinator } from "../src/network/budget.js";
import type { MetadataTransport } from "../src/providers/shared/metadata-transport.js";

const SECRET = "synthetic-probe-secret-never-returned";

interface LoopbackRequest {
  readonly method: string;
  readonly path: string;
  readonly authorization: string | null;
}

interface LoopbackServer {
  readonly url: string;
  readonly requests: LoopbackRequest[];
  readonly close: () => Promise<void>;
}

function jsonBody(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

async function loopback(
  handle: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<LoopbackServer> {
  const requests: LoopbackRequest[] = [];
  const server = createServer((request, response) => {
    requests.push({
      method: request.method ?? "GET",
      path: request.url ?? "/",
      authorization: request.headers.authorization ?? null,
    });
    handle(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("fixture listen failed");
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

function metadataTransport(mode: "ok" | "failed"): MetadataTransport {
  return {
    request: async () =>
      mode === "ok"
        ? {
            status: "ok",
            "message-type": "work-list",
            message: { items: [], "next-cursor": null },
          }
        : { status: "error", message: "fixture provider failure" },
  };
}

function agentTransport(
  mode: "text" | "tool" | "rejected",
  received: Record<string, unknown>[] = [],
): AgentTransport {
  return async (request): Promise<AgentTransportResponse> => {
    received.push(
      JSON.parse(new TextDecoder().decode(request.body)) as Record<
        string,
        unknown
      >,
    );
    if (mode === "rejected")
      return { status: 401, headers: [], body: new Uint8Array() };
    const output =
      mode === "tool"
        ? [
            {
              type: "function_call",
              name: "sciretriever_probe_stop",
              arguments: '{"received":true}',
            },
          ]
        : [
            {
              type: "message",
              status: "completed",
              role: "assistant",
              content: [{ type: "output_text", text: '{"ok":true}' }],
            },
          ];
    return {
      status: 200,
      headers: [["content-type", "application/json"]],
      body: jsonBody({
        object: "response",
        status: "completed",
        model: "model",
        output,
        usage: { input_tokens: 4, output_tokens: 2 },
      }),
    };
  };
}

const homes: string[] = [];
const servers: LoopbackServer[] = [];

async function home(payload: string): Promise<{
  readonly home: string;
  readonly owner: TypeScriptConfigurationOwner;
}> {
  const directory = await mkdtemp(
    join(tmpdir(), "sciretriever-probe-journey-"),
  );
  homes.push(directory);
  const owner = new TypeScriptConfigurationOwner(directory);
  await owner.publish(payload, "missing", [
    "sources",
    "providers",
    "models",
    "analyze",
    "parsing",
    "browser",
  ]);
  return { home: directory, owner };
}

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const directory of homes.splice(0))
    await rm(directory, { recursive: true, force: true });
});

function probeConfiguration(base: string, browser = true): string {
  return `[providers.fixture]
api = "openai-responses"
base_url = "${base}/v1"

[models."fixture/model"]
image = true
stream = false

[analyze]
model = "fixture/model"
metadata_max_output_tokens = 512
content_max_output_tokens = 2048
max_input_bytes = 1000000
max_chunk_bytes = 100000
max_chunk_count = 16
max_total_llm_requests = 8
max_total_output_tokens = 20000

[parsing]
base_url = "${base}"
connection_mode = "loopback"
model_identity = "mineru-3.4.4-vlm"

[browser]
enabled = ${browser ? "true" : "false"}
profile = "synthetic"
model = "fixture/model"
`;
}

async function seams(
  directory: string,
  options: {
    readonly agent?: AgentTransport;
    readonly metadata?: "ok" | "failed";
    readonly browser_site?: ConfigurationProbeBrowserSite | null;
  } = {},
): Promise<ConfigurationProbeSeams> {
  const owner = new TypeScriptConfigurationOwner(directory);
  const snapshot = await owner.read();
  const credentials = await loadCredentialBundle(directory);
  const agent = options.agent;
  return {
    credentials,
    // This entire suite is offline. Even with an installed Cloak bundle, an
    // accidental Site request cannot resolve the production homepage probe.
    browser_site_factory: async () => null,
    resolver: async (hostname: string) =>
      hostname === "127.0.0.1" ? ["127.0.0.1"] : [],
    ...(agent === undefined ? {} : { agent_transport: () => agent }),
    ...(options.browser_site === undefined
      ? {}
      : { browser_site: options.browser_site }),
    metadata: assembleMetadataRegistry(
      snapshot.configuration,
      credentials,
      new NetworkBudgetCoordinator(),
      {
        transportFactory: (provider) =>
          metadataTransport(
            options.metadata === "failed" && provider === "arxiv"
              ? "failed"
              : "ok",
          ),
      },
    ),
  };
}

describe("TypeScript configuration probe boundary", () => {
  it("keeps admitted probe credentials in flight and applies revocation to the next session", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "sciretriever-probe-revocation-"),
    );
    const owner = new TypeScriptConfigurationOwner(directory);
    const payload = `[providers.fixture]
api = "openai-responses"
base_url = "https://fixture.example.test/v1"
[models."fixture/model"]
image = false
stream = false
[analyze]
model = "fixture/model"
metadata_max_output_tokens = 512
content_max_output_tokens = 2048
max_input_bytes = 1000000
max_chunk_bytes = 100000
max_chunk_count = 16
max_total_llm_requests = 8
max_total_output_tokens = 20000
`;
    let markEntered!: () => void;
    let releaseRequest!: () => void;
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    const inFlight = new Promise<void>((resolve) => {
      releaseRequest = resolve;
    });
    const requests: Array<{
      readonly headers: readonly (readonly [string, string])[];
    }> = [];
    const transport: AgentTransport = async (request) => {
      requests.push({ headers: request.headers });
      markEntered();
      await inFlight;
      return {
        status: 200,
        headers: [["content-type", "application/json"]],
        body: jsonBody({
          object: "response",
          status: "completed",
          model: "model",
          output: [
            {
              type: "message",
              status: "completed",
              role: "assistant",
              content: [{ type: "output_text", text: '{"ok":true}' }],
            },
          ],
          usage: { input_tokens: 4, output_tokens: 2 },
        }),
      };
    };
    let admitted: ConfigurationProbeSession | undefined;
    let next: ConfigurationProbeSession | undefined;
    try {
      const published = await owner.publish(payload, "missing", [
        "providers",
        "models",
        "analyze",
      ]);
      await owner.credential(
        {
          namespace: "model",
          target: "fixture",
          kind: "set",
          value: SECRET,
        },
        published.revision,
      );
      admitted = await ConfigurationProbeSession.create(owner, {
        agent_transport: () => transport,
      });
      const running = admitted.run(
        { owner: "analyze", target: null, image: false },
        { authorized: true },
      );
      await entered;

      const current = await owner.read();
      await owner.credential(
        { namespace: "model", target: "fixture", kind: "remove" },
        current.revision,
      );
      releaseRequest();
      await expect(running).resolves.toMatchObject({ outcome: "passed" });
      expect(
        requests[0]?.headers.find(([name]) => name === "authorization")?.[1],
      ).toBe(`Bearer ${SECRET}`);

      next = await ConfigurationProbeSession.create(owner, {
        agent_transport: () => transport,
      });
      await expect(
        next.run(
          { owner: "analyze", target: null, image: false },
          { authorized: true },
        ),
      ).resolves.toMatchObject({
        outcome: "blocked",
        reason: "model-credential-unavailable",
      });
      expect(requests).toHaveLength(1);
    } finally {
      releaseRequest();
      admitted?.close();
      next?.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reads one bounded model directory through the shared Network boundary", async () => {
    const server = await loopback((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: "fixture/model" }] }));
    });
    servers.push(server);
    const { home: directory } = await home(probeConfiguration(server.url));
    const result = await runCli(
      ["config", "test", "provider", "fixture", "--json"],
      { home: directory, json: true, probeSeams: await seams(directory) },
    );
    expect(result.code).toBe(0);
    expect(result.value).toMatchObject({
      owner: "provider",
      target: "fixture",
      outcome: "passed",
      method: "GET",
      endpoint: `${server.url}/v1/models`,
      network_performed: true,
      browser_launched: false,
      authentication: "accepted",
      article_entitlement: "not-proven",
      persisted: false,
      execution: { network: "may-have-run", may_consume_quota: false },
    });
    expect(server.requests).toEqual([
      { method: "GET", path: "/v1/models", authorization: null },
    ]);
    expect(existsSync(join(directory, "catalog.sqlite"))).toBe(false);
    expect(existsSync(join(directory, "artifacts"))).toBe(false);
  });

  it("reports missing declarations and missing credentials as stable blocked outcomes", async () => {
    const { home: directory } = await home("[browser]\nenabled = false\n");
    const provider = await runCli(
      ["config", "test", "provider", "absent", "--json"],
      { home: directory, json: true },
    );
    expect(provider.code).toBe(3);
    expect(provider.value).toMatchObject({
      outcome: "blocked",
      reason: "model-provider-not-configured",
      network_performed: false,
      execution: { network: "not-requested" },
    });
    const parse = await runCli(["config", "test", "parse", "--json"], {
      home: directory,
      json: true,
    });
    expect(parse.value).toMatchObject({
      outcome: "blocked",
      reason: "parser-configuration-incomplete",
    });
    const analyze = await runCli(["config", "test", "analyze", "--json"], {
      home: directory,
      json: true,
    });
    expect(analyze.value).toMatchObject({
      outcome: "blocked",
      reason: "analysis-configuration-incomplete",
    });
    const browserModel = await runCli(
      ["config", "test", "browser", "model", "--json"],
      { home: directory, json: true },
    );
    expect(browserModel.value).toMatchObject({
      outcome: "skipped",
      reason: "browser-disabled",
    });
  });

  it("sends the fixed strict-schema text probe and the synthetic image probe", async () => {
    const server = await loopback((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({}));
    });
    servers.push(server);
    const { home: directory } = await home(probeConfiguration(server.url));
    const textRequests: Record<string, unknown>[] = [];
    const text = await runCli(
      ["config", "test", "model", "fixture/model", "--json"],
      {
        home: directory,
        json: true,
        probeSeams: await seams(directory, {
          agent: agentTransport("text", textRequests),
        }),
      },
    );
    expect(text.code).toBe(0);
    expect(text.value).toMatchObject({
      owner: "model",
      outcome: "passed",
      method: "POST",
      provider: "fixture",
      model: "model",
      network_performed: true,
      execution: { may_consume_quota: true },
      checks: ["strict-schema-text", "closed-response"],
    });
    expect(textRequests).toHaveLength(1);
    const wire = textRequests[0]!;
    expect(wire.model).toBe("model");
    expect(wire.stream).toBeUndefined();
    expect(wire.text).toMatchObject({
      format: {
        type: "json_schema",
        strict: true,
        schema: {
          type: "object",
          properties: { ok: { type: "boolean" } },
          required: ["ok"],
          additionalProperties: false,
        },
      },
    });
    expect(JSON.stringify(wire)).toContain("sciretriever-configuration");

    const imageRequests: Record<string, unknown>[] = [];
    const image = await runCli(
      ["config", "test", "model", "fixture/model", "--image", "--json"],
      {
        home: directory,
        json: true,
        probeSeams: await seams(directory, {
          agent: agentTransport("tool", imageRequests),
        }),
      },
    );
    expect(image.code).toBe(0);
    expect(image.value).toMatchObject({
      outcome: "passed",
      checks: ["synthetic-image", "closed-stop-tool", "tool-decision"],
    });
    const imageWire = JSON.stringify(imageRequests[0]);
    expect(imageWire).toContain("data:image/jpeg;base64,");
    expect(imageWire).toContain("sciretriever_probe_stop");
    expect(imageWire).not.toContain("sciretriever-configuration");
  });

  it("classifies a rejected credential as a stable failed outcome", async () => {
    const server = await loopback((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({}));
    });
    servers.push(server);
    const { home: directory } = await home(probeConfiguration(server.url));
    const result = await runCli(["config", "test", "analyze", "--json"], {
      home: directory,
      json: true,
      probeSeams: await seams(directory, {
        agent: agentTransport("rejected"),
      }),
    });
    expect(result.code).toBe(3);
    expect(result.value).toMatchObject({
      owner: "analyze",
      outcome: "failed",
      reason: "model-authentication-rejected",
      action: "set-credential",
      authentication: "rejected",
      network_performed: true,
      article_entitlement: "not-proven",
    });
  });

  it("separates performed, skipped and failed metadata search probes", async () => {
    const { home: directory } = await home("[browser]\nenabled = false\n");
    const probe = await seams(directory, { metadata: "failed" });
    const session = await ConfigurationProbeSession.create(
      new TypeScriptConfigurationOwner(directory),
      probe,
    );
    try {
      const performed = await session.run(
        { owner: "search", target: "crossref", image: false },
        { authorized: true },
      );
      expect(performed).toMatchObject({
        outcome: "passed",
        method: "GET",
        endpoint: "https://api.crossref.org",
        network_performed: true,
        checks: ["official-read-only-request"],
      });
      const skipped = await session.run(
        { owner: "search", target: "elsevier", image: false },
        { authorized: true },
      );
      expect(skipped).toMatchObject({
        outcome: "skipped",
        reason: "credential-missing",
        network_performed: false,
      });
      const failed = await session.run(
        { owner: "search", target: "arxiv", image: false },
        { authorized: true },
      );
      expect(failed.outcome).toBe("failed");
      expect(failed.network_performed).toBe(true);
      const aggregate = await session.run(
        { owner: "search", target: null, image: false },
        { authorized: true },
      );
      expect(aggregate.outcome).toBe("failed");
      expect(aggregate.results.length).toBeGreaterThan(1);
      expect(aggregate.results.every((item) => item.owner === "search")).toBe(
        true,
      );
      expect(aggregate.execution.code).toBe(aggregate.reason);
    } finally {
      session.close();
    }
  });

  it("never pretends a Download probe or a Browser runtime exists", async () => {
    vi.stubEnv("SCIRETRIEVER_CLOAK_BUNDLE", "");
    const { home: directory } = await home(
      '[browser]\nenabled = true\nprofile = "synthetic"\n[sources.acquisition]\nmode = "custom"\nproviders = ["arxiv", "core"]\n',
    );
    const session = await ConfigurationProbeSession.create(
      new TypeScriptConfigurationOwner(directory),
      await seams(directory),
    );
    try {
      const ready = await session.run(
        { owner: "download", target: "arxiv", image: false },
        { authorized: true },
      );
      expect(ready).toMatchObject({
        outcome: "unavailable",
        reason: "acquisition-probe-unavailable",
        action: "use-complete-pdf",
        network_performed: false,
        browser_launched: false,
        article_entitlement: "not-proven",
      });
      const notReady = await session.run(
        { owner: "download", target: "core", image: false },
        { authorized: true },
      );
      expect(notReady).toMatchObject({
        outcome: "blocked",
        reason: "missing-credential",
      });
      const site = await session.run(
        {
          owner: "browser-site",
          target: "elsevier-sciencedirect",
          image: false,
        },
        { authorized: true },
      );
      expect(site).toMatchObject({
        outcome: "unavailable",
        reason: "browser-site-probe-unavailable",
        browser_launched: false,
      });
      const disabled = await ConfigurationProbeSession.create(
        new TypeScriptConfigurationOwner(directory),
        await seams(directory, {
          browser_site: {
            access_keys: ["elsevier-sciencedirect"],
            probe: async () => undefined,
          },
        }),
      );
      try {
        expect(
          (
            await disabled.run(
              { owner: "browser-site", target: "unknown-site", image: false },
              { authorized: true },
            )
          ).reason,
        ).toBe("browser-site-unsupported-target");
      } finally {
        disabled.close();
      }
    } finally {
      session.close();
      vi.unstubAllEnvs();
    }
  });

  it("probes one explicitly selected Browser Site only with a wired port", async () => {
    const { home: directory } = await home(
      '[browser]\nenabled = true\nprofile = "synthetic"\n',
    );
    const probed: string[] = [];
    const browserSite: ConfigurationProbeBrowserSite = {
      access_keys: ["elsevier-sciencedirect"],
      probe: async (accessKey) => {
        probed.push(accessKey);
      },
    };
    const session = await ConfigurationProbeSession.create(
      new TypeScriptConfigurationOwner(directory),
      await seams(directory, { browser_site: browserSite }),
    );
    try {
      const passed = await session.run(
        {
          owner: "browser-site",
          target: "elsevier-sciencedirect",
          image: false,
        },
        { authorized: true },
      );
      expect(passed).toMatchObject({
        outcome: "passed",
        browser_launched: true,
        article_entitlement: "not-proven",
        persisted: false,
        checks: ["headed-browser", "minimal-target-navigation"],
      });
      expect(probed).toEqual(["elsevier-sciencedirect"]);
      const refused = await session.run(
        {
          owner: "browser-site",
          target: "elsevier-sciencedirect",
          image: false,
        },
        { authorized: false },
      );
      expect(refused).toMatchObject({
        outcome: "blocked",
        reason: "probe-not-authorized",
        browser_launched: false,
        network_performed: false,
      });
      expect(probed).toEqual(["elsevier-sciencedirect"]);
    } finally {
      session.close();
    }
  });

  it("defers Browser runtime resolution until an authorized Site request", async () => {
    const { home: directory } = await home(
      '[browser]\nenabled = true\nprofile = "synthetic"\n',
    );
    const probe = vi.fn(async () => undefined);
    const factory = vi.fn(async () => ({
      access_keys: ["acs-publications"],
      probe,
    }));
    const session = await ConfigurationProbeSession.create(
      new TypeScriptConfigurationOwner(directory),
      { ...(await seams(directory)), browser_site_factory: factory },
    );
    try {
      expect(factory).not.toHaveBeenCalled();
      await session.run(
        { owner: "download", target: "core", image: false },
        { authorized: true },
      );
      expect(factory).not.toHaveBeenCalled();
      await expect(
        session.run(
          { owner: "browser-site", target: "acs-publications", image: false },
          { authorized: false },
        ),
      ).resolves.toMatchObject({ outcome: "blocked" });
      expect(factory).not.toHaveBeenCalled();
      await expect(
        session.run(
          { owner: "browser-site", target: "acs-publications", image: false },
          { authorized: true },
        ),
      ).resolves.toMatchObject({ outcome: "passed" });
      expect(factory).toHaveBeenCalledTimes(1);
      expect(probe).toHaveBeenCalledTimes(1);
    } finally {
      session.close();
    }
  });

  it("verifies only the MinerU health endpoint", async () => {
    const healthy = await loopback((request, response) => {
      if (request.url === "/health") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            status: "healthy",
            version: "3.4.4",
            protocol_version: 2,
          }),
        );
        return;
      }
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "failed" }));
    });
    servers.push(healthy);
    const { home: directory } = await home(probeConfiguration(healthy.url));
    const session = await ConfigurationProbeSession.create(
      new TypeScriptConfigurationOwner(directory),
      await seams(directory),
    );
    try {
      const result = await session.run(
        { owner: "parse", target: null, image: false },
        { authorized: true },
      );
      expect(result).toMatchObject({
        outcome: "passed",
        method: "GET",
        endpoint: `${healthy.url}/health`,
        provider: "mineru",
        model: "mineru-3.4.4-vlm",
        checks: ["parser-healthy", "parser-release-3.4.4", "parser-protocol-2"],
      });
      expect(healthy.requests.map((item) => item.path)).toEqual(["/health"]);
    } finally {
      session.close();
    }

    const stale = await loopback((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          status: "healthy",
          version: "3.4.0",
          protocol_version: 2,
        }),
      );
    });
    servers.push(stale);
    const staleHome = await home(probeConfiguration(stale.url));
    const staleSession = await ConfigurationProbeSession.create(
      new TypeScriptConfigurationOwner(staleHome.home),
      await seams(staleHome.home),
    );
    try {
      const result = await staleSession.run(
        { owner: "parse", target: null, image: false },
        { authorized: true },
      );
      expect(result).toMatchObject({
        outcome: "failed",
        reason: "parser-release-mismatch",
      });
    } finally {
      staleSession.close();
    }
  });

  it("aggregates --all without borrowing a Download or Browser Site probe", async () => {
    const server = await loopback((request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify(
          request.url === "/health"
            ? { status: "healthy", version: "3.4.4", protocol_version: 2 }
            : { data: [] },
        ),
      );
    });
    servers.push(server);
    const { home: directory } = await home(probeConfiguration(server.url));
    const session = await ConfigurationProbeSession.create(
      new TypeScriptConfigurationOwner(directory),
      await seams(directory, { agent: agentTransport("tool") }),
    );
    try {
      const result = await session.run(
        { owner: "all", target: null, image: false },
        { authorized: true },
      );
      expect(result.results.map((item) => item.owner)).toEqual([
        "search",
        "download",
        "parse",
        "analyze",
        "browser-model",
      ]);
      // Download never counts; the executed probes decide the verdict.
      expect(result.outcome).toBe(
        result.results.some(
          (item) => item.owner !== "download" && item.outcome === "failed",
        )
          ? "failed"
          : result.outcome,
      );
      expect(result.limitations).toEqual(
        expect.arrayContaining([
          "download-probe-unavailable",
          "browser-site-requires-explicit-target",
          "model-directory-not-probed",
        ]),
      );
      expect(server.requests.every((item) => item.path !== "/v1/models")).toBe(
        true,
      );
    } finally {
      session.close();
    }
  });

  it("keeps machine output redacted, repeatable and free of side effects", async () => {
    const { home: directory, owner } = await home(
      '[providers.fixture]\napi = "openai-responses"\nbase_url = "https://fixture.example.test/v1"\n[browser]\nenabled = false\n',
    );
    const revision = (await owner.read()).revision;
    await owner.credential(
      {
        namespace: "source",
        target: "core",
        kind: "set",
        fields: { api_key: SECRET },
      },
      revision,
    );
    const stdout: string[] = [];
    const stderr: string[] = [];
    const first = await runCli(
      ["config", "test", "search", "elsevier", "--json"],
      {
        home: directory,
        json: true,
        stdout: (text) => stdout.push(text),
        stderr: (text) => stderr.push(text),
        probeSeams: await seams(directory),
      },
    );
    const second = await runCli(
      ["config", "test", "search", "elsevier", "--json"],
      {
        home: directory,
        json: true,
        stdout: (text) => stdout.push(text),
        stderr: (text) => stderr.push(text),
        probeSeams: await seams(directory),
      },
    );
    const withoutTiming = (value: ConfigurationProbeResult) => ({
      ...value,
      execution: { ...value.execution, elapsed_ms: 0 },
    });
    expect(withoutTiming(second.value as ConfigurationProbeResult)).toEqual(
      withoutTiming(first.value as ConfigurationProbeResult),
    );
    const rendered = `${stdout.join("")}${stderr.join("")}${JSON.stringify(
      first.value,
    )}`;
    expect(rendered).not.toContain(SECRET);
    expect(rendered).not.toContain("fixture.example.test");
    expect(rendered).not.toContain("/v1");
  });

  it("keeps stdout empty, diagnostics on stderr and performs nothing without authorization", async () => {
    const server = await loopback((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [] }));
    });
    servers.push(server);
    const { home: directory } = await home(probeConfiguration(server.url));
    const stdout: string[] = [];
    const stderr: string[] = [];
    const declined = await runCli(["config", "test", "provider", "fixture"], {
      home: directory,
      stdin: (async function* () {
        yield Buffer.from("n\n");
      })(),
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
      probeSeams: await seams(directory),
    });
    expect(declined.code).toBe(3);
    expect(declined.value).toMatchObject({
      outcome: "blocked",
      reason: "probe-not-authorized",
      network_performed: false,
    });
    // Nothing was authorized, so no result reaches stdout.
    expect(stdout.join("")).toBe("");
    expect(stderr.join("")).toContain("bounded read-only probe");
    expect(stderr.join("")).toContain("probe-not-authorized");
    expect(server.requests).toEqual([]);

    const approved = await runCli(["config", "test", "provider", "fixture"], {
      home: directory,
      stdin: (async function* () {
        yield Buffer.from("y\n");
      })(),
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
      probeSeams: await seams(directory),
    });
    expect(approved.code).toBe(0);
    // The plain result is the stdout result; prompts/diagnostics stay stderr.
    expect(stdout.join("")).toContain("Configuration test");
    expect(stdout.join("")).toContain("Outcome");
    expect(stderr.join("")).toContain("config test provider fixture");
    expect(stderr.join("")).toContain("passed");
    expect(server.requests.map((item) => item.path)).toEqual(["/v1/models"]);
  });

  it("cancels a probe through the user signal", async () => {
    const { home: directory } = await home(
      '[providers.fixture]\napi = "openai-responses"\nbase_url = "https://fixture.example.test/v1"\n[models."fixture/model"]\nstream = false\n',
    );
    const controller = new AbortController();
    controller.abort();
    const stderr: string[] = [];
    const result = await runCli(["config", "test", "model", "fixture/model"], {
      home: directory,
      json: true,
      signal: controller.signal,
      stderr: (text) => stderr.push(text),
      probeSeams: await seams(directory, { agent: agentTransport("text") }),
    });
    expect(result.code).toBe(130);
    expect(stderr.join("")).toContain("configuration-test-cancelled");
  });

  it("serializes the recursive --all result once, without leaking or repeating itself", async () => {
    const server = await loopback((request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify(
          request.url === "/health"
            ? { status: "healthy", version: "3.4.4", protocol_version: 2 }
            : { data: [] },
        ),
      );
    });
    servers.push(server);
    const { home: directory } = await home(
      // `--all` probes the enabled selection, so keep it to the one provider
      // whose fake transport speaks its response shape.
      `${probeConfiguration(server.url)}\n[sources.metadata]\nmode = "custom"\nproviders = ["crossref"]\n`,
    );
    // Text probe answers the strict schema; the image probe answers the closed
    // tool. The wire body decides which one the caller asked for.
    const transport: AgentTransport = async (request) => {
      const body = JSON.parse(new TextDecoder().decode(request.body)) as {
        readonly tools?: unknown;
      };
      const output = body.tools
        ? [
            {
              type: "function_call",
              name: "sciretriever_probe_stop",
              arguments: '{"received":true}',
            },
          ]
        : [
            {
              type: "message",
              status: "completed",
              role: "assistant",
              content: [{ type: "output_text", text: '{"ok":true}' }],
            },
          ];
      return {
        status: 200,
        headers: [["content-type", "application/json"]],
        body: jsonBody({
          object: "response",
          status: "completed",
          model: "model",
          output,
          usage: { input_tokens: 4, output_tokens: 2 },
        }),
      };
    };
    const stdout: string[] = [];
    const stderr: string[] = [];
    const result = await runCli(["config", "test", "--all", "--json"], {
      home: directory,
      json: true,
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
      probeSeams: await seams(directory, { agent: transport }),
    });
    expect(result.code).toBe(0);
    const payload = JSON.parse(stdout.join("")) as ConfigurationProbeResult;
    expect(payload).toEqual(result.value);
    expect(payload).toMatchObject({
      owner: "all",
      target: null,
      outcome: "passed",
      article_entitlement: "not-proven",
      persisted: false,
    });
    expect(payload.results.map((item) => item.owner)).toEqual([
      "search",
      "download",
      "parse",
      "analyze",
      "browser-model",
    ]);
    // The recursive shape terminates: only aggregates carry children and no
    // child ever repeats its parent.
    for (const child of payload.results) {
      for (const grandchild of child.results) {
        expect(grandchild.results).toEqual([]);
        expect(grandchild).not.toBe(payload);
        expect(grandchild.owner).not.toBe("all");
      }
    }
    // Machine output stays bounded and redacted: no secret, no home path.
    const rendered = stdout.join("");
    expect(rendered.length).toBeLessThan(200_000);
    expect(rendered).not.toContain(SECRET);
    expect(rendered).not.toContain(directory);
    // A Download probe never runs, so it can never make the aggregate pass or
    // fail: the executed categories decide the verdict.
    expect(
      payload.results.find((item) => item.owner === "download")?.outcome,
    ).toBe("unavailable");
    expect(payload.limitations).toEqual(
      expect.arrayContaining([
        "download-probe-unavailable",
        "browser-site-requires-explicit-target",
        "model-directory-not-probed",
      ]),
    );
  });

  it("derives the provider credential header from the configured protocol", async () => {
    const { home: directory, owner } = await home(
      '[providers.anthropic-fixture]\napi = "anthropic-messages"\nbase_url = "https://anthropic.example.test/v1"\n\n[providers.openai-fixture]\napi = "openai-responses"\nbase_url = "https://openai.example.test/v1"\n\n[models."anthropic-fixture/model"]\nstream = false\n\n[models."openai-fixture/model"]\nstream = false\n',
    );
    await owner.credential(
      {
        namespace: "model",
        target: "anthropic-fixture",
        kind: "set",
        value: SECRET,
      },
      (await owner.read()).revision,
    );
    await owner.credential(
      {
        namespace: "model",
        target: "openai-fixture",
        kind: "set",
        value: SECRET,
      },
      (await owner.read()).revision,
    );
    const captured: Record<string, string>[] = [];
    const capture: AgentTransport = async (request) => {
      captured.push(Object.fromEntries(request.headers));
      // A rejected credential is enough: the request headers are what matter.
      return { status: 401, headers: [], body: new Uint8Array() };
    };
    const stdout: string[] = [];
    const probeSeams = await seams(directory, { agent: capture });
    const anthropic = await runCli(
      ["config", "test", "model", "anthropic-fixture/model", "--json"],
      {
        home: directory,
        json: true,
        stdout: (text) => stdout.push(text),
        probeSeams,
      },
    );
    expect(anthropic.value).toMatchObject({
      outcome: "failed",
      reason: "model-authentication-rejected",
      provider: "anthropic-fixture",
      authentication: "rejected",
    });
    expect(captured[0]).toMatchObject({
      "x-api-key": SECRET,
      "anthropic-version": "2023-06-01",
    });
    expect(captured[0]).not.toHaveProperty("authorization");

    const openai = await runCli(
      ["config", "test", "model", "openai-fixture/model", "--json"],
      { home: directory, json: true, probeSeams },
    );
    expect(openai.value).toMatchObject({
      outcome: "failed",
      reason: "model-authentication-rejected",
      provider: "openai-fixture",
    });
    expect(captured[1]).toMatchObject({ authorization: `Bearer ${SECRET}` });
    expect(captured[1]).not.toHaveProperty("x-api-key");

    // The directory probe derives its header from the same shared mapping the
    // production adapter uses, so the two can never disagree.
    expect(providerProbeRequestHeaders("anthropic-messages", SECRET)).toEqual({
      headers: [
        ["accept", "application/json"],
        ["anthropic-version", "2023-06-01"],
      ],
      credential_headers: [credentialHeader("anthropic", SECRET)],
    });
    expect(providerProbeRequestHeaders("openai-responses", SECRET)).toEqual({
      headers: [["accept", "application/json"]],
      credential_headers: [credentialHeader("openai-responses", SECRET)],
    });
    expect(
      providerProbeRequestHeaders("openai-chat-completions", SECRET)
        ?.credential_headers,
    ).toEqual([credentialHeader("openai-chat", SECRET)]);
    expect(providerProbeRequestHeaders("unknown-api", SECRET)).toBeNull();

    // The secret is used on the wire but never enters machine output.
    expect(stdout.join("")).not.toContain(SECRET);
    expect(JSON.stringify(anthropic.value)).not.toContain(SECRET);
  });

  it("rejects incomplete and unknown selectors before external effects", async () => {
    const { home: directory } = await home("[browser]\nenabled = false\n");
    for (const command of [
      ["config", "test"],
      ["config", "test", "unknown"],
      ["config", "test", "provider"],
      ["config", "test", "browser", "site"],
      ["config", "test", "search"],
    ])
      await expect(runCli(command, { home: directory })).resolves.toMatchObject(
        {
          code: 2,
        },
      );
  });
});
