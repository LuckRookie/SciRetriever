import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/mcp/server.js";
import { runCli } from "../src/cli/main.js";
import { describe, expect, it, vi } from "vitest";
import * as bootstrap from "../src/bootstrap/application.js";
import { coreProcessingFixture } from "./core-processing-fixture.js";
import { createQueryApplication } from "../src/bootstrap/application.js";
import { executeQuery } from "../src/entry/query-operations.js";
import { executeMaintenance } from "../src/entry/maintenance-operations.js";

describe("durable proofreading and human locks", () => {
  it("requires existing raw inputs, publishes/reuses one immutable version, and reads it after reopening", async () => {
    const e = await coreProcessingFixture();
    try {
      const service = e.app.proofreading!;
      await expect(
        service.build({ asset_id: e.asset.asset_id }),
      ).rejects.toMatchObject({ code: "proofread-input-missing" });
      expect(e.parseCalls).toBe(0);
      await e.app.documentProcessing.parseDocuments(e.rawParseRequest);
      const first = await service.build({ asset_id: e.asset.asset_id });
      expect(first).toMatchObject({
        published: true,
        revision: 1,
        version: { status: "complete" },
      });
      const again = await service.build({ asset_id: e.asset.asset_id });
      expect(again).toEqual({ ...first, published: false });
      expect(e.parseCalls).toBe(2);
      expect(e.modelCalls).toBe(0);
      expect(
        (
          await e.app.documentRead.default({
            literature_id: e.parseRequest.literature_id,
            asset_id: e.asset.asset_id,
            asset_sha256: e.asset.sha256,
          })
        ).default,
      ).toBeNull();
      await e.reopen();
      const reader = await createQueryApplication(e.home);
      try {
        expect(
          await executeQuery(reader, "proofread-inspect", {
            asset_id: e.asset.asset_id,
            unresolved_only: false,
          }),
        ).toMatchObject({
          current: {
            proofread_id: first.version.proofread_id,
            status: "complete",
          },
          manual_revision: 0,
          items: expect.arrayContaining([
            {
              block_id: expect.any(String),
              draft_sha256: expect.any(String),
              draft: expect.any(Object),
              block: expect.any(Object),
              suspects: expect.any(Array),
              edits: expect.any(Array),
              decisions: [],
            },
          ]),
        });
      } finally {
        await reader.close();
      }
    } finally {
      await e.close();
    }
  });
  it("locks corrections, refuses stale decisions, preserves them on rebuild, and requires explicit revocation after input changes", async () => {
    const e = await coreProcessingFixture();
    try {
      await e.app.documentProcessing.parseDocuments(e.rawParseRequest);
      const first = await e.app.proofreading!.build({
        asset_id: e.asset.asset_id,
      });
      const inspected = await e.app.proofreading!.inspect({
        asset_id: e.asset.asset_id,
        unresolved_only: false,
      });
      const draft = inspected.items[0]!.draft;
      const request = {
        asset_id: e.asset.asset_id,
        proofread_id: first.version.proofread_id,
        block_id: draft.block_id,
        draft_sha256: draft.draft_sha256,
        expected_manual_revision: 0,
        action: "replace",
        reason: "Checked original PDF",
        text: "Human corrected transcription.",
        actor: "fixture-reader",
      };
      const decision = await e.app.proofreading!.decide(request);
      await expect(e.app.proofreading!.decide(request)).rejects.toMatchObject({
        code: "proofread-manual-stale",
      });
      const corrected = await e.app.proofreading!.build({
        asset_id: e.asset.asset_id,
      });
      expect(corrected.version.manual_decision_ids).toEqual([
        decision.decision_id,
      ]);
      expect(corrected.version.status).toBe("complete");
      await e.reopen();
      expect(
        (await e.app.proofreading!.build({ asset_id: e.asset.asset_id }))
          .version,
      ).toEqual(corrected.version);
      e.setText("# Changed source\n\nDifferent page content.");
      await e.app.documentProcessing.parseDocuments({
        ...e.rawParseRequest,
        force: true,
      });
      const conflicted = await e.app.proofreading!.build({
        asset_id: e.asset.asset_id,
      });
      expect(conflicted.version.status).toBe("incomplete");
      expect(
        conflicted.version.pages.some(
          (p) => p.pending_reason === "manual-conflict",
        ),
      ).toBe(true);
      expect(
        (await e.app.proofreading!.inspect({ asset_id: e.asset.asset_id }))
          .manual_revision,
      ).toBe(1);
      await executeMaintenance(e.app, "proofread-revoke", {
        asset_id: e.asset.asset_id,
        decision_id: decision.decision_id,
        expected_manual_revision: 1,
        actor: "fixture-reader",
      });
      expect(
        (await e.app.proofreading!.build({ asset_id: e.asset.asset_id }))
          .version.status,
      ).toBe("complete");
      await expect(
        e.app.rawParseStorage!.retire(first.version.draft_input.raw_parse_id),
      ).rejects.toMatchObject({ code: "raw-parse-in-use" });
      expect(e.modelCalls).toBe(0);
    } finally {
      await e.close();
    }
  });
  it("cancellation never changes the current version or starts MinerU", async () => {
    const e = await coreProcessingFixture();
    try {
      const stop = new AbortController();
      stop.abort();
      await expect(
        e.app.proofreading!.build({ asset_id: e.asset.asset_id }, stop.signal),
      ).rejects.toMatchObject({ code: "proofread-cancelled" });
      expect(
        (await e.app.proofreading!.inspect({ asset_id: e.asset.asset_id }))
          .current,
      ).toBeNull();
      expect(e.parseCalls).toBe(0);
    } finally {
      await e.close();
    }
  });
});

it("offers the same correction reads through CLI and MCP without parser/model calls", async () => {
  const e = await coreProcessingFixture();
  const host = createMcpServer({
    maintenance: true,
    applicationFactory: async () => e.app,
    queryFactory: () => createQueryApplication(e.home),
  });
  const [serverTransport, clientTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "fixture", version: "1" });
  try {
    await e.app.documentProcessing.parseDocuments(e.rawParseRequest);
    const output: string[] = [];
    const cliApp = await e.openAnother();
    const factory = vi
      .spyOn(bootstrap, "createApplication")
      .mockResolvedValueOnce(cliApp);
    let cli;
    try {
      cli = await runCli(["proofread", "build", "--request", "-", "--json"], {
        home: e.home,
        stdout: (s) => output.push(s),
        stdin: (async function* () {
          yield Buffer.from(JSON.stringify({ asset_id: e.asset.asset_id }));
        })(),
      });
    } finally {
      factory.mockRestore();
      await cliApp.close();
    }
    expect(cli.code).toBe(0);
    const receipt = JSON.parse(output.join(""));
    expect(receipt.status).toBe("complete");
    expect(receipt).not.toHaveProperty("failures");
    await host.connect(serverTransport);
    await client.connect(clientTransport);
    const response = await client.callTool({
      name: "proofread_inspect",
      arguments: {
        asset_id: e.asset.asset_id,
        unresolved_only: false,
        limit: 1,
      },
    });
    expect(response.isError).not.toBe(true);
    expect(response.structuredContent).toMatchObject({
      result: {
        current: { proofread_id: receipt.proofread_id },
        items: expect.arrayContaining([
          {
            block_id: expect.any(String),
            draft_sha256: expect.any(String),
            draft: expect.any(Object),
            block: expect.any(Object),
            suspects: expect.any(Array),
            edits: expect.any(Array),
            decisions: [],
          },
        ]),
      },
    });
    const reused = await client.callTool({
      name: "proofread_build",
      arguments: { asset_id: e.asset.asset_id },
    });
    expect(reused.isError).not.toBe(true);
    expect(reused.structuredContent).toMatchObject({
      result: { proofread_id: receipt.proofread_id, published: false },
    });
    expect(e.parseCalls).toBe(2);
    expect(e.modelCalls).toBe(0);
  } finally {
    await client.close();
    await host.close();
    await e.close();
  }
});

it("retains separate manual dispositions for several suspects in one block", async () => {
  const e = await coreProcessingFixture({
    analysisModel: false,
    textLayer: () => "Yield 97%.",
  });
  try {
    e.setText("Yield 67%.");
    await e.app.documentProcessing.parseDocuments(e.rawParseRequest);
    const first = await e.app.proofreading!.build({
      asset_id: e.asset.asset_id,
    });
    expect(first.version.status).toBe("incomplete");
    const view = await e.app.proofreading!.inspect({
        asset_id: e.asset.asset_id,
      }),
      item = view.items[0]!;
    expect(item.suspects.length).toBeGreaterThan(1);
    for (const [index, s] of item.suspects.entries())
      await e.app.proofreading!.decide({
        asset_id: e.asset.asset_id,
        proofread_id: first.version.proofread_id,
        block_id: item.block_id,
        draft_sha256: item.draft_sha256,
        expected_manual_revision: index,
        action: "resolve-suspect",
        text: null,
        reason: "The text layer is outdated; checked the original PDF.",
        actor: "fixture",
        suspect_id: s.suspect_id,
        disposition: {
          status: "draft-correct",
          reason: "Original PDF agrees with the draft.",
        },
      });
    const done = await e.app.proofreading!.build({
      asset_id: e.asset.asset_id,
    });
    expect(done.version.status).toBe("complete");
    expect(done.version.manual_decision_ids).toHaveLength(item.suspects.length);
    expect(
      done.version.suspects.every(
        (s) => s.disposition?.status === "draft-correct",
      ),
    ).toBe(true);
    expect(e.modelCalls).toBe(0);
  } finally {
    await e.close();
  }
});
it("records a locked no-body decision for a page with no draft blocks", async () => {
  const e = await coreProcessingFixture({
    analysisModel: false,
    headerOnly: true,
  });
  try {
    e.setText("Journal running header.");
    await e.app.documentProcessing.parseDocuments(e.rawParseRequest);
    const first = await e.app.proofreading!.build({
      asset_id: e.asset.asset_id,
    });
    expect(first.version.failure?.reason).toBe("page-content-missing");
    const view = await e.app.proofreading!.inspect({
      asset_id: e.asset.asset_id,
    });
    if (!("pages" in view)) throw new Error("missing page status");
    const page = view.pages[0]!;
    await e.app.proofreading!.decide({
      asset_id: e.asset.asset_id,
      proofread_id: first.version.proofread_id,
      block_id: page.block_id,
      draft_sha256: page.draft_sha256,
      page: 0,
      expected_manual_revision: 0,
      action: "no-body",
      text: null,
      reason: "The original page contains no body content.",
      actor: "fixture",
    });
    const done = await e.app.proofreading!.build({
      asset_id: e.asset.asset_id,
    });
    expect(done.version.status).toBe("complete");
    expect(done.version.pages[0]!.no_body_reason).toBe(
      "The original page contains no body content.",
    );
  } finally {
    await e.close();
  }
});
