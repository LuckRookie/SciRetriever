import { renderArrangement } from "../src/archive/render.js";
import { expect, it, vi } from "vitest";
import {
  parseDocumentReadResult,
  parseArchiveTextBundleV2,
  parseProofreadVersionV2,
  archiveProofreadHash,
  canonicalJsonBytes,
  parseArtifactRef,
  DRAFT_BASES,
  type ProofreadVersionV2,
  type DocumentReadOperation,
  type DocumentReadRequestMap,
} from "@sciretriever/contracts";
import { byteHash, textId } from "../src/archive/text-source.js";
import { documentRepresentationHash } from "../src/document/contract.js";
import { documentIdentity } from "../src/document/proofread-publication.js";
import { SqliteDocumentStorage } from "../src/document/storage.js";
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

async function reidentify(
  version: ProofreadVersionV2,
  changes: Partial<Pick<ProofreadVersionV2, "blocks" | "pages">>,
) {
  const { proofread_id: _id, content_sha256: _hash, ...body } = version;
  void _id;
  void _hash;
  const input = { ...body, ...changes },
    contentHash = await archiveProofreadHash(input);
  return parseProofreadVersionV2({
    ...input,
    content_sha256: contentHash,
    proofread_id: `${contentHash.slice(0, 8)}-${contentHash.slice(8, 12)}-${contentHash.slice(12, 16)}-${contentHash.slice(16, 20)}-${contentHash.slice(20, 32)}`,
  });
}

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
  const inspect = e.app.archiveText!.pdf.inspect.bind(e.app.archiveText!.pdf);
  vi.spyOn(e.app.archiveText!.pdf, "inspect").mockImplementation(
    async (...args) =>
      (await inspect(...args)).map((page) => {
        const text = page.text.replace(
          "A complete synthetic study.",
          `A complete synthetic study on page ${page.page}.`,
        );
        return page.page === 2
          ? {
              ...page,
              kind: "image-only" as const,
              text: "",
              visible_glyphs: 0,
              has_graphics: true,
            }
          : {
              ...page,
              text:
                page.page === 1 ? text.replace("on page 1", "on page 9") : text,
            };
      }),
  );
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
    expect(describe.text_level).toBe("proofread");
    expect(
      (await e.app.database.documentVersion(part.document_version_id!))!.version
        .builder_version,
    ).toBe("source-order-leaves-v5");
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
    const stateBefore = await e.app.archiveText!.storage.state(
      e.asset.asset_id,
    );
    for (const basis of DRAFT_BASES) {
      const tamperedBundle = parseArchiveTextBundleV2({
          ...output.bundle,
          leaves: output.bundle.leaves.map((row) =>
            row.destination.kind === "assigned" && row.leaf.page_index === 0
              ? { ...row, basis }
              : row,
          ),
        }),
        blockBytes = canonicalJsonBytes(tamperedBundle),
        page = output.version.pages[0]!,
        { unreviewed_reason: _reason, ...reviewed } = page;
      void _reason;
      const invalidVersion = await reidentify(output.version, {
        blocks: parseArtifactRef({
          sha256: byteHash(blockBytes),
          byte_size: blockBytes.length,
          media_type: "application/json",
        }),
        pages: [
          {
            ...reviewed,
            status: "accepted",
            evidence: {
              ...page.evidence,
              viewed_full_page: true,
              read_leaf_ids: page.retained_leaf_ids,
            },
          },
          ...output.version.pages.slice(1),
        ],
      });
      await expect(
        e.app.archiveText!.storage.publish(invalidVersion, tamperedBundle, {
          current_revision: Number(stateBefore.current!.revision),
          manual_revision: stateBefore.manual_revision,
        }),
      ).rejects.toThrow("archive-text-integrity");
      expect(
        (await e.app.archiveText!.storage.load(output.version.proofread_id))!
          .bundle,
      ).toEqual(output.bundle);
    }
    expect(await e.app.archiveText!.storage.state(e.asset.asset_id)).toEqual(
      stateBefore,
    );
    const checked = <K extends DocumentReadOperation>(
      kind: K,
      result: unknown,
      request: DocumentReadRequestMap[K],
    ) => parseDocumentReadResult(kind, result, request);
    const segmentsRequest = {
      document_version_id: part.document_version_id!,
      section_id: null,
      limit: 200,
      cursor: null,
    };
    const segments = checked(
      "segments",
      await e.app.documentRead.segments(segmentsRequest),
      segmentsRequest,
    );
    expect(segments.text_level).toBe("proofread");
    for (const basis of [
      "text-layer-match",
      "text-layer-differs",
      "no-text-layer",
    ]) {
      const segment = segments.segments.find((s) => s.basis === basis)!;
      expect(segment, basis).toBeDefined();
      const sliceRequest = {
        document_version_id: part.document_version_id!,
        selector: { kind: "segment" as const, segment_id: segment.segment_id },
        max_bytes: 65536,
        continuation: null,
      };
      const slice = checked(
        "slice",
        await e.app.documentRead.slice(sliceRequest),
        sliceRequest,
      );
      expect(slice).toMatchObject({
        text_level: "proofread",
        locations: [expect.objectContaining({ basis })],
      });
      const evidenceRequest = {
        evidence: slice.evidence[0]!,
        max_bytes: 65536,
        continuation: null,
      };
      const evidence = checked(
        "evidence",
        await e.app.documentRead.resolveEvidence(evidenceRequest),
        evidenceRequest,
      );
      expect(evidence).toMatchObject({
        text_level: "proofread",
        location: { basis },
      });
      await expect(
        e.app.documentRead.draftDifferences({
          document_version_id: part.document_version_id!,
          segment_id: segment.segment_id,
          max_bytes: 65536,
          continuation: null,
        }),
      ).rejects.toMatchObject({ code: "document-unsupported" });
    }
    await expect(
      e.app.documentRead.withVerifiedVersion(
        part.document_version_id!,
        async () => true,
      ),
    ).rejects.toMatchObject({ code: "document-unsupported" });
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
    expect(
      after.bundle.leaves
        .filter(
          (l) => l.destination.kind === "assigned" && l.leaf.page_index === 25,
        )
        .every((l) => l.basis === "text-layer"),
    ).toBe(true);
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
    expect(
      manual.bundle.leaves.some(
        (l) => l.text_source === "manual" && l.basis === "manual",
      ),
    ).toBe(true);
    // Register a genuine historical v4 closure using the old per-page bases.
    // This models an already-published version; reading it must not republish it.
    const legacyBundle = parseArchiveTextBundleV2({
      ...manual.bundle,
      leaves: manual.bundle.leaves.map((row) => ({
        ...row,
        basis:
          row.text_source === "manual"
            ? "manual"
            : manual.version.pages[row.leaf.page_index]!.page_kind ===
                "text-layer"
              ? "text-layer"
              : "image-only",
      })),
    });
    const bytes = canonicalJsonBytes(legacyBundle),
      legacyVersion = await reidentify(manual.version, {
        blocks: parseArtifactRef({
          sha256: byteHash(bytes),
          byte_size: bytes.length,
          media_type: "application/json",
        }),
      }),
      storage = e.app.archiveText!.storage,
      current = await storage.state(e.asset.asset_id);
    await storage.publish(legacyVersion, legacyBundle, {
      current_revision: Number(current.current!.revision),
      manual_revision: current.manual_revision,
    });
    const legacyRendered = renderArrangement(
        legacyBundle,
        legacyVersion.resources,
        "source-order-leaves-v4",
      ),
      legacyMarkdown = await storage.write(
        "proofread-markdown",
        legacyRendered.markdown,
        "text/markdown",
      ),
      legacyStructure = await storage.write(
        "document-structure",
        legacyRendered.bytes,
      ),
      material = (await e.app.database.documentMaterial(
        e.id,
        e.asset.asset_id,
      ))!,
      representation = {
        source_material_ref: material.material,
        proofread_id: legacyVersion.proofread_id,
        proofread_content_sha256: legacyVersion.content_sha256,
        builder_version: "source-order-leaves-v4" as const,
        locator_scheme: "utf8-segment-v1" as const,
        markdown: parseArtifactRef({
          sha256: legacyMarkdown.sha256,
          byte_size: legacyMarkdown.byte_size,
          media_type: legacyMarkdown.media_type,
        }),
        structure: parseArtifactRef({
          sha256: legacyStructure.sha256,
          byte_size: legacyStructure.byte_size,
          media_type: legacyStructure.media_type,
        }),
        resources: [],
      },
      representationHash = await documentRepresentationHash(representation),
      legacyId = textId(["published-v4-long", representationHash]),
      priorDefault = (await e.app.database.documentDefault(
        e.id,
        e.asset.asset_id,
        e.asset.sha256,
      ))!,
      documents = new SqliteDocumentStorage(e.app.database, e.app.files);
    await e.app.database.proofread("render-resources", {
      proofread_id: legacyVersion.proofread_id,
      manual_revision: current.manual_revision,
      resources: [
        { ...legacyMarkdown, kind: "markdown", logical_reference: "" },
      ],
    });
    await documents.commitVersion({
      version: {
        schema_version: 2,
        document_id: documentIdentity(e.id, e.asset.asset_id),
        document_version_id: legacyId,
        representation_sha256: representationHash,
        ...representation,
      },
      source_artifact_path: material.path,
      markdown_artifact_path: legacyMarkdown.reference,
      structure_artifact_path: legacyStructure.reference,
      resource_artifact_paths: {},
      expected_default_revision: priorDefault.revision,
      expected_manual_revision: current.manual_revision,
    });
    const before = await e.app.database.documentVersion(legacyId);
    await web?.close();
    web = undefined;
    await e.reopen();
    await new SqliteDocumentStorage(
      e.app.database,
      e.app.files,
    ).withVerifiedDocument(legacyId, async (version, markdown, structure) => {
      expect(version.builder_version).toBe("source-order-leaves-v4");
      expect(version.representation_sha256).toBe(representationHash);
      expect(Buffer.from(markdown)).toEqual(legacyRendered.markdown);
      expect(canonicalJsonBytes(structure)).toEqual(legacyRendered.bytes);
      expect(byteHash(canonicalJsonBytes(structure))).toBe(
        legacyRendered.sha256,
      );
      expect(byteHash(markdown)).toBe(legacyMarkdown.sha256);
    });
    expect(await e.app.database.documentVersion(legacyId)).toEqual(before);
  } finally {
    vi.restoreAllMocks();
    await web?.close();
    await e.close();
  }
}, 60000);
