import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createApplication } from "../src/bootstrap/application.js";
import { TypeScriptConfigurationOwner } from "../src/configuration/owner.js";
import { parseConfiguration } from "../src/configuration/index.js";
import { OpenAIChatAdapter } from "../src/agents/openai.js";
import type { AgentCall } from "../src/agents/protocol.js";

const call: AgentCall = {
  role: "analysis",
  messages: [
    {
      role: "user",
      parts: [{ media_type: "text/plain", text: "Return fixture result" }],
    },
  ],
  required_capabilities: ["structured_text"],
  input_sha256: "a".repeat(64),
  max_output_tokens: 32,
  response_schema: {
    type: "object",
    additionalProperties: false,
    properties: { ok: { type: "boolean" } },
    required: ["ok"],
  },
};
const protocols = [
  "openai-chat-completions",
  "openai-responses",
  "anthropic-messages",
] as const;
function payload(url: string, api: string) {
  return `[providers.fixture]\napi = "${api}"\nbase_url = "${url}/v1"\n[models."fixture/model"]\nstream = false\n[analyze]\nmodel = "fixture/model"\n`;
}
async function server(
  handle: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
) {
  const http = createServer(handle);
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  const address = http.address();
  if (!address || typeof address === "string")
    throw new Error("fixture listen failed");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      http.closeAllConnections();
      await new Promise<void>((r, j) => http.close((e) => (e ? j(e) : r())));
    },
  };
}
it.each(protocols)(
  "assembles %s from saved configuration and sends a credential-free request through real loopback Network",
  async (api) => {
    const received: {
      path: string;
      headers: IncomingMessage["headers"];
      body: Record<string, unknown>;
    }[] = [];
    const http = await server(async (req, res) => {
      const parts: Buffer[] = [];
      for await (const part of req) parts.push(Buffer.from(part as Uint8Array));
      received.push({
        path: req.url!,
        headers: req.headers,
        body: JSON.parse(Buffer.concat(parts).toString()) as Record<
          string,
          unknown
        >,
      });
      const value =
        api === "openai-chat-completions"
          ? {
              model: "model",
              choices: [
                { finish_reason: "stop", message: { content: '{"ok":true}' } },
              ],
              usage: { prompt_tokens: 2, completion_tokens: 3 },
            }
          : api === "openai-responses"
            ? {
                model: "model",
                status: "completed",
                output: [
                  {
                    type: "message",
                    content: [{ type: "output_text", text: '{"ok":true}' }],
                  },
                ],
                usage: { input_tokens: 2, output_tokens: 3 },
              }
            : {
                model: "model",
                stop_reason: "end_turn",
                content: [{ type: "text", text: '{"ok":true}' }],
                usage: { input_tokens: 2, output_tokens: 3 },
              };
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(value));
    });
    const home = await mkdtemp(join(tmpdir(), "sciretriever-model-loopback-"));
    let app: Awaited<ReturnType<typeof createApplication>> | undefined;
    try {
      const owner = new TypeScriptConfigurationOwner(home);
      await owner.publish(payload(http.url, api), "missing", [
        "providers",
        "models",
        "analyze",
      ]);
      app = await createApplication(home, { configurationOwner: owner });
      expect(received).toHaveLength(0);
      expect(app.agents.readiness("analysis")).toEqual({
        configured: true,
        missing: [],
      });
      await expect(app.agents.execute(call)).resolves.toMatchObject({
        value: { ok: true },
        provenance: { usage: { input_tokens: 2, output_tokens: 3 } },
      });
      expect(received).toHaveLength(1);
      expect(received[0]!.path).toBe(
        `/v1/${api === "openai-chat-completions" ? "chat/completions" : api === "openai-responses" ? "responses" : "messages"}`,
      );
      expect(received[0]!.body.model).toBe("model");
      expect(received[0]!.headers).not.toHaveProperty("authorization");
      expect(received[0]!.headers).not.toHaveProperty("x-api-key");
      expect(received[0]!.headers).not.toHaveProperty("cookie");
      if (api === "anthropic-messages")
        expect(received[0]!.headers["anthropic-version"]).toBe("2023-06-01");
    } finally {
      await app?.close();
      await http.close();
      await rm(home, { recursive: true, force: true });
    }
  },
  30000,
);
it("refuses an existing provider credential on a loopback endpoint before I/O", async () => {
  let requests = 0;
  const http = await server((_req, res) => {
    requests++;
    res.end("{}");
  });
  const home = await mkdtemp(join(tmpdir(), "sciretriever-model-loopback-"));
  try {
    const owner = new TypeScriptConfigurationOwner(home);
    await owner.publish(payload(http.url, protocols[0]), "missing", [
      "providers",
      "models",
      "analyze",
    ]);
    // Simulate a credential retained from the former HTTPS origin; no secret is sent to HTTP.
    await writeFile(
      join(home, ".sciretriever", "credentials.toml"),
      '[providers.fixture]\napi_key = "synthetic-retained-key"\norigin = "https://fixture.example.test"\n',
      { mode: 0o600 },
    );
    await expect(
      createApplication(home, { configurationOwner: owner }),
    ).rejects.toMatchObject({ code: "credential-boundary" });
    expect(requests).toBe(0);
  } finally {
    await http.close();
    await rm(home, { recursive: true, force: true });
  }
});
it("blocks model redirects to a second loopback port and cancels pending HTTP when the application closes", async () => {
  let escaped = 0,
    received = 0,
    entered: () => void = () => {};
  const waiting = new Promise<void>((r) => {
    entered = r;
  });
  const target = await server((_req, res) => {
    escaped++;
    res.end("{}");
  });
  const source = await server((_req, res) => {
    received++;
    if (received === 1) {
      res.writeHead(307, { location: `${target.url}/escaped` });
      res.end();
    } else entered();
  });
  const home = await mkdtemp(join(tmpdir(), "sciretriever-model-loopback-"));
  let app: Awaited<ReturnType<typeof createApplication>> | undefined;
  try {
    const owner = new TypeScriptConfigurationOwner(home);
    await owner.publish(payload(source.url, protocols[0]), "missing", [
      "providers",
      "models",
      "analyze",
    ]);
    app = await createApplication(home, { configurationOwner: owner });
    await expect(app.agents.execute(call)).rejects.toThrow();
    expect(received).toBe(1);
    expect(escaped).toBe(0);
    const pending = app.agents.execute(call);
    const rejected = expect(pending).rejects.toMatchObject({
      code: "agent-cancelled",
    });
    await Promise.race([waiting, pending]);
    await app.close();
    await rejected;
    expect(received).toBe(2);
    expect(escaped).toBe(0);
  } finally {
    await app?.close();
    await source.close();
    await target.close();
    await rm(home, { recursive: true, force: true });
  }
});
it("accepts explicit loopback ports but rejects ambiguous addresses and credentialed HTTP adapter calls", async () => {
  for (const url of [
    "http://127.0.0.1:8000",
    "http://localhost:8001",
    "http://[::1]:8002",
  ])
    expect(() => parseConfiguration(payload(url, protocols[0]))).not.toThrow();
  for (const url of [
    "http://127.1:8000",
    "http://2130706433:8000",
    "http://127.0.0.1:080",
    "http://10.0.0.1:8000",
    "https://127.0.0.1:8000",
  ])
    expect(() => parseConfiguration(payload(url, protocols[0]))).toThrow();
  let requests = 0;
  const adapter = new OpenAIChatAdapter({
    provider: "fixture",
    model: "model",
    endpoint: "http://127.0.0.1:8000/v1/chat/completions",
    credential: "synthetic-forbidden-key",
    transport: async () => {
      requests++;
      throw new Error("must not run");
    },
  });
  await expect(
    adapter.execute(call, { reasoning: "default", stream: false }),
  ).rejects.toMatchObject({ code: "agent-credentials" });
  expect(requests).toBe(0);
});
