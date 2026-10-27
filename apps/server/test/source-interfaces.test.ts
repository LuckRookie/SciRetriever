import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { expect, it } from "vitest";
import { parseSourceDirectory } from "@sciretriever/contracts";
import { startProductionWorkbench } from "../src/bootstrap/workbench.js";
import {
  workbenchLogin,
  workbenchTestAccess,
} from "./workbench-auth-fixture.js";
import { createMcpServer } from "../src/mcp/server.js";
import { runCli } from "../src/cli/main.js";
import { RestartAdmission } from "../src/application/restart-admission.js";
import { networkRequestDispatched } from "../src/network/request-activity.js";
it("uses one source contract and CAS through HTTP, CLI and MCP without literature writes or model calls", async () => {
  const home = await mkdtemp(join(tmpdir(), "sciretriever-source-interfaces-"));
  const fake = {
    metadata_assembly: {
      transportFactory: () => ({
        request: async () => {
          networkRequestDispatched();
          return [];
        },
      }),
    },
  };
  const web = await startProductionWorkbench({
    home,
    port: 0,
    access: workbenchTestAccess,
    assets: new Map([
      ["/", { contentType: "text/html", body: "Synthetic source interface" }],
    ]),
    configurationProbeSeams: fake,
  });
  const host = createMcpServer({ home, maintenance: true, probeSeams: fake });
  const client = new Client({ name: "synthetic-source-test", version: "1" });
  const [serverTransport, clientTransport] =
    InMemoryTransport.createLinkedPair();
  await host.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const before = await web.application.database.inspectExecutionRuntime();
    const auth = await workbenchLogin(web.origin),
      root = await fetch(web.origin, { headers: { Cookie: auth } }),
      cookie = `${auth}; ${root.headers
        .getSetCookie()
        .map((c) => c.split(";")[0])
        .join("; ")}`;
    const init = await fetch(`${web.origin}/api/clients`, {
      method: "POST",
      headers: {
        Cookie: cookie,
        Origin: web.origin,
        "X-Workbench-Init": "1",
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    const grant = (await init.json()) as { client_id: string; csrf: string };
    const call = async (path: string, value?: unknown) => {
      const response = await fetch(
        `${web.origin}/api/configuration/${path}?client_id=${grant.client_id}`,
        {
          method: value === undefined ? "GET" : "POST",
          headers: {
            Cookie: cookie,
            Origin: web.origin,
            "Content-Type": "application/json",
            "X-Workbench-Csrf": grant.csrf,
          },
          ...(value === undefined ? {} : { body: JSON.stringify(value) }),
        },
      );
      const body = (await response.json()) as {
        result?: unknown;
        code?: string;
        current_revision?: string;
        problem?: unknown;
      };
      return {
        status: response.status,
        result: body.result,
        body,
      };
    };
    const http = parseSourceDirectory((await call("sources")).result);
    expect(http.runtime).not.toBeNull();
    let output = "";
    const cli = await runCli(["config", "sources", "--json"], {
      home,
      stdout: (text) => {
        output += text;
      },
    });
    expect(cli.code).toBe(0);
    const cliDirectory = parseSourceDirectory(
      (JSON.parse(output) as { result: unknown }).result,
    );
    expect(cliDirectory.runtime).toBeNull();
    expect(cliDirectory.catalog_revision).toBe(http.catalog_revision);
    const mcp = await client.callTool({
      name: "configuration_sources",
      arguments: {},
    });
    expect(mcp.isError).not.toBe(true);
    const directory = parseSourceDirectory(
      (mcp.structuredContent as { result: unknown }).result,
    );
    expect(directory.catalog_revision).toBe(http.catalog_revision);
    const secret = "synthetic-source-value-never-echo";
    const saved = await call("source-save", {
      source: "wiley",
      baseline: http.catalog_revision,
      parameters: { action: "keep" },
      credentials: [
        { field: "tdm_api_token", action: "replace", value: secret },
      ],
      test_after_save: false,
    });
    expect(saved.status).toBe(200);
    expect(JSON.stringify(saved)).not.toContain(secret);
    const stale = {
      source: "wiley",
      baseline: http.catalog_revision,
      parameters: { action: "keep" },
      credentials: [
        { field: "tdm_api_token", action: "replace", value: secret },
      ],
      test_after_save: false,
    };
    const conflict = await call("source-save", stale);
    expect(conflict.status).toBe(409);
    expect(conflict.body).toMatchObject({
      code: "source-configuration-conflict",
      problem: { display: "error" },
    });
    let errors = "";
    const rejected = await runCli(
      ["config", "source-save", "--request", "-", "--json"],
      {
        home,
        stdin: (async function* () {
          yield Buffer.from(JSON.stringify(stale));
        })(),
        stderr: (t) => {
          errors += t;
        },
      },
    );
    expect(rejected.code).toBe(3);
    expect(JSON.parse(errors)).toMatchObject({
      code: conflict.body.code,
      current_revision: conflict.body.current_revision,
      problem: { display: "error" },
    });
    const rejectedMcp = await client.callTool({
      name: "configuration_source_save",
      arguments: stale,
    });
    expect(rejectedMcp.isError).toBe(true);
    expect(
      (rejectedMcp.structuredContent as { result: unknown }).result,
    ).toMatchObject({
      failure: {
        code: conflict.body.code,
        current_revision: conflict.body.current_revision,
        problem: { display: "error" },
      },
    });
    expect(JSON.stringify([conflict, errors, rejectedMcp])).not.toContain(
      secret,
    );
    const current = await client.callTool({
      name: "configuration_sources",
      arguments: {},
    });
    const next = parseSourceDirectory(
      (current.structuredContent as { result: unknown }).result,
    );
    expect(next.catalog_revision).not.toBe(http.catalog_revision);
    const admission = new RestartAdmission(home);
    await admission.newWork(async () => {
      const intent = await admission.acquire("intent", "exclusive");
      try {
        const input = {
          source: "wiley",
          baseline: next.catalog_revision,
          parameters: { action: "keep" },
          credentials: [],
          test_after_save: false,
        };
        let error = "";
        const cliResult = await runCli(
          ["config", "source-save", "--request", "-", "--json"],
          {
            home,
            stdin: (async function* () {
              yield Buffer.from(JSON.stringify(input));
            })(),
            stderr: (t) => {
              error += t;
            },
          },
        );
        expect(cliResult.code).toBe(3);
        expect(JSON.parse(error)).toMatchObject({
          code: "configuration-apply-busy",
        });
        const mcpResult = await client.callTool({
          name: "configuration_source_save",
          arguments: input,
        });
        expect(mcpResult.isError).toBe(true);
        expect(mcpResult.structuredContent).toMatchObject({
          result: { failure: { code: "configuration-apply-busy" } },
        });
      } finally {
        await intent.release();
      }
    });
    const source = next.rows.find((r) => r.source === "opencitations")!;
    const tested = await client.callTool({
      name: "configuration_source_test",
      arguments: {
        source: "opencitations",
        source_revision: source.source_revision,
        request_id: randomUUID(),
      },
    });
    expect(tested.isError).not.toBe(true);
    await expect
      .poll(async () => {
        const read = await client.callTool({
          name: "configuration_sources",
          arguments: {},
        });
        return parseSourceDirectory(
          (read.structuredContent as { result: unknown }).result,
        ).rows.find((r) => r.source === "opencitations")!.test.latest?.status;
      })
      .toBe("available");
    expect((await call("apply")).result).toMatchObject({
      managed: false,
      state: "unmanaged",
    });
    expect(
      (await web.application.database.inspectExecutionRuntime()).counts,
    ).toEqual(before.counts);
  } finally {
    await client.close();
    await host.close();
    await web.close();
    await rm(home, { recursive: true, force: true });
  }
}, 20000);
