import { renderArrangement } from "../src/archive/render.js";
import { expect, it } from "vitest";
import { archiveFixture, archiveModel } from "./archive-fixture.js";
import { executeQuery } from "../src/entry/query-operations.js";
import { createQueryApplication } from "../src/bootstrap/application.js";
import { startQueryOnlyWorkbench } from "../src/bootstrap/workbench.js";
import { runCli } from "../src/cli/main.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/mcp/server.js";
import {
  FIXTURE_DOI,
  FIXTURE_TITLE,
} from "../src/workbench/synthetic-fixture.js";

function longPdf() {
  const content = `BT /F1 14 Tf 40 740 Td (${FIXTURE_TITLE}) Tj 0 -24 Td (DOI: ${FIXTURE_DOI}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${Array.from({ length: 51 }, (_, i) => `${i + 5} 0 R`).join(" ")}] /Count 51 >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    ...Array.from(
      { length: 51 },
      () =>
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 4 0 R >>",
    ),
  ];
  let bytes = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((o, i) => {
    offsets.push(Buffer.byteLength(bytes));
    bytes += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(bytes);
  bytes += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((x) => `${String(x).padStart(10, "0")} 00000 n `)
    .join(
      "\n",
    )}\ntrailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(bytes);
}

it("publishes a long part as READY, scopes kept and dropped metadata to the end pages, exposes the same marker and counts, and retries a selected page", async () => {
  const e = await archiveFixture({
    pageCount: 51,
    sourcePdf: longPdf(),
    pageText: (page, text) =>
      text.replace(
        "A complete synthetic study.",
        `A complete synthetic study on page ${page}.`,
      ),
  });
  let web: Awaited<ReturnType<typeof startQueryOnlyWorkbench>> | undefined;
  let fragments: { page: number; role: string; text: string }[] = [];
  try {
    e.setText(
      "DROP_HEADER Synthetic running head.\n\n# Abstract\n\nFixture Author studies spectroscopy.\n\n# Introduction\n\nA complete synthetic study.\n\n# References\n\n[1] Example synthetic reference.\n",
    );
    e.setModel((input) => {
      if (input.method === "archive-metadata-dsh-v2")
        fragments = input.fragments as typeof fragments;
      return archiveModel(input);
    });
    await e.app.documentProcessing.parseDocuments(e.rawParseRequest);
    const run = await e.submit("long-production");
    expect(
      run.failures,
      JSON.stringify(await e.app.archive.status(e.id)),
    ).toEqual([]);
    const state = await e.app.archive.status(e.id),
      part = state.parts[0]!;
    const marker = {
      pages: 51,
      arrange_input_bytes: expect.any(Number),
      reasons: ["pages"],
    };
    expect(state.status).toBe("READY");
    expect(state.long_document).toEqual(marker);
    expect(part.long_document).toEqual(state.long_document);
    expect(part.steps.find((s) => s.step === "proofread")).toMatchObject({
      calls: 0,
      pages: {
        required: 51,
        accepted: 0,
        unreviewed: 51,
        pending: 0,
        failed: 0,
      },
    });
    expect(
      part.steps.find((s) => s.step === "arrange")!.output.stats,
    ).toMatchObject({ segment_count: 1 });
    expect(new Set(fragments.map((f) => f.page))).toEqual(
      new Set([
        ...Array.from({ length: 20 }, (_, i) => i + 1),
        47,
        48,
        49,
        50,
        51,
      ]),
    );
    expect(fragments.some((f) => f.role.startsWith("dropped:"))).toBe(true);
    const describe = await e.app.documentRead.describe({
      document_version_id: part.document_version_id,
    });
    expect(describe.long_document).toEqual(state.long_document);
    const library = await e.app.library.targetedSnapshot({
      literature_ids: [e.id],
    });
    expect(library.items[0]!.long_document).toEqual(state.long_document);
    expect(
      (
        await e.app.library.search({
          query: { title: "Synthetic" },
          limit: 20,
          cursor: null,
        })
      ).items[0]!.long_document,
    ).toEqual(state.long_document);
    const detail = await e.app.database.review<{
      items: { archive: { steps: { step: string; pages: unknown }[] } }[];
    }>("task-run", { job_id: run.job.job_id });
    expect(
      detail.items[0]!.archive.steps.find((s) => s.step === "proofread")!.pages,
    ).toMatchObject({ unreviewed: 51, pending: 0 });
    const output = (await e.app.archiveText!.storage.load(part.proofread_id!))!;
    expect(output.version.pages.every((p) => p.status === "unreviewed")).toBe(
      true,
    );
    expect(
      output.bundle.leaves
        .filter((l) => l.destination.kind === "assigned")
        .every(
          (l) =>
            l.corrected_text === l.leaf.original_text &&
            l.text_source === "parser",
        ),
    ).toBe(true);
    const query = await createQueryApplication(e.home);
    try {
      expect(
        (
          (await executeQuery(query, "document-describe", {
            document_version_id: part.document_version_id,
          })) as typeof describe
        ).long_document,
      ).toEqual(state.long_document);
    } finally {
      await query.close();
    }
    web = await startQueryOnlyWorkbench({ home: e.home, assets: new Map() });
    const response = await fetch(
      web.origin + "/api/v1/query/document-describe",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-SciRetriever-Protocol-Version": "1",
        },
        body: JSON.stringify({
          protocol_version: 1,
          request: { document_version_id: part.document_version_id },
        }),
      },
    );
    expect(response.status).toBe(200);
    expect((await response.json()).result.long_document).toEqual(
      state.long_document,
    );
    let stdout = "";
    expect(
      (
        await runCli(["document", "describe", "--request", "-"], {
          home: e.home,
          stdin: (async function* () {
            yield Buffer.from(
              JSON.stringify({ document_version_id: part.document_version_id }),
            );
          })(),
          stdout: (s) => {
            stdout += s;
          },
        })
      ).code,
    ).toBe(0);
    expect(JSON.parse(stdout).result.long_document).toEqual(
      state.long_document,
    );
    const server = createMcpServer({ home: e.home }),
      client = new Client({ name: "long-document", version: "1" }),
      [a, b] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(a);
      await client.connect(b);
      const result = await client.callTool({
        name: "document_read",
        arguments: {
          operation: "describe",
          request: { document_version_id: part.document_version_id },
        },
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        protocol_version: 1,
        result: { long_document: state.long_document },
      });
      const status = await client.callTool({
        name: "archive_query",
        arguments: { operation: "status", request: { literature_id: e.id } },
      });
      expect(status.isError).not.toBe(true);
      expect(status.structuredContent).toMatchObject({
        protocol_version: 1,
        result: {
          long_document: state.long_document,
          parts: [
            expect.objectContaining({ long_document: state.long_document }),
          ],
        },
      });
      const statusHttp = await fetch(web!.origin + "/api/v1/query/archive", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-SciRetriever-Protocol-Version": "1",
        },
        body: JSON.stringify({
          protocol_version: 1,
          request: { operation: "status", request: { literature_id: e.id } },
        }),
      });
      expect(statusHttp.status).toBe(200);
      expect((await statusHttp.json()).result.long_document).toEqual(
        state.long_document,
      );
      let cliStatus = "";
      expect(
        (
          await runCli(["archive", "status", e.id], {
            home: e.home,
            stdout: (text) => {
              cliStatus += text;
            },
          })
        ).code,
      ).toBe(0);
      expect(JSON.parse(cliStatus).long_document).toEqual(state.long_document);
    } finally {
      await client.close();
      await server.close();
    }
    const reused = await e.app.archiveText!.proofread(
      e.asset.asset_id,
      "full",
      null,
    );
    expect(
      reused.pages.every((p) => p.status === "unreviewed" && !p.reused),
    ).toBe(true);
    expect(reused.usage.calls).toBe(0);
    const retried = await e.app.archiveText!.proofread(
      e.asset.asset_id,
      "full",
      [25],
    );
    expect(retried.usage.calls).toBe(1);
    const after = (await e.app.archiveText!.storage.load(
      retried.proofread_id,
    ))!;
    expect(after.version.pages[25]!.status).toBe("accepted");
    expect(
      after.version.pages.filter((p) => p.status === "unreviewed"),
    ).toHaveLength(50);
    expect(after.version.pages[0]).toEqual(output.version.pages[0]);
    expect(after.version.status).toBe("complete");
    const callsBeforeManual = e.modelCalls;
    const markdown = renderArrangement(
      after.bundle,
      after.version.resources,
    ).markdown.toString();
    const saved = await e.app.archiveArrangement.save(
      {
        schema_version: 2,
        literature_id: e.id,
        asset_id: e.asset.asset_id,
        proofread_id: after.version.proofread_id,
        expected_arrangement_id: after.version.arrangement_id,
        expected_manual_revision: 0,
        markdown: markdown.replace(
          "A complete synthetic study on page 0.",
          "A manually checked synthetic study on page 0.",
        ),
      },
      "fixture-human",
    );
    expect(saved).toMatchObject({ saved: true, rebuild: { status: "done" } });
    expect(e.modelCalls).toBe(callsBeforeManual);
    const manual = (await e.app.archiveText!.storage.load(
      saved.proofread_id!,
    ))!;
    expect(manual.version.status).toBe("complete");
    expect(manual.version.pages[0]).toMatchObject({
      status: "unreviewed",
      unreviewed_reason: "long-document",
      suspects: [],
      dispositions: [],
      corrections: [expect.objectContaining({ source: "manual" })],
    });
  } finally {
    await web?.close();
    await e.close();
  }
}, 60000);
